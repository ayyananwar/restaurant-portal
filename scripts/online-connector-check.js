import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import axe from 'axe-core';
import { buildHostedApp } from '../dist/hosted/app.js';
import { hostedPool, prepareHostedStore, provisionOutlet } from '../dist/hosted/database.js';
import { buildApp } from '../dist/server/app.js';
import { openStore, createStaff } from '../dist/server/store.js';
import { createOnlineConnector, onlineInbox } from '../dist/server/online-connector.js';
import { saveBillingProfile } from '../dist/server/billing.js';
import { defaultBillingProfile } from '../dist/shared/billing.js';
import { publishMenu } from '../dist/server/menu-publication.js';

test('Windows connector survives lost acknowledgments and restarts; counter UI distinguishes queued decisions', { timeout: 120_000 }, async () => {
  assert.ok(process.env.HOSTED_TEST_DATABASE_URL);
  const namespace=`connector_${randomBytes(8).toString('hex')}`;
  const setup=hostedPool(process.env.HOSTED_TEST_DATABASE_URL);
  const pool=hostedPool(process.env.HOSTED_TEST_DATABASE_URL,`-c search_path=${namespace}`);
  const directory=mkdtempSync(join(tmpdir(),'restaurant-connector-'));
  const dbPath=join(directory,'outlet.sqlite');
  const remoteOrigin='https://connector.example.test';
  const token=randomBytes(32).toString('hex');
  const target={endpoint:remoteOrigin+'/api/publish/cafe',guestUrl:remoteOrigin+'/r/cafe',token};
  let db=openStore(dbPath);
  let hosted,local,connector,browser;
  let loseAcknowledgment=false;
  let malformed=false;
  let wrongReview=false;
  let offlineReview=false;
  let calls=0;
  const accountOptions={origin:remoteOrigin,phoneKey:randomBytes(32),verifier:{}};
  const sessions={};
  const actors={};
  const guestSessions=new Map();
  async function send(url,init={}) {
    calls++;
    assert.equal(new URL(url).origin,remoteOrigin);
    assert.equal(init.redirect,'error');
    if(offlineReview&&url.endsWith('/review'))throw new Error('Fixture connection interrupted');
    if(malformed&&url.endsWith('/pickup-requests'))return Response.json({requests:[{id:'bad'}],nextAfter:null});
    const result=await hosted.inject({method:init.method??'GET',url:new URL(url).pathname+new URL(url).search,
      headers:Object.fromEntries(new Headers(init.headers)),payload:init.body});
    if(wrongReview&&url.endsWith('/review')&&result.statusCode===200)return Response.json({...result.json(),orderId:randomUUID()});
    if(loseAcknowledgment&&url.endsWith('/decision')&&result.statusCode===200){loseAcknowledgment=false;throw new Error('Lost after commit');}
    return new Response(result.statusCode===204?null:result.rawPayload,{status:result.statusCode,headers:result.headers});
  }
  const localCall=(method,url,payload,role='billing')=>local.inject({method,url,payload,headers:{host:'127.0.0.1:3100',origin:'http://127.0.0.1:3100',cookie:`staff_session=${sessions[role]}`}});
  function makeLocal(origin='http://127.0.0.1:3100') {
    connector=createOnlineConnector(db,target,send);
    return buildApp(db,{origin,publication:target,online:{...connector,kick(){}}});
  }
  async function guestOrder(name) {
    const account=randomUUID(),cookie=randomBytes(32).toString('hex');
    await pool.query("INSERT INTO guest_accounts(id,phone_key,phone_last_four) VALUES($1,$2,'1111')",[account,randomBytes(32).toString('hex')]);
    await pool.query("INSERT INTO guest_sessions(token_hash,account_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash('sha256').update(cookie).digest('hex'),account]);
    const call=(path,payload)=>hosted.inject({method:'POST',url:'/api/online-pickup/cafe'+path,payload,headers:{host:'connector.example.test',origin:remoteOrigin,cookie:`__Host-guest_session=${cookie}`}});
    const quote=await call('/quote',{name,notes:'Call at collection',lines:[{menuId:1,quantity:2,note:'Less sugar'}]});
    assert.equal(quote.statusCode,200,quote.body);
    const order=await call('/requests',{requestId:randomUUID(),quoteId:quote.json().id});
    assert.equal(order.statusCode,200,order.body);guestSessions.set(order.json().id,cookie);return order.json();
  }
  try {
    await setup.query(`CREATE SCHEMA ${namespace}`);await prepareHostedStore(pool);
    await provisionOutlet(pool,'cafe','Connector Café','classic',token);
    hosted=await buildHostedApp(pool,undefined,accountOptions);
    for(const role of ['admin','billing','waiter','kitchen']){
      createStaff(db,role,role,role,'fixture-only long account password');
      actors[role]=db.prepare('SELECT id,name,role FROM staff WHERE username=?').get(role);
      sessions[role]=randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(sessions[role]).digest('hex'),actors[role].id,Date.now()+3_600_000);
    }
    db.exec("INSERT INTO menu(name,category,price_paise,description) VALUES('Chai','Drinks',6000,'Fresh tea');");
    db.exec("UPDATE outlet_settings SET mode='both' WHERE id=1;");
    saveBillingProfile(db,actors.admin,{...defaultBillingProfile,enabled:true,legalName:'Fixture Café',address:'Fixture address'});
    await publishMenu(db,target,new AbortController().signal,send);
    local=makeLocal();
    assert.equal((await localCall('GET','/api/online-orders',undefined,'waiter')).statusCode,403);
    assert.equal((await localCall('GET','/api/online-orders',undefined,'kitchen')).statusCode,403);
    assert.equal((await localCall('PUT','/api/outlet/online',{enabled:true,revision:1})).statusCode,403);
    await connector.refresh();
    assert.equal((await localCall('PUT','/api/outlet/online',{enabled:true,revision:1},'admin')).statusCode,204);
    await connector.refresh();
    assert.equal(onlineInbox(db,target).ready,false);
    assert.match(onlineInbox(db,target).error,/package/);
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=true WHERE slug='cafe'");
    await connector.refresh();assert.equal(onlineInbox(db,target).ready,true);
    const first=await guestOrder('Restart customer');await connector.refresh();
    const quote=(await localCall('POST',`/api/online-orders/${first.id}/review`,{revision:first.revision})).json();
    assert.ok(quote.hash);
    const input={requestId:randomUUID(),expectedRevision:first.revision,decision:'accept',reason:'',readyAt:Date.now()+1_200_000,reviewHash:quote.hash};
    assert.equal((await localCall('POST',`/api/online-orders/${first.id}/decision`,{...input,actor:actors.admin})).statusCode,400);
    assert.equal((await localCall('POST',`/api/online-orders/${first.id}/decision`,input)).statusCode,202);
    loseAcknowledgment=true;await connector.refresh();
    assert.equal(db.prepare('SELECT state FROM online_decisions WHERE request_id=?').get(input.requestId).state,'queued');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_decisions')).rows[0].n,1);
    await connector.stop();await local.close();db.close();db=openStore(dbPath);local=makeLocal();
    assert.equal(onlineInbox(db,target).orders[0].decision.state,'queued');
    await connector.refresh();
    assert.equal(onlineInbox(db,target).orders[0].status,'awaiting_payment');
    assert.equal(onlineInbox(db,target).orders[0].decision.state,'confirmed');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_decisions')).rows[0].n,1);
    const second=await guestOrder('Access review');await connector.refresh();
    const rejection={requestId:randomUUID(),expectedRevision:second.revision,decision:'reject',reason:'Sold out',readyAt:null,reviewHash:null};
    assert.equal((await localCall('POST',`/api/online-orders/${second.id}/decision`,rejection)).statusCode,202);
    db.prepare('UPDATE staff SET enabled=0 WHERE id=?').run(actors.billing.id);await connector.refresh();
    assert.equal(db.prepare('SELECT state FROM online_decisions WHERE request_id=?').get(rejection.requestId).state,'conflict');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_decisions')).rows[0].n,1);
    db.prepare('UPDATE staff SET enabled=1 WHERE id=?').run(actors.billing.id);
    assert.equal((await localCall('POST',`/api/online-orders/${second.id}/decision`,{...rejection,requestId:randomUUID()},'admin')).statusCode,202);
    await connector.refresh();assert.equal(onlineInbox(db,target).orders.find(order=>order.id===second.id).status,'rejected');
    malformed=true;const before=db.prepare('SELECT count(*) AS n FROM online_inbox').get().n;await connector.refresh();
    assert.match(onlineInbox(db,target).error,/Invalid/);assert.equal(db.prepare('SELECT count(*) AS n FROM online_inbox').get().n,before);malformed=false;
    const other=createOnlineConnector(db,{...target,endpoint:remoteOrigin+'/api/publish/other'},send);
    const callsBefore=calls;await other.refresh();assert.equal(calls,callsBefore);await other.stop();
    await connector.refresh();
    const third=await guestOrder('Browser customer');await connector.refresh();
    wrongReview=true;assert.equal((await localCall('POST',`/api/online-orders/${third.id}/review`,{revision:third.revision})).statusCode,502);wrongReview=false;
    offlineReview=true;assert.equal((await localCall('POST',`/api/online-orders/${third.id}/review`,{revision:third.revision})).statusCode,503);offlineReview=false;
    const stale=(await localCall('POST',`/api/online-orders/${third.id}/review`,{revision:third.revision})).json();
    saveBillingProfile(db,actors.admin,{...defaultBillingProfile,enabled:true,revision:1,legalName:'Updated Fixture Café',address:'Fixture address'});
    assert.equal((await localCall('POST',`/api/online-orders/${third.id}/decision`,{...input,requestId:randomUUID(),expectedRevision:third.revision,reviewHash:stale.hash})).statusCode,409);
    await connector.refresh();
    await connector.stop();await local.close();
    db.exec("UPDATE outlet_settings SET mode='counter' WHERE id=1;");
    // Reserve a local browser address, then build the app with that exact origin.
    const {createServer}=await import('node:net');const socket=createServer().listen(0,'127.0.0.1');await new Promise(resolve=>socket.once('listening',resolve));
    const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));const origin=`http://127.0.0.1:${port}`;
    local=makeLocal(origin);await local.listen({host:'127.0.0.1',port});
    browser=await chromium.launch({channel:process.env.RESTAURANT_TEST_BROWSER??'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addCookies([{name:'staff_session',value:sessions.billing,url:origin}]);
    const page=await context.newPage();await page.goto(origin);
    await page.getByRole('button',{name:'Online orders',exact:true}).click();
    await page.getByRole('button',{name:/Browser customer/}).click();
    if(process.env.RESTAURANT_TEST_SCREENSHOTS)for(const width of [390,1280]){await page.setViewportSize({width,height:844});await page.screenshot({animations:'disabled',path:join(process.env.RESTAURANT_TEST_SCREENSHOTS,`online-inbox-${width}.png`)});}
    await page.evaluate(axe.source);assert.deepEqual(await page.evaluate(async()=>(await window.axe.run({runOnly:['wcag2a','wcag2aa','wcag21a','wcag21aa']})).violations.map(issue=>issue.id)),[]);
    await page.getByRole('button',{name:'Review acceptance'}).click();
    await page.getByRole('heading',{name:'Review online acceptance'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Counter orders',exact:true}).isDisabled(),true);
    for(const width of [320,390,768,1280]){
      await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.evaluate(axe.source);const issues=await page.evaluate(async()=>(await window.axe.run({runOnly:['wcag2a','wcag2aa','wcag21a','wcag21aa']})).violations.map(issue=>issue.id));assert.deepEqual(issues,[]);
      if(process.env.RESTAURANT_TEST_SCREENSHOTS&&(width===390||width===1280))await page.screenshot({path:join(process.env.RESTAURANT_TEST_SCREENSHOTS,`online-review-${width}.png`)});
    }
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.textContent==='Online pickup orders');
    await page.getByRole('button',{name:'Review acceptance'}).click();
    await page.getByRole('button',{name:'Save acceptance decision'}).click();
    await page.getByText(/Decision saved on this PC/).waitFor();
    if(process.env.RESTAURANT_TEST_SCREENSHOTS){await page.setViewportSize({width:390,height:844});await page.getByText(/Decision saved on this PC/).scrollIntoViewIfNeeded();await page.screenshot({path:join(process.env.RESTAURANT_TEST_SCREENSHOTS,'online-queued-390.png')});}
    loseAcknowledgment=true;await connector.refresh();
    assert.equal(db.prepare("SELECT state FROM online_decisions WHERE order_id=? ORDER BY created_at DESC LIMIT 1").get(third.id).state,'queued');
    await connector.refresh();
    await page.getByRole('region',{name:'Online request for Browser customer'}).getByText('Waiting for customer payment',{exact:true}).waitFor();
    const accepted=(await pool.query('SELECT revision::int,decision FROM online_pickup_requests WHERE id=$1',[third.id])).rows[0];
    const consent=await hosted.inject({method:'PUT',url:`/api/online-pickup/cafe/requests/${third.id}/confirmation`,
      headers:{host:'connector.example.test',origin:remoteOrigin,cookie:`__Host-guest_session=${guestSessions.get(third.id)}`},
      payload:{expectedRevision:accepted.revision,reviewHash:accepted.decision.acceptance.review.hash}});
    assert.equal(consent.statusCode,200,consent.body);await connector.refresh();
    assert.equal(onlineInbox(db,target).orders.find(order=>order.id===third.id).confirmation.reviewHash,accepted.decision.acceptance.review.hash);
    await page.getByText('Customer confirmed the total. Payment is still required; do not start preparation.').waitFor();
    const fourth=await guestOrder('Reject browser customer');await connector.refresh();
    await page.getByRole('button',{name:/^Reject browser customer/}).click();
    await page.getByRole('button',{name:'Reject request',exact:true}).click();
    await page.getByLabel('Reason for rejection').fill('Kitchen closed');
    await page.getByRole('button',{name:'Save rejection decision'}).click();await page.getByText(/Decision saved on this PC/).waitFor();await connector.refresh();
    await page.getByRole('region',{name:'Online request for Reject browser customer'}).getByText('Rejection reason: Kitchen closed').waitFor();
    const ownerContext=await browser.newContext({viewport:{width:390,height:844}});await ownerContext.addCookies([{name:'staff_session',value:sessions.admin,url:origin}]);
    const owner=await ownerContext.newPage();await owner.goto(origin);await owner.getByRole('button',{name:'Online orders',exact:true}).click();
    assert.equal(await owner.locator('.staff-sidebar').count(),0);
    await owner.getByRole('button',{name:'Pause online pickup'}).click();await connector.refresh();
    await owner.getByText('Online pickup paused',{exact:true}).waitFor();
    db.prepare('INSERT INTO recovery_state VALUES(1,?,?,?, ?,NULL)').run(Date.now(),'a'.repeat(64),'[]','fixture');
    const pausedCalls=calls;await connector.refresh();assert.equal(calls,pausedCalls);assert.equal(onlineInbox(db,target).ready,false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM counter_orders').get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM built_in_bills').get().n,0);
  } finally {
    await browser?.close();await connector?.stop();await local?.close();await hosted?.close();db.close();
    await pool.end();try{await setup.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);}finally{await setup.end();}
    const cleanupPath=realpathSync(directory);
    if(dirname(cleanupPath)!==realpathSync(tmpdir())||!basename(cleanupPath).startsWith('restaurant-connector-'))throw new Error('Invalid test cleanup directory');
    rmSync(cleanupPath,{recursive:true});
  }
});

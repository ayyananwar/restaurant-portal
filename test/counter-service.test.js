import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../dist/server/app.js';
import { openStore, submitOrder } from '../dist/server/store.js';

const origin = 'http://127.0.0.1:3100';

function fixture(path = ':memory:') {
  const db = openStore(path);
  const cookies = {};
  for (const role of ['admin','billing','kitchen','waiter']) {
    const id = Number(db.prepare('INSERT INTO staff(username,name,role,password_hash) VALUES (?,?,?,?)').run(role, role, role, 'fixture').lastInsertRowid);
    const token = createHash('sha256').update(role).digest('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), id, Date.now() + 600_000);
    cookies[role] = `staff_session=${token}`;
  }
  db.exec("INSERT INTO menu(name,price_paise,category) VALUES ('Burger',12500,'Mains');");
  const app = buildApp(db, { origin });
  async function request(method, url, body, role = 'billing') {
    return app.inject({ method, url, headers: { host: '127.0.0.1:3100', cookie: cookies[role], origin,
      ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body });
  }
  const state = async role => (await request('GET', '/api/service', undefined, role)).json();
  const mode = async next => {
    const settings = (await state('admin')).settings;
    const reply = await request('PATCH','/api/outlet/settings', { mode: next, revision: settings.revision }, 'admin');
    assert.equal(reply.statusCode, 204, reply.body);
  };
  const draft = () => ({ requestId: randomUUID(), fulfillment: 'takeaway', customer: 'Guest', seating: '',
    paper: 'none', paperReference: '', lines: [{ menuId: 1, quantity: 2, note: 'No onions', expectedPricePaise: 12500 }] });
  const pay = (revision = 0, reference = randomUUID()) => ({ requestId: randomUUID(), revision, reference,
    officialTotalPaise: 25000, paymentMethod: 'UPI' });
  return { db, app, request, state, mode, draft, pay };
}

test('counter-only workflow gates the kitchen on payment and keeps retries, tokens, receipts and collection consistent', async () => {
  const f = fixture();
  try {
    assert.equal((await f.state('admin')).settings.mode, 'table');
    assert.equal((await f.request('POST','/api/counter-orders', f.draft())).statusCode, 409);
    assert.equal((await f.request('PATCH','/api/outlet/settings', { mode:'counter', revision:0 })).statusCode, 403);
    await f.mode('counter');
    assert.equal((await f.request('PATCH','/api/outlet/settings', { mode:'both', revision:0 }, 'admin')).statusCode, 409);
    const input = f.draft();
    assert.equal((await f.request('POST','/api/counter-orders', input, 'waiter')).statusCode, 403);
    const created = await f.request('POST','/api/counter-orders', input);
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().orderId;
    assert.deepEqual((await f.request('POST','/api/counter-orders', input)).json(), { orderId: id });
    assert.equal((await f.request('POST','/api/counter-orders', { ...input, customer:'Changed' })).statusCode, 409);
    assert.equal((await f.state('billing')).tables.length, 0);
    assert.equal((await f.state('kitchen')).counterOrders.length, 0);
    assert.equal((await f.state('waiter')).counterOrders.length, 0);
    const pending = (await f.state('billing')).counterOrders[0];
    assert.equal((await f.request('PATCH', `/api/dishes/${pending.lines[0].id}`, { status:'ready', revision:0 }, 'kitchen')).statusCode, 404);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`, { ...f.pay(), paymentMethod:null })).statusCode, 400);
    const payment = f.pay();
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`, payment)).statusCode, 200);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`, payment)).statusCode, 200);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`, { ...payment, requestId:randomUUID() })).statusCode, 409);
    const paid = (await f.state('billing')).counterOrders[0];
    assert.match(paid.token, /^\d{4}-\d{2}-\d{2} #1$/);
    assert.equal(paid.receipts.length, 1);
    assert.ok(paid.receipts[0].feedback.code);
    const kitchen = (await f.state('kitchen')).counterOrders[0];
    assert.equal(kitchen.customer, '');
    assert.deepEqual(kitchen.receipts, []);
    const action = { requestId:randomUUID(), revision:paid.revision, action:'collect', reason:'', reference:'' };
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`, action)).statusCode, 409);
    assert.equal((await f.request('PATCH', `/api/dishes/${paid.lines[0].id}`, { status:'ready', revision:0 }, 'kitchen')).statusCode, 204);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`, action)).statusCode, 200);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`, action)).statusCode, 200);
    assert.equal((await f.state('billing')).counterOrders[0].status, 'collected');
    assert.equal((await f.state('kitchen')).counterOrders.length, 0);
    const collected=(await f.state('billing')).counterOrders[0];
    const correction={requestId:randomUUID(),revision:collected.revision,action:'reduce',
      reason:'Returned after collection',reference:'',lineId:collected.lines[0].id,quantity:1,amountPaise:12500};
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`,correction)).statusCode,200);
    assert.equal((await f.state('billing')).counterOrders[0].refund.amountPaise,12500);
    assert.equal((await f.state('kitchen')).counterOrders.length,0);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { await f.app.close(); f.db.close(); }
});

test('counter payments roll back on conflicts, redeem coupons once and retain paid cancellation and refund history', async () => {
  const f = fixture();
  try {
    await f.mode('both');
    f.db.exec("INSERT INTO coupons(code,discount_paise,minimum_paise) VALUES ('SAVE50',5000,0);");
    const id = (await f.request('POST','/api/counter-orders', f.draft())).json().orderId;
    const quote = await f.request('POST',`/api/counter-orders/${id}/coupon`, { revision:0, code:'SAVE50' });
    assert.equal(quote.statusCode, 200, quote.body);
    f.db.exec('UPDATE menu SET available=0 WHERE id=1');
    const pay = { ...f.pay(0,'BILL-1'), coupon:quote.json() };
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`, pay)).statusCode, 409);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM check_receipts').get().n, 0);
    f.db.exec('UPDATE menu SET available=1 WHERE id=1');
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`, pay)).statusCode, 200);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`, pay)).statusCode, 200);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM check_receipts WHERE coupon_code=?').get('SAVE50').n, 1);
    const second = (await f.request('POST','/api/counter-orders', f.draft())).json().orderId;
    assert.equal((await f.request('POST',`/api/counter-orders/${second}/payment`, f.pay(0,'bill-1'))).statusCode, 409);
    assert.equal((await f.state('kitchen')).counterOrders.length, 1);
    await f.mode('table');
    const cancel = { requestId:randomUUID(), revision:1, action:'cancel', reason:'Customer cancelled', reference:'' };
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`, cancel)).statusCode, 200);
    const cancelled = (await f.state('billing')).counterOrders.find(order => order.id === id);
    assert.equal(cancelled.refund.amountPaise, 25000);
    assert.equal(cancelled.refund.reference, null);
    assert.equal((await f.state('kitchen')).counterOrders[0].status, 'cancelled');
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/kitchen-ack`,{},'billing')).statusCode,403);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/kitchen-ack`,{},'kitchen')).statusCode,204);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/kitchen-ack`,{},'kitchen')).statusCode,204);
    assert.equal((await f.state('kitchen')).counterOrders.length,0);
    const refund = { requestId:randomUUID(), revision:2, action:'refund', reason:'', reference:'UPI-REFUND-1' };
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`, refund)).statusCode, 200);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`, refund)).statusCode, 200);
    assert.equal((await f.state('billing')).counterOrders.find(order => order.id === id).refund.reference, 'UPI-REFUND-1');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM outlet_audit').get().n, 2);
  } finally { await f.app.close(); f.db.close(); }
});

test('paper-served counter orders stay out of kitchen, tokens continue after reopen, and legacy table references survive migration', async () => {
  const directory = mkdtempSync(join(tmpdir(),'counter-migration-'));
  const path = join(directory,'outlet.sqlite');
  const f = fixture(path);
  try {
    f.db.exec("INSERT INTO dining_tables(label) VALUES ('Table 1');");
    const tableOrder = submitOrder(f.db,1,4,{ requestId:randomUUID(), lines:[{ menuId:1,quantity:1 }] });
    // Reproduce the previous schema parent while retaining a real stored table order and request.
    f.db.exec(`PRAGMA foreign_keys=OFF; BEGIN;
      DROP TABLE table_resolutions; DROP TABLE counter_corrections; DROP TABLE configuration_events; DROP TABLE counter_requests; DROP TABLE counter_orders; DROP TABLE outlet_audit; DROP TABLE outlet_settings;
      CREATE TABLE legacy_orders(id INTEGER PRIMARY KEY,table_id INTEGER NOT NULL REFERENCES dining_tables(id),
        waiter_id INTEGER NOT NULL REFERENCES staff(id),opened_at INTEGER NOT NULL,closed_at INTEGER,closed_by INTEGER REFERENCES staff(id));
      INSERT INTO legacy_orders SELECT * FROM orders; DROP TABLE orders; ALTER TABLE legacy_orders RENAME TO orders;
      CREATE UNIQUE INDEX active_table_order ON orders(table_id) WHERE closed_at IS NULL;
      PRAGMA user_version=13; COMMIT;`);
    await f.app.close(); f.db.close();
    const upgraded = openStore(path);
    try {
      assert.equal(upgraded.prepare('SELECT id FROM orders').get().id, tableOrder);
      assert.equal(upgraded.prepare('SELECT mode FROM outlet_settings').get().mode, 'table');
      assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
      upgraded.exec("UPDATE outlet_settings SET mode='counter'; UPDATE menu SET available=0;");
      const { createCounterOrder, payCounterOrder, readCounterOrders } = await import('../dist/server/counter-service.js');
      const actor = { id:2, name:'billing', role:'billing' };
      const draft = { ...f.draft(), paper:'served', paperReference:'PAPER-17' };
      const id = createCounterOrder(upgraded,actor,draft);
      const payment = f.pay();
      payCounterOrder(upgraded,actor,id,payment);
      assert.equal(readCounterOrders(upgraded,{ id:3,name:'kitchen',role:'kitchen' }).length,0);
      assert.equal(readCounterOrders(upgraded,actor)[0].status,'ready');
      upgraded.close();
      const reopened = openStore(path);
      try {
        assert.equal(payCounterOrder(reopened,actor,id,payment),id);
        const next = createCounterOrder(reopened,actor,{ ...draft, requestId:randomUUID() });
        payCounterOrder(reopened,actor,next,f.pay());
        assert.match(readCounterOrders(reopened,actor).find(order => order.id === next).token, /#2$/);
      } finally { reopened.close(); }
    } catch (error) { try { upgraded.close(); } catch {} throw error; }
  } finally {
    try { await f.app.close(); f.db.close(); } catch {}
    rmSync(directory,{ recursive:true,force:true });
  }
});

test('partial paid cancellations preserve receipt history, bound refunds and reject stale kitchen updates', async () => {
  const f = fixture();
  try {
    await f.mode('counter');
    const id = (await f.request('POST','/api/counter-orders',f.draft())).json().orderId;
    await f.request('POST',`/api/counter-orders/${id}/payment`,f.pay());
    const paid = (await f.state('billing')).counterOrders[0];
    const lineId = paid.lines[0].id;
    const reduce = { requestId:randomUUID(),revision:1,action:'reduce',reason:'One burger cancelled',reference:'',
      lineId,quantity:1,amountPaise:12500 };
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`,{ ...reduce,amountPaise:30000 })).statusCode,409);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`,reduce)).statusCode,200);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`,reduce)).statusCode,200);
    const corrected = (await f.state('billing')).counterOrders[0];
    assert.equal(corrected.lines[0].quantity,1);
    assert.equal(corrected.corrections.length,1);
    assert.equal(corrected.receipts[0].officialTotalPaise,25000);
    assert.equal((await f.request('PATCH',`/api/dishes/${lineId}`,{ status:'ready',revision:0 },'kitchen')).statusCode,409);
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`,{ ...reduce,requestId:randomUUID(),revision:2,amountPaise:12501 })).statusCode,409);
    const refund = { requestId:randomUUID(),revision:2,action:'refund',reason:'',reference:'PARTIAL-REFUND-1' };
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`,refund)).statusCode,200);
    const cancel = { requestId:randomUUID(),revision:3,action:'cancel',reason:'Remaining burger cancelled',reference:'' };
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/action`,cancel)).statusCode,200);
    const result = (await f.state('billing')).counterOrders[0];
    assert.equal(result.status,'cancelled');
    assert.equal(result.corrections.length,2);
    assert.equal(result.refund.amountPaise,12500);
    assert.equal(result.corrections[0].reference,'PARTIAL-REFUND-1');
    const report = (await f.request('GET','/api/reports/waiter-activity?period=day',undefined,'admin')).json();
    assert.equal(report.counter[0].orders,1);
    assert.equal(report.counter[0].refundedPaise,12500);
    assert.equal(report.counter[0].refundNeededPaise,12500);
  } finally { await f.app.close(); f.db.close(); }
});

test('outlet policy blocks preparing-dish changes while keeping queued changes and approvals available', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO dining_tables(label) VALUES ('Table 1');");
    const id = submitOrder(f.db,1,4,{requestId:randomUUID(),lines:[{menuId:1,quantity:2}]});
    const lineId = f.db.prepare('SELECT id FROM order_lines WHERE order_id=?').get(id).id;
    await f.request('PATCH',`/api/dishes/${lineId}`,{status:'preparing',revision:0},'kitchen');
    assert.equal((await f.request('PATCH','/api/outlet/settings',{mode:'table',revision:0,changePolicy:'blocked'},'admin')).statusCode,204);
    const change = {requestId:randomUUID(),revision:1,quantity:1,note:''};
    assert.equal((await f.request('POST',`/api/dishes/${lineId}/changes`,change,'waiter')).statusCode,409);
    assert.equal((await f.request('PATCH','/api/outlet/settings',{mode:'table',revision:1,changePolicy:'approval'},'admin')).statusCode,204);
    const reply = await f.request('POST',`/api/dishes/${lineId}/changes`,change,'waiter');
    assert.equal(reply.statusCode,200,reply.body);
    assert.equal(reply.json().outcome,'pending');
  } finally { await f.app.close(); f.db.close(); }
});

test('owner setup restricts staff and table changes and revokes disabled and reset sessions', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('GET','/api/outlet/staff',undefined,'billing')).statusCode,403);
    assert.equal((await f.request('POST','/api/outlet/staff',{username:'new',name:'New',role:'billing'},'waiter')).statusCode,403);
    const created = await f.request('POST','/api/outlet/staff',{username:'cashier2',name:'Cashier 2',role:'billing'},'admin');
    assert.equal(created.statusCode,200,created.body);
    assert.match(created.json().password,/^[A-Za-z0-9_-]{24}$/);
    assert.match(created.headers['cache-control'],/no-store/);
    const roster = (await f.request('GET','/api/outlet/staff',undefined,'admin')).json().staff;
    assert.equal(roster.some(account=>'password_hash' in account),false);
    assert.equal((await f.request('PATCH','/api/outlet/staff/1',{enabled:false},'admin')).statusCode,409);
    assert.equal((await f.request('POST','/api/outlet/staff/1/password',{},'admin')).statusCode,409);
    assert.equal((await f.request('PATCH','/api/outlet/staff/4',{enabled:false},'admin')).statusCode,204);
    assert.equal((await f.request('GET','/api/service',undefined,'waiter')).statusCode,401);
    const reset = await f.request('POST','/api/outlet/staff/3/password',{},'admin');
    assert.equal(reset.statusCode,200,reset.body);
    assert.equal((await f.request('GET','/api/service',undefined,'kitchen')).statusCode,401);
    assert.equal((await f.request('POST','/api/outlet/tables',{label:'Window'},'admin')).statusCode,204);
    assert.equal((await f.request('POST','/api/outlet/tables',{label:'Window'},'admin')).statusCode,204);
    assert.equal((await f.request('PATCH','/api/outlet/tables/1',{label:'Garden'},'admin')).statusCode,204);
    assert.equal((await f.state('admin')).tables[0].label,'Garden');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dining_tables').get().n,1);
    const audit = f.db.prepare('SELECT details FROM configuration_events').all().map(row=>row.details).join(' ');
    assert.equal(audit.includes(created.json().password),false);
    assert.equal(audit.includes(reset.json().password),false);
  } finally { await f.app.close(); f.db.close(); }
});

test('only an owner can close an unpaid table with a current balance and an auditable kitchen notice', async () => {
  const f=fixture();
  try {
    f.db.exec("INSERT INTO dining_tables(label) VALUES ('Table 1');");
    const orderId=submitOrder(f.db,1,4,{requestId:randomUUID(),lines:[{menuId:1,quantity:2}]});
    assert.equal((await f.request('POST','/api/tables/1/release',{orderId},'waiter')).statusCode,409);
    assert.equal((await f.request('GET',`/api/tables/1/resolution?orderId=${orderId}`,undefined,'billing')).statusCode,403);
    const quote=(await f.request('GET',`/api/tables/1/resolution?orderId=${orderId}`,undefined,'admin')).json();
    assert.equal(quote.amountPaise,25000);
    const line=f.db.prepare('SELECT id FROM order_lines WHERE order_id=?').get(orderId);
    await f.request('POST',`/api/dishes/${line.id}/changes`,{requestId:randomUUID(),revision:0,quantity:3,note:''},'waiter');
    assert.equal((await f.request('POST','/api/tables/1/resolution',{orderId,version:quote.version,reason:'Guests left'},'admin')).statusCode,409);
    const next=(await f.request('GET',`/api/tables/1/resolution?orderId=${orderId}`,undefined,'admin')).json();
    assert.equal(next.amountPaise,37500);
    const resolution={orderId,version:next.version,reason:'Owner approved loss after guests left'};
    assert.equal((await f.request('POST','/api/tables/1/resolution',resolution,'admin')).statusCode,204);
    assert.equal((await f.request('POST','/api/tables/1/resolution',resolution,'admin')).statusCode,204);
    assert.equal((await f.request('POST','/api/tables/2/resolution',resolution,'admin')).statusCode,409);
    const state=await f.state('admin');
    assert.equal(state.tables[0].orderId,null);
    assert.equal(state.resolutions[0].amountPaise,37500);
    assert.equal((await f.state('kitchen')).tableCancellations[0].orderId,orderId);
    assert.equal((await f.state('kitchen')).resolutions,undefined);
    assert.equal((await f.request('POST',`/api/orders/${orderId}/resolution-ack`,{},'kitchen')).statusCode,204);
    assert.deepEqual((await f.state('kitchen')).tableCancellations,[]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM check_receipts').get().n,0);
    const nextParty=submitOrder(f.db,1,4,{requestId:randomUUID(),expectedOrderId:null,lines:[{menuId:1,quantity:1}]});
    assert.notEqual(nextParty,orderId);
    assert.equal((await f.state('billing')).tables[0].lines[0].quantity,1);
    assert.equal((await f.request('POST','/api/tables/1/resolution',resolution,'admin')).statusCode,204);
    assert.equal((await f.state('billing')).tables[0].orderId,nextParty);
  } finally {await f.app.close();f.db.close();}
});

test('a SQLite storage limit leaves no partial counter order or kitchen submission', async () => {
  const f=fixture();
  try {
    await f.mode('counter');
    f.db.exec('VACUUM');
    const pages=Number(f.db.prepare('PRAGMA page_count').get().page_count);
    f.db.exec(`PRAGMA max_page_count=${pages}`);
    const input={...f.draft(),lines:Array.from({length:50},()=>({menuId:1,quantity:1,expectedPricePaise:12500,note:'x'.repeat(300)}))};
    const reply=await f.request('POST','/api/counter-orders',input);
    assert.equal(reply.statusCode,500,reply.body);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM counter_requests').get().n,0);
    assert.equal((await f.state('kitchen')).counterOrders.length,0);
    f.db.exec('PRAGMA max_page_count=1073741823');
    assert.equal((await f.request('POST','/api/counter-orders',input)).statusCode,200);
  } finally {await f.app.close();f.db.close();}
});

test('simultaneous counter confirmations allocate one token and preserve the accepted receipt', async () => {
  const f=fixture();
  try {
    await f.mode('counter');
    const id=(await f.request('POST','/api/counter-orders',f.draft())).json().orderId;
    const results=await Promise.all([f.pay(0,'CASHIER-A'),f.pay(0,'CASHIER-B')].map(input=>
      f.request('POST',`/api/counter-orders/${id}/payment`,input)));
    assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,409]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM check_receipts').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM counter_orders WHERE token_number IS NOT NULL').get().n,1);
  } finally {await f.app.close();f.db.close();}
});

test('a failure between receipt recording and token assignment rolls the whole payment back', async () => {
  const f=fixture();
  try {
    await f.mode('counter');
    const id=(await f.request('POST','/api/counter-orders',f.draft())).json().orderId;
    const payment=f.pay();
    f.db.exec("CREATE TRIGGER reject_token BEFORE UPDATE OF token_number ON counter_orders BEGIN SELECT RAISE(ABORT,'test write interruption'); END;");
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`,payment)).statusCode,500);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM check_receipts').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM receipt_feedback_codes').get().n,0);
    assert.equal((await f.state('kitchen')).counterOrders.length,0);
    f.db.exec('DROP TRIGGER reject_token');
    assert.equal((await f.request('POST',`/api/counter-orders/${id}/payment`,payment)).statusCode,200);
    assert.equal((await f.state('billing')).counterOrders[0].token.endsWith('#1'),true);
  } finally {await f.app.close();f.db.close();}
});

test('counter tokens reset at India midnight and remain unique when the date moves back', async t => {
  const f=fixture();
  try {
    await f.mode('counter');
    const {createCounterOrder,payCounterOrder,readCounterOrders}=await import('../dist/server/counter-service.js');
    const actor={id:2,name:'billing',role:'billing'};
    t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-22T18:29:00Z')});
    const first=createCounterOrder(f.db,actor,f.draft());
    payCounterOrder(f.db,actor,first,f.pay());
    assert.equal(readCounterOrders(f.db,actor)[0].token,'2026-11-22 #1');
    t.mock.timers.tick(120_000);
    const second=createCounterOrder(f.db,actor,f.draft());
    payCounterOrder(f.db,actor,second,f.pay());
    assert.equal(readCounterOrders(f.db,actor)[0].token,'2026-11-23 #1');
    t.mock.timers.setTime(new Date('2026-11-22T18:29:30Z').valueOf());
    const third=createCounterOrder(f.db,actor,f.draft());
    payCounterOrder(f.db,actor,third,f.pay());
    assert.equal(readCounterOrders(f.db,actor).find(order=>order.id===third).token,'2026-11-22 #2');
  } finally {t.mock.timers.reset();await f.app.close();f.db.close();}
});

test('billing can audit a ready table-dish correction before its receipt, while waiter and paid edits stay blocked', async () => {
  const f=fixture();
  try {
    f.db.exec("INSERT INTO dining_tables(label) VALUES ('Table 1');");
    const orderId=submitOrder(f.db,1,4,{requestId:randomUUID(),lines:[{menuId:1,quantity:2}]});
    const lineId=f.db.prepare('SELECT id FROM order_lines WHERE order_id=?').get(orderId).id;
    await f.request('PATCH',`/api/dishes/${lineId}`,{status:'ready',revision:0},'kitchen');
    const correction={requestId:randomUUID(),revision:1,quantity:1,note:'Corrected receipt quantity',reason:'One item was entered twice'};
    assert.equal((await f.request('POST',`/api/dishes/${lineId}/correction`,correction,'waiter')).statusCode,403);
    assert.equal((await f.request('POST',`/api/dishes/${lineId}/correction`,correction)).statusCode,200);
    assert.equal((await f.request('POST',`/api/dishes/${lineId}/correction`,correction)).statusCode,200);
    assert.equal((await f.request('POST',`/api/dishes/${lineId}/correction`,{...correction,reason:'Different reason'})).statusCode,409);
    const table=(await f.state('billing')).tables[0];
    assert.equal(table.lines[0].quantity,1);
    assert.equal((await f.request('POST','/api/tables/1/receipts',{orderId,splitId:null,checkNumber:1,
      checkVersion:table.checkVersion,reference:'READY-CORRECTION-1',officialTotalPaise:12500,paymentMethod:'Cash'})).statusCode,204);
    assert.equal((await f.request('POST',`/api/dishes/${lineId}/correction`,{
      ...correction,requestId:randomUUID(),revision:2,quantity:0
    })).statusCode,409);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM configuration_events WHERE action='ready-dish-correction'").get().n,1);
  } finally {await f.app.close();f.db.close();}
});

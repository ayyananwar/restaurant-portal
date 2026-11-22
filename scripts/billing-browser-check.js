import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import axe from 'axe-core';
import { buildApp } from '../dist/server/app.js';
import { createStaff, openStore, submitOrder } from '../dist/server/store.js';
import { inspectEncryptedBackup } from '../dist/server/recovery.js';

const scratch=mkdtempSync(join(tmpdir(),'restaurant-billing-browser-'));
const output=resolve('data/billing-check');
mkdirSync(output,{recursive:true});
const db=openStore(join(scratch,'sample.sqlite'));
const password='billing-browser-fixture-only';
for(const role of ['admin','billing','waiter']) createStaff(db,role,role,role,password);
db.exec("INSERT INTO dining_tables(label) VALUES ('Table 7'); INSERT INTO menu(name,price_paise,category) VALUES ('Paneer tikka with a long descriptive name',24000,'Starters'); UPDATE outlet_settings SET mode='both'");
submitOrder(db,1,3,{requestId:crypto.randomUUID(),lines:[{menuId:1,quantity:2,expectedPricePaise:24000}]});
const app=buildApp(db,{origin:'http://127.0.0.1:31964'});
let browser;
const errors=[];
async function accessibility(page) {
  await page.evaluate(axe.source);
  const violations=await page.evaluate(async()=> (await window.axe.run({runOnly:['wcag2a','wcag2aa','wcag21aa']})).violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)})));
  assert.deepEqual(violations,[]);
}
try {
  await app.listen({host:'127.0.0.1',port:31964});
  browser=await chromium.launch({channel:process.env.RESTAURANT_TEST_BROWSER??'msedge'});
  async function login(role,width) {
    const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
    await context.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:31964'?route.continue():route.abort());
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:31964');
    await page.getByLabel('Username').fill(role);
    await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    return page;
  }
  const owner=await login('admin',390);
  await owner.getByRole('button',{name:'Configure billing',exact:true}).click();
  await owner.getByLabel('Billing availability').selectOption('true');
  await owner.getByLabel('Business legal name').fill('Ranchi sample restaurant');
  await owner.getByLabel('Business address').fill('Sample address for testing only\nRanchi, India');
  await owner.getByLabel('Business state',{exact:true}).selectOption('27');
  await owner.getByLabel('Tax treatment').selectOption('gst');
  await owner.getByLabel('Business GSTIN').fill('27AAPFU0939F1ZV');
  await owner.getByLabel('HSN / SAC classification').fill('996331');
  await owner.getByLabel('Applicable total GST (%)').fill('5');
  assert.equal(await owner.getByRole('button',{name:'Menu catalog',exact:true}).isDisabled(),true);
  await accessibility(owner);
  await owner.screenshot({path:join(output,'billing-setup-390.png'),fullPage:true});
  await owner.getByRole('button',{name:'Save billing setup',exact:true}).click();
  await owner.getByRole('button',{name:'Configure billing',exact:true}).waitFor();
  await owner.getByRole('button',{name:'Export encrypted backup',exact:true}).click();
  const backupForm=owner.getByRole('form',{name:'Encrypted backup export'});
  await backupForm.getByLabel('Backup passphrase · at least 16 characters').fill('browser-only recovery fixture secret');
  await backupForm.getByLabel('Repeat backup passphrase').fill('different recovery fixture secret');
  await backupForm.getByRole('button',{name:'Download backup',exact:true}).click();
  await backupForm.getByText('The two passphrases do not match. Enter them again.').waitFor();
  await backupForm.getByLabel('Repeat backup passphrase').fill('browser-only recovery fixture secret');
  assert.equal(await owner.getByRole('button',{name:'Menu catalog',exact:true}).isDisabled(),true);
  await accessibility(owner);
  await owner.screenshot({path:join(output,'backup-export-390.png'),fullPage:true});
  const download=owner.waitForEvent('download');
  await backupForm.getByRole('button',{name:'Download backup',exact:true}).click();
  const heartbeatStarted=Date.now();
  assert.equal((await owner.request.get('http://127.0.0.1:31964/api/service')).status(),200);
  assert.ok(Date.now()-heartbeatStarted<2000,'Backup blocked service requests');
  const backupDownload=await download;
  assert.match(backupDownload.suggestedFilename(),/^restaurant-backup-\d+\.rpb$/);
  const backupFile=join(output,'fixture-backup.rpb');await backupDownload.saveAs(backupFile);
  const inspected=await inspectEncryptedBackup(backupFile,'browser-only recovery fixture secret',scratch);
  const snapshot=openStore(inspected.path);
  try{assert.equal(snapshot.prepare('SELECT count(*) AS n FROM sessions').get().n,0);}finally{snapshot.close();}
  await inspected.cleanup();
  await owner.getByText('Download started.',{exact:false}).waitFor();
  const cashier=await login('billing',390);
  await cashier.getByRole('button',{name:'Table checks',exact:true}).click();
  await cashier.getByRole('button',{name:'Create built-in bill',exact:true}).click();
  const editor=cashier.getByRole('region',{name:'Create built-in bill'});
  assert.equal(await cashier.getByRole('button',{name:'Counter orders',exact:true}).isDisabled(),true);
  await editor.getByRole('button',{name:'Preview bill',exact:true}).click();
  await editor.getByRole('button',{name:'Issue bill',exact:true}).waitFor();
  await accessibility(cashier);
  assert.equal(await cashier.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await cashier.screenshot({path:join(output,'bill-preview-390.png'),fullPage:true});
  // Lose the successful response: the saved invoice must still appear after refresh, with one number.
  await cashier.route('**/api/tables/1/bills',async route=>{await route.fetch();await route.abort();});
  await editor.getByRole('button',{name:'Issue bill',exact:true}).click();
  const saved=cashier.locator('.saved-bill').filter({hasText:'RP/'});
  await saved.first().waitFor();
  await cashier.unroute('**/api/tables/1/bills');
  assert.equal(db.prepare('SELECT count(*) AS n FROM built_in_bills').get().n,1);
  const bill=saved.first();
  await bill.locator('summary').click();
  await cashier.evaluate(()=>{window.print=()=>{window.billPrints=(window.billPrints??0)+1;};});
  const invoice=JSON.parse(db.prepare('SELECT snapshot FROM built_in_bills').get().snapshot);
  for(const width of [320,390,768,1280]) {
    await cashier.setViewportSize({width,height:900});
    assert.equal(await cashier.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
    if(width===390||width===1280)await cashier.screenshot({path:join(output,`saved-bill-${width}.png`),fullPage:true});
  }
  for(const [layout,expectedWidth] of [['58',58],['80',80],['a4',210]]) {
    await bill.getByLabel('Paper layout').selectOption(layout);
    await bill.getByRole('button',{name:'Print bill',exact:true}).click();
    assert.equal(db.prepare('SELECT count(*) AS n FROM built_in_bills').get().n,1);
    await bill.locator('.bill-document').evaluate((element,width)=>{element.parentElement.dataset.printBill=width;},layout);
    await cashier.emulateMedia({media:'print'});
    assert.equal(await cashier.getByRole('button',{name:'Sign out',exact:true}).isVisible(),false);
    const pdf=await cashier.pdf({path:join(output,`bill-${layout}.pdf`),preferCSSPageSize:true,printBackground:true});
    const box=/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(pdf.toString('latin1'));
    assert.ok(box,'Missing PDF page dimensions');
    assert.ok(Math.abs(Number(box[1])*25.4/72-expectedWidth)<1,`Wrong paper width for ${layout}: ${box[1]}`);
    await bill.locator('.bill-document').evaluate(element=>delete element.parentElement.dataset.printBill);
    await cashier.emulateMedia({media:'screen'});
  }
  assert.equal(await cashier.evaluate(()=>window.billPrints),3);
  await cashier.getByRole('button',{name:'Record payment',exact:true}).click();
  await cashier.getByLabel('Payment outcome',{exact:true}).selectOption('Cash');
  const paymentResult=cashier.waitForResponse(response=>response.url().endsWith('/api/tables/1/receipts')&&response.request().method()==='POST');
  await cashier.getByRole('button',{name:'Save payment',exact:true}).click();
  assert.equal((await paymentResult).status(),204);
  assert.equal(db.prepare('SELECT payment_method FROM check_receipts').get().payment_method,'Cash');
  // Saved history survives a released table and excludes staff without billing permission.
  db.exec('UPDATE order_lines SET status=\'ready\'; UPDATE orders SET closed_at=1,closed_by=3');
  await cashier.reload();
  await cashier.getByText('Saved bills and credit notes',{exact:true}).click();
  const history=cashier.getByRole('region',{name:'Saved bill history'});
  await history.getByText(`View / print tax invoice · ${invoice.number}`,{exact:true}).waitFor();
  await history.getByLabel('Search invoice or credit note number').fill('MISSING');
  await history.getByRole('button',{name:'Search / refresh bills'}).click();
  await history.getByText('No saved built-in bills match this search.').waitFor();
  const counterId=await cashier.evaluate(async()=>{
    const response=await fetch('/api/counter-orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      requestId:crypto.randomUUID(),fulfillment:'takeaway',customer:'Sample guest',seating:'',paper:'none',paperReference:'',
      lines:[{menuId:1,quantity:2,expectedPricePaise:24000}]
    })});return (await response.json()).orderId;
  });
  assert.ok(counterId);
  await cashier.getByRole('button',{name:'Counter orders',exact:true}).click();
  await cashier.getByRole('button',{name:'Create built-in bill',exact:true}).click();
  const counterEditor=cashier.getByRole('region',{name:'Create built-in bill'});
  await counterEditor.getByRole('button',{name:'Preview bill',exact:true}).click();
  await counterEditor.getByLabel('Payment outcome').selectOption('Cash');
  await counterEditor.getByRole('button',{name:'Confirm payment and issue bill',exact:true}).click();
  await cashier.locator('.counter-orders').getByText('Official receipt amount · ₹480.00',{exact:true}).waitFor();
  assert.equal(db.prepare('SELECT count(*) AS n FROM built_in_bills').get().n,2);
  assert.equal(db.prepare('SELECT token_number FROM counter_orders WHERE order_id=?').get(counterId).token_number,1);
  await cashier.getByRole('button',{name:'Cancel some items',exact:true}).click();
  await cashier.getByLabel('Refund amount from official receipt (₹)').fill('240');
  await cashier.getByLabel('Cancellation reason',{exact:true}).fill('Browser sample partial cancellation');
  await cashier.getByRole('button',{name:'Confirm cancellation',exact:true}).click();
  const credit=cashier.locator('.saved-bill').filter({hasText:'View / print credit note'});
  await credit.locator('summary').click();
  await credit.getByRole('button',{name:'Print credit note',exact:true}).click();
  assert.equal(db.prepare('SELECT count(*) AS n FROM built_in_credit_notes').get().n,1);
  await accessibility(cashier);
  db.prepare('INSERT INTO recovery_state VALUES(1,?,?,?,?,NULL)').run(Date.now(),'a'.repeat(64),'[]','Browser recovery fixture');
  await owner.reload();
  const review=owner.getByRole('form',{name:'Review restored outlet'});
  await review.waitFor();
  await accessibility(owner);
  await owner.screenshot({path:join(output,'recovery-review-390.png'),fullPage:true});
  await review.getByLabel('I have reconciled the restored orders, payments and refunds.').check();
  await review.getByRole('button',{name:'Record owner review and resume service',exact:true}).click();
  await review.waitFor({state:'hidden'});
  assert.equal(db.prepare("SELECT count(*) AS n FROM configuration_events WHERE action='recovery-reviewed'").get().n,1);
  assert.deepEqual(errors,[]);
  console.log('Billing/recovery browser passed: encrypted export/inspection, responsive service, owner recovery review, table/counter invoices, safe retries, saved history, credit printing, accessibility, 320–1280 px and receipt/A4 PDFs.');
} finally {await browser?.close();await app.close();db.close();rmSync(scratch,{recursive:true});}

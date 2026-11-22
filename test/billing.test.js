import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../dist/server/app.js';
import { allocateBillNumber, financialYear } from '../dist/server/billing.js';
import { billableLines, checkVersion, openStore, readReceipts, submitOrder } from '../dist/server/store.js';
import { saveSplit } from '../dist/server/check-splits.js';
import { billAmounts, defaultBillingProfile, validGstin } from '../dist/shared/billing.js';

const origin = 'http://127.0.0.1:3100';
const buyer = { name: '', address: '', gstin: '', placeState: '20' };
const profile = { ...defaultBillingProfile, enabled: true, legalName: 'Sample outlet', address: 'Ranchi, Jharkhand' };
function fixture(path = ':memory:') {
  const db = openStore(path);
  const cookies = {};
  for (const role of ['admin', 'billing', 'kitchen', 'waiter']) {
    const id = Number(db.prepare('INSERT INTO staff(username,name,role,password_hash) VALUES (?,?,?,?)').run(role, role, role, 'fixture').lastInsertRowid);
    const token = createHash('sha256').update(role).digest('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), id, Date.now() + 600_000);
    cookies[role] = `staff_session=${token}`;
  }
  db.exec("INSERT INTO menu(name,price_paise,category) VALUES ('Lunch',12500,'Mains'); INSERT INTO dining_tables(label) VALUES ('Table 7'); UPDATE outlet_settings SET mode='both';");
  const app = buildApp(db, { origin });
  const request = (method, url, body, role = 'billing') => app.inject({ method, url,
    headers: { host: '127.0.0.1:3100', cookie: cookies[role], origin }, payload: body });
  const identity = orderId => ({ orderId, splitId: null, checkNumber: 1, checkVersion: checkVersion(billableLines(db, orderId)) });
  const tableOrder = () => submitOrder(db, 1, 4, { requestId: randomUUID(), lines: [{ menuId: 1, quantity: 2, expectedPricePaise: 12500 }] });
  const configure = async (next = profile) => {
    const response = await request('PUT', '/api/outlet/billing', next, 'admin');
    assert.equal(response.statusCode, 204, response.body);
  };
  const quote = async (id, customer = buyer, couponCode = '') => {
    const response = await request('POST', '/api/tables/1/bill-quote', { ...id, buyer: customer, couponCode });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  return { db, app, request, identity, tableOrder, configure, quote };
}

test('paise calculations reconcile local/interstate, inclusive/exclusive, discounts and odd paise', () => {
  const gst = { ...profile, taxMode: 'gst', rateBasisPoints: 500 };
  assert.deepEqual(billAmounts(10500, 0, gst, '20'), { taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, igstPaise: 0, roundingPaise: 0, totalPaise: 10500 });
  assert.equal(billAmounts(11000, 1000, { ...gst, pricesIncludeTax: false }, '07').igstPaise, 500);
  for (let amount = 0; amount < 1000; amount++) {
    for (const state of ['20', '07']) {
      const result = billAmounts(amount, 0, gst, state);
      assert.equal(result.totalPaise, amount);
      assert.equal(result.taxablePaise + result.cgstPaise + result.sgstPaise + result.igstPaise + result.roundingPaise, amount);
      assert.equal(result.cgstPaise, result.sgstPaise);
    }
  }
  assert.equal(validGstin('27AAPFU0939F1ZV'), true);
  assert.equal(validGstin('27AAPFU0939F1ZA'), false);
  assert.equal(financialYear(Date.parse('2026-03-31T18:29:59Z')), '2526');
  assert.equal(financialYear(Date.parse('2026-03-31T18:30:00Z')), '2627');
});

test('owner configuration, immutable table bills, retry identities and stale reviews', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('PUT', '/api/outlet/billing', profile)).statusCode, 403);
    assert.equal((await f.request('PUT', '/api/outlet/billing', { ...profile, series: 'TOO-LONG' }, 'admin')).statusCode, 400);
    await f.configure();
    assert.equal((await f.request('PUT', '/api/outlet/billing', profile, 'admin')).statusCode, 409);
    const id = f.identity(f.tableOrder());
    const quote = await f.quote(id);
    const input = { ...id, buyer, couponCode: '', requestId: randomUUID(), reviewHash: quote.reviewHash, paymentMethod: null };
    assert.equal((await f.request('POST', '/api/tables/1/bills', input, 'waiter')).statusCode, 403);
    await f.configure({ ...profile, revision: 1, legalName: 'Updated outlet' });
    assert.equal((await f.request('POST', '/api/tables/1/bills', input)).statusCode, 409);
    input.reviewHash = (await f.quote(id)).reviewHash;
    const created = await f.request('POST', '/api/tables/1/bills', input);
    assert.equal(created.statusCode, 200, created.body);
    const bill = created.json();
    assert.equal(bill.kind, 'receipt');
    assert.equal(bill.totalPaise, 25000);
    assert.match(bill.number, /^RP\/\d{4}\/000001$/);
    assert.equal(bill.number.length <= 16, true);
    assert.deepEqual((await f.request('POST', '/api/tables/1/bills', input)).json(), bill);
    assert.equal((await f.request('POST', '/api/tables/1/bills', { ...input, paymentMethod: 'Cash' })).statusCode, 409);
    assert.equal((await f.request('POST', '/api/tables/2/bills', input)).statusCode, 409);
    f.db.exec("UPDATE menu SET name='Different lunch',price_paise=99999;");
    await f.configure({ ...profile, revision: 2, address: 'New address' });
    assert.deepEqual(readReceipts(f.db, id.orderId)[0].bill, bill);
    assert.equal(f.db.prepare('SELECT last_number FROM bill_sequences').get().last_number, 1);
    const paid = await f.request('POST', '/api/tables/1/receipts', { ...id, reference: bill.number, officialTotalPaise: bill.totalPaise, paymentMethod: 'Cash' });
    assert.equal(paid.statusCode, 204, paid.body);
    assert.equal(readReceipts(f.db, id.orderId)[0].paymentMethod, 'Cash');
  } finally { await f.app.close(); f.db.close(); }
});

test('split checks allocate their own quantities, discounts and unique bill numbers', async () => {
  const f = fixture();
  try {
    await f.configure();
    const orderId = f.tableOrder();
    const line = f.db.prepare('SELECT id,revision FROM order_lines WHERE order_id=?').get(orderId);
    saveSplit(f.db, 1, 2, { orderId, requestId: randomUUID(), lineVersions: [{ lineId: line.id, revision: line.revision }],
      checks: [[{ lineId: line.id, quantity: 1 }], [{ lineId: line.id, quantity: 1 }]] });
    const splitId = f.db.prepare('SELECT id FROM order_splits').get().id;
    f.db.exec("INSERT INTO coupons(code,discount_paise,minimum_paise,expires_at) VALUES ('SAVE',1000,0,NULL)");
    for (const checkNumber of [1, 2]) {
      const id = { ...f.identity(orderId), splitId, checkNumber };
      const quote = await f.quote(id, buyer, checkNumber === 1 ? 'SAVE' : '');
      const response = await f.request('POST', '/api/tables/1/bills', { ...id, buyer, couponCode: checkNumber === 1 ? 'SAVE' : '',
        requestId: randomUUID(), reviewHash: quote.reviewHash, paymentMethod: 'Cash' });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().items[0].quantity, 1);
      assert.equal(response.json().totalPaise, checkNumber === 1 ? 11500 : 12500);
    }
    assert.equal(new Set(readReceipts(f.db, orderId).map(receipt => receipt.reference)).size, 2);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally { await f.app.close(); f.db.close(); }
});

test('counter bill and token commit together; partial/full credits reconcile the original invoice', async () => {
  const f = fixture();
  try {
    await f.configure({ ...profile, stateCode: '27', taxMode: 'gst', gstin: '27AAPFU0939F1ZV', classification: '996331', rateBasisPoints: 500 });
    const customer = { ...buyer, placeState: '27' };
    const created = await f.request('POST', '/api/counter-orders', { requestId: randomUUID(), fulfillment: 'takeaway', customer: 'Guest',
      seating: '', paper: 'none', paperReference: '', lines: [{ menuId: 1, quantity: 2, expectedPricePaise: 12500 }] });
    assert.equal(created.statusCode, 200, created.body);
    const orderId = created.json().orderId;
    const quoteResponse = await f.request('POST', `/api/counter-orders/${orderId}/bill-quote`, { revision: 0, buyer: customer, couponCode: '' });
    assert.equal(quoteResponse.statusCode, 200, quoteResponse.body);
    const quote = quoteResponse.json();
    const payment = { requestId: randomUUID(), revision: 0, reference: 'BUILT-IN', officialTotalPaise: quote.bill.totalPaise, paymentMethod: 'Cash',
      builtIn: { reviewHash: quote.reviewHash, buyer: customer, couponCode: '' } };
    f.db.exec("CREATE TRIGGER fail_token BEFORE UPDATE OF token_number ON counter_orders BEGIN SELECT RAISE(ABORT,'interrupted'); END");
    assert.equal((await f.request('POST', `/api/counter-orders/${orderId}/payment`, payment)).statusCode, 500);
    for (const table of ['built_in_bills', 'check_receipts', 'bill_sequences', 'receipt_feedback_codes']) {
      assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    f.db.exec('DROP TRIGGER fail_token');
    assert.equal((await f.request('POST', `/api/counter-orders/${orderId}/payment`, { ...payment, officialTotalPaise: 1 })).statusCode, 409);
    assert.equal((await f.request('POST', `/api/counter-orders/${orderId}/payment`, payment)).statusCode, 200);
    assert.equal((await f.request('POST', `/api/counter-orders/${orderId}/payment`, payment)).statusCode, 200);
    const original = readReceipts(f.db, orderId)[0].bill;
    const lineId = f.db.prepare('SELECT id FROM order_lines WHERE order_id=?').get(orderId).id;
    const reduce = { requestId: randomUUID(), revision: 1, action: 'reduce', reason: 'Wrong quantity', reference: '', lineId, quantity: 1, amountPaise: 12500 };
    const reduced = await f.request('POST', `/api/counter-orders/${orderId}/action`, reduce);
    assert.equal(reduced.statusCode, 200, reduced.body);
    assert.equal((await f.request('POST', `/api/counter-orders/${orderId}/action`, reduce)).statusCode, 200);
    const cancelled = await f.request('POST', `/api/counter-orders/${orderId}/action`, { requestId: randomUUID(), revision: 2, action: 'cancel', reason: 'Cancelled remainder', reference: '' });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const notes = f.db.prepare('SELECT snapshot FROM built_in_credit_notes').all().map(row => JSON.parse(row.snapshot));
    assert.equal(notes.length, 2);
    for (const field of ['totalPaise', 'taxablePaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'roundingPaise']) {
      assert.equal(notes.reduce((sum, note) => sum + note[field], 0), original[field], field);
    }
    assert.equal(notes.every(note => note.originalNumber === original.number), true);
    const kitchen = (await f.request('GET', '/api/service', undefined, 'kitchen')).json();
    assert.equal(kitchen.billingProfile, undefined);
    assert.equal(JSON.stringify(kitchen).includes(original.number), false);
    assert.deepEqual(readReceipts(f.db, orderId)[0].bill, original);
  } finally { await f.app.close(); f.db.close(); }
});

test('financial year rollover and series exhaustion do not reuse invoice numbers', async () => {
  const f = fixture();
  try {
    assert.equal(allocateBillNumber(f.db, 'RP', Date.parse('2026-03-31T18:29:59Z')), 'RP/2526/000001');
    assert.equal(allocateBillNumber(f.db, 'RP', Date.parse('2026-03-31T18:30:00Z')), 'RP/2627/000001');
    assert.equal(allocateBillNumber(f.db, 'RP', Date.parse('2026-03-31T18:29:58Z')), 'RP/2526/000002');
    f.db.exec("UPDATE bill_sequences SET last_number=999999 WHERE financial_year='2627'");
    assert.throws(() => allocateBillNumber(f.db, 'RP', Date.parse('2026-04-01')), /series is full/);
  } finally { await f.app.close(); f.db.close(); }
});

test('GST profile validation, buyer requirements, interstate tax, and composition billing', async () => {
  const f = fixture();
  try {
    const gst = { ...profile, stateCode: '27', taxMode: 'gst', gstin: '27AAPFU0939F1ZV', classification: '996331',
      rateBasisPoints: 500, pricesIncludeTax: false };
    for (const invalid of [{ gstin: '27AAPFU0939F1ZA' }, { stateCode: '20' }, { rateBasisPoints: 0 }, { classification: '' }]) {
      assert.equal((await f.request('PUT', '/api/outlet/billing', { ...gst, ...invalid }, 'admin')).statusCode, 400);
    }
    await f.configure(gst);
    const id = f.identity(f.tableOrder());
    const quote = await f.quote(id);
    assert.equal(quote.bill.igstPaise, 1250);
    assert.equal(quote.bill.cgstPaise, 0);
    assert.equal(quote.bill.totalPaise, 26250);
    assert.equal((await f.request('POST', '/api/tables/1/bill-quote', { ...id, buyer: { ...buyer, gstin: gst.gstin }, couponCode: '' })).statusCode, 400);
    assert.equal((await f.request('POST', '/api/tables/1/bill-quote', { ...id, buyer: { ...buyer, placeState: '99' }, couponCode: '' })).statusCode, 400);
    f.db.exec('UPDATE order_lines SET price_paise=2500000');
    const large = f.identity(id.orderId);
    assert.equal((await f.request('POST', '/api/tables/1/bill-quote', { ...large, buyer, couponCode: '' })).statusCode, 400);
    const named = await f.quote(large, { ...buyer, name: 'Customer', address: 'Customer address' });
    assert.equal(named.bill.totalPaise, 5250000);
    await f.configure({ ...gst, revision: 1, taxMode: 'composition', rateBasisPoints: 0 });
    const supply = await f.quote(large);
    assert.equal(supply.bill.kind, 'bill-of-supply');
    assert.equal(supply.bill.totalPaise, 5000000);
    assert.equal(supply.bill.igstPaise + supply.bill.cgstPaise + supply.bill.sgstPaise, 0);
  } finally { await f.app.close(); f.db.close(); }
});

test('saved invoice history enforces roles and preserves exact snapshots and sequences after reopen', async () => {
  const directory=mkdtempSync(join(tmpdir(),'restaurant-invoice-'));
  const path=join(directory,'test.sqlite');
  const f=fixture(path);
  let expected;
  try {
    await f.configure();
    const id=f.identity(f.tableOrder());
    const quote=await f.quote(id);
    const input={...id,buyer,couponCode:'',requestId:randomUUID(),reviewHash:quote.reviewHash,paymentMethod:'Cash'};
    const results=await Promise.all([input,{...input,requestId:randomUUID()}].map(body=>f.request('POST','/api/tables/1/bills',body)));
    assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,409]);
    expected=results.find(result=>result.statusCode===200).json();
    for(const role of ['waiter','kitchen'])assert.equal((await f.request('GET','/api/bills',undefined,role)).statusCode,403);
    assert.deepEqual((await f.request('GET','/api/bills',undefined,'admin')).json().bills,[expected]);
    assert.equal((await f.request('GET','/api/bills?offset=-1')).statusCode,400);
    assert.equal((await f.request('GET','/api/bills?search=MISSING')).json().bills.length,0);
    assert.equal((await f.request('GET','/api/bills?search=%27%20OR%201%3D1')).json().bills.length,0);
  } finally {await f.app.close();f.db.close();}
  try {
    const reopened=openStore(path);
    try {
      assert.deepEqual(readReceipts(reopened,1)[0].bill,expected);
      assert.equal(allocateBillNumber(reopened,'RP',expected.issuedAt),expected.number.replace('000001','000002'));
      assert.equal(reopened.prepare('PRAGMA foreign_key_check').get(),undefined);
    } finally {reopened.close();}
  } finally {rmSync(directory,{recursive:true});}
});

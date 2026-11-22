import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import jsQR from 'jsqr';
import sharp from 'sharp';
import { after, before, test } from 'node:test';
import { buildApp } from '../dist/server/app.js';
import { publicationTarget } from '../dist/server/menu-publication.js';
import { createStaff, openStore, storeSchemaVersion } from '../dist/server/store.js';
import { tableQrPreviewUrl } from '../dist/server/table-qr.js';
import { readWaiterActivity } from '../dist/server/waiter-activity.js';

test('opening a newer database fails closed without changing its data or journal mode', () => {
  const directory=mkdtempSync(join(tmpdir(),'restaurant-future-schema-'));
  const path=join(directory,'future.sqlite');
  try {
    const future=new DatabaseSync(path);
    future.exec(`CREATE TABLE future_marker(value TEXT); INSERT INTO future_marker VALUES('preserve'); PRAGMA user_version=${storeSchemaVersion+1};`);
    future.close();
    assert.throws(()=>openStore(path),/requires a newer application version/);
    const checked=new DatabaseSync(path,{readOnly:true});
    try {
      assert.equal(checked.prepare('PRAGMA user_version').get().user_version,storeSchemaVersion+1);
      assert.equal(checked.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
      assert.equal(checked.prepare('SELECT value FROM future_marker').get().value,'preserve');
    }finally{checked.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

const origin = 'http://127.0.0.1:3100';
const password = 'test-only-unique-fixture-password';
let directory, db, app;
const cookies = {};

function request(method, url, { role, body, headers } = {}) {
  return app.inject({
    method, url,
    headers: {
      host: new URL(origin).host,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(role ? { cookie: cookies[role] } : {}),
      ...headers
    },
    payload: body
  });
}

async function login(username) {
  const reply = await request('POST', '/api/session', { body: { username, password } });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.match(reply.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  return reply.headers['set-cookie'].split(';')[0];
}

const order = (lines = [{ menuId: 1, quantity: 2, note: 'Less spicy' }]) => ({ requestId: randomUUID(), lines });

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'restaurant-test-'));
  db = openStore(join(directory, 'test.sqlite'));
  app = buildApp(db, { origin });
  for (const username of ['waiter', 'second', 'kitchen', 'billing', 'admin']) {
    createStaff(db, username, username, username === 'second' ? 'waiter' : username, password);
    cookies[username] = await login(username);
  }
  db.exec(`
    INSERT INTO dining_tables (label) VALUES ('Table 7'), ('Table 8'), ('Table 9');
    INSERT INTO menu (name, price_paise) VALUES ('Paneer tikka', 24000), ('Masala chai', 6000);
  `);
});

after(async () => {
  await app.close();
  db.close();
  rmSync(directory, { recursive: true });
});

test('waiter, kitchen and counter share a complete order with durable status and a price snapshot', async () => {
  const body = order();
  const created = await request('POST', '/api/tables/1/orders', { role: 'waiter', body });
  assert.equal(created.statusCode, 200);
  const kitchen = await request('GET', '/api/service', { role: 'kitchen' });
  const line = kitchen.json().tables[0].lines[0];
  assert.equal(line.note, 'Less spicy');
  assert.equal(line.status, 'queued');
  for (const status of ['preparing', 'ready', 'ready']) {
    assert.equal((await request('PATCH', `/api/dishes/${line.id}`, { role: 'kitchen', body: { status } })).statusCode, 204);
  }
  assert.equal((await request('PATCH', `/api/dishes/${line.id}`, { role: 'kitchen', body: { status: 'preparing' } })).statusCode, 409);
  db.exec('UPDATE menu SET price_paise = 27000 WHERE id = 1');
  await app.close();
  db.close();
  db = openStore(join(directory, 'test.sqlite'));
  app = buildApp(db, { origin });
  const counter = await request('GET', '/api/service', { role: 'billing' });
  const persisted = counter.json().tables[0].lines[0];
  assert.deepEqual(persisted, { ...line, status: 'ready', revision: 2 });
  assert.equal(persisted.quantity * persisted.pricePaise, 48000);
  const retry = await request('POST', '/api/tables/1/orders', { role: 'waiter', body });
  assert.deepEqual(retry.json(), created.json());
  assert.equal((await request('GET', '/api/service', { role: 'billing' })).json().tables[0].lines.length, 1);
});

test('simultaneous table claims allow only one waiter, and retries cannot change the saved request', async () => {
  const body = order();
  const replies = await Promise.all(['waiter', 'second'].map(role => request('POST', '/api/tables/2/orders', { role, body })));
  assert.deepEqual(replies.map(reply => reply.statusCode).sort(), [200, 409]);
  const winner = replies[0].statusCode === 200 ? 'waiter' : 'second';
  const loser = winner === 'waiter' ? 'second' : 'waiter';
  assert.equal((await request('GET', '/api/service', { role: loser })).json().tables[1].lines.length, 0);
  const modified = await request('POST', '/api/tables/2/orders', { role: winner, body: { ...body, lines: [{ menuId: 2, quantity: 1 }] } });
  assert.equal(modified.statusCode, 409);
  assert.equal((await request('GET', '/api/service', { role: winner })).json().tables[1].lines.length, 1);
});

test('an unavailable dish rolls back the entire batch and leaves the table unclaimed', async () => {
  db.exec('UPDATE menu SET available = 0 WHERE id = 2');
  const failed = await request('POST', '/api/tables/3/orders', {
    role: 'waiter', body: order([{ menuId: 1, quantity: 1 }, { menuId: 2, quantity: 1 }])
  });
  assert.equal(failed.statusCode, 409);
  assert.match(failed.json().error, /Masala chai is sold out/);
  const menu = (await request('GET', '/api/service', { role: 'waiter' })).json().menu;
  assert.equal(menu.find(item => item.name === 'Masala chai').available, false);
  assert.equal((await request('GET', '/api/service', { role: 'billing' })).json().tables[2].orderId, null);
  db.exec('UPDATE menu SET available = 1 WHERE id = 2');
});

test('existing menu records keep their IDs, prices and availability when categories are introduced', () => {
  const path = join(directory, 'v1.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE menu (id INTEGER PRIMARY KEY, name TEXT, price_paise INTEGER, available INTEGER);
    CREATE TABLE order_lines (id INTEGER PRIMARY KEY, quantity INTEGER, note TEXT, status TEXT);
    CREATE TABLE dining_tables (id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, table_id INTEGER REFERENCES dining_tables(id), waiter_id INTEGER REFERENCES staff(id), opened_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE staff (id INTEGER PRIMARY KEY);
    CREATE TABLE order_requests (request_id TEXT, waiter_id INTEGER, payload TEXT);
    INSERT INTO staff VALUES (1);
    INSERT INTO order_requests VALUES ('old-request', 1, 'old-payload');
    INSERT INTO order_lines VALUES (17, 2, 'Less spicy', 'preparing');
    INSERT INTO menu VALUES (7, 'Legacy dish', 11000, 0);
    PRAGMA user_version = 1;
  `);
  legacy.close();
  const upgraded = openStore(path);
  try {
    assert.deepEqual({ ...upgraded.prepare('SELECT * FROM menu').get() },
      { id: 7, name: 'Legacy dish', price_paise: 11000, available: 0, category: 'Other',
        description: '', available_after: null, revision: 0, creation_request_id: null });
    assert.deepEqual({ ...upgraded.prepare('SELECT * FROM order_lines').get() },
      { id: 17, quantity: 2, note: 'Less spicy', status: 'preparing', revision: 0, cancelled_at: null, entry_source: 'waiter' });
    assert.deepEqual({ ...upgraded.prepare('SELECT * FROM order_requests').get() },
      { request_id: 'old-request', actor_id: 1, payload: 'old-payload', credited_waiter_id: 1, submitted_at: null });
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, storeSchemaVersion);
  } finally {
    upgraded.close();
  }
});

test('roles, validation, host restrictions and cross-origin protection are enforced on the server', async () => {
  assert.equal((await request('GET', '/api/service')).statusCode, 401);
  assert.equal((await request('POST', '/api/tables/3/orders', { role: 'admin', body: order() })).statusCode, 403);
  assert.equal((await request('POST', '/api/tables/3/orders', { role: 'billing', body: order() })).statusCode, 403);
  assert.equal((await request('PATCH', '/api/dishes/1', { role: 'waiter', body: { status: 'ready' } })).statusCode, 403);
  assert.equal((await request('POST', '/api/tables/3/orders', { role: 'waiter', body: order([{ menuId: 1, quantity: '2' }]) })).statusCode, 400);
  assert.equal((await request('POST', '/api/tables/3/orders', { role: 'waiter', body: order([{ menuId: 1, quantity: 1, pricePaise: 1 }]) })).statusCode, 400);
  assert.equal((await request('POST', '/api/tables/3/orders', { role: 'waiter', body: order(), headers: { origin: 'https://example.invalid' } })).statusCode, 403);
  assert.equal((await request('POST', '/api/tables/3/orders', { role: 'waiter', body: order(), headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal((await request('GET', '/api/service', { role: 'waiter', headers: { host: 'example.invalid' } })).statusCode, 403);
  assert.equal((await request('GET', '/assets/package.json')).statusCode, 404);
});

test('a table move and waiter transfer preserve the check and block stale writes', async () => {
  const initial = (await request('GET', '/api/service', { role: 'billing' })).json().tables[0];
  const transfer = (tableId, role, changes) => request('POST', `/api/tables/${tableId}/placement`, {
    role, body: { orderId: initial.orderId, waiterId: initial.waiter.id, ...changes }
  });
  const move = { action: 'move', destinationId: 3 };
  assert.equal((await transfer(1, 'kitchen', move)).statusCode, 403);
  assert.equal((await transfer(1, 'second', move)).statusCode, 403);
  assert.equal((await transfer(1, 'billing', { ...move, destinationId: 2 })).statusCode, 409);
  assert.equal((await transfer(1, 'billing', move)).statusCode, 204);
  assert.equal((await transfer(1, 'billing', move)).statusCode, 409);
  const moved = (await request('GET', '/api/service', { role: 'kitchen' })).json().tables[2];
  assert.equal(moved.orderId, initial.orderId);
  assert.deepEqual(moved.lines, initial.lines);
  const stale = await request('POST', '/api/tables/1/orders', { role: 'waiter', body: { ...order(), expectedOrderId: initial.orderId } });
  assert.equal(stale.statusCode, 409);
  assert.equal((await request('GET', '/api/service', { role: 'billing' })).json().tables[0].orderId, null);
  const state = (await request('GET', '/api/service', { role: 'billing' })).json();
  const second = state.waiters.find(waiter => waiter.name === 'second');
  assert.equal((await transfer(3, 'waiter', { action: 'transfer', destinationId: second.id })).statusCode, 204);
  assert.equal((await transfer(3, 'billing', { action: 'transfer', destinationId: second.id })).statusCode, 409);
  assert.equal((await request('GET', '/api/service', { role: 'waiter' })).json().tables[2].lines.length, 0);
  assert.deepEqual((await request('GET', '/api/service', { role: 'second' })).json().tables[2].lines, initial.lines);
  assert.equal(db.prepare('SELECT count(*) AS count FROM order_placements WHERE order_id = ?').get(initial.orderId).count, 2);
});

test('sent dish edits are audited, require approval once preparing, and expire when ready', async () => {
  const state = async () => (await request('GET', '/api/service', { role: 'billing' })).json().tables[0].lines;
  const started = await request('POST', '/api/tables/1/orders', {
    role: 'waiter', body: order([{ menuId: 1, quantity: 1 }])
  });
  assert.equal(started.statusCode, 200);
  const extra = await request('POST', '/api/tables/1/orders', {
    role: 'waiter', body: { ...order([{ menuId: 2, quantity: 2 }]), expectedOrderId: started.json().orderId }
  });
  assert.deepEqual(extra.json(), started.json());
  const [paneer, chai] = await state();
  const change = (line, body, role = 'waiter') => request('POST', `/api/dishes/${line.id}/changes`, { role, body });
  const progress = (line, status) => request('PATCH', `/api/dishes/${line.id}`, { role: 'kitchen', body: { status, revision: line.revision } });
  const decide = (id, approve, role = 'billing') => request('PATCH', `/api/dish-changes/${id}`, { role, body: { approve } });
  const payload = { requestId: randomUUID(), revision: paneer.revision, quantity: 2, note: 'No chilli' };
  assert.equal((await change(paneer, payload, 'second')).statusCode, 403);
  assert.equal((await change(paneer, payload, 'billing')).statusCode, 403);
  const applied = await change(paneer, payload);
  assert.equal(applied.json().outcome, 'applied');
  assert.deepEqual((await change(paneer, payload)).json(), applied.json());
  assert.equal((await progress(paneer, 'preparing')).statusCode, 409);
  assert.equal((await state())[0].note, 'No chilli');
  assert.equal((await state())[0].quantity, 2);
  assert.equal((await progress((await state())[0], 'preparing')).statusCode, 204);
  const cooking = (await state())[0];
  const cancellation = { requestId: randomUUID(), revision: cooking.revision, quantity: 0, note: cooking.note };
  const proposed = (await change(cooking, cancellation)).json();
  assert.equal(proposed.outcome, 'pending');
  assert.equal((await change(cooking, { ...cancellation, requestId: randomUUID() })).statusCode, 409);
  assert.equal((await state())[0].status, 'preparing');
  assert.equal((await decide(proposed.id, true, 'waiter')).statusCode, 403);
  assert.equal((await decide(proposed.id, true)).statusCode, 204);
  assert.equal((await decide(proposed.id, true)).statusCode, 204);
  assert.equal((await state())[0].status, 'cancelled');
  assert.equal((await progress(cooking, 'ready')).statusCode, 404);

  assert.equal((await progress(chai, 'preparing')).statusCode, 204);
  const currentChai = (await state())[1];
  const noteChange = { requestId: randomUUID(), revision: currentChai.revision, quantity: 2, note: 'No sugar' };
  const declined = (await change(currentChai, noteChange)).json();
  assert.equal((await decide(declined.id, false)).statusCode, 204);
  assert.equal((await state())[1].note, '');
  assert.equal((await state())[1].change.outcome, 'declined');
  const pending = (await change(currentChai, { ...noteChange, requestId: randomUUID() })).json();
  assert.equal((await progress(currentChai, 'ready')).statusCode, 204);
  assert.equal((await decide(pending.id, true)).statusCode, 409);
  assert.equal((await state())[1].change.outcome, 'expired');
  assert.equal(db.prepare('SELECT count(*) AS count FROM dish_changes WHERE line_id = ?').get(paneer.id).count, 2);
});

test('split checks reconcile to the order, preserve kitchen progress, and can be reopened', async () => {
  const table = (await request('GET', '/api/service', { role: 'billing' })).json().tables[0];
  const live = table.lines.find(line => line.status === 'ready');
  const cancelled = table.lines.find(line => line.status === 'cancelled');
  const payload = {
    orderId: table.orderId, requestId: randomUUID(), lineVersions: [{ lineId: live.id, revision: live.revision }],
    checks: [[{ lineId: live.id, quantity: 1 }], [{ lineId: live.id, quantity: 1 }]]
  };
  const save = (body, role = 'billing') => request('POST', '/api/tables/1/split', { role, body });
  assert.equal((await save(payload, 'waiter')).statusCode, 403);
  assert.equal((await save({ ...payload, lineVersions: [{ lineId: live.id, revision: 0 }] })).statusCode, 409);
  assert.equal((await save({ ...payload, checks: [payload.checks[0], [{ lineId: cancelled.id, quantity: 1 }]] })).statusCode, 409);
  assert.equal((await save({ ...payload, checks: [payload.checks[0], [{ lineId: live.id, quantity: 2 }]] })).statusCode, 409);
  assert.equal((await save(payload)).statusCode, 204);
  assert.equal((await save(payload)).statusCode, 204);
  const saved = (await request('GET', '/api/service', { role: 'billing' })).json().tables[0];
  assert.deepEqual(saved.checks.map(check => check.totalPaise), [live.pricePaise, live.pricePaise]);
  assert.equal((await request('GET', '/api/service', { role: 'kitchen' })).json().tables[0].lines.find(line => line.id === live.id).status, 'ready');
  assert.equal((await request('POST', '/api/tables/1/orders', { role: 'waiter', body: order() })).statusCode, 409);
  const destination = (await request('GET', '/api/service', { role: 'billing' })).json().tables[2];
  assert.equal((await request('POST', '/api/tables/1/placement', {
    role: 'billing', body: { action: 'join', orderId: table.orderId, waiterId: table.waiter.id, destinationId: 3, destinationOrderId: destination.orderId }
  })).statusCode, 409);
  const reopen = { orderId: table.orderId, splitId: saved.splitId };
  assert.equal((await request('POST', '/api/tables/1/split/reopen', { role: 'billing', body: reopen })).statusCode, 204);
  assert.equal((await request('POST', '/api/tables/1/split/reopen', { role: 'billing', body: reopen })).statusCode, 204);
  assert.equal((await save(payload)).statusCode, 204);
  assert.equal((await request('GET', '/api/service', { role: 'billing' })).json().tables[0].splitId, null);
});

test('joining tables preserves dish IDs, notes, states, and destination ownership', async () => {
  const before = (await request('GET', '/api/service', { role: 'billing' })).json().tables;
  const source = before[0];
  const target = before[2];
  const body = { action: 'join', orderId: source.orderId, waiterId: source.waiter.id, destinationId: 3, destinationOrderId: target.orderId };
  assert.equal((await request('POST', '/api/tables/1/placement', { role: 'waiter', body })).statusCode, 403);
  assert.equal((await request('POST', '/api/tables/1/placement', { role: 'billing', body: { ...body, destinationOrderId: source.orderId } })).statusCode, 409);
  assert.equal((await request('POST', '/api/tables/1/placement', { role: 'billing', body })).statusCode, 204);
  const after = (await request('GET', '/api/service', { role: 'billing' })).json().tables;
  assert.equal(after[0].orderId, null);
  assert.deepEqual(after[2].waiter, target.waiter);
  assert.deepEqual(after[2].lines, [...target.lines, ...source.lines].sort((a, b) => a.id - b.id));
  assert.equal(db.prepare('SELECT joined_order_id FROM order_placements WHERE order_id = ?').get(source.orderId).joined_order_id, target.orderId);
});

test('split receipts keep official amounts separate and gate safe release until all checks are paid', async () => {
  const billingState = async () => (await request('GET', '/api/service', { role: 'billing' })).json().tables[2];
  const table = await billingState();
  const lines = table.lines.filter(line => line.status !== 'cancelled');
  const split = {
    orderId: table.orderId, requestId: randomUUID(),
    lineVersions: lines.map(line => ({ lineId: line.id, revision: line.revision })),
    checks: lines.map(line => [{ lineId: line.id, quantity: line.quantity }])
  };
  assert.equal((await request('POST', '/api/tables/3/split', { role: 'billing', body: split })).statusCode, 204);
  const divided = await billingState();
  const release = (role = 'second') => request('POST', '/api/tables/3/release', { role, body: { orderId: divided.orderId } });
  const pay = (body, role = 'billing') => request('POST', '/api/tables/3/receipts', { role, body });
  const first = {
    orderId: divided.orderId, splitId: divided.splitId, checkNumber: 1, checkVersion: divided.checkVersion,
    reference: 'POS-01', officialTotalPaise: divided.checks[0].totalPaise + 500, paymentMethod: null
  };
  assert.equal((await pay(first, 'waiter')).statusCode, 403);
  assert.equal((await pay({ ...first, checkVersion: '0'.repeat(64) })).statusCode, 409);
  const offer = { code: 'ranchi50', discountPaise: 5000, minimumPaise: 0, expiresAt: null };
  const create = (body, role = 'admin') => request('POST', '/api/coupons', { role, body });
  assert.equal((await request('GET', '/api/coupons', { role: 'billing' })).statusCode, 403);
  assert.equal((await create(offer, 'billing')).statusCode, 403);
  assert.equal((await create(offer)).statusCode, 204);
  assert.equal((await create(offer)).statusCode, 204);
  assert.equal((await create({ ...offer, discountPaise: 5500 })).statusCode, 409);
  assert.equal((await create({ ...offer, code: 'OLD', expiresAt: Date.now() - 1 })).statusCode, 400);
  assert.equal((await create({ ...offer, code: 'MINIMUM', minimumPaise: divided.checks[0].totalPaise + 1 })).statusCode, 204);
  assert.equal((await create({ ...offer, code: 'CAPPED', discountPaise: divided.checks[0].totalPaise + 1 })).statusCode, 204);
  assert.equal((await create({ ...offer, code: 'EXPIRED', expiresAt: Date.now() + 60_000 })).statusCode, 204);
  db.prepare('UPDATE coupons SET expires_at = ? WHERE code = ?').run(Date.now() - 1, 'EXPIRED');
  const identity = { orderId: first.orderId, splitId: first.splitId, checkNumber: first.checkNumber, checkVersion: first.checkVersion };
  const quote = (code, role = 'billing', check = identity) => request('POST', '/api/tables/3/coupon-quote', { role, body: { ...check, code } });
  assert.equal((await quote('RANCHI50', 'admin')).statusCode, 403);
  assert.equal((await quote('RANCHI50', 'billing', { ...identity, checkVersion: '0'.repeat(64) })).statusCode, 409);
  for (const code of ['UNKNOWN', 'EXPIRED', 'MINIMUM']) assert.equal((await quote(code)).statusCode, 422);
  assert.equal((await quote('CAPPED')).json().discountPaise, divided.checks[0].totalPaise);
  const coupon = (await quote(' ranchi50 ')).json();
  assert.deepEqual(coupon, { code: 'RANCHI50', discountPaise: 5000 });
  const enable = enabled => request('PATCH', '/api/coupons/RANCHI50', { role: 'admin', body: { enabled } });
  assert.equal((await enable(false)).statusCode, 204);
  assert.equal((await pay({ ...first, coupon })).statusCode, 422);
  assert.equal((await enable(true)).statusCode, 204);
  assert.equal((await pay({ ...first, coupon: { ...coupon, discountPaise: 1 } })).statusCode, 409);
  const retries = await Promise.all([pay({ ...first, coupon }), pay({ ...first, coupon })]);
  assert.deepEqual(retries.map(reply => reply.statusCode), [204, 204]);
  assert.equal((await billingState()).receipts.length, 1);
  assert.equal((await billingState()).receipts[0].feedback, undefined);
  assert.equal((await quote('RANCHI50')).statusCode, 409);
  assert.equal((await pay({ ...first, checkNumber: 2, reference: 'pos-01' })).statusCode, 409);
  assert.equal((await request('POST', '/api/tables/3/split/reopen', {
    role: 'billing', body: { orderId: divided.orderId, splitId: divided.splitId }
  })).statusCode, 409);
  assert.equal((await release()).statusCode, 409);
  assert.equal((await pay({ ...first, paymentMethod: 'UPI' })).statusCode, 204);
  const feedback = (await billingState()).receipts[0].feedback;
  assert.match(feedback.code, /^(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/);
  assert.equal(feedback.published, false);
  assert.equal((await pay(first)).statusCode, 204);
  assert.equal((await billingState()).receipts[0].paymentMethod, 'UPI');
  assert.equal((await pay({ ...first, paymentMethod: 'Cash' })).statusCode, 409);
  for (let i = 1; i < divided.checks.length; i++) {
    const check = divided.checks[i];
    assert.equal((await pay({ ...first, checkNumber: i + 1, reference: `POS-${i + 1}`,
      officialTotalPaise: check.totalPaise, paymentMethod: 'Cash' })).statusCode, 204);
  }
  await app.close();
  db.close();
  db = openStore(join(directory, 'test.sqlite'));
  app = buildApp(db, { origin });
  const paid = await billingState();
  assert.equal(paid.receipts[0].officialTotalPaise, divided.checks[0].totalPaise + 500);
  assert.deepEqual(paid.receipts[0].coupon, coupon);
  assert.deepEqual(paid.receipts[0].feedback, feedback);
  assert.equal(new Set(paid.receipts.map(receipt => receipt.feedback.code)).size, paid.receipts.length);
  assert.equal((await request('GET', '/api/feedback', { role: 'billing' })).statusCode, 403);
  assert.deepEqual((await request('GET', '/api/feedback', { role: 'admin' })).json(), { configured: false, feedback: [] });
  assert.equal(paid.checks[0].totalPaise, divided.checks[0].totalPaise);
  assert.equal(paid.canRelease, true);
  assert.equal((await release('waiter')).statusCode, 403);
  assert.equal((await release()).statusCode, 204);
  assert.equal((await release()).statusCode, 204);
  assert.equal((await billingState()).orderId, null);
  const nextParty = await request('POST', '/api/tables/3/orders', { role: 'waiter', body: { ...order(), expectedOrderId: null } });
  assert.equal(nextParty.statusCode, 200);
  assert.notEqual(nextParty.json().orderId, divided.orderId);
  assert.deepEqual((await billingState()).receipts, []);
});

test('the assigned waiter can release a fully cancelled order without a receipt', async () => {
  const first = await request('POST', '/api/tables/1/orders', { role: 'waiter', body: order() });
  assert.equal(first.statusCode, 200);
  const table = (await request('GET', '/api/service', { role: 'waiter' })).json().tables[0];
  const line = table.lines[0];
  const cancelled = await request('POST', `/api/dishes/${line.id}/changes`, {
    role: 'waiter', body: { requestId: randomUUID(), revision: line.revision, quantity: 0, note: line.note }
  });
  assert.equal(cancelled.json().outcome, 'applied');
  const released = await request('POST', '/api/tables/1/release', { role: 'waiter', body: { orderId: table.orderId } });
  assert.equal(released.statusCode, 204);
});

test('paper orders keep staff credit, separate served history from the kitchen queue, and retry safely', async () => {
  const service = async role => (await request('GET', '/api/service', { role })).json();
  const billing = await service('billing');
  const credited = billing.waiters.find(waiter => waiter.name === 'second');
  const other = billing.waiters.find(waiter => waiter.name === 'waiter');
  const submit = (body, role = 'billing') => request('POST', '/api/tables/1/paper-orders', { role, body });
  const body = { ...order([{ menuId: 2, quantity: 1, note: 'Paper slip note' }]), expectedOrderId: null, creditedWaiterId: credited.id };
  db.exec('UPDATE menu SET available = 0 WHERE id = 2');
  assert.equal((await submit({ ...body, mode: 'served' }, 'waiter')).statusCode, 403);
  assert.equal((await submit({ ...body, mode: 'served', creditedWaiterId: billing.staff.id })).statusCode, 409);
  assert.equal((await submit({ ...body, mode: 'live' })).statusCode, 409);
  assert.equal((await service('billing')).tables[0].orderId, null);
  const served = await submit({ ...body, mode: 'served' });
  assert.equal(served.statusCode, 200);
  assert.deepEqual((await submit({ ...body, mode: 'served' })).json(), served.json());
  assert.equal((await submit({ ...body, mode: 'live' })).statusCode, 409);
  const table = (await service('billing')).tables[0];
  assert.equal(table.waiter.id, credited.id);
  assert.equal(table.lines.length, 1);
  assert.equal(table.lines[0].status, 'ready');
  assert.equal(table.lines[0].entrySource, 'paper-served');
  assert.equal((await service('kitchen')).tables[0].lines.length, 0);
  assert.equal((await request('PATCH', `/api/dishes/${table.lines[0].id}`, { role: 'kitchen', body: { status: 'ready' } })).statusCode, 404);

  const live = { ...order([{ menuId: 1, quantity: 1 }]), expectedOrderId: table.orderId, creditedWaiterId: other.id, mode: 'live' };
  assert.equal((await submit({ ...live, expectedOrderId: null })).statusCode, 409);
  assert.deepEqual((await submit(live)).json(), served.json());
  assert.equal((await service('billing')).tables[0].waiter.id, credited.id);
  const [ticket] = (await service('kitchen')).tables[0].lines;
  assert.equal(ticket.status, 'queued');
  assert.equal(ticket.entrySource, 'paper-live');
  assert.equal((await service('kitchen')).tables[0].lines.length, 1);
  const saved = db.prepare('SELECT actor_id, credited_waiter_id, submitted_at FROM order_requests WHERE request_id = ?').get(live.requestId);
  assert.equal(saved.actor_id, billing.staff.id);
  assert.equal(saved.credited_waiter_id, other.id);
  assert.ok(saved.submitted_at > 0);
  db.exec('UPDATE menu SET available = 1 WHERE id = 2');
});

test('catalog roles, stale edits, sold-out timing, and order price snapshots are enforced', async () => {
  const catalog = async role => (await request('GET', '/api/service', { role })).json().menu;
  const item = { name: 'Lemon rice', category: 'Mains', description: 'With curry leaves', pricePaise: 12550 };
  const create = { ...item, requestId: randomUUID() };
  assert.equal((await request('POST', '/api/menu', { role: 'kitchen', body: create })).statusCode, 403);
  const saved = await request('POST', '/api/menu', { role: 'admin', body: create });
  assert.equal(saved.statusCode, 200, saved.body);
  const { id } = saved.json();
  assert.deepEqual((await request('POST', '/api/menu', { role: 'admin', body: create })).json(), { id });
  assert.equal((await request('POST', '/api/menu', { role: 'admin', body: { ...create, name: 'Other dish' } })).statusCode, 409);
  const dish = (await catalog('kitchen')).find(entry => entry.id === id);
  assert.equal(dish.description, item.description);
  const adjust = (body, role = 'kitchen') => request('PATCH', `/api/menu/${id}/availability`, { role, body });
  const expected = Date.now() + 30 * 60_000;
  assert.equal((await adjust({ available: false, availableAfter: expected, revision: dish.revision }, 'waiter')).statusCode, 403);
  assert.equal((await adjust({ available: false, availableAfter: Date.now() - 10, revision: dish.revision })).statusCode, 400);
  assert.equal((await adjust({ available: false, availableAfter: expected, revision: dish.revision })).statusCode, 204);
  assert.equal((await request('PATCH', `/api/menu/${id}`, {
    role: 'admin', body: { ...item, pricePaise: 14000, revision: dish.revision }
  })).statusCode, 409);
  const sold = (await catalog('waiter')).find(entry => entry.id === id);
  assert.equal(sold.availableAfter, expected);
  db.prepare('UPDATE menu SET available_after = ? WHERE id = ?').run(Date.now() - 60_000, id);
  assert.equal((await catalog('waiter')).find(entry => entry.id === id).available, false);
  assert.equal((await adjust({ available: true, availableAfter: null, revision: sold.revision })).statusCode, 204);
  const available = (await catalog('billing')).find(entry => entry.id === id);
  assert.equal(available.availableAfter, null);
  assert.equal(available.available, true);

  const table = (await request('GET', '/api/service', { role: 'waiter' })).json().tables[2];
  const send = () => request('POST', '/api/tables/3/orders', {
    role: 'waiter', body: { ...order([{ menuId: id, quantity: 1, expectedPricePaise: item.pricePaise }]), expectedOrderId: table.orderId }
  });
  assert.equal((await send()).statusCode, 200);
  assert.equal((await request('PATCH', `/api/menu/${id}`, {
    role: 'admin', body: { ...item, pricePaise: 14000, revision: available.revision }
  })).statusCode, 204);
  assert.equal((await send()).statusCode, 409);
  const savedLines = (await request('GET', '/api/service', { role: 'waiter' })).json().tables[2].lines.filter(line => line.name === item.name);
  assert.equal(savedLines.length, 1);
  assert.equal(savedLines[0].pricePaise, item.pricePaise);
});

test('dish photos are sanitized, revision checked, and served with guest menu data only', async () => {
  const getGuest = () => request('GET', '/api/guest-menu');
  const before = (await getGuest()).json().items[0];
  assert.deepEqual(Object.keys(before).sort(),
    ['available', 'availableAfter', 'category', 'description', 'id', 'name', 'photoKey', 'pricePaise']);
  const adminItem = (await request('GET', '/api/service', { role: 'admin' })).json().menu[0];
  const photo = async background => (await sharp({ create: { width: 1500, height: 1000, channels: 3, background } }).png().toBuffer()).toString('base64');
  const encoded = await photo('#b47e51');
  const save = (revision, value, role = 'admin') => request('PATCH', `/api/menu/${before.id}/photo`, { role, body: { revision, encoded: value } });
  assert.equal((await save(adminItem.revision, encoded, 'kitchen')).statusCode, 403);
  assert.equal((await save(adminItem.revision, Buffer.from('<svg></svg>').toString('base64'))).statusCode, 400);
  const huge = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: 'white' } }).png().toBuffer();
  assert.equal((await save(adminItem.revision, huge.toString('base64'))).statusCode, 400);
  assert.equal((await save(adminItem.revision, encoded)).statusCode, 204);
  assert.equal((await save(adminItem.revision, encoded)).statusCode, 204);
  const replacement = await photo('#40505c');
  assert.equal((await save(adminItem.revision, replacement)).statusCode, 409);
  const after = (await getGuest()).json().items[0];
  const url = `/media/menu/${after.id}/${after.photoKey}`;
  const media = await request('GET', url);
  assert.equal(media.statusCode, 200);
  assert.equal(media.headers['content-type'], 'image/webp');
  const metadata = await sharp(media.rawPayload).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.exif, undefined);
  const currentRevision = async () => (await request('GET', '/api/service', { role: 'admin' })).json().menu[0].revision;
  assert.equal((await save(await currentRevision(), replacement)).statusCode, 204);
  const updated = (await getGuest()).json().items[0];
  assert.notEqual(updated.photoKey, after.photoKey);
  const replacementUrl = `/media/menu/${updated.id}/${updated.photoKey}`;
  assert.equal((await request('GET', replacementUrl)).statusCode, 200);
  assert.equal((await request('GET', url)).statusCode, 404);
  assert.equal((await save(await currentRevision(), null)).statusCode, 204);
  assert.equal((await request('GET', replacementUrl)).statusCode, 404);
  assert.equal((await getGuest()).json().items[0].photoKey, null);
});

test('publication status requires an admin session', async () => {
  assert.equal((await request('GET', '/api/menu/publication')).statusCode, 401);
  assert.equal((await request('GET', '/api/menu/publication', { role: 'kitchen' })).statusCode, 403);
  const status = await request('GET', '/api/menu/publication', { role: 'admin' });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json(), { configured: false, pending: false, publishedAt: null });
});

test('table QR cards are admin-only, require publication, and encode only the configured guest destination', async () => {
  const preview = 'http://127.0.0.1:3200/r/ranchi-cafe';
  assert.equal(tableQrPreviewUrl(preview), preview);
  assert.throws(() => tableQrPreviewUrl('http://example.test/r/ranchi-cafe'));
  assert.throws(() => tableQrPreviewUrl(`${preview}?other=outlet`));
  assert.equal((await request('GET', '/api/tables/1/qr')).statusCode, 401);
  assert.equal((await request('GET', '/api/tables/1/qr', { role: 'waiter' })).statusCode, 403);
  assert.equal((await request('GET', '/api/tables/1/qr', { role: 'admin' })).statusCode, 409);
  const target = publicationTarget({ RESTAURANT_PUBLISH_ORIGIN: 'https://menus.example.test',
    RESTAURANT_PUBLISH_OUTLET: 'ranchi-cafe', RESTAURANT_PUBLISH_TOKEN: 'a'.repeat(64) });
  const publisher = buildApp(db, { origin, publication: target, tableQrPreview: preview });
  const get = url => publisher.inject({ url, headers: { host: new URL(origin).host, cookie: cookies.admin } });
  try {
    assert.equal((await get('/api/tables/1/qr')).statusCode, 409);
    db.prepare(`UPDATE menu_publication SET destination = ?, published_version = version, published_at = ?`).run(target.endpoint, Date.now());
    assert.equal((await get('/api/tables/999/qr')).statusCode, 404);
    assert.equal((await get('/api/tables/-1/qr')).statusCode, 400);
    for (const id of [1, 2]) {
      const reply = await get(`/api/tables/${id}/qr?url=https://wrong.example.test/`);
      assert.equal(reply.statusCode, 200);
      assert.match(reply.headers['content-type'], /^image\/svg\+xml/);
      assert.equal(reply.headers['cache-control'], 'no-store');
      const { data, info } = await sharp(reply.rawPayload).resize(370, 370, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      assert.equal(code?.data, `https://menus.example.test/r/ranchi-cafe#table-${id}`);
    }
  } finally {
    db.exec('UPDATE menu_publication SET destination = NULL, published_version = NULL, published_at = NULL');
    await publisher.close();
  }
});

test('waiter activity uses India calendar periods, distinguishes entries, and preserves credit after assignment changes', () => {
  const reportDb = openStore(':memory:');
  try {
    reportDb.exec(`
      INSERT INTO staff (id, username, name, role, password_hash, enabled) VALUES
        (1, 'first', 'First waiter', 'waiter', 'fixture', 1),
        (2, 'second', 'Second waiter', 'waiter', 'fixture', 0),
        (3, 'counter', 'Counter', 'billing', 'fixture', 1);
      INSERT INTO dining_tables (id, label) VALUES (1, 'Table 7');
    `);
    const start = Date.parse('2026-11-09T00:00:00+05:30');
    const close = reportDb.prepare('INSERT INTO orders (id, table_id, waiter_id, opened_at, closed_at) VALUES (?, 1, 2, ?, ?)');
    for (const [id, opened] of [[1, start], [2, start - 1], [3, start + 100]]) close.run(id, opened, opened + 1000);
    const add = reportDb.prepare(`
      INSERT INTO order_requests (request_id, actor_id, table_id, order_id, payload, credited_waiter_id, submitted_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `);
    const waiter = JSON.stringify([[1, 1, '']]);
    add.run('first-round', 1, 1, waiter, 1, start);
    add.run('second-round', 1, 1, waiter, 1, start + 1);
    add.run('live-paper', 3, 1, '["paper-live",2,[[1,1,""]]]', 2, start + 2);
    add.run('served-paper', 3, 1, '["paper-served",2,[[1,1,""]]]', 2, Date.parse('2026-11-15T23:59:59.999+05:30'));
    add.run('next-week', 2, 1, waiter, 2, Date.parse('2026-11-16T00:00:00+05:30'));
    add.run('previous-day', 1, 2, waiter, 1, start - 1);
    add.run('legacy', 1, 3, waiter, 1, null);

    const day = readWaiterActivity(reportDb, 'day', '2026-11-09');
    assert.deepEqual(day.rows.map(row => [row.name, row.ordersHandled, row.orderEntries, row.livePaperEntries, row.estimatedEntries]),
      [['First waiter', 2, 3, 0, 1], ['Second waiter', 1, 1, 1, 0]]);
    assert.equal(day.rows[1].enabled, false);
    assert.equal(day.timezone, 'Asia/Kolkata');
    const week = readWaiterActivity(reportDb, 'week', '2026-11-12');
    assert.deepEqual([week.startDate, week.endDate], ['2026-11-09', '2026-11-15']);
    assert.deepEqual(week.rows.map(row => [row.orderEntries, row.servedPaperEntries]), [[3, 0], [2, 1]]);
    const month = readWaiterActivity(reportDb, 'month', '2026-11-12');
    assert.deepEqual([month.startDate, month.endDate], ['2026-11-01', '2026-11-30']);
    assert.deepEqual(month.rows.map(row => row.orderEntries), [4, 3]);
  } finally {
    reportDb.close();
  }
});

test('waiter activity reports require admin access and validate the date and period', async () => {
  const reportPath = '/api/reports/waiter-activity?period=day&date=2000-01-01';
  assert.equal((await request('GET', reportPath)).statusCode, 401);
  for (const role of ['waiter', 'kitchen', 'billing']) {
    assert.equal((await request('GET', reportPath, { role })).statusCode, 403);
  }
  const report = await request('GET', reportPath, { role: 'admin' });
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().rows.length, 2);
  assert.equal((await request('GET', '/api/reports/waiter-activity?period=day&date=2026-02-30', { role: 'admin' })).statusCode, 400);
  assert.equal((await request('GET', '/api/reports/waiter-activity?period=year', { role: 'admin' })).statusCode, 400);
});

test('sessions are hashed, expire, revoke on logout and stop working when a staff account is disabled', async () => {
  const token = cookies.admin.split('=')[1];
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token), undefined);
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(createHash('sha256').update(token).digest('hex')));
  const loggedOut = await request('POST', '/api/session/logout', { role: 'admin', body: {} });
  assert.equal(loggedOut.statusCode, 204);
  assert.equal((await request('GET', '/api/service', { role: 'admin' })).statusCode, 401);
  const billingToken = cookies.billing.split('=')[1];
  db.prepare('UPDATE sessions SET expires_at = 0 WHERE token_hash = ?').run(createHash('sha256').update(billingToken).digest('hex'));
  assert.equal((await request('GET', '/api/service', { role: 'billing' })).statusCode, 401);
  db.prepare('UPDATE staff SET enabled = 0 WHERE username = ?').run('kitchen');
  assert.equal((await request('GET', '/api/service', { role: 'kitchen' })).statusCode, 401);
});

test('repeated invalid logins are rate limited and use the same failure message for missing accounts', async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const reply = await request('POST', '/api/session', { body: { username: attempt % 2 ? 'missing' : 'waiter', password: 'wrong' } });
    assert.equal(reply.statusCode, 401);
    assert.equal(reply.json().error, 'Incorrect username or password.');
  }
  assert.equal((await request('POST', '/api/session', { body: { username: 'waiter', password } })).statusCode, 429);
});

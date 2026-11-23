import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildHostedApp } from '../dist/hosted/app.js';
import { acceptMenu, hostedPool, prepareHostedStore, provisionOutlet, publicationLease } from '../dist/hosted/database.js';
import { syncPickupChannel } from '../dist/hosted/online-ordering.js';
import { syncPickupPricing, reviewPickup, decidePickup } from '../dist/hosted/pickup-acceptance.js';
import { defaultBillingProfile } from '../dist/shared/billing.js';
import { validPickupRequest } from '../dist/shared/online-ordering.js';

test('customer confirmation is account-bound, immutable, atomic, retry-safe and never payment', { timeout: 30_000 }, async () => {
  assert.ok(process.env.HOSTED_TEST_DATABASE_URL);
  const namespace = `consent_${randomBytes(8).toString('hex')}`;
  const setup = hostedPool(process.env.HOSTED_TEST_DATABASE_URL);
  const pool = hostedPool(process.env.HOSTED_TEST_DATABASE_URL, `-c search_path=${namespace}`);
  const origin = 'https://consent.example.test';
  const token = randomBytes(32).toString('hex'), installation = randomUUID();
  const lease = publicationLease(`Bearer ${token}`, installation);
  const options = { origin, phoneKey: randomBytes(32), verifier: {} };
  const actor = { id: 1, name: 'Fixture cashier', role: 'billing' };
  const dish = pricePaise => ({ id: 1, name: 'Chai', pricePaise, available: true, availableAfter: null, photoKey: null, category: 'Drinks', description: '' });
  let app;
  const call = (order, method, suffix, payload, overrides = {}, slug = 'cafe') => app.inject({ method,
    url: `/api/online-pickup/${slug}${suffix}`, payload,
    headers: { host: 'consent.example.test', origin, cookie: `__Host-guest_session=${order.cookie}`, ...overrides } });
  async function request(accept = true) {
    const account = randomUUID(), cookie = randomBytes(32).toString('hex');
    await pool.query("INSERT INTO guest_accounts(id,phone_key,phone_last_four) VALUES($1,$2,'1111')", [account, randomBytes(32).toString('hex')]);
    await pool.query("INSERT INTO guest_sessions(token_hash,account_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [createHash('sha256').update(cookie).digest('hex'), account]);
    const customer = { cookie };
    const quote = await call(customer, 'POST', '/quote', { name: 'Customer', notes: '', lines: [{ menuId: 1, quantity: 2, note: '' }] });
    assert.equal(quote.statusCode, 200, quote.body);
    const pending = await call(customer, 'POST', '/requests', { requestId: randomUUID(), quoteId: quote.json().id });
    assert.equal(pending.statusCode, 200, pending.body);
    const order = pending.json();
    if (!accept) return { ...order, cookie };
    const review = await reviewPickup(pool, 'cafe', order.id, order.revision, lease);
    const saved = await decidePickup(pool, 'cafe', order.id, { requestId: randomUUID(), expectedRevision: order.revision,
      actor, decision: 'accept', reason: '', readyAt: Date.now() + 1_200_000, reviewHash: review.hash }, lease);
    return { ...saved, cookie };
  }
  const confirm = (order, payload = { expectedRevision: order.revision, reviewHash: order.acceptance.review.hash }, overrides = {}, slug = 'cafe') =>
    call(order, 'PUT', `/requests/${order.id}/confirmation`, payload, overrides, slug);
  try {
    await setup.query(`CREATE SCHEMA ${namespace}`); await prepareHostedStore(pool);
    await provisionOutlet(pool, 'cafe', 'Fixture Café', 'classic', token);
    await provisionOutlet(pool, 'other', 'Other', 'classic', randomBytes(32).toString('hex'));
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=true WHERE slug='cafe'");
    await acceptMenu(pool, 'cafe', 1, [dish(6500)], lease);
    await syncPickupChannel(pool, 'cafe', 1, true, lease);
    await syncPickupPricing(pool, 'cafe', { ...defaultBillingProfile, revision: 1, enabled: true, legalName: 'Fixture Café', address: 'Fixture address' }, lease);
    app = await buildHostedApp(pool, undefined, options);
    const order = await request(), other = await request();
    await pool.query('ALTER TABLE online_pickup_requests DROP COLUMN confirmation');
    await prepareHostedStore(pool); await prepareHostedStore(pool);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_requests WHERE confirmation IS NULL')).rows[0].n, 2);
    const payload = { expectedRevision: order.revision, reviewHash: order.acceptance.review.hash };
    assert.equal((await confirm(order, payload, { cookie: '' })).statusCode, 401);
    assert.equal((await confirm(order, payload, { origin: 'https://evil.example.test' })).statusCode, 403);
    assert.equal((await confirm(order, payload, { host: 'wrong.example.test' })).statusCode, 403);
    assert.equal((await confirm(order, payload, { cookie: `__Host-guest_session=${other.cookie}` })).statusCode, 404);
    assert.equal((await confirm(order, payload, {}, 'other')).statusCode, 404);
    assert.equal((await confirm(order, { ...payload, totalPaise: 1 })).statusCode, 400);
    assert.equal((await confirm(order, { ...payload, expectedRevision: 3 })).statusCode, 409);
    assert.equal((await confirm(order, { ...payload, reviewHash: 'a'.repeat(64) })).statusCode, 409);
    const pending = await request(false);
    assert.equal((await confirm(pending, payload)).statusCode, 409);
    await decidePickup(pool, 'cafe', pending.id, { requestId: randomUUID(), expectedRevision: 1, actor,
      decision: 'reject', reason: 'Fixture kitchen closed', readyAt: null, reviewHash: null }, lease);
    assert.equal((await confirm(pending, payload)).statusCode, 409);
    await syncPickupChannel(pool, 'cafe', 2, false, lease);
    assert.equal((await confirm(order)).statusCode, 503);
    await syncPickupChannel(pool, 'cafe', 3, true, lease);
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=false WHERE slug='cafe'");
    assert.equal((await confirm(order)).statusCode, 503);
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=true WHERE slug='cafe'");
    await pool.query("UPDATE online_pickup_channels SET heartbeat_at=clock_timestamp()-interval '46 seconds' WHERE outlet='cafe'");
    assert.equal((await confirm(order)).statusCode, 503);
    await syncPickupChannel(pool, 'cafe', 3, true, lease);
    // A changed menu cannot replace the accepted price the customer is confirming.
    await acceptMenu(pool, 'cafe', 2, [dish(7000)], lease);
    await pool.query(`CREATE FUNCTION fail_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.confirmation IS NOT NULL THEN RAISE EXCEPTION 'Fixture failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER consent_failure BEFORE UPDATE ON online_pickup_requests FOR EACH ROW EXECUTE FUNCTION fail_consent();`);
    assert.equal((await confirm(order)).statusCode, 500);
    assert.deepEqual((await pool.query('SELECT confirmation,revision::int FROM online_pickup_requests WHERE id=$1', [order.id])).rows[0], { confirmation: null, revision: 2 });
    await pool.query('DROP TRIGGER consent_failure ON online_pickup_requests; DROP FUNCTION fail_consent()');
    const replies = await Promise.all(Array.from({ length: 4 }, () => confirm(order)));
    assert.ok(replies.every(reply => reply.statusCode === 200));
    const saved = replies[0].json();
    assert.ok(replies.every(reply => JSON.stringify(reply.json()) === JSON.stringify(saved)));
    assert.equal(saved.status, 'awaiting_payment'); assert.equal(saved.revision, 3);
    assert.equal(saved.acceptance.review.amounts.totalPaise, 13000);
    assert.equal(saved.confirmation.reviewHash, payload.reviewHash);
    assert.equal(saved.confirmation.acceptedRevision, 2); assert.equal(validPickupRequest(saved), true);
    assert.equal(validPickupRequest({ ...saved, confirmation: { ...saved.confirmation, reviewHash: 'b'.repeat(64) } }), false);
    assert.equal(validPickupRequest({ ...saved, confirmation: { ...saved.confirmation, confirmedAt: saved.acceptance.paymentExpiresAt } }), false);
    assert.equal((await confirm(order, { ...payload, expectedRevision: 3 })).statusCode, 409);
    await app.close(); app = await buildHostedApp(pool, undefined, options);
    assert.deepEqual((await call(order, 'GET', `/requests/${order.id}`)).json(), saved);
    await pool.query("UPDATE online_pickup_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])", [[order.id, other.id]]);
    assert.equal((await confirm(other)).statusCode, 409);
    const expired = (await confirm(order)).json();
    assert.equal(expired.status, 'expired'); assert.deepEqual(expired.confirmation, saved.confirmation);
    await pool.query("UPDATE online_pickup_requests SET status='recovery_required',revision=revision+1 WHERE id=$1", [order.id]);
    const recovery = (await confirm(order)).json();
    assert.equal(recovery.status, 'recovery_required'); assert.deepEqual(recovery.confirmation, saved.confirmation);
    assert.equal(validPickupRequest(recovery), true);
    await pool.query("UPDATE online_pickup_requests SET status='recovery_required',revision=revision+1 WHERE id=$1", [other.id]);
    assert.equal((await confirm(other)).statusCode, 409);
  } finally {
    await app?.close(); await pool.end();
    try { await setup.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); } finally { await setup.end(); }
  }
});

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildHostedApp } from '../dist/hosted/app.js';
import { acceptMenu, hostedPool, prepareHostedStore, provisionOutlet, publicationLease } from '../dist/hosted/database.js';
import { syncPickupChannel } from '../dist/hosted/online-ordering.js';
import { defaultBillingProfile } from '../dist/shared/billing.js';
import { coordinateHostedRecovery } from '../dist/hosted/recovery.js';

test('restaurant pickup decisions are fresh, priced, audited, retry-safe and fenced on recovery', { timeout: 30_000 }, async () => {
  assert.ok(process.env.HOSTED_TEST_DATABASE_URL);
  const namespace = `pickup_decision_${randomBytes(8).toString('hex')}`;
  const setup = hostedPool(process.env.HOSTED_TEST_DATABASE_URL);
  const pool = hostedPool(process.env.HOSTED_TEST_DATABASE_URL, `-c search_path=${namespace}`);
  const token = randomBytes(32).toString('hex');
  const installation = randomUUID();
  const lease = publicationLease(`Bearer ${token}`, installation);
  const origin = 'https://pickup.example.test';
  const options = { origin, phoneKey: randomBytes(32), verifier: {} };
  const profile = { ...defaultBillingProfile, revision: 1, enabled: true, legalName: 'Sample Café', address: 'Sample address' };
  const actor = { id: 7, name: 'Sample cashier', role: 'billing' };
  const dish = pricePaise => ({ id: 1, name: 'Chai', category: 'Drinks', pricePaise, description: '', available: true, availableAfter: null, photoKey: null });
  let app;
  try {
    await setup.query(`CREATE SCHEMA ${namespace}`);
    await prepareHostedStore(pool);
    await provisionOutlet(pool, 'cafe', 'Café', 'classic', token);
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=true WHERE slug='cafe'");
    const otherToken = randomBytes(32).toString('hex');
    const otherInstallation = randomUUID();
    await provisionOutlet(pool, 'other', 'Other', 'classic', otherToken);
    await acceptMenu(pool, 'cafe', 1, [dish(6000)], lease);
    await acceptMenu(pool, 'other', 1, [dish(6000)], publicationLease(`Bearer ${otherToken}`, otherInstallation));
    await syncPickupChannel(pool, 'cafe', 1, true, lease);
    app = await buildHostedApp(pool, undefined, options);
    const machine = (method, suffix, payload, credential = token, identity = installation, slug = 'cafe') => app.inject({
      method, url: `/api/publish/${slug}${suffix}`, payload,
      headers: { authorization: `Bearer ${credential}`, 'x-outlet-installation': identity }
    });
    const guest = (cookie, method, suffix, payload) => app.inject({ method, url: `/api/online-pickup/cafe${suffix}`, payload,
      headers: { host: 'pickup.example.test', origin, cookie: `__Host-guest_session=${cookie}` } });
    async function newOrder() {
      const cookie = randomBytes(32).toString('hex');
      const account = randomUUID();
      await pool.query("INSERT INTO guest_accounts(id,phone_key,phone_last_four) VALUES($1,$2,'1111')", [account, randomBytes(32).toString('hex')]);
      await pool.query("INSERT INTO guest_sessions(token_hash,account_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [createHash('sha256').update(cookie).digest('hex'), account]);
      const quoted = await guest(cookie, 'POST', '/quote', { name: 'Customer', notes: '', lines: [{ menuId: 1, quantity: 2, note: 'Less sugar' }] });
      assert.equal(quoted.statusCode, 200);
      const response = await guest(cookie, 'POST', '/requests', { quoteId: quoted.json().id, requestId: randomUUID() });
      assert.equal(response.statusCode, 200);
      return { ...response.json(), cookie, account };
    }
    const review = order => machine('POST', `/pickup-requests/${order.id}/review`, { revision: order.revision });
    const decision = (order, input) => machine('POST', `/pickup-requests/${order.id}/decision`, input);
    const accept = (order, reviewHash) => ({ requestId: randomUUID(), expectedRevision: order.revision, actor,
      decision: 'accept', reason: '', readyAt: Date.now() + 1_200_000, reviewHash });
    const reject = order => ({ requestId: randomUUID(), expectedRevision: order.revision, actor,
      decision: 'reject', reason: 'Kitchen is closing', readyAt: null, reviewHash: null });
    const first = await newOrder();
    // Apply the preceding hosted schema to a populated fixture, then migrate twice.
    await pool.query(`DROP TABLE online_pickup_decisions; ALTER TABLE online_pickup_channels DROP COLUMN pricing;
      ALTER TABLE online_pickup_requests DROP COLUMN revision, DROP COLUMN decision;
      DROP INDEX online_pickup_one_open;
      ALTER TABLE online_pickup_requests DROP CONSTRAINT online_pickup_requests_status_check;
      ALTER TABLE online_pickup_requests ADD CONSTRAINT online_pickup_requests_status_check CHECK(status IN ('pending_acceptance','expired'));
      CREATE UNIQUE INDEX online_pickup_one_pending ON online_pickup_requests(outlet,account_id) WHERE status='pending_acceptance';`);
    await prepareHostedStore(pool);
    await prepareHostedStore(pool);
    assert.equal((await guest(first.cookie, 'GET', `/requests/${first.id}`)).json().revision, 1);
    assert.equal((await review(first)).statusCode, 409);
    assert.equal((await machine('PUT', '/pickup-pricing', { ...profile, revision: 0 })).statusCode, 400);
    assert.equal((await machine('PUT', '/pickup-pricing', { ...profile, gstin: 'invalid' })).statusCode, 400);
    assert.equal((await machine('PUT', '/pickup-pricing', profile)).statusCode, 204);
    assert.equal((await machine('PUT', '/pickup-pricing', profile)).statusCode, 204);
    assert.equal((await machine('PUT', '/pickup-pricing', { ...profile, legalName: 'Changed without revision' })).statusCode, 409);
    assert.equal((await machine('GET', '/pickup-requests', undefined, 'f'.repeat(64))).statusCode, 401);
    assert.equal((await machine('GET', '/pickup-requests', undefined, token, randomUUID())).statusCode, 401);
    const guestMachine = await app.inject({ method: 'GET', url: '/api/publish/cafe/pickup-requests', headers: { cookie: `__Host-guest_session=${first.cookie}` } });
    assert.equal(guestMachine.statusCode, 401);
    assert.equal((await machine('POST', `/pickup-requests/${first.id}/review`, { revision: 1 }, otherToken, otherInstallation, 'other')).statusCode, 404);
    let price = (await review(first)).json();
    assert.equal(price.amounts.totalPaise, 12000);
    assert.equal(price.currency, 'INR');
    assert.equal((await decision(first, { ...accept(first, price.hash), actor: { ...actor, role: 'kitchen' } })).statusCode, 403);
    assert.equal((await decision(first, { ...accept(first, price.hash), readyAt: Date.now() - 1 })).statusCode, 400);
    await acceptMenu(pool, 'cafe', 2, [dish(6500)], lease);
    assert.equal((await decision(first, accept(first, price.hash))).statusCode, 409);
    price = (await review(first)).json();
    const gst = { ...profile, revision: 2, stateCode: '27', taxMode: 'gst', gstin: '27AAPFU0939F1ZV',
      classification: '996331', rateBasisPoints: 500, pricesIncludeTax: false };
    assert.equal((await machine('PUT', '/pickup-pricing', gst)).statusCode, 204);
    assert.equal((await decision(first, accept(first, price.hash))).statusCode, 409);
    price = (await review(first)).json();
    assert.equal(price.subtotalPaise, 13000);
    assert.deepEqual(price.amounts, { taxablePaise: 13000, cgstPaise: 325, sgstPaise: 325, igstPaise: 0, roundingPaise: 0, totalPaise: 13650 });
    const input = accept(first, price.hash);
    const [accepted, duplicate] = await Promise.all([decision(first, input), decision(first, input)]);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(duplicate.json(), accepted.json());
    const saved = accepted.json();
    assert.equal(saved.status, 'awaiting_payment');
    assert.equal(saved.revision, 2);
    assert.equal(saved.quote.subtotalPaise, 12000);
    assert.equal(saved.acceptance.review.amounts.totalPaise, 13650);
    assert.equal(Object.hasOwn(saved, 'actor'), false);
    assert.equal(Object.hasOwn(saved.acceptance.review.seller, 'series'), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_decisions')).rows[0].n, 1);
    await prepareHostedStore(pool);
    await prepareHostedStore(pool);
    assert.deepEqual((await guest(first.cookie, 'GET', `/requests/${first.id}`)).json(), saved);
    assert.equal((await decision(first, { ...input, actor: { role: actor.role, name: actor.name, id: actor.id } })).statusCode, 200);
    assert.equal((await decision(first, { ...input, readyAt: input.readyAt + 1 })).statusCode, 409);
    assert.equal((await decision(first, { ...input, requestId: randomUUID() })).statusCode, 409);
    assert.equal((await machine('PUT', '/pickup-pricing', { ...gst, revision: 3, rateBasisPoints: 1000 })).statusCode, 204);
    assert.deepEqual((await decision(first, input)).json(), saved);
    await app.close();
    app = await buildHostedApp(pool, undefined, options);
    assert.deepEqual((await guest(first.cookie, 'GET', `/requests/${first.id}`)).json(), saved);
    assert.deepEqual((await decision(first, input)).json(), saved);
    const browseOnly = await buildHostedApp(pool);
    try {
      assert.equal((await browseOnly.inject({ method: 'GET', url: '/api/publish/cafe/pickup-requests',
        headers: { authorization: `Bearer ${token}`, 'x-outlet-installation': installation } })).statusCode, 503);
    } finally { await browseOnly.close(); }

    const rejectedOrder = await newOrder();
    await syncPickupChannel(pool, 'cafe', 2, false, lease);
    assert.equal((await review(rejectedOrder)).statusCode, 503);
    assert.equal((await decision(rejectedOrder, { ...reject(rejectedOrder), reason: ' ' })).statusCode, 400);
    const rejection = await decision(rejectedOrder, reject(rejectedOrder));
    assert.equal(rejection.statusCode, 200);
    assert.equal(rejection.json().rejection.reason, 'Kitchen is closing');
    assert.equal(rejection.json().status, 'rejected');
    assert.deepEqual((await machine('GET', `/pickup-requests/${rejectedOrder.id}`)).json(), rejection.json());
    await syncPickupChannel(pool, 'cafe', 3, true, lease);
    const expired = await newOrder();
    await pool.query("UPDATE online_pickup_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
    assert.equal((await review(expired)).statusCode, 409);
    assert.equal((await decision(expired, reject(expired))).statusCode, 409);
    assert.equal((await machine('GET', `/pickup-requests/${expired.id}`)).json().status, 'expired');
    const race = await newOrder();
    const racePrice = (await review(race)).json();
    const results = await Promise.all([decision(race, accept(race, racePrice.hash)), decision(race, reject(race))]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
    const failedOrder = await newOrder();
    const failedInput = accept(failedOrder, (await review(failedOrder)).json().hash);
    await pool.query(`CREATE FUNCTION fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected decision audit failure'; END $$;
      CREATE TRIGGER fail_decision BEFORE INSERT ON online_pickup_decisions FOR EACH ROW EXECUTE FUNCTION fail_decision();`);
    assert.equal((await decision(failedOrder, failedInput)).statusCode, 500);
    const unchanged = (await guest(failedOrder.cookie, 'GET', `/requests/${failedOrder.id}`)).json();
    assert.equal(unchanged.status, 'pending_acceptance');
    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.acceptance, undefined);
    await pool.query('DROP TRIGGER fail_decision ON online_pickup_decisions; DROP FUNCTION fail_decision();');
    assert.equal((await decision(failedOrder, failedInput)).statusCode, 200);
    await pool.query("UPDATE online_pickup_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [failedOrder.id]);
    assert.equal((await decision(failedOrder, failedInput)).json().status, 'expired');
    assert.ok((await machine('GET', `/pickup-requests/${failedOrder.id}`)).json().acceptance);

    // The transport walks more than one page without exposing sessions or audit actors.
    const bulk = Array.from({ length: 101 }, () => ({ account: randomUUID(), id: randomUUID(), request: randomUUID(), quote: randomUUID(), phone: randomBytes(32).toString('hex') }));
    await pool.query(`INSERT INTO guest_accounts(id,phone_key,phone_last_four)
      SELECT x.account::uuid,x.phone,'1111' FROM jsonb_to_recordset($1::jsonb) AS x(account text,phone text)`, [JSON.stringify(bulk)]);
    await pool.query(`INSERT INTO online_pickup_requests(id,outlet,account_id,request_id,quote_id,installation,status,snapshot,expires_at)
      SELECT x.id::uuid,'cafe',x.account::uuid,x.request::uuid,x.quote::uuid,$2,'pending_acceptance',$3,clock_timestamp()+interval '10 minutes'
      FROM jsonb_to_recordset($1::jsonb) AS x(id text,account text,request text,quote text)`, [JSON.stringify(bulk), installation, JSON.stringify(first.quote)]);
    const page = (await machine('GET', '/pickup-requests')).json();
    assert.equal(page.requests.length, 100);
    assert.ok(page.nextAfter);
    const next = (await machine('GET', `/pickup-requests?after=${page.nextAfter}`)).json();
    const ids = [...page.requests, ...next.requests].map(order => order.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(bulk.every(order => ids.includes(order.id)));
    assert.equal(next.nextAfter, null);
    assert.equal((await machine('GET', '/pickup-requests?after=invalid')).statusCode, 400);
    assert.ok(page.requests.every(order => !Object.hasOwn(order, 'account_id') && !Object.hasOwn(order, 'actor')));
    const replacement = randomUUID();
    await coordinateHostedRecovery(pool, 'cafe', `Bearer ${token}`, { requestId: randomUUID(), sourceHash: 'a'.repeat(64),
      installation, newInstallation: replacement, menuVersion: 2, offerVersion: 1, retireOffers: [] });
    const afterRecovery = (await guest(first.cookie, 'GET', `/requests/${first.id}`)).json();
    assert.equal(afterRecovery.status, 'recovery_required');
    assert.deepEqual(afterRecovery.acceptance, saved.acceptance);
    assert.equal((await decision(first, input)).statusCode, 401);
    const newLease = publicationLease(`Bearer ${token}`, replacement);
    await syncPickupChannel(pool, 'cafe', 4, true, newLease);
    const recoveredInbox = (await machine('GET', '/pickup-requests', undefined, token, replacement)).json();
    assert.ok(recoveredInbox.requests.some(order => order.id === first.id && order.status === 'recovery_required'));
    const blocked = await guest(first.cookie, 'POST', '/quote', { name: 'Customer', notes: '', lines: [{ menuId: 1, quantity: 1, note: '' }] });
    assert.equal(blocked.statusCode, 409);
    assert.equal((await pool.query('SELECT pricing FROM online_pickup_channels WHERE outlet=$1', ['cafe'])).rows[0].pricing, null);
  } finally {
    await app?.close();
    await pool.end();
    try { await setup.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); }
    finally { await setup.end(); }
  }
});

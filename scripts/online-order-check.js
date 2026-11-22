import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildHostedApp } from '../dist/hosted/app.js';
import { acceptMenu, hostedPool, prepareHostedStore, provisionOutlet, publicationLease } from '../dist/hosted/database.js';
import { syncPickupChannel } from '../dist/hosted/online-ordering.js';
import { coordinateHostedRecovery } from '../dist/hosted/recovery.js';

test('online pickup reviews and pending requests are priced, isolated, retry-safe and unavailable without a live outlet', { timeout: 25_000 }, async () => {
  assert.ok(process.env.HOSTED_TEST_DATABASE_URL, 'Provide a disposable PostgreSQL database.');
  const namespace = `online_check_${randomBytes(8).toString('hex')}`;
  const setup = hostedPool(process.env.HOSTED_TEST_DATABASE_URL);
  const pool = hostedPool(process.env.HOSTED_TEST_DATABASE_URL, `-c search_path=${namespace}`);
  const origin = 'https://orders.example.test';
  const token = randomBytes(32).toString('hex');
  const installation = randomUUID();
  const lease = publicationLease(`Bearer ${token}`, installation);
  const account = randomUUID();
  const secondAccount = randomUUID();
  const session = randomBytes(32).toString('hex');
  const secondSession = randomBytes(32).toString('hex');
  const sessionHash = value => createHash('sha256').update(value).digest('hex');
  const accountOptions = { origin, phoneKey: randomBytes(32), verifier: {} };
  const cart = { name: '  Pickup customer  ', notes: 'No plastic cutlery\nThank you', lines: [
    { menuId: 1, quantity: 2, note: 'Less sugar' }, { menuId: 3, quantity: 1, note: '<b>No onions</b>' }
  ] };
  let app;
  try {
    await setup.query(`CREATE SCHEMA ${namespace}`);
    await prepareHostedStore(pool);
    await prepareHostedStore(pool);
    await provisionOutlet(pool, 'cafe', 'Pickup Café', 'classic', token);
    const otherToken = randomBytes(32).toString('hex');
    await provisionOutlet(pool, 'other', 'Other Café', 'classic', otherToken);
    for (const [id, cookie] of [[account, session], [secondAccount, secondSession]]) {
      await pool.query('INSERT INTO guest_accounts(id,phone_key,phone_last_four) VALUES($1,$2,$3)', [id, randomBytes(32).toString('hex'), '1111']);
      await pool.query("INSERT INTO guest_sessions(token_hash,account_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [sessionHash(cookie), id]);
    }
    const dish = (id, pricePaise, available = true) => ({ id, pricePaise, available, availableAfter: null,
      name: `Dish ${id}`, category: 'Menu', description: '', photoKey: null });
    let menu = [dish(1, 6000), dish(2, 10000, false), dish(3, 22000)];
    await acceptMenu(pool, 'cafe', 1, menu, lease);
    const otherLease = publicationLease(`Bearer ${otherToken}`, randomUUID());
    await acceptMenu(pool, 'other', 1, menu, otherLease);
    await syncPickupChannel(pool, 'other', 1, true, otherLease);
    app = await buildHostedApp(pool, undefined, accountOptions);
    const call = (method, path, payload, cookie = session, headers = {}) => app.inject({ method,
      url: `/api/online-pickup/${path}`, payload, headers: { host: 'orders.example.test', origin,
        ...(cookie ? { cookie: `__Host-guest_session=${cookie}` } : {}), ...headers } });
    const quote = async (payload = cart, cookie = session) => call('POST', 'cafe/quote', payload, cookie);
    const submit = (quoteId, requestId = randomUUID(), cookie = session, slug = 'cafe') => call('POST', `${slug}/requests`, { requestId, quoteId }, cookie);
    assert.equal((await quote(cart, '')).statusCode, 401);
    assert.equal((await call('POST', 'cafe/quote', cart, session, { origin: 'https://evil.example.test' })).statusCode, 403);
    assert.equal((await quote()).statusCode, 503);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_quotes')).rows[0].n, 0);
    await syncPickupChannel(pool, 'cafe', 1, false, lease);
    assert.equal((await quote()).statusCode, 503);
    await assert.rejects(() => syncPickupChannel(pool, 'cafe', 1, true, lease), { statusCode: 409 });
    await syncPickupChannel(pool, 'cafe', 2, true, lease);
    await assert.rejects(() => syncPickupChannel(pool, 'cafe', 1, true, lease), { statusCode: 409 });
    await assert.rejects(() => syncPickupChannel(pool, 'cafe', 3, true, publicationLease(`Bearer ${token}`, randomUUID())), { statusCode: 409 });
    for (const invalid of [ { ...cart, subtotalPaise: 1 }, { ...cart, name: ' ' }, { ...cart, lines: [] },
      { ...cart, notes: '\0' }, { ...cart, lines: [{ menuId: 1, quantity: 21, note: '' }] },
      { ...cart, lines: [cart.lines[0], cart.lines[0]] }, { ...cart, lines: [{ menuId: 0, quantity: 1, note: '' }] } ]) {
      assert.equal((await quote(invalid)).statusCode, 400);
    }
    assert.equal((await quote({ ...cart, lines: [{ menuId: 2, quantity: 1, note: '' }] })).statusCode, 409);
    assert.equal((await quote({ ...cart, lines: [{ menuId: 999, quantity: 1, note: '' }] })).statusCode, 409);
    assert.equal((await quote({ ...cart, lines: Array.from({ length: 6 }, (_, index) => ({ menuId: index + 1, quantity: 20, note: '' })) })).statusCode, 400);
    const reviewResponse = await quote();
    assert.equal(reviewResponse.statusCode, 200);
    const review = reviewResponse.json();
    assert.equal(review.subtotalPaise, 34000);
    assert.equal(review.name, 'Pickup customer');
    assert.equal(review.lines[1].note, '<b>No onions</b>');
    assert.equal(Object.hasOwn(review, 'account_id'), false);
    assert.equal((await submit(review.id, randomUUID(), secondSession)).statusCode, 409);
    assert.equal((await submit(review.id, randomUUID(), session, 'other')).statusCode, 409);
    await pool.query("UPDATE online_pickup_quotes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [review.id]);
    assert.equal((await submit(review.id)).statusCode, 409);
    const replaced = (await quote()).json();
    const latest = (await quote()).json();
    assert.notEqual(replaced.id, latest.id);
    assert.equal((await submit(replaced.id)).statusCode, 409);
    menu = [dish(1, 6500), dish(2, 10000, false), dish(3, 22000)];
    await acceptMenu(pool, 'cafe', 2, menu, lease);
    assert.equal((await submit(latest.id)).statusCode, 409);
    const fresh = (await quote()).json();
    assert.equal(fresh.subtotalPaise, 35000);
    await pool.query("UPDATE online_pickup_channels SET heartbeat_at=clock_timestamp()-interval '46 seconds' WHERE outlet='cafe'");
    assert.equal((await quote()).statusCode, 503);
    assert.equal((await submit(fresh.id)).statusCode, 503);
    await syncPickupChannel(pool, 'cafe', 2, true, lease);
    const requestId = randomUUID();
    assert.equal((await call('POST', 'cafe/requests', { requestId, quoteId: fresh.id, status: 'paid' })).statusCode, 400);
    const confirmations = await Promise.all([submit(fresh.id, requestId), submit(fresh.id, requestId), submit(fresh.id, requestId)]);
    assert.ok(confirmations.every(response => response.statusCode === 200));
    const order = confirmations[0].json();
    assert.deepEqual(confirmations[1].json(), order);
    assert.deepEqual(confirmations[2].json(), order);
    assert.equal(order.status, 'pending_acceptance');
    assert.equal(order.quote.subtotalPaise, 35000);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_requests')).rows[0].n, 1);
    assert.equal((await submit(randomUUID(), requestId)).statusCode, 409);
    assert.equal((await submit(fresh.id)).statusCode, 409);
    assert.equal((await quote()).statusCode, 409);
    assert.equal((await call('GET', `cafe/requests/${order.id}`, undefined, '')).statusCode, 401);
    assert.equal((await call('GET', `cafe/requests/${order.id}`, undefined, secondSession)).statusCode, 404);
    assert.equal((await call('GET', `other/requests/${order.id}`)).statusCode, 404);
    assert.equal((await call('GET', `cafe/requests/${order.id}`, undefined, session, { host: 'evil.example.test' })).statusCode, 403);
    assert.deepEqual((await call('GET', `cafe/requests/${order.id}`)).json(), order);
    await app.close();
    app = await buildHostedApp(pool, undefined, accountOptions);
    assert.deepEqual((await call('GET', `cafe/requests/${order.id}`)).json(), order, 'A new API instance reads the durable request.');
    await pool.query("UPDATE online_pickup_channels SET enabled=false WHERE outlet='cafe'");
    assert.deepEqual((await submit(fresh.id, requestId)).json(), order, 'A retry returns the committed outcome even after the outlet pauses.');
    await syncPickupChannel(pool, 'cafe', 3, true, lease);
    await pool.query("UPDATE online_pickup_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [order.id]);
    assert.equal((await call('GET', `cafe/requests/${order.id}`)).json().status, 'expired');
    const nextReview = (await quote()).json();
    assert.equal((await pool.query('SELECT status FROM online_pickup_requests WHERE id=$1', [order.id])).rows[0].status, 'expired');

    // A failure after insertion must retain the review and leave no partial order request.
    await pool.query(`CREATE FUNCTION fail_review_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected review deletion failure'; END $$;
      CREATE TRIGGER fail_review_delete BEFORE DELETE ON online_pickup_quotes FOR EACH ROW EXECUTE FUNCTION fail_review_delete();`);
    const retryId = randomUUID();
    const failed = await submit(nextReview.id, retryId);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.includes('injected'), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_requests WHERE request_id=$1', [retryId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_quotes WHERE id=$1', [nextReview.id])).rows[0].n, 1);
    await pool.query('DROP TRIGGER fail_review_delete ON online_pickup_quotes; DROP FUNCTION fail_review_delete();');
    const recovered = await submit(nextReview.id, retryId);
    assert.equal(recovered.statusCode, 200);
    const secondReview = (await quote(cart, secondSession)).json();
    assert.ok(secondReview.id);
    const newInstallation = randomUUID();
    await coordinateHostedRecovery(pool, 'cafe', `Bearer ${token}`, { requestId: randomUUID(), sourceHash: 'a'.repeat(64),
      installation, newInstallation, menuVersion: 9, offerVersion: 1, retireOffers: [] });
    assert.equal((await call('GET', `cafe/requests/${recovered.json().id}`)).json().status, 'expired');
    assert.equal((await quote(cart, secondSession)).statusCode, 503);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_quotes')).rows[0].n, 0);
    await assert.rejects(() => syncPickupChannel(pool, 'cafe', 4, true, lease), { statusCode: 409 });
    await syncPickupChannel(pool, 'cafe', 4, true, publicationLease(`Bearer ${token}`, newInstallation));
    assert.equal((await quote(cart, secondSession)).statusCode, 200);
    await pool.query(`INSERT INTO guest_phone_limits(key,count,expires_at) VALUES($1,30,clock_timestamp()+interval '15 minutes')
      ON CONFLICT(key) DO UPDATE SET count=30,expires_at=excluded.expires_at`, [`pickup-quote:${account}`]);
    assert.equal((await quote()).statusCode, 429);
    await pool.query("UPDATE guest_sessions SET expires_at=clock_timestamp()-interval '1 second'");
    assert.equal((await quote()).statusCode, 401);
    assert.equal((await submit(nextReview.id, retryId)).statusCode, 401);
  } finally {
    await app?.close();
    await pool.end();
    try { await setup.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); }
    finally { await setup.end(); }
  }
});

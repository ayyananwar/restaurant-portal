import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import axe from 'axe-core';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { buildHostedApp } from '../dist/hosted/app.js';
import { hostedPool, prepareHostedStore, provisionOutlet, publicMenu as storedMenu, publicationLease, acceptMenu, stagePhoto, stageFeedbackCodes } from '../dist/hosted/database.js';
import { syncOutletOffers } from '../dist/hosted/offers.js';
import { twilioVerifier } from '../dist/hosted/phone-verify.js';
import { setMenuAvailability } from '../dist/server/menu-catalog.js';
import { createCoupon, setCouponEnabled } from '../dist/server/coupons.js';
import { buildApp } from '../dist/server/app.js';
import { updateMenuPhoto } from '../dist/server/menu-photo.js';
import { publicationStatus, publicationTarget, publishMenu } from '../dist/server/menu-publication.js';
import { loadPrivateFeedback, publishFeedbackCodes } from '../dist/server/receipt-feedback.js';
import { quoteCoupon, recordReceipt } from '../dist/server/receipt-handoff.js';
import { syncOffers } from '../dist/server/offer-sync.js';
import { openStore, readTables, submitOrder } from '../dist/server/store.js';
import { checkStaging } from './staging-check.js';

test('remote database connections require verified TLS and cannot override their target', async () => {
  for (const suffix of ['?sslmode=disable', '?sslmode=require', '?sslmode=no-verify', '?host=example.test', '?ssl=false']) {
    assert.throws(() => hostedPool(`postgresql://sample@db.example.test/menus${suffix}`));
  }
  const remote = hostedPool('postgresql://sample@db.example.test/menus');
  assert.deepEqual(remote.options.ssl, { rejectUnauthorized: true });
  await remote.end();
});

test('hosted publishing binds one installation and rejects stale writes under the outlet lock', { timeout: 20_000 }, async () => {
  assert.ok(process.env.HOSTED_TEST_DATABASE_URL, 'Provide the disposable PostgreSQL test URL.');
  const namespace = `hosted_fence_${randomBytes(8).toString('hex')}`;
  const setup = hostedPool(process.env.HOSTED_TEST_DATABASE_URL);
  const pool = hostedPool(process.env.HOSTED_TEST_DATABASE_URL, `-c search_path=${namespace}`);
  const token = randomBytes(32).toString('hex');
  const installation = randomUUID();
  const replacement = randomUUID();
  const lease = publicationLease(`Bearer ${token}`, installation);
  let app;
  let blocker;
  try {
    await setup.query(`CREATE SCHEMA ${namespace}`);
    await prepareHostedStore(pool);
    await provisionOutlet(pool, 'legacy', 'Legacy outlet', 'classic', token);
    // Reproduce the previously deployed hosted schema, then verify a repeatable, preserving upgrade.
    await pool.query('ALTER TABLE hosted_outlets DROP COLUMN publication_installation');
    await prepareHostedStore(pool);
    await prepareHostedStore(pool);
    app = await buildHostedApp(pool, undefined, { origin: 'https://example.test', phoneKey: randomBytes(32), verifier: {} });
    const path = '/api/publish/legacy';
    const inject = (method, suffix, payload, identity = installation, credential = token) => app.inject({
      method, url: path + suffix, payload,
      headers: { authorization: `Bearer ${credential}`, ...(identity === null ? {} : { 'x-outlet-installation': identity }) }
    });
    const offers = { installation, version: 1, offers: [], ready: [], redeemed: [] };
    assert.equal((await inject('POST', '/offer-sync', offers, null)).statusCode, 200);
    assert.equal((await inject('PUT', '/menu', { version: 1, items: [] }, replacement)).statusCode, 409);
    assert.equal((await pool.query('SELECT publication_installation FROM hosted_outlets')).rows[0].publication_installation, null);
    assert.equal((await inject('PUT', '/menu', { version: 1, items: [] })).statusCode, 204);
    assert.equal((await pool.query('SELECT publication_installation FROM hosted_outlets')).rows[0].publication_installation, installation);
    for (const identity of [null, replacement, 'invalid']) {
      for (const [method, suffix, payload] of [
        ['PUT', '/menu', { version: 2, items: [] }],
        ['POST', '/offer-sync', offers],
        ['PUT', '/feedback-codes', { codes: [{ digest: 'a'.repeat(64), expiresAt: Date.now() + 1000 }] }],
        ['GET', '/feedback'], ['HEAD', `/photos/${'a'.repeat(64)}`], ['PUT', `/photos/${'a'.repeat(64)}`, 'bad image']
      ]) assert.equal((await inject(method, suffix, payload, identity)).statusCode, 401, `${method} ${suffix}`);
    }
    assert.equal((await inject('POST', '/offer-sync', { ...offers, installation: replacement })).statusCode, 409);
    assert.equal((await inject('GET', '/feedback', undefined, installation, 'f'.repeat(64))).statusCode, 401);
    assert.equal((await inject('GET', '/feedback')).statusCode, 200);

    // The request passes HTTP authentication, then waits behind a simulated recovery transaction.
    blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT slug FROM hosted_outlets WHERE slug = 'legacy' FOR UPDATE");
    const waiting = inject('PUT', '/menu', { version: 99, items: [] });
    const response = Promise.resolve(waiting);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await setup.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
        AND query = 'SELECT token_hash, publication_installation FROM hosted_outlets WHERE slug = $1 FOR UPDATE'`);
      if (state.rowCount) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true, 'The publishing request reached the locked write after authentication.');
    await blocker.query("UPDATE hosted_outlets SET publication_installation = $1 WHERE slug = 'legacy'", [replacement]);
    await blocker.query('COMMIT');
    blocker.release();
    blocker = undefined;
    assert.equal((await response).statusCode, 409);
    assert.equal((await pool.query('SELECT version FROM hosted_outlets')).rows[0].version, '1');
    assert.equal((await inject('PUT', '/menu', { version: 2, items: [] }, replacement)).statusCode, 204);
    // Exercise every write primitive too: no route may accidentally omit the locked check.
    const code = { digest: 'b'.repeat(64), expiresAt: Date.now() + 1000 };
    for (const write of [
      () => acceptMenu(pool, 'legacy', 100, [], lease),
      () => stagePhoto(pool, 'legacy', 'c'.repeat(64), Buffer.from('fixture'), lease),
      () => stageFeedbackCodes(pool, 'legacy', [code], lease),
      () => syncOutletOffers(pool, 'legacy', offers, lease),
      () => acceptMenu(pool, 'legacy', 100, [])
    ]) await assert.rejects(write, { statusCode: 409 });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM hosted_photos')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM receipt_feedback')).rows[0].count, 0);
    const newLease = publicationLease(`Bearer ${token}`, replacement);
    await pool.query('UPDATE hosted_outlets SET token_hash = $1', [createHash('sha256').update(randomBytes(32)).digest()]);
    await assert.rejects(() => stageFeedbackCodes(pool, 'legacy', [code], newLease), { statusCode: 409 });
  } finally {
    if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
    await app?.close();
    await pool.end();
    try { await setup.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); }
    finally { await setup.end(); }
  }
});

test('PostgreSQL hosted menu, HTTPS publication and guest browser flow', { timeout: 65_000 }, async () => {
  const { HOSTED_TEST_DATABASE_URL, HOSTED_TEST_TLS_KEY, NODE_EXTRA_CA_CERTS, RESTAURANT_TEST_SCREENSHOTS } = process.env;
  assert.ok(HOSTED_TEST_DATABASE_URL && HOSTED_TEST_TLS_KEY && NODE_EXTRA_CA_CERTS,
    'Provide a test PostgreSQL URL, local TLS key, and matching certificate via NODE_EXTRA_CA_CERTS.');
  const namespace = `hosted_check_${randomBytes(8).toString('hex')}`;
  const setup = hostedPool(HOSTED_TEST_DATABASE_URL);
  const pool = hostedPool(HOSTED_TEST_DATABASE_URL, `-c search_path=${namespace}`);
  const db = openStore(':memory:');
  const installation = db.prepare('SELECT installation FROM offer_publication WHERE id = 1').get().installation;
  const token = randomBytes(32).toString('hex');
  const otherToken = randomBytes(32).toString('hex');
  const signal = new AbortController().signal;
  let app;
  let browser;

  try {
    const requestedTls = new URL(HOSTED_TEST_DATABASE_URL).searchParams.get('sslmode') === 'verify-full';
    if (requestedTls) {
      const { rows } = await setup.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      assert.equal(rows[0]?.ssl, true);
    }
    await setup.query(`CREATE SCHEMA ${namespace}`);
    await prepareHostedStore(pool);
    await provisionOutlet(pool, 'ranchi-cafe', 'Ranchi Café', 'photo-led', token);
    await provisionOutlet(pool, 'other', 'Other Café', 'classic', otherToken);
    await assert.rejects(provisionOutlet(pool, 'duplicate-secret', 'Duplicate', 'classic', token), { code: '23505' });
    const browseOnly = await buildHostedApp(pool);
    try {
      const disabled = await browseOnly.inject({ method: 'PUT', url: '/api/publish/ranchi-cafe/feedback-codes',
        headers: { authorization: `Bearer ${token}` }, payload: { codes: [{ digest: 'a'.repeat(64), expiresAt: Date.now() + 1000 }] } });
      assert.equal(disabled.statusCode, 503);
    } finally { await browseOnly.close(); }
    const tls = { key: readFileSync(HOSTED_TEST_TLS_KEY), cert: readFileSync(NODE_EXTRA_CA_CERTS) };
    const socket = createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const { port } = socket.address();
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    const origin = `https://127.0.0.1:${port}`;
    const verifications = new Map();
    const verifier = twilioVerifier('VA' + 'a'.repeat(32), 'SK' + 'b'.repeat(32), 'fixture-only', async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.ok(url.startsWith('https://verify.twilio.com/v2/Services/VA'));
      if (url.endsWith('/Verifications')) {
        const phone = init.body.get('To');
        assert.match(phone, /^\+91900000111[0-9]$/);
        assert.equal(init.body.get('Channel'), 'sms');
        const sid = 'VE' + randomBytes(16).toString('hex');
        verifications.set(sid, true);
        return Response.json({ sid, status: 'pending' });
      }
      assert.ok(url.endsWith('/VerificationCheck'));
      const sid = init.body.get('VerificationSid');
      if (!verifications.has(sid)) return new Response(null, { status: 404 });
      const approved = init.body.get('Code') === '519247';
      if (approved) verifications.delete(sid);
      return Response.json({ sid, status: approved ? 'approved' : 'pending' });
    });
    const accountOptions = { origin, phoneKey: randomBytes(32), verifier };
    app = await buildHostedApp(pool, tls, accountOptions);
    await app.listen({ host: '127.0.0.1', port });
    const target = publicationTarget({ RESTAURANT_PUBLISH_ORIGIN: origin,
      RESTAURANT_PUBLISH_OUTLET: 'ranchi-cafe', RESTAURANT_PUBLISH_TOKEN: token });

    async function put(path, body, credential = token, contentType = 'application/json') {
      return fetch(`${origin}/api/publish/${path}`, { method: 'PUT', body: contentType === 'application/json' ? JSON.stringify(body) : body,
        headers: { Authorization: `Bearer ${credential}`, 'X-Outlet-Installation': installation, 'Content-Type': contentType } });
    }
    const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#83694f' } }).png().toBuffer();
    db.exec(`INSERT INTO menu (name, category, price_paise, description) VALUES ('Ginger chai', 'Drinks', 4500, 'Brewed with ginger');
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 247)
      INSERT INTO menu (name, category, price_paise, description) SELECT 'Sample dish ' || i, 'Mains', 18000, '' FROM n;`);
    await updateMenuPhoto(db, 1, 0, png.toString('base64'));
    const key = db.prepare('SELECT photo_key FROM menu_photos WHERE menu_id = 1').get().photo_key;
    const asset = `/media/menu/ranchi-cafe/1/${key}`;
    const wrongAsset = `/media/menu/other/1/${key}`;
    const publicPath = '/api/public-menu/ranchi-cafe';
    const guest = async path => fetch(origin + path);
    const publicMenu = async () => (await guest(publicPath)).json();
    assert.equal((await guest(publicPath)).status, 404);
    const version = db.prepare('SELECT version FROM menu_publication WHERE id = 1').get().version;
    const dish = { id: 1, name: 'Ginger chai', category: 'Drinks', pricePaise: 4500,
      description: 'Brewed with ginger', available: true, availableAfter: null, photoKey: key };
    const snapshot = { version, items: [dish] };
    assert.equal((await put('other/menu', snapshot)).status, 401);
    assert.equal((await put('ranchi-cafe/menu', { ...snapshot, staff: [] })).status, 400);
    assert.equal((await put('ranchi-cafe/menu', { ...snapshot, items: [dish, dish] })).status, 400);
    assert.equal((await put('ranchi-cafe/menu', snapshot)).status, 422);
    const pngKey = createHash('sha256').update(png).digest('hex');
    assert.equal((await put(`ranchi-cafe/photos/${pngKey}`, png, token, 'image/webp')).status, 400);
    assert.equal((await put(`ranchi-cafe/photos/${key}`, png, token, 'image/webp')).status, 400);

    let lost = false;
    const lostAcknowledgment = async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/menu') && response.status === 204) {
        lost = true;
        throw new Error('Acknowledgment lost');
      }
      if (url.includes('/photos/') && init.method === 'PUT') assert.equal((await guest(asset)).status, 404);
      return response;
    };
    await assert.rejects(publishMenu(db, target, signal, lostAcknowledgment), /Acknowledgment lost/);
    assert.equal(lost, true);
    assert.equal(publicationStatus(db, target).pending, true);
    const first = await publicMenu();
    assert.deepEqual(Object.keys(first).sort(), ['items', 'name', 'publishedAt', 'theme']);
    assert.equal(first.items.length, 248);
    assert.deepEqual(first.items[0], dish);
    await publishMenu(db, target, signal);
    assert.equal(publicationStatus(db, target).pending, false);
    assert.equal((await publicMenu()).publishedAt, first.publishedAt);
    assert.deepEqual(await checkStaging(origin, 'ranchi-cafe'), { dishes: 248, checkedPhoto: true });
    assert.equal((await put('ranchi-cafe/menu', snapshot)).status, 409);
    assert.equal((await put('other/menu', snapshot, otherToken)).status, 422);
    assert.equal((await guest(wrongAsset)).status, 404);
    assert.equal((await guest(asset.replace('/1/', '/2/'))).status, 404);
    assert.equal((await guest(asset)).headers.get('content-type'), 'image/webp');
    assert.equal((await guest('/api/service')).status, 404);
    const manifest = JSON.parse(readFileSync(new URL('../dist/client/.vite/manifest.json', import.meta.url)));
    assert.equal((await guest(`/${manifest['index.html'].file}`)).status, 404);

    setMenuAvailability(db, 1, { available: false, availableAfter: null, revision: 1 });
    await app.close();
    await assert.rejects(publishMenu(db, target, signal), /fetch failed/);
    assert.equal((await storedMenu(pool, 'ranchi-cafe')).items[0].available, true);
    assert.equal(publicationStatus(db, target).pending, true);
    app = await buildHostedApp(pool, tls, accountOptions);
    assert.equal(await app.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) }), origin);
    await publishMenu(db, target, signal);
    assert.equal((await publicMenu()).items[0].available, false);
    assert.equal((await put('ranchi-cafe/menu', { version, items: first.items })).status, 409);

    const concurrent = await Promise.all([
      put('other/menu', { version: 2, items: [] }, otherToken),
      put('other/menu', { version: 2, items: [{ ...dish, photoKey: null }] }, otherToken)
    ]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [204, 409]);

    browser = await chromium.launch({ channel: process.env.RESTAURANT_TEST_BROWSER ?? 'msedge' });
    const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 844 } });
    const unexpected = [];
    page.on('pageerror', error => unexpected.push(error.message));
    await page.goto(`${origin}/r/ranchi-cafe#table-1`);
    await page.getByRole('heading', { name: 'Ranchi Café', exact: true }).waitFor();
    const heroImage = await page.locator('.guest-hero').evaluate(hero => getComputedStyle(hero).backgroundImage.match(/url\("([^"]+)"\)/)?.[1]);
    assert.ok(heroImage);
    const hero = await page.request.get(heroImage);
    assert.equal(hero.status(), 200);
    assert.equal(hero.headers()['content-type'], 'image/webp');
    await page.getByText('Sold out', { exact: true }).waitFor();
    assert.ok(await page.locator('time').getAttribute('datetime'));
    assert.equal(await page.getByText('Local preview').count(), 0);
    assert.ok(await page.locator('.guest-photo-led').count());
    assert.equal(await page.getByRole('img', { name: 'Ginger chai' }).evaluate(img => img.decode().then(() => img.naturalWidth > 0)), true);
    const guestAccount = (action, data, headers = {}) => fetch(`${origin}/api/guest-account/${action}`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data)
    });
    assert.equal((await guestAccount('start', { phone: '9000001111' }, { Origin: 'https://other.example.test' })).status, 403);
    assert.equal((await guestAccount('start', { phone: '1234567890' })).status, 400);
    await page.getByRole('button', { name: 'Sign in with phone' }).click();
    await page.getByLabel('Indian mobile number (+91)').fill('9000001111');
    const [start] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/guest-account/start')),
      page.getByRole('button', { name: 'Send code' }).click()]);
    const { challenge } = await start.json();
    assert.match(challenge, /^[a-f0-9]{64}$/);
    await page.getByLabel('Verification code').waitFor();
    await page.evaluate(axe.source);
    const signInIssues = await page.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(issue => issue.id));
    assert.deepEqual(signInIssues, []);
    if (RESTAURANT_TEST_SCREENSHOTS) await page.screenshot({ path: join(RESTAURANT_TEST_SCREENSHOTS, 'guest-phone-sign-in.png') });
    assert.equal((await guestAccount('start', { phone: '9000001111' })).status, 429);
    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await page.getByText(/That code is incorrect or expired/).waitFor();
    await page.getByLabel('Verification code').fill('519247');
    const [verified] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/guest-account/verify')),
      page.getByRole('button', { name: 'Verify and sign in' }).click()]);
    assert.deepEqual(await verified.json(), { account: { phoneLast4: '1111' } });
    const cookie = (await verified.headerValue('set-cookie')).split(';')[0];
    assert.match(await verified.headerValue('set-cookie'), /__Host-guest_session=.*Path=\/; Secure; HttpOnly; SameSite=Lax/);
    assert.equal((await guestAccount('verify', { challenge, code: '519247' })).status, 422);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM guest_accounts')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT phone_key FROM guest_accounts')).rows[0].phone_key.length, 64);
    await page.reload();
    await page.getByText('Signed in · phone ending 1111', { exact: true }).waitFor();
    db.exec(`INSERT INTO dining_tables (label) VALUES ('Table 7'), ('Table 9');
      INSERT INTO staff (username, name, role, password_hash) VALUES ('waiter', 'Waiter', 'waiter', 'fixture'),
      ('counter', 'Counter', 'billing', 'fixture'), ('owner', 'Owner', 'admin', 'fixture');`);
    const orderId = submitOrder(db, 1, 1, { requestId: 'feedback-test', lines: [{ menuId: 2, quantity: 1 }] });
    const secondOrder = submitOrder(db, 2, 1, { requestId: 'claim-duplicate', lines: [{ menuId: 2, quantity: 1 }] });
    const billing = { id: 2, name: 'Counter', role: 'billing' };
    const [table, second] = readTables(db, billing);
    const check = { orderId, checkNumber: 1, splitId: null, checkVersion: table.checkVersion };
    createCoupon(db, { code: 'TEATIME', publicTitle: 'Tea time offer', discountPaise: 2500, minimumPaise: 10000, expiresAt: null });
    createCoupon(db, { code: 'PRIVATECODE', discountPaise: 500, minimumPaise: 0, expiresAt: null });
    let offersWire;
    await syncOffers(db, target, signal, (url, init) => { offersWire = JSON.parse(init.body); return fetch(url, init); });
    assert.deepEqual(offersWire.offers.map(offer => offer.id), ['TEATIME']);
    const anotherInstallation = await fetch(`${target.endpoint}/offer-sync`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Outlet-Installation': installation, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...offersWire, installation: '00000000-0000-0000-0000-000000000000' })
    });
    assert.equal(anotherInstallation.status, 409);
    const offersPath = '/api/guest-offers/ranchi-cafe';
    const readOffers = async (session = cookie) => (await fetch(`${origin}${offersPath}`, { headers: { Cookie: session } })).json();
    assert.equal((await readOffers('')).offers[0].title, 'Tea time offer');
    const claim = (session = cookie) => fetch(`${origin}${offersPath}/claim`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session }, body: JSON.stringify({ offerId: 'TEATIME' }) });
    assert.equal((await claim('')).status, 401);
    await page.reload();
    await page.getByRole('button', { name: 'Claim offer' }).click();
    await page.getByText('Waiting for the restaurant to sync').waitFor();
    assert.equal((await claim()).status, 204);
    assert.deepEqual((await readOffers()).claims, [{ offerId: 'TEATIME', title: 'Tea time offer', status: 'waiting' }]);
    assert.throws(() => quoteCoupon(db, 1, { ...check, code: 'TEATIME' }, target.endpoint), { statusCode: 422 });
    await assert.rejects(syncOffers(db, target, signal, async (url, init) => {
      const lost = await fetch(url, init);
      await lost.body?.cancel();
      throw new Error('Claim response lost');
    }), /Claim response lost/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM coupon_claims').get().count, 0);
    await syncOffers(db, target, signal);
    assert.equal((await readOffers()).claims[0].code, undefined);
    await syncOffers(db, target, signal);
    const guestClaim = (await readOffers()).claims[0];
    assert.equal(guestClaim.status, 'ready');
    assert.match(guestClaim.code, /^CL-[A-F0-9]{16}$/);
    assert.deepEqual((await readOffers('')).claims, []);
    const strangerStart = await (await guestAccount('start', { phone: '9000001114' })).json();
    const strangerVerified = await guestAccount('verify', { challenge: strangerStart.challenge, code: '519247' });
    const strangerCookie = strangerVerified.headers.get('set-cookie').split(';')[0];
    assert.deepEqual((await readOffers(strangerCookie)).claims, []);
    await page.getByRole('button', { name: 'Refresh offers' }).click();
    await page.getByText(guestClaim.code, { exact: true }).waitFor();
    await page.evaluate(axe.source);
    const offerIssues = await page.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(issue => issue.id));
    assert.deepEqual(offerIssues, []);
    if (RESTAURANT_TEST_SCREENSHOTS) await page.screenshot({ path: join(RESTAURANT_TEST_SCREENSHOTS, 'guest-offer-claim.png') });
    setCouponEnabled(db, 'TEATIME', false);
    assert.throws(() => quoteCoupon(db, 1, { ...check, code: guestClaim.code }, target.endpoint), { statusCode: 422 });
    setCouponEnabled(db, 'TEATIME', true);
    await assert.rejects(syncOffers(db, target, signal, async () => { throw new Error('Offline'); }), /Offline/);
    const quote = quoteCoupon(db, 1, { ...check, code: guestClaim.code }, target.endpoint);
    assert.deepEqual(quote, { code: guestClaim.code, discountPaise: 2500 });
    const receipt = { ...check, reference: 'TEST-PRIVATE-POS-01', officialTotalPaise: 15500, paymentMethod: 'Cash', coupon: quote };
    recordReceipt(db, 1, 2, receipt, target.endpoint);
    recordReceipt(db, 1, 2, receipt, target.endpoint);
    assert.throws(() => recordReceipt(db, 2, 2, { ...receipt, orderId: secondOrder, checkVersion: second.checkVersion,
      reference: 'TEST-PRIVATE-POS-02' }, target.endpoint), { statusCode: 422 });
    assert.equal((await readOffers()).claims[0].status, 'ready');
    await syncOffers(db, target, signal);
    assert.equal((await readOffers()).claims[0].status, 'redeemed');
    await page.getByRole('button', { name: 'Refresh offers' }).click();
    await page.getByText('Redeemed', { exact: true }).waitFor();
    setCouponEnabled(db, 'TEATIME', false);
    await syncOffers(db, target, signal);
    assert.deepEqual((await readOffers('')).offers, []);
    assert.equal((await claim()).status, 422);
    assert.equal((await readOffers()).claims[0].status, 'redeemed');
    const staleOffer = await fetch(`${target.endpoint}/offer-sync`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Outlet-Installation': installation, 'Content-Type': 'application/json' }, body: JSON.stringify(offersWire)
    });
    assert.equal(staleOffer.status, 409);
    const slip = readTables(db, billing, target)[0].receipts[0].feedback;
    assert.equal(slip.published, false);
    await assert.rejects(publishFeedbackCodes(db, target, signal, async () => { throw new Error('Offline'); }), /Offline/);
    const sendFeedback = (slug, body, session = cookie) => fetch(`${origin}/api/guest-feedback/${slug}`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session }, body: JSON.stringify(body)
    });
    const response = { code: slip.code, rating: 4, comment: 'Quick service <thank you>' };
    assert.equal((await sendFeedback('ranchi-cafe', response, '')).status, 401);
    assert.equal((await sendFeedback('ranchi-cafe', response)).status, 422);
    let wire;
    await publishFeedbackCodes(db, target, signal, (url, init) => { wire = JSON.parse(init.body); return fetch(url, init); });
    assert.deepEqual(Object.keys(wire.codes[0]).sort(), ['digest', 'expiresAt']);
    assert.equal(wire.codes[0].digest, createHash('sha256').update(slip.code.replaceAll('-', '')).digest('hex'));
    assert.equal(readTables(db, billing, target)[0].receipts[0].feedback.published, true);
    assert.equal((await sendFeedback('other', response)).status, 422);
    await page.getByRole('button', { name: 'Leave private feedback' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'guest-feedback-code');
    await page.getByRole('button', { name: 'Cancel feedback' }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Leave private feedback');
    await page.getByRole('button', { name: 'Leave private feedback' }).click();
    await page.evaluate(axe.source);
    const feedbackIssues = await page.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(issue => issue.id));
    assert.deepEqual(feedbackIssues, []);
    if (RESTAURANT_TEST_SCREENSHOTS) await page.screenshot({ path: join(RESTAURANT_TEST_SCREENSHOTS, 'guest-private-feedback.png') });
    await page.getByLabel('Feedback code').fill(slip.code.toLowerCase());
    await page.getByLabel('Rating', { exact: true }).selectOption('4');
    await page.getByLabel('Comment (optional)').fill(response.comment);
    await page.getByRole('button', { name: 'Send feedback' }).click();
    await page.getByText('Thank you. Your feedback was sent privately.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Thank you. Your feedback was sent privately.');
    assert.equal((await sendFeedback('ranchi-cafe', response)).status, 422);
    assert.equal((await put('ranchi-cafe/feedback-codes', wire)).status, 204);
    assert.equal((await sendFeedback('ranchi-cafe', response)).status, 422);
    assert.equal((await guest('/api/publish/ranchi-cafe/feedback')).status, 401);
    assert.equal((await fetch(`${origin}/api/publish/ranchi-cafe/feedback`, { headers: { Authorization: `Bearer ${otherToken}` } })).status, 401);
    const ownerInbox = await loadPrivateFeedback(db, target);
    assert.deepEqual(Object.keys(ownerInbox.feedback[0]).sort(), ['comment', 'id', 'rating', 'receivedAt']);
    assert.equal(ownerInbox.feedback[0].comment, response.comment);
    assert.deepEqual(await loadPrivateFeedback(db, { ...target, endpoint: `${origin}/api/publish/other`, token: otherToken }), { feedback: [] });
    const staffOrigin = 'http://127.0.0.1:3100';
    const staffApp = buildApp(db, { origin: staffOrigin, publication: target });
    try {
      const staffToken = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, 3, ?)')
        .run(createHash('sha256').update(staffToken).digest('hex'), Date.now() + 60_000);
      const inbox = await staffApp.inject({ url: '/api/feedback', headers: { host: '127.0.0.1:3100', cookie: `staff_session=${staffToken}` } });
      assert.equal(inbox.statusCode, 200);
      assert.deepEqual(inbox.json(), { configured: true, ...ownerInbox });
    } finally {
      await staffApp.close();
    }
    const expiredCode = '0011223344556677';
    const raceCode = '1122334455667788';
    assert.equal((await put('ranchi-cafe/feedback-codes', { codes: [
      { digest: createHash('sha256').update(expiredCode).digest('hex'), expiresAt: Date.now() - 1000 },
      { digest: createHash('sha256').update(raceCode).digest('hex'), expiresAt: Date.now() + 60_000 }
    ] })).status, 204);
    assert.equal((await sendFeedback('ranchi-cafe', { ...response, code: expiredCode })).status, 422);
    const simultaneous = await Promise.all([1, 2].map(rating => sendFeedback('ranchi-cafe', { code: raceCode, rating, comment: '' })));
    assert.deepEqual(simultaneous.map(reply => reply.status).sort(), [204, 422]);
    assert.equal((await sendFeedback('ranchi-cafe', { ...response, code: 'guessed' })).status, 422);
    assert.equal((await sendFeedback('ranchi-cafe', { ...response, code: 'guessed' })).status, 422);
    assert.equal((await sendFeedback('ranchi-cafe', { ...response, code: 'guessed' })).status, 429);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in with phone' }).waitFor();
    const revoked = await fetch(`${origin}/api/guest-account`, { headers: { Cookie: cookie } });
    assert.deepEqual(await revoked.json(), { available: true, account: null });
    const expired = await (await guestAccount('start', { phone: '9000001112' })).json();
    await pool.query("UPDATE guest_phone_challenges SET expires_at = now() - interval '1 second'");
    assert.equal((await guestAccount('verify', { challenge: expired.challenge, code: '519247' })).status, 422);
    const limited = await (await guestAccount('start', { phone: '9000001113' })).json();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await guestAccount('verify', { challenge: limited.challenge, code: '000000' })).status, 422);
    }
    assert.equal((await guestAccount('verify', { challenge: limited.challenge, code: '519247' })).status, 422);
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.evaluate(axe.source);
      const failures = await page.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(issue => issue.id));
      assert.deepEqual(failures, []);
      if (RESTAURANT_TEST_SCREENSHOTS) await page.screenshot({ path: join(RESTAURANT_TEST_SCREENSHOTS, `hosted-menu-${width}.png`) });
    }
    await page.goto(`${origin}/r/other?theme=photo-led`);
    await page.getByRole('heading', { name: 'Other Café', exact: true }).waitFor();
    assert.ok(await page.locator('.guest-classic').count());
    await page.goto(`${origin}/r/unpublished`);
    await page.getByText('This menu is unavailable. Ask the restaurant for its current menu.').waitFor();
    assert.deepEqual(unexpected, []);

    await updateMenuPhoto(db, 1, 2, null);
    await publishMenu(db, target, signal);
    assert.equal((await guest(asset)).status, 404);
  } finally {
    await browser?.close();
    await app?.close();
    db.close();
    await pool.end();
    try { await setup.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); }
    finally { await setup.end(); }
  }
});

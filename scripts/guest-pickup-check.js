import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import axe from 'axe-core';
import { buildHostedApp } from '../dist/hosted/app.js';
import { acceptMenu, hostedPool, prepareHostedStore, provisionOutlet, publicationLease } from '../dist/hosted/database.js';
import { syncPickupChannel } from '../dist/hosted/online-ordering.js';
import { syncPickupPricing, reviewPickup, decidePickup } from '../dist/hosted/pickup-acceptance.js';
import { defaultBillingProfile } from '../dist/shared/billing.js';

test('guest pickup cart recovers lost replies, isolates accounts and shows restaurant acceptance without payment', { timeout: 120_000 }, async () => {
  assert.ok(process.env.HOSTED_TEST_DATABASE_URL);
  const namespace = `guest_pickup_${randomBytes(8).toString('hex')}`;
  const setup = hostedPool(process.env.HOSTED_TEST_DATABASE_URL);
  const pool = hostedPool(process.env.HOSTED_TEST_DATABASE_URL, `-c search_path=${namespace}`);
  const origin = 'https://cart.example.test';
  const token = randomBytes(32).toString('hex');
  const lease = publicationLease(`Bearer ${token}`, randomUUID());
  const accountOptions = { origin, phoneKey: randomBytes(32), verifier: {} };
  const profile = { ...defaultBillingProfile, revision: 1, enabled: true, testMode: true, legalName: 'Fixture Café', address: 'Fixture address' };
  const dish = (id, name, pricePaise, available = true) => ({ id, name, pricePaise, available, availableAfter: null, photoKey: null, category: 'Drinks', description: 'Freshly made' });
  const menu = [dish(1, 'Masala Chai', 6000), dish(2, 'Lime Soda', 11000), dish(3, 'Sold-out drink', 10000, false)];
  const actor = { id: 1, name: 'Fixture counter', role: 'billing' };
  let app, browser;
  let loseReply = false;
  let unavailable = false;
  let loseConfirmation = false;
  let blockStatus = false;
  const submissions = [];
  const confirmations = [];
  const accounts = [];
  try {
    await setup.query(`CREATE SCHEMA ${namespace}`); await prepareHostedStore(pool);
    await provisionOutlet(pool, 'cafe', 'Fixture Café', 'classic', token);
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=true WHERE slug='cafe'");
    await acceptMenu(pool, 'cafe', 1, menu, lease);
    await syncPickupChannel(pool, 'cafe', 1, true, lease);
    await syncPickupPricing(pool, 'cafe', profile, lease);
    for (let index = 0; index < 2; index++) {
      const id = randomUUID(), cookie = randomBytes(32).toString('hex'); accounts.push({ id, cookie });
      await pool.query("INSERT INTO guest_accounts(id,phone_key,phone_last_four) VALUES($1,$2,'1111')", [id, randomBytes(32).toString('hex')]);
      await pool.query("INSERT INTO guest_sessions(token_hash,account_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [createHash('sha256').update(cookie).digest('hex'), id]);
    }
    const get = (url, cookie = accounts[0].cookie, host = 'cart.example.test') => app.inject({ method: 'GET', url, headers: { host, cookie: `__Host-guest_session=${cookie}` } });
    app = await buildHostedApp(pool, undefined, accountOptions);
    assert.deepEqual((await get('/api/online-pickup/cafe/availability')).json(), { preview: false, available: false, payments: false });
    await app.close(); app = await buildHostedApp(pool, undefined, accountOptions, { pickupPreview: true });
    assert.equal((await get('/api/online-pickup/cafe/availability')).json().available, true);
    assert.equal((await get('/api/online-pickup/cafe/availability', '', 'wrong.example.test')).statusCode, 403);
    assert.equal((await get('/api/online-pickup/cafe/active', '')).statusCode, 401);
    assert.equal((await get('/api/online-pickup/other/active')).json().order, null);
    await pool.query("UPDATE online_pickup_channels SET pricing=jsonb_set(pricing,'{testMode}','false') WHERE outlet='cafe'");
    assert.equal((await get('/api/online-pickup/cafe/availability')).json().available, false);
    await pool.query("UPDATE online_pickup_channels SET pricing=jsonb_set(pricing,'{testMode}','true') WHERE outlet='cafe'");
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=false WHERE slug='cafe'");
    assert.equal((await get('/api/online-pickup/cafe/availability')).json().available, false);
    await pool.query("UPDATE hosted_outlets SET online_pickup_entitled=true WHERE slug='cafe'");
    await pool.query("UPDATE online_pickup_channels SET heartbeat_at=clock_timestamp()-interval '46 seconds' WHERE outlet='cafe'");
    assert.equal((await get('/api/online-pickup/cafe/availability')).json().available, false);
    await syncPickupChannel(pool, 'cafe', 1, true, lease);
    browser = await chromium.launch({ channel: process.env.RESTAURANT_TEST_BROWSER ?? 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: '__Host-guest_session', value: accounts[0].cookie, url: origin, secure: true, httpOnly: true }]);
    await context.route(`${origin}/**`, async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (unavailable && path.includes('/api/online-pickup/')) return route.abort('connectionfailed');
      if (blockStatus && request.method() === 'GET' && /\/requests\/[a-f0-9-]+$/.test(path)) return route.abort('connectionfailed');
      const result = await app.inject({ method: request.method(), url: path + new URL(request.url()).search,
        headers: { ...await request.allHeaders(), host: 'cart.example.test' }, payload: request.postData() ?? undefined });
      if (path.endsWith('/requests') && request.method() === 'POST') {
        submissions.push(JSON.parse(request.postData()));
        if (loseReply && result.statusCode === 200) { loseReply = false; return route.abort('connectionfailed'); }
      }
      if (path.endsWith('/confirmation') && request.method() === 'PUT') {
        confirmations.push(JSON.parse(request.postData()));
        if (loseConfirmation && result.statusCode === 200) { loseConfirmation = false; return route.abort('connectionfailed'); }
      }
      await route.fulfill({ status: result.statusCode, headers: Object.fromEntries(Object.entries(result.headers).map(([key, value]) => [key, String(value)])), body: result.rawPayload });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/r/cafe`);
    const add = page.getByRole('button', { name: 'Add for pickup: Masala Chai', exact: true });
    await add.waitFor(); await page.waitForFunction(() => !document.querySelector('.guest-add')?.disabled);
    assert.equal(await page.getByRole('button', { name: 'Add for pickup: Sold-out drink' }).isDisabled(), true);
    await add.click(); await add.click();
    await page.setViewportSize({ width: 390, height: 400 });
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.getByRole('link', { name: 'Review pickup cart · 2 items' }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pickup-heading');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector('.guest-cart-shortcut'));
    await page.getByLabel('Name for collection').fill('Pickup customer');
    await page.getByLabel('Notes for Masala Chai').fill('<b>Less sugar</b>');
    await page.getByLabel('Order notes (optional)').fill('No plastic cutlery');
    await page.getByRole('button', { name: 'Review current prices' }).click();
    await page.getByRole('heading', { name: 'Current menu prices' }).waitFor();
    assert.match(await page.locator('.guest-pickup-review').innerText(), /120/);
    // Any edit invalidates the previous quote, even when quantities are unchanged later.
    await page.getByLabel('Notes for Masala Chai').fill('<b>No sugar</b>');
    assert.equal(await page.getByRole('button', { name: 'Send pickup request' }).count(), 0);
    // Server price changes are shown explicitly before the customer submits.
    await acceptMenu(pool, 'cafe', 2, [dish(1, 'Masala Chai', 6500), menu[1], menu[2]], lease);
    await page.getByRole('button', { name: 'Refresh menu', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.guest-dish-meta strong')?.textContent === '₹65.00');
    assert.equal(await page.getByLabel('Name for collection').inputValue(), 'Pickup customer');
    assert.equal(await page.getByLabel('Notes for Masala Chai').inputValue(), '<b>No sugar</b>');
    await page.getByRole('button', { name: 'Review current prices' }).click();
    await page.getByRole('button', { name: 'Send pickup request' }).waitFor();
    assert.match(await page.locator('.guest-pickup-review').innerText(), /130/);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole('button', { name: 'Send pickup request' }).scrollIntoViewIfNeeded();
      await page.waitForFunction(() => !document.querySelector('.guest-cart-shortcut'));
      await page.evaluate(axe.source);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(issue => issue.id)), []);
      if (process.env.RESTAURANT_TEST_SCREENSHOTS && [390, 1280].includes(width)) await page.screenshot({ fullPage: true, path: join(process.env.RESTAURANT_TEST_SCREENSHOTS, `guest-cart-${width}.png`) });
    }
    loseReply = true;
    await page.getByRole('button', { name: 'Send pickup request' }).click();
    await page.getByRole('button', { name: 'Check or retry request' }).waitFor();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_requests')).rows[0].n, 1);
    assert.equal(await add.isDisabled(), true);
    await page.getByRole('button', { name: 'Check or retry request' }).click();
    await page.getByRole('heading', { name: 'Waiting for restaurant acceptance' }).waitFor();
    assert.equal(submissions.length, 2); assert.deepEqual(submissions[0], submissions[1]);
    assert.equal(await page.locator('.guest-pickup b').count(), 0); // Notes are text, never markup.
    assert.equal((await page.evaluate(() => Object.values(sessionStorage).join(''))).includes('Pickup customer'), false);
    const row = (await pool.query('SELECT id FROM online_pickup_requests')).rows[0];
    assert.equal((await get('/api/online-pickup/cafe/active', accounts[1].cookie)).json().order, null);
    assert.equal((await get(`/api/online-pickup/cafe/requests/${row.id}`, accounts[1].cookie)).statusCode, 404);
    assert.equal((await get('/api/online-pickup/other/active')).json().order, null);
    // Refresh recovers from the server without relying on browser storage.
    await page.evaluate(() => sessionStorage.clear()); await page.reload();
    await page.getByRole('heading', { name: 'Waiting for restaurant acceptance' }).waitFor();
    await syncPickupChannel(pool, 'cafe', 1, true, lease);
    await syncPickupPricing(pool, 'cafe', { ...profile, revision: 2, taxMode: 'gst', stateCode: '27',
      gstin: '27AAPFU0939F1ZV', classification: '996331', rateBasisPoints: 500, pricesIncludeTax: false }, lease);
    const review = await reviewPickup(pool, 'cafe', row.id, 1, lease);
    await decidePickup(pool, 'cafe', row.id, { requestId: randomUUID(), expectedRevision: 1, actor, decision: 'accept', reason: '', readyAt: Date.now() + 1_200_000, reviewHash: review.hash }, lease);
    await page.getByRole('heading', { name: 'Restaurant accepted · payment unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /pay/i }).count(), 0);
    assert.match(await page.locator('.guest-pickup-status').innerText(), /130/);
    const finalTotal = page.getByRole('region', { name: 'Restaurant final total' });
    await finalTotal.getByText('CGST', { exact: true }).waitFor();
    await finalTotal.getByText('SGST', { exact: true }).waitFor();
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await finalTotal.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.evaluate(axe.source);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(issue => issue.id)), []);
      if (process.env.RESTAURANT_TEST_SCREENSHOTS && [390, 1280].includes(width)) await page.screenshot({ fullPage: true, path: join(process.env.RESTAURANT_TEST_SCREENSHOTS, `guest-final-total-${width}.png`) });
    }
    // A committed confirmation with a lost reply can be retried without renewing its time or price.
    await syncPickupChannel(pool, 'cafe', 1, true, lease);
    loseConfirmation = true; blockStatus = true;
    await page.getByRole('button', { name: 'Confirm total of ₹136.50', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /Confirmation could not be checked/ }).waitFor();
    await page.getByRole('button', { name: 'Confirm total of ₹136.50', exact: true }).click();
    await page.getByText(/You confirmed this total at/).waitFor();
    blockStatus = false;
    assert.equal(confirmations.length, 2); assert.deepEqual(confirmations[0], confirmations[1]);
    assert.equal((await pool.query('SELECT revision::int FROM online_pickup_requests WHERE id=$1', [row.id])).rows[0].revision, 3);
    await page.reload(); await page.getByText(/You confirmed this total at/).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Confirm total/ }).count(), 0);
    unavailable = true;
    await page.getByRole('alert').filter({ hasText: /Check your connection/ }).waitFor();
    await page.getByRole('heading', { name: 'Restaurant accepted · payment unavailable' }).waitFor();
    unavailable = false;
    await pool.query("UPDATE online_pickup_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [row.id]);
    await page.getByRole('heading', { name: 'Request expired' }).waitFor();
    await page.getByRole('button', { name: 'Start a new pickup order' }).click();
    await page.getByText('Choose dishes from the menu below.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText('Sign in with your phone above to request pickup.').waitFor();
    assert.equal(await page.getByText('Pickup customer', { exact: true }).count(), 0);
    await context.addCookies([{ name: '__Host-guest_session', value: accounts[1].cookie, url: origin, secure: true, httpOnly: true }]);
    await page.reload(); await page.getByText('Signed in · phone ending 1111', { exact: true }).waitFor();
    assert.equal(await page.locator('.guest-pickup-status').count(), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM online_pickup_requests')).rows[0].n, 1);
    await syncPickupChannel(pool, 'cafe', 2, false, lease);
    assert.equal((await get('/api/online-pickup/cafe/availability', accounts[1].cookie)).json().available, false);
  } finally {
    await browser?.close(); await app?.close(); await pool.end();
    try { await setup.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); } finally { await setup.end(); }
  }
});

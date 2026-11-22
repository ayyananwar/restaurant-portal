import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axe from 'axe-core';
import { unzipSync } from 'fflate';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { buildApp } from '../dist/server/app.js';
import { createStaff, openStore } from '../dist/server/store.js';

const directory = mkdtempSync(join(tmpdir(), 'restaurant-browser-'));
const db = openStore(join(directory, 'test.sqlite'));
const port = Number(process.env.RESTAURANT_TEST_PORT ?? 31963);
const origin = `http://127.0.0.1:${port}`;
const password = 'test-only-browser-fixture-password';
const app = buildApp(db, { origin, sampleArtwork: true, tableQrPreview: 'http://127.0.0.1:3200/r/ranchi-cafe' });
const externalRequests = [];
const browserErrors = [];
let browser;
const screenshots = process.env.RESTAURANT_TEST_SCREENSHOTS;

async function checkAccessibility(page, screen) {
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () => {
    const results = await window.axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] });
    return results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }));
  });
  assert.deepEqual(violations, [], `Accessibility checks failed on ${screen}`);
}

async function isolatedPage(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const target = new URL(route.request().url());
    if (target.origin === origin) return route.continue();
    externalRequests.push(target.origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  return page;
}

async function staffPage(role, width = 390) {
  const page = await isolatedPage(width);
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Staff sign-in' }).waitFor();
  if (role === 'waiter') {
    await checkAccessibility(page, 'staff sign-in');
    if (screenshots) await page.screenshot({ path: join(screenshots, 'sign-in.png') });
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.getByLabel('Username').evaluate(input => input === document.activeElement), true);
  await page.getByLabel('Username').fill(role);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  return page;
}

try {
  for (const role of ['admin', 'waiter', 'kitchen', 'billing']) createStaff(db, role, role, role, password);
  createStaff(db, 'second-waiter', 'Second waiter', 'waiter', password);
  db.exec(`
    INSERT INTO dining_tables (label) VALUES ('Table 7'), ('Table 9');
    INSERT INTO menu (name, price_paise, category, available) VALUES
      ('Paneer tikka', 24000, 'Starters', 1), ('Masala chai', 6000, 'Drinks', 1), ('Veg biryani', 22000, 'Mains', 0);
    WITH RECURSIVE sample(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM sample WHERE n < 247)
    INSERT INTO menu (name, price_paise, category) SELECT 'Sample kitchen dish ' || n, 15000, 'Mains' FROM sample;
  `);
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ channel: process.env.RESTAURANT_TEST_BROWSER ?? 'msedge' });
  const waiter = await staffPage('waiter', 320);
  const kitchen = await staffPage('kitchen');
  const counter = await staffPage('billing', 1280);
  const admin = await staffPage('admin', 1280);
  await kitchen.getByText('Dishes will appear here when a waiter sends an order.').waitFor();
  await counter.getByText('Checks will appear here when a waiter opens an order.').waitFor();
  await admin.getByRole('heading', { name: 'Outlet overview' }).waitFor();
  const outletNav = admin.getByRole('navigation', { name: 'Outlet navigation' });
  if (screenshots) {
    const signedOut = await isolatedPage(1672);
    await signedOut.setViewportSize({ width: 1672, height: 941 });
    await signedOut.goto(origin);
    await signedOut.getByRole('heading', { name: 'Staff sign-in' }).waitFor();
    await signedOut.screenshot({ path: join(screenshots, 'sign-in-desktop.png') });
    await signedOut.context().close();
    await admin.screenshot({ path: join(screenshots, 'outlet-overview.png') });
    await waiter.setViewportSize({ width: 1672, height: 941 });
    await waiter.screenshot({ path: join(screenshots, 'table-service.png') });
    await waiter.setViewportSize({ width: 320, height: 844 });
  }

  const cards = admin.getByRole('button', { name: 'Table QR cards' });
  assert.equal(await waiter.getByRole('button', { name: 'Table QR cards' }).count(), 0);
  const missingCode = admin.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/tables/2/qr') });
  await admin.route('**/api/tables/2/qr', route => route.abort());
  await cards.click();
  await missingCode;
  await admin.getByText('Local preview. These codes open only on this computer.').waitFor();
  const codes = admin.getByRole('img', { name: /Menu QR code for Table/ });
  assert.equal(await codes.count(), 2);
  await admin.setViewportSize({ width: 320, height: 844 });
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await checkAccessibility(admin, 'table QR cards');
  await admin.getByLabel('Tables to print').selectOption({ label: 'Table 9' });
  assert.equal(await codes.count(), 1);
  await admin.evaluate(() => { window.print = () => document.body.dataset.printed = 'yes'; });
  await admin.getByRole('button', { name: 'Print cards' }).click();
  await admin.getByRole('alert').filter({ hasText: 'Some QR codes could not load.' }).waitFor();
  assert.equal(await admin.locator('body[data-printed=yes]').count(), 0);
  await admin.unroute('**/api/tables/2/qr');
  await admin.getByRole('button', { name: 'Reload codes' }).click();
  await admin.getByRole('button', { name: 'Print cards' }).click();
  await admin.locator('body[data-printed=yes]').waitFor();
  await admin.getByLabel('Tables to print').selectOption({ label: 'All tables' });
  await admin.setViewportSize({ width: 1280, height: 844 });
  if (screenshots) await admin.screenshot({ path: join(screenshots, 'table-qr-cards.png') });
  await admin.emulateMedia({ media: 'print' });
  assert.equal(await admin.getByRole('button', { name: 'Sign out' }).isVisible(), false);
  assert.equal(await admin.getByRole('button', { name: 'Print cards' }).isVisible(), false);
  assert.equal(await codes.first().isVisible(), true);
  assert.equal(await admin.getByText('Local preview only', { exact: true }).count(), 2);
  const printPdf = await admin.pdf({ preferCSSPageSize: true });
  assert.equal(printPdf.subarray(0, 5).toString(), '%PDF-');
  await admin.emulateMedia({ media: 'screen' });
  await admin.getByRole('button', { name: 'Back to overview' }).click();
  await admin.waitForFunction(() => document.activeElement?.id === 'table-qr-trigger');
  for (const width of [1280, 768, 320]) {
    await admin.setViewportSize({ width, height: 844 });
    for (const label of ['Menu catalog', 'Table QR cards', 'Dine-in coupons', 'Private feedback', 'Waiter activity', 'Outlet overview']) {
      const button = outletNav.getByRole('button', { name: label, exact: true });
      await button.focus();
      await admin.keyboard.press('Enter');
      const heading = admin.getByRole('heading', { name: label, exact: true, level: 1 });
      await heading.waitFor();
      await admin.waitForFunction(() => document.activeElement === document.querySelector('h1'));
      assert.equal(await button.getAttribute('aria-current'), 'page', label);
      assert.equal(await outletNav.locator('[aria-current="page"]').count(), 1, label);
      assert.equal(await admin.locator('.staff-sidebar').count(), 0, label);
      assert.equal(await admin.locator('.overview-banner').isVisible(), true, label);
      const layout = await outletNav.evaluate(nav => ({
        fits: document.documentElement.scrollWidth <= innerWidth,
        targets: Array.from(nav.querySelectorAll('button'), control => control.getBoundingClientRect().height)
      }));
      assert.equal(layout.fits, true, `${label} at ${width}px`);
      assert.ok(layout.targets.every(height => height >= 44), `Touch targets in ${label} at ${width}px`);
      if (width === 320) await checkAccessibility(admin, `${label} at 320px`);
    }
  }
  await admin.setViewportSize({ width: 1280, height: 844 });

  const tableSeven = waiter.locator('section').filter({ has: waiter.getByRole('heading', { name: 'Table 7', exact: true }) });
  await tableSeven.getByRole('button', { name: 'Take order' }).click();
  if (screenshots) {
    await waiter.setViewportSize({ width: 1672, height: 941 });
    await waiter.screenshot({ path: join(screenshots, 'take-order-desktop.png') });
    await waiter.setViewportSize({ width: 320, height: 844 });
  }
  assert.equal(await waiter.getByRole('button', { name: /^Add / }).count(), 250);
  assert.equal(await waiter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok((await waiter.getByRole('button', { name: 'Add Paneer tikka' }).boundingBox()).height >= 44);
  assert.equal(await waiter.getByRole('button', { name: 'Add Veg biryani' }).isDisabled(), true);
  await waiter.getByLabel('Search dishes').fill('no matching dish');
  await waiter.getByText(/No dishes match/).waitFor();
  await waiter.getByRole('button', { name: 'Clear filters' }).click();
  await waiter.getByRole('button', { name: 'Starters' }).click();
  await waiter.getByLabel('Search dishes').fill('TIKKA paneer');
  await waiter.getByRole('button', { name: 'Add Paneer tikka' }).focus();
  await waiter.keyboard.press('Enter');
  await waiter.keyboard.press('Enter');
  await waiter.getByRole('button', { name: 'All', exact: true }).click();
  await waiter.getByLabel('Search dishes').fill('chai');
  await waiter.getByRole('button', { name: 'Add Masala chai' }).click();
  await checkAccessibility(waiter, 'waiter dish picker');
  if (screenshots) await waiter.screenshot({ path: join(screenshots, 'waiter-order.png') });
  await waiter.getByRole('button', { name: 'Review order' }).click();
  await waiter.getByLabel('Note for Paneer tikka').fill('Less spicy');
  await waiter.goBack();
  await waiter.getByLabel('Search dishes').waitFor();
  assert.equal(await waiter.getByLabel('Search dishes').inputValue(), 'chai');
  await waiter.getByRole('button', { name: 'Review order' }).click();
  assert.equal(await waiter.getByLabel('Note for Paneer tikka').inputValue(), 'Less spicy');
  await waiter.getByRole('button', { name: 'Remove Masala chai' }).click();
  await waiter.getByRole('button', { name: 'Undo' }).click();
  await waiter.setViewportSize({ width: 1280, height: 844 });
  assert.equal(await waiter.getByLabel('Note for Paneer tikka').inputValue(), 'Less spicy');
  await waiter.getByText('₹540.00', { exact: true }).waitFor();
  await checkAccessibility(waiter, 'desktop order draft');
  await waiter.setViewportSize({ width: 320, height: 844 });
  await waiter.getByRole('button', { name: 'Send to kitchen' }).waitFor();
  await waiter.context().setOffline(true);
  await waiter.getByText(/Connection lost/).waitFor();
  assert.equal(await waiter.getByRole('button', { name: 'Send to kitchen' }).isDisabled(), true);
  assert.equal(await waiter.getByLabel('Note for Paneer tikka').inputValue(), 'Less spicy');
  await waiter.context().setOffline(false);
  await waiter.getByText('Connected to the outlet', { exact: true }).waitFor();
  let lostResponse = false;
  await waiter.route('**/api/tables/1/orders', async route => {
    if (lostResponse) return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    lostResponse = true;
    return route.abort('connectionreset');
  });
  await waiter.getByRole('button', { name: 'Send to kitchen' }).click();
  await waiter.getByRole('button', { name: 'Retry submission' }).click();
  await waiter.getByRole('button', { name: 'Add to order' }).waitFor();

  const paneer = kitchen.getByRole('listitem').filter({ hasText: 'Paneer tikka' });
  const chai = kitchen.getByRole('listitem').filter({ hasText: 'Masala chai' });
  await counter.locator('.total').getByText('₹540.00', { exact: true }).waitFor();
  await paneer.getByText('Less spicy', { exact: true }).waitFor();
  const waiterPaneer = waiter.getByRole('listitem').filter({ hasText: 'Paneer tikka' });
  const waiterChai = waiter.getByRole('listitem').filter({ hasText: 'Masala chai' });
  await waiterPaneer.getByRole('button', { name: 'Change dish' }).click();
  await waiterPaneer.getByLabel('Quantity', { exact: true }).fill('3');
  await waiterPaneer.getByLabel('Note', { exact: true }).fill('No chilli');
  await waiterPaneer.getByRole('button', { name: 'Save change' }).click();
  await paneer.getByText('No chilli', { exact: true }).waitFor();
  await counter.locator('.total').getByText('₹780.00', { exact: true }).waitFor();
  await paneer.getByRole('button', { name: 'Start preparing' }).click();
  await paneer.getByText('In preparation', { exact: true }).waitFor();
  await paneer.getByRole('button', { name: 'Mark ready' }).click();
  await chai.getByRole('button', { name: 'Start preparing' }).click();
  await waiterChai.getByText('In preparation', { exact: true }).waitFor();
  await waiterChai.getByRole('button', { name: 'Cancel dish' }).click();
  await waiterChai.getByRole('button', { name: 'Request approval' }).click();
  const counterChai = counter.getByRole('listitem').filter({ hasText: 'Masala chai' });
  await counterChai.getByText('Counter approval pending', { exact: true }).waitFor();
  await counter.locator('.total').getByText('₹780.00', { exact: true }).waitFor();
  await checkAccessibility(counter, 'pending dish change');
  await counterChai.getByRole('button', { name: 'Approve change' }).click();
  await chai.getByText('Cancelled', { exact: true }).waitFor();
  await counter.locator('.total').getByText('₹720.00', { exact: true }).waitFor();
  await counter.getByRole('listitem').filter({ hasText: 'Paneer tikka' }).getByText('Ready', { exact: true }).waitFor();
  await counterChai.getByText('Cancelled', { exact: true }).waitFor();
  await admin.getByText('1 active table', { exact: true }).waitFor();
  assert.equal(await admin.getByRole('button', { name: 'Take order' }).count(), 0);
  await counter.getByRole('button', { name: 'Move table' }).click();
  const placement = counter.locator('.placement-form');
  await counter.waitForFunction(() => document.activeElement?.id.startsWith('placement-destination-'));
  assert.equal(await counter.getByRole('button', { name: 'Confirm move' }).isDisabled(), true);
  await placement.getByRole('button', { name: 'Cancel' }).click();
  await counter.waitForFunction(() => document.activeElement?.textContent === 'Move table');
  await counter.getByRole('button', { name: 'Move table' }).click();
  await counter.getByLabel('Destination table').selectOption({ label: 'Table 9' });
  const placementRequest = '**/api/tables/*/placement';
  await counter.route(placementRequest, route => route.abort());
  await counter.getByRole('button', { name: 'Confirm move' }).click();
  await placement.getByRole('alert').filter({ hasText: 'Connection interrupted' }).waitFor();
  assert.equal(await counter.getByLabel('Destination table').locator('option:checked').textContent(), 'Table 9');
  if (screenshots) await placement.screenshot({ path: join(screenshots, 'table-move-retry.png') });
  await counter.unroute(placementRequest);
  await counter.getByRole('button', { name: 'Confirm move' }).click();
  await kitchen.getByRole('heading', { name: 'Table 9' }).waitFor();
  await counter.getByRole('button', { name: 'Transfer waiter' }).click();
  await placement.getByText(/Transfer Table 9 from/).waitFor();
  await counter.getByLabel('Receiving waiter').selectOption({ label: 'Second waiter' });
  await counter.getByRole('button', { name: 'Confirm transfer' }).click();
  await counter.getByText('Second waiter', { exact: true }).waitFor();
  await counter.locator('.total').getByText('₹720.00', { exact: true }).waitFor();
  await Promise.all([
    checkAccessibility(kitchen, 'kitchen queue'),
    checkAccessibility(counter, 'counter checks'),
    checkAccessibility(admin, 'outlet overview')
  ]);
  if (screenshots) await counter.screenshot({ path: join(screenshots, 'counter.png') });
  if (screenshots) {
    await kitchen.setViewportSize({ width: 1672, height: 941 });
    await kitchen.screenshot({ path: join(screenshots, 'kitchen-queue.png') });
    await kitchen.setViewportSize({ width: 390, height: 844 });
  }
  assert.equal(await counter.getByRole('listitem').count(), 2);

  await tableSeven.getByRole('button', { name: 'Take order' }).click();
  await waiter.getByLabel('Search dishes').fill('Masala chai');
  await waiter.getByRole('button', { name: 'Add Masala chai' }).click();
  await waiter.getByRole('button', { name: 'Review order' }).click();
  await waiter.getByRole('button', { name: 'Send to kitchen' }).click();
  await counter.setViewportSize({ width: 320, height: 844 });
  await counter.getByRole('button', { name: /^Table 7\b/ }).click();
  await counter.waitForFunction(() => document.activeElement?.id === 'counter-check-title');
  const sourceTable = counter.locator('.table-panel').filter({ has: counter.getByRole('heading', { name: 'Table 7', exact: true }) });
  await sourceTable.getByRole('button', { name: 'Join tables' }).click();
  await sourceTable.getByLabel('Destination table').selectOption({ label: 'Table 9' });
  await sourceTable.getByRole('button', { name: 'Confirm join' }).click();
  await sourceTable.waitFor({ state: 'hidden' });
  await counter.locator('.total').getByText('₹780.00', { exact: true }).waitFor();
  await kitchen.getByRole('heading', { name: 'Table 7', exact: true }).waitFor({ state: 'hidden' });
  await counter.setViewportSize({ width: 320, height: 844 });
  await counter.getByRole('button', { name: 'Split check' }).click();
  await counter.waitForFunction(() => document.activeElement?.textContent === 'Split by dish quantity');
  await counter.locator('.split-section .total').getByText('₹780.00', { exact: true }).waitFor();
  assert.equal(await counter.getByRole('button', { name: 'Save split' }).isDisabled(), true);
  await counter.getByLabel('Quantity of Paneer tikka on check 2, No chilli').fill('1');
  await counter.getByLabel('Quantity of Masala chai on check 2').fill('1');
  await checkAccessibility(counter, 'split editor');
  assert.equal(await counter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshots) await counter.screenshot({ path: join(screenshots, 'split-editor.png') });
  await counter.getByRole('button', { name: 'Save split' }).click();
  const split = counter.getByRole('region', { name: 'Saved split checks' });
  await split.getByText('₹480.00', { exact: true }).waitFor();
  await split.getByText('₹300.00', { exact: true }).waitFor();
  await counter.reload();
  await split.getByText('₹480.00', { exact: true }).waitFor();
  await split.getByRole('button', { name: 'Reopen check' }).click();
  await split.getByRole('button', { name: 'Confirm reopen' }).click();
  await counter.getByRole('button', { name: 'Split check' }).waitFor();
  await counter.locator('.total').getByText('₹780.00', { exact: true }).waitFor();
  const assignedWaiter = await staffPage('second-waiter');
  await assignedWaiter.getByRole('heading', { name: 'Table 9', exact: true }).waitFor();
  assert.equal(await assignedWaiter.getByRole('button', { name: 'Mark table vacant' }).count(), 0);
  await admin.getByRole('button', { name: 'Dine-in coupons' }).click();
  await admin.getByRole('button', { name: 'Create coupon' }).click();
  await admin.waitForFunction(() => document.activeElement?.id === 'coupon-code');
  assert.equal(await outletNav.getByRole('button', { name: 'Menu catalog' }).isDisabled(), true);
  await admin.getByRole('button', { name: 'Cancel', exact: true }).click();
  await admin.waitForFunction(() => document.activeElement?.id === 'create-coupon');
  assert.equal(await outletNav.getByRole('button', { name: 'Menu catalog' }).isEnabled(), true);
  await admin.getByRole('button', { name: 'Create coupon' }).click();
  await admin.getByLabel('Code', { exact: true }).fill('RANCHI50');
  await admin.getByLabel('Discount (₹)', { exact: true }).fill('50');
  await admin.getByLabel('Minimum check (₹, optional)', { exact: true }).fill('500');
  await admin.getByRole('button', { name: 'Create coupon' }).click();
  await admin.getByText('Coupon saved.', { exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Create coupon' }).click();
  await admin.getByLabel('Code', { exact: true }).fill('TEATIME');
  await admin.getByLabel('Discount (₹)', { exact: true }).fill('25');
  await admin.getByLabel('Public offer title (optional)', { exact: true }).fill('Tea time offer');
  await admin.getByRole('button', { name: 'Create coupon' }).click();
  await admin.getByText('Public offer · Tea time offer', { exact: true }).waitFor();
  await admin.setViewportSize({ width: 320, height: 844 });
  await admin.getByLabel('Search coupons').fill('Missing coupon');
  await admin.getByText('No coupons match your filters.').waitFor();
  await admin.getByRole('button', { name: 'Clear filters' }).click();
  await admin.getByRole('rowheader', { name: 'RANCHI50' }).waitFor();
  await checkAccessibility(admin, 'dine-in coupons');
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshots) await admin.screenshot({ path: join(screenshots, 'coupon-manager.png') });
  if (screenshots) {
    await admin.setViewportSize({ width: 1672, height: 941 });
    await admin.screenshot({ path: join(screenshots, 'coupons-desktop.png') });
    await admin.setViewportSize({ width: 320, height: 844 });
  }
  await admin.getByRole('button', { name: 'Back to overview' }).click();
  await counter.getByRole('button', { name: 'Record receipt' }).click();
  await counter.getByLabel('Coupon code (optional)').fill('ranchi50');
  assert.equal(await counter.getByRole('button', { name: 'Save receipt' }).isDisabled(), true);
  await counter.getByRole('button', { name: 'Check coupon' }).click();
  await counter.getByText(/RANCHI50 saves ₹50\.00.*Items after discount ₹730\.00/).waitFor();
  await counter.getByLabel('Receipt reference').fill('DEMO-POS-078');
  await counter.getByLabel('Official total (₹)').fill('740.50');
  await checkAccessibility(counter, 'receipt handoff');
  await counter.getByRole('button', { name: 'Save receipt' }).click();
  await counter.getByText('Unpaid', { exact: true }).waitFor();
  await counter.getByText(/DEMO-POS-078.*₹740\.50/).waitFor();
  await counter.getByText('Coupon RANCHI50 · ₹50.00 off', { exact: true }).waitFor();
  await counter.getByRole('button', { name: 'Record payment' }).click();
  await counter.getByLabel('Payment outcome').selectOption('UPI');
  await counter.getByRole('button', { name: 'Save payment' }).click();
  await counter.getByRole('button', { name: 'Paid checks', exact: true }).click();
  await counter.getByText('Paid · UPI', { exact: true }).waitFor();
  const couponTotals = await admin.evaluate(async () => (await fetch('/api/coupons')).json());
  assert.equal(couponTotals.redemptions.RANCHI50, 1);
  await counter.getByText('Private feedback code', { exact: true }).waitFor();
  const feedbackCode = await counter.locator('.feedback-code').textContent();
  assert.match(feedbackCode, /^(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/);
  await counter.evaluate(() => {
    window.print = () => {
      document.body.dataset.feedbackPrinted = String(document.querySelectorAll('[data-print-feedback]').length);
    };
  });
  await counter.getByRole('button', { name: 'Print feedback slip' }).click();
  await counter.locator('body[data-feedback-printed="1"]').waitFor();
  await counter.locator('.receipt-feedback').evaluate(element => { element.dataset.printFeedback = 'true'; });
  await counter.emulateMedia({ media: 'print' });
  assert.equal(await counter.getByText(feedbackCode, { exact: true }).isVisible(), true);
  assert.equal(await counter.getByText(/DEMO-POS-078/).isVisible(), false);
  await counter.emulateMedia({ media: 'screen' });
  await counter.locator('.receipt-feedback').evaluate(element => { delete element.dataset.printFeedback; });
  const feedbackRequest = '**/api/feedback';
  await admin.route(feedbackRequest, route => route.abort());
  await admin.getByRole('button', { name: 'Private feedback' }).click();
  await admin.getByRole('alert').filter({ hasText: 'Connection interrupted' }).waitFor();
  await admin.unroute(feedbackRequest);
  await admin.getByRole('button', { name: 'Refresh feedback' }).click();
  await admin.getByText('Connect the hosted menu to receive guest feedback.', { exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Back to overview' }).click();
  assert.equal(await assignedWaiter.getByRole('button', { name: 'Mark table vacant' }).count(), 0);
  const queuedChai = kitchen.getByRole('listitem').filter({ hasText: 'Masala chai' }).filter({
    has: kitchen.getByText('Queued', { exact: true })
  });
  await queuedChai.getByRole('button', { name: 'Mark ready' }).click();
  await assignedWaiter.getByRole('button', { name: 'Mark table vacant' }).click();
  await assignedWaiter.getByRole('button', { name: 'Confirm vacancy' }).click();
  await counter.getByRole('heading', { name: 'Table 9', exact: true }).waitFor({ state: 'hidden' });
  await counter.getByRole('button', { name: 'Open checks', exact: true }).click();
  await kitchen.getByRole('heading', { name: 'Table 9', exact: true }).waitFor({ state: 'hidden' });

  async function openPaperOrder(table, mode) {
    await counter.getByRole('button', { name: 'Enter paper order' }).click();
    await counter.waitForFunction(() => document.activeElement?.id === 'paper-setup-title');
    assert.equal(await counter.getByRole('button', { name: 'Choose dishes' }).isDisabled(), true);
    await counter.getByLabel('Table', { exact: true }).selectOption({ label: `${table} · Vacant` });
    await counter.getByLabel('Waiter to credit').selectOption({ label: 'Second waiter' });
    await counter.getByLabel('Paper order type').selectOption(mode);
    if (mode === 'served') {
      await checkAccessibility(counter, 'paper order setup');
      assert.equal(await counter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (screenshots) await counter.screenshot({ path: join(screenshots, 'paper-order-setup.png') });
    }
    await counter.getByRole('button', { name: 'Choose dishes' }).click();
  }

  await openPaperOrder('Table 7', 'served');
  await counter.getByLabel('Search dishes').fill('Veg biryani');
  await counter.getByRole('button', { name: 'Add Veg biryani' }).click();
  await counter.getByRole('button', { name: 'Review order' }).click();
  await counter.getByLabel('Note for Veg biryani').fill('From paper slip');
  await counter.getByRole('button', { name: 'Save served order' }).click();
  const paperTable = counter.locator('.table-panel').filter({ has: counter.getByRole('heading', { name: 'Table 7', exact: true }) });
  await paperTable.getByText('Paper · already served', { exact: true }).waitFor();
  await paperTable.locator('.total').getByText('₹220.00', { exact: true }).waitFor();
  assert.equal(await kitchen.getByRole('heading', { name: 'Table 7', exact: true }).count(), 0);

  await openPaperOrder('Table 9', 'live');
  await counter.getByLabel('Search dishes').fill('Masala chai');
  await counter.getByRole('button', { name: 'Add Masala chai' }).click();
  await counter.getByRole('button', { name: 'Review order' }).click();
  await counter.getByRole('button', { name: 'Send to kitchen' }).click();
  await kitchen.getByRole('heading', { name: 'Table 9', exact: true }).waitFor();
  await kitchen.getByText('Paper · live', { exact: true }).waitFor();
  assert.equal(await kitchen.getByRole('heading', { name: 'Table 7', exact: true }).count(), 0);

  assert.equal(await counter.getByRole('button', { name: 'Waiter activity' }).count(), 0);
  await admin.getByRole('button', { name: 'Waiter activity' }).click();
  const activity = admin.getByRole('table', { name: 'Activity by waiter' });
  const secondWaiter = activity.getByRole('row').filter({ has: admin.getByRole('rowheader', { name: 'Second waiter', exact: true }) });
  await secondWaiter.getByText('1 live · 1 served', { exact: true }).waitFor();
  assert.deepEqual((await secondWaiter.getByRole('cell').allTextContents()).slice(0, 2), ['2', '2']);
  const currentDate = await admin.getByLabel('Date in period').inputValue();
  await admin.setViewportSize({ width: 320, height: 844 });
  await admin.getByLabel('Period', { exact: true }).selectOption('week');
  await admin.getByRole('button', { name: 'Run report' }).click();
  await admin.getByText(/ to .*India time/).waitFor();
  await admin.getByLabel('Date in period').fill('2000-01-01');
  await admin.getByLabel('Period', { exact: true }).selectOption('month');
  await admin.getByRole('button', { name: 'Run report' }).click();
  await admin.getByText(/1 Jan 2000 to 31 Jan 2000/).waitFor();
  assert.deepEqual(await secondWaiter.getByRole('cell').allTextContents(), ['0', '0', '0']);
  await admin.getByLabel('Date in period').fill(currentDate);
  await admin.getByRole('button', { name: 'Run report' }).click();
  await secondWaiter.getByText('1 live · 1 served', { exact: true }).waitFor();
  const reportRequest = url => url.pathname === '/api/reports/waiter-activity';
  await admin.route(reportRequest, route => route.abort());
  await admin.getByRole('button', { name: 'Run report' }).click();
  await admin.getByText(/Connection interrupted/).waitFor();
  await secondWaiter.getByText('1 live · 1 served', { exact: true }).waitFor();
  await admin.unroute(reportRequest);
  await admin.getByRole('button', { name: 'Run report' }).click();
  await admin.getByRole('alert').waitFor({ state: 'hidden' });
  await admin.getByRole('button', { name: 'Run report' }).waitFor();
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await checkAccessibility(admin, 'waiter activity report');
  if (screenshots) await admin.screenshot({ path: join(screenshots, 'waiter-activity.png') });
  await admin.getByRole('button', { name: 'Back to overview' }).click();
  await admin.getByRole('button', { name: 'Waiter activity' }).waitFor();
  await admin.getByRole('button', { name: 'Menu catalog' }).click();
  if (screenshots) {
    await admin.setViewportSize({ width: 1672, height: 941 });
    await admin.screenshot({ path: join(screenshots, 'menu-catalog.png') });
    await admin.setViewportSize({ width: 320, height: 844 });
  }
  await admin.getByText('Public menu publishing is off.', { exact: true }).waitFor();
  await admin.getByLabel('Find a dish').fill('No matching dish');
  await admin.getByText('No dishes match your filters.').waitFor();
  await admin.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await admin.getByLabel('Find a dish').inputValue(), '');
  await admin.getByLabel('Find a dish').fill('Paneer tikka');
  const exportMenu = admin.getByRole('button', { name: 'Export menu images' });
  await exportMenu.click();
  await admin.getByLabel('Title on the images').fill('Ranchi Café <Menu>');
  await admin.getByRole('button', { name: 'Create preview' }).click();
  const firstImage = admin.getByRole('img', { name: /^Ranchi Café <Menu>, image 1 of/ });
  await firstImage.waitFor();
  const pageStatus = admin.getByRole('status').filter({ hasText: /^Page / });
  const pageCount = Number((await pageStatus.textContent()).match(/of (\d+)/)[1]);
  assert.ok(pageCount > 1);
  await admin.locator('summary').filter({ hasText: 'Text on this page' }).click();
  await admin.getByText('Veg biryani · ₹220.00 · Sold out', { exact: false }).waitFor();
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await checkAccessibility(admin, 'menu image export');
  if (screenshots) await firstImage.screenshot({ path: join(screenshots, 'menu-image-preview.png') });
  const [png] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: 'Download this PNG' }).click()]);
  assert.equal(png.suggestedFilename(), 'menu-01.png');
  const imageMetadata = await sharp(await png.path()).metadata();
  assert.deepEqual([imageMetadata.format, imageMetadata.width, imageMetadata.height], ['png', 1080, 1350]);

  let dishes = await admin.locator('.menu-image-export details li').count();
  const nextImage = admin.getByRole('button', { name: 'Next page' });
  for (let page = 2; page <= pageCount; page++) {
    await nextImage.click();
    await admin.getByText(`Page ${page} of ${pageCount}`, { exact: true }).waitFor();
    dishes += await admin.locator('.menu-image-export details li').count();
  }
  assert.equal(dishes, 250, 'Export includes the full catalog even when catalog search was active.');
  assert.equal(await nextImage.isDisabled(), true);
  const [archive] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: 'Download all as ZIP' }).click()]);
  assert.equal(archive.suggestedFilename(), 'menu-images.zip');
  const files = unzipSync(readFileSync(await archive.path()));
  assert.equal(Object.keys(files).length, pageCount);
  assert.equal(Buffer.compare(Buffer.from(files['menu-01.png']), readFileSync(await png.path())), 0);
  await admin.getByRole('button', { name: 'Back to catalog' }).click();
  await admin.waitForFunction(() => document.activeElement?.id === 'menu-image-trigger');
  await admin.getByLabel('Find a dish').fill('');
  await admin.getByRole('button', { name: 'Add dish' }).click();
  await admin.waitForFunction(() => document.activeElement?.id === 'catalog-name');
  assert.equal(await outletNav.getByRole('button', { name: 'Outlet overview' }).isDisabled(), true);
  await admin.getByLabel('Dish name').fill('Lemon rice');
  await admin.getByLabel('Category', { exact: true }).fill('Lunch specials');
  await admin.getByLabel('Price (₹)').fill('125.50');
  await admin.getByLabel('Description (optional)').fill('With curry leaves');
  await checkAccessibility(admin, 'dish editor');
  if (screenshots) await admin.screenshot({ path: join(screenshots, 'dish-editor.png') });
  await admin.getByRole('button', { name: 'Save dish' }).click();
  await admin.getByLabel('Find a dish').fill('Lemon rice');
  const adminDish = admin.getByRole('listitem').filter({ hasText: 'Lemon rice' });
  await adminDish.getByText('With curry leaves', { exact: true }).waitFor();
  await adminDish.getByRole('button', { name: 'Edit dish' }).click();
  await admin.getByLabel('Price (₹)').fill('140.00');
  await admin.getByRole('button', { name: 'Save dish' }).click();
  await adminDish.getByText(/₹140\.00/).waitFor();
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await adminDish.getByRole('button', { name: 'Add photo' }).click();
  const photo = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#b47e51' } }).png().toBuffer();
  await admin.getByLabel('Choose photo').setInputFiles({ name: 'dish.png', mimeType: 'image/png', buffer: photo });
  await admin.getByRole('button', { name: 'Save photo' }).click();
  await adminDish.getByRole('button', { name: 'Change photo' }).waitFor();

  const guest = await isolatedPage(320);
  await guest.goto(`${origin}/guest-menu`);
  await guest.getByRole('heading', { name: 'Restaurant menu', exact: true }).waitFor();
  await guest.getByRole('button', { name: 'Search menu' }).click();
  const guestSearch = guest.getByRole('searchbox', { name: 'Search dishes' });
  assert.equal(await guestSearch.evaluate(input => input === document.activeElement), true);
  await guestSearch.fill('no matching dish');
  await guest.getByText('No dishes match your search.').waitFor();
  await guest.getByRole('button', { name: 'Clear search' }).click();
  await guestSearch.fill('paneer starters');
  await guest.getByRole('status').filter({ hasText: '1 dish found' }).waitFor();
  await guestSearch.press('Escape');
  assert.equal(await guest.getByRole('button', { name: 'Search menu' }).evaluate(button => button === document.activeElement), true);
  await guest.getByRole('img', { name: 'Paneer tikka' }).waitFor();
  await guest.getByRole('listitem').filter({ hasText: 'Paneer tikka' }).getByText('Available', { exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: /^Add\b/ }).count(), 0);
  const guestDish = guest.getByRole('listitem').filter({ hasText: 'Lemon rice' });
  await guestDish.getByText('₹140.00', { exact: true }).waitFor();
  await guestDish.getByRole('img', { name: 'Lemon rice' }).scrollIntoViewIfNeeded();
  assert.equal(await guestDish.getByRole('img', { name: 'Lemon rice' }).evaluate(img => img.decode().then(() => img.naturalWidth > 0)), true);
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await guest.getByLabel('Preview themes').click();
  await guest.getByRole('link', { name: 'Photo-led' }).click();
  await guestDish.getByText('With curry leaves', { exact: true }).waitFor();
  await guest.getByRole('link', { name: 'Lunch specials', exact: true }).click();
  assert.equal(await guest.getByRole('link', { name: 'Lunch specials', exact: true }).getAttribute('aria-current'), 'location');
  await guestDish.getByRole('img', { name: 'Lemon rice' }).scrollIntoViewIfNeeded();
  assert.equal(await guestDish.getByRole('img', { name: 'Lemon rice' }).evaluate(img => img.decode().then(() => img.naturalWidth > 0)), true);
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  let classicMenu;
  for (const theme of ['classic', 'photo-led']) {
    await guest.goto(`${origin}/guest-menu?theme=${theme}`);
    await guestDish.getByText('₹140.00', { exact: true }).waitFor();
    const contents = await guest.locator('.guest-category').allTextContents();
    if (theme === 'classic') classicMenu = contents;
    else assert.deepEqual(contents, classicMenu, 'Both themes must show the same live menu');
    const heroUrl = await guest.locator('.guest-hero').evaluate(hero => getComputedStyle(hero).backgroundImage.match(/url\("([^"]+)"\)/)?.[1]);
    assert.ok(heroUrl, `Missing ${theme} hero`);
    const hero = await guest.request.get(heroUrl);
    assert.equal(hero.status(), 200);
    assert.equal(hero.headers()['content-type'], 'image/webp');
    for (const width of [320, 390, 768, 1280]) {
      await guest.setViewportSize({ width, height: 844 });
      const layout = await guest.locator('.guest-page').evaluate(page => ({
        fits: document.documentElement.scrollWidth <= innerWidth,
        targets: Array.from(page.querySelectorAll('.guest-icon-button, .guest-themes a, .guest-categories a'), control => control.getBoundingClientRect())
          .filter(rect => rect.width > 0 && rect.height > 0)
          .map(rect => ({ width: rect.width, height: rect.height }))
      }));
      assert.equal(layout.fits, true, `${theme} menu at ${width}px`);
      assert.ok(layout.targets.every(target => target.width >= 44 && target.height >= 44), `${theme} touch targets at ${width}px`);
      if (width === 320 || width === 1280) await checkAccessibility(guest, `${theme} menu at ${width}px`);
      if (screenshots && (width === 390 || width === 1280)) {
        await guest.screenshot({ path: join(screenshots, `guest-${theme}-${width}.png`) });
      }
    }
  }

  await kitchen.getByRole('button', { name: 'Dish availability', exact: true }).click();
  if (screenshots) {
    await kitchen.setViewportSize({ width: 1672, height: 941 });
    await kitchen.screenshot({ path: join(screenshots, 'dish-availability.png') });
    await kitchen.setViewportSize({ width: 390, height: 844 });
  }
  assert.equal(await kitchen.getByRole('button', { name: 'Export menu images' }).count(), 0);
  await kitchen.getByLabel('Find a dish').fill('Lemon rice');
  const kitchenDish = kitchen.getByRole('listitem').filter({ hasText: 'Lemon rice' });
  assert.equal(await kitchen.getByRole('button', { name: 'Add dish' }).count(), 0);
  await kitchenDish.getByRole('button', { name: 'Mark sold out' }).click();
  const expected = new Date(Date.now() + (330 + 45) * 60_000).toISOString().slice(0, 16);
  await kitchen.getByLabel('Expected return (India time, optional)').fill(expected);
  const [availabilitySaved] = await Promise.all([
    kitchen.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/availability')),
    kitchen.getByRole('button', { name: 'Save sold out' }).click()
  ]);
  assert.equal(availabilitySaved.status(), 204, await availabilitySaved.text());
  await kitchenDish.getByText(/min left/).waitFor();
  await guest.reload();
  await guestDish.getByText('Sold out', { exact: true }).waitFor();
  const assignedTable = assignedWaiter.locator('.table-panel').filter({
    has: assignedWaiter.getByRole('heading', { name: 'Table 9', exact: true })
  });
  await assignedTable.getByRole('button', { name: 'Add to order' }).click();
  await assignedWaiter.getByLabel('Search dishes').fill('Lemon rice');
  const addLemonRice = assignedWaiter.getByRole('button', { name: 'Add Lemon rice' });
  await assignedWaiter.getByText('Sold out', { exact: true }).waitFor();
  assert.equal(await addLemonRice.isDisabled(), true);
  await kitchenDish.getByRole('button', { name: 'Confirm available' }).click();
  await kitchenDish.getByText('Available', { exact: true }).waitFor();
  await addLemonRice.click();
  await assignedWaiter.getByRole('button', { name: 'Review order' }).click();
  await assignedWaiter.locator('.draft-panel .total').getByText('₹140.00', { exact: true }).waitFor();
  await admin.getByRole('navigation', { name: 'Outlet navigation' }).getByRole('button', { name: 'Outlet overview', exact: true }).click();
  await admin.getByRole('button', { name: 'Change service mode' }).click();
  await admin.getByLabel('Service mode', { exact: true }).selectOption('both');
  await admin.getByRole('button', { name: 'Confirm service mode' }).click();
  await admin.getByText('Table and counter service', { exact: true }).waitFor();
  await counter.getByRole('button', { name: 'Counter orders', exact: true }).click();
  await counter.getByRole('button', { name: 'New counter order' }).click();
  await counter.getByLabel('Customer name (optional)').fill('Counter guest');
  await counter.getByRole('button', { name: 'Choose dishes' }).click();
  await counter.getByLabel('Search dishes').fill('Paneer tikka');
  await counter.getByRole('button', { name: 'Add Paneer tikka' }).click();
  await counter.getByRole('button', { name: 'Add Paneer tikka' }).click();
  await counter.getByRole('button', { name: 'Review order' }).click();
  await counter.setViewportSize({width:1280,height:844});
  await counter.locator('.draft-panel .total').getByText('₹480.00',{exact:true}).waitFor();
  await counter.setViewportSize({width:320,height:844});
  await counter.getByRole('button', { name: 'Save for payment' }).click();
  const counterOrder = counter.getByRole('article', { name: /^Unpaid counter order/ });
  await counterOrder.getByText('Awaiting payment', { exact: true }).waitFor();
  assert.equal(await counterOrder.getByRole('button', { name: 'Print token' }).count(), 0);
  await checkAccessibility(counter, 'unpaid counter order');
  assert.equal(await counter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await counterOrder.getByLabel('Official receipt reference').fill('COUNTER-001');
  await counterOrder.getByLabel('Official receipt amount (₹)').fill('480');
  const counterPayment = '**/api/counter-orders/*/payment';
  await counter.route(counterPayment, async route => {
    await route.fetch();
    await route.abort();
  }, { times: 1 });
  await counterOrder.getByRole('button', { name: 'Record payment and issue token' }).click();
  const paidCounterOrder = counter.getByRole('article', { name: /^\d{4}-\d{2}-\d{2} #1$/ });
  await paidCounterOrder.getByText('Paid · Cash · COUNTER-001', { exact: true }).waitFor();
  await counter.evaluate(() => { window.print = () => document.body.dataset.counterPrinted = 'yes'; });
  await paidCounterOrder.getByRole('button', { name: 'Print token' }).click();
  await counter.locator('body[data-counter-printed=yes]').waitFor();
  await paidCounterOrder.getByRole('button', { name: 'Cancel some items' }).click();
  await paidCounterOrder.getByLabel('Refund amount from official receipt (₹)').fill('240');
  await paidCounterOrder.getByLabel('Cancellation reason').fill('One guest left');
  await paidCounterOrder.getByRole('button', { name: 'Confirm cancellation' }).click();
  await paidCounterOrder.getByText(/Refund needed · ₹240.00/).waitFor();
  await paidCounterOrder.getByRole('button', { name: 'Record external refund' }).click();
  await paidCounterOrder.getByLabel('External refund reference').fill('COUNTER-REFUND-001');
  await paidCounterOrder.getByRole('button', { name: 'Confirm refund' }).click();
  await paidCounterOrder.getByText('₹240.00 · Refund recorded · COUNTER-REFUND-001', { exact: true }).waitFor();
  await kitchen.getByRole('button', { name: 'Back to queue' }).click();
  const kitchenCounter = kitchen.getByRole('article', { name: /^\d{4}-\d{2}-\d{2} #1$/ });
  await kitchenCounter.waitFor();
  assert.equal(await kitchenCounter.getByText('Counter guest', { exact: true }).count(), 0);
  await checkAccessibility(kitchen, 'mixed kitchen queue');
  await kitchenCounter.getByRole('button', { name: 'Mark ready' }).click();
  await paidCounterOrder.getByRole('button', { name: /^Confirm collected/ }).waitFor();
  await checkAccessibility(counter, 'ready counter order');
  for(const width of [320,390,768,1280]) {
    await counter.setViewportSize({width,height:844});
    assert.equal(await counter.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Counter service at ${width}px`);
    if(width===1280) await checkAccessibility(counter,'desktop counter order');
    if(screenshots&&(width===390||width===1280)) await counter.screenshot({path:join(screenshots,`counter-pay-first-${width}.png`)});
  }
  await counter.setViewportSize({width:320,height:844});
  await paidCounterOrder.getByRole('button', { name: /^Confirm collected/ }).click();
  await paidCounterOrder.waitFor({ state: 'hidden' });
  await counter.getByRole('button', { name: 'History · last 7 days' }).click();
  await paidCounterOrder.getByText('Collected', { exact: true }).waitFor();
  assert.equal(await counter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const counterResults = await counter.evaluate(async () => (await fetch('/api/service')).json());
  assert.equal(counterResults.counterOrders.length, 1);
  assert.equal(counterResults.counterOrders[0].receipts.length, 1);
  assert.equal(counterResults.counterOrders[0].lines[0].quantity, 1);
  assert.equal(counterResults.counterOrders[0].corrections[0].amountPaise, 24000);
  const liveTable=kitchen.locator('.table-panel').filter({has:kitchen.getByRole('heading',{name:'Table 9',exact:true})});
  await liveTable.getByRole('button',{name:'Mark ready',exact:true}).click();
  await counter.getByRole('button',{name:'Table checks',exact:true}).click();
  await counter.getByRole('button',{name:/^Table 9\b/}).click();
  const readyTable=counter.locator('.table-panel').filter({has:counter.getByRole('heading',{name:'Table 9',exact:true})});
  await readyTable.getByRole('button',{name:'Correct ready dish'}).click();
  await readyTable.getByLabel('Note',{exact:true}).fill('Counter corrected the note');
  await readyTable.getByLabel('Correction reason').fill('Paper slip clarification');
  await readyTable.getByRole('button',{name:'Save change',exact:true}).click();
  await readyTable.getByText('Counter corrected the note',{exact:true}).waitFor();
  await admin.getByRole('button', { name: 'Change service mode' }).click();
  await admin.getByLabel('Changes after preparation starts', { exact: true }).selectOption('blocked');
  await admin.getByRole('button', { name: 'Confirm service mode' }).click();
  await admin.getByText('Changes after preparation starts · Blocked', { exact: true }).waitFor();
  await admin.locator('summary').filter({ hasText: 'Manage staff and tables' }).click();
  await admin.getByLabel('Staff name', { exact: true }).fill('Counter assistant');
  await admin.getByLabel('Staff username', { exact: true }).fill('counter-assistant');
  await admin.getByRole('button', { name: 'Create staff account' }).click();
  await admin.getByRole('button', { name: 'I have saved the credentials' }).click();
  await admin.getByRole('button', { name: 'Disable counter-assistant', exact: true }).click();
  await admin.getByRole('button', { name: 'Enable counter-assistant', exact: true }).waitFor();
  await admin.getByLabel('Table label', { exact: true }).fill('Patio');
  await admin.getByRole('button', { name: 'Save table' }).click();
  await admin.getByRole('option', { name: 'Patio', exact: true }).waitFor({ state: 'attached' });
  await checkAccessibility(admin, 'owner setup');
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const ownerResolution=admin.getByRole('button',{name:'Review unpaid resolution · Table 9',exact:true});
  await ownerResolution.click();
  const ownerForm=admin.locator('.table-resolution').filter({has:admin.getByRole('heading',{name:'Owner resolution · Table 9'})});
  await ownerForm.getByLabel('Resolution reason').fill('Owner approved test walkout resolution');
  await ownerForm.getByRole('button',{name:'Record resolution and free table'}).click();
  const resolvedTable=admin.locator('.table-panel').filter({has:admin.getByRole('heading',{name:'Table 9',exact:true})});
  await resolvedTable.getByText('Available',{exact:true}).waitFor();
  const afterResolution=await admin.evaluate(async()=>(await fetch('/api/service')).json());
  assert.equal(afterResolution.tables.find(table=>table.label==='Table 9').orderId,null);
  assert.notEqual(afterResolution.tables.find(table=>table.label==='Table 7').orderId,null);
  await admin.getByText('Owner resolution history · latest 100',{exact:true}).waitFor();
  const resolutionNotice=kitchen.getByRole('button',{name:/^Acknowledge · Order/});
  await resolutionNotice.click();
  await resolutionNotice.waitFor({state:'hidden'});
  assert.equal(await waiter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await waiter.getByRole('button', { name: 'Sign out' }).click();
  await waiter.getByRole('heading', { name: 'Staff sign-in' }).waitFor();
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(browserErrors, []);
  console.log('Browser check passed: local operations, catalog and availability, photo upload, and both guest menu themes.');
} finally {
  await browser?.close();
  await app.close();
  db.close();
  rmSync(directory, { recursive: true });
}

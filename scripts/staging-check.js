import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function checkStaging(origin, outlet) {
  const base = URL.parse(origin ?? '');
  if (!base || base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || base.search || base.hash
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(outlet ?? '')) {
    throw new Error('Supply an HTTPS origin and the outlet slug.');
  }
  const get = (path, options) => fetch(new URL(path, base), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(10_000)
  });
  const [page, data, staff, publish] = await Promise.all([
    get(`/r/${outlet}`), get(`/api/public-menu/${outlet}`), get('/api/service'),
    get(`/api/publish/${outlet}/menu`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ]);
  assert.equal(page.status, 200, 'Guest page must be reachable.');
  assert.equal(data.status, 200, 'Outlet must publish a menu before the check.');
  assert.equal(staff.status, 404, 'The guest host must omit the staff API.');
  assert.equal(publish.status, 401, 'The publisher must reject anonymous writes.');
  assert.match(page.headers.get('content-type') ?? '', /^text\/html\b/, 'Guest route must serve HTML.');
  assert.match(data.headers.get('cache-control') ?? '', /\bno-store\b/, 'Menu availability must bypass shared caches.');
  const html = await page.text();
  assert.match(html, /id="guest-root"/, 'Guest page is missing its application mount.');
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[\w-]+\.(?:js|css))"/g)].map(match => match[1]))];
  assert.ok(assets.some(asset => asset.endsWith('.js')) && assets.some(asset => asset.endsWith('.css')), 'Guest bundle references are missing.');
  await Promise.all(assets.map(async asset => {
    const result = await get(asset);
    await result.body?.cancel();
    assert.equal(result.status, 200, `Guest asset is unavailable: ${asset}`);
    assert.match(result.headers.get('content-type') ?? '', asset.endsWith('.css') ? /^text\/css\b/ : /javascript\b/);
  }));
  const menu = await data.json();
  assert.deepEqual(Object.keys(menu).sort(), ['items', 'name', 'publishedAt', 'theme'], 'Guest response fields differ from the public contract.');
  assert.ok(menu.name && ['classic', 'photo-led'].includes(menu.theme) && Number.isFinite(Date.parse(menu.publishedAt)));
  assert.ok(Array.isArray(menu.items) && menu.items.length > 0, 'Publish a non-empty test menu first.');
  for (const item of menu.items) {
    assert.deepEqual(Object.keys(item).sort(), ['available', 'availableAfter', 'category', 'description', 'id', 'name', 'photoKey', 'pricePaise']);
  }
  const dish = menu.items.find(item => item.photoKey);
  if (dish) {
    const photo = await get(`/media/menu/${outlet}/${dish.id}/${dish.photoKey}`);
    await photo.body?.cancel();
    assert.equal(photo.status, 200, 'Published dish photo must be reachable.');
    assert.match(photo.headers.get('content-type') ?? '', /^image\/webp\b/);
  }
  await staff.body?.cancel();
  await publish.body?.cancel();
  return { dishes: menu.items.length, checkedPhoto: Boolean(dish) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { dishes, checkedPhoto } = await checkStaging(process.argv[2], process.argv[3]);
    console.log(`Staging checks passed for ${dishes} dishes${checkedPhoto ? ' and a dish photo' : ''}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

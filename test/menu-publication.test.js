import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createMenuItem, setMenuAvailability } from '../dist/server/menu-catalog.js';
import { updateMenuPhoto } from '../dist/server/menu-photo.js';
import { publicationStatus, publicationTarget, publishMenu } from '../dist/server/menu-publication.js';
import { openStore } from '../dist/server/store.js';

const env = {
  RESTAURANT_PUBLISH_ORIGIN: 'https://menus.example.test',
  RESTAURANT_PUBLISH_OUTLET: 'ranchi-demo',
  RESTAURANT_PUBLISH_TOKEN: randomBytes(32).toString('hex')
};

test('publication stays optional and requires an exact HTTPS origin and installation credential', () => {
  assert.equal(publicationTarget({}), undefined);
  for (const bad of ['http://menus.example.test', 'https://user@menus.example.test', 'https://menus.example.test/path', 'https://menus.example.test/?secret=1']) {
    assert.throws(() => publicationTarget({ ...env, RESTAURANT_PUBLISH_ORIGIN: bad }));
  }
  assert.throws(() => publicationTarget({ ...env, RESTAURANT_PUBLISH_OUTLET: '../other' }));
  assert.throws(() => publicationTarget({ ...env, RESTAURANT_PUBLISH_TOKEN: 'short' }));
  assert.equal(publicationTarget(env).endpoint, 'https://menus.example.test/api/publish/ranchi-demo');
});

test('offline changes survive restart and publish only the latest guest menu with its photos', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'restaurant-publication-'));
  const database = join(directory, 'outlet.sqlite');
  let db = openStore(database);
  const target = publicationTarget(env);
  const signal = new AbortController().signal;
  const photos = new Set();
  const snapshots = [];
  let photoUploads = 0;
  let ackLost = false;
  let editWhilePublishing = false;

  try {
    const id = createMenuItem(db, 'chai-create', { name: 'Chai', category: 'Drinks', description: 'With ginger', pricePaise: 4500 });
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#996633' } }).png().toBuffer();
    await updateMenuPhoto(db, id, 0, png.toString('base64'));
    setMenuAvailability(db, id, { available: false, availableAfter: null, revision: 1 });
    await assert.rejects(publishMenu(db, target, signal, async () => { throw new Error('Offline'); }), /Offline/);
    db.close();
    db = openStore(database);
    assert.deepEqual(publicationStatus(db, target), { configured: true, pending: true, publishedAt: null });

    const receiver = async (url, request) => {
      assert.equal(request.headers.get('Authorization'), `Bearer ${target.token}`);
      assert.equal(request.redirect, 'error');
      assert.ok(url.startsWith(`${target.endpoint}/`));
      if (url.endsWith('/menu')) {
        assert.equal(request.method, 'PUT');
        assert.equal(request.headers.get('Content-Type'), 'application/json');
        const snapshot = JSON.parse(request.body);
        assert.deepEqual(Object.keys(snapshot), ['version', 'items']);
        assert.ok(photos.has(snapshot.items[0].photoKey), 'A photo must exist before publishing its menu');
        snapshots.push(snapshot);
        if (ackLost) throw new Error('Acknowledgment lost');
        if (editWhilePublishing) setMenuAvailability(db, id, { available: true, availableAfter: null, revision: 2 });
        return new Response(null, { status: 204 });
      }
      const key = url.split('/').at(-1);
      if (request.method === 'HEAD') return new Response(null, { status: photos.has(key) ? 204 : 404 });
      assert.equal(request.method, 'PUT');
      assert.equal(request.headers.get('Content-Type'), 'image/webp');
      assert.equal(createHash('sha256').update(request.body).digest('hex'), key);
      photos.add(key);
      photoUploads++;
      return new Response(null, { status: 204 });
    };

    ackLost = true;
    await assert.rejects(publishMenu(db, target, signal, receiver), /Acknowledgment lost/);
    assert.equal(publicationStatus(db, target).publishedAt, null);
    ackLost = false;
    editWhilePublishing = true;
    await publishMenu(db, target, signal, receiver);
    assert.deepEqual(snapshots[0], snapshots[1]);
    assert.deepEqual(snapshots[0].items[0], {
      id, name: 'Chai', category: 'Drinks', pricePaise: 4500, description: 'With ginger',
      available: false, availableAfter: null, photoKey: [...photos][0]
    });
    assert.equal(publicationStatus(db, target).pending, true);
    assert.ok(publicationStatus(db, target).publishedAt);
    editWhilePublishing = false;
    await publishMenu(db, target, signal, receiver);
    assert.equal(snapshots[2].version, snapshots[1].version + 1);
    assert.equal(snapshots[2].items[0].available, true);
    assert.equal(publicationStatus(db, target).pending, false);
    assert.equal(photoUploads, 1);
    assert.equal(publicationStatus(db, publicationTarget({ ...env, RESTAURANT_PUBLISH_OUTLET: 'another' })).pending, true);
    await publishMenu(db, target, signal, async () => assert.fail('Already published'));
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
});

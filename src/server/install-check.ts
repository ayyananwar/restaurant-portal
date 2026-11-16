import { existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { buildApp } from './app.js';
import { openStore, storeSchemaVersion } from './store.js';

const [source, scratch] = process.argv.slice(2);
if (!source || !scratch || existsSync(scratch)) throw new Error('Provide the outlet database and a new validation database path.');
let sourceVersion = 0;
if (existsSync(source)) {
  const original = new DatabaseSync(source, { readOnly: true });
  try {
    sourceVersion = Number(original.prepare('PRAGMA user_version').get()?.user_version);
    if (sourceVersion > storeSchemaVersion) throw new Error('The outlet database requires a newer application version.');
    await backup(original, scratch);
  } finally {
    original.close();
  }
}

const db = openStore(scratch);
try {
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('The database copy failed its integrity check.');
  const app = buildApp(db, { origin: 'http://127.0.0.1:3100' });
  try {
    const manifest = JSON.parse(await readFile(new URL('../client/.vite/manifest.json', import.meta.url), 'utf8')) as Record<string, { file: string; css?: string[] }>;
    if (!manifest['index.html'] || !manifest['guest-menu.html']) throw new Error('The packaged browser build is incomplete.');
    for (const entry of Object.values(manifest)) {
      for (const file of [entry.file, ...(entry.css ?? [])]) await access(new URL(`../client/${file}`, import.meta.url));
    }
    const index = await app.inject({ url: '/', headers: { host: '127.0.0.1:3100' } });
    const guest = await app.inject({ url: '/guest-menu', headers: { host: '127.0.0.1:3100' } });
    if (index.statusCode !== 200 || guest.statusCode !== 200) throw new Error('The packaged browser pages did not load.');
    console.log(JSON.stringify({ sourceVersion, schemaVersion: storeSchemaVersion }));
  } finally {
    await app.close();
  }
} finally {
  db.close();
}

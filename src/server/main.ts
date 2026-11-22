import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildApp } from './app.js';
import { publicationTarget, startMenuPublisher } from './menu-publication.js';
import { openStore } from './store.js';
import { tableQrPreviewUrl } from './table-qr.js';
import { createOnlineConnector } from './online-connector.js';

const host = process.env.RESTAURANT_BIND ?? '127.0.0.1';
const port = Number(process.env.RESTAURANT_PORT ?? '3100');
const key = process.env.RESTAURANT_TLS_KEY;
const cert = process.env.RESTAURANT_TLS_CERT;
const origin = new URL(process.env.RESTAURANT_ORIGIN ?? `http://127.0.0.1:${port}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set a valid RESTAURANT_PORT.');
if (Boolean(key) !== Boolean(cert) || origin.protocol !== (key ? 'https:' : 'http:')
  || (!key && (host !== '127.0.0.1' || origin.hostname !== '127.0.0.1'))) {
  throw new Error('Use a certificate, key, and HTTPS origin for staff network access.');
}
if (Number(origin.port || (key ? 443 : 80)) !== port || origin.pathname !== '/'
  || origin.username || origin.password || origin.search || origin.hash) {
  throw new Error('Set RESTAURANT_ORIGIN to the exact origin and listening port.');
}
const path = resolve(process.env.RESTAURANT_DB ?? 'data/outlet.sqlite');
mkdirSync(dirname(path), { recursive: true });
const db = openStore(path);
let publication;
let tableQrPreview;
try {
  publication = publicationTarget(process.env);
} catch {
  console.error('Menu publication is disabled. Check the HTTPS origin, outlet slug, and installation token.');
}
try {
  tableQrPreview = tableQrPreviewUrl(process.env.RESTAURANT_QR_PREVIEW_URL);
} catch {
  console.error('Table card preview is disabled. Check the loopback guest menu URL.');
}
const online=createOnlineConnector(db,publication);
const app = buildApp(db, {
  origin: origin.origin,
  sampleArtwork: process.env.RESTAURANT_SAMPLE_ARTWORK === '1',
  tls: key && cert ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined,
  publication,
  online,
  tableQrPreview
});
let stopPublisher: ReturnType<typeof startMenuPublisher> | undefined;
app.addHook('onClose', async () => {
  await Promise.all([stopPublisher?.(),online.stop()]);
  db.close();
});
await app.listen({ host, port });
if (publication) stopPublisher = startMenuPublisher(db, publication);
if (publication) online.start();
console.log(`Restaurant portal is running at ${origin.origin}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}

import { readFile } from 'node:fs/promises';
import { buildHostedApp } from './app.js';
import { hostedPool } from './database.js';
import { guestAccountOptions } from './phone-verify.js';

const connectionString = process.env.HOSTED_DATABASE_URL;
const host = process.env.HOSTED_BIND ?? '127.0.0.1';
const port = Number(process.env.HOSTED_PORT ?? '3200');
const key = process.env.HOSTED_TLS_KEY;
const cert = process.env.HOSTED_TLS_CERT;
const accounts = guestAccountOptions(process.env);
if (!connectionString || !Number.isInteger(port) || port < 1 || port > 65535
  || Boolean(key) !== Boolean(cert) || (!key && host !== '127.0.0.1')) {
  throw new Error('Configure the hosted database, a valid port, and TLS for non-loopback access.');
}

const pool = hostedPool(connectionString);
pool.on('error', () => console.error('Hosted database connection interrupted.'));
try {
  await pool.query('SELECT publication_installation FROM hosted_outlets LIMIT 0');
  if (accounts) await pool.query('SELECT 1 FROM guest_accounts, receipt_feedback, outlet_offer_snapshots, outlet_offer_claims LIMIT 0');
  const tls = key && cert ? { key: await readFile(key), cert: await readFile(cert) } : undefined;
  const app = await buildHostedApp(pool, tls, accounts);
  app.addHook('onClose', async () => pool.end());
  await app.listen({ host, port });
  console.log(`Hosted menu is running on ${tls ? 'https' : 'http'}://${host}:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
} catch {
  await pool.end();
  console.error('Hosted menu could not start. Check database access, setup, and listener configuration.');
  process.exitCode = 1;
}

import { createHash, timingSafeEqual } from 'node:crypto';
import pg, { type Pool, type PoolClient } from 'pg';
import type { GuestMenuItem, GuestMenuTheme } from '../shared/contracts.js';

export const outletSlugPattern = '^[a-z0-9][a-z0-9-]{0,62}$';
export const photoKeyPattern = '^[a-f0-9]{64}$';
const photoQuota = 256 * 1024 * 1024;
export const installationPattern = '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$';
export type PublicationLease = { installation?: string; tokenHash?: Buffer };

const publicationConflict = () => Object.assign(new Error('The publishing installation has changed.'), { statusCode: 409 });

export function hostedPool(connectionString: string, options?: string) {
  const url = URL.parse(connectionString);
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
    || url.pathname.length <= 1 || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode')
    || url.searchParams.getAll('sslmode').length > 1) {
    throw new Error('Use a PostgreSQL URL with a host, user, and database, and only the optional sslmode setting.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const mode = url.searchParams.get('sslmode');
  if (mode !== null && mode !== 'verify-full' && !(mode === 'disable' && loopback)) {
    throw new Error('Hosted PostgreSQL requires verified TLS for remote connections.');
  }
  url.search = '';
  return new pg.Pool({
    connectionString: url.href, options, connectionTimeoutMillis: 5_000, statement_timeout: 8_000,
    ssl: !loopback || mode === 'verify-full' ? { rejectUnauthorized: true } : false
  });
}

export async function prepareHostedStore(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hosted_outlets (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      theme TEXT NOT NULL CHECK (theme IN ('classic', 'photo-led')),
      token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
      version BIGINT,
      items JSONB,
      published_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS hosted_photos (
      outlet TEXT NOT NULL REFERENCES hosted_outlets(slug),
      key TEXT NOT NULL,
      image BYTEA NOT NULL,
      staged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (outlet, key)
    );
    CREATE TABLE IF NOT EXISTS guest_accounts (
      id UUID PRIMARY KEY,
      phone_key TEXT NOT NULL UNIQUE,
      phone_last_four TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guest_phone_challenges (
      id TEXT PRIMARY KEY,
      phone_key TEXT NOT NULL,
      phone_last_four TEXT NOT NULL,
      provider_id TEXT NOT NULL UNIQUE,
      attempts INT NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS guest_phone_challenge_expiry ON guest_phone_challenges (expires_at);
    CREATE TABLE IF NOT EXISTS guest_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES guest_accounts(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS guest_session_expiry ON guest_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS guest_phone_limits (
      key TEXT PRIMARY KEY,
      count INT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS guest_phone_limit_expiry ON guest_phone_limits (expires_at);
    CREATE TABLE IF NOT EXISTS receipt_feedback (
      outlet TEXT NOT NULL REFERENCES hosted_outlets(slug),
      digest TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      feedback_id UUID,
      rating INT CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      received_at TIMESTAMPTZ,
      PRIMARY KEY (outlet, digest)
    );
    CREATE INDEX IF NOT EXISTS receipt_feedback_recent ON receipt_feedback (outlet, received_at DESC) WHERE received_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS outlet_offer_snapshots (
      outlet TEXT PRIMARY KEY REFERENCES hosted_outlets(slug),
      installation UUID NOT NULL,
      version BIGINT NOT NULL,
      offers JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outlet_offer_claims (
      outlet TEXT NOT NULL REFERENCES outlet_offer_snapshots(outlet),
      offer_id TEXT NOT NULL,
      account_id UUID NOT NULL REFERENCES guest_accounts(id),
      title TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      ready BOOLEAN NOT NULL DEFAULT false,
      redeemed BOOLEAN NOT NULL DEFAULT false,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (outlet, offer_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS outlet_offer_pending ON outlet_offer_claims (outlet, claimed_at, code) WHERE NOT ready;
    CREATE INDEX IF NOT EXISTS outlet_offer_account ON outlet_offer_claims (outlet, account_id, claimed_at DESC);
    ALTER TABLE hosted_outlets ADD COLUMN IF NOT EXISTS publication_installation UUID;
  `);
}

export async function stageFeedbackCodes(pool: Pool, slug: string, codes: { digest: string; expiresAt: number }[], lease: PublicationLease = {}) {
  await outletWrite(pool, slug, async client => {
    await client.query(`
      INSERT INTO receipt_feedback (outlet, digest, expires_at)
      SELECT $1, x.digest, to_timestamp(x."expiresAt" / 1000.0)
      FROM jsonb_to_recordset($2::jsonb) AS x(digest TEXT, "expiresAt" BIGINT)
      ON CONFLICT (outlet, digest) DO NOTHING
    `, [slug, JSON.stringify(codes)]);
  }, lease);
}

export async function outletFeedback(pool: Pool, slug: string) {
  const { rows } = await pool.query(`
    SELECT feedback_id AS id, rating, comment, received_at AS "receivedAt" FROM receipt_feedback
    WHERE outlet = $1 AND received_at IS NOT NULL ORDER BY received_at DESC, feedback_id DESC LIMIT 100
  `, [slug]);
  return rows;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest();

export function publicationLease(authorization: string | undefined, installation: unknown): PublicationLease {
  const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return { ...(typeof installation === 'string' ? { installation } : {}), ...(token ? { tokenHash: tokenHash(token) } : {}) };
}

export async function provisionOutlet(pool: Pool, slug: string, name: string, theme: GuestMenuTheme, token: string) {
  if (!new RegExp(outletSlugPattern).test(slug) || !name.trim() || name.length > 100 || name.includes('\0')
    || !['classic', 'photo-led'].includes(theme) || !new RegExp(photoKeyPattern).test(token)) {
    throw new Error('Provide a valid outlet slug, display name, theme, and installation token.');
  }
  await pool.query('INSERT INTO hosted_outlets (slug, name, theme, token_hash) VALUES ($1, $2, $3, $4)',
    [slug, name.trim(), theme, tokenHash(token)]);
}

export async function authenticateOutlet(pool: Pool, slug: string, authorization: string | undefined, installation?: unknown) {
  const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token || !new RegExp(outletSlugPattern).test(slug)
    || (installation !== undefined && (typeof installation !== 'string' || !new RegExp(installationPattern).test(installation)))) return false;
  const { rows } = await pool.query<{ token_hash: Buffer; publication_installation: string | null }>(
    'SELECT token_hash, publication_installation FROM hosted_outlets WHERE slug = $1', [slug]);
  const current = rows[0];
  const stored = current?.token_hash;
  const matches = timingSafeEqual(tokenHash(token), stored ?? Buffer.alloc(32));
  return Boolean(current && matches && (!current.publication_installation || current.publication_installation === installation));
}

export async function outletWrite<T>(pool: Pool, slug: string, write: (client: PoolClient) => Promise<T>, lease?: PublicationLease) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ token_hash: Buffer; publication_installation: string | null }>(
      'SELECT token_hash, publication_installation FROM hosted_outlets WHERE slug = $1 FOR UPDATE', [slug]);
    // Check again under the lock: request authentication can predate a recovery or token rotation.
    // Guest claims omit a lease; every publishing write supplies one, including legacy clients.
    if (lease) {
      const current = rows[0];
      if (!current) throw publicationConflict();
      if ((lease.tokenHash && !timingSafeEqual(lease.tokenHash, current.token_hash))
        || (lease.installation !== undefined && !new RegExp(installationPattern).test(lease.installation))
        || (current.publication_installation && current.publication_installation !== lease.installation)) throw publicationConflict();
      if (!current.publication_installation && lease.installation) {
        const prior = await client.query<{ installation: string }>('SELECT installation FROM outlet_offer_snapshots WHERE outlet = $1', [slug]);
        if (prior.rows[0] && prior.rows[0].installation !== lease.installation) throw publicationConflict();
        await client.query('UPDATE hosted_outlets SET publication_installation = $2 WHERE slug = $1', [slug, lease.installation]);
      }
    }
    const result = await write(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function hasPhoto(pool: Pool, slug: string, key: string) {
  const result = await pool.query('SELECT 1 FROM hosted_photos WHERE outlet = $1 AND key = $2', [slug, key]);
  return result.rowCount === 1;
}

export async function stagePhoto(pool: Pool, slug: string, key: string, image: Buffer, lease: PublicationLease = {}) {
  return outletWrite(pool, slug, async client => {
    const existing = await client.query('SELECT 1 FROM hosted_photos WHERE outlet = $1 AND key = $2', [slug, key]);
    if (existing.rowCount) return true;
    await client.query(`
      DELETE FROM hosted_photos p USING hosted_outlets o
      WHERE p.outlet = $1 AND o.slug = p.outlet AND p.staged_at < now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.items) item WHERE item->>'photoKey' = p.key)
    `, [slug]);
    const { rows } = await client.query<{ size: number }>(
      'SELECT COALESCE(sum(octet_length(image)), 0)::int AS size FROM hosted_photos WHERE outlet = $1', [slug]);
    if ((rows[0]?.size ?? 0) + image.length > photoQuota) return false;
    await client.query('INSERT INTO hosted_photos (outlet, key, image) VALUES ($1, $2, $3)', [slug, key, image]);
    return true;
  }, lease);
}

export async function acceptMenu(pool: Pool, slug: string, version: number, items: GuestMenuItem[], lease: PublicationLease = {}) {
  const json = JSON.stringify(items);
  const keys = [...new Set(items.flatMap(item => item.photoKey ? [item.photoKey] : []))];
  return outletWrite(pool, slug, async client => {
    const { rows } = await client.query<{ version: string | null; identical: boolean }>(
      'SELECT version, items = $2::jsonb AS identical FROM hosted_outlets WHERE slug = $1', [slug, json]);
    const current = rows[0];
    if (!current) return 404;
    if (version === Number(current.version) && current.identical) return 204;
    if (version <= Number(current.version)) return 409;
    const { rowCount } = await client.query('SELECT key FROM hosted_photos WHERE outlet = $1 AND key = ANY($2::text[])', [slug, keys]);
    if (rowCount !== keys.length) return 422;
    await client.query('UPDATE hosted_outlets SET version = $2, items = $3, published_at = clock_timestamp() WHERE slug = $1',
      [slug, version, json]);
    return 204;
  }, lease);
}

export async function publicMenu(pool: Pool, slug: string) {
  const { rows } = await pool.query<{ name: string; theme: GuestMenuTheme; items: GuestMenuItem[]; publishedAt: Date }>(`
    SELECT name, theme, items, published_at AS "publishedAt" FROM hosted_outlets
    WHERE slug = $1 AND published_at IS NOT NULL
  `, [slug]);
  return rows[0];
}

export async function publicPhoto(pool: Pool, slug: string, id: number, key: string) {
  const { rows } = await pool.query<{ image: Buffer }>(`
    SELECT p.image FROM hosted_photos p JOIN hosted_outlets o ON o.slug = p.outlet
    WHERE p.outlet = $1 AND p.key = $3 AND o.items @> jsonb_build_array(jsonb_build_object('id', $2::bigint, 'photoKey', $3::text))
  `, [slug, id, key]);
  return rows[0]?.image;
}

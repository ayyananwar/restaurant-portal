import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GuestMenuItem } from '../shared/contracts.js';
import type { PickupAcceptance, PickupCart, PickupQuote, PickupRequest } from '../shared/online-ordering.js';
import { installationPattern, outletWrite, type PublicationLease } from './database.js';

export class OnlineOrderingError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
const fail = (statusCode: number, message: string) => new OnlineOrderingError(statusCode, message);
const uuid = new RegExp(installationPattern);
export const cleanText = (value: unknown, maximum: number, multiline = false) => typeof value === 'string' && value.length <= maximum
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value)
  && (multiline || !/[\r\n\t]/.test(value));

function validateCart(cart: PickupCart) {
  if (!cart || !cleanText(cart.name, 100) || !cart.name.trim() || !cleanText(cart.notes, 500, true)
    || !Array.isArray(cart.lines) || !cart.lines.length || cart.lines.length > 50
    || cart.lines.some(line => !line || !Number.isSafeInteger(line.menuId) || line.menuId < 1
      || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20 || !cleanText(line.note, 250, true))
    || cart.lines.reduce((sum, line) => sum + line.quantity, 0) > 100
    || new Set(cart.lines.map(line => line.menuId)).size !== cart.lines.length) throw fail(400, 'Review the items and notes before ordering.');
}

async function accountFor(client: Pick<Pool, 'query'>, session: string) {
  const { rows } = await client.query<{ account_id: string }>(
    'SELECT account_id FROM guest_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()', [session]);
  if (!rows[0]) throw fail(401, 'Sign in with your phone to order.');
  return rows[0].account_id;
}

export async function availableChannel(client: PoolClient, slug: string) {
  const { rows } = await client.query<{ installation: string; revision: string; version: string; items: GuestMenuItem[]; now_ms: string }>(`
    SELECT c.installation,c.revision,o.version,o.items,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms
    FROM online_pickup_channels c JOIN hosted_outlets o ON o.slug=c.outlet
    WHERE c.outlet=$1 AND c.enabled AND o.online_pickup_entitled AND c.heartbeat_at>clock_timestamp()-interval '45 seconds'
      AND c.installation=o.publication_installation AND o.published_at IS NOT NULL`, [slug]);
  if (!rows[0]) throw fail(503, 'Online pickup is unavailable. Contact the restaurant or try again later.');
  return rows[0];
}

async function expirePending(client: PoolClient, slug: string, account: string) {
  await client.query(`UPDATE online_pickup_requests SET status='expired',revision=revision+1
    WHERE outlet=$1 AND account_id=$2 AND status IN ('pending_acceptance','awaiting_payment') AND expires_at<=clock_timestamp()`, [slug, account]);
}

// Called by the future authenticated counter connector, never by a guest. A fresh
// heartbeat is necessary even when enabled; a published menu alone cannot accept orders.
export async function syncPickupChannel(pool: Pool, slug: string, revision: number, enabled: boolean, lease: PublicationLease) {
  if (!lease.installation || !uuid.test(lease.installation) || !lease.tokenHash
    || !Number.isSafeInteger(revision) || revision < 1 || typeof enabled !== 'boolean') throw fail(400, 'Invalid online pickup configuration.');
  return outletWrite(pool, slug, async client => {
    if (enabled && !(await client.query('SELECT 1 FROM hosted_outlets WHERE slug=$1 AND online_pickup_entitled', [slug])).rowCount) {
      throw fail(403, 'The online pickup package is not active for this outlet.');
    }
    const result = await client.query(`INSERT INTO online_pickup_channels(outlet,installation,revision,enabled,heartbeat_at)
      VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(outlet) DO UPDATE SET
      installation=excluded.installation,revision=excluded.revision,enabled=excluded.enabled,heartbeat_at=excluded.heartbeat_at
      WHERE online_pickup_channels.installation=excluded.installation
        AND (online_pickup_channels.revision<excluded.revision OR
          (online_pickup_channels.revision=excluded.revision AND online_pickup_channels.enabled=excluded.enabled))
      RETURNING revision`, [slug, lease.installation, revision, enabled]);
    if (!result.rowCount) throw fail(409, 'Online pickup settings changed. Review the current configuration.');
  }, lease);
}

export async function quotePickup(pool: Pool, slug: string, session: string, cart: PickupCart): Promise<PickupQuote> {
  validateCart(cart);
  return outletWrite(pool, slug, async client => {
    const account = await accountFor(client, session);
    const channel = await availableChannel(client, slug);
    await expirePending(client, slug, account);
    if ((await client.query("SELECT 1 FROM online_pickup_requests WHERE outlet=$1 AND account_id=$2 AND status IN ('pending_acceptance','awaiting_payment','recovery_required')", [slug, account])).rowCount) {
      throw fail(409, 'An earlier order still needs payment or restaurant review.');
    }
    const lines = cart.lines.map(line => {
      const item = channel.items.find(item => item.id === line.menuId);
      if (!item?.available) throw fail(409, 'An item is no longer available. Review the menu.');
      return { menuId: item.id, name: item.name, quantity: line.quantity, note: line.note.trim(), unitPaise: item.pricePaise };
    });
    const subtotalPaise = lines.reduce((sum, line) => sum + line.unitPaise * line.quantity, 0);
    if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise < 0 || subtotalPaise > 99_999_999_999) throw fail(400, 'This order exceeds the supported amount.');
    const quote: PickupQuote = { id: randomUUID(), expiresAt: Number(channel.now_ms) + 300_000, name: cart.name.trim(), notes: cart.notes.trim(), lines, subtotalPaise };
    await client.query(`INSERT INTO online_pickup_quotes(id,outlet,account_id,installation,channel_revision,menu_version,snapshot,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0)) ON CONFLICT(outlet,account_id) DO UPDATE SET
      id=excluded.id,installation=excluded.installation,channel_revision=excluded.channel_revision,menu_version=excluded.menu_version,
      snapshot=excluded.snapshot,expires_at=excluded.expires_at`,
    [quote.id, slug, account, channel.installation, channel.revision, channel.version, JSON.stringify(quote), quote.expiresAt]);
    return quote;
  });
}

export type RequestRow = { id: string; quote_id: string; installation: string; revision: string; status: PickupRequest['status'];
  created_at: Date; expires_at: Date; expired: boolean; snapshot: PickupQuote;
  decision: { acceptance?: PickupAcceptance; rejection?: { reason: string; at: number } } | null };
export const requestView = (row: RequestRow): PickupRequest => ({ id: row.id, quote: row.snapshot, revision: Number(row.revision),
  status: ['pending_acceptance','awaiting_payment'].includes(row.status) && row.expired ? 'expired' : row.status,
  createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime(),
  ...(row.decision?.acceptance ? { acceptance: row.decision.acceptance } : {}),
  ...(row.decision?.rejection ? { rejection: row.decision.rejection } : {}) });

export async function submitPickup(pool: Pool, slug: string, session: string, requestId: string, quoteId: string): Promise<PickupRequest> {
  if (!uuid.test(requestId) || !uuid.test(quoteId)) throw fail(400, 'Invalid order request.');
  return outletWrite(pool, slug, async client => {
    const account = await accountFor(client, session);
    const { rows: saved } = await client.query<RequestRow>('SELECT *,expires_at<=clock_timestamp() AS expired FROM online_pickup_requests WHERE outlet=$1 AND account_id=$2 AND request_id=$3', [slug, account, requestId]);
    if (saved[0]) {
      if (saved[0].quote_id !== quoteId) throw fail(409, 'This request was already used for a different review.');
      return requestView(saved[0]);
    }
    const channel = await availableChannel(client, slug);
    const { rows } = await client.query<{ installation: string; channel_revision: string; menu_version: string; snapshot: PickupQuote }>(
      'SELECT * FROM online_pickup_quotes WHERE id=$1 AND outlet=$2 AND account_id=$3 AND expires_at>clock_timestamp()', [quoteId, slug, account]);
    const quote = rows[0];
    if (!quote || quote.installation !== channel.installation || quote.channel_revision !== channel.revision || quote.menu_version !== channel.version) {
      throw fail(409, 'The menu or ordering settings changed, or this review expired. Review your order again.');
    }
    await expirePending(client, slug, account);
    if ((await client.query("SELECT 1 FROM online_pickup_requests WHERE outlet=$1 AND account_id=$2 AND status IN ('pending_acceptance','awaiting_payment','recovery_required')", [slug, account])).rowCount) throw fail(409, 'An earlier order still needs payment or restaurant review.');
    const result = await client.query<RequestRow>(`INSERT INTO online_pickup_requests(id,outlet,account_id,request_id,quote_id,installation,status,snapshot,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'pending_acceptance',$7,clock_timestamp()+interval '10 minutes') RETURNING *,expires_at<=clock_timestamp() AS expired`,
    [randomUUID(), slug, account, requestId, quoteId, channel.installation, JSON.stringify(quote.snapshot)]);
    await client.query('DELETE FROM online_pickup_quotes WHERE id=$1', [quoteId]);
    return requestView(result.rows[0]!);
  });
}

export async function readPickup(pool: Pool, slug: string, session: string, id: string): Promise<PickupRequest> {
  if (!uuid.test(id)) throw fail(400, 'Invalid order request.');
  const account = await accountFor(pool, session);
  const { rows } = await pool.query<RequestRow>('SELECT *,expires_at<=clock_timestamp() AS expired FROM online_pickup_requests WHERE id=$1 AND outlet=$2 AND account_id=$3', [id, slug, account]);
  if (!rows[0]) throw fail(404, 'Order request not found.');
  return requestView(rows[0]);
}

// Recovery is account-scoped and remains available when the counter goes offline.
export async function activePickup(pool: Pool, slug: string, session: string): Promise<PickupRequest | null> {
  const account = await accountFor(pool, session);
  const { rows } = await pool.query<RequestRow>(`SELECT *,expires_at<=clock_timestamp() AS expired
    FROM online_pickup_requests WHERE outlet=$1 AND account_id=$2
      AND (status='recovery_required' OR (status IN ('pending_acceptance','awaiting_payment') AND expires_at>clock_timestamp()))
    ORDER BY created_at DESC LIMIT 1`, [slug, account]);
  return rows[0] ? requestView(rows[0]) : null;
}

export async function pickupPreviewAvailable(pool: Pool, slug: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM online_pickup_channels c JOIN hosted_outlets o ON o.slug=c.outlet
    WHERE c.outlet=$1 AND c.enabled AND o.online_pickup_entitled AND c.installation=o.publication_installation
      AND o.published_at IS NOT NULL AND c.heartbeat_at>clock_timestamp()-interval '45 seconds'
      AND c.pricing->>'testMode'='true' AND c.pricing->>'enabled'='true'`, [slug]);
  return Boolean(result.rowCount);
}

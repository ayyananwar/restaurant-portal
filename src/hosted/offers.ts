import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { OfferClaim, PublicOffer } from '../shared/contracts.js';
import { outletWrite } from './database.js';

export type OfferSync = { installation: string; version: number; offers: PublicOffer[]; ready: string[]; redeemed: string[] };
type ClaimRow = { offerId: string; title: string; code: string; ready: boolean; redeemed: boolean };

const active = (offer: PublicOffer, now: number) => offer.enabled && (offer.expiresAt === null || offer.expiresAt > now);

export async function syncOutletOffers(pool: Pool, slug: string, input: OfferSync) {
  const offers = JSON.stringify(input.offers);
  return outletWrite(pool, slug, async client => {
    const { rows } = await client.query<{ installation: string; version: string; identical: boolean }>(`
      SELECT installation, version, offers = $2::jsonb AS identical FROM outlet_offer_snapshots WHERE outlet = $1
    `, [slug, offers]);
    const prior = rows[0];
    if (prior && (prior.installation !== input.installation || input.version < Number(prior.version)
      || (input.version === Number(prior.version) && !prior.identical))) return;
    if (!prior || input.version > Number(prior.version)) await client.query(`
      INSERT INTO outlet_offer_snapshots (outlet, installation, version, offers) VALUES ($1, $2, $3, $4)
      ON CONFLICT (outlet) DO UPDATE SET version = excluded.version, offers = excluded.offers
    `, [slug, input.installation, input.version, offers]);
    if (input.ready.length) await client.query('UPDATE outlet_offer_claims SET ready = true WHERE outlet = $1 AND code = ANY($2::text[]) AND NOT ready', [slug, input.ready]);
    if (input.redeemed.length) await client.query('UPDATE outlet_offer_claims SET redeemed = true WHERE outlet = $1 AND code = ANY($2::text[]) AND ready AND NOT redeemed', [slug, input.redeemed]);
    const pending = await client.query<{ code: string; offerId: string }>(`
      SELECT code, offer_id AS "offerId" FROM outlet_offer_claims WHERE outlet = $1 AND NOT ready
      ORDER BY claimed_at, code LIMIT 100
    `, [slug]);
    return { claims: pending.rows };
  });
}

export async function readGuestOffers(pool: Pool, slug: string, session: string) {
  const [snapshot, account] = await Promise.all([
    pool.query<{ offers: PublicOffer[] }>('SELECT offers FROM outlet_offer_snapshots WHERE outlet = $1', [slug]),
    pool.query<ClaimRow>(`
      SELECT c.offer_id AS "offerId", c.title, c.code, c.ready, c.redeemed FROM outlet_offer_claims c
      JOIN guest_sessions s ON s.account_id = c.account_id
      WHERE c.outlet = $1 AND s.token_hash = $2 AND s.expires_at > now() ORDER BY c.claimed_at DESC
    `, [slug, session])
  ]);
  const now = Date.now();
  const offers = (snapshot.rows[0]?.offers ?? []).filter(offer => active(offer, now));
  const live = new Set(offers.map(offer => offer.id));
  const claims: OfferClaim[] = account.rows.map(row => {
    const status = row.redeemed ? 'redeemed' : !live.has(row.offerId) ? 'unavailable' : row.ready ? 'ready' : 'waiting';
    return { offerId: row.offerId, title: row.title, status, ...(status === 'ready' ? { code: row.code } : {}) };
  });
  return { offers, claims };
}

export function claimOffer(pool: Pool, slug: string, offerId: string, session: string) {
  return outletWrite(pool, slug, async client => {
    const { rows: accounts } = await client.query<{ account_id: string }>(
      'SELECT account_id FROM guest_sessions WHERE token_hash = $1 AND expires_at > now()', [session]);
    if (!accounts[0]) return 401;
    const { rows } = await client.query<{ offers: PublicOffer[] }>('SELECT offers FROM outlet_offer_snapshots WHERE outlet = $1', [slug]);
    const offer = rows[0]?.offers.find(item => item.id === offerId && active(item, Date.now()));
    if (!offer) return 422;
    await client.query(`
      INSERT INTO outlet_offer_claims (outlet, offer_id, account_id, title, code) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (outlet, offer_id, account_id) DO NOTHING
    `, [slug, offerId, accounts[0].account_id, offer.title, `CL-${randomBytes(8).toString('hex').toUpperCase()}`]);
    return 204;
  });
}

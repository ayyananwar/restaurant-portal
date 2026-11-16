import type { DatabaseSync } from 'node:sqlite';
import type { PublicOffer } from '../shared/contracts.js';
import { readCoupons } from './coupons.js';

type Target = { endpoint: string; token: string };
type IncomingClaim = { code: string; offerId: string };

export async function syncOffers(db: DatabaseSync, target: Target, signal: AbortSignal, send = fetch) {
  db.exec('BEGIN');
  let state: { installation: string; version: number };
  let offers: PublicOffer[];
  let awaiting: { code: string; readyAck: number; redeemed: number }[];
  try {
    state = db.prepare('SELECT installation, version FROM offer_publication WHERE id = 1').get() as typeof state;
    offers = readCoupons(db).flatMap(({ code, publicTitle, discountPaise, minimumPaise, expiresAt, enabled }) =>
      publicTitle ? [{ id: code, title: publicTitle, discountPaise, minimumPaise, expiresAt, enabled }] : []);
    awaiting = db.prepare(`
      SELECT c.code, c.ready_ack AS readyAck, r.claim_code IS NOT NULL AS redeemed
      FROM coupon_claims c LEFT JOIN check_receipts r ON r.claim_code = c.code
      WHERE c.destination = ? AND (c.ready_ack = 0 OR (r.claim_code IS NOT NULL AND c.redemption_ack = 0))
      ORDER BY c.code LIMIT 100
    `).all(target.endpoint) as typeof awaiting;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (!offers.length) return;
  const ready = awaiting.filter(claim => !claim.readyAck).map(claim => claim.code);
  const redeemed = awaiting.filter(claim => claim.redeemed).map(claim => claim.code);
  const response = await send(`${target.endpoint}/offer-sync`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...state, offers, ready, redeemed })
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('The hosted service did not acknowledge offer sync.');
  }
  const { claims } = await response.json() as { claims: IncomingClaim[] };
  if (!Array.isArray(claims) || claims.length > 100 || claims.some(claim =>
    !/^CL-[A-F0-9]{16}$/.test(claim?.code) || !/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(claim?.offerId))) {
    throw new Error('The hosted service returned invalid offer claims.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const add = db.prepare(`
      INSERT INTO coupon_claims (code, offer_code, destination) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING
    `);
    const existing = db.prepare('SELECT offer_code, destination FROM coupon_claims WHERE code = ?');
    for (const claim of claims) {
      if (add.run(claim.code, claim.offerId, target.endpoint).changes) continue;
      const row = existing.get(claim.code);
      if (row?.offer_code !== claim.offerId || row?.destination !== target.endpoint) throw new Error('Conflicting offer claim.');
    }
    const markReady = db.prepare('UPDATE coupon_claims SET ready_ack = 1 WHERE code = ? AND destination = ?');
    const markRedeemed = db.prepare('UPDATE coupon_claims SET redemption_ack = 1 WHERE code = ? AND destination = ?');
    for (const code of ready) markReady.run(code, target.endpoint);
    for (const code of redeemed) markRedeemed.run(code, target.endpoint);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

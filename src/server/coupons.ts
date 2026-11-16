import type { DatabaseSync } from 'node:sqlite';
import type { Coupon, CouponQuote } from '../shared/contracts.js';
import { WorkflowError } from './store.js';

function codeKey(code: string) {
  return code.trim().toUpperCase();
}

const couponColumns = 'code, discount_paise AS discountPaise, minimum_paise AS minimumPaise, expires_at AS expiresAt, enabled, public_title AS publicTitle';
type CouponRow = Omit<Coupon, 'enabled' | 'publicTitle'> & { enabled: number; publicTitle: string | null };
const asCoupon = (row: CouponRow): Coupon => ({ ...row, enabled: row.enabled === 1, publicTitle: row.publicTitle ?? undefined });

function readCoupon(db: DatabaseSync, code: string): Coupon | undefined {
  const row = db.prepare(`
    SELECT ${couponColumns}
    FROM coupons WHERE code = ?
  `).get(code) as CouponRow | undefined;
  return row && asCoupon(row);
}

export function readCoupons(db: DatabaseSync) {
  const rows = db.prepare(`
    SELECT ${couponColumns}
    FROM coupons ORDER BY code
  `).all() as unknown as CouponRow[];
  return rows.map(asCoupon);
}

export function readCouponRedemptions(db: DatabaseSync) {
  const rows = db.prepare(`SELECT coupon_code AS code, count(*) AS count FROM check_receipts
    WHERE coupon_code IS NOT NULL AND payment_method IS NOT NULL GROUP BY coupon_code`).all();
  return Object.fromEntries(rows.map(row => [String(row.code), Number(row.count)]));
}

export function createCoupon(db: DatabaseSync, input: Omit<Coupon, 'enabled'>) {
  const code = codeKey(input.code);
  if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(code)) throw new WorkflowError(400, 'Use 3 to 24 letters, numbers, or hyphens for the code.');
  if (/^CL-[A-F0-9]{16}$/.test(code)) throw new WorkflowError(400, 'Choose a different coupon code.');
  const publicTitle = input.publicTitle?.trim() || undefined;
  if (publicTitle && /[\u0000\uD800-\uDFFF]/u.test(publicTitle)) throw new WorkflowError(400, 'Enter a valid offer title.');
  const unexpired = input.expiresAt === null || input.expiresAt > Date.now();
  if (unexpired) {
    const inserted = db.prepare(`
      INSERT INTO coupons (code, discount_paise, minimum_paise, expires_at, public_title)
      SELECT ?, ?, ?, ?, :title WHERE :title IS NULL OR (SELECT count(*) FROM coupons WHERE public_title IS NOT NULL) < 1000
      ON CONFLICT(code) DO NOTHING
    `).run({ title: publicTitle ?? null }, code, input.discountPaise, input.minimumPaise, input.expiresAt);
    if (inserted.changes) return;
  }
  if (publicTitle && unexpired) throw new WorkflowError(409, 'This outlet reached its public offer limit.');
  const prior = readCoupon(db, code);
  if (prior) {
    if (prior.discountPaise === input.discountPaise && prior.minimumPaise === input.minimumPaise && prior.expiresAt === input.expiresAt
      && prior.publicTitle === publicTitle) return;
    throw new WorkflowError(409, 'This code is already in use. Choose another code.');
  }
  throw new WorkflowError(400, 'Choose an expiry in the future.');
}

export function setCouponEnabled(db: DatabaseSync, code: string, enabled: boolean) {
  if (!db.prepare('UPDATE coupons SET enabled = ? WHERE code = ?').run(enabled ? 1 : 0, code).changes) {
    throw new WorkflowError(404, 'Coupon not found.');
  }
}

export function couponForTotal(db: DatabaseSync, code: string, subtotal: number, destination?: string, now = Date.now()): CouponQuote & { offerCode?: string } {
  const key = codeKey(code);
  const claim = destination && db.prepare(`
    SELECT c.offer_code AS offerCode FROM coupon_claims c LEFT JOIN check_receipts r ON r.claim_code = c.code
    WHERE c.code = ? AND c.destination = ? AND r.claim_code IS NULL
  `).get(key, destination) as { offerCode: string } | undefined;
  const coupon = readCoupon(db, claim ? claim.offerCode : key);
  if (!coupon?.enabled || (coupon.publicTitle && !claim) || (coupon.expiresAt !== null && coupon.expiresAt <= now)) {
    throw new WorkflowError(422, 'This coupon is unavailable. Check the code or ask the owner.');
  }
  if (subtotal <= 0 || subtotal < coupon.minimumPaise) throw new WorkflowError(422, 'This check does not meet the coupon minimum.');
  return { code: key, discountPaise: Math.min(coupon.discountPaise, subtotal), offerCode: claim ? coupon.code : undefined };
}

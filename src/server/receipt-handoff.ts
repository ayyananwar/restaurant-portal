import type { DatabaseSync } from 'node:sqlite';
import type { CheckIdentity, CheckItem, ReceiptRequest } from '../shared/contracts.js';
import { couponForTotal } from './coupons.js';
import { issueFeedbackCode } from './receipt-feedback.js';
import { activeSplit, billableLines, canReleaseCheck, checkVersion, readReceipts, requireCurrentOrder, WorkflowError } from './store.js';

function requireReceiptOrder(db: DatabaseSync, tableId: number | null, orderId: number) {
  if (tableId !== null) return requireCurrentOrder(db, tableId, orderId);
  if (!db.prepare(`SELECT 1 FROM orders o JOIN counter_orders c ON c.order_id=o.id
    WHERE o.id=? AND o.closed_at IS NULL AND c.cancelled_at IS NULL`).get(orderId)) {
    throw new WorkflowError(409, 'This counter order changed. Open its current details.');
  }
}

function receiptSubtotal(db: DatabaseSync, tableId: number | null, request: CheckIdentity) {
  requireReceiptOrder(db, tableId, request.orderId);
  const split = activeSplit(db, request.orderId);
  if ((split?.id ?? null) !== request.splitId) throw new WorkflowError(409, 'The check split changed. Review the current checks.');
  const lines = billableLines(db, request.orderId);
  if (!lines.length || checkVersion(lines) !== request.checkVersion) {
    throw new WorkflowError(409, 'The check changed. Review the items before recording the receipt.');
  }
  if (db.prepare(`
    SELECT 1 FROM dish_changes c JOIN order_lines l ON l.id = c.line_id
    WHERE l.order_id = ? AND c.outcome = 'pending' LIMIT 1
  `).get(request.orderId)) throw new WorkflowError(409, 'Resolve pending dish changes before recording a receipt.');
  const allocation = split ? (JSON.parse(split.checks) as CheckItem[][])[request.checkNumber - 1]
    : request.checkNumber === 1 ? lines.map(line => ({ lineId: line.id, quantity: line.quantity })) : undefined;
  if (!allocation) throw new WorkflowError(404, 'This check is no longer available.');
  const prices = new Map(lines.map(line => [line.id, line.pricePaise]));
  return allocation.reduce((sum, item) => sum + item.quantity * prices.get(item.lineId)!, 0);
}

export function quoteCoupon(db: DatabaseSync, tableId: number | null, request: CheckIdentity & { code: string }, destination?: string) {
  const subtotal = receiptSubtotal(db, tableId, request);
  if (db.prepare('SELECT 1 FROM check_receipts WHERE order_id = ? AND check_number = ?').get(request.orderId, request.checkNumber)) {
    throw new WorkflowError(409, 'This check already has a receipt.');
  }
  const { code, discountPaise } = couponForTotal(db, request.code, subtotal, destination);
  return { code, discountPaise };
}

export function recordReceipt(db: DatabaseSync, tableId: number, actorId: number, request: ReceiptRequest, destination?: string) {
  db.exec('BEGIN IMMEDIATE');
  try {
    recordReceiptInTransaction(db, tableId, actorId, request, destination);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function recordReceiptInTransaction(db: DatabaseSync, tableId: number | null, actorId: number, request: ReceiptRequest, destination?: string) {
  const reference = request.reference.trim();
  if (!reference) throw new WorkflowError(400, 'Enter the official receipt reference.');
  const prior = db.prepare(`
    SELECT split_id, reference, official_total_paise, payment_method, COALESCE(claim_code, coupon_code) AS coupon_code, coupon_discount_paise FROM check_receipts
    WHERE order_id = ? AND check_number = ?
  `).get(request.orderId, request.checkNumber);
  const now = Date.now();
  if (prior) {
    if (prior.split_id !== request.splitId || prior.reference !== reference || prior.official_total_paise !== request.officialTotalPaise
      || (request.coupon && (request.coupon.code !== prior.coupon_code || request.coupon.discountPaise !== prior.coupon_discount_paise))
      || (prior.payment_method !== null && request.paymentMethod !== null && prior.payment_method !== request.paymentMethod)) {
      throw new WorkflowError(409, 'This check already has a different receipt or payment record.');
    }
    if (prior.payment_method === null && request.paymentMethod !== null) {
      requireReceiptOrder(db, tableId, request.orderId);
      db.prepare(`
        UPDATE check_receipts SET payment_method = ?, paid_by = ?, paid_at = ?
        WHERE order_id = ? AND check_number = ?
      `).run(request.paymentMethod, actorId, now, request.orderId, request.checkNumber);
      issueFeedbackCode(db, request.orderId, request.checkNumber, now);
    }
    return;
  }
  const itemTotal = receiptSubtotal(db, tableId, request);
  if (db.prepare('SELECT 1 FROM check_receipts WHERE reference = ?').get(reference)) {
    throw new WorkflowError(409, 'That receipt reference is already recorded. Include the receipt series if applicable.');
  }
  const coupon = request.coupon ? couponForTotal(db, request.coupon.code, itemTotal, destination, now) : undefined;
  if (coupon && coupon.discountPaise !== request.coupon?.discountPaise) {
    throw new WorkflowError(409, 'The coupon amount changed. Check it again before recording the receipt.');
  }
  const paid = request.paymentMethod !== null;
  db.prepare(`
    INSERT INTO check_receipts (
      order_id, split_id, check_number, reference, item_total_paise, official_total_paise,
      recorded_by, recorded_at, payment_method, paid_by, paid_at, coupon_code, coupon_discount_paise, claim_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(request.orderId, request.splitId, request.checkNumber, reference, itemTotal, request.officialTotalPaise,
    actorId, now, request.paymentMethod, paid ? actorId : null, paid ? now : null,
    coupon?.offerCode ?? coupon?.code ?? null, coupon?.discountPaise ?? null, coupon?.offerCode ? coupon.code : null);
  if (paid) issueFeedbackCode(db, request.orderId, request.checkNumber, now);
}

export function releaseTable(db: DatabaseSync, tableId: number, orderId: number, waiterId: number) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare('SELECT closed_by FROM orders WHERE id = ? AND table_id = ? AND closed_at IS NOT NULL').get(orderId, tableId);
    if (prior?.closed_by !== waiterId) {
      const order = requireCurrentOrder(db, tableId, orderId);
      if (order.waiterId !== waiterId) throw new WorkflowError(403, 'Only the assigned waiter can mark this table vacant.');
      const split = activeSplit(db, orderId);
      const count = split ? (JSON.parse(split.checks) as CheckItem[][]).length : 1;
      if (!canReleaseCheck(billableLines(db, orderId), readReceipts(db, orderId), count)) {
        throw new WorkflowError(409, 'All checks must be paid and all remaining dishes ready before releasing the table.');
      }
      db.prepare('UPDATE orders SET closed_at = ?, closed_by = ? WHERE id = ?').run(Date.now(), waiterId, orderId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

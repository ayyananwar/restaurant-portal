import type { DatabaseSync } from 'node:sqlite';
import type { SplitRequest } from '../shared/contracts.js';
import { activeSplit, hasReceipt, requireCurrentOrder, WorkflowError } from './store.js';

export function saveSplit(db: DatabaseSync, tableId: number, actorId: number, request: SplitRequest) {
  const checks = JSON.stringify(request.checks.map(items => [...items].sort((a, b) => a.lineId - b.lineId)));
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare('SELECT order_id, checks FROM order_splits WHERE saved_by = ? AND request_id = ?')
      .get(actorId, request.requestId);
    if (prior) {
      if (prior.order_id !== request.orderId || prior.checks !== checks) {
        throw new WorkflowError(409, 'This request ID was already used for another split.');
      }
      db.exec('COMMIT');
      return;
    }
    requireCurrentOrder(db, tableId, request.orderId);
    if (activeSplit(db, request.orderId)) throw new WorkflowError(409, 'The counter already saved a split for this check.');
    if (hasReceipt(db, request.orderId)) throw new WorkflowError(409, 'A check with a recorded receipt cannot be split.');
    if (db.prepare(`
      SELECT c.id FROM dish_changes c JOIN order_lines l ON l.id = c.line_id
      WHERE l.order_id = ? AND c.outcome = 'pending' LIMIT 1
    `).get(request.orderId)) {
      throw new WorkflowError(409, 'Resolve pending dish changes before splitting this check.');
    }
    const lines = db.prepare('SELECT id, quantity, revision FROM order_lines WHERE order_id = ? AND cancelled_at IS NULL')
      .all(request.orderId) as Array<{ id: number; quantity: number; revision: number }>;
    const revisions = new Map(request.lineVersions.map(line => [line.lineId, line.revision]));
    if (request.lineVersions.length !== lines.length || lines.some(line => revisions.get(line.id) !== line.revision)) {
      throw new WorkflowError(409, 'The order changed while you were splitting it. Review the latest dishes and try again.');
    }
    const remaining = new Map(lines.map(line => [line.id, line.quantity]));
    for (const check of request.checks) {
      const seen = new Set<number>();
      for (const item of check) {
        const quantity = remaining.get(item.lineId);
        if (quantity === undefined || quantity < item.quantity || seen.has(item.lineId)) {
          throw new WorkflowError(409, 'A dish allocation exceeds the available quantity or repeats within one check.');
        }
        seen.add(item.lineId);
        remaining.set(item.lineId, quantity - item.quantity);
      }
    }
    if ([...remaining.values()].some(quantity => quantity !== 0)) {
      throw new WorkflowError(409, 'Allocate every billable item before saving the split.');
    }
    db.prepare('INSERT INTO order_splits (order_id, checks, saved_by, request_id, saved_at) VALUES (?, ?, ?, ?, ?)')
      .run(request.orderId, checks, actorId, request.requestId, Date.now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function reopenSplit(db: DatabaseSync, tableId: number, actorId: number, orderId: number, splitId: number) {
  db.exec('BEGIN IMMEDIATE');
  try {
    requireCurrentOrder(db, tableId, orderId);
    const split = activeSplit(db, orderId);
    if (split && hasReceipt(db, orderId)) throw new WorkflowError(409, 'A split with recorded receipts cannot be reopened.');
    if (split && split.id !== splitId) throw new WorkflowError(409, 'This check has a newer split. Review it before reopening.');
    if (!split && !db.prepare('SELECT id FROM order_splits WHERE id = ? AND order_id = ? AND cleared_at IS NOT NULL').get(splitId, orderId)) {
      throw new WorkflowError(404, 'Split check not found.');
    }
    if (split) db.prepare('UPDATE order_splits SET cleared_by = ?, cleared_at = ? WHERE id = ?').run(actorId, Date.now(), splitId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PrivateFeedback } from '../shared/contracts.js';
import { publicationHeaders } from './publication-headers.js';

type Target = { endpoint: string; token: string };

export function issueFeedbackCode(db: DatabaseSync, orderId: number, checkNumber: number, now: number) {
  const code = randomBytes(8).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
  db.prepare('INSERT INTO receipt_feedback_codes (order_id, check_number, code, expires_at) VALUES (?, ?, ?, ?)')
    .run(orderId, checkNumber, code, now + 14 * 24 * 60 * 60 * 1000);
}

export async function publishFeedbackCodes(db: DatabaseSync, target: Target, signal: AbortSignal, send = fetch) {
  const now = Date.now();
  const pending = db.prepare(`
    UPDATE receipt_feedback_codes SET destination = ? WHERE rowid IN (
      SELECT rowid FROM receipt_feedback_codes WHERE published = 0 AND expires_at > ? AND (destination IS NULL OR destination = ?)
      ORDER BY expires_at, rowid LIMIT 100
    ) RETURNING code, expires_at AS expiresAt
  `).all(target.endpoint, now, target.endpoint) as { code: string; expiresAt: number }[];
  if (!pending.length) return;
  const response = await send(`${target.endpoint}/feedback-codes`, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { ...publicationHeaders(db, target.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes: pending.map(({ code, expiresAt }) => ({
      digest: createHash('sha256').update(code.replaceAll('-', '')).digest('hex'), expiresAt
    })) })
  });
  await response.body?.cancel();
  if (response.status !== 204) throw new Error('The hosted service did not acknowledge feedback codes.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const mark = db.prepare('UPDATE receipt_feedback_codes SET published = 1 WHERE code = ? AND destination = ?');
    for (const { code } of pending) mark.run(code, target.endpoint);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function loadPrivateFeedback(db: DatabaseSync, target: Target, send = fetch): Promise<{ feedback: PrivateFeedback[] }> {
  const response = await send(`${target.endpoint}/feedback`, {
    headers: publicationHeaders(db, target.token), redirect: 'error', signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('The hosted service did not return feedback.');
  }
  return response.json();
}

import type { DatabaseSync } from 'node:sqlite';
import type { ReportPeriod, WaiterActivityReport, WaiterActivityRow } from '../shared/contracts.js';
import { WorkflowError } from './store.js';

const dayMs = 86_400_000;
const outletOffsetMs = 330 * 60_000;
const dateText = (date: Date) => date.toISOString().slice(0, 10);

export function readWaiterActivity(db: DatabaseSync, period: ReportPeriod, selectedDate?: string): WaiterActivityReport {
  // Calendar arithmetic stays in UTC, then the range is shifted to Ranchi midnight.
  const anchorDate = selectedDate ?? dateText(new Date(Date.now() + outletOffsetMs));
  const start = new Date(`${anchorDate}T00:00:00Z`);
  if (!Number.isFinite(start.valueOf()) || dateText(start) !== anchorDate) {
    throw new WorkflowError(400, 'Choose a valid report date.');
  }
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (period === 'month') start.setUTCDate(1);
  const end = new Date(start);
  if (period === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + (period === 'week' ? 7 : 1));

  const rows = db.prepare(`
    WITH activity AS (
      SELECT r.credited_waiter_id AS waiter_id,
        COUNT(DISTINCT r.order_id) AS ordersHandled,
        COUNT(*) AS orderEntries,
        SUM(CASE WHEN json_valid(r.payload) THEN json_extract(r.payload, '$[0]') IS 'paper-live' ELSE 0 END) AS livePaperEntries,
        SUM(CASE WHEN json_valid(r.payload) THEN json_extract(r.payload, '$[0]') IS 'paper-served' ELSE 0 END) AS servedPaperEntries,
        SUM(r.submitted_at IS NULL) AS estimatedEntries
      FROM order_requests r JOIN orders o ON o.id = r.order_id
      WHERE COALESCE(r.submitted_at, o.opened_at) >= ? AND COALESCE(r.submitted_at, o.opened_at) < ?
      GROUP BY r.credited_waiter_id
    )
    SELECT s.id AS waiterId, s.name, s.enabled,
      COALESCE(a.ordersHandled, 0) AS ordersHandled,
      COALESCE(a.orderEntries, 0) AS orderEntries,
      COALESCE(a.livePaperEntries, 0) AS livePaperEntries,
      COALESCE(a.servedPaperEntries, 0) AS servedPaperEntries,
      COALESCE(a.estimatedEntries, 0) AS estimatedEntries
    FROM staff s LEFT JOIN activity a ON s.id = a.waiter_id
    WHERE s.role = 'waiter' AND (s.enabled = 1 OR a.orderEntries > 0)
    ORDER BY ordersHandled DESC, s.name COLLATE NOCASE, s.id
  `).all(start.valueOf() - outletOffsetMs, end.valueOf() - outletOffsetMs) as unknown as
    Array<Omit<WaiterActivityRow, 'enabled'> & { enabled: number }>;

  return {
    period, anchorDate, startDate: dateText(start), endDate: dateText(new Date(end.valueOf() - dayMs)),
    timezone: 'Asia/Kolkata',
    rows: rows.map(row => ({ ...row, enabled: row.enabled === 1 }))
  };
}

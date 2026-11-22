import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { reportPeriods, type ReportPeriod, type WaiterActivityReport } from '../shared/contracts.js';
import { api, message } from './api.js';
import { BarChart3, UsersRound } from 'lucide-react';
import { formatPaise } from './money.js';

const periodNames = { day: 'Day', week: 'Week', month: 'Month' };
const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const numberFormat = new Intl.NumberFormat('en-IN');
const displayDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));

export function WaiterActivity({ onClose }: { onClose: () => void }) {
  const [period, setPeriod] = useState<ReportPeriod>('day');
  const [date, setDate] = useState('');
  const [query, setQuery] = useState<{ period: ReportPeriod; date?: string }>({ period: 'day' });
  const [report, setReport] = useState<WaiterActivityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams({ period: query.period });
    if (query.date) params.set('date', query.date);
    void api<WaiterActivityReport>(`/api/reports/waiter-activity?${params}`).then(result => {
      if (!current) return;
      setReport(result);
      setDate(value => value || result.anchorDate);
    }).catch(error => {
      if (current) setError(message(error));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [query]);

  function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    setQuery({ period, date: date || undefined });
  }

  const estimated = report?.rows.reduce((sum, row) => sum + row.estimatedEntries, 0) ?? 0;
  return <section className="panel activity-report" aria-labelledby="activity-title">
    <div className="table-header">
      <h2 id="activity-title"><span className="staff-icon-tile"><UsersRound aria-hidden="true" /></span>Waiter activity</h2>
      <Button variant="ghost" onClick={onClose}>Back to overview</Button>
    </div>
    <form className="activity-filters" onSubmit={run}>
      <Field>
        <FieldLabel htmlFor="activity-period">Period</FieldLabel>
        <select id="activity-period" value={period} onChange={event => setPeriod(event.target.value as ReportPeriod)}>
          {reportPeriods.map(value => <option key={value} value={value}>{periodNames[value]}</option>)}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="activity-date">Date in period</FieldLabel>
        <Input id="activity-date" type="date" value={date} onChange={event => setDate(event.target.value)} />
      </Field>
      <Button type="submit" disabled={loading}><BarChart3 aria-hidden="true" />{loading ? 'Loading…' : 'Run report'}</Button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {report && <>
      <p className="note" role="status">
        {displayDate(report.startDate)}{report.endDate !== report.startDate ? ` to ${displayDate(report.endDate)}` : ''} · India time
      </p>
      <p className="note">Each order is counted once per waiter. Entries include additional rounds and paper slips.</p>
      {estimated > 0 && <p className="note">Older entries without timestamps use the check’s opening date ({numberFormat.format(estimated)} in this period).</p>}
      {report.rows.length === 0 ? <p className="note">No waiter accounts or activity for this period.</p> :
        <table className="activity-table" aria-label="Activity by waiter">
          <thead><tr><th scope="col">Waiter</th><th scope="col">Orders</th><th scope="col">Entries</th><th scope="col">Paper</th></tr></thead>
          <tbody>
            {report.rows.map(row => <tr key={row.waiterId}>
              <th scope="row">{row.name}{!row.enabled && <Badge variant="secondary">Inactive</Badge>}</th>
              <td>{numberFormat.format(row.ordersHandled)}</td>
              <td>{numberFormat.format(row.orderEntries)}</td>
              <td>{numberFormat.format(row.livePaperEntries + row.servedPaperEntries)}
                {row.livePaperEntries + row.servedPaperEntries > 0 && <span className="note activity-paper">
                  {numberFormat.format(row.livePaperEntries)} live · {numberFormat.format(row.servedPaperEntries)} served
                </span>}
              </td>
            </tr>)}
          </tbody>
        </table>}
      <h3>Counter activity</h3>
      <p className="note">Orders opened in this period, grouped by cashier and service type. Amounts reflect their current receipt and refund records.</p>
      {!report.counter.length ? <p className="note">No counter orders in this period.</p> :
        <ul className="split-summary">{report.counter.map(row => <li key={`${row.cashier}-${row.fulfillment}`}>
          <strong>{row.cashier} · {row.fulfillment === 'takeaway' ? 'Takeaway' : 'Dine-in'}</strong>
          <p>{numberFormat.format(row.orders)} orders · {numberFormat.format(row.cancelled)} cancelled</p>
          <p>Recorded item subtotal · {formatPaise(row.itemTotalPaise)}</p>
          <p>Official receipt amounts · {formatPaise(row.officialTotalPaise)}</p>
          <p>Refunds recorded · {formatPaise(row.refundedPaise)}</p>
          <p>Refunds needed · {formatPaise(row.refundNeededPaise)}</p>
        </li>)}</ul>}
    </>}
  </section>;
}

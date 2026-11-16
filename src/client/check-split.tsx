import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { CheckItem, Table } from '../shared/contracts.js';
import { api, message } from './api.js';
import { formatPaise } from './money.js';
import { ReceiptHandoff } from './receipt-handoff.js';

export function CheckSplit({ table, connected, onRefresh }: {
  table: Table;
  connected: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [count, setCount] = useState(2);
  const [allocation, setAllocation] = useState<Record<number, number[]>>({});
  const [orderSnapshot, setOrderSnapshot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saveRequest = useRef<{ key: string; id: string } | null>(null);
  const splitTrigger = useRef<HTMLButtonElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const lines = table.lines.filter(line => line.status !== 'cancelled');
  const pending = lines.some(line => line.change?.outcome === 'pending');
  const tooManyLines = lines.length > 500;
  const maxChecks = Math.min(8, lines.reduce((sum, line) => sum + line.quantity, 0));
  const byId = new Map(lines.map(line => [line.id, line]));
  const itemTotal = lines.reduce((sum, line) => sum + line.pricePaise * line.quantity, 0);
  const snapshot = JSON.stringify(lines.map(line => [line.id, line.quantity, line.note]));
  const changed = editing && snapshot !== orderSnapshot;
  useEffect(() => {
    if (editing) editorHeading.current?.focus();
  }, [editing]);
  const checks: CheckItem[][] = Array.from({ length: count }, () => []);
  let valid = count <= maxChecks;
  for (const line of lines) {
    const amounts = allocation[line.id]?.slice(0, count - 1) ?? [];
    const remaining = line.quantity - amounts.reduce((sum, amount) => sum + amount, 0);
    if (remaining < 0) valid = false;
    if (remaining > 0) checks[0]?.push({ lineId: line.id, quantity: remaining });
    amounts.forEach((quantity, index) => { if (quantity > 0) checks[index + 1]?.push({ lineId: line.id, quantity }); });
  }
  valid &&= checks.every(check => check.length > 0);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || pending || changed || tooManyLines) return;
    const key = JSON.stringify(checks);
    if (saveRequest.current?.key !== key) saveRequest.current = { key, id: crypto.randomUUID() };
    await run('split', { orderId: table.orderId, checks, requestId: saveRequest.current.id,
      lineVersions: lines.map(line => ({ lineId: line.id, revision: line.revision })) });
  }

  async function run(path: string, body: unknown) {
    if (!table.orderId || busy || !connected) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/tables/${table.id}/${path}`, 'POST', body);
      setEditing(false);
      setReopening(false);
      setAllocation({});
      saveRequest.current = null;
    } catch (error) {
      setError(message(error));
    } finally {
      await onRefresh();
      setBusy(false);
    }
  }

  if (table.splitId !== null) return <section className="split-section" aria-label="Saved split checks">
    <h3>Split checks</h3>
    <ol className="split-summary">
      {table.checks.map((check, index) => <li key={index}>
        <div className="table-header"><strong>Check {index + 1}</strong><span className="amount">{formatPaise(check.totalPaise)}</span></div>
        <ul className="split-items">
          {check.items.map(item => <li key={item.lineId}>{item.quantity} × {byId.get(item.lineId)?.name}</li>)}
        </ul>
        <ReceiptHandoff table={table} checkNumber={index + 1} itemTotal={check.totalPaise}
          connected={connected} onRefresh={onRefresh} />
      </li>)}
    </ol>
    {table.hasReceipt ? <p className="note">Recorded receipts lock these allocations.</p> : reopening ? <>
      <p className="note">Reopening clears this allocation and lets staff change the order again.</p>
      <div className="actions">
        <Button disabled={busy || !connected} onClick={() => void run('split/reopen', { orderId: table.orderId, splitId: table.splitId })}>Confirm reopen</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setReopening(false)}>Go back</Button>
      </div>
    </> : <Button variant="outline" disabled={!connected} onClick={() => setReopening(true)}>Reopen check</Button>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;

  if (!editing || table.hasReceipt) return lines.length ? <>
    {maxChecks >= 2 && !table.hasReceipt && <Button ref={splitTrigger} className="order-trigger" variant="outline" disabled={!connected || pending || tooManyLines}
      onClick={() => { saveRequest.current = null; setOrderSnapshot(snapshot); setCount(2); setEditing(true); }}>Split check</Button>}
    {pending && maxChecks >= 2 && <p className="note">Resolve pending dish changes before splitting.</p>}
    {tooManyLines && <p className="note">This order exceeds the 500-line limit for splitting.</p>}
    <ReceiptHandoff table={table} checkNumber={1} itemTotal={itemTotal} connected={connected} onRefresh={onRefresh} />
  </> : null;

  const total = (items: CheckItem[]) => items.reduce((sum, item) => sum + (byId.get(item.lineId)?.pricePaise ?? 0) * item.quantity, 0);
  return <form className="split-section" onSubmit={save}>
    <h3 ref={editorHeading} tabIndex={-1}>Split by dish quantity</h3>
    <p className="total">Original check total <strong>{formatPaise(itemTotal)}</strong></p>
    <p className="note">Assign quantities to the additional checks. Unassigned portions stay on Check 1.</p>
    <Field>
      <FieldLabel htmlFor={`split-count-${table.id}`}>Number of checks</FieldLabel>
      <select id={`split-count-${table.id}`} value={count} disabled={busy} onChange={event => {
        const next = Number(event.target.value);
        setCount(next);
        setAllocation(values => Object.fromEntries(Object.entries(values).map(([id, amounts]) => [id, amounts.slice(0, next - 1)])));
      }}>
        {Array.from({ length: Math.max(0, maxChecks - 1) }, (_, index) => index + 2).map(value => <option key={value}>{value}</option>)}
      </select>
    </Field>
    <p className="table-header"><strong>Check 1</strong><span className="amount">{formatPaise(total(checks[0] ?? []))}</span></p>
    {checks.slice(1).map((check, index) => <fieldset key={index} className="split-allocation" disabled={busy}>
      <legend>Check {index + 2} · {formatPaise(total(check))}</legend>
      {lines.map(line => {
        const id = `allocation-${line.id}-${index}`;
        const amounts = allocation[line.id] ?? [];
        const maximum = Math.max(0, line.quantity - amounts.reduce((sum, amount, slot) => slot === index ? sum : sum + amount, 0));
        return <Field key={line.id} orientation="horizontal">
          <FieldLabel htmlFor={id}>{line.name} ({line.quantity} total){line.note ? ` · ${line.note}` : ''}</FieldLabel>
          <Input id={id} aria-label={`Quantity of ${line.name} on check ${index + 2}${line.note ? `, ${line.note}` : ''}`}
            type="number" min={0} max={maximum} step={1} required value={amounts[index] ?? 0}
            onChange={event => {
              const value = Number(event.target.value);
              if (!Number.isInteger(value) || value < 0 || value > maximum) return;
              setAllocation(current => ({ ...current, [line.id]: Array.from({ length: count - 1 }, (_, slot) =>
                slot === index ? value : current[line.id]?.[slot] ?? 0) }));
            }} />
        </Field>;
      })}
    </fieldset>)}
    {!valid && <p className="note">Each check needs at least one item, and all quantities must match the order.</p>}
    {pending && <p className="note">Resolve pending dish changes before saving.</p>}
    {changed && <div>
      <p className="error" role="status">The order changed while you were splitting it.</p>
      <Button variant="outline" type="button" disabled={busy || maxChecks < 2} onClick={() => { setAllocation({}); setCount(2); setOrderSnapshot(snapshot); setError(''); }}>
        Restart split with current dishes
      </Button>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <Button type="submit" disabled={!connected || busy || !valid || pending || changed || tooManyLines}>{busy ? 'Saving…' : 'Save split'}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => {
        setEditing(false); setAllocation({}); setError('');
        window.requestAnimationFrame(() => splitTrigger.current?.focus());
      }}>Cancel</Button>
    </div>
  </form>;
}

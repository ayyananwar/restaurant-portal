import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import type { PaperOrderDetails, PaperOrderMode, ServiceState, Table } from '../shared/contracts.js';

export function PaperOrderSetup({ tables, waiters, connected, onStart, onClose }: {
  tables: Table[];
  waiters: ServiceState['waiters'];
  connected: boolean;
  onStart: (tableId: number, paper: PaperOrderDetails) => void;
  onClose: () => void;
}) {
  const [tableId, setTableId] = useState(0);
  const [creditedWaiterId, setCreditedWaiterId] = useState(0);
  const [mode, setMode] = useState<PaperOrderMode | ''>('');
  const heading = useRef<HTMLHeadingElement>(null);
  const table = tables.find(entry => entry.id === tableId);
  const availableTables = tables.filter(entry => entry.splitId === null && !entry.hasReceipt);
  const eligibleTable = availableTables.some(entry => entry.id === tableId);
  const eligibleWaiter = waiters.some(waiter => waiter.id === creditedWaiterId);
  const valid = connected && !!mode && eligibleTable && eligibleWaiter;
  useEffect(() => { heading.current?.focus(); }, []);

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid && mode) onStart(tableId, { mode, creditedWaiterId });
  }

  return <form className="panel paper-order-setup" onSubmit={start} aria-labelledby="paper-setup-title">
    <h2 id="paper-setup-title" ref={heading} tabIndex={-1}>Enter paper order</h2>
    <p className="note">Choose the table, the waiter who handled the slip, and whether the food still needs preparation.</p>
    <Field>
      <FieldLabel htmlFor="paper-table">Table</FieldLabel>
      <select id="paper-table" required value={eligibleTable ? tableId : ''} disabled={!availableTables.length} onChange={event => {
        const id = Number(event.target.value);
        const assigned = availableTables.find(entry => entry.id === id)?.waiter?.id;
        setTableId(id);
        setCreditedWaiterId(waiters.some(waiter => waiter.id === assigned) ? assigned ?? 0 : 0);
      }}>
        <option value="" disabled>Choose a table</option>
        {availableTables.map(entry => <option key={entry.id} value={entry.id}>{entry.label} · {entry.waiter?.name ?? 'Vacant'}</option>)}
      </select>
    </Field>
    {!availableTables.length ? <p className="note" role="status">No tables can accept a paper order right now.</p>
      : tableId > 0 && !eligibleTable && <p className="error" role="status">That table can no longer accept orders. Choose another table.</p>}
    <Field>
      <FieldLabel htmlFor="paper-waiter">Waiter to credit</FieldLabel>
      <select id="paper-waiter" required value={eligibleWaiter ? creditedWaiterId : ''} disabled={!waiters.length}
        onChange={event => setCreditedWaiterId(Number(event.target.value))}>
        <option value="" disabled>Choose a waiter</option>
        {waiters.map(waiter => <option key={waiter.id} value={waiter.id}>{waiter.name}</option>)}
      </select>
    </Field>
    {!waiters.length ? <p className="note" role="status">No enabled waiters are available to credit.</p>
      : creditedWaiterId > 0 && !eligibleWaiter && <p className="error" role="status">That waiter is no longer available. Choose another waiter.</p>}
    {eligibleTable && table?.waiter && <p className="note">The current table stays assigned to {table.waiter.name}.</p>}
    <Field>
      <FieldLabel htmlFor="paper-mode">Paper order type</FieldLabel>
      <select id="paper-mode" required value={mode} onChange={event => setMode(event.target.value as PaperOrderMode)}>
        <option value="" disabled>Choose an order type</option>
        <option value="live">Live · send to kitchen</option>
        <option value="served">Already served · add to check only</option>
      </select>
    </Field>
    <div className="actions">
      <Button type="submit" disabled={!valid}>Choose dishes</Button>
      <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
    </div>
  </form>;
}

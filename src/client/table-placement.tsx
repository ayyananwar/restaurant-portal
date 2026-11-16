import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import type { PlacementRequest, ServiceState, Table } from '../shared/contracts.js';
import { api, message } from './api.js';

export function TablePlacement({ table, tables, waiters, connected, canJoin, onRefresh }: {
  table: Table;
  tables: Table[];
  waiters: ServiceState['waiters'];
  connected: boolean;
  canJoin: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [action, setAction] = useState<PlacementRequest['action'] | null>(null);
  const [selection, setSelection] = useState('');
  const [sourceWaiter, setSourceWaiter] = useState<number>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [lastAction, setLastAction] = useState<PlacementRequest['action'] | null>(null);
  const destinationField = useRef<HTMLSelectElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const freeTables = tables.filter(entry => entry.orderId === null);
  const otherWaiters = waiters.filter(waiter => waiter.id !== table.waiter?.id);
  const joinable = tables.filter(entry => entry.id !== table.id && entry.orderId !== null && entry.splitId === null && !entry.hasReceipt);
  useEffect(() => {
    if (action) destinationField.current?.focus();
  }, [action]);
  if (!table.waiter || table.orderId === null) return null;

  function open(next: PlacementRequest['action']) {
    setLastAction(next);
    setSelection('');
    setError('');
    setSourceWaiter(table.waiter?.id);
    setAction(next);
  }

  function close() {
    setAction(null);
    setError('');
    window.requestAnimationFrame(() => trigger.current?.focus());
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connected || saving || !action || !table.orderId || !selected || sourceChanged || sourceWaiter === undefined) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/tables/${table.id}/placement`, 'POST', {
        orderId: table.orderId, waiterId: sourceWaiter, action, destinationId: selected.id,
        destinationOrderId: action === 'join' ? selected.orderId ?? undefined : undefined
      } satisfies PlacementRequest);
      close();
    } catch (error) {
      setError(message(error));
    } finally {
      await onRefresh();
      setSaving(false);
    }
  }

  if (!action) return <div className="actions">
    {freeTables.length > 0 && <Button ref={lastAction === 'move' ? trigger : undefined} variant="outline" disabled={!connected} onClick={() => open('move')}>Move table</Button>}
    {otherWaiters.length > 0 && <Button ref={lastAction === 'transfer' ? trigger : undefined} variant="outline" disabled={!connected} onClick={() => open('transfer')}>Transfer waiter</Button>}
    {canJoin && table.splitId === null && !table.hasReceipt && joinable.length > 0 &&
      <Button ref={lastAction === 'join' ? trigger : undefined} variant="outline" disabled={!connected} onClick={() => open('join')}>Join tables</Button>}
  </div>;

  const options = action === 'transfer' ? otherWaiters.map(waiter => ({ ...waiter, orderId: null }))
    : (action === 'move' ? freeTables : joinable).map(entry => ({ id: entry.id, name: entry.label, orderId: entry.orderId }));
  const optionValue = (option: (typeof options)[number]) => action === 'join' ? `${option.id}:${option.orderId}` : String(option.id);
  const selected = options.find(option => optionValue(option) === selection);
  const sourceChanged = sourceWaiter !== table.waiter.id || (action === 'join' && (table.splitId !== null || table.hasReceipt));
  const destination = `placement-destination-${table.id}`;
  return <form className="placement-form" onSubmit={save}>
    <p className="note">{action === 'join'
      ? `Join ${table.label} into another open check. The receiving table keeps its waiter.`
      : action === 'move' ? `Move the current check from ${table.label} to a vacant table.`
        : `Transfer ${table.label} from ${table.waiter.name} to another waiter.`}</p>
    <Field>
      <FieldLabel htmlFor={destination}>{action === 'transfer' ? 'Receiving waiter' : 'Destination table'}</FieldLabel>
      <select id={destination} ref={destinationField} required value={selected ? selection : ''} disabled={saving || sourceChanged || !options.length}
        onChange={event => { setSelection(event.target.value); setError(''); }}>
        <option value="" disabled>Choose {action === 'transfer' ? 'a waiter' : 'a table'}</option>
        {options.map(option => <option key={option.id} value={optionValue(option)}>{option.name}</option>)}
      </select>
    </Field>
    {sourceChanged ? <p className="error" role="status">This check changed. Cancel and open the action again to review it.</p>
      : !options.length ? <p className="note" role="status">There are no eligible destinations right now.</p>
        : selection && !selected && <p className="error" role="status">That destination changed. Choose another option.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <Button disabled={!connected || saving || !selected || sourceChanged} type="submit">
        {saving ? 'Saving…' : action === 'move' ? 'Confirm move' : action === 'join' ? 'Confirm join' : 'Confirm transfer'}
      </Button>
      <Button variant="ghost" type="button" disabled={saving} onClick={close}>Cancel</Button>
    </div>
  </form>;
}

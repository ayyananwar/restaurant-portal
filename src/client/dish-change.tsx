import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { DishChangeRequest, OrderLine, Role } from '../shared/contracts.js';
import { api, message, RequestError } from './api.js';

const outcomeLabel = {
  pending: 'Counter approval pending',
  applied: 'Change applied',
  declined: 'Change declined',
  expired: 'Change expired when the dish became ready'
};

export function DishChangeControls({ line, role, canEdit, disabled, onRefresh }: {
  line: OrderLine;
  role: Role;
  canEdit: boolean;
  disabled: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<{ mode: 'edit' | 'cancel'; revision: number; quantity: number; note: string } | null>(null);
  const [retry, setRetry] = useState<DishChangeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = line.change?.outcome === 'pending' ? line.change : null;
  const editable = canEdit && (line.status === 'queued' || line.status === 'preparing');

  function open(mode: 'edit' | 'cancel') {
    setError('');
    setEditor({ mode, revision: line.revision, quantity: line.quantity, note: line.note });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy || disabled) return;
    const values = new FormData(event.currentTarget);
    const request = retry ?? {
      requestId: crypto.randomUUID(),
      revision: editor.revision,
      quantity: editor.mode === 'cancel' ? 0 : Number(values.get('quantity')),
      note: editor.mode === 'cancel' ? editor.note : String(values.get('note'))
    };
    setError('');
    setBusy(true);
    try {
      await api(`/api/dishes/${line.id}/changes`, 'POST', request);
      setEditor(null);
      setRetry(null);
      await onRefresh();
    } catch (error) {
      setRetry(error instanceof RequestError && error.status < 500 ? null : request);
      setError(message(error));
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function resolve(approve: boolean) {
    if (!pending || busy || disabled) return;
    setError('');
    setBusy(true);
    try {
      await api(`/api/dish-changes/${pending.id}`, 'PATCH', { approve });
    } catch (error) {
      setError(message(error));
    } finally {
      await onRefresh();
      setBusy(false);
    }
  }

  if (!line.change && !editable && !editor) return null;
  return <div className="dish-change">
    {line.change && <Badge variant="secondary" data-state={pending ? 'preparing' : undefined} role="status">
      {outcomeLabel[line.change.outcome]}
    </Badge>}
    {pending && <p className="note">
      {pending.quantity === 0 ? 'Requested cancellation.' : `Requested quantity: ${pending.quantity}. ${pending.note ? `Note: ${pending.note}` : 'No note.'}`}
    </p>}
    {pending && role === 'billing' && <div className="actions">
      <Button disabled={busy || disabled} onClick={() => void resolve(true)}>Approve change</Button>
      <Button variant="outline" disabled={busy || disabled} onClick={() => void resolve(false)}>Decline change</Button>
    </div>}
    {editable && !pending && !editor && <div className="actions">
      <Button variant="outline" disabled={disabled} onClick={() => open('edit')}>Change dish</Button>
      <Button variant="ghost" disabled={disabled} onClick={() => open('cancel')}>Cancel dish</Button>
    </div>}
    {editor && <form className="dish-change-form" onSubmit={save}>
      {editor.mode === 'edit' ? <>
        <Field>
          <FieldLabel htmlFor={`edit-quantity-${line.id}`}>Quantity</FieldLabel>
          <Input id={`edit-quantity-${line.id}`} name="quantity" type="number" min={1} max={99}
            defaultValue={editor.quantity} required disabled={busy || !!retry} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`edit-note-${line.id}`}>Note</FieldLabel>
          <Input id={`edit-note-${line.id}`} name="note" maxLength={300} defaultValue={editor.note} disabled={busy || !!retry} />
        </Field>
      </> : <p>Cancel {line.name} from this order?</p>}
      {line.status === 'preparing' && <p className="note">The counter must approve changes after preparation starts.</p>}
      <div className="actions">
        <Button type="submit" variant={editor.mode === 'cancel' ? 'destructive' : 'default'}
          disabled={busy || disabled || (!editable && !retry)}>
          {busy ? 'Saving…' : retry ? 'Retry change' : line.status === 'preparing' ? 'Request approval'
            : editor.mode === 'cancel' ? 'Confirm cancellation' : 'Save change'}
        </Button>
        <Button variant="ghost" type="button" disabled={busy || !!retry} onClick={() => { setEditor(null); setError(''); }}>Go back</Button>
      </div>
    </form>}
    {error && <p className="error" role="alert">{error}{retry ? ' Retry to confirm whether the change was received.' : ''}</p>}
  </div>;
}

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import type { Table } from '../shared/contracts.js';
import { api, message } from './api.js';
import { formatPaise } from './money.js';

export function TableResolution({ table,connected,onRefresh }:{
  table:Table;connected:boolean;onRefresh:()=>Promise<void>;
}) {
  const [quote,setQuote]=useState<{amountPaise:number;version:string}>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function review() {
    if(!table.orderId||!connected||busy) return;
    setBusy(true);setError('');
    try {setQuote(await api(`/api/tables/${table.id}/resolution?orderId=${table.orderId}`));}
    catch(error){setError(message(error));}
    finally {setBusy(false);}
  }
  async function resolve(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!quote||!table.orderId||!connected||busy) return;
    const reason=String(new FormData(event.currentTarget).get('reason'));
    setBusy(true);setError('');
    try {
      await api(`/api/tables/${table.id}/resolution`,'POST',{orderId:table.orderId,version:quote.version,reason});
      await onRefresh();
    } catch(error){setError(message(error));}
    finally {setBusy(false);}
  }
  return <div className="table-resolution">
    {!quote?<Button variant="outline" disabled={busy||!connected} onClick={()=>void review()}>Review unpaid resolution · {table.label}</Button>:
      <form className="menu-editor" onSubmit={resolve}>
        <h3>Owner resolution · {table.label}</h3>
        <p>Outstanding balance · {formatPaise(quote.amountPaise)}</p>
        <p className="note">Uses recorded receipt amounts where available and item totals for unrecorded checks. Confirm this balance against your billing software.</p>
        {quote.amountPaise>0?<>
          <p className="note">Closing this order frees the table and tells the kitchen to stop remaining preparation. The balance and your reason stay in owner resolution history.</p>
          <Field><FieldLabel htmlFor={`resolution-${table.id}`}>Resolution reason</FieldLabel>
            <Input id={`resolution-${table.id}`} name="reason" maxLength={500} required disabled={busy}/></Field>
          <Button type="submit" disabled={busy||!connected}>Record resolution and free table</Button>
        </>:<p className="note">There is no unpaid balance. Use the normal table release workflow.</p>}
        <div className="actions">
          <Button type="button" variant="outline" disabled={busy||!connected} onClick={()=>void review()}>Refresh balance</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={()=>setQuote(undefined)}>Cancel resolution</Button>
        </div>
      </form>}
    {error&&<p className="error" role="alert">{error}</p>}
  </div>;
}

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { BillSnapshot } from '../shared/contracts.js';
import { api, message } from './api.js';
import { BillPrint } from './bill-print.js';

export function BillHistory({ connected }: { connected: boolean }) {
  const [open,setOpen]=useState(false);
  return <details className="panel" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Saved bills and credit notes</summary>
    {open&&<SavedBills connected={connected}/>}
  </details>;
}
function SavedBills({connected}:{connected:boolean}) {
  const [query,setQuery]=useState({search:'',offset:0,revision:0});
  const [result,setResult]=useState<{bills:BillSnapshot[];hasMore:boolean}>();
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    setBusy(true);setError('');
    api<{bills:BillSnapshot[];hasMore:boolean}>(`/api/bills?search=${encodeURIComponent(query.search)}&offset=${query.offset}`)
      .then(data=>{if(active)setResult(data);}).catch(error=>{if(active)setError(message(error));})
      .finally(()=>{if(active)setBusy(false);});
    return ()=>{active=false;};
  },[query]);
  function search(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery({search:String(new FormData(event.currentTarget).get('search')).trim(),offset:0,revision:query.revision+1});
  }
  return <section className="receipt-handoff" aria-label="Saved bill history" aria-busy={busy}>
    <form className="bill-print-controls" onSubmit={search}>
      <Field><FieldLabel htmlFor="bill-search">Search invoice or credit note number</FieldLabel><Input id="bill-search" name="search" maxLength={32} disabled={busy}/></Field>
      <Button type="submit" variant="outline" disabled={busy||!connected}>Search / refresh bills</Button>
    </form>
    {busy?<p role="status">Loading saved bills…</p>:error?<p className="error" role="alert">{error}</p>:<>
      {!result?.bills.length&&<p className="note">No saved built-in bills match this search.</p>}
      {result?.bills.map(bill=><BillPrint key={bill.number} bill={bill}/>)}
    </>}
    <div className="actions"><Button variant="outline" disabled={busy||!connected||query.offset===0} onClick={()=>setQuery({...query,offset:Math.max(0,query.offset-50)})}>Newer bills</Button>
      <Button variant="outline" disabled={busy||!connected||!!error||!result?.hasMore} onClick={()=>setQuery({...query,offset:query.offset+50})}>Older bills</Button>
      {error&&<Button variant="outline" disabled={busy||!connected} onClick={()=>setQuery({...query,revision:query.revision+1})}>Retry loading bills</Button>}</div>
  </section>;
}

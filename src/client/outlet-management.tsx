import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { roles, type Role, type ServiceState } from '../shared/contracts.js';
import { api, message } from './api.js';

type StaffAccount = { id:number; username:string; name:string; role:Role; enabled:number };
const roleNames = { admin:'Owner',billing:'Billing',kitchen:'Kitchen',waiter:'Waiter' };

export function OutletManagement({ service, connected, onRefresh }: {
  service:ServiceState; connected:boolean; onRefresh:()=>Promise<void>;
}) {
  const [staff,setStaff] = useState<StaffAccount[]>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [attempt,setAttempt] = useState(0);
  const [credentials,setCredentials] = useState<{username:string;password:string}>();
  const [resetId,setResetId] = useState<number>();
  useEffect(()=>{
    let current=true;
    void api<{staff:StaffAccount[]}>('/api/outlet/staff').then(result=>{
      if(current) setStaff(result.staff);
    }).catch(error=>{if(current) setError(message(error));});
    return ()=>{current=false;};
  },[attempt]);
  async function run(action:()=>Promise<unknown>) {
    if(busy||!connected) return;
    setBusy(true);setError('');
    try {
      await action();
      setStaff((await api<{staff:StaffAccount[]}>('/api/outlet/staff')).staff);
      await onRefresh();
    } catch(error) {setError(message(error));}
    finally {setBusy(false);}
  }
  function addStaff(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const values=new FormData(form);
    void run(async()=>{
      const result=await api<{username:string;password:string}>('/api/outlet/staff','POST',{
        username:String(values.get('username')).trim().toLowerCase(),name:String(values.get('name')).trim(),role:values.get('role')
      });
      setCredentials(result);form.reset();
    });
  }
  function table(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const values=new FormData(form);
    const id=String(values.get('table'));
    void run(async()=>{
      await api(id?`/api/outlet/tables/${id}`:'/api/outlet/tables',id?'PATCH':'POST',{label:String(values.get('label'))});
      form.reset();
    });
  }
  return <section className="panel" aria-label="Staff and table setup">
    <h2>Staff and table setup</h2>
    <form className="menu-editor" onSubmit={addStaff}>
      <h3>Add staff account</h3>
      <Field><FieldLabel htmlFor="staff-name">Staff name</FieldLabel>
        <Input id="staff-name" name="name" required maxLength={100} disabled={busy}/></Field>
      <Field><FieldLabel htmlFor="staff-username">Staff username</FieldLabel>
        <Input id="staff-username" name="username" required maxLength={32} pattern="[a-z0-9_-]+" autoCapitalize="none" spellCheck={false} disabled={busy}/></Field>
      <Field><FieldLabel htmlFor="staff-role">Staff role</FieldLabel>
        <select id="staff-role" name="role" defaultValue="billing" disabled={busy}>{roles.map(role=><option key={role} value={role}>{roleNames[role]}</option>)}</select></Field>
      <Button type="submit" disabled={busy||!connected}>Create staff account</Button>
    </form>
    {credentials&&<div className="panel" role="status">
      <p>Save these sign-in details privately. They are shown for this action.</p>
      <p>Username <strong>{credentials.username}</strong></p>
      <p className="receipt-reference">Password <code>{credentials.password}</code></p>
      <Button variant="outline" onClick={()=>setCredentials(undefined)}>I have saved the credentials</Button>
    </div>}
    {staff?<ul className="menu-management-list" aria-label="Staff accounts">{staff.map(account=><li key={account.id} className="menu-management-row">
      <strong>{account.name} · {roleNames[account.role]}</strong>
      <p>{account.username} · {account.enabled?'Enabled':'Disabled'}</p>
      {account.id!==service.staff.id&&<div className="actions">
        <Button variant="outline" disabled={busy||!connected} onClick={()=>void run(()=>api(`/api/outlet/staff/${account.id}`,'PATCH',{enabled:!account.enabled}))}>
          {account.enabled?'Disable':'Enable'} {account.username}</Button>
        <Button variant="outline" disabled={busy||!connected} onClick={()=>setResetId(account.id)}>Reset password for {account.username}</Button>
      </div>}
      {resetId===account.id&&<div className="actions">
        <p className="note">Resetting the password signs {account.username} out of all devices.</p>
        <Button disabled={busy||!connected} onClick={()=>void run(async()=>{
          setCredentials(await api(`/api/outlet/staff/${account.id}/password`,'POST',{}));setResetId(undefined);
        })}>Confirm password reset</Button>
        <Button variant="ghost" disabled={busy} onClick={()=>setResetId(undefined)}>Cancel password reset</Button>
      </div>}
    </li>)}</ul>:!error&&<p role="status">Loading staff accounts…</p>}
    <form className="menu-editor" onSubmit={table}>
      <h3>Add or rename a table</h3>
      <Field><FieldLabel htmlFor="setup-table">Table to update</FieldLabel>
        <select id="setup-table" name="table" disabled={busy}>
          <option value="">Add a new table</option>{service.tables.map(table=><option key={table.id} value={table.id}>{table.label}</option>)}
        </select></Field>
      <Field><FieldLabel htmlFor="setup-table-label">Table label</FieldLabel>
        <Input id="setup-table-label" name="label" maxLength={60} required disabled={busy}/></Field>
      <Button type="submit" disabled={busy||!connected}>Save table</Button>
    </form>
    {error&&<div><p className="error" role="alert">{error}</p>
      {!staff&&<Button variant="outline" disabled={busy||!connected} onClick={()=>{setError('');setAttempt(value=>value+1);}}>Reload staff accounts</Button>}
    </div>}
  </section>;
}

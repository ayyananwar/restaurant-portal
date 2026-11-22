import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { message, RequestError } from './api.js';
import { useProtectedEdit } from './edit-lock.js';
import type { ServiceState } from '../shared/contracts.js';
import { api } from './api.js';
import { formatPublicationTime } from './menu-display.js';

export function RecoveryReview({recovery,connected,onRefresh}:{recovery:NonNullable<ServiceState['recovery']>;connected:boolean;onRefresh:()=>Promise<void>}) {
  const [checked,setChecked]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function confirm(event:FormEvent) {
    event.preventDefault();if(busy||!connected||!checked)return;
    setBusy(true);setError('');
    try{await api('/api/outlet/recovery-review','POST',{sourceHash:recovery.sourceHash,restoredAt:recovery.restoredAt,confirmed:true});}
    catch(error){setError(message(error));}
    finally{await onRefresh();setBusy(false);}
  }
  return <form className="billing-settings" onSubmit={confirm} aria-label="Review restored outlet">
    <h3>Review restored outlet</h3>
    <p className="note">Restored {formatPublicationTime(recovery.restoredAt)} IST. Compare restored orders, payments and refunds with the preserved pre-restore copy and external records. Activity after the backup may be missing.</p>
    <Field className="recovery-confirmation"><FieldLabel htmlFor="recovery-confirmation"><input id="recovery-confirmation" type="checkbox" required checked={checked} disabled={busy}
      onChange={event=>setChecked(event.target.checked)}/> I have reconciled the restored orders, payments and refunds.</FieldLabel></Field>
    <Button type="submit" disabled={!checked||busy||!connected}>{busy?'Saving review…':'Record owner review and resume service'}</Button>
    {error&&<p className="error" role="alert">{error}</p>}
  </form>;
}

export function BackupExport({ connected }: { connected: boolean }) {
  const [editing,setEditing]=useState(false);
  const [downloaded,setDownloaded]=useState(false);
  return <section className="billing-settings" aria-label="Outlet backups">
    <h3>Backups</h3>
    <p className="note">Export an encrypted copy of your restaurant’s orders, bills, menu and staff accounts. Save it to a separate device or secure storage; a copy on this PC does not protect against drive loss.</p>
    {editing?<BackupForm connected={connected} onClose={()=>setEditing(false)} onDownloaded={()=>{setDownloaded(true);setEditing(false);}}/>
      :<Button variant="outline" disabled={!connected} onClick={()=>{setDownloaded(false);setEditing(true);}}>Export encrypted backup</Button>}
    {downloaded&&<p className="note" role="status">Download started. Confirm that the .rpb file was saved, then keep a copy away from this PC. Keep its passphrase separately.</p>}
    <p className="note">Restore is an offline Windows task with the service stopped. Outlets linked to hosted offers or publication require coordinated recovery.</p>
  </section>;
}
function BackupForm({connected,onClose,onDownloaded}:{connected:boolean;onClose:()=>void;onDownloaded:()=>void}) {
  useProtectedEdit();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy||!connected)return;
    const form=event.currentTarget;
    const values=new FormData(form);
    const passphrase=String(values.get('passphrase'));
    if(passphrase!==values.get('confirmation')){setError('The two passphrases do not match. Enter them again.');return;}
    setBusy(true);setError('');
    try {
      const response=await fetch('/api/outlet/backup',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({passphrase}),signal:AbortSignal.timeout(120_000)});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new RequestError(response.status,body.error??'The backup could not be created.');}
      const blob=await response.blob();
      const name=/filename="(restaurant-backup-\d+\.rpb)"/.exec(response.headers.get('content-disposition')??'')?.[1];
      if(!name||blob.size<80)throw new Error('Invalid backup response');
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
      window.setTimeout(()=>URL.revokeObjectURL(url),30_000);
      form.reset();onDownloaded();
    }catch(error){setError(message(error));}
    finally{setBusy(false);}
  }
  return <form className="menu-editor" aria-label="Encrypted backup export" onSubmit={save}>
    <FieldGroup>
      <Field><FieldLabel htmlFor="backup-passphrase">Backup passphrase · at least 16 characters</FieldLabel><Input id="backup-passphrase" name="passphrase" type="password"
        autoComplete="new-password" minLength={16} maxLength={256} required disabled={busy}/></Field>
      <Field><FieldLabel htmlFor="backup-confirmation">Repeat backup passphrase</FieldLabel><Input id="backup-confirmation" name="confirmation" type="password"
        autoComplete="new-password" minLength={16} maxLength={256} required disabled={busy}/></Field>
    </FieldGroup>
    <p className="note">We cannot recover a forgotten backup passphrase. Keep it in a password manager or another safe place, separately from this file.</p>
    <div className="actions"><Button type="submit" disabled={busy||!connected}>{busy?'Creating encrypted backup…':'Download backup'}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
    {busy&&<p role="status" className="note">Keep this page open while the database snapshot is encrypted.</p>}
    {error&&<p role="alert" className="error">{error}</p>}
  </form>;
}

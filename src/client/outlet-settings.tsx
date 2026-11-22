import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { serviceModes, type ServiceMode, type ServiceState } from '../shared/contracts.js';
import { api, message } from './api.js';
import { OutletManagement } from './outlet-management.js';

const labels = { table: 'Table service', counter: 'Counter service · pay first', both: 'Table and counter service' };

export function OutletSettings({ service, connected, onRefresh }: {
  service: ServiceState; connected: boolean; onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [managing,setManaging] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !connected) return;
    const mode = String(new FormData(event.currentTarget).get('mode')) as ServiceMode;
    const changePolicy = String(new FormData(event.currentTarget).get('changePolicy'));
    setBusy(true); setError('');
    try {
      await api('/api/outlet/settings', 'PATCH', { mode, revision: service.settings.revision, changePolicy });
      setEditing(false);
    } catch (error) { setError(message(error)); }
    finally { await onRefresh(); setBusy(false); }
  }
  const openCounter = service.counterOrders.filter(order => !['collected','cancelled'].includes(order.status)).length;
  const paidCounter = service.counterOrders.filter(order => order.token).length;
  return <section className="panel outlet-settings" aria-label="Outlet service mode">
    <div className="table-header"><h2>Service mode</h2>
      {!editing && <Button variant="outline" disabled={!connected} onClick={() => setEditing(true)}>Change service mode</Button>}</div>
    <p>{labels[service.settings.mode]}</p>
    {service.settings.mode !== 'counter' && !service.tables.length && <p className="note">Add tables and waiter accounts below before starting table service.</p>}
    <p className="note">Changes after preparation starts · {service.settings.changePolicy === 'approval' ? 'Counter approval required' : 'Blocked'}</p>
    <p className="note">{openCounter} open counter orders · {paidCounter} paid counter orders in the current view</p>
    {editing && <form className="menu-editor" onSubmit={save}>
      <Field><FieldLabel htmlFor="service-mode">Service mode</FieldLabel>
        <select key={service.settings.revision} id="service-mode" name="mode" defaultValue={service.settings.mode} disabled={busy}>
          {serviceModes.map(mode => <option key={mode} value={mode}>{labels[mode]}</option>)}
        </select></Field>
      <Field><FieldLabel htmlFor="change-policy">Changes after preparation starts</FieldLabel>
        <select id="change-policy" name="changePolicy" defaultValue={service.settings.changePolicy} disabled={busy}>
          <option value="approval">Require counter approval</option><option value="blocked">Block changes</option>
        </select></Field>
      <p className="note">Changing mode affects new orders. {service.tables.filter(table => table.orderId !== null).length} table orders and {openCounter} counter orders remain accessible until completed.</p>
      <div className="actions"><Button type="submit" disabled={busy || !connected}>Confirm service mode</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button></div>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    <details onToggle={event=>setManaging(event.currentTarget.open)}>
      <summary className="menu-preview-link">Manage staff and tables</summary>
      {managing&&<OutletManagement service={service} connected={connected} onRefresh={onRefresh}/>}
    </details>
  </section>;
}

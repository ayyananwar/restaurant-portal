import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { BillingProfile } from '../shared/contracts.js';
import { defaultBillingProfile, stateNames } from '../shared/billing.js';
import { api, message } from './api.js';
import { useProtectedEdit } from './edit-lock.js';

export function BillingSettings({ profile = defaultBillingProfile, connected, onRefresh }: {
  profile?: BillingProfile; connected: boolean; onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  return <section className="billing-settings" aria-label="Billing setup">
    <div className="table-header"><h3>Billing setup</h3>{!editing && <Button variant="outline" disabled={!connected} onClick={() => setEditing(true)}>Configure billing</Button>}</div>
    <p className="note">{profile.enabled ? `${profile.legalName} · Built-in billing enabled${profile.testMode ? ' · Test mode' : ''}` : 'External billing handoff. Enable built-in bills after entering your business details.'}</p>
    {editing && <BillingProfileForm profile={profile} connected={connected} onRefresh={onRefresh} onClose={() => setEditing(false)} />}
  </section>;
}

function BillingProfileForm({ profile, connected, onRefresh, onClose }: {
  profile: BillingProfile; connected: boolean; onRefresh: () => Promise<void>; onClose: () => void;
}) {
  const [value, setValue] = useState(profile);
  useProtectedEdit();
  const [rate, setRate] = useState(String(profile.rateBasisPoints / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function change<K extends keyof BillingProfile>(field: K, next: BillingProfile[K]) { setValue(current => ({ ...current, [field]: next })); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !connected) return;
    if (value.taxMode === 'gst' && (!/^\d{1,2}(\.\d{1,2})?$/.test(rate) || Number(rate) <= 0 || Number(rate) > 28)) {
      setError('Enter the applicable GST percentage between 0.01 and 28, with up to two decimal places.'); return;
    }
    setBusy(true); setError('');
    try {
      await api('/api/outlet/billing', 'PUT', { ...value, rateBasisPoints: value.taxMode === 'gst' ? Math.round(Number(rate) * 100) : 0 });
      onClose();
    } catch (error) { setError(message(error)); }
    finally { await onRefresh(); setBusy(false); }
  }
  return <form className="menu-editor billing-profile-form" onSubmit={save}>
    <Field><FieldLabel htmlFor="bill-enabled">Billing availability</FieldLabel><select id="bill-enabled" value={String(value.enabled)} disabled={busy}
      onChange={event => change('enabled', event.target.value === 'true')}><option value="false">External billing only</option><option value="true">Built-in and external billing</option></select></Field>
    <Field><FieldLabel htmlFor="bill-legal-name">Business legal name</FieldLabel><Input id="bill-legal-name" maxLength={150} required={value.enabled}
      value={value.legalName} disabled={busy} onChange={event => change('legalName', event.target.value)} /></Field>
    <Field><FieldLabel htmlFor="bill-address">Business address</FieldLabel><textarea id="bill-address" maxLength={600} required={value.enabled}
      value={value.address} disabled={busy} onChange={event => change('address', event.target.value)} /></Field>
    <Field><FieldLabel htmlFor="bill-state">Business state</FieldLabel><select id="bill-state" value={value.stateCode} disabled={busy}
      onChange={event => change('stateCode', event.target.value)}>{Object.entries(stateNames).sort().map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></Field>
    <Field><FieldLabel htmlFor="bill-tax-mode">Tax treatment</FieldLabel><select id="bill-tax-mode" value={value.taxMode} disabled={busy}
      onChange={event => { change('taxMode', event.target.value as BillingProfile['taxMode']); if (event.target.value === 'none') change('gstin', ''); }}>
      <option value="none">Non-GST customer receipt</option><option value="gst">GST tax invoice</option><option value="composition">Composition · bill of supply</option></select></Field>
    {value.taxMode !== 'none' && <>
      <Field><FieldLabel htmlFor="bill-gstin">Business GSTIN</FieldLabel><Input id="bill-gstin" value={value.gstin} maxLength={15} required={value.enabled}
        disabled={busy} onChange={event => change('gstin', event.target.value.toUpperCase())} /></Field>
      <Field><FieldLabel htmlFor="bill-classification">HSN / SAC classification</FieldLabel><Input id="bill-classification" value={value.classification} maxLength={8} inputMode="numeric"
        required={value.enabled} disabled={busy} onChange={event => change('classification', event.target.value)} /></Field>
    </>}
    {value.taxMode === 'gst' && <>
      <Field><FieldLabel htmlFor="bill-rate">Applicable total GST (%)</FieldLabel><Input id="bill-rate" value={rate} inputMode="decimal" maxLength={5} required={value.enabled}
        disabled={busy} onChange={event => setRate(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="bill-inclusive">Menu price treatment</FieldLabel><select id="bill-inclusive" value={String(value.pricesIncludeTax)} disabled={busy}
        onChange={event => change('pricesIncludeTax', event.target.value === 'true')}><option value="true">Menu prices include GST</option><option value="false">Add GST to menu prices</option></select></Field>
    </>}
    <Field><FieldLabel htmlFor="bill-series">Invoice series · 1–4 letters or numbers</FieldLabel><Input id="bill-series" value={value.series} maxLength={4} pattern="[A-Z0-9]{1,4}" required
      disabled={busy} onChange={event => change('series', event.target.value.toUpperCase())} /></Field>
    <Field><FieldLabel htmlFor="bill-test-mode">Invoice use</FieldLabel><select id="bill-test-mode" value={String(value.testMode)} disabled={busy}
      onChange={event => change('testMode', event.target.value === 'true')}><option value="true">Test · not for customer use</option><option value="false">Customer bills</option></select></Field>
    <p className="note">This version uses one classification and tax rate for the whole bill. Confirm your applicable tax treatment before customer use. Electronic tax reporting and mixed item tax rates are not included.</p>
    <div className="actions"><Button type="submit" disabled={busy || !connected}>{busy ? 'Saving…' : 'Save billing setup'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

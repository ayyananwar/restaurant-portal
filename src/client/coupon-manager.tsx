import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Coupon } from '../shared/contracts.js';
import { api, message } from './api.js';
import { formatPublicationTime } from './menu-display.js';
import { formatPaise, parseRupees } from './money.js';
import { Gift, Plus, Search, Ticket, CircleCheck, UsersRound } from 'lucide-react';

type CouponData = { coupons: Coupon[]; redemptions: Record<string, number> };

export function CouponManager({ connected, onClose, onEditChange }: {
  connected: boolean; onClose: () => void; onEditChange: (editing: boolean) => void;
}) {
  const [data, setData] = useState<CouponData | null>(null);
  const coupons = data?.coupons;
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const stateOf = (coupon: Coupon) => coupon.expiresAt !== null && coupon.expiresAt <= Date.now() ? 'Expired' : coupon.enabled ? 'Active' : 'Paused';
  const results = coupons?.filter(coupon => `${coupon.code} ${coupon.publicTitle ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    (status === 'all' || stateOf(coupon) === status));

  useEffect(() => {
    onEditChange(editing || busy);
  }, [editing, busy, onEditChange]);

  useEffect(() => {
    if (editing) document.getElementById('coupon-code')?.focus();
  }, [editing]);

  function closeEditor() {
    setEditing(false);
    window.requestAnimationFrame(() => {
      const button = document.getElementById('create-coupon');
      if (button instanceof HTMLButtonElement && !button.disabled) button.focus();
      else document.getElementById('coupon-title')?.focus();
    });
  }

  useEffect(() => {
    let current = true;
    void api<CouponData>('/api/coupons').then(result => {
      if (current) setData(result);
    }).catch((error: unknown) => {
      if (current) setError(message(error));
    });
    return () => { current = false; };
  }, [attempt]);

  async function save(action: () => Promise<unknown>, success: string, form?: HTMLFormElement) {
    if (!connected || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setData(await api<CouponData>('/api/coupons'));
      form?.reset();
      if (form) closeEditor();
      setNotice(success);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const discountPaise = parseRupees(String(values.get('discount')));
    const minimumPaise = parseRupees(String(values.get('minimum') || '0'));
    const expiry = String(values.get('expiry') ?? '');
    const expiresAt = expiry ? Date.parse(`${expiry}:00+05:30`) : null;
    if (!discountPaise || minimumPaise === undefined || (expiresAt !== null && !Number.isFinite(expiresAt))) {
      setError('Enter a discount greater than zero, a valid minimum, and an optional expiry.');
      return;
    }
    const code = String(values.get('code'));
    const publicTitle = String(values.get('publicTitle') ?? '').trim();
    void save(() => api('/api/coupons', 'POST', { code, discountPaise, minimumPaise, expiresAt, publicTitle }), 'Coupon saved.', form);
  }

  return <section className="panel menu-catalog coupon-manager" aria-labelledby="coupon-title">
    <div className="table-header">
      <h2 id="coupon-title" tabIndex={-1}><span className="staff-icon-tile"><Gift aria-hidden="true" /></span>Manage dine-in coupons</h2>
      <div className="actions">{coupons && !editing && <Button id="create-coupon" disabled={!connected || busy} onClick={() => {
        setError(''); setNotice(''); setEditing(true);
      }}><Plus aria-hidden="true" />Create coupon</Button>}
      <Button variant="ghost" disabled={editing || busy} onClick={onClose}>Back to overview</Button></div>
    </div>
    <p className="muted">Create a shared code or publish an offer guests can claim after phone sign-in.</p>
    {!coupons ? (error ? <Button variant="outline" disabled={!connected} onClick={() => {
      setError(''); setAttempt(value => value + 1);
    }}>Reload coupons</Button> : <p role="status">Loading coupons…</p>) : <>
      <div className="staff-metrics coupon-metrics">
        <div><Ticket aria-hidden="true" /><span>Total coupons<strong>{coupons.length}</strong></span></div>
        <div><CircleCheck aria-hidden="true" /><span>Active coupons<strong>{coupons.filter(coupon => stateOf(coupon) === 'Active').length}</strong></span></div>
        <div><UsersRound aria-hidden="true" /><span>Total redemptions<strong>{Object.values(data?.redemptions ?? {}).reduce((sum, count) => sum + count, 0)}</strong></span></div>
      </div>
      {editing && <form className="menu-editor" onSubmit={create}>
        <Field><FieldLabel htmlFor="coupon-code">Code</FieldLabel>
          <Input id="coupon-code" name="code" required maxLength={24} minLength={3} placeholder="RANCHI50" disabled={busy} />
        </Field>
        <Field><FieldLabel htmlFor="coupon-discount">Discount (₹)</FieldLabel>
          <Input id="coupon-discount" name="discount" required inputMode="decimal" maxLength={12} disabled={busy} />
        </Field>
        <Field><FieldLabel htmlFor="coupon-minimum">Minimum check (₹, optional)</FieldLabel>
          <Input id="coupon-minimum" name="minimum" inputMode="decimal" maxLength={12} disabled={busy} />
        </Field>
        <Field><FieldLabel htmlFor="coupon-expiry">Expiry (India time, optional)</FieldLabel>
          <Input id="coupon-expiry" name="expiry" type="datetime-local" disabled={busy} />
        </Field>
        <Field><FieldLabel htmlFor="coupon-public-title">Public offer title (optional)</FieldLabel>
          <Input id="coupon-public-title" name="publicTitle" maxLength={100} aria-describedby="coupon-public-hint" disabled={busy} />
        </Field>
        <p id="coupon-public-hint" className="note">Add a title to give each verified guest one claim. Leave it blank for a shared code.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><Button type="submit" disabled={!connected || busy}>{busy ? 'Saving…' : 'Create coupon'}</Button><Button variant="ghost" disabled={busy} onClick={() => { closeEditor(); setError(''); }}>Cancel</Button></div>
      </form>}
      <div className="menu-tools"><div className="staff-search"><Search aria-hidden="true" /><Input id="coupon-search" type="search" aria-label="Search coupons" placeholder="Search coupons by name or code…" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <select aria-label="Coupon status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All status</option><option>Active</option><option>Paused</option><option>Expired</option></select></div>
      {results?.length ? <table className="coupon-table" role="table" aria-label="Dine-in coupons"><thead role="rowgroup"><tr role="row">
        {['Coupon / Code', 'Discount', 'Validity (India time)', 'Redemptions', 'Status', 'Actions'].map(label => <th key={label} scope="col" role="columnheader">{label}</th>)}
      </tr></thead><tbody role="rowgroup">
        {results.map(coupon => {
          const state = stateOf(coupon);
          return <tr key={coupon.code} role="row">
            <th scope="row" role="rowheader"><strong>{coupon.code}</strong>{coupon.publicTitle && <p className="note">Public offer · {coupon.publicTitle}</p>}</th>
            <td role="cell"><span className="coupon-mobile-label" aria-hidden="true">Discount</span><strong>{formatPaise(coupon.discountPaise)} off</strong><p className="note">Min. {formatPaise(coupon.minimumPaise)}</p></td>
            <td role="cell"><span className="coupon-mobile-label" aria-hidden="true">Validity</span>{coupon.expiresAt !== null ? `${formatPublicationTime(coupon.expiresAt)} IST` : 'No expiry'}</td>
            <td role="cell"><span className="coupon-mobile-label" aria-hidden="true">Redemptions</span>{data?.redemptions[coupon.code] ?? 0}</td>
            <td role="cell"><span className="coupon-mobile-label" aria-hidden="true">Status</span><span className="coupon-state" data-state={state === 'Active' ? 'ready' : undefined}>{state}</span></td>
            <td role="cell">{state !== 'Expired' && <Button variant="outline" disabled={!connected || busy || editing}
              aria-label={`${coupon.enabled ? 'Pause' : 'Resume'} coupon ${coupon.code}`}
              onClick={() => void save(() => api(`/api/coupons/${coupon.code}`, 'PATCH', { enabled: !coupon.enabled }),
                coupon.enabled ? 'Coupon paused.' : 'Coupon resumed.')}>
                {coupon.enabled ? 'Pause coupon' : 'Resume coupon'}</Button>}</td>
          </tr>;
        })}
      </tbody></table> : <div className="actions">
        <p className="note" role="status">{coupons.length ? 'No coupons match your filters.' : 'No dine-in coupons yet.'}</p>
        {coupons.length > 0 && <Button variant="outline" onClick={() => {
          setQuery(''); setStatus('all'); document.getElementById('coupon-search')?.focus();
        }}>Clear filters</Button>}
      </div>}
    </>}
    {error && !editing && <p className="error" role="alert">{error}</p>}
    {notice && <p className="note" role="status">{notice}</p>}
  </section>;
}

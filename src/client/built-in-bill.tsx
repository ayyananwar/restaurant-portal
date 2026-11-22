import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { paymentMethods, type BillBuyer, type BillingProfile, type BillQuote, type PaymentMethod } from '../shared/contracts.js';
import { stateNames } from '../shared/billing.js';
import { message } from './api.js';
import { BillDocument } from './bill-print.js';
import { useProtectedEdit } from './edit-lock.js';

export function BuiltInBill({ profile, connected, counter = false, customer = '', onQuote, onIssue, onRefresh, onCancel }: {
  profile: BillingProfile; connected: boolean; counter?: boolean; customer?: string;
  onQuote: (buyer: BillBuyer, coupon: string) => Promise<BillQuote>;
  onIssue: (quote: BillQuote, buyer: BillBuyer, coupon: string, method: PaymentMethod | null, requestId: string) => Promise<unknown>;
  onRefresh: () => Promise<void>; onCancel: () => void;
}) {
  const id = useId();
  useProtectedEdit();
  const [buyer, setBuyer] = useState<BillBuyer>({ name: customer, address: '', gstin: '', placeState: profile.stateCode });
  const [coupon, setCoupon] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [quote, setQuote] = useState<BillQuote>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saved = useRef<{ key: string; id: string } | null>(null);
  function changeBuyer(field: keyof BillBuyer, value: string) {
    setBuyer(current => ({ ...current, [field]: value })); setQuote(undefined); setError('');
  }
  async function preview(event: FormEvent) {
    event.preventDefault();
    if (busy || !connected) return;
    setBusy(true); setError(''); setQuote(undefined);
    try { setQuote(await onQuote(buyer, coupon.trim())); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function issue() {
    if (!quote || busy || !connected || (counter && !method)) return;
    const key = JSON.stringify([quote.reviewHash, buyer, coupon.trim(), method]);
    if (saved.current?.key !== key) saved.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { await onIssue(quote, buyer, coupon.trim(), method || null, saved.current.id); onCancel(); }
    catch (error) { setError(message(error)); }
    finally { await onRefresh(); setBusy(false); }
  }
  return <section className="built-in-bill" aria-label="Create built-in bill">
    <h4>Create bill</h4>
    <p className="note">{profile.legalName} · {profile.taxMode === 'gst' ? `${profile.rateBasisPoints / 100}% GST` : profile.taxMode === 'composition' ? 'Bill of supply' : 'Non-GST receipt'}
      {profile.testMode && ' · Test mode'}. Review before issuing. Issued bills retain their original details.</p>
    <form className="counter-payment" onSubmit={preview}>
      <Field><FieldLabel htmlFor={`${id}-name`}>Customer name (optional)</FieldLabel>
        <Input id={`${id}-name`} value={buyer.name} maxLength={100} disabled={busy} onChange={event => changeBuyer('name', event.target.value)} /></Field>
      <Field><FieldLabel htmlFor={`${id}-address`}>Customer address (optional)</FieldLabel>
        <textarea id={`${id}-address`} value={buyer.address} maxLength={600} disabled={busy} onChange={event => changeBuyer('address', event.target.value)} /></Field>
      {profile.taxMode !== 'none' && <>
        <Field><FieldLabel htmlFor={`${id}-gstin`}>Customer GSTIN (optional)</FieldLabel>
          <Input id={`${id}-gstin`} value={buyer.gstin} maxLength={15} disabled={busy} onChange={event => changeBuyer('gstin', event.target.value.toUpperCase())} /></Field>
        <Field><FieldLabel htmlFor={`${id}-state`}>Place of supply</FieldLabel><select id={`${id}-state`} value={buyer.placeState} disabled={busy}
          onChange={event => changeBuyer('placeState', event.target.value)}>{Object.entries(stateNames).sort().map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></Field>
        <p className="note">Buyer name and address are required for a registered buyer or a GST invoice of ₹50,000 or more.</p>
      </>}
      <Field><FieldLabel htmlFor={`${id}-coupon`}>Coupon code (optional)</FieldLabel>
        <Input id={`${id}-coupon`} value={coupon} maxLength={32} disabled={busy} onChange={event => { setCoupon(event.target.value.toUpperCase()); setQuote(undefined); }} /></Field>
      <Button type="submit" variant="outline" disabled={busy || !connected}>Preview bill</Button>
    </form>
    {quote && <>
      <BillDocument bill={quote.bill} />
      <Field><FieldLabel htmlFor={`${id}-method`}>Payment outcome</FieldLabel><select id={`${id}-method`} value={method} disabled={busy}
        onChange={event => setMethod(event.target.value as PaymentMethod | '')}>
        <option value="">{counter ? 'Choose payment method' : 'Unpaid'}</option>
        {paymentMethods.map(value => <option key={value} value={value}>Paid · {value}</option>)}
      </select></Field>
      <p className="note">{counter ? 'Collect payment before confirming. This saves the bill and sends the order to the kitchen.' : 'This saves and locks this check. Printing or issuing a bill does not charge the customer.'}</p>
      <Button disabled={busy || !connected || (counter && !method)} onClick={() => void issue()}>{busy ? 'Saving…' : counter ? 'Confirm payment and issue bill' : 'Issue bill'}</Button>
    </>}
    <Button variant="ghost" disabled={busy} onClick={onCancel}>Back to receipt options</Button>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

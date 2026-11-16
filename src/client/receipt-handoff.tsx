import { useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { paymentMethods, type CouponQuote, type PaymentMethod, type ReceiptRequest, type Table } from '../shared/contracts.js';
import { api, message } from './api.js';
import { formatPaise, parseRupees } from './money.js';
import { formatPublicationTime } from './menu-display.js';

export function ReceiptHandoff({ table, checkNumber, itemTotal, connected, onRefresh }: {
  table: Table;
  checkNumber: number;
  itemTotal: number;
  connected: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<CouponQuote>();
  const receipt = table.receipts.find(item => item.checkNumber === checkNumber);
  const pending = table.lines.some(line => line.change?.outcome === 'pending');
  const changed = snapshot !== null && snapshot !== table.checkVersion;
  const fieldId = `receipt-${table.id}-${checkNumber}`;

  function close() {
    setSnapshot(null);
    setCode('');
    setCoupon(undefined);
    setError('');
  }

  async function checkCoupon() {
    if (!snapshot || !table.orderId || !connected || busy || pending || changed || !code.trim()) return;
    setBusy(true);
    setError('');
    setCoupon(undefined);
    try {
      setCoupon(await api<CouponQuote>(`/api/tables/${table.id}/coupon-quote`, 'POST', {
        orderId: table.orderId, splitId: table.splitId, checkNumber, checkVersion: snapshot, code
      }));
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !table.orderId || !connected || busy || pending || changed || (code.trim() && !coupon)) return;
    const values = new FormData(event.currentTarget);
    const reference = receipt?.reference ?? String(values.get('reference')).trim();
    const officialTotalPaise = receipt?.officialTotalPaise ?? parseRupees(String(values.get('amount')));
    const paymentMethod = String(values.get('payment') ?? '') as PaymentMethod | '';
    if (!reference || officialTotalPaise === undefined) {
      setError('Enter the receipt reference and a valid amount in rupees, with up to two decimal places.');
      return;
    }
    if (receipt && !paymentMethod) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/tables/${table.id}/receipts`, 'POST', {
        orderId: table.orderId, splitId: table.splitId, checkNumber, checkVersion: snapshot, reference,
        officialTotalPaise, paymentMethod: paymentMethod || null, coupon
      } satisfies ReceiptRequest);
      close();
    } catch (error) {
      setError(message(error));
    } finally {
      await onRefresh();
      setBusy(false);
    }
  }

  return <div className="receipt-handoff">
    {receipt && <div className="table-header">
      <span className="receipt-reference">{receipt.reference} · {formatPaise(receipt.officialTotalPaise)}</span>
      <Badge variant="secondary" data-state={receipt.paymentMethod ? 'ready' : 'preparing'}>
        {receipt.paymentMethod ? `Paid · ${receipt.paymentMethod}` : 'Unpaid'}
      </Badge>
    </div>}
    {receipt?.coupon && <p className="note">Coupon {receipt.coupon.code} · {formatPaise(receipt.coupon.discountPaise)} off</p>}
    {receipt?.feedback && <FeedbackSlip feedback={receipt.feedback} />}
    {snapshot && !receipt?.paymentMethod ? <form className="receipt-handoff" onSubmit={save}>
      {!receipt && <>
        <p className="note">Enter the reference and final amount from the restaurant’s billing software.</p>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-coupon`}>Coupon code (optional)</FieldLabel>
          <Input id={`${fieldId}-coupon`} value={code} maxLength={32} autoComplete="off" disabled={busy}
            onChange={event => { setCode(event.target.value); setCoupon(undefined); setError(''); }} />
        </Field>
        {code.trim() && <Button type="button" variant="outline" disabled={!connected || busy || changed || pending}
          onClick={() => void checkCoupon()}>Check coupon</Button>}
        {coupon && <p className="note" role="status">{coupon.code} saves {formatPaise(coupon.discountPaise)}.
          Items after discount {formatPaise(itemTotal - coupon.discountPaise)}. Apply the discount in your billing software.</p>}
        <Field>
          <FieldLabel htmlFor={`${fieldId}-reference`}>Receipt reference</FieldLabel>
          <Input id={`${fieldId}-reference`} name="reference" required maxLength={100} disabled={busy} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-amount`}>Official total (₹)</FieldLabel>
          <Input id={`${fieldId}-amount`} name="amount" required inputMode="decimal" maxLength={12}
            defaultValue={(itemTotal / 100).toFixed(2)} disabled={busy} />
        </Field>
      </>}
      <Field>
        <FieldLabel htmlFor={`${fieldId}-payment`}>Payment outcome</FieldLabel>
        <select id={`${fieldId}-payment`} name="payment" defaultValue="" required={!!receipt} disabled={busy}>
          <option value="" disabled={!!receipt}>{receipt ? 'Choose payment method' : 'Unpaid'}</option>
          {paymentMethods.map(method => <option key={method} value={method}>Paid · {method}</option>)}
        </select>
      </Field>
      {changed && <p className="error" role="status">The items changed. Close this form and review the check before recording a receipt.</p>}
      <div className="actions">
        <Button type="submit" disabled={!connected || busy || changed || pending || (!!code.trim() && !coupon)}>{busy ? 'Working…' : receipt ? 'Save payment' : 'Save receipt'}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
      </div>
    </form> : !receipt?.paymentMethod && <Button variant="outline" disabled={!connected || pending || !table.checkVersion}
      onClick={() => { setError(''); setSnapshot(table.checkVersion); }}>{receipt ? 'Record payment' : 'Record receipt'}</Button>}
    {pending && <p className="note">Resolve pending dish changes before recording the receipt.</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}

function FeedbackSlip({ feedback }: { feedback: NonNullable<Table['receipts'][number]['feedback']> }) {
  const slip = useRef<HTMLDivElement>(null);
  const expired = feedback.expiresAt <= Date.now();
  function print() {
    if (!slip.current) return;
    slip.current.dataset.printFeedback = 'true';
    try { window.print(); }
    finally { delete slip.current.dataset.printFeedback; }
  }
  return <div className="receipt-feedback" ref={slip}>
    <div className="receipt-feedback-slip">
      <strong>Private feedback code</strong>
      <p className="feedback-code">{feedback.code}</p>
      {feedback.guestUrl && <p>Open the menu and choose <strong>Leave private feedback</strong>.</p>}
      {feedback.guestUrl && <a className="menu-preview-link" href={feedback.guestUrl}>{feedback.guestUrl}</a>}
      <p className="note">{expired ? 'Code expired' : `Use by ${formatPublicationTime(feedback.expiresAt)} IST`}.</p>
      {!expired && !feedback.published && <p className="note">{feedback.guestUrl
        ? 'This code will work after it syncs.' : 'Connect the outlet’s hosted menu to use this code.'}</p>}
    </div>
    {!expired && <Button variant="outline" onClick={print}>Print feedback slip</Button>}
  </div>;
}

export function ReleaseTable({ table, connected, onRefresh }: {
  table: Table;
  connected: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!table.canRelease || table.orderId === null) return null;

  async function release() {
    if (busy || !connected) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/tables/${table.id}/release`, 'POST', { orderId: table.orderId });
      setConfirm(false);
    } catch (error) {
      setError(message(error));
    } finally {
      await onRefresh();
      setBusy(false);
    }
  }

  return <div className="receipt-handoff">
    {confirm ? <>
      <p className="note">Mark {table.label} vacant after the guests leave?</p>
      <div className="actions">
        <Button disabled={!connected || busy} onClick={() => void release()}>{busy ? 'Saving…' : 'Confirm vacancy'}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>Go back</Button>
      </div>
    </> : <Button variant="outline" disabled={!connected} onClick={() => setConfirm(true)}>Mark table vacant</Button>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}

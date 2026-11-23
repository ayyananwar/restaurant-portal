import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { PickupRequest } from '../shared/online-ordering.js';
import { api, RequestError } from './api.js';
import { formatPaise } from './money.js';

const pickupTime = (value: number) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
}).format(value);

export function GuestPickupAcceptance({ outlet, order, onUpdate }: {
  outlet: string; order: PickupRequest; onUpdate: Dispatch<SetStateAction<PickupRequest | null>>;
}) {
  const acceptance = order.acceptance;
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  useEffect(() => {
    if (order.status !== 'awaiting_payment' || order.confirmation) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [order.status, Boolean(order.confirmation)]);
  if (!acceptance) return null;
  const { review, readyAt, paymentExpiresAt } = acceptance;
  const expired = now >= paymentExpiresAt;
  async function confirm() {
    if (running.current || !acceptance || expired) return;
    running.current = true; setBusy(true); setError('');
    try {
      const result = await api<PickupRequest>(`/api/online-pickup/${outlet}/requests/${order.id}/confirmation`, 'PUT', {
        expectedRevision: order.revision, reviewHash: acceptance.review.hash
      });
      onUpdate(previous => previous?.id === result.id && previous.revision <= result.revision ? result : previous);
    } catch (failure) {
      setError(failure instanceof RequestError ? failure.message : 'Confirmation could not be checked. Retry safely or wait for the request status to update.');
    } finally { running.current = false; setBusy(false); }
  }
  return <section className="guest-pickup-review" aria-label="Restaurant final total">
    <h3>Restaurant final total</h3>
    <p>{review.seller.legalName}</p>
    <ul>{review.lines.map(line => <li key={line.menuId}>{line.quantity} × {line.name}: {formatPaise(line.unitPaise * line.quantity)}</li>)}</ul>
    <dl className="guest-pickup-amounts">
      <div><dt>Item subtotal {review.seller.taxMode === 'gst' && (review.seller.pricesIncludeTax ? '(GST included)' : '(before GST)')}</dt><dd>{formatPaise(review.subtotalPaise)}</dd></div>
      {review.seller.taxMode === 'gst' && <div><dt>Taxable amount</dt><dd>{formatPaise(review.amounts.taxablePaise)}</dd></div>}
      {([['CGST', review.amounts.cgstPaise], ['SGST', review.amounts.sgstPaise], ['IGST', review.amounts.igstPaise]] as const).map(([label, amount]) => amount > 0 && <div key={label}><dt>{label}</dt><dd>{formatPaise(amount)}</dd></div>)}
      {review.amounts.roundingPaise !== 0 && <div><dt>Rounding</dt><dd>{formatPaise(review.amounts.roundingPaise)}</dd></div>}
      <div><dt><strong>Final total</strong></dt><dd><strong>{formatPaise(review.amounts.totalPaise)}</strong></dd></div>
    </dl>
    <p>Pickup estimate: {pickupTime(readyAt)} IST</p>
    <p>Payment deadline: {pickupTime(paymentExpiresAt)} IST. Confirmation does not extend this deadline.</p>
    {order.confirmation ? <p role="status">You confirmed this total at {pickupTime(order.confirmation.confirmedAt)} IST. This is not a payment.</p>
      : order.status === 'awaiting_payment' && <>
        <p>{expired ? 'The payment window has ended. Wait for the request status to update.' : 'Check the dishes, taxes, final total and pickup time before confirming.'}</p>
        <button type="button" disabled={busy || expired} onClick={() => void confirm()}>{busy ? 'Confirming total…' : `Confirm total of ${formatPaise(review.amounts.totalPaise)}`}</button>
      </>}
    <p>Payment is unavailable in this test checkout. Food preparation does not start.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}

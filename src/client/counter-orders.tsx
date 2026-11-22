import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { paymentMethods, type CounterDraft, type CounterOrder, type CounterPayment, type CouponQuote, type OrderRequest, type ServiceState, type Table } from '../shared/contracts.js';
import { api, message } from './api.js';
import { formatPaise, parseRupees } from './money.js';
import { OrderComposer } from './order-composer.js';
import { FeedbackSlip } from './receipt-handoff.js';
import { formatPublicationTime } from './menu-display.js';
import type { BillingProfile, BillQuote } from '../shared/contracts.js';
import { BuiltInBill } from './built-in-bill.js';
import { BillPrint } from './bill-print.js';
import { useEditsLocked } from './edit-lock.js';

export const counterStatus = {
  'awaiting-payment': 'Awaiting payment', preparing: 'Preparing', ready: 'Ready',
  collected: 'Collected', cancelled: 'Cancelled'
};

export function CounterOrders({ service, connected, onRefresh, onEditChange }: {
  service: ServiceState; connected: boolean; onRefresh: () => Promise<void>; onEditChange: (editing: boolean) => void;
}) {
  const [stage, setStage] = useState<'list' | 'setup' | 'dishes'>('list');
  const [details, setDetails] = useState<Omit<CounterDraft, keyof OrderRequest>>({
    fulfillment: 'takeaway', customer: '', seating: '', paper: 'none', paperReference: ''
  });
  const [filter, setFilter] = useState('active');
  const editsLocked = useEditsLocked();
  useEffect(() => { onEditChange(stage !== 'list'); }, [stage, onEditChange]);
  useEffect(() => () => onEditChange(false), [onEditChange]);
  const kitchen = service.staff.role === 'kitchen';
  const orders = service.counterOrders.filter(order => kitchen || (filter === 'active'
    ? !['collected','cancelled'].includes(order.status) || (order.refund && !order.refund.reference)
    : filter === 'history' ? ['collected','cancelled'].includes(order.status) : order.status === filter));
  if (stage === 'setup') return <form className="panel paper-order-setup" onSubmit={event => {
    event.preventDefault(); setStage('dishes');
  }}>
    <h2>New counter order</h2>
    <Field><FieldLabel htmlFor="counter-fulfillment">Service type</FieldLabel>
      <select id="counter-fulfillment" value={details.fulfillment} onChange={event => setDetails({ ...details, fulfillment: event.target.value as CounterDraft['fulfillment'] })}>
        <option value="takeaway">Takeaway</option><option value="dine-in">Dine-in</option>
      </select></Field>
    <Field><FieldLabel htmlFor="counter-customer">Customer name (optional)</FieldLabel>
      <Input id="counter-customer" value={details.customer} maxLength={100} onChange={event => setDetails({ ...details, customer: event.target.value })} /></Field>
    <Field><FieldLabel htmlFor="counter-seat">Seating label (optional)</FieldLabel>
      <Input id="counter-seat" value={details.seating} maxLength={60} onChange={event => setDetails({ ...details, seating: event.target.value })} /></Field>
    <Field><FieldLabel htmlFor="counter-paper">Order source</FieldLabel>
      <select id="counter-paper" value={details.paper} onChange={event => setDetails({ ...details, paper: event.target.value as CounterDraft['paper'] })}>
        <option value="none">New order</option><option value="live">Paper order · still needs preparation</option><option value="served">Paper order · already served</option>
      </select></Field>
    {details.paper !== 'none' && <Field><FieldLabel htmlFor="counter-paper-reference">Original paper reference</FieldLabel>
      <Input id="counter-paper-reference" value={details.paperReference} required maxLength={100} onChange={event => setDetails({ ...details, paperReference: event.target.value })} /></Field>}
    <p className="note">Record payment after selecting dishes. The kitchen receives the order after payment is saved.</p>
    <div className="actions"><Button type="submit">Choose dishes</Button><Button type="button" variant="ghost" onClick={() => setStage('list')}>Cancel</Button></div>
  </form>;
  if (stage === 'dishes') {
    const table: Table = { id: -1, label: 'Counter order', orderId: null, waiter: null, lines: [], splitId: null,
      checks: [], checkVersion: null, receipts: [], hasReceipt: false, canRelease: false };
    return <OrderComposer table={table} menu={service.menu} connected={connected} canOrder={service.settings.mode !== 'table'}
      samplePhotos={service.sampleArtwork} onRefresh={onRefresh} onClose={() => setStage('list')}
      counter={{ label: `${details.fulfillment === 'takeaway' ? 'Takeaway' : 'Dine-in'}${details.customer ? ` · ${details.customer}` : ''}`,
        served: details.paper === 'served', onSave: async order => { await api('/api/counter-orders', 'POST', { ...order, ...details }); } }} />;
  }
  return <section className="counter-orders" aria-label="Counter orders">
    <div className="table-header"><h2>{kitchen ? 'Counter kitchen orders' : 'Counter orders'}</h2>
      {!kitchen && <Button id="new-counter-order" disabled={editsLocked || !connected || service.settings.mode === 'table'} onClick={() => {
        setDetails({ fulfillment: 'takeaway', customer: '', seating: '', paper: 'none', paperReference: '' }); setFilter('active'); setStage('setup');
      }}>New counter order</Button>}</div>
    {!kitchen && <div className="actions" role="group" aria-label="Counter order status">
      {[['active','Active'],['awaiting-payment','Awaiting payment'],['preparing','Preparing'],['ready','Ready'],['history','History · last 7 days']].map(([key,label]) =>
        <Button key={key} disabled={editsLocked} variant={filter === key ? 'default' : 'outline'} aria-pressed={filter === key} onClick={() => setFilter(key!)}>{label}</Button>)}
    </div>}
    {!orders.length && <p className="panel muted">No counter orders in this view.</p>}
    <div className="table-grid">{orders.map(order => <CounterCard key={order.id} profile={service.billingProfile} order={order} connected={connected} kitchen={kitchen} onRefresh={onRefresh} />)}</div>
  </section>;
}

function CounterCard({ order, connected, kitchen, onRefresh, profile }: {
  profile?: BillingProfile;
  order: CounterOrder; connected: boolean; kitchen: boolean; onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [coupon, setCoupon] = useState<CouponQuote>();
  const [code, setCode] = useState('');
  const [action, setAction] = useState<'cancel' | 'refund' | 'reduce'>();
  const [printing, setPrinting] = useState(false);
  const [builtIn, setBuiltIn] = useState(false);
  const payment = useRef<{ key: string; input: CounterPayment } | undefined>(undefined);
  const actionRequest = useRef<{ key: string; id: string } | undefined>(undefined);
  useEffect(() => { setError(''); }, [order.revision]);
  useEffect(() => {
    if (!printing) return;
    try { window.print(); } finally { setPrinting(false); }
  }, [printing]);
  async function run(work: () => Promise<unknown>) {
    if (!connected || busy) return;
    setBusy(true); setError('');
    try { await work(); setAction(undefined); }
    catch (error) { setError(message(error)); }
    finally { await onRefresh(); setBusy(false); }
  }
  function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const amount = parseRupees(String(values.get('amount')));
    if (amount === undefined) { setError('Enter a valid official receipt amount.'); return; }
    const input = { revision: order.revision, reference: String(values.get('reference')).trim(), officialTotalPaise: amount,
      paymentMethod: String(values.get('method')) as CounterPayment['paymentMethod'], coupon };
    const key = JSON.stringify(input);
    if (payment.current?.key !== key) payment.current = { key, input: { ...input, requestId: crypto.randomUUID() } };
    const request = payment.current.input;
    void run(() => api(`/api/counter-orders/${order.id}/payment`, 'POST', request));
  }
  function finish(kind: 'collect' | 'cancel' | 'refund' | 'reduce', reason = '', reference = '',
    reduction?: { lineId: number; quantity: number; amountPaise: number }) {
    const input = { revision: order.revision, action: kind, reason, reference, ...reduction };
    const key = JSON.stringify(input);
    if (actionRequest.current?.key !== key) actionRequest.current = { key, id: crypto.randomUUID() };
    const requestId = actionRequest.current.id;
    void run(() => api(`/api/counter-orders/${order.id}/action`, 'POST', { ...input, requestId }));
  }
  return <article className="panel" aria-label={order.token ?? `Unpaid counter order ${order.id}`}>
    <div className="table-header"><h3>{order.token?.split(' ')[1] ?? `Order ${order.id}`}</h3><strong>{counterStatus[order.status]}</strong></div>
    <p className="note">{order.fulfillment === 'takeaway' ? 'Takeaway' : 'Dine-in'}{order.seating && ` · ${order.seating}`}</p>
    {!kitchen && <p className="note">{order.customer && `${order.customer} · `}{order.cashier} · {formatPublicationTime(order.openedAt)} IST</p>}
    {order.paper !== 'none' && <p className="note">Paper · {order.paper === 'served' ? 'Already served' : 'Live'}{order.paperReference && ` · ${order.paperReference}`}</p>}
    <ul className="lines">{order.lines.map(line => <li key={line.id} className="dish">
      <div><strong>{line.quantity} × {line.name}</strong>{line.note && <p className="note">{line.note}</p>}</div>
      <span>{line.status === 'queued' ? 'Queued' : line.status === 'preparing' ? 'In preparation' : line.status === 'ready' ? 'Ready' : 'Cancelled'}</span>
      {kitchen && line.status !== 'ready' && line.status !== 'cancelled' && <div className="actions">
        {line.status === 'queued' && <Button variant="outline" disabled={!connected || busy} onClick={() => void run(() =>
          api(`/api/dishes/${line.id}`, 'PATCH', { status: 'preparing', revision: line.revision }))}>Start preparing</Button>}
        <Button disabled={!connected || busy} onClick={() => void run(() =>
          api(`/api/dishes/${line.id}`, 'PATCH', { status: 'ready', revision: line.revision }))}>Mark ready</Button>
      </div>}
    </li>)}</ul>
    {kitchen && order.corrections.length>0 && <div role="status">
      <h4>Cancellation instructions</h4>
      {order.corrections.map(item=><p key={item.id}>{item.quantity>0?`${item.quantity} × ${item.item}`:'Whole order'} cancelled · {item.reason}</p>)}
    </div>}
    {kitchen && order.status==='cancelled' && <Button disabled={busy||!connected}
      onClick={()=>void run(()=>api(`/api/counter-orders/${order.id}/kitchen-ack`,'POST',{}))}>Acknowledge cancellation</Button>}
    {!kitchen && <>
      <p className="total">Item subtotal <strong>{formatPaise(order.totalPaise)}</strong></p>
      {order.receipts.map(receipt => <div key={receipt.reference} className="receipt-handoff">
        <p>Paid · {receipt.paymentMethod} · {receipt.reference}</p>
        <p>Official receipt amount · {formatPaise(receipt.officialTotalPaise)}</p>
        {receipt.coupon && <p>Coupon {receipt.coupon.code} · {formatPaise(receipt.coupon.discountPaise)} off</p>}
        {receipt.feedback && <FeedbackSlip feedback={receipt.feedback} />}
        {receipt.bill && <BillPrint bill={receipt.bill} />}
      </div>)}
      {order.status === 'awaiting-payment' && <>
        {profile?.enabled && (builtIn ? <BuiltInBill key={order.revision} profile={profile} connected={connected && !busy} counter customer={order.customer}
          onRefresh={onRefresh} onCancel={() => setBuiltIn(false)}
          onQuote={(buyer, couponCode) => api<BillQuote>(`/api/counter-orders/${order.id}/bill-quote`, 'POST', { revision: order.revision, buyer, couponCode })}
          onIssue={(quote, buyer, couponCode, method, requestId) => api(`/api/counter-orders/${order.id}/payment`, 'POST', {
            requestId, revision: order.revision, reference: 'BUILT-IN', officialTotalPaise: quote.bill.totalPaise, paymentMethod: method!,
            builtIn: { reviewHash: quote.reviewHash, buyer, couponCode }
          } satisfies CounterPayment)} /> : <Button variant="outline" disabled={busy || !connected} onClick={() => setBuiltIn(true)}>Create built-in bill</Button>)}
        {(!builtIn || !profile?.enabled) && <>
        <form className="counter-payment" onSubmit={pay}>
          <p className="note">Collect payment through your billing system, then record it here. Check the external receipt before retrying an uncertain payment.</p>
          <Field><FieldLabel htmlFor={`pay-reference-${order.id}`}>Official receipt reference</FieldLabel>
            <Input id={`pay-reference-${order.id}`} name="reference" maxLength={100} required disabled={busy} /></Field>
          <Field><FieldLabel htmlFor={`pay-amount-${order.id}`}>Official receipt amount (₹)</FieldLabel>
            <Input id={`pay-amount-${order.id}`} name="amount" inputMode="decimal" maxLength={12} required disabled={busy} /></Field>
          <Field><FieldLabel htmlFor={`pay-method-${order.id}`}>Payment method</FieldLabel>
            <select id={`pay-method-${order.id}`} name="method" disabled={busy}>{paymentMethods.map(method => <option key={method}>{method}</option>)}</select></Field>
          {coupon && <p role="status">{coupon.code} · {formatPaise(coupon.discountPaise)} off · Item total {formatPaise(order.totalPaise - coupon.discountPaise)}</p>}
          <Button type="submit" disabled={busy || !connected}>{busy ? 'Saving…' : 'Record payment and issue token'}</Button>
        </form>
        <div className="actions">
          <Field><FieldLabel htmlFor={`counter-coupon-${order.id}`}>Coupon code (optional)</FieldLabel>
            <Input id={`counter-coupon-${order.id}`} value={code} maxLength={32} disabled={busy} onChange={event => { setCode(event.target.value); setCoupon(undefined); }} /></Field>
          <Button variant="outline" disabled={busy || !connected || !code.trim()} onClick={() => void run(async () => {
            setCoupon(await api<CouponQuote>(`/api/counter-orders/${order.id}/coupon`, 'POST', { revision: order.revision, code }));
          })}>Check coupon</Button>
        </div></>}
      </>}
      {order.status === 'ready' && <Button disabled={busy || !connected} onClick={() => finish('collect')}>Confirm collected · {order.token?.split(' ')[1]}</Button>}
      {order.token && <Button variant="outline" onClick={() => setPrinting(true)}>Print token</Button>}
      {order.status !== 'cancelled' && !action &&
        <div className="actions">
          <Button variant="ghost" disabled={busy || !connected} onClick={() => setAction('cancel')}>Cancel order</Button>
          {order.token && <Button variant="outline" disabled={busy || !connected} onClick={() => setAction('reduce')}>Cancel some items</Button>}
        </div>}
      {order.corrections.length > 0 && <ul className="split-summary" aria-label="Correction history">{order.corrections.map(item =>
        <li key={item.id}><p>{item.quantity > 0 ? `${item.quantity} × ${item.item}` : 'Order cancellation'} · {item.reason}</p>
          <p>{formatPaise(item.amountPaise)} · {item.reference ? `Refund recorded · ${item.reference}` : 'Refund needed'}</p>
          {item.creditNote && <BillPrint bill={item.creditNote} />}</li>)}</ul>}
      {order.refund && !order.refund.reference && <p className="error">Refund needed · {formatPaise(order.refund.amountPaise)} · {order.refund.reason}</p>}
      {order.refund && !order.refund.reference && !action && <Button variant="outline" disabled={busy || !connected} onClick={() => setAction('refund')}>Record external refund</Button>}
      {action && <form className="counter-payment" onSubmit={event => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        if (action === 'reduce') {
          const amountPaise = parseRupees(String(values.get('refundAmount')));
          if (amountPaise === undefined) { setError('Enter the amount to refund from the official receipt.'); return; }
          finish(action, String(values.get('reason') ?? ''), '', {
            lineId: Number(values.get('lineId')), quantity: Number(values.get('quantity')), amountPaise
          });
        } else finish(action, String(values.get('reason') ?? ''), String(values.get('reference') ?? ''));
      }}>
        <h4>{action === 'cancel' ? `Cancel ${order.token ?? `Order ${order.id}`}` : action === 'reduce' ? 'Cancel paid items' : 'Record external refund'}</h4>
        {action === 'reduce' && <>
          <Field><FieldLabel htmlFor={`reduce-line-${order.id}`}>Dish to cancel</FieldLabel>
            <select id={`reduce-line-${order.id}`} name="lineId" disabled={busy}>{order.lines.filter(line => line.status !== 'cancelled').map(line =>
              <option key={line.id} value={line.id}>{line.name} · {line.quantity} remaining</option>)}</select></Field>
          <Field><FieldLabel htmlFor={`reduce-quantity-${order.id}`}>Quantity to cancel</FieldLabel>
            <Input id={`reduce-quantity-${order.id}`} name="quantity" type="number" min={1} max={99} defaultValue={1} required disabled={busy} /></Field>
          <Field><FieldLabel htmlFor={`reduce-refund-${order.id}`}>Refund amount from official receipt (₹)</FieldLabel>
            <Input id={`reduce-refund-${order.id}`} name="refundAmount" inputMode="decimal" maxLength={12} required disabled={busy} /></Field>
        </>}
        <Field><FieldLabel htmlFor={`counter-action-${order.id}`}>{action !== 'refund' ? 'Cancellation reason' : 'External refund reference'}</FieldLabel>
          <Input id={`counter-action-${order.id}`} name={action !== 'refund' ? 'reason' : 'reference'} maxLength={action !== 'refund' ? 500 : 100} required disabled={busy} /></Field>
        {action === 'cancel' && order.token && <p className="note">The kitchen order will be cancelled. Record any refund through your payment system, then save its reference here.</p>}
        <div className="actions"><Button type="submit" disabled={busy || !connected}>Confirm {action !== 'refund' ? 'cancellation' : 'refund'}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setAction(undefined)}>Go back</Button></div>
      </form>}
      {printing && <div className="counter-token-slip" data-print-counter>
        <h2>Restaurant Portal</h2><h3>{order.token}</h3><p>{order.fulfillment === 'takeaway' ? 'Takeaway' : 'Dine-in'}</p>
        <ul>{order.lines.filter(line=>line.status!=='cancelled').map(line => <li key={line.id}>{line.quantity} × {line.name}</li>)}</ul>
        <p>{counterStatus[order.status]}</p>
      </div>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </article>;
}

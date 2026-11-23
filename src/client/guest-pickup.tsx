import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { GuestMenuItem } from '../shared/contracts.js';
import type { PickupCart, PickupQuote, PickupRequest } from '../shared/online-ordering.js';
import { api, RequestError } from './api.js';
import { formatPaise } from './money.js';
import { GuestPickupAcceptance } from './guest-pickup-acceptance.js';

export const emptyPickupCart = (): PickupCart => ({ name: '', notes: '', lines: [] });
type Availability = { preview: boolean; available: boolean; payments: false };
type Attempt = { requestId: string; quoteId: string };
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export function GuestPickup({ outlet, account, items, cart, setCart, onAvailable, onLocked, onRefreshMenu, onVisible }: {
  outlet: string; account: string | null; items: GuestMenuItem[]; cart: PickupCart;
  setCart: Dispatch<SetStateAction<PickupCart>>; onAvailable: (value: boolean) => void; onLocked: (value: boolean) => void;
  onRefreshMenu: () => void;
  onVisible: (value: boolean) => void;
}) {
  const path = `/api/online-pickup/${outlet}`;
  const storageKey = account ? `pickup-attempt:${outlet}:${account}` : '';
  const [availability, setAvailability] = useState<Availability>();
  const [loaded, setLoaded] = useState(!account);
  const [order, setOrder] = useState<PickupRequest | null>(null);
  const [review, setReview] = useState<{ cart: PickupCart; items: GuestMenuItem[]; quote: PickupQuote }>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const section = useRef<HTMLElement>(null);
  const quote = review?.cart === cart && review.items === items ? review.quote : undefined;
  const active = order && !['expired', 'rejected'].includes(order.status);
  const locked = Boolean(busy || !loaded || attempt || active);

  useEffect(() => { onLocked(locked); }, [locked, onLocked]);
  useEffect(() => { onAvailable(Boolean(availability?.available)); }, [availability?.available, onAvailable]);
  useEffect(() => {
    if (!section.current) { onVisible(false); return; }
    const observer = new IntersectionObserver(([entry]) => onVisible(entry?.isIntersecting ?? false));
    observer.observe(section.current);
    return () => observer.disconnect();
  }, [availability?.preview, Boolean(order), Boolean(attempt), onVisible]);
  useEffect(() => {
    let current = true;
    async function refresh() {
      try { const result = await api<Availability>(`${path}/availability`); if (current) setAvailability(result); }
      catch { if (current) setAvailability(previous => previous ? { ...previous, available: false } : undefined); }
    }
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [path]);

  // Server lookup recovers outstanding requests even when browser storage was cleared.
  useEffect(() => {
    if (!account) return;
    let current = true;
    let retry: number | undefined;
    async function restore() {
      try {
        const result = await api<{ order: PickupRequest | null }>(`${path}/active`);
        if (!current) return;
        setOrder(result.order);
        if (result.order) {
          try { sessionStorage.removeItem(storageKey); } catch { /* The server remains authoritative. */ }
        } else {
          try {
            const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
            if (saved && typeof saved === 'object' && 'requestId' in saved && 'quoteId' in saved
              && typeof saved.requestId === 'string' && uuid.test(saved.requestId)
              && typeof saved.quoteId === 'string' && uuid.test(saved.quoteId)) setAttempt({ requestId: saved.requestId, quoteId: saved.quoteId });
          } catch { /* No recoverable local attempt. */ }
        }
        setLoaded(true); setError('');
      } catch (failure) {
        if (current) { setError(message(failure)); retry = window.setTimeout(() => void restore(), 15_000); }
      }
    }
    void restore();
    return () => { current = false; window.clearTimeout(retry); };
  }, [account, path, storageKey]);

  useEffect(() => {
    if (!order || !active) return;
    let current = true;
    let polling = false;
    const timer = window.setInterval(() => {
      if (document.hidden || polling) return;
      polling = true;
      void api<PickupRequest>(`${path}/requests/${order.id}`).then(result => {
        if (current) { setOrder(previous => previous && previous.revision > result.revision ? previous : result); setError(''); }
      }).catch(failure => { if (current) setError(message(failure)); }).finally(() => { polling = false; });
    }, 5_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [path, order?.id, Boolean(active)]);

  function message(failure: unknown) { return failure instanceof RequestError ? failure.message : 'Check your connection and try again.'; }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(message(failure)); }
    finally { running.current = false; setBusy(false); }
  }
  async function send(saved: Attempt) {
    setAttempt(saved);
    // Save identifiers only, before sending. Never persist the customer's name or notes.
    try { sessionStorage.setItem(storageKey, JSON.stringify(saved)); }
    catch { throw new RequestError(503, 'Browser storage is unavailable. Enable site storage before sending your request.'); }
    try {
      const result = await api<PickupRequest>(`${path}/requests`, 'POST', saved);
      setOrder(result); setAttempt(undefined); setReview(undefined);
      try { sessionStorage.removeItem(storageKey); } catch { /* The server has confirmed the request. */ }
      heading.current?.focus();
    } catch (failure) {
      // A timeout may follow a committed order: retain the exact request identity.
      if (failure instanceof RequestError && [400, 401, 403, 409, 415].includes(failure.status)) {
        setAttempt(undefined); setReview(undefined);
        try { sessionStorage.removeItem(storageKey); } catch { /* Already recorded server-side if committed. */ }
        const recovered = await api<{ order: PickupRequest | null }>(`${path}/active`);
        if (recovered.order) { setOrder(recovered.order); return; }
      }
      throw failure;
    }
  }

  if (!availability?.preview && !order && !attempt) return null;
  return <section ref={section} className="guest-account guest-pickup" aria-labelledby="pickup-heading">
    <h2 id="pickup-heading" ref={heading} tabIndex={-1}>Pickup order</h2>
    <p className="guest-pickup-notice">Test checkout · No payment is taken and food preparation does not start.</p>
    {!account ? <p>Sign in with your phone above to request pickup.</p> : !loaded ? <p role="status">Checking for an earlier request…</p> : null}
    {error && <p role="alert">{error}</p>}
    {order ? <div className="guest-pickup-status" aria-live="polite">
      <h3>{order.status === 'pending_acceptance' ? 'Waiting for restaurant acceptance' : order.status === 'awaiting_payment' ? 'Restaurant accepted · payment unavailable'
        : order.status === 'recovery_required' ? 'Restaurant review needed' : order.status === 'rejected' ? 'Restaurant declined the request' : 'Request expired'}</h3>
      <p>Request {order.id.slice(0, 8)} · {order.quote.name}</p>
      <ul>{order.quote.lines.map(line => <li key={line.menuId}>{line.quantity} × {line.name}{line.note && <p>{line.note}</p>}</li>)}</ul>
      {order.quote.notes && <p>{order.quote.notes}</p>}
      <p>Original item estimate: <strong>{formatPaise(order.quote.subtotalPaise)}</strong></p>
      {order.acceptance && <GuestPickupAcceptance key={order.id} outlet={outlet} order={order} onUpdate={setOrder} />}
      {order.rejection && <p>{order.rejection.reason}</p>}
      {order.status === 'recovery_required' && <p>Contact the restaurant. Do not place another request until this is resolved.</p>}
      {!active && <button type="button" onClick={() => { setOrder(null); setCart(emptyPickupCart()); setReview(undefined); heading.current?.focus(); }}>Start a new pickup order</button>}
    </div> : attempt ? <>
      <p>The last submission needs confirmation. Retry safely using the same request; do not create another order.</p>
      <button type="button" disabled={busy} onClick={() => void run(() => send(attempt))}>{busy ? 'Checking request…' : 'Check or retry request'}</button>
    </> : <>
      {!availability?.available && <p>Online pickup is currently unavailable. Your draft stays here while this page is open.</p>}
      <button type="button" disabled={locked} onClick={onRefreshMenu}>Refresh menu</button>
      {!cart.lines.length ? <p>Choose dishes from the menu below.</p> : <form className="guest-pickup-form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          if (!account || !loaded) return;
          if (quote) {
            if (quote.expiresAt <= Date.now()) { setReview(undefined); throw new RequestError(409, 'This review expired. Review current prices again.'); }
            await send({ requestId: crypto.randomUUID(), quoteId: quote.id });
          } else setReview({ cart, items, quote: await api<PickupQuote>(`${path}/quote`, 'POST', cart) });
        });
      }}>
        <fieldset disabled={locked}><legend>Your items</legend>
          <ul className="guest-pickup-lines">{cart.lines.map(line => {
            const item = items.find(item => item.id === line.menuId);
            return <li key={line.menuId}>
              <h3>{item?.name ?? 'Removed dish'}</h3>
              {!item?.available && <p>This dish is unavailable. Remove it to continue.</p>}
              <div className="guest-account-row">
                <label htmlFor={`pickup-quantity-${line.menuId}`}>Quantity</label>
                <select id={`pickup-quantity-${line.menuId}`} value={line.quantity} onChange={event => setCart(previous => ({ ...previous, lines: previous.lines.map(saved => saved.menuId === line.menuId ? { ...saved, quantity: Number(event.target.value) } : saved) }))}>
                  {Array.from({ length: 20 }, (_, index) => <option key={index + 1}
                    disabled={cart.lines.reduce((sum, saved) => sum + saved.quantity, 0) - line.quantity + index + 1 > 100}>{index + 1}</option>)}
                </select>
                <button type="button" aria-label={`Remove ${item?.name ?? 'dish'}`} onClick={() => setCart(previous => ({ ...previous, lines: previous.lines.filter(saved => saved.menuId !== line.menuId) }))}>Remove</button>
              </div>
              <label htmlFor={`pickup-note-${line.menuId}`}>Notes for {item?.name ?? 'this dish'}</label>
              <textarea id={`pickup-note-${line.menuId}`} rows={2} maxLength={250} value={line.note} onChange={event => setCart(previous => ({ ...previous, lines: previous.lines.map(saved => saved.menuId === line.menuId ? { ...saved, note: event.target.value } : saved) }))} />
            </li>;
          })}</ul>
          <label htmlFor="pickup-name">Name for collection</label>
          <input id="pickup-name" autoComplete="given-name" required maxLength={100} value={cart.name} onChange={event => setCart(previous => ({ ...previous, name: event.target.value }))} />
          <label htmlFor="pickup-notes">Order notes (optional)</label>
          <textarea id="pickup-notes" rows={2} maxLength={500} value={cart.notes} onChange={event => setCart(previous => ({ ...previous, notes: event.target.value }))} />
        </fieldset>
        {quote && <div className="guest-pickup-review" aria-live="polite">
          <h3>Current menu prices</h3>
          <ul>{quote.lines.map(line => <li key={line.menuId}>{line.quantity} × {line.name}: {formatPaise(line.unitPaise * line.quantity)}</li>)}</ul>
          <p>Item subtotal: <strong>{formatPaise(quote.subtotalPaise)}</strong></p>
          <p>The restaurant will confirm availability, taxes, the final total and pickup time before payment.</p>
        </div>}
        <button type="submit" disabled={locked || !account || !availability?.available || cart.lines.some(line => !items.find(item => item.id === line.menuId)?.available)}>
          {busy ? 'Please wait…' : quote ? 'Send pickup request' : 'Review current prices'}
        </button>
      </form>}
    </>}
  </section>;
}

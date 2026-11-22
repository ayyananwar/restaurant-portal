import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { MenuItem, OrderRequest, PaperOrderDetails, Table } from '../shared/contracts.js';
import { api, message, RequestError } from './api.js';
import { formatPaise } from './money.js';
import { availabilityCaption, filterMenu } from './menu-display.js';
import { DishPhoto } from './dish-photo.js';
import { ArrowLeft, ChefHat, ClipboardList, Grid2X2, Plus, Search, Utensils } from 'lucide-react';

type DraftLine = OrderRequest['lines'][number] & { id: string; item: MenuItem };
const wideScreen = '(min-width: 64rem)';

export function OrderComposer({ table, menu, connected, canOrder, paper, samplePhotos, onClose, onRefresh, counter }: {
  table: Table;
  menu: MenuItem[];
  connected: boolean;
  canOrder: boolean;
  paper?: PaperOrderDetails & { waiterName: string };
  samplePhotos?: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  counter?: { label: string; served: boolean; onSave: (order: OrderRequest) => Promise<void> };
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [removed, setRemoved] = useState<{ line: DraftLine; index: number } | null>(null);
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState<OrderRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const sendLock = useRef(false);
  const initialOrderId = useRef(table.orderId);
  const catalogScroll = useRef(0);

  useEffect(() => {
    if (window.matchMedia(wideScreen).matches) search.current?.focus({ preventScroll: true });
    else heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function restorePane(event: PopStateEvent) {
      const next = event.state?.orderReview === table.id;
      setReview(next);
      window.requestAnimationFrame(() => {
        if (next) reviewHeading.current?.focus();
        else {
          window.scrollTo(0, catalogScroll.current);
          reviewButton.current?.focus({ preventScroll: true });
        }
      });
    }
    window.addEventListener('popstate', restorePane);
    return () => window.removeEventListener('popstate', restorePane);
  }, [table.id]);

  const menuById = new Map(menu.map(item => [item.id, item]));
  const categories = [...new Set(menu.map(item => item.category))];
  const results = filterMenu(menu, query, category);
  const quantity = draft.reduce((sum, line) => sum + line.quantity, 0);
  const total = draft.reduce((sum, line) => sum + line.quantity * (menuById.get(line.menuId) ?? line.item).pricePaise, 0);
  const served = paper?.mode === 'served' || counter?.served;
  const unavailable = draft.some(line => {
    const item = menuById.get(line.menuId);
    return !item || (!served && !item.available);
  });
  const tableChanged = table.orderId !== initialOrderId.current;
  const editable = canOrder && !tableChanged && !busy && !pending;

  function add(item: MenuItem) {
    const id = crypto.randomUUID();
    setDraft(lines => {
      const existing = lines.find(line => line.menuId === item.id && !line.note?.trim());
      if (existing) return lines.map(line => line.id === existing.id ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line);
      if (lines.length >= 50) return lines;
      return [...lines, { id, item, menuId: item.id, quantity: 1, note: '' }];
    });
  }

  function update(id: string, change: Partial<Pick<DraftLine, 'quantity' | 'note'>>) {
    setDraft(lines => lines.map(line => line.id === id ? { ...line, ...change } : line));
  }

  function changePane(next: boolean) {
    if (next) {
      catalogScroll.current = window.scrollY;
      window.history.pushState({ ...window.history.state, orderReview: table.id }, '');
      setReview(true);
      window.requestAnimationFrame(() => reviewHeading.current?.focus());
    } else {
      window.history.back();
    }
  }

  function close() {
    if (window.history.state?.orderReview === table.id) window.history.back();
    onClose();
  }

  async function send() {
    if (sendLock.current || !connected || (!pending && (!canOrder || tableChanged || !draft.length || unavailable))) return;
    const order = pending ?? {
      requestId: crypto.randomUUID(),
      expectedOrderId: initialOrderId.current,
      lines: draft.map(({ menuId, quantity, note, item }) => ({
        menuId, quantity, note: note?.trim(), expectedPricePaise: (menuById.get(menuId) ?? item).pricePaise
      }))
    };
    sendLock.current = true;
    setBusy(true);
    setPending(order);
    setError('');
    try {
      if (counter) await counter.onSave(order);
      else await api(`/api/tables/${table.id}/${paper ? 'paper-orders' : 'orders'}`, 'POST',
        paper ? { ...order, mode: paper.mode, creditedWaiterId: paper.creditedWaiterId } : order);
      await onRefresh();
      close();
    } catch (error) {
      if (error instanceof RequestError && [400, 403, 404, 409].includes(error.status)) {
        setPending(null);
        await onRefresh();
      }
      setError(message(error));
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }

  return <section className="composer" aria-labelledby="composer-title" data-review={review}>
    <header className="composer-header">
      <div>
        <h2 id="composer-title" className="sr-only" tabIndex={-1} ref={heading}>
          {counter ? 'Counter order' : paper ? served ? 'Already-served paper order' : 'Live paper order' : table.orderId ? 'Add to order' : 'Take order'}
        </h2>
        <p className="composer-table-label"><Grid2X2 aria-hidden="true" /><span><small>{counter ? 'Counter order' : 'Table / Customer'}</small><strong>{counter?.label ?? table.label}</strong></span></p>
        {paper && <p className="note">Credit {paper.waiterName} · {served ? 'Add to the check only' : 'Send to the kitchen'}</p>}
      </div>
      <Button variant="secondary" disabled={busy || !!pending}
        onClick={() => draft.length ? dialog.current?.showModal() : close()}><ArrowLeft aria-hidden="true" />{counter ? 'Back to counter' : 'Back to tables'}</Button>
    </header>
    {!canOrder && <p className="error" role="alert">{table.hasReceipt
      ? 'The counter recorded a receipt. Return to tables to continue.'
      : table.splitId !== null
      ? 'The counter split this check. Ask the counter to reopen it before changing the order.'
      : `${table.waiter?.name} now has this table. Return to tables to continue.`}</p>}
    {canOrder && tableChanged && !pending && <p className="error" role="alert">This table’s order changed. Return to tables and open the current order.</p>}
    <div className="composer-panes">
      <section className="panel catalog" aria-label="Dish catalog">
        <div className="catalog-controls">
          <div className="catalog-heading">
          <h2><span className="staff-icon-tile"><Utensils aria-hidden="true" /></span>Menu</h2>
          <Field className="staff-search">
            <FieldLabel htmlFor="menu-search" className="sr-only">Search dishes</FieldLabel>
            <Search aria-hidden="true" />
            <Input id="menu-search" ref={search} type="search" placeholder="Name or category" value={query}
              onChange={event => setQuery(event.target.value)} />
          </Field>
          </div>
          {categories.length > 1 && <div className="category-list" role="group" aria-label="Menu categories">
            {[null, ...categories].map(option => <Button key={option ?? ''} variant="outline" size="sm"
              aria-pressed={category === option} onClick={() => setCategory(option)}>{option ?? 'All'}</Button>)}
          </div>}
          <a href="#draft-title" className="desktop-jump" onClick={event => {
            event.preventDefault();
            reviewHeading.current?.focus();
          }}>Jump to order</a>
        </div>
        {results.length ? <ul className="catalog-items">
          {results.map(item => {
            const existing = draft.find(line => line.menuId === item.id && !line.note?.trim());
            const capped = existing ? existing.quantity >= 99 : draft.length >= 50;
            const caption = availabilityCaption(item);
            return <li className="catalog-item" key={item.id}>
              <DishPhoto item={item} sample={samplePhotos} />
              <div className="item-text">
                <strong>{item.name}</strong>
                <p className="note">{item.category}</p><b>{formatPaise(item.pricePaise)}</b>
                {!item.available && <Badge data-state="sold-out" variant="secondary">Sold out</Badge>}
                {caption && <p className="note">{caption}</p>}
              </div>
              <Button aria-label={`Add ${item.name}`} disabled={!editable || (!served && !item.available) || capped}
                onClick={() => add(item)}><Plus aria-hidden="true" /></Button>
            </li>;
          })}
        </ul> : <div className="catalog-empty">
          <p>{query.trim() ? `No dishes match “${query.trim()}”.` : 'No dishes in this category.'}</p>
          {(query || category) && <Button variant="outline" onClick={() => { setQuery(''); setCategory(null); search.current?.focus(); }}>Clear filters</Button>}
        </div>}
      </section>
      <section className="panel draft-panel" aria-labelledby="draft-title">
        <div className="table-header">
          <h2 id="draft-title" tabIndex={-1} ref={reviewHeading}><span className="staff-icon-tile"><ClipboardList aria-hidden="true" /></span>Order summary</h2>
          <Button variant="ghost" className="mobile-back" onClick={() => changePane(false)}>Back to menu</Button>
          <a href="#menu-search" className="desktop-jump" onClick={event => {
            event.preventDefault();
            search.current?.focus();
          }}>Back to search</a>
        </div>
        {draft.length === 0 && <p className="muted">Add dishes from the menu to start this order.</p>}
        {draft.length > 0 && <ul className="draft-items">
          {draft.map((line, index) => {
            const item = menuById.get(line.menuId);
            return <li key={line.id} className="draft-item">
              <div className="table-header">
                <strong>{line.item.name}</strong>
                <span className="amount">{formatPaise(line.quantity * (item ?? line.item).pricePaise)}</span>
              </div>
              {!item?.available && <Badge variant="secondary" data-state="sold-out">Sold out</Badge>}
              <div className="quantity-controls" role="group" aria-label={`Quantity for ${line.item.name}`}>
                <Button variant="outline" aria-label={`Decrease ${line.item.name} quantity`} disabled={!editable || line.quantity <= 1}
                  onClick={() => update(line.id, { quantity: line.quantity - 1 })}>−</Button>
                <span className="amount">{line.quantity}</span>
                <Button variant="outline" aria-label={`Increase ${line.item.name} quantity`} disabled={!editable || line.quantity >= 99}
                  onClick={() => update(line.id, { quantity: line.quantity + 1 })}>+</Button>
                <Button variant="ghost" aria-label={`Remove ${line.item.name}`} disabled={!editable}
                  onClick={() => { setRemoved({ line, index }); setDraft(lines => lines.filter(entry => entry.id !== line.id)); }}>Remove</Button>
              </div>
              <Field>
                <FieldLabel htmlFor={`note-${line.id}`}>Note for {line.item.name}</FieldLabel>
                <Input id={`note-${line.id}`} maxLength={300} placeholder="Optional" disabled={!editable} value={line.note}
                  onChange={event => update(line.id, { note: event.target.value })} />
              </Field>
            </li>;
          })}
        </ul>}
        {removed && <div className="table-header">
          <p role="status">{removed.line.item.name} removed.</p>
          <Button variant="outline" disabled={!editable || draft.length >= 50} onClick={() => {
            setDraft(lines => [...lines.slice(0, removed.index), removed.line, ...lines.slice(removed.index)]);
            setRemoved(null);
          }}>Undo</Button>
        </div>}
        {unavailable && !pending && <p className="error" role="status">Remove unavailable dishes before saving.</p>}
        {error && <p className="error" role="alert">{error}{pending ? ' Retry to check whether the order was saved.' : ''}</p>}
        <p className="total"><span><b>Total</b> · {quantity} {quantity === 1 ? 'item' : 'items'}</span><strong>{formatPaise(total)}</strong></p>
        <Button disabled={busy || !connected || (!pending && (!canOrder || tableChanged || !draft.length || unavailable))}
          onClick={() => void send()}><ChefHat aria-hidden="true" />{busy ? 'Saving…' : pending ? 'Retry submission' : counter ? 'Save for payment' : served ? 'Save served order' : 'Send to kitchen'}</Button>
      </section>
    </div>
    <p className="sr-only" role="status">{quantity} {quantity === 1 ? 'item' : 'items'} in the order</p>
    <div className="review-bar">
      <span className="amount">{quantity} {quantity === 1 ? 'item' : 'items'} · {formatPaise(total)}</span>
      <Button ref={reviewButton} disabled={!draft.length && !removed} onClick={() => changePane(true)}>Review order</Button>
    </div>
    <dialog ref={dialog} className="panel discard-dialog" aria-labelledby="discard-title">
      <h2 id="discard-title">Discard this order draft?</h2>
      <p>The unsent items for {table.label} will be removed.</p>
      <div className="actions">
        <Button variant="outline" autoFocus onClick={() => dialog.current?.close()}>Keep editing</Button>
        <Button variant="destructive" onClick={() => { dialog.current?.close(); close(); }}>Discard draft</Button>
      </div>
    </dialog>
  </section>;
}

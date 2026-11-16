import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { OrderLine, PaperOrderDetails, Role, ServiceState } from '../shared/contracts.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, message, RequestError } from './api.js';
import { formatPaise } from './money.js';
import { OrderComposer } from './order-composer.js';
import { TablePlacement } from './table-placement.js';
import { DishChangeControls } from './dish-change.js';
import { CheckSplit } from './check-split.js';
import { ReleaseTable } from './receipt-handoff.js';
import { PaperOrderSetup } from './paper-order-setup.js';
import { WaiterActivity } from './waiter-activity.js';
import { MenuCatalog } from './menu-catalog.js';
import { TableQrCards } from './table-qr-cards.js';
import { CouponManager } from './coupon-manager.js';
import { PrivateFeedback } from './private-feedback.js';
import { ArrowRight, BookOpen, ChefHat, ClipboardList, ConciergeBell, Grid2X2, House, LockKeyhole, LogOut, MessageSquareText, Plus, QrCode, Search, Ticket, UserRound, UsersRound, Eye, EyeOff, Check, CirclePlay } from 'lucide-react';
import emptyTable from './art/empty-table.webp';
import { DishPhoto } from './dish-photo.js';
import './styles.css';

const statusLabels = { queued: 'Queued', preparing: 'In preparation', ready: 'Ready', cancelled: 'Cancelled' };
const roleLabels = { admin: 'Outlet overview', waiter: 'Table service', kitchen: 'Kitchen queue', billing: 'Counter checks' };
const adminPages = [
  { id: null, label: roleLabels.admin, icon: House, trigger: 'outlet-overview-trigger' },
  { id: 'activity', label: 'Waiter activity', icon: UsersRound, trigger: 'waiter-activity-trigger' },
  { id: 'menu', label: 'Menu catalog', icon: BookOpen, trigger: 'menu-catalog-trigger' },
  { id: 'qr', label: 'Table QR cards', icon: QrCode, trigger: 'table-qr-trigger' },
  { id: 'coupons', label: 'Dine-in coupons', icon: Ticket, trigger: 'coupon-trigger' },
  { id: 'feedback', label: 'Private feedback', icon: MessageSquareText, trigger: 'private-feedback-trigger' }
] as const;
const emptyMessages = {
  admin: 'Tables will appear after the outlet is configured.',
  waiter: 'There are no tables set up for this outlet.',
  kitchen: 'Dishes will appear here when a waiter sends an order.',
  billing: 'Checks will appear here when a waiter opens an order.'
};

function App() {
  const [service, setService] = useState<ServiceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    void api<ServiceState>('/api/service').then(setService).catch(error => {
      if (!(error instanceof RequestError && error.status === 401)) setError(message(error));
    }).finally(() => setLoading(false));
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setSigningIn(true);
    setError('');
    try {
      await api('/api/session', 'POST', {
        username: String(values.get('username')).trim().toLowerCase(), password: values.get('password')
      });
      setService(await api<ServiceState>('/api/service'));
    } catch (error) {
      setError(message(error));
    } finally {
      setSigningIn(false);
    }
  }

  if (loading) return <main className="login"><p role="status">Opening the restaurant portal…</p></main>;
  if (service) return <Dashboard initial={service} onSignedOut={() => setService(null)} />;
  return <main className="login">
    <form className="panel login-form" onSubmit={signIn}>
      <div className="login-banner" aria-hidden="true" />
      <p className="eyebrow">Restaurant portal</p>
      <h1>Staff sign-in</h1>
      <p className="muted">Sign in with your outlet account.</p>
      <FieldGroup className="login-fields">
        <Field>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <div className="login-input"><UserRound aria-hidden="true" /><Input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={32} /></div>
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <div className="login-input"><LockKeyhole aria-hidden="true" /><Input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required maxLength={128} /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff /> : <Eye />}</button></div>
        </Field>
      </FieldGroup>
      {error && <p role="alert" className="error">{error}</p>}
      <Button type="submit" disabled={signingIn}>{signingIn ? 'Signing in…' : 'Sign in'}<ArrowRight aria-hidden="true" /></Button>
    </form>
  </main>;
}

function Dashboard({ initial, onSignedOut }: { initial: ServiceState; onSignedOut: () => void }) {
  const [service, setService] = useState(initial);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tableId, setTableId] = useState<number | null>(null);
  const [paperEntry, setPaperEntry] = useState<PaperOrderDetails | 'setup' | null>(null);
  const [workspaceView, setWorkspaceView] = useState<(typeof adminPages)[number]['id']>(null);
  const [workspaceLocked, setWorkspaceLocked] = useState(false);
  const workspaceHeading = useRef<HTMLHeadingElement>(null);
  const [tableQuery, setTableQuery] = useState('');
  const [tableStatus, setTableStatus] = useState('all');
  const [listView, setListView] = useState(false);
  const [counterTab, setCounterTab] = useState<'open' | 'paid'>('open');
  const [counterTable, setCounterTable] = useState<number>();
  const version = useRef(0);
  const onSignOut = useRef(onSignedOut);
  onSignOut.current = onSignedOut;

  useEffect(() => {
    if (workspaceView || tableId !== null || paperEntry === 'setup') window.scrollTo(0, 0);
  }, [workspaceView, tableId, paperEntry]);

  useEffect(() => {
    if (!workspaceLocked) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [workspaceLocked]);

  async function refresh() {
    const requestVersion = ++version.current;
    try {
      const updated = await api<ServiceState>('/api/service');
      if (requestVersion === version.current) {
        setService(updated);
        setConnected(true);
      }
    } catch (error) {
      if (requestVersion !== version.current) return;
      if (error instanceof RequestError && error.status === 401) onSignOut.current();
      else setConnected(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer = window.setTimeout(tick, 3000);
    async function tick() {
      await refresh();
      if (!cancelled) timer = window.setTimeout(tick, 3000);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      version.current++;
    };
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(message(error));
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  const { staff, tables, menu, waiters } = service;
  const samplePhotos = service.sampleArtwork;
  const currentTable = tables.find(table => table.id === tableId);
  const paper = paperEntry && paperEntry !== 'setup' ? {
    ...paperEntry, waiterName: waiters.find(waiter => waiter.id === paperEntry.creditedWaiterId)?.name ?? 'selected waiter'
  } : undefined;
  const visible = staff.role === 'waiter' ? tables.filter(table => {
    const query = tableQuery.trim().toLowerCase();
    return (tableStatus === 'all' || (table.orderId === null) === (tableStatus === 'available')) &&
      `${table.label} ${table.orderId ?? ''} ${table.lines.map(line => line.name).join(' ')}`.toLowerCase().includes(query);
  }) : staff.role === 'admin' ? tables
    : tables.filter(table => staff.role === 'kitchen' ? table.lines.length > 0 : table.orderId !== null);
  const occupied = tables.filter(table => table.orderId !== null).length;
  const isAdmin = staff.role === 'admin';
  const currentPage = adminPages.find(page => page.id === workspaceView);
  const title = currentTable && !paper ? (currentTable.orderId ? 'Order details' : 'Take order')
    : workspaceView === 'menu' && staff.role === 'kitchen' ? 'Dish availability'
    : isAdmin ? currentPage?.label ?? roleLabels.admin : roleLabels[staff.role];
  function returnToOverview() {
    setWorkspaceView(null);
    const trigger = isAdmin ? currentPage?.trigger : 'menu-catalog-trigger';
    if (trigger) window.requestAnimationFrame(() => {
      const button = document.getElementById(trigger);
      if (button instanceof HTMLButtonElement && !button.disabled) button.focus();
      else workspaceHeading.current?.focus();
    });
  }
  const homeIcon = { admin: House, waiter: Grid2X2, kitchen: ChefHat, billing: ClipboardList }[staff.role];
  const HomeIcon = homeIcon;
  const counterChecks = visible.filter(table => {
    const paid = table.receipts.length === (table.splitId === null ? 1 : table.checks.length) && table.receipts.every(receipt => receipt.paymentMethod);
    return counterTab === 'paid' ? paid : !paid;
  });
  const checkTotal = (table: ServiceState['tables'][number]) => table.lines.reduce((sum, line) => line.status === 'cancelled' ? sum : sum + line.pricePaise * line.quantity, 0);
  const selectedCheck = counterChecks.find(table => table.id === counterTable) ?? counterChecks[0];
  const billingDashboard = staff.role === 'billing' && !paperEntry && !currentTable;
  return <div className={`staff-shell ${isAdmin ? 'staff-overview' : 'staff-sidebar-shell'}`} data-role={staff.role}>
    {isAdmin ? <div className="overview-banner" aria-hidden="true" /> :
      <aside className="staff-sidebar">
        <div className="staff-brand"><ConciergeBell aria-hidden="true" /><span>Restaurant Portal</span></div>
        <nav aria-label="Staff navigation">
          <button type="button" aria-current={!workspaceView && !currentTable && !paperEntry ? 'page' : undefined}
            disabled={!!currentTable || !!paperEntry} onClick={() => setWorkspaceView(null)}><HomeIcon aria-hidden="true" />{roleLabels[staff.role]}</button>
          {currentTable && <span aria-current="page"><Plus aria-hidden="true" />{paper ? 'Paper order' : 'Take order'}</span>}
          {staff.role === 'kitchen' && <button type="button" aria-current={workspaceView === 'menu' ? 'page' : undefined} aria-label="Dish availability workspace"
            disabled={!connected} onClick={() => setWorkspaceView('menu')}><ConciergeBell aria-hidden="true" />Dish availability</button>}
        </nav>
      </aside>}
    <main className={`workspace${billingDashboard ? ' counter-workspace' : ''}`}>
    <header className="topbar">
      <div>
        <p className="eyebrow">Restaurant portal</p>
        <h1 ref={workspaceHeading} tabIndex={-1}>{title}</h1>
      </div>
      <div className="identity">
        <span className="muted">{staff.name}</span>
        <Button variant="outline" disabled={busy || workspaceLocked} onClick={async () => {
          setBusy(true);
          try {
            await api('/api/session/logout', 'POST', {});
            onSignedOut();
          } catch (error) {
            setError(message(error));
          } finally {
            setBusy(false);
          }
        }}><LogOut aria-hidden="true" />Sign out</Button>
      </div>
    </header>
    <div className="service-bar">
      <p className={connected ? 'connection' : 'connection disconnected'} role="status">
        {connected ? 'Connected to the outlet' : 'Connection lost. Rejoin the restaurant Wi-Fi to resume.'}
      </p>
      <p className="table-count">{occupied} active {occupied === 1 ? 'table' : 'tables'}</p>
    </div>
    {isAdmin && <nav className="overview-actions" aria-label="Outlet navigation">
      {adminPages.map(({ id, label, trigger, icon: Icon }) => <Button key={trigger} id={trigger} type="button" variant="outline"
        aria-current={workspaceView === id ? 'page' : undefined}
        disabled={workspaceView !== id && (workspaceLocked || (!connected && id !== null))}
        onClick={() => {
          if (workspaceView === id) return;
          setWorkspaceView(id);
          window.requestAnimationFrame(() => workspaceHeading.current?.focus());
        }}><Icon aria-hidden="true" />{label}</Button>)}
      {workspaceLocked && <p className="note">Save or cancel this edit to switch sections.</p>}
    </nav>}
    {error && <p role="alert" className="error">{error}</p>}
    {workspaceView === 'activity' ? <WaiterActivity onClose={returnToOverview} />
      : workspaceView === 'feedback' ? <PrivateFeedback onClose={returnToOverview} />
      : workspaceView === 'coupons' ? <CouponManager connected={connected} onClose={returnToOverview} onEditChange={setWorkspaceLocked} />
      : workspaceView === 'qr' ? <TableQrCards tables={tables} destination={service.tableQr} connected={connected} onClose={returnToOverview} />
      : workspaceView === 'menu' ? <MenuCatalog menu={menu} canEdit={isAdmin} connected={connected} onRefresh={refresh}
        publication={service.publication} samplePhotos={samplePhotos} onClose={returnToOverview}
        onEditChange={isAdmin ? setWorkspaceLocked : undefined} />
      : paperEntry === 'setup' ? <PaperOrderSetup tables={tables} waiters={waiters} connected={connected}
      onStart={(id, details) => { setPaperEntry(details); setTableId(id); }}
      onClose={() => {
        setPaperEntry(null);
        window.requestAnimationFrame(() => document.getElementById('paper-order-trigger')?.focus());
    }} /> : currentTable ? <OrderComposer key={currentTable.id} table={currentTable} menu={menu} paper={paper} samplePhotos={samplePhotos}
      connected={connected} canOrder={currentTable.splitId === null && !currentTable.hasReceipt
        && (!!paper || !currentTable.waiter || currentTable.waiter.id === staff.id)}
      onClose={() => {
        setTableId(null);
        setPaperEntry(null);
        window.requestAnimationFrame(() => document.getElementById(paper ? 'paper-order-trigger' : `take-order-${currentTable.id}`)?.focus());
      }} onRefresh={refresh} /> : <>
    {staff.role === 'billing' && <div className="counter-actions actions">
      {(['open', 'paid'] as const).map(tab => <Button key={tab} variant={counterTab === tab ? 'default' : 'outline'} aria-pressed={counterTab === tab}
        onClick={() => { setCounterTab(tab); setCounterTable(undefined); }}><ClipboardList aria-hidden="true" />{tab === 'open' ? 'Open checks' : 'Paid checks'}</Button>)}
      <Button id="paper-order-trigger" variant="outline" disabled={!connected || !waiters.length || !menu.length}
        onClick={() => setPaperEntry('setup')}>Enter paper order</Button>
    </div>}
    {staff.role === 'kitchen' && <div className="counter-actions"><Button id="menu-catalog-trigger" variant="outline" disabled={!connected}
      onClick={() => setWorkspaceView('menu')}><ConciergeBell aria-hidden="true" />Dish availability</Button></div>}
    {staff.role === 'waiter' && <>
      <div className="staff-metrics">
        {[[tables.length, 'Total tables'], [tables.length - occupied, 'Available'], [occupied, 'Occupied'], [occupied, 'Active orders']].map(([count, label]) =>
          <div key={label}><ConciergeBell aria-hidden="true" /><span><strong>{count}</strong>{label}</span></div>)}
      </div>
      <div className="table-filters">
        <div className="staff-search"><Search aria-hidden="true" /><Input type="search" aria-label="Search table or order" placeholder="Search table or order…" value={tableQuery} onChange={event => setTableQuery(event.target.value)} /></div>
        <select aria-label="Table status" value={tableStatus} onChange={event => setTableStatus(event.target.value)}><option value="all">All status</option><option value="available">Available</option><option value="occupied">Occupied</option></select>
        <div className="actions"><Button variant={listView ? 'outline' : 'default'} aria-pressed={!listView} onClick={() => setListView(false)}>Table view</Button>
          <Button variant={listView ? 'default' : 'outline'} aria-pressed={listView} onClick={() => setListView(true)}>List view</Button></div>
      </div>
    </>}
    {visible.length === 0 && <p className="panel muted">{tables.length && staff.role === 'waiter' ? 'No tables match your filters.' : emptyMessages[staff.role]}</p>}
    <div className={billingDashboard ? 'counter-layout' : undefined}>
    {billingDashboard && counterChecks.length > 0 && <section className="panel counter-list" aria-label={`${counterTab === 'open' ? 'Open' : 'Paid'} checks`}>
      <div className="table-header"><h2>{counterTab === 'open' ? 'Open checks' : 'Paid checks'}</h2><strong>{formatPaise(counterChecks.reduce((sum, table) => sum + checkTotal(table), 0))}</strong></div>
      {counterChecks.map(table => <button key={table.id} type="button" className="counter-select" aria-controls="counter-check" aria-pressed={selectedCheck?.id === table.id} onClick={() => {
        setCounterTable(table.id);
        if (window.matchMedia('(width < 58rem)').matches) {
          window.requestAnimationFrame(() => document.getElementById('counter-check-title')?.focus());
        }
      }}>
        <span><ClipboardList aria-hidden="true" />{table.label}</span><strong>{formatPaise(checkTotal(table))}</strong>
      </button>)}
    </section>}
    {billingDashboard && visible.length > 0 && !counterChecks.length && <p className="panel muted">No {counterTab} checks.</p>}
    <div id={billingDashboard ? 'counter-check' : undefined} className={`table-grid${listView && staff.role === 'waiter' ? ' table-list-view' : ''}`}>
    {(billingDashboard ? (selectedCheck ? [selectedCheck] : []) : visible).map(table => <section className="panel table-panel" key={table.id} data-occupied={table.orderId !== null}>
        <div className="table-header">
          <h2 id={billingDashboard ? 'counter-check-title' : undefined} tabIndex={billingDashboard ? -1 : undefined}>
            {staff.role === 'kitchen' && <span className="staff-icon-tile"><ChefHat aria-hidden="true" /></span>}{table.label}
          </h2>
          <Badge variant={table.waiter ? 'secondary' : 'outline'} className="table-owner">{table.waiter?.name ?? 'Available'}</Badge>
        </div>
        {billingDashboard && <div className="counter-columns" aria-hidden="true"><span>Item</span><span>Qty</span><span>Amount</span></div>}
        {staff.role === 'waiter' && table.orderId === null && <div className="vacant-table"><img src={emptyTable} alt="" /><p>Ready for next guest</p></div>}
        {staff.role === 'waiter' && table.orderId !== null && <div className="table-progress">
          <p>{table.lines.filter(line => line.status !== 'cancelled').reduce((sum, line) => sum + line.quantity, 0)} items · <strong>{formatPaise(checkTotal(table))}</strong></p>
          <div className="service-progress" aria-label="Order progress">{['Ordered', 'Preparing', 'Ready'].map((step, index) => {
            const complete = index === 0 || (index === 1 ? table.lines.some(line => line.status === 'preparing' || line.status === 'ready') : table.lines.every(line => line.status === 'ready' || line.status === 'cancelled'));
            return <span key={step} data-complete={complete}><i>{complete && <Check aria-hidden="true" />}</i>{step}</span>;
          })}</div>
        </div>}
        {table.lines.length > 0 && <ul className="lines">
          {table.lines.map(line => <Dish key={line.id} line={line} role={staff.role}
            canEdit={staff.role === 'waiter' && table.waiter?.id === staff.id && table.splitId === null && !table.hasReceipt}
            disabled={busy || !connected} onRefresh={refresh}
            photo={staff.role === 'billing' ? <DishPhoto item={menu.find(item => item.name === line.name)} sample={samplePhotos} /> : undefined}
            change={status => void run(() => api(`/api/dishes/${line.id}`, 'PATCH', { status, revision: line.revision }))} />)}
        </ul>}
        {staff.role === 'billing' && <p className="total">
          Check total <strong>{formatPaise(table.lines.reduce((sum, line) => line.status === 'cancelled' ? sum : sum + line.pricePaise * line.quantity, 0))}</strong>
        </p>}
        {staff.role === 'billing' && table.orderId !== null &&
          <CheckSplit key={`billing-${table.orderId}`} table={table} connected={connected} onRefresh={refresh} />}
        {staff.role === 'waiter' && table.waiter?.id === staff.id && table.splitId !== null && !table.hasReceipt &&
          <p className="note">The counter split this check. Ask the counter to reopen it before changing the order.</p>}
        {staff.role === 'waiter' && table.waiter?.id === staff.id && table.hasReceipt &&
          <p className="note">The counter recorded a receipt. The order is locked.</p>}
        {staff.role === 'waiter' && (!table.waiter || table.waiter.id === staff.id) &&
          <Button id={`take-order-${table.id}`} variant="outline" className="order-trigger"
            disabled={!connected || !menu.length || table.splitId !== null || table.hasReceipt} onClick={() => setTableId(table.id)}>
            <Plus aria-hidden="true" />{table.orderId ? 'Add to order' : 'Take order'}
          </Button>}
        {staff.role === 'waiter' && table.waiter?.id === staff.id &&
          <ReleaseTable key={`release-${table.orderId}`} table={table} connected={connected} onRefresh={refresh} />}
        {(staff.role === 'billing' || (staff.role === 'waiter' && table.waiter?.id === staff.id)) && table.orderId !== null &&
          <TablePlacement key={`placement-${table.orderId}`} table={table} tables={tables} waiters={waiters}
            connected={connected} canJoin={staff.role === 'billing'} onRefresh={refresh} />}
      </section>)}
    </div>
    </div>
    </>}
  </main></div>;
}

function Dish({ line, role, canEdit, disabled, change, onRefresh, photo }: {
  line: OrderLine;
  photo?: React.ReactNode;
  role: Role;
  canEdit: boolean;
  disabled: boolean;
  change: (status: 'preparing' | 'ready') => void;
  onRefresh: () => Promise<void>;
}) {
  return <li className="dish">
    <div className="dish-copy">{photo}<div>
      <strong>{role === 'billing' ? line.name : `${line.quantity} × ${line.name}`}</strong>
      {line.note && <p className="note">{line.note}</p>}
      {line.entrySource !== 'waiter' && <p className="note">{line.entrySource === 'paper-served' ? 'Paper · already served' : 'Paper · live'}</p>}
    </div></div>
    {role === 'billing' && <span className="counter-quantity" aria-label={`Quantity ${line.quantity}`}>{line.quantity}</span>}
    <div className="dish-status">
      {role !== 'kitchen' && line.status !== 'cancelled' && <span>{formatPaise(line.pricePaise * line.quantity)}</span>}
      <Badge variant="secondary" data-state={line.status}>{statusLabels[line.status]}</Badge>
    </div>
    {role === 'kitchen' && (line.status === 'queued' || line.status === 'preparing') && <div className="actions">
      {line.status === 'queued' && <Button variant="outline" disabled={disabled} onClick={() => change('preparing')}><CirclePlay aria-hidden="true" />Start preparing</Button>}
      <Button disabled={disabled} onClick={() => change('ready')}><Check aria-hidden="true" />Mark ready</Button>
    </div>}
    <DishChangeControls line={line} role={role} canEdit={canEdit} disabled={disabled} onRefresh={onRefresh} />
  </li>;
}

createRoot(document.getElementById('root')!).render(<App />);

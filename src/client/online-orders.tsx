import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { OnlineInbox, PickupPriceReview, PickupRequest } from '../shared/online-ordering.js';
import { api, message } from './api.js';
import { formatPaise } from './money.js';
import { formatPublicationTime } from './menu-display.js';
import { useEditsLocked, useProtectedEdit } from './edit-lock.js';

const labels:Record<PickupRequest['status'],string>={pending_acceptance:'Waiting for restaurant',awaiting_payment:'Waiting for customer payment',
  rejected:'Rejected',expired:'Expired',recovery_required:'Owner review needed'};
const indiaTime=(at:number)=>new Date(at+330*60_000).toISOString().slice(0,16);
export function OnlineOrders({connected,owner,onClose}:{connected:boolean;owner:boolean;onClose?:()=>void}) {
  const [inbox,setInbox]=useState<OnlineInbox|null>(null);
  const [selected,setSelected]=useState<string>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [edit,setEdit]=useState<{order:PickupRequest;review:PickupPriceReview|null} | null>(null);
  const locked=useEditsLocked();
  const heading=useRef<HTMLHeadingElement>(null);
  const returnFocus=useRef(false);
  useEffect(()=>{if(!edit&&returnFocus.current){heading.current?.focus();returnFocus.current=false;}},[edit]);
  async function load(){try{setInbox(await api<OnlineInbox>('/api/online-orders'));setError('');}catch(error){setError(message(error));}}
  useEffect(()=>{let current=true;let timer:ReturnType<typeof setTimeout>;async function tick(){
    try{const next=await api<OnlineInbox>('/api/online-orders');if(current){setInbox(next);setError('');}}catch(error){if(current)setError(message(error));}
    if(current)timer=setTimeout(tick,3000);
  }void tick();return()=>{current=false;clearTimeout(timer);};},[]);
  const order=inbox?.orders.find(order=>order.id===selected)??inbox?.orders[0];
  async function run(task:()=>Promise<void>){setBusy(true);setError('');try{await task();}catch(error){setError(message(error));}finally{setBusy(false);}}
  if(edit)return <OnlineDecision order={edit.order} review={edit.review} connected={connected} onClose={()=>{returnFocus.current=true;setEdit(null);void load();}} />;
  return <section aria-label="Online orders">
    <div className="table-header"><h2 ref={heading} tabIndex={-1}>Online pickup orders</h2>
      {onClose&&<Button variant="ghost" disabled={locked} onClick={onClose}>Back to outlet overview</Button>}</div>
    <p className="note">Review online requests here. Acceptance asks the customer to pay; it does not send food to the kitchen.</p>
    {error&&<p role="alert" className="error">{error}</p>}
    {!inbox&&!error&&<p role="status">Opening online requests…</p>}
    {inbox&&<>
      <div className="panel online-summary">
        <div className="actions"><Badge>{!inbox.configured?'Not connected':inbox.ready?'Accepting requests':inbox.enabled?'Online connection pending':inbox.settingsConfirmed?'Online pickup paused':'Pause requested'}</Badge>
          <Button variant="outline" disabled={!connected||busy||locked||!inbox.configured} onClick={()=>void run(async()=>{await api('/api/online-orders/refresh','POST',{});await load();})}>Refresh online requests</Button>
          {owner&&<Button variant="outline" disabled={!connected||busy||locked||!inbox.configured} onClick={()=>void run(async()=>{
            await api('/api/outlet/online','PUT',{enabled:!inbox.enabled,revision:inbox.revision});await load();
          })}>{inbox.enabled?'Pause online pickup':'Enable online pickup'}</Button>}
        </div>
        {!inbox.configured&&<p className="note">The hosted outlet connection is not configured. Local table and counter service continue normally.</p>}
        {inbox.lastSyncedAt&&<p className="muted">Last hosted sync: {formatPublicationTime(new Date(inbox.lastSyncedAt).toISOString())} IST</p>}
        {inbox.error&&<p role="alert" className="error">{inbox.error}</p>}
        {!inbox.ready&&inbox.configured&&(inbox.enabled||!inbox.settingsConfirmed)&&<p className="note">{inbox.enabled?'Online availability is not confirmed. The online package and a live outlet connection are required.':'The pause is saved on this PC and is waiting for hosted confirmation.'}</p>}
      </div>
      {!inbox.orders.length&&<p className="panel muted">No online requests have reached this counter.</p>}
      {!!order&&<div className="counter-layout online-orders-layout">
        <section className="panel counter-list" aria-label="Online request list">
          {inbox.orders.map(item=><button className="counter-select" type="button" key={item.id} disabled={locked||busy}
            aria-pressed={item.id===order.id} onClick={()=>{setSelected(item.id);heading.current?.focus();}}>
            <strong>{item.quote.name}</strong><span>{item.decision?.state==='queued'?'Decision queued':labels[item.status]}</span>
            <span>{formatPaise(item.acceptance?.review.amounts.totalPaise??item.quote.subtotalPaise)}</span>
          </button>)}
        </section>
        <section className="panel" aria-label={`Online request for ${order.quote.name}`}>
          <div className="table-header"><h3>{order.quote.name}</h3><Badge>{labels[order.status]}</Badge></div>
          <p className="muted">Request {order.id.slice(0,8)} · {formatPublicationTime(new Date(order.createdAt).toISOString())} IST</p>
          <ul className="online-item-list">{order.quote.lines.map(line=><li key={line.menuId}><strong>{line.quantity} × {line.name}</strong>
            {line.note&&<p>{line.note}</p>}</li>)}</ul>
          {order.quote.notes&&<p>Order note: {order.quote.notes}</p>}
          <p><strong>Customer item estimate: {formatPaise(order.quote.subtotalPaise)}</strong></p>
          {order.acceptance&&<><OnlineTotal review={order.acceptance.review}/><p>Promised pickup: {formatPublicationTime(new Date(order.acceptance.readyAt).toISOString())} IST</p></>}
          {order.confirmation&&<p>Customer confirmed the total. Payment is still required; do not start preparation.</p>}
          {order.rejection&&<p>Rejection reason: {order.rejection.reason}</p>}
          {order.decision?.state==='queued'&&<p role="status" className="note">Decision saved on this PC. Waiting for hosted confirmation; do not start preparation.</p>}
          {order.decision?.state==='conflict'&&<p role="alert" className="error">{order.decision.error??'The decision needs review. Refresh the request before trying again.'}</p>}
          {order.status==='recovery_required'&&<p className="error">The owner must reconcile this accepted request and any payment outcome before service resumes.</p>}
          {order.status==='pending_acceptance'&&order.decision?.state!=='queued'&&<div className="actions">
            <Button disabled={!connected||busy||locked||order.expiresAt<=Date.now()} onClick={()=>void run(async()=>{
              const review=await api<PickupPriceReview>(`/api/online-orders/${order.id}/review`,'POST',{revision:order.revision});setEdit({order,review});
            })}>Review acceptance</Button>
            <Button variant="outline" disabled={!connected||busy||locked||order.expiresAt<=Date.now()} onClick={()=>setEdit({order,review:null})}>Reject request</Button>
          </div>}
        </section>
      </div>}
    </>}
  </section>;
}
function OnlineTotal({review}:{review:PickupPriceReview}){
  return <dl className="bill-totals"><div><dt>Item subtotal</dt><dd>{formatPaise(review.subtotalPaise)}</dd></div>
    <div><dt>{review.seller.pricesIncludeTax?'Tax included':'Tax added'}</dt><dd>{formatPaise(review.amounts.cgstPaise+review.amounts.sgstPaise+review.amounts.igstPaise)}</dd></div>
    <div><dt>{review.seller.pricesIncludeTax?'Total, tax included':'Total, including tax'}</dt><dd><strong>{formatPaise(review.amounts.totalPaise)}</strong></dd></div>
  </dl>;
}
function OnlineDecision({order,review,connected,onClose}:{order:PickupRequest;review:PickupPriceReview|null;connected:boolean;onClose:()=>void}){
  useProtectedEdit();
  const [readyAt,setReadyAt]=useState(()=>indiaTime(Date.now()+20*60_000));
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [requestId]=useState(()=>crypto.randomUUID());
  const focus=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{focus.current?.focus();},[]);
  async function submit(event:FormEvent){event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{await api(`/api/online-orders/${order.id}/decision`,'POST',{requestId,expectedRevision:order.revision,decision:review?'accept':'reject',
      reason:review?'':reason.trim(),readyAt:review?new Date(readyAt+'+05:30').getTime():null,reviewHash:review?.hash??null});onClose();}
    catch(error){setError(message(error));}finally{setBusy(false);}
  }
  return <form className="panel online-decision" onSubmit={submit}>
    <h2 ref={focus} tabIndex={-1}>{review?'Review online acceptance':'Reject online request'}</h2>
    <p>{order.quote.name} · Request {order.id.slice(0,8)}</p>
    {review&&<><ul className="online-item-list">{review.lines.map(line=><li key={line.menuId}>{line.quantity} × {line.name} · {formatPaise(line.quantity*line.unitPaise)}{line.note&&<p>{line.note}</p>}</li>)}</ul>
      <OnlineTotal review={review}/><p className="note">The customer must review this total and pay. Preparation remains locked until payment is verified.</p></>}
    <FieldGroup><Field><FieldLabel htmlFor="online-decision-value">{review?'Promised pickup (India time)':'Reason for rejection'}</FieldLabel>
      {review?<Input id="online-decision-value" type="datetime-local" required min={indiaTime(Date.now()+120_000)} max={indiaTime(Date.now()+86_400_000)} value={readyAt} disabled={busy} onChange={event=>setReadyAt(event.target.value)}/>
        :<textarea id="online-decision-value" required maxLength={500} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/>}
    </Field></FieldGroup>
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="actions"><Button type="submit" disabled={busy||!connected}>{busy?'Saving decision…':review?'Save acceptance decision':'Save rejection decision'}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
  </form>;
}

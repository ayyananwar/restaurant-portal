import type { DatabaseSync } from 'node:sqlite';
import { publicationHeaders } from './publication-headers.js';
import { readBillingProfile } from './billing.js';
import { WorkflowError } from './store.js';
import type { Staff } from '../shared/contracts.js';
import { validPickupRequest, validPickupReview, type OnlineInbox, type PickupDecision, type PickupRequest } from '../shared/online-ordering.js';

type Target={endpoint:string;token:string};
type Settings={revision:number;enabled:number;destination:string|null;ack_revision:number|null;last_success:number|null;last_error:string|null;cursor:string|null};
type SavedDecision={request_id:string;order_id:string;actor_id:number;payload:string;state:string;attempted_at:number|null};
const settings=(db:DatabaseSync)=>db.prepare('SELECT * FROM online_connector WHERE id=1').get() as unknown as Settings;
const fail=(status:number,message:string)=>new WorkflowError(status,message);
const decisionKey=(value:Omit<PickupDecision,'actor'>)=>JSON.stringify({requestId:value.requestId,expectedRevision:value.expectedRevision,
  decision:value.decision,reason:value.reason,readyAt:value.readyAt,reviewHash:value.reviewHash});
function bind(db:DatabaseSync,target:Target) {
  const prior=settings(db).destination;
  if(prior&&prior!==target.endpoint)throw fail(409,'This database is linked to a different online outlet. Contact support before reconnecting.');
  db.prepare('UPDATE online_connector SET destination=? WHERE id=1 AND destination IS NULL').run(target.endpoint);
}
function saveRequest(db:DatabaseSync,destination:string,value:unknown) {
  if(!validPickupRequest(value))throw fail(502,'The online service returned an invalid request.');
  db.prepare(`INSERT INTO online_inbox(destination,id,revision,snapshot,verified_at) VALUES(?,?,?,?,?)
    ON CONFLICT(destination,id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,verified_at=excluded.verified_at,
      review=CASE WHEN online_inbox.revision=excluded.revision THEN online_inbox.review ELSE NULL END,
      reviewed_at=CASE WHEN online_inbox.revision=excluded.revision THEN online_inbox.reviewed_at ELSE NULL END
    WHERE excluded.revision>=online_inbox.revision`).run(destination,value.id,value.revision,JSON.stringify(value),Date.now());
  return value;
}
export function onlineInbox(db:DatabaseSync,target?:Target):OnlineInbox {
  const current=settings(db);
  const destination=target?.endpoint??current.destination;
  const rows=destination?db.prepare(`SELECT snapshot FROM online_inbox WHERE destination=?
    ORDER BY CASE json_extract(snapshot,'$.status') WHEN 'recovery_required' THEN 0 WHEN 'pending_acceptance' THEN 1 WHEN 'awaiting_payment' THEN 2 ELSE 3 END,
      CASE WHEN json_extract(snapshot,'$.status')='pending_acceptance' THEN json_extract(snapshot,'$.createdAt') END ASC,
      json_extract(snapshot,'$.createdAt') DESC,id LIMIT 200`).all(destination):[];
  return {configured:Boolean(target),enabled:Boolean(current.enabled),settingsConfirmed:current.ack_revision===current.revision,revision:current.revision,lastSyncedAt:current.last_success,error:current.last_error,
    ready:Boolean(target&&current.enabled&&current.ack_revision===current.revision&&!current.last_error&&current.last_success&&Date.now()-current.last_success<45_000&&
      !db.prepare('SELECT 1 FROM recovery_state WHERE id=1 AND reviewed_at IS NULL').get()),
    orders:rows.map(row=>{
      const order=JSON.parse(String(row.snapshot)) as PickupRequest;
      const decision=db.prepare(`SELECT request_id,state,error FROM online_decisions WHERE destination=? AND order_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(destination!,order.id);
      return {...order,...(decision?{decision:{requestId:String(decision.request_id),state:String(decision.state) as 'queued'|'confirmed'|'conflict',error:decision.error===null?null:String(decision.error)}}:{})};
    })};
}

export function setOnlineEnabled(db:DatabaseSync,actor:Staff,enabled:boolean,revision:number,target?:Target) {
  if(actor.role!=='admin')throw fail(403,'Only the owner can change online ordering.');
  if(!target)throw fail(409,'Configure the hosted outlet connection first.');
  bind(db,target);
  if(enabled&&!readBillingProfile(db).enabled)throw fail(409,'Configure and enable built-in billing before activating online pickup.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const current=settings(db);
    if(current.revision!==revision)throw fail(409,'Online settings changed. Refresh before saving.');
    if(Boolean(current.enabled)!==enabled){
      db.prepare('UPDATE online_connector SET enabled=?,revision=revision+1,ack_revision=NULL,last_error=NULL WHERE id=1').run(Number(enabled));
      db.prepare('INSERT INTO configuration_events(actor_id,at,action,details) VALUES(?,?,?,?)').run(actor.id,Date.now(),'online-pickup-setting',JSON.stringify({enabled,revision:revision+1}));
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function queueOnlineDecision(db:DatabaseSync,actor:Staff,id:string,input:Omit<PickupDecision,'actor'>,target?:Target) {
  if(!['admin','billing'].includes(actor.role))throw fail(403,'Only owner and billing staff can decide online requests.');
  if(!target)throw fail(409,'The hosted outlet connection is not configured.');
  bind(db,target);
  const payload:PickupDecision={...input,actor:{id:actor.id,name:actor.name,role:actor.role}};
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior=db.prepare('SELECT * FROM online_decisions WHERE request_id=?').get(input.requestId) as unknown as SavedDecision|undefined;
    if(prior){
      const {actor:oldActor,...oldInput}=JSON.parse(prior.payload) as PickupDecision;
      if(prior.order_id!==id||prior.actor_id!==actor.id||decisionKey(oldInput)!==decisionKey(input)||prior.actor_id!==oldActor.id)throw fail(409,'This decision identity was already used with different details.');
      db.exec('COMMIT');return {requestId:prior.request_id,state:prior.state};
    }
    const row=db.prepare('SELECT * FROM online_inbox WHERE destination=? AND id=?').get(target.endpoint,id);
    if(!row)throw fail(404,'Online request not found. Refresh the inbox.');
    const order=JSON.parse(String(row.snapshot)) as PickupRequest;
    if(order.status!=='pending_acceptance'||order.revision!==input.expectedRevision||order.expiresAt<=Date.now())throw fail(409,'The request changed or expired. Refresh before deciding.');
    if(db.prepare("SELECT 1 FROM online_decisions WHERE destination=? AND order_id=? AND state='queued'").get(target.endpoint,id))throw fail(409,'A decision for this request is already queued.');
    if(input.decision==='accept'){
      const review=row.review?JSON.parse(String(row.review)):null;
      if(!validPickupReview(review)||review.orderId!==id||review.hash!==input.reviewHash||review.revision!==order.revision||Date.now()-Number(row.reviewed_at)>60_000||review.seller.revision!==readBillingProfile(db).revision)throw fail(409,'Review the latest total before accepting.');
      if(!Number.isSafeInteger(input.readyAt)||input.readyAt!<Date.now()+120_000||input.readyAt!>Date.now()+86_400_000||input.reason!=='')throw fail(400,'Choose a pickup time between two minutes and 24 hours ahead.');
    }else if(!input.reason.trim()||input.readyAt!==null||input.reviewHash!==null)throw fail(400,'Enter a rejection reason.');
    db.prepare("INSERT INTO online_decisions(request_id,destination,order_id,actor_id,payload,created_at,state) VALUES(?,?,?,?,?,?,'queued')")
      .run(input.requestId,target.endpoint,id,actor.id,JSON.stringify(payload),Date.now());
    db.exec('COMMIT');return {requestId:input.requestId,state:'queued'};
  }catch(error){db.exec('ROLLBACK');throw error;}
}

class RemoteError extends WorkflowError {}
export function createOnlineConnector(db:DatabaseSync,target?:Target,send=fetch) {
  const controller=new AbortController();
  let active:Promise<void>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let running=false;
  let again=false;
  const paused=()=>Boolean(db.prepare('SELECT 1 FROM recovery_state WHERE id=1 AND reviewed_at IS NULL').get());
  async function request(path:string,method='GET',body?:unknown):Promise<unknown> {
    if(!target)throw fail(409,'The hosted outlet connection is not configured.');
    const response=await send(target.endpoint+path,{method,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]),
      headers:{...publicationHeaders(db,target.token),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok){await response.body?.cancel();throw new RemoteError(response.status,response.status===403?'The online package is inactive or access was denied.':
      response.status===409?'Online settings or this request changed. Refresh before trying again.':'The hosted service could not confirm this request. Saved decisions are retained.');}
    if(response.status===204){await response.body?.cancel();return undefined;}
    if(!response.headers.get('content-type')?.includes('application/json')||!response.body){await response.body?.cancel();throw fail(502,'Invalid online response.');}
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16*1024*1024){await reader.cancel();throw fail(502,'The online response exceeds its limit.');}chunks.push(part.value);}}
    finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function cycle() {
    if(!target||paused()||controller.signal.aborted)return;
    bind(db,target);
    const current=settings(db);
    let configurationError:string|null=null;
    try{
      await request('/pickup-channel','PUT',{revision:current.revision,enabled:Boolean(current.enabled)});
      db.prepare('UPDATE online_connector SET ack_revision=? WHERE id=1 AND revision=?').run(current.revision,current.revision);
      const profile=readBillingProfile(db);
      if(profile.revision>0)await request('/pickup-pricing','PUT',profile);
    }catch(error){if(!(error instanceof RemoteError)||![403,409].includes(error.statusCode))throw error;configurationError=error.message;}
    const queued=db.prepare("SELECT * FROM online_decisions WHERE destination=? AND state='queued' ORDER BY created_at,rowid LIMIT 20").all(target.endpoint) as unknown as SavedDecision[];
    for(const operation of queued){
      if(paused()||controller.signal.aborted)return;
      const actor=db.prepare('SELECT enabled,role FROM staff WHERE id=?').get(operation.actor_id);
      if(!actor?.enabled||!['admin','billing'].includes(String(actor.role))){
        db.prepare("UPDATE online_decisions SET state='conflict',error=? WHERE request_id=?").run('Operator access changed. The owner must review the current hosted outcome.',operation.request_id);continue;
      }
      try{
        db.prepare('UPDATE online_decisions SET attempted_at=? WHERE request_id=?').run(Date.now(),operation.request_id);
        const result=await request(`/pickup-requests/${operation.order_id}/decision`,'POST',JSON.parse(operation.payload));
        if(!validPickupRequest(result)||result.id!==operation.order_id)throw fail(502,'Invalid online decision acknowledgment.');
        db.exec('BEGIN IMMEDIATE');try{saveRequest(db,target.endpoint,result);
          db.prepare("UPDATE online_decisions SET state='confirmed',result=?,error=NULL WHERE request_id=?").run(JSON.stringify(result),operation.request_id);db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
      }catch(error){
        if(error instanceof RemoteError&&[400,403,404,409].includes(error.statusCode))db.prepare("UPDATE online_decisions SET state='conflict',error=? WHERE request_id=?").run(error.message,operation.request_id);
        else throw error;
      }
    }
    const page=await request('/pickup-requests'+(current.cursor?`?after=${current.cursor}`:'')) as {requests?:unknown;nextAfter?:unknown};
    if(!Array.isArray(page.requests)||page.requests.length>100||page.requests.some(value=>!validPickupRequest(value))||
      !(page.nextAfter===null||(typeof page.nextAfter==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(page.nextAfter)))||page.nextAfter===current.cursor&&page.nextAfter!==null||
      new Set(page.requests.map(value=>value.id)).size!==page.requests.length||page.nextAfter!==null&&(page.requests.length!==100||page.requests.at(-1).id!==page.nextAfter))throw fail(502,'Invalid online inbox page.');
    for(const value of page.requests)saveRequest(db,target.endpoint,value);
    db.prepare('UPDATE online_connector SET cursor=? WHERE id=1').run(page.nextAfter as string|null);
    const ids=db.prepare(`SELECT id FROM online_inbox WHERE destination=? ORDER BY
      CASE WHEN json_extract(snapshot,'$.status') IN ('pending_acceptance','awaiting_payment','recovery_required') THEN 0 ELSE 1 END,verified_at,id LIMIT 100`).all(target.endpoint).map(row=>String(row.id));
    if(ids.length){
      const reconciled=await request('/pickup-requests/reconcile','POST',{ids}) as {requests?:unknown;missing?:unknown};
      if(!Array.isArray(reconciled.requests)||!Array.isArray(reconciled.missing)||reconciled.requests.length+reconciled.missing.length!==ids.length||
        reconciled.requests.some(value=>!validPickupRequest(value)||!ids.includes(value.id))||reconciled.missing.some(id=>typeof id!=='string'||!ids.includes(id)))throw fail(502,'Invalid online reconciliation response.');
      if(new Set([...reconciled.requests.map(value=>value.id),...reconciled.missing]).size!==ids.length)throw fail(502,'Duplicate online reconciliation identifiers.');
      for(const value of reconciled.requests)saveRequest(db,target.endpoint,value);
      if(reconciled.missing.length)configurationError='A saved request is missing from the hosted service. Preserve the data and contact support.';
    }
    db.prepare('UPDATE online_connector SET last_success=?,last_error=? WHERE id=1').run(Date.now(),configurationError);
  }
  function refresh():Promise<void> {
    if(active){again=true;return active;}
    active=(async()=>{do{again=false;try{await cycle();}catch(error){if(!controller.signal.aborted)db.prepare('UPDATE online_connector SET last_error=? WHERE id=1').run(error instanceof WorkflowError?error.message:'Online connection interrupted. Saved decisions will retry.');}}while(again&&!controller.signal.aborted);})()
      .finally(()=>{active=undefined;});
    return active;
  }
  function kick(){if(!controller.signal.aborted)void refresh();}
  function start(){if(running)return;running=true;const tick=async()=>{await refresh();if(!controller.signal.aborted)timer=setTimeout(tick,settings(db).cursor?100:15_000).unref();};void tick();}
  async function review(id:string,revision:number){
    if(!target||paused())throw fail(409,'Online review is paused or not configured.');
    bind(db,target);
    let result:unknown;
    try{result=await request(`/pickup-requests/${id}/review`,'POST',{revision});}
    catch(error){if(error instanceof WorkflowError)throw error;throw fail(503,'The hosted outlet is unreachable. Reconnect and review the order again.');}
    if(!validPickupReview(result)||result.orderId!==id||result.revision!==revision)throw fail(502,'Invalid online price review.');
    if(result.seller.revision!==readBillingProfile(db).revision)throw fail(409,'Billing settings are still synchronizing. Refresh before reviewing again.');
    const saved=db.prepare(`UPDATE online_inbox SET review=?,reviewed_at=? WHERE destination=? AND id=? AND revision=?`).run(JSON.stringify(result),Date.now(),target.endpoint,id,revision);
    if(!saved.changes)throw fail(409,'The request changed while reviewing. Refresh the inbox.');
    return result;
  }
  return {refresh,kick,start,review,async stop(){controller.abort();clearTimeout(timer);await active;}};
}
export type OnlineConnector=ReturnType<typeof createOnlineConnector>;

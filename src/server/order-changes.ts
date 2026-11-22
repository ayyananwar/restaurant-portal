import type { DatabaseSync } from 'node:sqlite';
import type { DishChangeRequest, Staff } from '../shared/contracts.js';
import { activeSplit, hasReceipt, WorkflowError } from './store.js';

function activeLine(db: DatabaseSync, lineId: number) {
  return db.prepare(`
    SELECT l.quantity, l.note, l.revision, l.status, l.cancelled_at, o.waiter_id, o.table_id, o.id AS order_id, m.available
    FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN menu m ON m.id = l.menu_id
    WHERE l.id = ? AND o.closed_at IS NULL
  `).get(lineId) as {
    quantity: number; note: string; revision: number; status: string;
    cancelled_at: number | null; waiter_id: number; table_id: number | null; order_id: number; available: number;
  } | undefined;
}

function applyChange(db: DatabaseSync, lineId: number, quantity: number, note: string, now: number) {
  if (quantity === 0) {
    db.prepare('UPDATE order_lines SET cancelled_at = ?, revision = revision + 1 WHERE id = ?').run(now, lineId);
  } else {
    db.prepare('UPDATE order_lines SET quantity = ?, note = ?, revision = revision + 1 WHERE id = ?').run(quantity, note, lineId);
  }
}

export function requestDishChange(db: DatabaseSync, lineId: number, staff: Staff, request: DishChangeRequest) {
  const note = request.note.trim();
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare(`
      SELECT id, line_id, revision, quantity, note, outcome FROM dish_changes WHERE requested_by = ? AND request_id = ?
    `).get(staff.id, request.requestId);
    if (prior) {
      if (prior.line_id !== lineId || prior.revision !== request.revision || prior.quantity !== request.quantity || prior.note !== note) {
        throw new WorkflowError(409, 'This request ID was already used for another change.');
      }
      db.exec('COMMIT');
      return { id: Number(prior.id), outcome: prior.outcome };
    }
    const line = activeLine(db, lineId);
    if (!line) throw new WorkflowError(404, 'Active dish not found.');
    if (line.waiter_id !== staff.id) throw new WorkflowError(403, 'Only the assigned waiter can request this change.');
    if (activeSplit(db, line.order_id)) throw new WorkflowError(409, 'Ask the counter to reopen the split check before changing dishes.');
    if (hasReceipt(db, line.order_id)) throw new WorkflowError(409, 'The counter already recorded a receipt for this check.');
    if (line.cancelled_at !== null || line.status === 'ready' || line.revision !== request.revision) {
      throw new WorkflowError(409, 'This dish changed or is already ready. Review the current order.');
    }
    if (request.quantity > line.quantity && line.available !== 1) throw new WorkflowError(409, 'This dish is sold out. The quantity cannot be increased.');
    if (request.quantity === line.quantity && note === line.note) throw new WorkflowError(400, 'Change the quantity or note before saving.');
    if (db.prepare("SELECT id FROM dish_changes WHERE line_id = ? AND outcome = 'pending'").get(lineId)) {
      throw new WorkflowError(409, 'The counter is already reviewing a change for this dish.');
    }
    const now = Date.now();
    if (line.status === 'preparing' && db.prepare('SELECT change_policy FROM outlet_settings WHERE id=1').get()?.change_policy === 'blocked') {
      throw new WorkflowError(409, 'This outlet blocks changes after preparation starts.');
    }
    const outcome = line.status === 'queued' ? 'applied' : 'pending';
    const result = db.prepare(`
      INSERT INTO dish_changes
        (line_id, requested_by, request_id, requested_at, revision, previous_quantity, previous_note, quantity, note, outcome, resolved_by, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(lineId, staff.id, request.requestId, now, request.revision, line.quantity, line.note, request.quantity, note, outcome,
      outcome === 'applied' ? staff.id : null, outcome === 'applied' ? now : null);
    if (outcome === 'applied') applyChange(db, lineId, request.quantity, note, now);
    db.exec('COMMIT');
    return { id: Number(result.lastInsertRowid), outcome };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function resolveDishChange(db: DatabaseSync, changeId: number, actorId: number, approve: boolean) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const change = db.prepare('SELECT line_id, revision, quantity, note, outcome FROM dish_changes WHERE id = ?')
      .get(changeId) as { line_id: number; revision: number; quantity: number; note: string; outcome: string } | undefined;
    if (!change) throw new WorkflowError(404, 'Change request not found.');
    const outcome = approve ? 'applied' : 'declined';
    if (change.outcome !== outcome) {
      if (change.outcome !== 'pending') throw new WorkflowError(409, 'This change is no longer pending.');
      const line = activeLine(db, change.line_id);
      if (!line || line.cancelled_at !== null || line.status !== 'preparing' || line.revision !== change.revision) {
        throw new WorkflowError(409, 'The dish changed while the request was pending.');
      }
      if (approve && change.quantity > line.quantity && line.available !== 1) throw new WorkflowError(409, 'This dish is sold out. Decline the request and ask the waiter to review the order.');
      const now = Date.now();
      if (approve) applyChange(db, change.line_id, change.quantity, change.note, now);
      db.prepare('UPDATE dish_changes SET outcome = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
        .run(outcome, actorId, now, changeId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function correctReadyDish(db:DatabaseSync,lineId:number,actor:Staff,input:DishChangeRequest & {reason:string}) {
  if(actor.role!=='billing') throw new WorkflowError(403,'Only billing staff can correct a ready dish.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior=db.prepare('SELECT id,line_id,revision,quantity,note FROM dish_changes WHERE requested_by=? AND request_id=?')
      .get(actor.id,input.requestId);
    const note=input.note.trim();
    const reason=input.reason.trim();
    if(prior) {
      const audit=db.prepare("SELECT details FROM configuration_events WHERE actor_id=? AND action='ready-dish-correction' AND json_extract(details,'$.requestId')=?")
        .get(actor.id,input.requestId);
      if(!audit||prior.line_id!==lineId||prior.revision!==input.revision||prior.quantity!==input.quantity||prior.note!==note||
        JSON.parse(String(audit.details)).reason!==reason) throw new WorkflowError(409,'This correction request was already used.');
      db.exec('COMMIT');return {id:Number(prior.id),outcome:'applied'};
    }
    const line=activeLine(db,lineId);
    if(!line||line.table_id===null||line.cancelled_at!==null||line.status!=='ready'||line.revision!==input.revision) {
      throw new WorkflowError(409,'Open the current ready table dish before correcting it.');
    }
    if(hasReceipt(db,line.order_id)||activeSplit(db,line.order_id)) throw new WorkflowError(409,'Recorded or split checks are locked. Review the billing records before making a correction.');
    if(!reason||input.quantity>line.quantity||(input.quantity===line.quantity&&note===line.note)) {
      throw new WorkflowError(400,'Enter a reason and reduce the quantity, cancel the dish, or correct its note. Add new dishes through the waiter.');
    }
    const now=Date.now();
    const result=db.prepare(`INSERT INTO dish_changes(line_id,requested_by,request_id,requested_at,revision,previous_quantity,previous_note,
      quantity,note,outcome,resolved_by,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,'applied',?,?)`)
      .run(lineId,actor.id,input.requestId,now,line.revision,line.quantity,line.note,input.quantity,note,actor.id,now);
    applyChange(db,lineId,input.quantity,note,now);
    db.prepare('INSERT INTO configuration_events(actor_id,at,action,details) VALUES (?,?,?,?)')
      .run(actor.id,now,'ready-dish-correction',JSON.stringify({lineId,orderId:line.order_id,requestId:input.requestId,reason}));
    db.exec('COMMIT');
    return {id:Number(result.lastInsertRowid),outcome:'applied'};
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

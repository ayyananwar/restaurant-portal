import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CheckItem, Staff } from '../shared/contracts.js';
import { activeSplit, billableLines, checkVersion, readReceipts, requireCurrentOrder, WorkflowError } from './store.js';

export function tableResolutionQuote(db: DatabaseSync, tableId: number, orderId: number) {
  requireCurrentOrder(db,tableId,orderId);
  const lines=billableLines(db,orderId);
  const split=activeSplit(db,orderId);
  const checks=split?JSON.parse(split.checks) as CheckItem[][]:[lines.map(line=>({lineId:line.id,quantity:line.quantity}))];
  const receipts=readReceipts(db,orderId);
  const amountPaise=checks.reduce((sum,items,index)=>{
    const receipt=receipts.find(entry=>entry.checkNumber===index+1);
    if(receipt?.paymentMethod) return sum;
    return sum+(receipt?.officialTotalPaise??items.reduce((subtotal,item)=>
      subtotal+item.quantity*(lines.find(line=>line.id===item.lineId)?.pricePaise??0),0));
  },0);
  const version=createHash('sha256').update(JSON.stringify([orderId,split?.id??null,checkVersion(lines),receipts,amountPaise])).digest('hex');
  return {amountPaise,version};
}

export function resolveTableBalance(db:DatabaseSync,actor:Staff,tableId:number,input:{orderId:number;version:string;reason:string}) {
  if(actor.role!=='admin') throw new WorkflowError(403,'Only an owner can resolve an unpaid table.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior=db.prepare('SELECT r.reason,r.owner_id,o.table_id FROM table_resolutions r JOIN orders o ON o.id=r.order_id WHERE r.order_id=?').get(input.orderId);
    if(prior) {
      if(prior.table_id!==tableId||prior.reason!==input.reason.trim()||prior.owner_id!==actor.id) throw new WorkflowError(409,'This table already has a different recorded resolution.');
      db.exec('COMMIT');return;
    }
    const quote=tableResolutionQuote(db,tableId,input.orderId);
    if(quote.version!==input.version||quote.amountPaise<=0) throw new WorkflowError(409,'The check changed. Review its current balance.');
    if(!input.reason.trim()) throw new WorkflowError(400,'Enter the owner resolution reason.');
    const label=String(db.prepare('SELECT label FROM dining_tables WHERE id=?').get(tableId)?.label);
    db.prepare('INSERT INTO table_resolutions(order_id,table_label,amount_paise,reason,owner_id,at) VALUES (?,?,?,?,?,?)')
      .run(input.orderId,label,quote.amountPaise,input.reason.trim(),actor.id,Date.now());
    db.prepare('UPDATE orders SET closed_at=?,closed_by=? WHERE id=?').run(Date.now(),actor.id,input.orderId);
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

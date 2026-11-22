import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BillBuyer, BillQuote, BillingProfile, BillSnapshot, CheckIdentity, CheckItem, Staff } from '../shared/contracts.js';
import { billAmounts, billingProfileIssue, defaultBillingProfile, normalizeBillingProfile, roundRatio, stateNames, validGstin } from '../shared/billing.js';
import { activeSplit, WorkflowError } from './store.js';
import { couponForTotal } from './coupons.js';

export function readBillingProfile(db:DatabaseSync):BillingProfile {
  const row=db.prepare('SELECT revision,profile FROM billing_profile WHERE id=1').get();
  return row?{...JSON.parse(String(row.profile)),revision:Number(row.revision)}:{...defaultBillingProfile};
}

export function saveBillingProfile(db:DatabaseSync,actor:Staff,input:BillingProfile) {
  if(actor.role!=='admin') throw new WorkflowError(403,'Only an owner can configure billing.');
  const profile=normalizeBillingProfile(input);
  const issue=billingProfileIssue(profile);
  if(issue) throw new WorkflowError(400,issue);
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior=readBillingProfile(db);
    const recovery=db.prepare('SELECT blocked_series FROM recovery_state WHERE id=1').get();
    if(recovery) {
      const blocked=JSON.parse(String(recovery.blocked_series)) as string[];
      if(blocked.includes(profile.series)||blocked.includes(profile.creditSeries)) throw new WorkflowError(409,'That series is reserved after recovery. Choose a new invoice and credit-note series.');
    }
    if(prior.revision!==profile.revision) throw new WorkflowError(409,'Billing settings changed. Review the current profile.');
    db.prepare('INSERT INTO billing_profile(id,revision,profile) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,profile=excluded.profile')
      .run(profile.revision+1,JSON.stringify(profile));
    db.prepare('INSERT INTO configuration_events(actor_id,at,action,details) VALUES (?,?,?,?)')
      .run(actor.id,Date.now(),'billing-profile',JSON.stringify({revision:profile.revision+1}));
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

export function financialYear(now:number) {
  const date=new Date(now+330*60_000);
  const year=date.getUTCFullYear()-(date.getUTCMonth()<3?1:0);
  return `${String(year).slice(-2)}${String(year+1).slice(-2)}`;
}

export function allocateBillNumber(db:DatabaseSync,series:string,now:number) {
  const year=financialYear(now);
  const row=db.prepare(`INSERT INTO bill_sequences(series,financial_year,last_number) VALUES (?,?,1)
    ON CONFLICT(series,financial_year) DO UPDATE SET last_number=last_number+1 RETURNING last_number`).get(series,year);
  const number=Number(row?.last_number);
  if(number>999999) throw new WorkflowError(409,'This invoice series is full for the financial year. Ask the owner to choose a new series.');
  return `${series}/${year}/${String(number).padStart(6,'0')}`;
}

export function prepareBill(db:DatabaseSync,identity:CheckIdentity,buyerInput:BillBuyer,couponCode:string,destination?:string):BillQuote {
  const profile=readBillingProfile(db);
  if(!profile.enabled) throw new WorkflowError(409,'The owner needs to enable and configure built-in billing.');
  const buyer={name:buyerInput.name.trim(),address:buyerInput.address.trim(),gstin:buyerInput.gstin.trim().toUpperCase(),placeState:buyerInput.placeState};
  if(!stateNames[buyer.placeState]||(buyer.gstin&&!validGstin(buyer.gstin))) throw new WorkflowError(400,'Enter a valid place of supply and buyer GSTIN.');
  const lines=db.prepare('SELECT id,name,quantity,price_paise FROM order_lines WHERE order_id=? AND cancelled_at IS NULL ORDER BY id')
    .all(identity.orderId);
  const split=activeSplit(db,identity.orderId);
  const allocation=split?(JSON.parse(split.checks) as CheckItem[][])[identity.checkNumber-1]:lines.map(line=>({lineId:Number(line.id),quantity:Number(line.quantity)}));
  if(!allocation?.length) throw new WorkflowError(409,'The selected check has no billable items.');
  const items=allocation.map(item=>{
    const line=lines.find(line=>line.id===item.lineId);
    if(!line) throw new WorkflowError(409,'The check changed. Review its current items.');
    return {name:String(line.name),quantity:item.quantity,unitPaise:Number(line.price_paise),amountPaise:item.quantity*Number(line.price_paise)};
  });
  const subtotalPaise=items.reduce((sum,item)=>sum+item.amountPaise,0);
  const coupon=couponCode.trim()?couponForTotal(db,couponCode,subtotalPaise,destination):undefined;
  const discountPaise=coupon?.discountPaise??0;
  const amounts=billAmounts(subtotalPaise,discountPaise,profile,buyer.placeState);
  if(amounts.totalPaise>99_999_999_999) throw new WorkflowError(422,'This check exceeds the supported bill amount.');
  if((buyer.gstin||(profile.taxMode==='gst'&&amounts.totalPaise>=5_000_000))&&(!buyer.name||!buyer.address)) {
    throw new WorkflowError(400,'Enter the buyer name and address for this invoice.');
  }
  const bill:BillSnapshot={
    number:'Preview',issuedAt:0,kind:profile.taxMode==='gst'?'tax-invoice':profile.taxMode==='composition'?'bill-of-supply':'receipt',
    profile,buyer,items,subtotalPaise,discountPaise,...amounts
  };
  const reviewHash=createHash('sha256').update(JSON.stringify({identity,bill,coupon})).digest('hex');
  return {reviewHash,bill};
}

export function issueCreditNote(db:DatabaseSync,orderId:number,correctionId:number,amount:number,reason:string,item:string,quantity:number) {
  const row=db.prepare('SELECT snapshot FROM built_in_bills WHERE order_id=? AND check_number=1').get(orderId);
  if(!row) return;
  const original=JSON.parse(String(row.snapshot)) as BillSnapshot;
  const previous=db.prepare('SELECT snapshot FROM built_in_credit_notes WHERE order_id=?').all(orderId)
    .map(row=>JSON.parse(String(row.snapshot)) as BillSnapshot);
  const remaining=(field:'taxablePaise'|'cgstPaise'|'sgstPaise'|'igstPaise'|'totalPaise')=>
    original[field]-previous.reduce((sum,note)=>sum+note[field],0);
  const last=amount===remaining('totalPaise');
  const part=(field:'taxablePaise'|'cgstPaise'|'sgstPaise'|'igstPaise')=>
    last?remaining(field):Math.min(remaining(field),roundRatio(amount,original[field],Math.max(1,original.totalPaise)));
  const taxablePaise=part('taxablePaise');
  const cgstPaise=part('cgstPaise');
  const sgstPaise=part('sgstPaise');
  const igstPaise=part('igstPaise');
  const now=Date.now();
  const note:BillSnapshot={
    ...original,kind:'credit-note',number:allocateBillNumber(db,readBillingProfile(db).creditSeries??'CN',now),issuedAt:now,originalNumber:original.number,
    items:[{name:item?`${quantity} × ${item} cancellation`:'Remaining order cancellation',quantity:1,unitPaise:amount,amountPaise:amount}],
    subtotalPaise:amount,discountPaise:0,taxablePaise,cgstPaise,sgstPaise,igstPaise,
    totalPaise:amount,roundingPaise:amount-taxablePaise-cgstPaise-sgstPaise-igstPaise,reason
  };
  db.prepare('INSERT INTO built_in_credit_notes(correction_id,number,order_id,snapshot) VALUES (?,?,?,?)')
    .run(correctionId,note.number,orderId,JSON.stringify(note));
}

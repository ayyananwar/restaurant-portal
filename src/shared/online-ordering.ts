export interface PickupCart {
  name: string;
  notes: string;
  lines: Array<{ menuId: number; quantity: number; note: string }>;
}

export interface PickupQuote {
  id: string;
  expiresAt: number;
  subtotalPaise: number;
  name: string;
  notes: string;
  lines: Array<{ menuId: number; name: string; quantity: number; note: string; unitPaise: number }>;
}

export interface PickupRequest {
  id: string;
  status: 'pending_acceptance' | 'awaiting_payment' | 'rejected' | 'expired' | 'recovery_required';
  revision: number;
  createdAt: number;
  expiresAt: number;
  quote: PickupQuote;
  acceptance?: PickupAcceptance;
  rejection?: { reason: string; at: number };
}
import type { BillingProfile, BillSnapshot, Staff } from './contracts.js';


export interface PickupPriceReview {
  hash: string;
  orderId: string;
  currency: 'INR';
  revision: number;
  lines: PickupQuote['lines'];
  subtotalPaise: number;
  discountPaise: number;
  feesPaise: number;
  amounts: Pick<BillSnapshot, 'taxablePaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'roundingPaise' | 'totalPaise'>;
  seller: Pick<BillingProfile, 'legalName' | 'address' | 'stateCode' | 'gstin' | 'taxMode' | 'rateBasisPoints' | 'pricesIncludeTax' | 'classification' | 'revision' | 'testMode'>;
}
export interface PickupAcceptance {
  review: PickupPriceReview;
  readyAt: number;
  acceptedAt: number;
  paymentExpiresAt: number;
}
export interface PickupDecision {
  requestId: string;
  expectedRevision: number;
  actor: Pick<Staff, 'id' | 'name' | 'role'>;
  decision: 'accept' | 'reject';
  reason: string;
  readyAt: number | null;
  reviewHash: string | null;
}

export interface OnlineInbox {
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  settingsConfirmed: boolean;
  revision: number;
  lastSyncedAt: number | null;
  error: string | null;
  orders: Array<PickupRequest & { decision?: { requestId: string; state: 'queued' | 'confirmed' | 'conflict'; error: string | null } }>;
}

const uuidPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const money=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=99_999_999_999;
const stamp=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=8_640_000_000_000_000;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function validLines(value:unknown):value is PickupQuote['lines'] {
  return Array.isArray(value)&&value.length>0&&value.length<=50&&value.every(line=>record(line)&&
    Number.isSafeInteger(line.menuId)&&Number(line.menuId)>0&&typeof line.name==='string'&&line.name.length<=100&&
    typeof line.note==='string'&&line.note.length<=250&&Number.isInteger(line.quantity)&&Number(line.quantity)>0&&Number(line.quantity)<=20&&money(line.unitPaise))
    &&value.reduce((sum,line)=>sum+line.quantity,0)<=100&&new Set(value.map(line=>line.menuId)).size===value.length;
}
export function validPickupReview(value:unknown):value is PickupPriceReview {
  if(!record(value)||typeof value.orderId!=='string'||!uuidPattern.test(value.orderId)||typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash)||value.currency!=='INR'||
    !Number.isSafeInteger(value.revision)||Number(value.revision)<1||!validLines(value.lines)||!money(value.subtotalPaise)||
    value.lines.reduce((sum,line)=>sum+line.quantity*line.unitPaise,0)!==value.subtotalPaise||value.discountPaise!==0||value.feesPaise!==0||
    !record(value.amounts)||!record(value.seller))return false;
  const a=value.amounts;
  return ['taxablePaise','cgstPaise','sgstPaise','igstPaise','totalPaise'].every(key=>money(a[key]))&&
    typeof a.roundingPaise==='number'&&Number.isSafeInteger(a.roundingPaise)&&Math.abs(a.roundingPaise)<=2&&
    Number(a.taxablePaise)+Number(a.cgstPaise)+Number(a.sgstPaise)+Number(a.igstPaise)+a.roundingPaise===a.totalPaise&&
    typeof value.seller.legalName==='string'&&value.seller.legalName.length<=150&&
    typeof value.seller.address==='string'&&value.seller.address.length<=600&&Number.isSafeInteger(value.seller.revision)&&Number(value.seller.revision)>0&&
    typeof value.seller.stateCode==='string'&&/^[0-9]{2}$/.test(value.seller.stateCode)&&typeof value.seller.gstin==='string'&&value.seller.gstin.length<=15&&
    ['none','gst','composition'].includes(String(value.seller.taxMode))&&Number.isInteger(value.seller.rateBasisPoints)&&
    Number(value.seller.rateBasisPoints)>=0&&Number(value.seller.rateBasisPoints)<=2800&&typeof value.seller.pricesIncludeTax==='boolean'&&
    typeof value.seller.classification==='string'&&value.seller.classification.length<=8&&typeof value.seller.testMode==='boolean';
}
export function validPickupRequest(value:unknown):value is PickupRequest {
  if(!record(value)||typeof value.id!=='string'||!uuidPattern.test(value.id)||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||
    !['pending_acceptance','awaiting_payment','rejected','expired','recovery_required'].includes(String(value.status))||!stamp(value.createdAt)||!stamp(value.expiresAt)||!record(value.quote))return false;
  const q=value.quote;
  if(typeof q.id!=='string'||!uuidPattern.test(q.id)||!stamp(q.expiresAt)||typeof q.name!=='string'||q.name.length>100||
    typeof q.notes!=='string'||q.notes.length>500||!validLines(q.lines)||!money(q.subtotalPaise)||q.lines.reduce((sum,line)=>sum+line.quantity*line.unitPaise,0)!==q.subtotalPaise)return false;
  if(value.acceptance!==undefined&&(!record(value.acceptance)||!validPickupReview(value.acceptance.review)||value.acceptance.review.orderId!==value.id||!stamp(value.acceptance.readyAt)||
    !stamp(value.acceptance.acceptedAt)||!stamp(value.acceptance.paymentExpiresAt)))return false;
  if(value.rejection!==undefined&&(!record(value.rejection)||typeof value.rejection.reason!=='string'||value.rejection.reason.length>500||!stamp(value.rejection.at)))return false;
  return (value.status!=='awaiting_payment'||value.acceptance!==undefined)&&(value.status!=='rejected'||value.rejection!==undefined);
}

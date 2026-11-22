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

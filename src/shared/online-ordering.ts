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
  status: 'pending_acceptance' | 'expired';
  createdAt: number;
  expiresAt: number;
  quote: PickupQuote;
}

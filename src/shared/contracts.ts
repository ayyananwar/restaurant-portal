export const roles = ['admin', 'waiter', 'kitchen', 'billing'] as const;
export type Role = typeof roles[number];
export const serviceModes = ['table', 'counter', 'both'] as const;
export type ServiceMode = typeof serviceModes[number];
export interface BillingProfile {
  enabled: boolean;
  revision: number;
  legalName: string;
  address: string;
  stateCode: string;
  gstin: string;
  taxMode: 'none' | 'gst' | 'composition';
  rateBasisPoints: number;
  pricesIncludeTax: boolean;
  classification: string;
  series: string;
  testMode: boolean;
}
export interface BillBuyer { name: string; address: string; gstin: string; placeState: string }
export interface BillSnapshot {
  number: string;
  issuedAt: number;
  kind: 'receipt' | 'tax-invoice' | 'bill-of-supply' | 'credit-note';
  profile: BillingProfile;
  buyer: BillBuyer;
  items: Array<{ name: string; quantity: number; unitPaise: number; amountPaise: number }>;
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  roundingPaise: number;
  totalPaise: number;
  originalNumber?: string;
  reason?: string;
}
export interface BuiltInBillRequest extends CheckIdentity {
  requestId: string;
  reviewHash: string;
  buyer: BillBuyer;
  paymentMethod: PaymentMethod | null;
  couponCode: string;
}
export interface BillQuote { reviewHash: string; bill: BillSnapshot }
export interface OutletSettings { mode: ServiceMode; revision: number; changePolicy: 'approval' | 'blocked' }
export interface CounterDraft extends OrderRequest {
  fulfillment: 'dine-in' | 'takeaway';
  customer: string;
  seating: string;
  paper: 'none' | 'live' | 'served';
  paperReference: string;
}
export interface CounterPayment {
  requestId: string;
  revision: number;
  reference: string;
  officialTotalPaise: number;
  paymentMethod: PaymentMethod;
  coupon?: CouponQuote;
  builtIn?: { reviewHash: string; buyer: BillBuyer; couponCode: string };
}
export interface CounterOrder {
  id: number;
  revision: number;
  openedAt: number;
  cashier: string;
  fulfillment: CounterDraft['fulfillment'];
  customer: string;
  seating: string;
  paper: CounterDraft['paper'];
  paperReference: string;
  token: string | null;
  status: 'awaiting-payment' | 'preparing' | 'ready' | 'collected' | 'cancelled';
  lines: OrderLine[];
  receipts: CheckReceipt[];
  totalPaise: number;
  refund: { amountPaise: number; reference: string | null; reason: string } | null;
  corrections: Array<{ id: number; reason: string; amountPaise: number; reference: string | null; item: string; quantity: number; creditNote?: BillSnapshot }>;
}

export const dishStatuses = ['queued', 'preparing', 'ready', 'cancelled'] as const;
export type DishStatus = typeof dishStatuses[number];
export const paperOrderModes = ['live', 'served'] as const;
export type PaperOrderMode = typeof paperOrderModes[number];

export interface Staff {
  id: number;
  name: string;
  role: Role;
}

export interface MenuItem {
  id: number;
  name: string;
  pricePaise: number;
  category: string;
  available: boolean;
  description: string;
  availableAfter: number | null;
  revision: number;
  photoKey: string | null;
}

export type GuestMenuItem = Pick<MenuItem, 'id' | 'name' | 'pricePaise' | 'category' | 'available' | 'description' | 'availableAfter' | 'photoKey'>;
export type GuestMenuTheme = 'classic' | 'photo-led';
export interface GuestMenu {
  items: GuestMenuItem[];
  sampleArtwork?: boolean;
  name?: string;
  theme?: GuestMenuTheme;
  publishedAt?: string;
}
export interface MenuPublicationStatus {
  configured: boolean;
  pending: boolean;
  publishedAt: number | null;
}
export interface TableQrDestination {
  url: string;
  preview: boolean;
}
export const maxMenuPhotoBytes = 4 * 1024 * 1024;

export function menuPhotoPath(id: number, key: string) {
  return `/media/menu/${id}/${key}`;
}

export interface MenuItemDetails {
  name: string;
  category: string;
  description: string;
  pricePaise: number;
}

export interface MenuAvailability {
  available: boolean;
  availableAfter: number | null;
  revision: number;
}

export interface OrderLine {
  id: number;
  name: string;
  pricePaise: number;
  quantity: number;
  note: string;
  status: DishStatus;
  revision: number;
  change: DishChange | null;
  entrySource: 'waiter' | 'paper-live' | 'paper-served';
}

export interface DishChangeRequest {
  requestId: string;
  revision: number;
  quantity: number;
  note: string;
}

export interface DishChange {
  id: number;
  quantity: number;
  note: string;
  outcome: 'pending' | 'applied' | 'declined' | 'expired';
}

export interface Table {
  id: number;
  label: string;
  waiter: { id: number; name: string } | null;
  orderId: number | null;
  lines: OrderLine[];
  splitId: number | null;
  checks: SplitCheck[];
  checkVersion: string | null;
  receipts: CheckReceipt[];
  hasReceipt: boolean;
  canRelease: boolean;
}

export const paymentMethods = ['Cash', 'UPI', 'Card', 'Mixed', 'Other'] as const;
export type PaymentMethod = typeof paymentMethods[number];

export interface CheckReceipt {
  bill?: BillSnapshot;
  checkNumber: number;
  reference: string;
  officialTotalPaise: number;
  paymentMethod: PaymentMethod | null;
  coupon?: CouponQuote;
  feedback?: { code: string; expiresAt: number; published: boolean; guestUrl?: string };
}

export interface CheckIdentity {
  orderId: number;
  splitId: number | null;
  checkNumber: number;
  checkVersion: string;
}

export type ReceiptRequest = Omit<CheckReceipt, 'feedback' | 'bill'> & CheckIdentity;

export interface PrivateFeedback {
  id: string;
  rating: number;
  comment: string;
  receivedAt: string;
}

export interface CouponQuote {
  code: string;
  discountPaise: number;
}

export interface Coupon extends CouponQuote {
  minimumPaise: number;
  expiresAt: number | null;
  enabled: boolean;
  publicTitle?: string;
}

export interface PublicOffer {
  id: string;
  title: string;
  discountPaise: number;
  minimumPaise: number;
  expiresAt: number | null;
  enabled: boolean;
}

export interface OfferClaim {
  offerId: string;
  title: string;
  status: 'waiting' | 'ready' | 'redeemed' | 'unavailable';
  code?: string;
}

export interface CheckItem {
  lineId: number;
  quantity: number;
}

export interface SplitCheck {
  items: CheckItem[];
  totalPaise: number;
}

export interface SplitRequest {
  orderId: number;
  requestId: string;
  lineVersions: Array<{ lineId: number; revision: number }>;
  checks: CheckItem[][];
}

export interface ServiceState {
  billingProfile?: BillingProfile;
  tableCancellations?: Array<{orderId:number;tableLabel:string}>;
  resolutions?: Array<{orderId:number;tableLabel:string;amountPaise:number;reason:string;at:number;owner:string}>;
  settings: OutletSettings;
  counterOrders: CounterOrder[];
  sampleArtwork?: boolean;
  staff: Staff;
  menu: MenuItem[];
  tables: Table[];
  waiters: Array<Pick<Staff, 'id' | 'name'>>;
  publication?: MenuPublicationStatus;
  tableQr?: TableQrDestination;
}

export interface OrderRequest {
  requestId: string;
  expectedOrderId?: number | null;
  lines: Array<{ menuId: number; quantity: number; note?: string; expectedPricePaise?: number }>;
}

export interface PaperOrderDetails {
  mode: PaperOrderMode;
  creditedWaiterId: number;
}

export interface PaperOrderRequest extends OrderRequest, PaperOrderDetails {
  expectedOrderId: number | null;
}

export const reportPeriods = ['day', 'week', 'month'] as const;
export type ReportPeriod = typeof reportPeriods[number];

export interface WaiterActivityRow {
  waiterId: number;
  name: string;
  enabled: boolean;
  ordersHandled: number;
  orderEntries: number;
  livePaperEntries: number;
  servedPaperEntries: number;
  estimatedEntries: number;
}

export interface WaiterActivityReport {
  counter: Array<{
    cashier: string; fulfillment: 'dine-in' | 'takeaway'; orders: number; itemTotalPaise: number;
    officialTotalPaise: number; cancelled: number; refundNeededPaise: number; refundedPaise: number;
  }>;
  period: ReportPeriod;
  anchorDate: string;
  startDate: string;
  endDate: string;
  timezone: 'Asia/Kolkata';
  rows: WaiterActivityRow[];
}

export interface PlacementRequest {
  orderId: number;
  waiterId: number;
  action: 'move' | 'transfer' | 'join';
  destinationId: number;
  destinationOrderId?: number;
}

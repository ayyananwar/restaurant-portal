import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyRequest } from 'fastify';
import { maxMenuPhotoBytes, paperOrderModes, paymentMethods, reportPeriods, type CheckIdentity, type Coupon, type DishChangeRequest, type MenuAvailability, type MenuItemDetails, type OrderRequest, type PaperOrderRequest, type PlacementRequest, type ReceiptRequest, type ReportPeriod, type Role, type SplitRequest, type Staff } from '../shared/contracts.js';
import { reopenSplit, saveSplit } from './check-splits.js';
import { quoteBuiltInBill, quoteCoupon, recordBuiltInBill, recordReceipt, releaseTable } from './receipt-handoff.js';
import { readBillingProfile, saveBillingProfile } from './billing.js';
import type { BillBuyer, BillingProfile, BuiltInBillRequest } from '../shared/contracts.js';
import { createCoupon, readCouponRedemptions, readCoupons, setCouponEnabled } from './coupons.js';
import { correctReadyDish, requestDishChange, resolveDishChange } from './order-changes.js';
import { readWaiterActivity } from './waiter-activity.js';
import { createMenuItem, setMenuAvailability, updateMenuItem } from './menu-catalog.js';
import { readMenuPhoto, updateMenuPhoto } from './menu-photo.js';
import { publicationStatus, publicationTarget, readGuestMenu } from './menu-publication.js';
import { renderTableQr } from './table-qr.js';
import { loadPrivateFeedback } from './receipt-feedback.js';
import { acknowledgeCounterCancellation, createCounterOrder, finishCounterOrder, payCounterOrder, readCounterOrders, readSettings, updateSettings } from './counter-service.js';
import { serviceModes, type CounterDraft, type CounterPayment, type OutletSettings } from '../shared/contracts.js';
import { roles } from '../shared/contracts.js';
import { addStaffAccount, readStaffAccounts, resetStaffPassword, saveTable, updateStaffAccount } from './outlet-management.js';
import { resolveTableBalance, tableResolutionQuote } from './table-resolution.js';
import { authenticate, billableLines, checkVersion, readMenu, readTables, readWaiters, submitOrder, updateDish, updatePlacement, WorkflowError } from './store.js';

const integerId = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const revisionSchema = { ...integerId, minimum: 0 };
const requestIdSchema = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
const moneySchema = { type: 'integer', minimum: 0, maximum: 99_999_999_999 };
const couponCode = { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{2,23}$' };
const couponInput = { type: 'string', minLength: 1, maxLength: 32 };
const positiveMoney = { ...moneySchema, minimum: 1 };
const buyerSchema = {
  type: 'object', additionalProperties: false, required: ['name','address','gstin','placeState'], properties: {
    name: { type: 'string', maxLength: 100 }, address: { type: 'string', maxLength: 600 },
    gstin: { type: 'string', maxLength: 15 }, placeState: { type: 'string', pattern: '^[0-9]{2}$' }
  }
};
const billReviewFields = { buyer: buyerSchema, couponCode: { type: 'string', maxLength: 32 } };
const reviewHashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const checkIdentityFields = {
  orderId: integerId, splitId: { anyOf: [integerId, { type: 'null' }] },
  checkNumber: { type: 'integer', minimum: 1, maximum: 8 },
  checkVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' }
};
const menuFields = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  category: { type: 'string', minLength: 1, maxLength: 60 },
  description: { type: 'string', maxLength: 600 },
  pricePaise: moneySchema
};

const loginSchema = {
  type: 'object', additionalProperties: false, required: ['username', 'password'],
  properties: {
    username: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
    password: { type: 'string', minLength: 1, maxLength: 128 }
  }
};
const orderSchema = {
  type: 'object', additionalProperties: false, required: ['requestId', 'lines'],
  properties: {
    requestId: requestIdSchema,
    expectedOrderId: { anyOf: [integerId, { type: 'null' }] },
    lines: {
      type: 'array', minItems: 1, maxItems: 50,
      items: {
        type: 'object', additionalProperties: false, required: ['menuId', 'quantity'],
        properties: {
          menuId: integerId,
          quantity: { type: 'integer', minimum: 1, maximum: 99 },
          note: { type: 'string', maxLength: 300 },
          expectedPricePaise: moneySchema
        }
      }
    }
  }
};
const idSchema = {
  type: 'object', required: ['id'],
  properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } }
};
const sessionDuration = 12 * 60 * 60 * 1000;
const assetDir = new URL('../client/', import.meta.url);

function sessionHash(request: FastifyRequest) {
  const token = request.headers.cookie?.match(/(?:^|;\s*)staff_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token ? createHash('sha256').update(token).digest('hex') : '';
}

export function buildApp(db: DatabaseSync, options: {
  origin: string;
  sampleArtwork?: boolean;
  tls?: { key: Buffer; cert: Buffer };
  logger?: boolean;
  publication?: ReturnType<typeof publicationTarget>;
  tableQrPreview?: string;
}) {
  const origin = new URL(options.origin);
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${options.tls ? '; Secure' : ''}`;
  const app = Fastify({
    logger: options.logger ?? false,
    ...(options.tls ? { https: options.tls } : {}),
    bodyLimit: 24_576,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }
  });
  const attempts = new Map<string, { count: number; expires: number }>();

  function tableQrDestination() {
    if (options.publication) {
      if (publicationStatus(db, options.publication).publishedAt !== null) return { url: options.publication.guestUrl, preview: false };
    } else if (options.tableQrPreview) return { url: options.tableQrPreview, preview: true };
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
    if (request.headers.host !== origin.host) throw new WorkflowError(403, 'Unexpected host.');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if ((request.headers.origin && request.headers.origin !== origin.origin)
        || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new WorkflowError(403, 'Cross-site requests are blocked.');
      }
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
        throw new WorkflowError(415, 'Use a JSON request.');
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkflowError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof Error) {
      if ('validation' in error) return reply.code(400).send({ error: 'Check the values and try again.' });
      if ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
        return reply.code(error.statusCode).send({ error: 'The request could not be accepted.' });
      }
    }
    request.log.error('Restaurant request failed');
    return reply.code(500).send({ error: 'The restaurant service could not complete the request.' });
  });

  function requireStaff(request: FastifyRequest, role?: Role): Staff {
    const staff = db.prepare(`
      SELECT u.id, u.name, u.role FROM sessions s JOIN staff u ON u.id = s.staff_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1
    `).get(sessionHash(request), Date.now()) as Staff | undefined;
    if (!staff) throw new WorkflowError(401, 'Sign in to continue.');
    if (role && staff.role !== role) throw new WorkflowError(403, 'This account cannot do that.');
    return staff;
  }

  let activeLogins = 0;
  app.post<{ Body: { username: string; password: string } }>('/api/session', {
    schema: { body: loginSchema }
  }, async (request, reply) => {
    const now = Date.now();
    for (const [ip, value] of attempts) if (value.expires <= now) attempts.delete(ip);
    const limit = attempts.get(request.ip) ?? { count: 0, expires: now + 5 * 60_000 };
    if (limit.count >= 10 || (!attempts.has(request.ip) && attempts.size >= 500)) {
      return reply.header('Retry-After', '300').code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    if (activeLogins >= 4) {
      return reply.header('Retry-After', '1').code(429).send({ error: 'Sign-in is busy. Try again in a moment.' });
    }
    limit.count++;
    attempts.set(request.ip, limit);
    activeLogins++;
    const staff = await authenticate(db, request.body.username, request.body.password).finally(() => activeLogins--);
    if (!staff) throw new WorkflowError(401, 'Incorrect username or password.');
    attempts.delete(request.ip);
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?').run(now, sessionHash(request));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
      createHash('sha256').update(token).digest('hex'), staff.id, now + sessionDuration
    );
    return reply.header('Set-Cookie', `staff_session=${token}; ${cookieFlags}; Max-Age=${sessionDuration / 1000}`)
      .send({ staff });
  });

  app.post('/api/session/logout', (request, reply) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(request));
    return reply.header('Set-Cookie', `staff_session=; ${cookieFlags}; Max-Age=0`).code(204).send();
  });

  app.get('/api/service', (request, reply) => {
    const staff = requireStaff(request);
    return reply.send({
      staff,
      ...(options.sampleArtwork ? { sampleArtwork: true } : {}),
      menu: readMenu(db),
      waiters: staff.role === 'waiter' || staff.role === 'billing' ? readWaiters(db) : [],
      tables: readTables(db, staff, options.publication),
      settings: readSettings(db),
      counterOrders: readCounterOrders(db, staff, options.publication),
      ...(['admin','billing'].includes(staff.role) ? { billingProfile: readBillingProfile(db) } : {}),
      ...(staff.role==='admin'?{ resolutions:db.prepare(`SELECT r.order_id AS orderId,r.table_label AS tableLabel,
        r.amount_paise AS amountPaise,r.reason,r.at,s.name AS owner FROM table_resolutions r JOIN staff s ON s.id=r.owner_id
        ORDER BY r.at DESC,r.order_id DESC LIMIT 100`).all() }:{}),
      ...(staff.role==='kitchen'?{tableCancellations:db.prepare('SELECT order_id AS orderId,table_label AS tableLabel FROM table_resolutions WHERE kitchen_ack_at IS NULL ORDER BY at').all()}:{}),
      ...(staff.role === 'admin' ? { publication: publicationStatus(db, options.publication), tableQr: tableQrDestination() } : {})
    });
  });

  app.put<{Body:BillingProfile}>('/api/outlet/billing', { schema: { body: {
    type:'object', additionalProperties:false,
    required:['enabled','revision','legalName','address','stateCode','gstin','taxMode','rateBasisPoints','pricesIncludeTax','classification','series','testMode'],
    properties:{enabled:{type:'boolean'},revision:revisionSchema,legalName:{type:'string',maxLength:150},address:{type:'string',maxLength:600},
      stateCode:{type:'string',pattern:'^[0-9]{2}$'},gstin:{type:'string',maxLength:15},taxMode:{enum:['none','gst','composition']},
      rateBasisPoints:{type:'integer',minimum:0,maximum:2800},pricesIncludeTax:{type:'boolean'},classification:{type:'string',maxLength:8},
      series:{type:'string',pattern:'^[A-Z0-9]{1,4}$'},testMode:{type:'boolean'}}
  }}},(request,reply)=>{saveBillingProfile(db,requireStaff(request,'admin'),request.body);return reply.code(204).send();});

  app.get<{Querystring:{offset?:string;search?:string}}>('/api/bills',{schema:{querystring:{
    type:'object',additionalProperties:false,properties:{offset:{type:'string',pattern:'^(0|[1-9][0-9]{0,6})$'},search:{type:'string',maxLength:32}}
  }}},request=>{
    const staff=requireStaff(request);
    if(!['admin','billing'].includes(staff.role)) throw new WorkflowError(403,'Only the owner and billing staff can view saved bills.');
    const rows=db.prepare(`SELECT number,snapshot FROM (
      SELECT number,snapshot FROM built_in_bills UNION ALL SELECT number,snapshot FROM built_in_credit_notes
    ) WHERE instr(number,?)>0 ORDER BY json_extract(snapshot,'$.issuedAt') DESC,number DESC LIMIT 51 OFFSET ?`)
      .all((request.query.search??'').trim().toUpperCase(),Number(request.query.offset??0));
    return {bills:rows.slice(0,50).map(row=>JSON.parse(String(row.snapshot))),hasMore:rows.length>50};
  });

  app.patch<{ Body: OutletSettings }>('/api/outlet/settings', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['mode','revision'],
    properties: { mode: { enum: serviceModes }, revision: revisionSchema, changePolicy: { enum: ['approval','blocked'] } }
  } } }, (request, reply) => {
    updateSettings(db, requireStaff(request, 'admin'), request.body);
    return reply.code(204).send();
  });
  app.get<{Params:{id:string};Querystring:{orderId:string}}>('/api/tables/:id/resolution',{schema:{
    params:idSchema,querystring:{type:'object',additionalProperties:false,required:['orderId'],properties:{orderId:{type:'string',pattern:'^[1-9][0-9]{0,14}$'}}}
  }},request=>{
    requireStaff(request,'admin');
    return tableResolutionQuote(db,Number(request.params.id),Number(request.query.orderId));
  });
  app.post<{Params:{id:string};Body:{orderId:number;version:string;reason:string}}>('/api/tables/:id/resolution',{schema:{
    params:idSchema,body:{type:'object',additionalProperties:false,required:['orderId','version','reason'],properties:{
      orderId:integerId,version:{type:'string',pattern:'^[a-f0-9]{64}$'},reason:{type:'string',minLength:1,maxLength:500}
    }}
  }},(request,reply)=>{
    resolveTableBalance(db,requireStaff(request,'admin'),Number(request.params.id),request.body);
    return reply.code(204).send();
  });
  app.post<{Params:{id:string}}>('/api/orders/:id/resolution-ack',{schema:{params:idSchema,body:{type:'object',additionalProperties:false,properties:{}}}},
    (request,reply)=>{
      requireStaff(request,'kitchen');
      if(!db.prepare('UPDATE table_resolutions SET kitchen_ack_at=COALESCE(kitchen_ack_at,?) WHERE order_id=?').run(Date.now(),Number(request.params.id)).changes) {
        throw new WorkflowError(404,'Resolution notice not found.');
      }
      return reply.code(204).send();
    });

  app.get('/api/outlet/staff', request => {
    requireStaff(request,'admin');
    return { staff:readStaffAccounts(db) };
  });
  app.post<{ Body:{username:string;name:string;role:Role} }>('/api/outlet/staff', { schema:{ body:{
    type:'object',additionalProperties:false,required:['username','name','role'],
    properties:{username:{type:'string',pattern:'^[a-z0-9_-]{1,32}$'},name:{type:'string',minLength:1,maxLength:100},role:{enum:roles}}
  } } }, request => addStaffAccount(db,requireStaff(request,'admin'),request.body));
  app.patch<{ Params:{id:string};Body:{enabled:boolean} }>('/api/outlet/staff/:id',{schema:{params:idSchema,body:{
    type:'object',additionalProperties:false,required:['enabled'],properties:{enabled:{type:'boolean'}}
  }}},(request,reply)=>{
    updateStaffAccount(db,requireStaff(request,'admin'),Number(request.params.id),request.body.enabled);
    return reply.code(204).send();
  });
  app.post<{ Params:{id:string} }>('/api/outlet/staff/:id/password',{schema:{params:idSchema,body:{
    type:'object',additionalProperties:false,properties:{}
  }}},request=>resetStaffPassword(db,requireStaff(request,'admin'),Number(request.params.id)));
  const tableBody = {type:'object',additionalProperties:false,required:['label'],properties:{label:{type:'string',minLength:1,maxLength:60}}};
  app.post<{Body:{label:string}}>('/api/outlet/tables',{schema:{body:tableBody}},(request,reply)=>{
    saveTable(db,requireStaff(request,'admin'),request.body.label);
    return reply.code(204).send();
  });
  app.patch<{Params:{id:string};Body:{label:string}}>('/api/outlet/tables/:id',{schema:{params:idSchema,body:tableBody}},(request,reply)=>{
    saveTable(db,requireStaff(request,'admin'),request.body.label,Number(request.params.id));
    return reply.code(204).send();
  });

  app.post<{ Body: CounterDraft }>('/api/counter-orders', { schema: { body: {
    ...orderSchema,
    required: ['requestId','lines','fulfillment','customer','seating','paper','paperReference'],
    properties: {
      ...orderSchema.properties,
      fulfillment: { enum: ['dine-in','takeaway'] }, customer: { type: 'string', maxLength: 100 },
      seating: { type: 'string', maxLength: 60 }, paper: { enum: ['none','live','served'] },
      paperReference: { type: 'string', maxLength: 100 }
    }
  } } }, (request, reply) => reply.send({ orderId: createCounterOrder(db, requireStaff(request, 'billing'), request.body) }));

  app.post<{ Params: { id: string }; Body: CounterPayment }>('/api/counter-orders/:id/payment', { schema: {
    params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['requestId','revision','reference','officialTotalPaise','paymentMethod'],
      properties: {
        requestId: requestIdSchema, revision: revisionSchema, reference: { type: 'string', minLength: 1, maxLength: 100 },
        officialTotalPaise: moneySchema, paymentMethod: { enum: paymentMethods },
        builtIn: { type:'object',additionalProperties:false,required:['reviewHash','buyer','couponCode'],
          properties:{reviewHash:reviewHashSchema,...billReviewFields} },
        coupon: { type: 'object', additionalProperties: false, required: ['code','discountPaise'], properties: { code: couponInput, discountPaise: positiveMoney } }
      }
    }
  } }, (request, reply) => reply.send({
    orderId: payCounterOrder(db, requireStaff(request, 'billing'), Number(request.params.id), request.body, options.publication?.endpoint)
  }));
  app.post<{Params:{id:string};Body:{revision:number;buyer:BillBuyer;couponCode:string}}>('/api/counter-orders/:id/bill-quote',{schema:{
    params:idSchema,body:{type:'object',additionalProperties:false,required:['revision','buyer','couponCode'],
      properties:{revision:revisionSchema,...billReviewFields}}
  }},request=>{
    requireStaff(request,'billing');
    const id=Number(request.params.id);
    const order=db.prepare('SELECT revision FROM counter_orders WHERE order_id=?').get(id);
    if(!order||order.revision!==request.body.revision) throw new WorkflowError(409,'This counter order changed. Review its current details.');
    return quoteBuiltInBill(db,null,{orderId:id,splitId:null,checkNumber:1,checkVersion:checkVersion(billableLines(db,id))},
      request.body.buyer,request.body.couponCode,options.publication?.endpoint);
  });
  app.post<{Params:{id:string};Body:DishChangeRequest & {reason:string}}>('/api/dishes/:id/correction',{schema:{
    params:idSchema,body:{type:'object',additionalProperties:false,required:['requestId','revision','quantity','note','reason'],properties:{
      requestId:requestIdSchema,revision:revisionSchema,quantity:{type:'integer',minimum:0,maximum:99},
      note:{type:'string',maxLength:300},reason:{type:'string',minLength:1,maxLength:500}
    }}
  }},request=>correctReadyDish(db,Number(request.params.id),requireStaff(request,'billing'),request.body));

  app.post<{ Params: { id: string }; Body: { revision: number; code: string } }>('/api/counter-orders/:id/coupon', { schema: {
    params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['revision','code'],
      properties: { revision: revisionSchema, code: couponInput }
    }
  } }, (request, reply) => {
    requireStaff(request, 'billing');
    const orderId = Number(request.params.id);
    const current = readCounterOrders(db, { id: 0, name: '', role: 'billing' }).find(order => order.id === orderId);
    if (!current || current.revision !== request.body.revision || current.status !== 'awaiting-payment') throw new WorkflowError(409, 'Open the current unpaid order.');
    return reply.send(quoteCoupon(db, null, { orderId, splitId: null, checkNumber: 1, code: request.body.code,
      checkVersion: checkVersion(billableLines(db, orderId)) }, options.publication?.endpoint));
  });

  app.post<{ Params: { id: string }; Body: Parameters<typeof finishCounterOrder>[3] }>('/api/counter-orders/:id/action', { schema: {
    params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['requestId','revision','action','reason','reference'],
      properties: {
        requestId: requestIdSchema, revision: revisionSchema, action: { enum: ['collect','cancel','refund','reduce'] },
        reason: { type: 'string', maxLength: 500 }, reference: { type: 'string', maxLength: 100 },
        lineId: integerId, quantity: { type:'integer',minimum:1,maximum:99 }, amountPaise: moneySchema
      }
    }
  } }, (request, reply) => reply.send({
    orderId: finishCounterOrder(db, requireStaff(request, 'billing'), Number(request.params.id), request.body)
  }));
  app.post<{Params:{id:string}}>('/api/counter-orders/:id/kitchen-ack',{schema:{params:idSchema,body:{
    type:'object',additionalProperties:false,properties:{}
  }}},(request,reply)=>{
    acknowledgeCounterCancellation(db,requireStaff(request,'kitchen'),Number(request.params.id));
    return reply.code(204).send();
  });

  app.post<{ Body: MenuItemDetails & { requestId: string } }>('/api/menu', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: [...Object.keys(menuFields), 'requestId'],
      properties: { ...menuFields, requestId: requestIdSchema }
    } }
  }, (request, reply) => {
    requireStaff(request, 'admin');
    return reply.send({ id: createMenuItem(db, request.body.requestId, request.body) });
  });

  app.patch<{ Params: { id: string }; Body: MenuItemDetails & { revision: number } }>('/api/menu/:id', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: [...Object.keys(menuFields), 'revision'],
      properties: { ...menuFields, revision: revisionSchema }
    } }
  }, (request, reply) => {
    requireStaff(request, 'admin');
    updateMenuItem(db, Number(request.params.id), request.body.revision, request.body);
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string }; Body: MenuAvailability }>('/api/menu/:id/availability', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['available', 'availableAfter', 'revision'],
      properties: { available: { type: 'boolean' }, availableAfter: {
        anyOf: [{ type: 'integer', minimum: 1, maximum: 4_102_444_800_000 }, { type: 'null' }]
      }, revision: revisionSchema }
    } }
  }, (request, reply) => {
    const staff = requireStaff(request);
    if (staff.role !== 'kitchen' && staff.role !== 'admin') throw new WorkflowError(403, 'Only the kitchen or admin can update availability.');
    setMenuAvailability(db, Number(request.params.id), request.body);
    return reply.code(204).send();
  });

  const maxEncodedPhoto = Math.ceil(maxMenuPhotoBytes / 3) * 4;
  let activePhotoWrites = 0;
  app.patch<{ Params: { id: string }; Body: { revision: number; encoded: string | null } }>('/api/menu/:id/photo', {
    bodyLimit: maxEncodedPhoto + 1024,
    onRequest: async request => { requireStaff(request, 'admin'); },
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['revision', 'encoded'],
      properties: { revision: revisionSchema, encoded: { anyOf: [
        { type: 'string', minLength: 4, maxLength: maxEncodedPhoto }, { type: 'null' }
      ] } }
    } }
  }, async (request, reply) => {
    if (activePhotoWrites >= 2) throw new WorkflowError(429, 'Photo processing is busy. Try again in a moment.');
    activePhotoWrites++;
    try {
      await updateMenuPhoto(db, Number(request.params.id), request.body.revision, request.body.encoded);
      return reply.code(204).send();
    } finally {
      activePhotoWrites--;
    }
  });

  app.get('/api/guest-menu', () => ({
    items: readGuestMenu(db),
    ...(options.sampleArtwork ? { sampleArtwork: true } : {})
  }));

  app.get('/api/menu/publication', request => {
    requireStaff(request, 'admin');
    return publicationStatus(db, options.publication);
  });

  app.get('/api/feedback', async request => {
    requireStaff(request, 'admin');
    if (!options.publication) return { configured: false, feedback: [] };
    try {
      return { configured: true, ...(await loadPrivateFeedback(options.publication)) };
    } catch {
      throw new WorkflowError(503, 'Feedback could not load. Check the internet connection and try again.');
    }
  });

  app.get<{ Params: { id: string } }>('/api/tables/:id/qr', { schema: { params: idSchema } }, async (request, reply) => {
    requireStaff(request, 'admin');
    const destination = tableQrDestination();
    if (!destination) throw new WorkflowError(409, 'Publish the guest menu before creating table cards.');
    const id = Number(request.params.id);
    if (!db.prepare('SELECT 1 FROM dining_tables WHERE id = ?').get(id)) throw new WorkflowError(404, 'Table not found.');
    return reply.type('image/svg+xml; charset=utf-8').send(await renderTableQr(destination.url, id));
  });

  app.get<{ Params: { id: string; key: string } }>('/media/menu/:id/:key', {
    schema: { params: {
      ...idSchema, required: ['id', 'key'], properties: { ...idSchema.properties, key: { type: 'string', pattern: '^[a-f0-9]{64}$' } }
    } }
  }, (request, reply) => {
    const photo = readMenuPhoto(db, Number(request.params.id), request.params.key);
    if (!photo) return reply.code(404).send();
    return reply.type('image/webp').send(photo);
  });

  app.get<{ Querystring: { period: ReportPeriod; date?: string } }>('/api/reports/waiter-activity', {
    schema: { querystring: {
      type: 'object', additionalProperties: false, required: ['period'],
      properties: { period: { type: 'string', enum: reportPeriods }, date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' } }
    } }
  }, (request, reply) => {
    requireStaff(request, 'admin');
    return reply.send(readWaiterActivity(db, request.query.period, request.query.date));
  });

  app.post<{ Params: { id: string }; Body: PlacementRequest }>('/api/tables/:id/placement', {
    schema: {
      params: idSchema,
      body: {
        type: 'object', additionalProperties: false, required: ['orderId', 'waiterId', 'action', 'destinationId'],
        properties: {
          orderId: integerId, waiterId: integerId, action: { type: 'string', enum: ['move', 'transfer', 'join'] },
          destinationId: integerId, destinationOrderId: integerId
        }
      }
    }
  }, (request, reply) => {
    updatePlacement(db, Number(request.params.id), requireStaff(request), request.body);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: SplitRequest }>('/api/tables/:id/split', {
    bodyLimit: 256_000,
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['orderId', 'requestId', 'lineVersions', 'checks'],
      properties: {
        orderId: integerId, requestId: requestIdSchema, lineVersions: {
          type: 'array', minItems: 1, maxItems: 500, items: {
            type: 'object', additionalProperties: false, required: ['lineId', 'revision'],
            properties: { lineId: integerId, revision: revisionSchema }
          }
        }, checks: {
          type: 'array', minItems: 2, maxItems: 8, items: {
            type: 'array', minItems: 1, maxItems: 500, items: {
              type: 'object', additionalProperties: false, required: ['lineId', 'quantity'],
              properties: { lineId: integerId, quantity: { type: 'integer', minimum: 1, maximum: 99 } }
            }
          }
        }
      }
    } }
  }, (request, reply) => {
    saveSplit(db, Number(request.params.id), requireStaff(request, 'billing').id, request.body);
    return reply.code(204).send();
  });

  app.get('/api/coupons', request => {
    requireStaff(request, 'admin');
    return { coupons: readCoupons(db), redemptions: readCouponRedemptions(db) };
  });

  app.post<{ Body: Omit<Coupon, 'enabled'> }>('/api/coupons', {
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['code', 'discountPaise', 'minimumPaise', 'expiresAt'], properties: {
        code: couponInput, discountPaise: positiveMoney, minimumPaise: moneySchema, publicTitle: { type: 'string', maxLength: 100 },
        expiresAt: { anyOf: [{ ...integerId, maximum: 8_640_000_000_000_000 }, { type: 'null' }] }
      }
    } }
  }, (request, reply) => {
    requireStaff(request, 'admin');
    createCoupon(db, request.body);
    return reply.code(204).send();
  });

  app.patch<{ Params: { code: string }; Body: { enabled: boolean } }>('/api/coupons/:code', {
    schema: {
      params: { type: 'object', required: ['code'], properties: { code: couponCode } },
      body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } }
    }
  }, (request, reply) => {
    requireStaff(request, 'admin');
    setCouponEnabled(db, request.params.code, request.body.enabled);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: CheckIdentity & { code: string } }>('/api/tables/:id/coupon-quote', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: [...Object.keys(checkIdentityFields), 'code'],
      properties: { ...checkIdentityFields, code: couponInput }
    } }
  }, request => {
    requireStaff(request, 'billing');
    return quoteCoupon(db, Number(request.params.id), request.body, options.publication?.endpoint);
  });

  app.post<{ Params: { id: string }; Body: ReceiptRequest }>('/api/tables/:id/receipts', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false,
      required: ['orderId', 'splitId', 'checkNumber', 'checkVersion', 'reference', 'officialTotalPaise', 'paymentMethod'],
      properties: {
        ...checkIdentityFields,
        reference: { type: 'string', minLength: 1, maxLength: 100 },
        officialTotalPaise: moneySchema,
        paymentMethod: { anyOf: [{ type: 'string', enum: paymentMethods }, { type: 'null' }] },
        coupon: { type: 'object', additionalProperties: false, required: ['code', 'discountPaise'],
          properties: { code: couponCode, discountPaise: positiveMoney } }
      }
    } }
  }, (request, reply) => {
    recordReceipt(db, Number(request.params.id), requireStaff(request, 'billing').id, request.body, options.publication?.endpoint);
    return reply.code(204).send();
  });

  app.post<{Params:{id:string};Body:CheckIdentity & {buyer:BillBuyer;couponCode:string}}>('/api/tables/:id/bill-quote',{schema:{
    params:idSchema,body:{type:'object',additionalProperties:false,required:[...Object.keys(checkIdentityFields),'buyer','couponCode'],
      properties:{...checkIdentityFields,...billReviewFields}}
  }},request=>{
    requireStaff(request,'billing');
    return quoteBuiltInBill(db,Number(request.params.id),request.body,request.body.buyer,request.body.couponCode,options.publication?.endpoint);
  });
  app.post<{Params:{id:string};Body:BuiltInBillRequest}>('/api/tables/:id/bills',{schema:{
    params:idSchema,body:{type:'object',additionalProperties:false,
      required:[...Object.keys(checkIdentityFields),'buyer','couponCode','requestId','reviewHash','paymentMethod'],
      properties:{...checkIdentityFields,...billReviewFields,requestId:requestIdSchema,reviewHash:reviewHashSchema,
        paymentMethod:{anyOf:[{enum:paymentMethods},{type:'null'}]}}}
  }},request=>recordBuiltInBill(db,Number(request.params.id),requireStaff(request,'billing').id,request.body,options.publication?.endpoint));

  app.post<{ Params: { id: string }; Body: { orderId: number } }>('/api/tables/:id/release', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['orderId'], properties: { orderId: integerId }
    } }
  }, (request, reply) => {
    releaseTable(db, Number(request.params.id), request.body.orderId, requireStaff(request, 'waiter').id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { orderId: number; splitId: number } }>('/api/tables/:id/split/reopen', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['orderId', 'splitId'],
      properties: { orderId: integerId, splitId: integerId }
    } }
  }, (request, reply) => {
    reopenSplit(db, Number(request.params.id), requireStaff(request, 'billing').id, request.body.orderId, request.body.splitId);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: OrderRequest }>('/api/tables/:id/orders', {
    schema: { params: idSchema, body: orderSchema }
  }, (request, reply) => {
    const staff = requireStaff(request, 'waiter');
    const orderId = submitOrder(db, Number(request.params.id), staff.id, request.body);
    return reply.send({ orderId });
  });

  app.post<{ Params: { id: string }; Body: PaperOrderRequest }>('/api/tables/:id/paper-orders', {
    schema: { params: idSchema, body: {
      ...orderSchema,
      required: [...orderSchema.required, 'expectedOrderId', 'creditedWaiterId', 'mode'],
      properties: {
        ...orderSchema.properties, creditedWaiterId: integerId, mode: { type: 'string', enum: paperOrderModes }
      }
    } }
  }, (request, reply) => {
    const staff = requireStaff(request, 'billing');
    const { mode, creditedWaiterId, ...order } = request.body;
    const orderId = submitOrder(db, Number(request.params.id), staff.id, order, { mode, creditedWaiterId });
    return reply.send({ orderId });
  });

  app.post<{ Params: { id: string }; Body: DishChangeRequest }>('/api/dishes/:id/changes', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['requestId', 'revision', 'quantity', 'note'],
      properties: {
        requestId: requestIdSchema, revision: revisionSchema,
        quantity: { type: 'integer', minimum: 0, maximum: 99 }, note: { type: 'string', maxLength: 300 }
      }
    } }
  }, (request, reply) => {
    return reply.send(requestDishChange(db, Number(request.params.id), requireStaff(request, 'waiter'), request.body));
  });

  app.patch<{ Params: { id: string }; Body: { approve: boolean } }>('/api/dish-changes/:id', {
    schema: { params: idSchema, body: {
      type: 'object', additionalProperties: false, required: ['approve'],
      properties: { approve: { type: 'boolean' } }
    } }
  }, (request, reply) => {
    resolveDishChange(db, Number(request.params.id), requireStaff(request, 'billing').id, request.body.approve);
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string }; Body: { status: 'preparing' | 'ready'; revision?: number } }>('/api/dishes/:id', {
    schema: {
      params: idSchema,
      body: {
        type: 'object', additionalProperties: false, required: ['status'],
        properties: { status: { type: 'string', enum: ['preparing', 'ready'] }, revision: revisionSchema }
      }
    }
  }, (request, reply) => {
    const staff = requireStaff(request, 'kitchen');
    updateDish(db, Number(request.params.id), request.body.status, staff.id, request.body.revision);
    return reply.code(204).send();
  });

  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await readFile(new URL('index.html', assetDir))));
  app.get('/guest-menu', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await readFile(new URL('guest-menu.html', assetDir))));
  app.get<{ Params: { file: string } }>('/assets/:file', async (request, reply) => {
    const file = request.params.file;
    if (!/^[a-zA-Z0-9_-]+\.(?:js|css|webp)$/.test(file)) return reply.code(404).send();
    const contents = await readFile(new URL(`assets/${file}`, assetDir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!contents) return reply.code(404).send();
    const type = file.endsWith('.webp') ? 'image/webp' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    return reply.type(type).send(contents);
  });

  return app;
}

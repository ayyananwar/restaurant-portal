import type { DatabaseSync } from 'node:sqlite';
import type { CounterDraft, CounterOrder, CounterPayment, OrderLine, OutletSettings, Staff } from '../shared/contracts.js';
import { billableLines, checkVersion, readReceipts, WorkflowError } from './store.js';
import { recordReceiptInTransaction } from './receipt-handoff.js';

export function readSettings(db: DatabaseSync): OutletSettings {
  return db.prepare('SELECT mode, revision, change_policy AS changePolicy FROM outlet_settings WHERE id=1').get() as unknown as OutletSettings;
}

export function updateSettings(db: DatabaseSync, actor: Staff, settings: Pick<OutletSettings, 'mode' | 'revision'> & { changePolicy?: OutletSettings['changePolicy'] }) {
  if (actor.role !== 'admin') throw new WorkflowError(403, 'Only the owner can change the service mode.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = readSettings(db);
    if (previous.revision !== settings.revision) throw new WorkflowError(409, 'Settings changed. Review the current mode.');
    const changePolicy = settings.changePolicy ?? previous.changePolicy;
    if (previous.mode !== settings.mode || previous.changePolicy !== changePolicy) {
      db.prepare('UPDATE outlet_settings SET mode=?, change_policy=?, revision=revision+1 WHERE id=1').run(settings.mode, changePolicy);
      db.prepare('INSERT INTO outlet_audit(actor_id,at,previous_mode,next_mode) VALUES (?,?,?,?)')
        .run(actor.id, Date.now(), previous.mode, settings.mode);
      db.prepare('INSERT INTO configuration_events(actor_id,at,action,details) VALUES (?,?,?,?)')
        .run(actor.id, Date.now(), 'service-settings', JSON.stringify({ previous, next: { mode: settings.mode, changePolicy } }));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function cashier(actor: Staff) {
  if (actor.role !== 'billing') throw new WorkflowError(403, 'Only billing staff can perform this action.');
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function replay(db: DatabaseSync, actor: Staff, requestId: string, action: string, payload: unknown) {
  const row = db.prepare('SELECT action,payload,order_id AS orderId FROM counter_requests WHERE actor_id=? AND request_id=?')
    .get(actor.id, requestId);
  if (!row) return;
  if (row.action !== action || row.payload !== JSON.stringify(payload)) throw new WorkflowError(409, 'This request was already used. Review the saved order.');
  return Number(row.orderId);
}

function remember(db: DatabaseSync, actor: Staff, requestId: string, action: string, payload: unknown, orderId: number) {
  db.prepare('INSERT INTO counter_requests(actor_id,request_id,action,payload,order_id) VALUES (?,?,?,?,?)')
    .run(actor.id, requestId, action, JSON.stringify(payload), orderId);
}

function current(db: DatabaseSync, orderId: number, revision: number) {
  const row = db.prepare(`SELECT c.*, o.closed_at FROM counter_orders c JOIN orders o ON o.id=c.order_id WHERE c.order_id=?`).get(orderId);
  if (!row) throw new WorkflowError(404, 'Counter order not found.');
  if (row.revision !== revision) throw new WorkflowError(409, 'This order changed. Review its current details.');
  return row;
}

export function createCounterOrder(db: DatabaseSync, actor: Staff, input: CounterDraft) {
  cashier(actor);
  return transaction(db, () => {
    const prior = replay(db, actor, input.requestId, 'create', input);
    if (prior !== undefined) return prior;
    if (readSettings(db).mode === 'table') throw new WorkflowError(409, 'Enable counter service before starting a counter order.');
    if (input.paper !== 'none' && !input.paperReference.trim()) throw new WorkflowError(400, 'Enter the original paper reference.');
    if (!input.lines.length || input.lines.length > 50) throw new WorkflowError(400, 'Choose between 1 and 50 dishes.');
    const items = input.lines.map(line => {
      const item = db.prepare('SELECT name, price_paise, available FROM menu WHERE id=?').get(line.menuId);
      if (!item || (input.paper !== 'served' && !item.available)) throw new WorkflowError(409, 'A dish is unavailable. Review the current menu.');
      if (line.expectedPricePaise !== item.price_paise) throw new WorkflowError(409, 'A price changed. Review the current menu.');
      return { ...line, name: String(item.name), price: Number(item.price_paise) };
    });
    const inserted = db.prepare('INSERT INTO orders(table_id,waiter_id,opened_at) VALUES (NULL,NULL,?)').run(Date.now());
    const id = Number(inserted.lastInsertRowid);
    db.prepare(`INSERT INTO counter_orders(order_id,cashier_id,fulfillment,customer,seating,paper,paper_reference) VALUES (?,?,?,?,?,?,?)`)
      .run(id, actor.id, input.fulfillment, input.customer.trim(), input.seating.trim(), input.paper, input.paperReference.trim());
    const insert = db.prepare(`INSERT INTO order_lines(order_id,menu_id,name,price_paise,quantity,note,status,entry_source) VALUES (?,?,?,?,?,?,?,?)`);
    for (const item of items) insert.run(id, item.menuId, item.name, item.price, item.quantity, item.note?.trim() ?? '',
      input.paper === 'served' ? 'ready' : 'queued', input.paper === 'served' ? 'paper-served' : input.paper === 'live' ? 'paper-live' : 'waiter');
    remember(db, actor, input.requestId, 'create', input, id);
    return id;
  });
}

export function payCounterOrder(db: DatabaseSync, actor: Staff, orderId: number, input: CounterPayment, destination?: string) {
  cashier(actor);
  return transaction(db, () => {
    const payload = { orderId, ...input };
    const prior = replay(db, actor, input.requestId, 'pay', payload);
    if (prior !== undefined) return prior;
    const order = current(db, orderId, input.revision);
    if (order.token_number !== null || order.closed_at !== null) throw new WorkflowError(409, 'This order is already paid or closed. Review its details.');
    const lines = billableLines(db, orderId);
    for (const line of db.prepare(`SELECT l.price_paise,m.price_paise AS current_price,m.available
      FROM order_lines l JOIN menu m ON m.id=l.menu_id WHERE l.order_id=? AND l.cancelled_at IS NULL`).all(orderId)) {
      if ((order.paper !== 'served' && !line.available) || line.price_paise !== line.current_price) {
        throw new WorkflowError(409, 'A price or availability changed. Cancel this unpaid order and review the current menu.');
      }
    }
    recordReceiptInTransaction(db, null, actor.id, {
      orderId, splitId: null, checkNumber: 1, checkVersion: checkVersion(lines),
      reference: input.reference, officialTotalPaise: input.officialTotalPaise, paymentMethod: input.paymentMethod, coupon: input.coupon
    }, destination);
    const date = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const number = Number(db.prepare('SELECT COALESCE(MAX(token_number),0)+1 AS next FROM counter_orders WHERE token_date=?').get(date)?.next);
    db.prepare('UPDATE counter_orders SET token_date=?,token_number=?,revision=revision+1 WHERE order_id=?').run(date, number, orderId);
    remember(db, actor, input.requestId, 'pay', payload, orderId);
    return orderId;
  });
}

export function finishCounterOrder(db: DatabaseSync, actor: Staff, orderId: number, input: {
  requestId: string; revision: number; action: 'collect' | 'cancel' | 'refund' | 'reduce'; reason: string; reference: string;
  lineId?: number; quantity?: number; amountPaise?: number;
}) {
  cashier(actor);
  return transaction(db, () => {
    const payload = { orderId, ...input };
    const prior = replay(db, actor, input.requestId, input.action, payload);
    if (prior !== undefined) return prior;
    const order = current(db, orderId, input.revision);
    if (input.action === 'collect') {
      if (order.token_number === null || order.closed_at !== null || billableLines(db, orderId).some(line => line.status !== 'ready')) {
        throw new WorkflowError(409, 'Payment and all dishes must be ready before collection.');
      }
      db.prepare('UPDATE counter_orders SET collected_at=? WHERE order_id=?').run(Date.now(), orderId);
    } else if (input.action === 'cancel' || input.action === 'reduce') {
      if (order.cancelled_at !== null || (order.closed_at !== null && order.collected_at === null) || !input.reason.trim()) {
        throw new WorkflowError(409, 'Open the current order and enter a cancellation reason.');
      }
      const receipt = readReceipts(db, orderId)[0];
      const previous = Number(db.prepare('SELECT COALESCE(SUM(amount_paise),0) AS total FROM counter_corrections WHERE order_id=?').get(orderId)?.total);
      let amount = Math.max(0, (receipt?.officialTotalPaise ?? 0) - previous);
      let item = '';
      let quantity = 0;
      if (input.action === 'reduce') {
        if (!receipt) throw new WorkflowError(409, 'Partial corrections apply to paid orders.');
        const line = db.prepare('SELECT name,quantity FROM order_lines WHERE id=? AND order_id=? AND cancelled_at IS NULL').get(input.lineId ?? 0,orderId);
        if (!line || !input.quantity || input.quantity > Number(line.quantity) || input.amountPaise === undefined || input.amountPaise > amount) {
          throw new WorkflowError(409, 'Review the current quantity and remaining refundable receipt amount.');
        }
        amount = input.amountPaise;
        item = String(line.name);
        quantity = input.quantity;
        if (quantity === line.quantity) db.prepare('UPDATE order_lines SET cancelled_at=?,revision=revision+1 WHERE id=?').run(Date.now(),input.lineId!);
        else db.prepare('UPDATE order_lines SET quantity=quantity-?,revision=revision+1 WHERE id=?').run(quantity,input.lineId!);
      } else {
        db.prepare('UPDATE order_lines SET cancelled_at=?, revision=revision+1 WHERE order_id=? AND cancelled_at IS NULL').run(Date.now(), orderId);
      }
      if (receipt) db.prepare('INSERT INTO counter_corrections(order_id,reason,amount_paise,actor_id,at,item,quantity) VALUES (?,?,?,?,?,?,?)')
        .run(orderId, input.reason.trim(), amount, actor.id, Date.now(), item, quantity);
      if (!billableLines(db,orderId).length) db.prepare('UPDATE counter_orders SET cancelled_at=? WHERE order_id=?').run(Date.now(),orderId);
    } else {
      const adjustment = db.prepare('SELECT id FROM counter_corrections WHERE order_id=? AND reference IS NULL').get(orderId);
      if (!adjustment || !input.reference.trim()) throw new WorkflowError(409, 'Enter a refund reference for an unresolved correction.');
      if (db.prepare('SELECT id FROM counter_corrections WHERE reference=? COLLATE NOCASE').get(input.reference.trim())) {
        throw new WorkflowError(409, 'That refund reference is already recorded.');
      }
      db.prepare('UPDATE counter_corrections SET reference=?, resolved_by=?,resolved_at=? WHERE order_id=? AND reference IS NULL')
        .run(input.reference.trim(), actor.id, Date.now(), orderId);
    }
    if (input.action === 'collect' || (input.action !== 'refund' && !billableLines(db,orderId).length)) {
      db.prepare('UPDATE orders SET closed_at=?, closed_by=? WHERE id=?').run(Date.now(), actor.id, orderId);
    }
    db.prepare('UPDATE counter_orders SET revision=revision+1 WHERE order_id=?').run(orderId);
    remember(db, actor, input.requestId, input.action, payload, orderId);
    return orderId;
  });
}

export function readCounterOrders(db: DatabaseSync, actor: Staff, target?: { endpoint: string; guestUrl: string }): CounterOrder[] {
  if (actor.role === 'waiter') return [];
  const rows = db.prepare(`SELECT c.*,o.opened_at,s.name AS cashier FROM counter_orders c JOIN orders o ON o.id=c.order_id
    JOIN staff s ON s.id=c.cashier_id
    WHERE o.closed_at IS NULL OR EXISTS(SELECT 1 FROM counter_corrections a WHERE a.order_id=c.order_id AND a.reference IS NULL)
      OR (c.cancelled_at IS NOT NULL AND c.collected_at IS NULL AND c.token_number IS NOT NULL AND c.kitchen_ack_at IS NULL AND c.paper<>'served')
      OR o.closed_at >= ?
    ORDER BY o.opened_at DESC, o.id DESC`).all(Date.now() - 7 * 86_400_000);
  return rows.flatMap(row => {
    if (actor.role === 'kitchen' && (row.token_number === null || row.collected_at !== null ||
      (row.cancelled_at !== null && row.kitchen_ack_at !== null) || row.paper === 'served')) return [];
    const lines = db.prepare(`SELECT id,name,price_paise AS pricePaise,quantity,note,revision,entry_source AS entrySource,
      CASE WHEN cancelled_at IS NULL THEN status ELSE 'cancelled' END AS status FROM order_lines WHERE order_id=? ORDER BY id`)
      .all(row.order_id!) as unknown as Omit<OrderLine, 'change'>[];
    const corrections = db.prepare('SELECT id,amount_paise AS amountPaise,reference,reason,item,quantity FROM counter_corrections WHERE order_id=? ORDER BY id')
      .all(row.order_id!) as unknown as CounterOrder['corrections'];
    const outstanding = corrections.filter(item => item.reference === null);
    const refund = !corrections.length ? null : {
      amountPaise: outstanding.reduce((sum,item) => sum + item.amountPaise,0),
      reference: outstanding.length ? null : corrections.at(-1)!.reference, reason: outstanding.map(item => item.reason).join(' · ')
    };
    return [{
      id: Number(row.order_id), revision: Number(row.revision), openedAt: Number(row.opened_at), cashier: String(row.cashier),
      fulfillment: row.fulfillment as CounterDraft['fulfillment'],
      customer: actor.role === 'kitchen' ? '' : String(row.customer), seating: String(row.seating),
      paper: row.paper as CounterDraft['paper'], paperReference: actor.role === 'kitchen' ? '' : String(row.paper_reference),
      token: row.token_number === null ? null : `${row.token_date} #${row.token_number}`,
      status: row.cancelled_at !== null ? 'cancelled' : row.collected_at !== null ? 'collected' : row.token_number === null ? 'awaiting-payment'
        : lines.every(line => line.status === 'ready' || line.status === 'cancelled') ? 'ready' : 'preparing',
      lines: lines.map(line => ({ ...line, change: null })),
      receipts: actor.role === 'kitchen' ? [] : readReceipts(db, Number(row.order_id), target),
      totalPaise: lines.reduce((sum, line) => line.status === 'cancelled' ? sum : sum + line.pricePaise * line.quantity, 0),
      refund: actor.role === 'kitchen' ? null : refund,
      corrections: actor.role === 'kitchen' ? corrections.map(item => ({ ...item,amountPaise:0,reference:null })) : corrections
    }];
  });
}

export function acknowledgeCounterCancellation(db: DatabaseSync, actor: Staff, orderId: number) {
  if (actor.role !== 'kitchen') throw new WorkflowError(403,'Only kitchen staff can acknowledge this cancellation.');
  const order=db.prepare('SELECT cancelled_at,token_number,kitchen_ack_at FROM counter_orders WHERE order_id=?').get(orderId);
  if (!order || order.cancelled_at===null || order.token_number===null) throw new WorkflowError(409,'This paid order has no cancellation to acknowledge.');
  if (order.kitchen_ack_at!==null) return;
  db.prepare('UPDATE counter_orders SET kitchen_ack_at=? WHERE order_id=?').run(Date.now(),orderId);
}

import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { CheckItem, CheckReceipt, DishStatus, MenuItem, OrderLine, OrderRequest, PaperOrderDetails, PlacementRequest, Role, Staff, Table } from '../shared/contracts.js';

export const storeSchemaVersion = 18;

export class WorkflowError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const passwordOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const derivePassword = promisify(scrypt) as (
  password: string, salt: string, length: number, options: typeof passwordOptions
) => Promise<Buffer>;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE staff (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'waiter', 'kitchen', 'billing')),
        password_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        staff_id INTEGER NOT NULL REFERENCES staff(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE dining_tables (id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL);
      CREATE TABLE menu (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
        available INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        table_id INTEGER NOT NULL REFERENCES dining_tables(id),
        waiter_id INTEGER NOT NULL REFERENCES staff(id),
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE UNIQUE INDEX active_table_order ON orders(table_id) WHERE closed_at IS NULL;
      CREATE TABLE order_requests (
        request_id TEXT NOT NULL,
        waiter_id INTEGER NOT NULL REFERENCES staff(id),
        table_id INTEGER NOT NULL REFERENCES dining_tables(id),
        order_id INTEGER NOT NULL REFERENCES orders(id),
        payload TEXT NOT NULL,
        PRIMARY KEY (waiter_id, request_id)
      );
      CREATE TABLE order_lines (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        menu_id INTEGER NOT NULL REFERENCES menu(id),
        name TEXT NOT NULL,
        price_paise INTEGER NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
        note TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'preparing', 'ready'))
      );
      CREATE INDEX lines_by_order ON order_lines(order_id);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  } else if (version > storeSchemaVersion || version < 0) {
    db.close();
    throw new Error('Unsupported restaurant database version');
  }
  if (version < 2) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE menu ADD COLUMN category TEXT NOT NULL DEFAULT 'Other';
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  if (version < 3) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE order_placements (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        actor_id INTEGER NOT NULL REFERENCES staff(id),
        changed_at INTEGER NOT NULL,
        previous_table_id INTEGER NOT NULL REFERENCES dining_tables(id),
        next_table_id INTEGER NOT NULL REFERENCES dining_tables(id),
        previous_waiter_id INTEGER NOT NULL REFERENCES staff(id),
        next_waiter_id INTEGER NOT NULL REFERENCES staff(id)
      );
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
  if (version < 4) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE order_lines ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE order_lines ADD COLUMN cancelled_at INTEGER;
      CREATE TABLE dish_changes (
        id INTEGER PRIMARY KEY,
        line_id INTEGER NOT NULL REFERENCES order_lines(id),
        requested_by INTEGER NOT NULL REFERENCES staff(id),
        request_id TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        previous_quantity INTEGER NOT NULL,
        previous_note TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 99),
        note TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'declined', 'expired')),
        resolved_by INTEGER REFERENCES staff(id),
        resolved_at INTEGER,
        UNIQUE (requested_by, request_id)
      );
      CREATE INDEX changes_by_line ON dish_changes(line_id, id DESC);
      CREATE UNIQUE INDEX pending_change_by_line ON dish_changes(line_id) WHERE outcome = 'pending';
      PRAGMA user_version = 4;
      COMMIT;
    `);
  }
  if (version < 5) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE order_placements ADD COLUMN joined_order_id INTEGER REFERENCES orders(id);
      CREATE TABLE order_splits (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        checks TEXT NOT NULL,
        saved_by INTEGER NOT NULL REFERENCES staff(id),
        request_id TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        cleared_by INTEGER REFERENCES staff(id),
        cleared_at INTEGER,
        UNIQUE (saved_by, request_id)
      );
      CREATE UNIQUE INDEX active_split_by_order ON order_splits(order_id) WHERE cleared_at IS NULL;
      PRAGMA user_version = 5;
      COMMIT;
    `);
  }
  if (version < 6) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE orders ADD COLUMN closed_by INTEGER REFERENCES staff(id);
      CREATE TABLE check_receipts (
        order_id INTEGER NOT NULL REFERENCES orders(id),
        split_id INTEGER REFERENCES order_splits(id),
        check_number INTEGER NOT NULL,
        reference TEXT NOT NULL COLLATE NOCASE UNIQUE,
        item_total_paise INTEGER NOT NULL,
        official_total_paise INTEGER NOT NULL,
        recorded_by INTEGER NOT NULL REFERENCES staff(id),
        recorded_at INTEGER NOT NULL,
        payment_method TEXT CHECK (payment_method IN ('Cash', 'UPI', 'Card', 'Mixed', 'Other')),
        paid_by INTEGER REFERENCES staff(id),
        paid_at INTEGER,
        PRIMARY KEY (order_id, check_number)
      );
      PRAGMA user_version = 6;
      COMMIT;
    `);
  }
  if (version < 7) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE order_requests RENAME COLUMN waiter_id TO actor_id;
      ALTER TABLE order_requests ADD COLUMN credited_waiter_id INTEGER REFERENCES staff(id);
      ALTER TABLE order_requests ADD COLUMN submitted_at INTEGER;
      UPDATE order_requests SET credited_waiter_id = actor_id;
      ALTER TABLE order_lines ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'waiter'
        CHECK (entry_source IN ('waiter', 'paper-live', 'paper-served'));
      PRAGMA user_version = 7;
      COMMIT;
    `);
  }
  if (version < 8) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE menu ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE menu ADD COLUMN available_after INTEGER;
      ALTER TABLE menu ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE menu ADD COLUMN creation_request_id TEXT;
      CREATE UNIQUE INDEX menu_creation_request ON menu(creation_request_id) WHERE creation_request_id IS NOT NULL;
      PRAGMA user_version = 8;
      COMMIT;
    `);
  }
  if (version < 9) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE menu_photos (
        menu_id INTEGER PRIMARY KEY REFERENCES menu(id),
        photo_key TEXT NOT NULL,
        image BLOB NOT NULL
      );
      PRAGMA user_version = 9;
      COMMIT;
    `);
  }
  if (version < 10) {
    // Photo writes also increment the dish revision in their transaction.
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE menu_publication (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        destination TEXT,
        published_version INTEGER,
        published_at INTEGER
      );
      INSERT INTO menu_publication (id) VALUES (1);
      CREATE TRIGGER menu_publish_insert AFTER INSERT ON menu BEGIN
        UPDATE menu_publication SET version = version + 1 WHERE id = 1;
      END;
      CREATE TRIGGER menu_publish_update AFTER UPDATE OF revision ON menu
        WHEN NEW.revision <> OLD.revision BEGIN
        UPDATE menu_publication SET version = version + 1 WHERE id = 1;
      END;
      CREATE TRIGGER menu_publish_delete AFTER DELETE ON menu BEGIN
        UPDATE menu_publication SET version = version + 1 WHERE id = 1;
      END;
      PRAGMA user_version = 10;
      COMMIT;
    `);
  }
  if (version < 11) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE coupons (
        code TEXT PRIMARY KEY,
        discount_paise INTEGER NOT NULL CHECK(discount_paise > 0),
        minimum_paise INTEGER NOT NULL CHECK(minimum_paise >= 0),
        expires_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1))
      );
      ALTER TABLE check_receipts ADD COLUMN coupon_code TEXT REFERENCES coupons(code);
      ALTER TABLE check_receipts ADD COLUMN coupon_discount_paise INTEGER CHECK(coupon_discount_paise > 0);
      PRAGMA user_version = 11;
      COMMIT;
    `);
  }
  if (version < 12) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE receipt_feedback_codes (
        order_id INTEGER NOT NULL,
        check_number INTEGER NOT NULL,
        code TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        destination TEXT,
        published INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (order_id, check_number),
        FOREIGN KEY (order_id, check_number) REFERENCES check_receipts(order_id, check_number)
      );
      PRAGMA user_version = 12;
      COMMIT;
    `);
  }
  if (version < 13) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE coupons ADD COLUMN public_title TEXT;
      CREATE TABLE offer_publication (id INTEGER PRIMARY KEY CHECK(id = 1), installation TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE coupon_claims (
        code TEXT PRIMARY KEY,
        offer_code TEXT NOT NULL REFERENCES coupons(code),
        destination TEXT NOT NULL,
        ready_ack INTEGER NOT NULL DEFAULT 0,
        redemption_ack INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE check_receipts ADD COLUMN claim_code TEXT REFERENCES coupon_claims(code);
      CREATE UNIQUE INDEX receipt_claim_once ON check_receipts (claim_code) WHERE claim_code IS NOT NULL;
      CREATE TRIGGER offer_insert AFTER INSERT ON coupons WHEN NEW.public_title IS NOT NULL BEGIN
        UPDATE offer_publication SET version = version + 1 WHERE id = 1;
      END;
      CREATE TRIGGER offer_update AFTER UPDATE OF enabled ON coupons WHEN NEW.public_title IS NOT NULL AND NEW.enabled <> OLD.enabled BEGIN
        UPDATE offer_publication SET version = version + 1 WHERE id = 1;
      END;
    `);
    try {
      db.prepare('INSERT INTO offer_publication VALUES (1, ?, 1)').run(randomUUID());
      db.exec('PRAGMA user_version = 13; COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (version < 14) {
    // Rebuild the parent without renaming it first, preserving existing child references.
    db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      db.exec(`
        CREATE TABLE orders_next (
          id INTEGER PRIMARY KEY, table_id INTEGER REFERENCES dining_tables(id),
          waiter_id INTEGER REFERENCES staff(id), opened_at INTEGER NOT NULL,
          closed_at INTEGER, closed_by INTEGER REFERENCES staff(id),
          CHECK ((table_id IS NULL) = (waiter_id IS NULL))
        );
        INSERT INTO orders_next SELECT id, table_id, waiter_id, opened_at, closed_at, closed_by FROM orders;
        DROP TABLE orders;
        ALTER TABLE orders_next RENAME TO orders;
        CREATE UNIQUE INDEX active_table_order ON orders(table_id) WHERE closed_at IS NULL;
        CREATE TABLE outlet_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('table','counter','both')), revision INTEGER NOT NULL);
        INSERT INTO outlet_settings VALUES (1, 'table', 0);
        CREATE TABLE outlet_audit (id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES staff(id), at INTEGER NOT NULL, previous_mode TEXT NOT NULL, next_mode TEXT NOT NULL);
        CREATE TABLE counter_orders (
          order_id INTEGER PRIMARY KEY REFERENCES orders(id), revision INTEGER NOT NULL DEFAULT 0,
          cashier_id INTEGER NOT NULL REFERENCES staff(id),
          fulfillment TEXT NOT NULL CHECK(fulfillment IN ('dine-in','takeaway')),
          customer TEXT NOT NULL, seating TEXT NOT NULL,
          paper TEXT NOT NULL CHECK(paper IN ('none','live','served')), paper_reference TEXT NOT NULL,
          token_date TEXT, token_number INTEGER, collected_at INTEGER, cancelled_at INTEGER,
          UNIQUE(token_date, token_number)
        );
        CREATE TABLE counter_requests (
          actor_id INTEGER NOT NULL REFERENCES staff(id), request_id TEXT NOT NULL,
          action TEXT NOT NULL, payload TEXT NOT NULL, order_id INTEGER NOT NULL REFERENCES orders(id),
          PRIMARY KEY(actor_id, request_id)
        );
        CREATE TABLE counter_adjustments (
          order_id INTEGER PRIMARY KEY REFERENCES counter_orders(order_id),
          reason TEXT NOT NULL, amount_paise INTEGER NOT NULL,
          actor_id INTEGER NOT NULL REFERENCES staff(id), at INTEGER NOT NULL,
          reference TEXT, resolved_by INTEGER REFERENCES staff(id), resolved_at INTEGER
        );
      `);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database migration failed its reference check.');
      db.exec('PRAGMA user_version = 14; COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      db.close();
      throw error;
    }
    db.exec('PRAGMA foreign_keys = ON;');
  }
  if (version < 15) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE outlet_settings ADD COLUMN change_policy TEXT NOT NULL DEFAULT 'approval' CHECK(change_policy IN ('approval','blocked'));
      CREATE TABLE counter_corrections (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES counter_orders(order_id),
        reason TEXT NOT NULL, amount_paise INTEGER NOT NULL CHECK(amount_paise>=0),
        actor_id INTEGER NOT NULL REFERENCES staff(id), at INTEGER NOT NULL,
        reference TEXT, resolved_by INTEGER REFERENCES staff(id), resolved_at INTEGER,
        item TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO counter_corrections(order_id,reason,amount_paise,actor_id,at,reference,resolved_by,resolved_at)
        SELECT order_id,reason,amount_paise,actor_id,at,reference,resolved_by,resolved_at FROM counter_adjustments;
      DROP TABLE counter_adjustments;
      CREATE TABLE configuration_events (
        id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES staff(id), at INTEGER NOT NULL,
        action TEXT NOT NULL, details TEXT NOT NULL
      );
      PRAGMA user_version=15;
      COMMIT;
    `);
  }
  if (version < 16) {
    db.exec('BEGIN IMMEDIATE; ALTER TABLE counter_orders ADD COLUMN kitchen_ack_at INTEGER; PRAGMA user_version=16; COMMIT;');
  }
  if (version < 17) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE table_resolutions (
        order_id INTEGER PRIMARY KEY REFERENCES orders(id),table_label TEXT NOT NULL,
        amount_paise INTEGER NOT NULL CHECK(amount_paise>0),reason TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES staff(id),at INTEGER NOT NULL,kitchen_ack_at INTEGER
      );
      PRAGMA user_version=17; COMMIT;`);
  }
  if (version < 18) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE billing_profile(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,profile TEXT NOT NULL);
      CREATE TABLE bill_sequences(series TEXT NOT NULL,financial_year TEXT NOT NULL,last_number INTEGER NOT NULL,PRIMARY KEY(series,financial_year));
      CREATE TABLE built_in_bills (
        order_id INTEGER NOT NULL,check_number INTEGER NOT NULL,
        number TEXT NOT NULL UNIQUE,actor_id INTEGER NOT NULL REFERENCES staff(id),request_id TEXT NOT NULL,payload TEXT NOT NULL,snapshot TEXT NOT NULL,
        PRIMARY KEY(order_id,check_number),UNIQUE(actor_id,request_id),
        FOREIGN KEY(order_id,check_number) REFERENCES check_receipts(order_id,check_number) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE built_in_credit_notes (
        correction_id INTEGER PRIMARY KEY REFERENCES counter_corrections(id),number TEXT NOT NULL UNIQUE,
        order_id INTEGER NOT NULL REFERENCES orders(id),snapshot TEXT NOT NULL
      );
      PRAGMA user_version=18;COMMIT;`);
  }
  return db;
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64, passwordOptions).toString('hex');
  return `${salt}:${digest}`;
}

export function createStaff(db: DatabaseSync, username: string, name: string, role: Role, password: string) {
  db.prepare('INSERT INTO staff (username, name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(username, name, role, hashPassword(password));
}

export async function authenticate(db: DatabaseSync, username: string, password: string): Promise<Staff | undefined> {
  const account = db.prepare('SELECT id, name, role, password_hash AS hash FROM staff WHERE username = ? AND enabled = 1')
    .get(username) as (Staff & { hash: string }) | undefined;
  const [salt = '00000000000000000000000000000000', digest = '00'.repeat(64)] = account?.hash.split(':') ?? [];
  const derived = await derivePassword(password, salt, 64, passwordOptions);
  const valid = timingSafeEqual(derived, Buffer.from(digest, 'hex'));
  if (valid && account) return { id: account.id, name: account.name, role: account.role };
}

export function readMenu(db: DatabaseSync): MenuItem[] {
  const items = db.prepare(`
    SELECT m.id, m.name, m.price_paise AS pricePaise, m.category, m.available, m.description,
      m.available_after AS availableAfter, m.revision, p.photo_key AS photoKey
    FROM menu m LEFT JOIN menu_photos p ON p.menu_id = m.id ORDER BY m.id
  `)
    .all() as unknown as Array<Omit<MenuItem, 'available'> & { available: number }>;
  return items.map(item => ({ ...item, available: item.available === 1 }));
}

export function readWaiters(db: DatabaseSync) {
  return db.prepare("SELECT id, name FROM staff WHERE role = 'waiter' AND enabled = 1 ORDER BY name, id")
    .all() as unknown as Array<Pick<Staff, 'id' | 'name'>>;
}

export function activeSplit(db: DatabaseSync, orderId: number) {
  return db.prepare('SELECT id, checks FROM order_splits WHERE order_id = ? AND cleared_at IS NULL')
    .get(orderId) as { id: number; checks: string } | undefined;
}

export function hasReceipt(db: DatabaseSync, orderId: number) {
  return Boolean(db.prepare('SELECT 1 FROM check_receipts WHERE order_id = ? LIMIT 1').get(orderId));
}

export function billableLines(db: DatabaseSync, orderId: number) {
  return db.prepare(`
    SELECT id, quantity, note, price_paise AS pricePaise, status
    FROM order_lines WHERE order_id = ? AND cancelled_at IS NULL ORDER BY id
  `).all(orderId) as unknown as Array<Pick<OrderLine, 'id' | 'quantity' | 'note' | 'pricePaise' | 'status'>>;
}

export function checkVersion(lines: ReturnType<typeof billableLines>) {
  return createHash('sha256').update(JSON.stringify(lines.map(line => [line.id, line.quantity, line.note, line.pricePaise]))).digest('hex');
}

type FeedbackTarget = { endpoint: string; guestUrl: string };

export function readReceipts(db: DatabaseSync, orderId: number, feedbackTarget?: FeedbackTarget) {
  const rows = db.prepare(`
    SELECT r.check_number AS checkNumber, r.reference, r.official_total_paise AS officialTotalPaise, r.payment_method AS paymentMethod,
      COALESCE(r.claim_code, r.coupon_code) AS code, r.coupon_discount_paise AS discountPaise, f.code AS feedbackCode, f.expires_at AS expiresAt,
      f.destination, f.published, b.snapshot AS billSnapshot
    FROM check_receipts r LEFT JOIN receipt_feedback_codes f ON f.order_id = r.order_id AND f.check_number = r.check_number
    LEFT JOIN built_in_bills b ON b.order_id=r.order_id AND b.check_number=r.check_number
    WHERE r.order_id = ? ORDER BY r.check_number
  `).all(orderId) as unknown as Array<Omit<CheckReceipt, 'coupon' | 'feedback'> & {
    code: string | null; discountPaise: number | null; feedbackCode: string | null; expiresAt: number | null;
    destination: string | null; published: number | null; billSnapshot: string | null;
  }>;
  return rows.map(({ code, discountPaise, feedbackCode, expiresAt, destination, published, billSnapshot, ...receipt }) => ({
    ...receipt,
    ...(billSnapshot ? { bill: JSON.parse(billSnapshot) } : {}),
    ...(code !== null && discountPaise !== null ? { coupon: { code, discountPaise } } : {}),
    ...(feedbackCode && expiresAt !== null ? { feedback: {
      code: feedbackCode, expiresAt, published: published === 1 && destination === feedbackTarget?.endpoint,
      guestUrl: destination === null || destination === feedbackTarget?.endpoint ? feedbackTarget?.guestUrl : undefined
    } } : {})
  }));
}

export function canReleaseCheck(lines: ReturnType<typeof billableLines>, receipts: CheckReceipt[], expectedChecks: number) {
  return lines.length === 0 || (lines.every(line => line.status === 'ready')
    && receipts.length === expectedChecks && receipts.every(receipt => receipt.paymentMethod !== null));
}

export function requireCurrentOrder(db: DatabaseSync, tableId: number, orderId: number) {
  const order = db.prepare('SELECT waiter_id FROM orders WHERE id = ? AND table_id = ? AND closed_at IS NULL').get(orderId, tableId);
  if (!order) throw new WorkflowError(409, 'This table’s check changed. Review the current check.');
  return { waiterId: Number(order.waiter_id) };
}

export function readTables(db: DatabaseSync, staff: Staff, feedbackTarget?: FeedbackTarget): Table[] {
  const tables = db.prepare(`
    SELECT t.id, t.label, o.id AS orderId, s.id AS waiterId, s.name AS waiterName
    FROM dining_tables t
    LEFT JOIN orders o ON o.table_id = t.id AND o.closed_at IS NULL
    LEFT JOIN staff s ON s.id = o.waiter_id
    ORDER BY t.id
  `).all() as unknown as Array<{
    id: number; label: string; orderId: number | null; waiterId: number | null; waiterName: string | null;
  }>;
  const lines = db.prepare(`
    SELECT l.id, l.name, l.price_paise AS pricePaise, l.quantity, l.note, l.revision, l.entry_source AS entrySource,
      CASE WHEN l.cancelled_at IS NULL THEN l.status ELSE 'cancelled' END AS status,
      c.id AS changeId, c.quantity AS changeQuantity, c.note AS changeNote, c.outcome AS changeOutcome
    FROM order_lines l LEFT JOIN dish_changes c ON c.id = (
      SELECT id FROM dish_changes WHERE line_id = l.id ORDER BY id DESC LIMIT 1
    )
    WHERE l.order_id = ? AND (? = 0 OR l.entry_source <> 'paper-served') ORDER BY l.id
  `);
  return tables.map(table => {
    const orderLines = table.orderId !== null && (staff.role !== 'waiter' || table.waiterId === staff.id)
      ? (lines.all(table.orderId, staff.role === 'kitchen' ? 1 : 0) as unknown as Array<Omit<OrderLine, 'change'> & {
        changeId: number | null; changeQuantity: number; changeNote: string; changeOutcome: NonNullable<OrderLine['change']>['outcome'];
      }>).map(({ changeId, changeQuantity, changeNote, changeOutcome, ...line }) => ({
        ...line, change: changeId === null ? null : { id: changeId, quantity: changeQuantity, note: changeNote, outcome: changeOutcome }
      }))
      : [];
    const split = table.orderId === null ? undefined : activeSplit(db, table.orderId);
    const allocation = split ? JSON.parse(split.checks) as CheckItem[][] : null;
    const checks = allocation && staff.role === 'billing'
      ? allocation.map(items => ({
        items, totalPaise: items.reduce((sum, item) => sum + item.quantity * (orderLines.find(line => line.id === item.lineId)?.pricePaise ?? 0), 0)
      }))
      : [];
    const canSeeBilling = staff.role === 'billing' || (staff.role === 'waiter' && staff.id === table.waiterId);
    const receipts = table.orderId !== null && canSeeBilling ? readReceipts(db, table.orderId, feedbackTarget) : [];
    const billable = orderLines.filter(line => line.status !== 'cancelled');
    return {
      id: table.id, label: table.label, orderId: table.orderId, splitId: split?.id ?? null, checks,
      checkVersion: staff.role === 'billing' && table.orderId !== null ? checkVersion(billable) : null,
      receipts: staff.role === 'billing' ? receipts : [],
      hasReceipt: receipts.length > 0,
      canRelease: table.orderId !== null && canSeeBilling && canReleaseCheck(billable, receipts, allocation?.length ?? 1),
      waiter: table.waiterId === null ? null : { id: table.waiterId, name: table.waiterName! },
      lines: orderLines
    };
  });
}

export function submitOrder(db: DatabaseSync, tableId: number, actorId: number, request: OrderRequest, paper?: PaperOrderDetails): number {
  const creditedWaiterId = paper?.creditedWaiterId ?? actorId;
  const entrySource = paper ? `paper-${paper.mode}` : 'waiter';
  const served = paper?.mode === 'served';
  const lines = request.lines.map(line => line.expectedPricePaise === undefined
    ? [line.menuId, line.quantity, line.note ?? '']
    : [line.menuId, line.quantity, line.note ?? '', line.expectedPricePaise]);
  const payload = JSON.stringify(paper ? [entrySource, creditedWaiterId, lines] : lines);
  db.exec('BEGIN IMMEDIATE');
  try {
    const saved = db.prepare(`
      SELECT table_id, order_id, payload FROM order_requests WHERE actor_id = ? AND request_id = ?
    `).get(actorId, request.requestId);
    if (saved) {
      if (saved.table_id !== tableId || saved.payload !== payload) {
        throw new WorkflowError(409, 'This request was already used for a different order.');
      }
      db.exec('COMMIT');
      return Number(saved.order_id);
    }
    if (!db.prepare('SELECT id FROM dining_tables WHERE id = ?').get(tableId)) {
      throw new WorkflowError(404, 'Table not found.');
    }
    const active = db.prepare('SELECT id, waiter_id FROM orders WHERE table_id = ? AND closed_at IS NULL').get(tableId);
    if (!active && db.prepare("SELECT mode FROM outlet_settings WHERE id=1").get()?.mode === 'counter') {
      throw new WorkflowError(409, 'This outlet uses counter service. Start a counter order.');
    }
    if (request.expectedOrderId !== undefined && request.expectedOrderId !== (active?.id ?? null)) {
      throw new WorkflowError(409, 'This table’s order changed. Check the table before sending.');
    }
    if (!paper && active && active.waiter_id !== actorId) {
      throw new WorkflowError(409, 'Another waiter has this table.');
    }
    if (paper && !db.prepare("SELECT 1 FROM staff WHERE id = ? AND role = 'waiter' AND enabled = 1").get(creditedWaiterId)) {
      throw new WorkflowError(409, 'Choose an enabled waiter for this paper order.');
    }
    if (active && activeSplit(db, Number(active.id))) {
      throw new WorkflowError(409, 'The counter has split this check. Ask the counter to reopen it before adding dishes.');
    }
    if (active && hasReceipt(db, Number(active.id))) throw new WorkflowError(409, 'The counter already recorded a receipt for this check.');
    const now = Date.now();
    const orderId = Number(active?.id ?? db.prepare('INSERT INTO orders (table_id, waiter_id, opened_at) VALUES (?, ?, ?)')
      .run(tableId, creditedWaiterId, now).lastInsertRowid);
    const menu = db.prepare('SELECT name, price_paise, available FROM menu WHERE id = ?');
    const insertLine = db.prepare(`
      INSERT INTO order_lines (order_id, menu_id, name, price_paise, quantity, note, status, entry_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const line of request.lines) {
      const item = menu.get(line.menuId);
      if (typeof item?.name !== 'string' || typeof item.price_paise !== 'number') {
        throw new WorkflowError(409, 'A dish is no longer available. Check the menu and try again.');
      }
      if (!served && item.available !== 1) {
        throw new WorkflowError(409, `${item.name} is sold out. Remove it or choose another dish.`);
      }
      if (line.expectedPricePaise !== undefined && line.expectedPricePaise !== item.price_paise) {
        throw new WorkflowError(409, `${item.name} has a new price. Review the current total before sending.`);
      }
      insertLine.run(orderId, line.menuId, item.name, item.price_paise, line.quantity, line.note ?? '', served ? 'ready' : 'queued', entrySource);
    }
    db.prepare(`
      INSERT INTO order_requests (request_id, actor_id, table_id, order_id, payload, credited_waiter_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(request.requestId, actorId, tableId, orderId, payload, creditedWaiterId, now);
    db.exec('COMMIT');
    return orderId;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function updatePlacement(db: DatabaseSync, tableId: number, staff: Staff, change: PlacementRequest) {
  if (staff.role !== 'billing' && staff.role !== 'waiter') throw new WorkflowError(403, 'This account cannot move or transfer orders.');
  if (change.action === 'join' && staff.role !== 'billing') throw new WorkflowError(403, 'Only the counter can join tables.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const active = db.prepare('SELECT id, waiter_id FROM orders WHERE table_id = ? AND closed_at IS NULL').get(tableId);
    if (!active || active.id !== change.orderId || active.waiter_id !== change.waiterId) {
      throw new WorkflowError(409, 'The table or waiter changed. Refresh and try again.');
    }
    if (staff.role === 'waiter' && staff.id !== active.waiter_id) {
      throw new WorkflowError(403, 'The assigned waiter or counter can make this change.');
    }
    const nextTable = change.action === 'transfer' ? tableId : change.destinationId;
    let nextWaiter = change.action === 'transfer' ? change.destinationId : change.waiterId;
    let joinedOrderId: number | null = null;
    if (nextTable === tableId && nextWaiter === change.waiterId) {
      throw new WorkflowError(400, 'Choose a different table or waiter.');
    }
    if (change.action === 'join') {
      const destination = db.prepare('SELECT id, waiter_id FROM orders WHERE table_id = ? AND closed_at IS NULL').get(nextTable);
      if (!destination || destination.id !== change.destinationOrderId) {
        throw new WorkflowError(409, 'The destination check changed. Choose the table again.');
      }
      joinedOrderId = Number(destination.id);
      nextWaiter = Number(destination.waiter_id);
      if (hasReceipt(db, change.orderId) || hasReceipt(db, joinedOrderId)) throw new WorkflowError(409, 'Tables with recorded receipts cannot be joined.');
      if (activeSplit(db, change.orderId) || activeSplit(db, joinedOrderId)) {
        throw new WorkflowError(409, 'Reopen both split checks before joining their tables.');
      }
      db.prepare('UPDATE order_lines SET order_id = ? WHERE order_id = ?').run(joinedOrderId, change.orderId);
      db.prepare('UPDATE orders SET closed_at = ? WHERE id = ?').run(Date.now(), change.orderId);
    } else if (change.action === 'move') {
      if (!db.prepare('SELECT id FROM dining_tables WHERE id = ?').get(nextTable)) throw new WorkflowError(404, 'Table not found.');
      if (db.prepare('SELECT id FROM orders WHERE table_id = ? AND closed_at IS NULL').get(nextTable)) {
        throw new WorkflowError(409, 'That table is occupied. Choose an available table.');
      }
    } else if (!db.prepare("SELECT id FROM staff WHERE id = ? AND role = 'waiter' AND enabled = 1").get(nextWaiter)) {
      throw new WorkflowError(409, 'That waiter is unavailable. Choose another waiter.');
    }
    if (joinedOrderId === null) db.prepare('UPDATE orders SET table_id = ?, waiter_id = ? WHERE id = ?').run(nextTable, nextWaiter, change.orderId);
    db.prepare(`
      INSERT INTO order_placements (order_id, actor_id, changed_at, previous_table_id, next_table_id, previous_waiter_id, next_waiter_id, joined_order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(change.orderId, staff.id, Date.now(), tableId, nextTable, change.waiterId, nextWaiter, joinedOrderId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function updateDish(db: DatabaseSync, lineId: number, status: Extract<DishStatus, 'preparing' | 'ready'>, actorId: number, revision?: number) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare(`
      SELECT l.status, l.revision FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.id = ? AND l.cancelled_at IS NULL AND l.entry_source <> 'paper-served' AND o.closed_at IS NULL
        AND (o.table_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM counter_orders c JOIN check_receipts r ON r.order_id=c.order_id
          WHERE c.order_id=o.id AND c.token_number IS NOT NULL AND c.cancelled_at IS NULL AND r.payment_method IS NOT NULL
        ))
    `).get(lineId);
    if (!current) throw new WorkflowError(404, 'Active dish not found.');
    if (current.status !== status) {
      if (revision !== undefined && revision !== current.revision) throw new WorkflowError(409, 'The dish changed. Review the latest instructions.');
      if (current.status === 'ready') throw new WorkflowError(409, 'This dish is already ready.');
      db.prepare('UPDATE order_lines SET status = ?, revision = revision + 1 WHERE id = ?').run(status, lineId);
      if (status === 'ready') {
        db.prepare("UPDATE dish_changes SET outcome = 'expired', resolved_by = ?, resolved_at = ? WHERE line_id = ? AND outcome = 'pending'")
          .run(actorId, Date.now(), lineId);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Data layer. All money is stored as integer paise to avoid floating-point drift.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  GST_RATES, STATES, UQC, financialYear, gstinValid, hsnValid, invoiceProblem, localDate, parseDocNumber, splitTax, stateLabel, taxOf,
} from '../public/gst.js';

// Tables whose CHECK rules have grown since the first release. Older databases are rebuilt
// to these definitions on open (see rebuildIfOutdated); `marker` is text only the current version has.
const STOCK_MOVEMENTS = `
-- Ledger of every stock change, so the current quantity is always explainable.
CREATE TABLE IF NOT EXISTS stock_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  change       INTEGER NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('stock_in', 'sale', 'adjustment', 'purchase_return', 'sale_return')),
  sale_id      INTEGER REFERENCES sales(id),
  purchase_id  INTEGER REFERENCES purchases(id),
  return_id    INTEGER REFERENCES purchase_returns(id),
  sale_return_id INTEGER REFERENCES sale_returns(id),
  note         TEXT,
  client_id    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const SUPPLIER_LEDGER = `
-- What the shop owes each supplier. Same shape as ledger_entries, the other way round.
-- 'payment' and 'return' reduce the balance; the rest increase it.
CREATE TABLE IF NOT EXISTS supplier_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
  type         TEXT NOT NULL CHECK (type IN ('opening', 'purchase', 'payment', 'return', 'refund')),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  purchase_id  INTEGER REFERENCES purchases(id),
  return_id    INTEGER REFERENCES purchase_returns(id),
  method       TEXT,
  note         TEXT,
  client_id    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const LEDGER_ENTRIES = `
-- Udhaar (credit) khata. amount is always positive; the type says which way it moves the balance.
-- 'payment' and 'return' reduce what the customer owes.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  type            TEXT NOT NULL CHECK (type IN ('opening', 'credit_sale', 'payment', 'return')),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  sale_id         INTEGER REFERENCES sales(id),
  sale_return_id  INTEGER REFERENCES sale_returns(id),
  method          TEXT,
  note            TEXT,
  client_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const REBUILDS = [
  ['stock_movements', STOCK_MOVEMENTS, 'sale_return_id'],
  ['supplier_ledger', SUPPLIER_LEDGER, "'refund'"],
  ['ledger_entries', LEDGER_ENTRIES, 'sale_return_id'],
];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode     TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),      -- selling price, paise, GST-inclusive
  cost        INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
  gst_rate    REAL    NOT NULL DEFAULT 0 CHECK (gst_rate >= 0),
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_stock   INTEGER NOT NULL DEFAULT 5,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT,                                     -- digits only
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subtotal        INTEGER NOT NULL,
  discount        INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  tax             INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL DEFAULT 'cash',
  customer_name   TEXT,
  customer_phone  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     INTEGER NOT NULL REFERENCES sales(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  barcode     TEXT NOT NULL,
  name        TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  INTEGER NOT NULL,
  unit_cost   INTEGER,                                -- product cost when sold, for profit
  gst_rate    REAL NOT NULL,
  line_total  INTEGER NOT NULL
);

${STOCK_MOVEMENTS}

${LEDGER_ENTRIES}

-- Goods a customer brings back. Refunded in cash/UPI/card, or taken off their udhaar ('khata').
-- restock = 0 means the item was damaged and does not go back on the shelf.
CREATE TABLE IF NOT EXISTS sale_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id        INTEGER REFERENCES sales(id),
  customer_id    INTEGER REFERENCES customers(id),
  total          INTEGER NOT NULL,
  refund_method  TEXT NOT NULL CHECK (refund_method IN ('cash', 'upi', 'card', 'khata')),
  restock        INTEGER NOT NULL DEFAULT 1,
  reason         TEXT,
  client_id      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id   INTEGER NOT NULL REFERENCES sale_returns(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  barcode     TEXT NOT NULL,
  name        TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price  INTEGER NOT NULL,                       -- refunded per unit
  unit_cost   INTEGER NOT NULL,                       -- cost of the unit, for profit
  gst_rate    REAL NOT NULL DEFAULT 0,
  line_total  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT,
  gstin       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A supplier's bill. Its lines add stock; total - paid goes on the supplier's khata.
CREATE TABLE IF NOT EXISTS purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_no      TEXT,
  total           INTEGER NOT NULL,
  paid            INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT,
  note            TEXT,
  client_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  barcode      TEXT NOT NULL,
  name         TEXT NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost    INTEGER NOT NULL,
  line_total   INTEGER NOT NULL
);

${SUPPLIER_LEDGER}

-- Goods sent back to a supplier (damaged, expired, wrong item). Reduces stock and what we owe;
-- with settlement 'refund' the supplier paid cash back instead, so the balance nets out.
CREATE TABLE IF NOT EXISTS purchase_returns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_id     INTEGER REFERENCES purchases(id),
  total           INTEGER NOT NULL,
  settlement      TEXT NOT NULL CHECK (settlement IN ('adjust', 'refund')),
  refund_method   TEXT,
  reason          TEXT,
  client_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id   INTEGER NOT NULL REFERENCES purchase_returns(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  barcode     TEXT NOT NULL,
  name        TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost   INTEGER NOT NULL,
  line_total  INTEGER NOT NULL
);

-- Shop profile and preferences, one JSON value per key ('shop').
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Each phone or browser that issues invoices gets its own document series (Rule 46(b) allows
-- several), so it can number invoices offline without two devices ever using the same number.
CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Highest number used per series, document type and financial year.
CREATE TABLE IF NOT EXISTS doc_counters (
  series  TEXT NOT NULL,
  doc     TEXT NOT NULL CHECK (doc IN ('invoice', 'credit_note')),
  fy      TEXT NOT NULL,
  last    INTEGER NOT NULL,
  PRIMARY KEY (series, doc, fy)
);

-- Numbers that were allocated but never issued (e.g. an offline bill that was discarded).
-- Reported as cancelled in the GSTR-1 document summary.
CREATE TABLE IF NOT EXISTS voided_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc         TEXT NOT NULL CHECK (doc IN ('invoice', 'credit_note')),
  number      TEXT NOT NULL UNIQUE,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rule 56(8): electronic records must keep a log of every entry edited or deleted.
-- Sales, purchases, payments and returns are never edited (corrections are new entries);
-- this records changes to the things that can be edited.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  action     TEXT NOT NULL,
  changes    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger_entries(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_client ON ledger_entries(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_phone ON suppliers(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_client ON purchases(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_ledger_client ON supplier_ledger(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier ON supplier_ledger(supplier_id);
CREATE INDEX IF NOT EXISTS idx_returns_supplier ON purchase_returns(supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_client ON purchase_returns(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_return_items_return ON purchase_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_created ON sale_returns(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_returns_client ON sale_returns(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);
`;

// Columns added after the first release; applied to existing databases on open.
const MIGRATIONS = [
  ['sales', 'customer_id', 'INTEGER REFERENCES customers(id)'],
  // client_id lets an offline device retry the same action without it being recorded twice.
  ['sales', 'client_id', 'TEXT'],
  ['stock_movements', 'client_id', 'TEXT'],
  ['stock_movements', 'purchase_id', 'INTEGER REFERENCES purchases(id)'],
  // Sales made before this column existed are valued at the product's cost price at upgrade time.
  ['sale_items', 'unit_cost', 'INTEGER', 'UPDATE sale_items SET unit_cost = (SELECT cost FROM products WHERE id = product_id)'],
  // GST: HSN code and unit per product; buyer, place of supply and tax split per invoice and line.
  ['products', 'hsn', 'TEXT'],
  ['products', 'unit', "TEXT NOT NULL DEFAULT 'NOS'"],
  ['customers', 'gstin', 'TEXT'],
  ['customers', 'address', 'TEXT'],
  ['sales', 'invoice_no', 'TEXT'],
  ['sales', 'buyer_gstin', 'TEXT'],
  ['sales', 'buyer_address', 'TEXT'],
  ['sales', 'place_of_supply', 'TEXT'],
  ['sales', 'inter_state', 'INTEGER NOT NULL DEFAULT 0'],
  ['sales', 'taxable', 'INTEGER'],
  ['sales', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sales', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sales', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_items', 'hsn', 'TEXT'],
  ['sale_items', 'unit', 'TEXT'],
  ['sale_items', 'taxable', 'INTEGER'],
  ['sale_items', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_items', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_items', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_returns', 'note_no', 'TEXT'],
  ['sale_returns', 'taxable', 'INTEGER'],
  ['sale_returns', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_returns', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_returns', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_return_items', 'hsn', 'TEXT'],
  ['sale_return_items', 'unit', 'TEXT'],
  ['sale_return_items', 'taxable', 'INTEGER'],
  ['sale_return_items', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_return_items', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['sale_return_items', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
];
const POST_MIGRATION = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client ON sales(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_client ON stock_movements(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoice_no ON sales(invoice_no) WHERE invoice_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_returns_note_no ON sale_returns(note_no) WHERE note_no IS NOT NULL;
`;

export const DEFAULT_SHOP = {
  legal_name: '', trade_name: '', address: '', state_code: '', gstin: '', phone: '', email: '',
  gst_registered: false,
  hsn_digits: 4,     // 4 if last year's turnover was up to ₹5 crore, else 6 (Notification 78/2020)
  tz_offset: 330,    // minutes east of UTC; invoice dates and financial years use the shop's local time
  invoice_terms: '',
};

// Code for the n-th device series: A…Z, then AA…ZZ. '0' is the server's own series.
const seriesCode = (n) => (n <= 26 ? String.fromCharCode(64 + n) : seriesCode(Math.floor((n - 1) / 26)) + seriesCode(((n - 1) % 26) + 1));
export const SERVER_SERIES = '0';

// Sales and returns recorded before GST support get their tax split worked out once, as intra-state.
function backfillTax(db) {
  const sales = db.prepare('SELECT id, discount FROM sales WHERE taxable IS NULL').all();
  for (const sale of sales) {
    const lines = db.prepare('SELECT id, line_total, gst_rate FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.id);
    const split = splitTax(lines.map((l) => ({ amount: l.line_total, rate: l.gst_rate })), sale.discount, false);
    const t = { taxable: 0, cgst: 0, sgst: 0 };
    lines.forEach((l, i) => {
      db.prepare('UPDATE sale_items SET taxable = ?, cgst = ?, sgst = ? WHERE id = ?').run(split[i].taxable, split[i].cgst, split[i].sgst, l.id);
      for (const k of Object.keys(t)) t[k] += split[i][k];
    });
    db.prepare('UPDATE sales SET taxable = ?, cgst = ?, sgst = ? WHERE id = ?').run(t.taxable, t.cgst, t.sgst, sale.id);
  }
  const returns = db.prepare('SELECT id FROM sale_returns WHERE taxable IS NULL').all();
  for (const r of returns) {
    const t = { taxable: 0, cgst: 0, sgst: 0 };
    for (const l of db.prepare('SELECT id, line_total, gst_rate FROM sale_return_items WHERE return_id = ?').all(r.id)) {
      const x = taxOf(l.line_total, l.gst_rate, false);
      db.prepare('UPDATE sale_return_items SET taxable = ?, cgst = ?, sgst = ? WHERE id = ?').run(x.taxable, x.cgst, x.sgst, l.id);
      for (const k of Object.keys(t)) t[k] += x[k];
    }
    db.prepare('UPDATE sale_returns SET taxable = ?, cgst = ?, sgst = ? WHERE id = ?').run(t.taxable, t.cgst, t.sgst, r.id);
  }
}

const PARTIES = {
  customer: {
    table: 'customers', ledger: 'ledger_entries', fk: 'customer_id', label: 'customer', Label: 'Customer',
    owes: (name) => `${name} owes`,
  },
  supplier: {
    table: 'suppliers', ledger: 'supplier_ledger', fk: 'supplier_id', label: 'supplier', Label: 'Supplier',
    owes: (name) => `You owe ${name}`,
  },
};

const BALANCE_SQL = `COALESCE(SUM(CASE WHEN l.type IN ('payment', 'return') THEN -l.amount ELSE l.amount END), 0)`;

// { field: [old, new] } for the fields that changed.
function diff(before, after, keys = Object.keys(after)) {
  const out = {};
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = [before[k] ?? null, after[k] ?? null];
  return out;
}

export { GST_RATES, UQC, hsnValid };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function openDb(path = 'data/hisaab.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const [table, column, type, backfill] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      if (backfill) db.exec(backfill);
    }
  }
  for (const [table, createSql, marker] of REBUILDS) rebuildIfOutdated(db, table, createSql, marker);
  db.exec(SCHEMA); // recreate indexes dropped by a rebuild
  db.exec(POST_MIGRATION);
  db.exec('BEGIN');
  backfillTax(db);
  db.exec('COMMIT');
  return new Store(db);
}

// SQLite can't change a CHECK constraint in place, so copy the table into the new definition.
function rebuildIfOutdated(db, table, createSql, marker) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (sql.includes(marker)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_old`);
    db.exec(`DROP TABLE ${table}_old`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  // Indian mobile numbers are stored without the country code so +91 98… and 98… match.
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits || null;
}

class Store {
  constructor(db) {
    this.db = db;
  }

  transaction(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  // --- settings, devices, document numbers, audit ----------------------

  getShop() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'shop'").get();
    return { ...DEFAULT_SHOP, ...(row ? JSON.parse(row.value) : {}) };
  }

  // Validates and saves the shop profile. A regular GST registration needs a valid GSTIN, legal
  // name and address; the state comes from the GSTIN.
  updateShop(fields) {
    return this.transaction(() => {
      const before = this.getShop();
      const shop = { ...before, ...fields };
      if (shop.gstin) {
        shop.gstin = shop.gstin.toUpperCase();
        if (!gstinValid(shop.gstin)) throw new HttpError(400, 'That GSTIN is not valid — check for a typo');
        shop.state_code = shop.gstin.slice(0, 2);
      }
      if (shop.state_code && !STATES[shop.state_code]) throw new HttpError(400, 'Unknown state code');
      if (shop.gst_registered) {
        if (!shop.gstin) throw new HttpError(400, 'Enter your GSTIN to issue tax invoices');
        if (!shop.legal_name || !shop.address) throw new HttpError(400, 'Legal name and address are printed on every tax invoice');
      }
      if (![4, 6].includes(shop.hsn_digits)) throw new HttpError(400, 'hsn_digits must be 4 or 6');
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES ('shop', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(shop));
      this.audit('settings', null, 'update', diff(before, shop));
      return shop;
    });
  }

  registerDevice(name = null) {
    return this.transaction(() => {
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM devices').get();
      const code = seriesCode(n + 1);
      const { lastInsertRowid: id } = this.db.prepare('INSERT INTO devices (code, name) VALUES (?, ?)').run(code, name);
      this.audit('device', Number(id), 'create', { code, name });
      return this.getDevice(id);
    });
  }

  // A device and the last number it has used in each document series, so a phone whose
  // storage was cleared can carry on from the right number.
  getDevice(id) {
    const d = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!d) return null;
    d.counters = this.db.prepare('SELECT doc, fy, last FROM doc_counters WHERE series = ?').all(d.code);
    return d;
  }

  // Local date and financial year of a UTC timestamp, in the shop's time zone.
  localInfo(createdAt) {
    const ts = createdAt ?? this.db.prepare("SELECT datetime('now') AS t").get().t;
    const day = localDate(ts, this.getShop().tz_offset);
    return { day, fy: financialYear(day).short };
  }

  // Number for a new invoice or credit note. A device sends the number it allocated from its own
  // series; it must be well-formed, belong to a registered device, match the document's financial
  // year and not be taken. Without one, the next number in the server's own series is used.
  #claimNumber(doc, number, createdAt) {
    const { fy } = this.localInfo(createdAt);
    let series, seq;
    if (number) {
      const parsed = parseDocNumber(number);
      if (!parsed || parsed.doc !== doc) throw new HttpError(400, `${number} is not a valid ${doc === 'invoice' ? 'invoice' : 'credit note'} number`);
      if (parsed.fy !== fy) throw new HttpError(400, `${number} is for financial year ${parsed.fy}, but this document is dated in ${fy}`);
      if (!this.db.prepare('SELECT 1 FROM devices WHERE code = ?').get(parsed.series)) {
        throw new HttpError(400, `Series ${parsed.series} does not belong to a registered device`);
      }
      const table = doc === 'invoice' ? 'sales WHERE invoice_no' : 'sale_returns WHERE note_no';
      if (this.db.prepare(`SELECT 1 FROM ${table} = ?`).get(number)
        || this.db.prepare('SELECT 1 FROM voided_documents WHERE number = ?').get(number)) {
        throw new HttpError(409, `${number} has already been used`);
      }
      ({ series, seq } = parsed);
    } else {
      series = SERVER_SERIES;
      const row = this.db.prepare('SELECT last FROM doc_counters WHERE series = ? AND doc = ? AND fy = ?').get(series, doc, fy);
      seq = (row?.last ?? 0) + 1;
    }
    this.db
      .prepare(
        `INSERT INTO doc_counters (series, doc, fy, last) VALUES (?, ?, ?, ?)
         ON CONFLICT(series, doc, fy) DO UPDATE SET last = MAX(last, excluded.last)`
      )
      .run(series, doc, fy, seq);
    return number ?? (doc === 'invoice' ? `${series}/${fy}/${String(seq).padStart(5, '0')}` : `CN${series}/${fy}/${String(seq).padStart(4, '0')}`);
  }

  // Records a device-allocated number that will never be issued, so the gap shows as cancelled.
  voidNumber(number, reason = null) {
    const parsed = parseDocNumber(number);
    if (!parsed) throw new HttpError(400, 'Not a valid document number');
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM devices WHERE code = ?').get(parsed.series)) throw new HttpError(400, 'Unknown series');
      const table = parsed.doc === 'invoice' ? 'sales WHERE invoice_no' : 'sale_returns WHERE note_no';
      if (this.db.prepare(`SELECT 1 FROM ${table} = ?`).get(number)) throw new HttpError(409, `${number} was issued and cannot be voided`);
      const seen = this.db.prepare('SELECT * FROM voided_documents WHERE number = ?').get(number);
      if (seen) return seen;
      const { lastInsertRowid: id } = this.db
        .prepare('INSERT INTO voided_documents (doc, number, reason) VALUES (?, ?, ?)')
        .run(parsed.doc, number, reason);
      this.db
        .prepare(
          `INSERT INTO doc_counters (series, doc, fy, last) VALUES (?, ?, ?, ?)
           ON CONFLICT(series, doc, fy) DO UPDATE SET last = MAX(last, excluded.last)`
        )
        .run(parsed.series, parsed.doc, parsed.fy, parsed.seq);
      this.audit('document', Number(id), 'void', { number, reason });
      return this.db.prepare('SELECT * FROM voided_documents WHERE id = ?').get(id);
    });
  }

  audit(entity, entityId, action, changes) {
    if (changes && typeof changes === 'object' && !Object.keys(changes).length) return;
    this.db
      .prepare('INSERT INTO audit_log (entity, entity_id, action, changes) VALUES (?, ?, ?, ?)')
      .run(entity, entityId, action, changes === undefined ? null : JSON.stringify(changes));
  }

  listAudit({ limit = 100, entity } = {}) {
    const rows = entity
      ? this.db.prepare('SELECT * FROM audit_log WHERE entity = ? ORDER BY id DESC LIMIT ?').all(entity, limit)
      : this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null }));
  }

  // Rule 57: keep a restorable backup. Writes a consistent copy of the whole database to `path`.
  backupTo(path) {
    this.db.prepare('VACUUM INTO ?').run(path);
  }

  // --- products ---------------------------------------------------------

  listProducts({ q, lowStock } = {}) {
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    if (q) {
      sql += ' AND (name LIKE ? OR barcode LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (lowStock) sql += ' AND quantity <= low_stock';
    sql += ' ORDER BY name COLLATE NOCASE';
    return this.db.prepare(sql).all(...params);
  }

  getProduct(id) {
    return this.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  }

  getByBarcode(barcode) {
    return this.db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
  }

  createProduct({
    barcode, name, price, cost = 0, gst_rate = 0, quantity = 0, low_stock = 5, hsn = null, unit = 'NOS',
  }, clientId = null) {
    if (this.getByBarcode(barcode)) throw new HttpError(409, `Barcode ${barcode} already exists`);
    return this.transaction(() => {
      const { lastInsertRowid: id } = this.db
        .prepare(
          `INSERT INTO products (barcode, name, price, cost, gst_rate, quantity, low_stock, hsn, unit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(barcode, name, price, cost, gst_rate, quantity, low_stock, hsn, unit);
      this.audit('product', Number(id), 'create', { barcode, name, price, cost, gst_rate, hsn, unit });
      if (quantity > 0) this.#move(id, quantity, 'stock_in', null, 'Initial stock', clientId);
      return this.getProduct(id);
    });
  }

  updateProduct(id, fields) {
    const product = this.getProduct(id);
    if (!product) throw new HttpError(404, 'Product not found');
    const allowed = ['name', 'price', 'cost', 'gst_rate', 'low_stock', 'barcode', 'hsn', 'unit'];
    const sets = Object.keys(fields).filter((k) => allowed.includes(k));
    if (sets.length) {
      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE products SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
          )
          .run(...sets.map((k) => fields[k]), id);
        this.audit('product', id, 'update', diff(product, this.getProduct(id), sets));
      });
    }
    return this.getProduct(id);
  }

  // Add (positive) or remove (negative) stock outside of a sale.
  adjustStock(id, change, reason, note = null, clientId = null) {
    return this.transaction(() => {
      const product = this.getProduct(id);
      if (!product) throw new HttpError(404, 'Product not found');
      if (product.quantity + change < 0) {
        throw new HttpError(409, `Only ${product.quantity} of ${product.name} in stock`);
      }
      this.db
        .prepare("UPDATE products SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?")
        .run(change, id);
      this.#move(id, change, reason, null, note, clientId);
      return this.getProduct(id);
    });
  }

  // The product a previously synced stock change applied to, if this client_id was seen before.
  productForMovement(clientId) {
    return this.db
      .prepare('SELECT p.* FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE m.client_id = ?')
      .get(clientId);
  }

  movements(productId) {
    return this.db
      .prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT 100')
      .all(productId);
  }

  // --- khata: customers (they owe us) and suppliers (we owe them) -------

  listCustomers(opts) { return this.#listParties(PARTIES.customer, opts); }
  getCustomer(id) { return this.#getParty(PARTIES.customer, id); }
  getCustomerByPhone(phone) { return this.#partyByPhone(PARTIES.customer, phone); }
  createCustomer(fields) { return this.#createParty(PARTIES.customer, fields); }
  recordPayment(id, payment) { return this.#recordPartyPayment(PARTIES.customer, id, payment); }

  listSuppliers(opts) { return this.#listParties(PARTIES.supplier, opts); }
  createSupplier(fields) { return this.#createParty(PARTIES.supplier, fields); }
  recordSupplierPayment(id, payment) { return this.#recordPartyPayment(PARTIES.supplier, id, payment); }
  getSupplier(id) {
    const s = this.#getParty(PARTIES.supplier, id);
    if (s) {
      s.purchases = this.db.prepare('SELECT * FROM purchases WHERE supplier_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(id);
      s.returns = this.db.prepare('SELECT * FROM purchase_returns WHERE supplier_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(id);
    }
    return s;
  }

  #listParties(P, { q, dueOnly } = {}) {
    let sql = `SELECT c.*, ${BALANCE_SQL} AS balance, MAX(l.created_at) AS last_activity
               FROM ${P.table} c LEFT JOIN ${P.ledger} l ON l.${P.fk} = c.id WHERE 1=1`;
    const params = [];
    if (q) {
      sql += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ' GROUP BY c.id';
    if (dueOnly) sql += ' HAVING balance > 0';
    sql += ' ORDER BY balance DESC, c.name COLLATE NOCASE';
    return this.db.prepare(sql).all(...params);
  }

  #getParty(P, id) {
    const c = this.db
      .prepare(
        `SELECT c.*, ${BALANCE_SQL} AS balance FROM ${P.table} c
         LEFT JOIN ${P.ledger} l ON l.${P.fk} = c.id WHERE c.id = ? GROUP BY c.id`
      )
      .get(id);
    if (!c) return null;
    c.entries = this.db
      .prepare(`SELECT * FROM ${P.ledger} WHERE ${P.fk} = ? ORDER BY created_at DESC, id DESC LIMIT 200`)
      .all(id);
    return c;
  }

  #partyByPhone(P, phone) {
    const p = normalizePhone(phone);
    return p ? this.db.prepare(`SELECT * FROM ${P.table} WHERE phone = ?`).get(p) : undefined;
  }

  #createParty(P, { name, phone = null, gstin = null, opening_balance = 0, note = null }) {
    phone = normalizePhone(phone);
    if (phone && this.#partyByPhone(P, phone)) throw new HttpError(409, `A ${P.label} with this phone already exists`);
    return this.transaction(() => {
      const id = this.#insertParty(P, name, phone, gstin);
      if (opening_balance > 0) {
        this.db
          .prepare(`INSERT INTO ${P.ledger} (${P.fk}, type, amount, note) VALUES (?, 'opening', ?, ?)`)
          .run(id, opening_balance, note ?? 'Opening balance');
      }
      return P === PARTIES.supplier ? this.getSupplier(id) : this.getCustomer(id);
    });
  }

  #insertParty(P, name, phone, gstin = null) {
    const { lastInsertRowid } = P === PARTIES.supplier
      ? this.db.prepare('INSERT INTO suppliers (name, phone, gstin) VALUES (?, ?, ?)').run(name, phone, gstin)
      : this.db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run(name, phone);
    return lastInsertRowid;
  }

  // Find by id or phone; create when a name is given and no match exists.
  #resolveParty(P, { id, name, phone }, { create }) {
    if (id) {
      const c = this.db.prepare(`SELECT * FROM ${P.table} WHERE id = ?`).get(id);
      if (!c) throw new HttpError(404, `${P.Label} not found`);
      return c;
    }
    const existing = this.#partyByPhone(P, phone);
    if (existing) return existing;
    // Regulars are often known by name alone; match on name when no phone is given.
    if (!normalizePhone(phone) && name) {
      const byName = this.db.prepare(`SELECT * FROM ${P.table} WHERE name = ? COLLATE NOCASE`).all(name);
      if (byName.length === 1) return byName[0];
      if (byName.length > 1) throw new HttpError(409, `More than one ${P.label} is called ${name} — add their phone number`);
    }
    if (!create) return null;
    if (!name) throw new HttpError(400, `${P.Label} name is required`);
    const newId = this.#insertParty(P, name, normalizePhone(phone));
    return this.db.prepare(`SELECT * FROM ${P.table} WHERE id = ?`).get(newId);
  }

  #recordPartyPayment(P, partyId, { amount, method = 'cash', note = null, client_id = null, created_at = null }) {
    const get = (id) => (P === PARTIES.supplier ? this.getSupplier(id) : this.getCustomer(id));
    return this.transaction(() => {
      if (client_id) {
        const seen = this.db.prepare(`SELECT ${P.fk} AS id FROM ${P.ledger} WHERE client_id = ?`).get(client_id);
        if (seen) return { duplicate: true, party: get(seen.id) };
      }
      const party = get(partyId);
      if (!party) throw new HttpError(404, `${P.Label} not found`);
      if (amount > party.balance) {
        throw new HttpError(409, `${P.owes(party.name)} only ₹${(party.balance / 100).toFixed(2)}`);
      }
      this.db
        .prepare(
          `INSERT INTO ${P.ledger} (${P.fk}, type, amount, method, note, client_id, created_at)
           VALUES (?, 'payment', ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        )
        .run(partyId, amount, method, note, client_id, created_at);
      return { duplicate: false, party: get(partyId) };
    });
  }

  // --- supplier purchases -----------------------------------------------

  // Records a supplier bill: adds every line to stock (creating new products on the way),
  // updates each product's cost price, and puts the unpaid part on the supplier's khata.
  // items: [{ barcode, quantity, unit_cost, name?, price?, gst_rate?, low_stock? }]
  createPurchase({
    supplier_id = null, supplier_name = null, supplier_phone = null, invoice_no = null, items,
    paid = 0, payment_method = 'cash', note = null, client_id = null, created_at = null,
  }) {
    return this.transaction(() => {
      if (client_id) {
        const seen = this.db.prepare('SELECT id FROM purchases WHERE client_id = ?').get(client_id);
        if (seen) return { ...this.getPurchase(seen.id), duplicate: true };
      }
      const supplier = this.#resolveParty(
        PARTIES.supplier, { id: supplier_id, name: supplier_name, phone: supplier_phone }, { create: true }
      );
      const total = items.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
      if (paid > total) throw new HttpError(400, 'Paid amount cannot exceed the bill total');

      const { lastInsertRowid: purchaseId } = this.db
        .prepare(
          `INSERT INTO purchases (supplier_id, invoice_no, total, paid, payment_method, note, client_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        )
        .run(supplier.id, invoice_no, total, paid, payment_method, note, client_id, created_at);

      const insertItem = this.db.prepare(
        `INSERT INTO purchase_items (purchase_id, product_id, barcode, name, quantity, unit_cost, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        let p = this.getByBarcode(item.barcode);
        if (!p) {
          if (!item.name || item.price === undefined) {
            throw new HttpError(400, `New product ${item.barcode} needs a name and selling price`);
          }
          const { lastInsertRowid } = this.db
            .prepare('INSERT INTO products (barcode, name, price, cost, gst_rate, low_stock, hsn, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(item.barcode, item.name, item.price, item.unit_cost, item.gst_rate ?? 0, item.low_stock ?? 5, item.hsn ?? null, item.unit ?? 'NOS');
          p = this.getProduct(lastInsertRowid);
        }
        this.db
          .prepare("UPDATE products SET quantity = quantity + ?, cost = ?, updated_at = datetime('now') WHERE id = ?")
          .run(item.quantity, item.unit_cost, p.id);
        this.db
          .prepare(
            `INSERT INTO stock_movements (product_id, change, reason, purchase_id, note)
             VALUES (?, ?, 'stock_in', ?, ?)`
          )
          .run(p.id, item.quantity, purchaseId, `Purchase from ${supplier.name}`);
        insertItem.run(purchaseId, p.id, p.barcode, p.name, item.quantity, item.unit_cost, item.quantity * item.unit_cost);
      }

      const ledger = this.db.prepare(
        `INSERT INTO supplier_ledger (supplier_id, type, amount, purchase_id, method, created_at)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
      );
      if (total > 0) ledger.run(supplier.id, 'purchase', total, purchaseId, null, created_at);
      if (paid > 0) ledger.run(supplier.id, 'payment', paid, purchaseId, payment_method, created_at);
      return { ...this.getPurchase(purchaseId), duplicate: false };
    });
  }

  getPurchase(id) {
    const p = this.db
      .prepare('SELECT p.*, s.name AS supplier_name FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?')
      .get(id);
    if (!p) return null;
    p.items = this.db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
    return p;
  }

  listPurchases({ supplierId, limit = 50 } = {}) {
    let sql = 'SELECT p.*, s.name AS supplier_name FROM purchases p JOIN suppliers s ON s.id = p.supplier_id';
    const params = [];
    if (supplierId) {
      sql += ' WHERE p.supplier_id = ?';
      params.push(supplierId);
    }
    sql += ' ORDER BY p.created_at DESC, p.id DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // --- purchase returns -------------------------------------------------

  // Sends goods back to a supplier. Stock goes down and the value comes off what we owe them
  // (settlement 'adjust'), or is recorded as a cash refund ('refund'), which leaves the balance as is.
  // With purchase_id, each line must be on that bill and can't exceed what is left to return from it;
  // unit_cost then defaults to that bill's cost, otherwise to the product's current cost price.
  // items: [{ barcode, quantity, unit_cost? }]
  createReturn({
    supplier_id, purchase_id = null, items, settlement = 'adjust', refund_method = null, reason = null,
    client_id = null, created_at = null,
  }) {
    return this.transaction(() => {
      if (client_id) {
        const seen = this.db.prepare('SELECT id FROM purchase_returns WHERE client_id = ?').get(client_id);
        if (seen) return { ...this.getReturn(seen.id), duplicate: true };
      }
      const supplier = this.db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplier_id);
      if (!supplier) throw new HttpError(404, 'Supplier not found');

      let billLines = null;
      if (purchase_id) {
        const bill = this.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id);
        if (!bill || bill.supplier_id !== supplier.id) throw new HttpError(400, `Purchase #${purchase_id} is not from ${supplier.name}`);
        billLines = this.returnableFromPurchase(purchase_id);
      }

      // Merge repeated barcodes so the stock and bill checks see the full quantity.
      const merged = new Map();
      for (const item of items) {
        const line = merged.get(item.barcode) ?? { ...item, quantity: 0 };
        line.quantity += item.quantity;
        if (item.unit_cost !== undefined) line.unit_cost = item.unit_cost;
        merged.set(item.barcode, line);
      }

      const lines = [];
      for (const item of merged.values()) {
        const p = this.getByBarcode(item.barcode);
        if (!p) throw new HttpError(404, `Product ${item.barcode} not found`);
        if (p.quantity < item.quantity) throw new HttpError(409, `Only ${p.quantity} of ${p.name} in stock to return`);
        let unitCost = item.unit_cost ?? p.cost;
        if (billLines) {
          const billLine = billLines.find((l) => l.product_id === p.id);
          if (!billLine) throw new HttpError(400, `${p.name} is not on purchase #${purchase_id}`);
          if (item.quantity > billLine.returnable) {
            throw new HttpError(409, `Only ${billLine.returnable} of ${p.name} left to return from purchase #${purchase_id}`);
          }
          unitCost = item.unit_cost ?? billLine.unit_cost;
        }
        lines.push({ p, quantity: item.quantity, unit_cost: unitCost, line_total: unitCost * item.quantity });
      }
      const total = lines.reduce((s, l) => s + l.line_total, 0);

      const { lastInsertRowid: returnId } = this.db
        .prepare(
          `INSERT INTO purchase_returns (supplier_id, purchase_id, total, settlement, refund_method, reason, client_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        )
        .run(supplier.id, purchase_id, total, settlement, settlement === 'refund' ? refund_method : null, reason, client_id, created_at);

      const insertItem = this.db.prepare(
        `INSERT INTO purchase_return_items (return_id, product_id, barcode, name, quantity, unit_cost, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const { p, quantity, unit_cost, line_total } of lines) {
        insertItem.run(returnId, p.id, p.barcode, p.name, quantity, unit_cost, line_total);
        this.db
          .prepare("UPDATE products SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?")
          .run(quantity, p.id);
        this.db
          .prepare(
            `INSERT INTO stock_movements (product_id, change, reason, return_id, purchase_id, note)
             VALUES (?, ?, 'purchase_return', ?, ?, ?)`
          )
          .run(p.id, -quantity, returnId, purchase_id, `Returned to ${supplier.name}${reason ? ' — ' + reason : ''}`);
      }

      if (total > 0) {
        const ledger = this.db.prepare(
          `INSERT INTO supplier_ledger (supplier_id, type, amount, return_id, purchase_id, method, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        );
        ledger.run(supplier.id, 'return', total, returnId, purchase_id, null, reason, created_at);
        if (settlement === 'refund') {
          ledger.run(supplier.id, 'refund', total, returnId, purchase_id, refund_method, 'Cash back for return', created_at);
        }
      }
      return { ...this.getReturn(returnId), duplicate: false };
    });
  }

  // Lines of a purchase with how many units are still returnable after earlier returns against it.
  returnableFromPurchase(purchaseId) {
    return this.db
      .prepare(
        `SELECT pi.product_id, pi.barcode, pi.name, pi.unit_cost, SUM(pi.quantity) AS bought,
                COALESCE((SELECT SUM(ri.quantity) FROM purchase_return_items ri JOIN purchase_returns r ON r.id = ri.return_id
                          WHERE r.purchase_id = pi.purchase_id AND ri.product_id = pi.product_id), 0) AS returned
         FROM purchase_items pi WHERE pi.purchase_id = ? GROUP BY pi.product_id`
      )
      .all(purchaseId)
      .map((l) => ({ ...l, returnable: l.bought - l.returned }));
  }

  getReturn(id) {
    const r = this.db
      .prepare('SELECT r.*, s.name AS supplier_name FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ?')
      .get(id);
    if (!r) return null;
    r.items = this.db.prepare('SELECT * FROM purchase_return_items WHERE return_id = ? ORDER BY id').all(id);
    return r;
  }

  listReturns({ supplierId, limit = 50 } = {}) {
    let sql = 'SELECT r.*, s.name AS supplier_name FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id';
    const params = [];
    if (supplierId) {
      sql += ' WHERE r.supplier_id = ?';
      params.push(supplierId);
    }
    sql += ' ORDER BY r.created_at DESC, r.id DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // --- supplier reports -------------------------------------------------

  // One row per supplier for [from, to): bills, amounts bought/returned/paid in the period, plus
  // the current balance and last purchase (all-time). Suppliers with no activity and no dues are left out.
  supplierReport({ from, to }) {
    const inRange = (alias) => `${alias}.created_at >= ? AND ${alias}.created_at < ?`;
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.phone, s.gstin,
           (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id AND ${inRange('p')}) AS bills,
           (SELECT COALESCE(SUM(total), 0) FROM purchases p WHERE p.supplier_id = s.id AND ${inRange('p')}) AS purchased,
           (SELECT COALESCE(SUM(total), 0) FROM purchase_returns r WHERE r.supplier_id = s.id AND ${inRange('r')}) AS returned,
           (SELECT COALESCE(SUM(amount), 0) FROM supplier_ledger l WHERE l.supplier_id = s.id AND l.type = 'payment' AND ${inRange('l')}) AS paid,
           (SELECT COALESCE(SUM(amount), 0) FROM supplier_ledger l WHERE l.supplier_id = s.id AND l.type = 'refund' AND ${inRange('l')}) AS refunded,
           (SELECT ${BALANCE_SQL} FROM supplier_ledger l WHERE l.supplier_id = s.id) AS balance,
           (SELECT MAX(created_at) FROM purchases p WHERE p.supplier_id = s.id) AS last_purchase_at
         FROM suppliers s`
      )
      .all(from, to, from, to, from, to, from, to, from, to)
      .map((r) => ({ ...r, net_purchased: r.purchased - r.returned }))
      .filter((r) => r.bills || r.returned || r.paid || r.refunded || r.balance)
      .sort((a, b) => b.net_purchased - a.net_purchased || b.balance - a.balance);
    const totals = {};
    for (const key of ['bills', 'purchased', 'returned', 'net_purchased', 'paid', 'refunded', 'balance']) {
      totals[key] = rows.reduce((sum, r) => sum + r[key], 0);
    }
    return { from, to, rows, totals };
  }

  // What was bought from one supplier in [from, to), product by product, net of returns.
  supplierItemsReport(supplierId, { from, to }) {
    const supplier = this.getSupplier(supplierId);
    if (!supplier) throw new HttpError(404, 'Supplier not found');
    const items = this.db
      .prepare(
        `WITH bought AS (
           SELECT pi.product_id, SUM(pi.quantity) AS qty, SUM(pi.line_total) AS amount
           FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
           WHERE p.supplier_id = ? AND p.created_at >= ? AND p.created_at < ? GROUP BY pi.product_id),
         back AS (
           SELECT ri.product_id, SUM(ri.quantity) AS qty, SUM(ri.line_total) AS amount
           FROM purchase_return_items ri JOIN purchase_returns r ON r.id = ri.return_id
           WHERE r.supplier_id = ? AND r.created_at >= ? AND r.created_at < ? GROUP BY ri.product_id)
         SELECT pr.id AS product_id, pr.barcode, pr.name,
                COALESCE(b.qty, 0) AS bought_qty, COALESCE(b.amount, 0) AS bought_amount,
                COALESCE(k.qty, 0) AS returned_qty, COALESCE(k.amount, 0) AS returned_amount
         FROM products pr
         LEFT JOIN bought b ON b.product_id = pr.id
         LEFT JOIN back k ON k.product_id = pr.id
         WHERE b.product_id IS NOT NULL OR k.product_id IS NOT NULL
         ORDER BY COALESCE(b.amount, 0) - COALESCE(k.amount, 0) DESC, pr.name COLLATE NOCASE`
      )
      .all(supplierId, from, to, supplierId, from, to)
      .map((i) => ({ ...i, avg_cost: i.bought_qty ? Math.round(i.bought_amount / i.bought_qty) : null }));
    const summary = this.supplierReport({ from, to }).rows.find((r) => r.id === supplierId) ?? {
      bills: 0, purchased: 0, returned: 0, net_purchased: 0, paid: 0, refunded: 0, balance: supplier.balance,
    };
    const inRange = 'supplier_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC';
    return {
      from, to,
      supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone, gstin: supplier.gstin, balance: supplier.balance },
      summary,
      items,
      purchases: this.db.prepare(`SELECT * FROM purchases WHERE ${inRange}`).all(supplierId, from, to),
      returns: this.db.prepare(`SELECT * FROM purchase_returns WHERE ${inRange}`).all(supplierId, from, to),
    };
  }

  // --- sales ------------------------------------------------------------

  // Records a sale and removes the sold quantities from stock in one atomic step.
  // Items name a product by product_id or barcode. If any line is short on stock, nothing is
  // written — unless allowOversell is set (a sale already made while offline), in which case
  // stock bottoms out at zero and the shortfall is logged as an adjustment to recount.
  // Records a sale and removes the sold quantities from stock in one atomic step.
  // Items name a product by product_id or barcode. If any line is short on stock, nothing is
  // written — unless allowOversell is set (a sale already made while offline), in which case
  // stock bottoms out at zero and the shortfall is logged as an adjustment to recount.
  // Checks the GST rules for a tax invoice before anything is written (regular registration only).
  #checkInvoice(shop, lines, { buyer_gstin, customer_name, buyer_address, total }) {
    const b2b = Boolean(buyer_gstin);
    if (b2b) {
      if (!gstinValid(buyer_gstin)) throw new HttpError(400, `Buyer GSTIN ${buyer_gstin} is not valid`);
      if (buyer_gstin === shop.gstin) throw new HttpError(400, 'Buyer GSTIN is your own GSTIN');
      if (!customer_name || !buyer_address) throw new HttpError(400, "A B2B invoice needs the buyer's legal name and address");
    } else if (total >= 50_000_00 && (!customer_name || !buyer_address)) {
      // Rule 46(e): unregistered buyer, value ₹50,000 or more.
      throw new HttpError(400, "Bills of ₹50,000 or more need the customer's name and address");
    }
    for (const l of lines) {
      if (!GST_RATES.includes(l.gst_rate)) throw new HttpError(400, `${l.name}: ${l.gst_rate}% is not a GST rate`);
      if (l.hsn && !hsnValid(l.hsn)) throw new HttpError(400, `${l.name}: HSN ${l.hsn} should be 4, 6 or 8 digits`);
      // Notification 78/2020: HSN is required on B2B invoices (and on all invoices above ₹5 crore
      // turnover) with at least 4 or 6 digits.
      const needed = b2b || shop.hsn_digits === 6;
      if (needed && (!l.hsn || l.hsn.length < shop.hsn_digits)) {
        throw new HttpError(400, `${l.name} needs a ${shop.hsn_digits}-digit HSN code${b2b ? ' on a B2B invoice' : ''} — add it in Inventory`);
      }
    }
  }

  // Records a sale and removes the sold quantities from stock in one atomic step.
  // Items name a product by product_id or barcode. If any line is short on stock, nothing is
  // written — unless allowOversell is set (a sale already made while offline), in which case
  // stock bottoms out at zero and the shortfall is logged as an adjustment to recount.
  // An offline sale also carries each line as it was printed (unit_price, gst_rate, hsn, unit), so
  // the recorded invoice matches the one the customer was given even if prices changed since.
  // For a GST-registered shop the sale is a tax invoice: numbered (invoice_no from the device's
  // series, or the server's), with place of supply, CGST/SGST or IGST per line, and B2B details.
  createSale({
    items, discount = 0, payment_method = 'cash', customer_id = null, customer_name = null,
    customer_phone = null, client_id = null, created_at = null, allowOversell = false,
    invoice_no = null, buyer_gstin = null, buyer_address = null, place_of_supply = null,
  }) {
    return this.transaction(() => {
      if (client_id) {
        const seen = this.db.prepare('SELECT id FROM sales WHERE client_id = ?').get(client_id);
        if (seen) return { ...this.getSale(seen.id), duplicate: true };
      }
      const shop = this.getShop();
      const gst = shop.gst_registered;
      buyer_gstin = buyer_gstin ? buyer_gstin.toUpperCase() : null;

      // Merge duplicate lines for the same product so the stock check sees the full demand.
      const wanted = new Map();
      for (const item of items) {
        const p = item.product_id ? this.getProduct(item.product_id) : this.getByBarcode(item.barcode);
        if (!p) throw new HttpError(404, `Product ${item.product_id ?? item.barcode} not found`);
        const line = wanted.get(p.id) ?? { p, quantity: 0, printed: allowOversell && item.unit_price !== undefined ? item : null };
        line.quantity += item.quantity;
        wanted.set(p.id, line);
      }

      const lines = [];
      for (const { p, quantity, printed } of wanted.values()) {
        if (p.quantity < quantity && !allowOversell) {
          throw new HttpError(409, `Only ${p.quantity} of ${p.name} in stock`);
        }
        const unit_price = printed?.unit_price ?? p.price;
        lines.push({
          p, quantity, unit_price, line_total: unit_price * quantity, name: p.name,
          gst_rate: printed?.gst_rate ?? p.gst_rate, hsn: printed?.hsn ?? p.hsn, unit: printed?.unit ?? p.unit,
        });
      }

      const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
      if (discount > subtotal) throw new HttpError(400, 'Discount cannot exceed the bill amount');
      const total = subtotal - discount;
      if (gst) {
        const problem = invoiceProblem(shop, lines, { buyer_gstin, customer_name, buyer_address, total });
        if (problem) throw new HttpError(400, problem);
      }

      const pos = place_of_supply ?? (buyer_gstin && !gst ? null : shop.state_code) ?? null;
      if (pos && !STATES[pos]) throw new HttpError(400, `Unknown place of supply ${pos}`);
      const interState = Boolean(gst && pos && pos !== shop.state_code);
      const split = splitTax(lines.map((l) => ({ amount: l.line_total, rate: l.gst_rate })), discount, interState);
      const sum = (k) => split.reduce((s, x) => s + x[k], 0);

      const credit = payment_method === 'credit';
      const customer = this.#resolveParty(
        PARTIES.customer, { id: customer_id, name: customer_name, phone: customer_phone }, { create: credit }
      );
      if (credit && !customer) throw new HttpError(400, 'Udhaar needs a customer name');
      if (customer && buyer_gstin && !customer.gstin) {
        this.db.prepare('UPDATE customers SET gstin = ?, address = COALESCE(address, ?) WHERE id = ?').run(buyer_gstin, buyer_address, customer.id);
      }

      const number = this.#claimNumber('invoice', invoice_no, created_at);
      const { lastInsertRowid: saleId } = this.db
        .prepare(
          `INSERT INTO sales (subtotal, discount, total, tax, payment_method, customer_id, customer_name,
                              customer_phone, client_id, created_at, invoice_no, buyer_gstin, buyer_address,
                              place_of_supply, inter_state, taxable, cgst, sgst, igst)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          subtotal, discount, total, sum('cgst') + sum('sgst') + sum('igst'), payment_method, customer?.id ?? null,
          customer_name ?? customer?.name ?? null, customer?.phone ?? normalizePhone(customer_phone), client_id, created_at,
          number, buyer_gstin, buyer_address, pos, interState ? 1 : 0, sum('taxable'), sum('cgst'), sum('sgst'), sum('igst')
        );

      const insertItem = this.db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, barcode, name, quantity, unit_price, unit_cost, gst_rate, line_total,
                                 hsn, unit, taxable, cgst, sgst, igst)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const decrement = this.db.prepare(
        "UPDATE products SET quantity = MAX(quantity - ?, 0), updated_at = datetime('now') WHERE id = ?"
      );
      const warnings = [];
      lines.forEach(({ p, quantity, unit_price, gst_rate, line_total, hsn, unit }, i) => {
        const t = split[i];
        insertItem.run(saleId, p.id, p.barcode, p.name, quantity, unit_price, p.cost, gst_rate, line_total,
          hsn, unit, t.taxable, t.cgst, t.sgst, t.igst);
        decrement.run(quantity, p.id);
        this.#move(p.id, -quantity, 'sale', saleId, null);
        const shortfall = quantity - p.quantity;
        if (shortfall > 0) {
          this.#move(p.id, shortfall, 'adjustment', saleId, `Sold ${shortfall} more than recorded stock while offline — please recount`);
          warnings.push(`${p.name}: sold ${shortfall} more than in stock — please recount`);
        }
      });

      if (credit && total > 0) {
        this.db
          .prepare(
            `INSERT INTO ledger_entries (customer_id, type, amount, sale_id, created_at)
             VALUES (?, 'credit_sale', ?, ?, COALESCE(?, datetime('now')))`
          )
          .run(customer.id, total, saleId, created_at);
      }
      return { ...this.getSale(saleId), duplicate: false, warnings };
    });
  }

  getSale(id) {
    const sale = this.db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (!sale) return null;
    sale.items = this.db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
    return sale;
  }

  listSales({ from, to, limit = 50 } = {}) {
    let sql = 'SELECT * FROM sales WHERE 1=1';
    const params = [];
    if (from) {
      sql += ' AND created_at >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND created_at < ?';
      params.push(to);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // Dashboard numbers. `since` is a UTC 'YYYY-MM-DD HH:MM:SS' string.
  summary(since) {
    const sales = this.db
      .prepare('SELECT COUNT(*) AS bills, COALESCE(SUM(total), 0) AS revenue FROM sales WHERE created_at >= ?')
      .get(since);
    const stock = this.db
      .prepare(
        `SELECT COUNT(*) AS products,
                COALESCE(SUM(quantity), 0) AS units,
                COALESCE(SUM(quantity * price), 0) AS stock_value,
                COALESCE(SUM(CASE WHEN quantity <= low_stock THEN 1 ELSE 0 END), 0) AS low_stock
         FROM products`
      )
      .get();
    const { udhaar_due } = this.db
      .prepare(`SELECT ${BALANCE_SQL} AS udhaar_due FROM ledger_entries l`)
      .get();
    const { refunds } = this.db
      .prepare('SELECT COALESCE(SUM(total), 0) AS refunds FROM sale_returns WHERE created_at >= ?')
      .get(since);
    const { supplier_due } = this.db
      .prepare(`SELECT ${BALANCE_SQL} AS supplier_due FROM supplier_ledger l`)
      .get();
    return { ...sales, refunds, ...stock, udhaar_due, supplier_due };
  }

  // --- customer returns -------------------------------------------------

  // Lines of a bill with how many units can still come back, and what each one refunds:
  // the price actually paid, i.e. the unit price less its share of the bill discount.
  returnableFromSale(saleId) {
    const sale = this.db.prepare('SELECT subtotal, discount FROM sales WHERE id = ?').get(saleId);
    if (!sale) return null;
    return this.db
      .prepare(
        `SELECT si.product_id, si.barcode, si.name, SUM(si.quantity) AS sold, SUM(si.line_total) AS line_total,
                MAX(si.unit_cost) AS unit_cost, MAX(si.gst_rate) AS gst_rate, MAX(si.hsn) AS hsn, MAX(si.unit) AS unit,
                COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
                          WHERE r.sale_id = si.sale_id AND ri.product_id = si.product_id), 0) AS returned
         FROM sale_items si WHERE si.sale_id = ? GROUP BY si.product_id ORDER BY MIN(si.id)`
      )
      .all(saleId)
      .map((l) => {
        const paid = sale.subtotal ? l.line_total - (sale.discount * l.line_total) / sale.subtotal : 0;
        return { ...l, returnable: l.sold - l.returned, unit_refund: Math.round(paid / l.sold) };
      });
  }

  // Takes goods back from a customer. With sale_id, lines must be on that bill, can't exceed what
  // is left to return, and refund what was paid; without it, the product's current price is refunded.
  // refund_method 'khata' takes the amount off the customer's udhaar (it may go into advance).
  // restock: false for damaged goods — recorded, but not put back into stock.
  // For a GST-registered shop every return is a credit note (Rule 53): it must name the original
  // invoice, gets its own number series, reverses the tax the way the invoice charged it, and can
  // only be issued up to 30 November after the end of that invoice's financial year (Section 34(2)).
  createSaleReturn({
    sale_id = null, items, refund_method = 'cash', restock = true, reason = null,
    customer_id = null, customer_name = null, customer_phone = null, client_id = null, created_at = null,
    note_no = null,
  }) {
    return this.transaction(() => {
      if (client_id) {
        const seen = this.db.prepare('SELECT id FROM sale_returns WHERE client_id = ?').get(client_id);
        if (seen) return { ...this.getSaleReturn(seen.id), duplicate: true };
      }
      const shop = this.getShop();
      let sale = null, billLines = null;
      if (sale_id) {
        sale = this.db.prepare('SELECT * FROM sales WHERE id = ?').get(sale_id);
        if (!sale) throw new HttpError(404, `Bill #${sale_id} not found`);
        billLines = this.returnableFromSale(sale_id);
      }
      if (shop.gst_registered) {
        if (!sale) throw new HttpError(400, 'A credit note must refer to the original invoice — load the bill first');
        const { start } = financialYear(localDate(sale.created_at, shop.tz_offset));
        const deadline = `${start + 1}-11-30`;
        if (this.localInfo(created_at).day > deadline) {
          throw new HttpError(400, `The last date for a credit note on invoice ${sale.invoice_no ?? '#' + sale.id} was 30 Nov ${start + 1}`);
        }
      }

      const merged = new Map();
      for (const item of items) merged.set(item.barcode, (merged.get(item.barcode) ?? 0) + item.quantity);

      const lines = [];
      for (const [barcode, quantity] of merged) {
        const p = this.getByBarcode(barcode);
        if (!p) throw new HttpError(404, `Product ${barcode} not found`);
        if (billLines) {
          const line = billLines.find((l) => l.product_id === p.id);
          if (!line) throw new HttpError(400, `${p.name} is not on bill #${sale_id}`);
          if (quantity > line.returnable) {
            throw new HttpError(409, `Only ${line.returnable} of ${p.name} left to return from bill #${sale_id}`);
          }
          lines.push({
            p, quantity, unit_price: line.unit_refund, unit_cost: line.unit_cost ?? p.cost, gst_rate: line.gst_rate,
            hsn: line.hsn, unit: line.unit,
          });
        } else {
          lines.push({ p, quantity, unit_price: p.price, unit_cost: p.cost, gst_rate: p.gst_rate, hsn: p.hsn, unit: p.unit });
        }
      }
      const total = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);

      let customer = null;
      if (sale?.customer_id) customer = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id);
      if (!customer && (customer_id || customer_name || customer_phone)) {
        customer = this.#resolveParty(
          PARTIES.customer, { id: customer_id, name: customer_name, phone: customer_phone }, { create: refund_method === 'khata' }
        );
      }
      if (refund_method === 'khata' && !customer) throw new HttpError(400, 'Taking a return off udhaar needs the customer');

      // Reverse tax the way the invoice charged it (IGST for an inter-state invoice).
      const interState = Boolean(sale?.inter_state);
      const taxes = lines.map((l) => taxOf(l.unit_price * l.quantity, l.gst_rate, interState));
      const sum = (k) => taxes.reduce((s, x) => s + x[k], 0);
      const number = this.#claimNumber('credit_note', note_no, created_at);

      const { lastInsertRowid: returnId } = this.db
        .prepare(
          `INSERT INTO sale_returns (sale_id, customer_id, total, refund_method, restock, reason, client_id, created_at,
                                     note_no, taxable, cgst, sgst, igst)
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?)`
        )
        .run(sale_id, customer?.id ?? null, total, refund_method, restock ? 1 : 0, reason, client_id, created_at,
          number, sum('taxable'), sum('cgst'), sum('sgst'), sum('igst'));

      const insertItem = this.db.prepare(
        `INSERT INTO sale_return_items (return_id, product_id, barcode, name, quantity, unit_price, unit_cost, gst_rate, line_total,
                                        hsn, unit, taxable, cgst, sgst, igst)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      lines.forEach(({ p, quantity, unit_price, unit_cost, gst_rate, hsn, unit }, i) => {
        const t = taxes[i];
        insertItem.run(returnId, p.id, p.barcode, p.name, quantity, unit_price, unit_cost, gst_rate, unit_price * quantity,
          hsn, unit, t.taxable, t.cgst, t.sgst, t.igst);
        if (restock) {
          this.db
            .prepare("UPDATE products SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?")
            .run(quantity, p.id);
          this.db
            .prepare(
              `INSERT INTO stock_movements (product_id, change, reason, sale_id, sale_return_id, note)
               VALUES (?, ?, 'sale_return', ?, ?, ?)`
            )
            .run(p.id, quantity, sale_id, returnId, `Customer return${reason ? ' — ' + reason : ''}`);
        }
      });
      if (refund_method === 'khata' && total > 0) {
        this.db
          .prepare(
            `INSERT INTO ledger_entries (customer_id, type, amount, sale_id, sale_return_id, note, created_at)
             VALUES (?, 'return', ?, ?, ?, ?, COALESCE(?, datetime('now')))`
          )
          .run(customer.id, total, sale_id, returnId, reason, created_at);
      }
      return { ...this.getSaleReturn(returnId), duplicate: false };
    });
  }

  getSaleReturn(id) {
    const r = this.db
      .prepare(
        `SELECT r.*, c.name AS customer_name, s.invoice_no, s.created_at AS invoice_date, s.buyer_gstin, s.buyer_address,
                s.customer_name AS buyer_name, s.place_of_supply
         FROM sale_returns r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN sales s ON s.id = r.sale_id WHERE r.id = ?`
      )
      .get(id);
    if (!r) return null;
    r.restock = Boolean(r.restock);
    r.items = this.db.prepare('SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id').all(id);
    return r;
  }

  listSaleReturns({ saleId, limit = 50 } = {}) {
    let sql = 'SELECT r.*, c.name AS customer_name FROM sale_returns r LEFT JOIN customers c ON c.id = r.customer_id';
    const params = [];
    if (saleId) {
      sql += ' WHERE r.sale_id = ?';
      params.push(saleId);
    }
    sql += ' ORDER BY r.created_at DESC, r.id DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r, restock: Boolean(r.restock) }));
  }

  // --- profit report ----------------------------------------------------

  // Gross profit for [from, to): what customers paid (after bill discounts, less refunds) minus what
  // those goods cost. Sold units are costed at the cost price when they were sold; returned units
  // that went back on the shelf give their cost back, damaged ones don't. Amounts include GST;
  // `tax` is the GST inside net sales, for shops that need profit before tax.
  // tzOffset (minutes east of UTC, e.g. 330 for India) groups days in the shop's local time.
  profitReport({ from, to, tzOffset = 0 }) {
    const shift = `${tzOffset >= 0 ? '+' : '-'}${Math.abs(tzOffset)} minutes`;
    const sold = this.db
      .prepare(
        `SELECT si.product_id, si.barcode, si.name, si.quantity, si.gst_rate, s.id AS sale_id,
                si.line_total - (CASE WHEN s.subtotal > 0 THEN s.discount * si.line_total * 1.0 / s.subtotal ELSE 0 END) AS revenue,
                si.quantity * COALESCE(si.unit_cost, p.cost) AS cost,
                COALESCE(si.unit_cost, p.cost) = 0 AS no_cost,
                date(s.created_at, ?) AS day
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
         WHERE s.created_at >= ? AND s.created_at < ?`
      )
      .all(shift, from, to);
    const back = this.db
      .prepare(
        `SELECT ri.product_id, ri.barcode, ri.name, ri.quantity, ri.gst_rate, ri.line_total AS refund,
                CASE WHEN r.restock THEN ri.quantity * ri.unit_cost ELSE 0 END AS cost_back,
                date(r.created_at, ?) AS day
         FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
         WHERE r.created_at >= ? AND r.created_at < ?`
      )
      .all(shift, from, to);

    const blank = () => ({ qty_sold: 0, qty_returned: 0, gross_sales: 0, returns: 0, cogs: 0, tax: 0 });
    const products = new Map(), days = new Map(), total = blank(), bills = new Set();
    const missingCost = new Set();
    const bucket = (map, key, init) => map.get(key) ?? map.set(key, { ...init(), ...blank() }).get(key);
    const tax = (amount, rate) => (rate > 0 ? (amount * rate) / (100 + rate) : 0);

    for (const l of sold) {
      bills.add(l.sale_id);
      if (l.no_cost) missingCost.add(l.product_id);
      for (const b of [bucket(products, l.product_id, () => ({ product_id: l.product_id, barcode: l.barcode, name: l.name })),
        bucket(days, l.day, () => ({ day: l.day })), total]) {
        b.qty_sold += l.quantity;
        b.gross_sales += l.revenue;
        b.cogs += l.cost;
        b.tax += tax(l.revenue, l.gst_rate);
      }
    }
    for (const l of back) {
      for (const b of [bucket(products, l.product_id, () => ({ product_id: l.product_id, barcode: l.barcode, name: l.name })),
        bucket(days, l.day, () => ({ day: l.day })), total]) {
        b.qty_returned += l.quantity;
        b.returns += l.refund;
        b.cogs -= l.cost_back;
        b.tax -= tax(l.refund, l.gst_rate);
      }
    }

    const finish = (b) => {
      const net_sales = Math.round(b.gross_sales - b.returns);
      const cogs = Math.round(b.cogs);
      const gross_profit = net_sales - cogs;
      return {
        ...b,
        gross_sales: Math.round(b.gross_sales),
        returns: Math.round(b.returns),
        net_sales, cogs, gross_profit,
        tax: Math.round(b.tax),
        margin_pct: net_sales > 0 ? Math.round((gross_profit / net_sales) * 1000) / 10 : null,
      };
    };
    return {
      from, to,
      summary: { ...finish(total), bills: bills.size, products_without_cost: missingCost.size },
      by_day: [...days.values()].map(finish).sort((a, b) => a.day.localeCompare(b.day)),
      by_product: [...products.values()]
        .map((p) => ({ ...finish(p), no_cost: missingCost.has(p.product_id) }))
        .sort((a, b) => b.gross_profit - a.gross_profit || a.name.localeCompare(b.name)),
    };
  }

  // --- GSTR-1 -----------------------------------------------------------

  // Outward supplies for one return period (a calendar month in the shop's time zone), in the
  // sections of GSTR-1. Invoices are B2B (buyer has a GSTIN), B2CL (unregistered, inter-state,
  // invoice value above ₹1 lakh — Rule 59(4) from August 2024) or B2CS (everything else, summed by
  // place of supply and rate). Credit notes follow the invoice they reverse: CDNR for B2B, CDNUR
  // for B2CL, and for B2CS they reduce that month's B2CS and HSN figures.
  gstr1(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month must look like 2026-10');
    const shop = this.getShop();
    const tz = shop.tz_offset;
    const [y, m] = month.split('-').map(Number);
    const utc = (yy, mm) => new Date(Date.UTC(yy, mm - 1, 1) - tz * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const from = utc(y, m), to = utc(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
    const day = (ts) => localDate(ts, tz);
    const pos = (code) => stateLabel(code ?? shop.state_code);
    const B2CL_LIMIT = 1_00_000_00;

    const invoices = this.db.prepare('SELECT * FROM sales WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id').all(from, to);
    const itemsOf = this.db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id');
    const notes = this.db
      .prepare(
        `SELECT r.*, s.invoice_no, s.created_at AS invoice_at, s.buyer_gstin, s.customer_name AS buyer_name,
                s.inter_state, s.place_of_supply, s.total AS invoice_value
         FROM sale_returns r JOIN sales s ON s.id = r.sale_id
         WHERE r.created_at >= ? AND r.created_at < ? ORDER BY r.created_at, r.id`
      )
      .all(from, to);
    const noteItemsOf = this.db.prepare('SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id');
    const kind = (inv) => (inv.buyer_gstin ? 'b2b' : inv.inter_state && inv.total > B2CL_LIMIT ? 'b2cl' : 'b2cs');

    const byRate = (items) => {
      const rates = new Map();
      for (const i of items) {
        const r = rates.get(i.gst_rate) ?? rates.set(i.gst_rate, { rate: i.gst_rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 }).get(i.gst_rate);
        for (const k of ['taxable', 'igst', 'cgst', 'sgst']) r[k] += i[k];
      }
      return [...rates.values()];
    };
    const sections = { b2b: [], b2cl: [], b2cs: new Map(), cdnr: [], cdnur: [], hsn_b2b: new Map(), hsn_b2c: new Map() };
    const totals = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    const warnings = new Set();
    const add = (target, row, sign) => { for (const k of ['taxable', 'igst', 'cgst', 'sgst']) target[k] += sign * row[k]; };

    const addB2cs = (code, rows, sign) => {
      for (const r of rows) {
        const key = `${code}|${r.rate}`;
        const t = sections.b2cs.get(key) ?? sections.b2cs.set(key, { type: 'OE', place_of_supply: pos(code), rate: r.rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 }).get(key);
        add(t, r, sign);
      }
    };
    const addHsn = (b2b, items, sign) => {
      const map = b2b ? sections.hsn_b2b : sections.hsn_b2c;
      for (const i of items) {
        if (!i.hsn) warnings.add(`${i.name} has no HSN code`);
        const unitCode = i.unit ?? 'NOS';
        const key = `${i.hsn ?? ''}|${i.gst_rate}|${unitCode}`;
        const h = map.get(key) ?? map.set(key, {
          hsn: i.hsn ?? '', description: i.name, uqc: `${unitCode}-${UQC[unitCode] ?? 'OTHERS'}`, quantity: 0, value: 0,
          rate: i.gst_rate, taxable: 0, igst: 0, cgst: 0, sgst: 0,
        }).get(key);
        h.quantity += sign * i.quantity;
        h.value += sign * (i.taxable + i.igst + i.cgst + i.sgst);
        add(h, i, sign);
      }
    };

    for (const inv of invoices) {
      const items = itemsOf.all(inv.id);
      const rates = byRate(items);
      const k = kind(inv);
      if (!inv.invoice_no) warnings.add('Some bills were made before invoice numbering was turned on and show as #id');
      const number = inv.invoice_no ?? `#${inv.id}`;
      if (k === 'b2b') {
        for (const r of rates) sections.b2b.push({
          gstin: inv.buyer_gstin, receiver_name: inv.customer_name ?? '', invoice_no: number, invoice_date: day(inv.created_at),
          invoice_value: inv.total, place_of_supply: pos(inv.place_of_supply), reverse_charge: 'N', invoice_type: 'Regular B2B', ...r,
        });
      } else if (k === 'b2cl') {
        for (const r of rates) sections.b2cl.push({
          invoice_no: number, invoice_date: day(inv.created_at), invoice_value: inv.total, place_of_supply: pos(inv.place_of_supply), ...r,
        });
      } else {
        addB2cs(inv.place_of_supply, rates, 1);
      }
      addHsn(k === 'b2b', items, 1);
      for (const r of rates) add(totals, r, 1);
    }

    for (const n of notes) {
      const items = noteItemsOf.all(n.id);
      const rates = byRate(items);
      const k = kind({ buyer_gstin: n.buyer_gstin, inter_state: n.inter_state, total: n.invoice_value });
      const common = { note_no: n.note_no ?? `#${n.id}`, note_date: day(n.created_at), note_type: 'C', place_of_supply: pos(n.place_of_supply), note_value: n.total };
      if (k === 'b2b') {
        for (const r of rates) sections.cdnr.push({
          gstin: n.buyer_gstin, receiver_name: n.buyer_name ?? '', ...common, reverse_charge: 'N', supply_type: 'Regular B2B', ...r,
          invoice_no: n.invoice_no, invoice_date: day(n.invoice_at),
        });
      } else if (k === 'b2cl') {
        for (const r of rates) sections.cdnur.push({ ur_type: 'B2CL', ...common, ...r, invoice_no: n.invoice_no, invoice_date: day(n.invoice_at) });
      } else {
        addB2cs(n.place_of_supply, rates, -1);
      }
      addHsn(k === 'b2b', items, -1);
      for (const r of rates) add(totals, r, -1);
    }

    // Table 13: per series, first and last number, how many, and how many were not issued.
    const docs = [];
    const docRanges = (nature, rows, voidDoc) => {
      const series = new Map();
      for (const { number } of rows) {
        const p = parseDocNumber(number);
        if (!p) continue;
        const key = `${p.series}/${p.fy}`;
        const r = series.get(key) ?? series.set(key, { min: p, max: p, issued: 0, voided: 0 }).get(key);
        if (p.seq < r.min.seq) r.min = p;
        if (p.seq > r.max.seq) r.max = p;
        r.issued++;
      }
      for (const v of this.db.prepare('SELECT number FROM voided_documents WHERE doc = ? AND created_at >= ? AND created_at < ?').all(voidDoc, from, to)) {
        const p = parseDocNumber(v.number);
        const key = `${p.series}/${p.fy}`;
        const r = series.get(key) ?? series.set(key, { min: p, max: p, issued: 0, voided: 0 }).get(key);
        if (p.seq < r.min.seq) r.min = p;
        if (p.seq > r.max.seq) r.max = p;
      }
      const fmt = voidDoc === 'invoice' ? (p) => `${p.series}/${p.fy}/${String(p.seq).padStart(5, '0')}` : (p) => `CN${p.series}/${p.fy}/${String(p.seq).padStart(4, '0')}`;
      for (const r of [...series.values()].sort((a, b) => fmt(a.min).localeCompare(fmt(b.min)))) {
        const count = r.max.seq - r.min.seq + 1;
        docs.push({ nature, from: fmt(r.min), to: fmt(r.max), total: count, cancelled: count - r.issued });
      }
    };
    docRanges('Invoices for outward supply', invoices.map((i) => ({ number: i.invoice_no })), 'invoice');
    docRanges('Credit Note', notes.map((n) => ({ number: n.note_no })), 'credit_note');

    const nonZero = (r) => r.taxable || r.igst || r.cgst || r.sgst || r.quantity;
    return {
      month, from, to,
      shop: { gstin: shop.gstin, legal_name: shop.legal_name, state: pos(shop.state_code) },
      registered: shop.gst_registered,
      summary: {
        invoices: invoices.length, credit_notes: notes.length, ...totals,
        tax: totals.igst + totals.cgst + totals.sgst,
        b2b_invoices: new Set(sections.b2b.map((r) => r.invoice_no)).size,
        b2cl_invoices: new Set(sections.b2cl.map((r) => r.invoice_no)).size,
      },
      b2b: sections.b2b,
      b2cl: sections.b2cl,
      b2cs: [...sections.b2cs.values()].filter(nonZero).sort((a, b) => a.place_of_supply.localeCompare(b.place_of_supply) || a.rate - b.rate),
      cdnr: sections.cdnr,
      cdnur: sections.cdnur,
      hsn_b2b: [...sections.hsn_b2b.values()].filter(nonZero).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate),
      hsn_b2c: [...sections.hsn_b2c.values()].filter(nonZero).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate),
      docs,
      warnings: [...warnings],
    };
  }

  #move(productId, change, reason, saleId, note, clientId = null) {
    this.db
      .prepare(
        'INSERT INTO stock_movements (product_id, change, reason, sale_id, note, client_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(productId, change, reason, saleId, note, clientId);
  }
}

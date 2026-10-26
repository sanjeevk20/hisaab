// Data layer. All money is stored as integer paise to avoid floating-point drift.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  gst_rate    REAL NOT NULL,
  line_total  INTEGER NOT NULL
);

-- Ledger of every stock change, so the current quantity is always explainable.
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  change      INTEGER NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('stock_in', 'sale', 'adjustment')),
  sale_id     INTEGER REFERENCES sales(id),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Udhaar (credit) khata. amount is always positive; the type says which way it moves the balance.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  type         TEXT NOT NULL CHECK (type IN ('opening', 'credit_sale', 'payment')),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  sale_id      INTEGER REFERENCES sales(id),
  method       TEXT,
  note         TEXT,
  client_id    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger_entries(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_client ON ledger_entries(client_id) WHERE client_id IS NOT NULL;
`;

// Columns added after the first release; applied to existing databases on open.
const MIGRATIONS = [
  ['sales', 'customer_id', 'INTEGER REFERENCES customers(id)'],
  // client_id lets an offline device retry the same action without it being recorded twice.
  ['sales', 'client_id', 'TEXT'],
  ['stock_movements', 'client_id', 'TEXT'],
];
const POST_MIGRATION = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client ON sales(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_client ON stock_movements(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
`;

const BALANCE_SQL = `COALESCE(SUM(CASE WHEN l.type = 'payment' THEN -l.amount ELSE l.amount END), 0)`;

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
  for (const [table, column, type] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec(POST_MIGRATION);
  return new Store(db);
}

export function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  // Indian mobile numbers are stored without the country code so +91 98… and 98… match.
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits || null;
}

// Tax already contained in a GST-inclusive amount.
function inclusiveTax(amount, rate) {
  return rate > 0 ? Math.round((amount * rate) / (100 + rate)) : 0;
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

  createProduct({ barcode, name, price, cost = 0, gst_rate = 0, quantity = 0, low_stock = 5 }, clientId = null) {
    if (this.getByBarcode(barcode)) throw new HttpError(409, `Barcode ${barcode} already exists`);
    return this.transaction(() => {
      const { lastInsertRowid: id } = this.db
        .prepare(
          `INSERT INTO products (barcode, name, price, cost, gst_rate, quantity, low_stock)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(barcode, name, price, cost, gst_rate, quantity, low_stock);
      if (quantity > 0) this.#move(id, quantity, 'stock_in', null, 'Initial stock', clientId);
      return this.getProduct(id);
    });
  }

  updateProduct(id, fields) {
    const product = this.getProduct(id);
    if (!product) throw new HttpError(404, 'Product not found');
    const allowed = ['name', 'price', 'cost', 'gst_rate', 'low_stock', 'barcode'];
    const sets = Object.keys(fields).filter((k) => allowed.includes(k));
    if (sets.length) {
      this.db
        .prepare(
          `UPDATE products SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
        )
        .run(...sets.map((k) => fields[k]), id);
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

  // --- customers & udhaar -----------------------------------------------

  listCustomers({ q, dueOnly } = {}) {
    let sql = `SELECT c.*, ${BALANCE_SQL} AS balance, MAX(l.created_at) AS last_activity
               FROM customers c LEFT JOIN ledger_entries l ON l.customer_id = c.id WHERE 1=1`;
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

  getCustomer(id) {
    const c = this.db
      .prepare(
        `SELECT c.*, ${BALANCE_SQL} AS balance FROM customers c
         LEFT JOIN ledger_entries l ON l.customer_id = c.id WHERE c.id = ? GROUP BY c.id`
      )
      .get(id);
    if (!c) return null;
    c.entries = this.db
      .prepare('SELECT * FROM ledger_entries WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
      .all(id);
    return c;
  }

  getCustomerByPhone(phone) {
    const p = normalizePhone(phone);
    return p ? this.db.prepare('SELECT * FROM customers WHERE phone = ?').get(p) : undefined;
  }

  createCustomer({ name, phone = null, opening_balance = 0, note = null }) {
    phone = normalizePhone(phone);
    if (phone && this.getCustomerByPhone(phone)) throw new HttpError(409, 'A customer with this phone already exists');
    return this.transaction(() => {
      const { lastInsertRowid: id } = this.db
        .prepare('INSERT INTO customers (name, phone) VALUES (?, ?)')
        .run(name, phone);
      if (opening_balance > 0) {
        this.db
          .prepare("INSERT INTO ledger_entries (customer_id, type, amount, note) VALUES (?, 'opening', ?, ?)")
          .run(id, opening_balance, note ?? 'Opening balance');
      }
      return this.getCustomer(id);
    });
  }

  // Find by id or phone; create when a name is given and no match exists.
  #resolveCustomer({ customer_id, customer_name, customer_phone }, { create }) {
    if (customer_id) {
      const c = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
      if (!c) throw new HttpError(404, 'Customer not found');
      return c;
    }
    const existing = this.getCustomerByPhone(customer_phone);
    if (existing) return existing;
    // Regulars are often known by name alone; match on name when no phone is given.
    if (!normalizePhone(customer_phone) && customer_name) {
      const byName = this.db.prepare('SELECT * FROM customers WHERE name = ? COLLATE NOCASE').all(customer_name);
      if (byName.length === 1) return byName[0];
      if (byName.length > 1) throw new HttpError(409, `More than one customer is called ${customer_name} — add their phone number`);
    }
    if (!create) return null;
    if (!customer_name) throw new HttpError(400, 'Udhaar needs a customer name');
    const { lastInsertRowid: id } = this.db
      .prepare('INSERT INTO customers (name, phone) VALUES (?, ?)')
      .run(customer_name, normalizePhone(customer_phone));
    return this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  }

  recordPayment(customerId, { amount, method = 'cash', note = null, client_id = null, created_at = null }) {
    return this.transaction(() => {
      if (client_id) {
        const seen = this.db.prepare('SELECT customer_id FROM ledger_entries WHERE client_id = ?').get(client_id);
        if (seen) return { duplicate: true, customer: this.getCustomer(seen.customer_id) };
      }
      const customer = this.getCustomer(customerId);
      if (!customer) throw new HttpError(404, 'Customer not found');
      if (amount > customer.balance) {
        throw new HttpError(409, `${customer.name} owes only ₹${(customer.balance / 100).toFixed(2)}`);
      }
      this.db
        .prepare(
          `INSERT INTO ledger_entries (customer_id, type, amount, method, note, client_id, created_at)
           VALUES (?, 'payment', ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        )
        .run(customerId, amount, method, note, client_id, created_at);
      return { duplicate: false, customer: this.getCustomer(customerId) };
    });
  }

  // --- sales ------------------------------------------------------------

  // Records a sale and removes the sold quantities from stock in one atomic step.
  // Items name a product by product_id or barcode. If any line is short on stock, nothing is
  // written — unless allowOversell is set (a sale already made while offline), in which case
  // stock bottoms out at zero and the shortfall is logged as an adjustment to recount.
  createSale({
    items, discount = 0, payment_method = 'cash', customer_id = null, customer_name = null,
    customer_phone = null, client_id = null, created_at = null, allowOversell = false,
  }) {
    return this.transaction(() => {
      if (client_id) {
        const seen = this.db.prepare('SELECT id FROM sales WHERE client_id = ?').get(client_id);
        if (seen) return { ...this.getSale(seen.id), duplicate: true };
      }

      // Merge duplicate lines for the same product so the stock check sees the full demand.
      const wanted = new Map();
      for (const item of items) {
        const p = item.product_id ? this.getProduct(item.product_id) : this.getByBarcode(item.barcode);
        if (!p) throw new HttpError(404, `Product ${item.product_id ?? item.barcode} not found`);
        const line = wanted.get(p.id) ?? { p, quantity: 0 };
        line.quantity += item.quantity;
        wanted.set(p.id, line);
      }

      const lines = [];
      for (const { p, quantity } of wanted.values()) {
        if (p.quantity < quantity && !allowOversell) {
          throw new HttpError(409, `Only ${p.quantity} of ${p.name} in stock`);
        }
        lines.push({ p, quantity, line_total: p.price * quantity });
      }

      const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
      if (discount > subtotal) throw new HttpError(400, 'Discount cannot exceed the bill amount');
      const total = subtotal - discount;
      // Spread the discount proportionally before extracting tax from each line.
      const tax = lines.reduce((s, l) => {
        const share = subtotal ? l.line_total - Math.round((discount * l.line_total) / subtotal) : 0;
        return s + inclusiveTax(share, l.p.gst_rate);
      }, 0);

      const credit = payment_method === 'credit';
      const customer = this.#resolveCustomer({ customer_id, customer_name, customer_phone }, { create: credit });
      if (credit && !customer) throw new HttpError(400, 'Udhaar needs a customer name');

      const { lastInsertRowid: saleId } = this.db
        .prepare(
          `INSERT INTO sales (subtotal, discount, total, tax, payment_method, customer_id, customer_name,
                              customer_phone, client_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        )
        .run(
          subtotal, discount, total, tax, payment_method, customer?.id ?? null,
          customer?.name ?? customer_name, customer?.phone ?? normalizePhone(customer_phone), client_id, created_at
        );

      const insertItem = this.db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, barcode, name, quantity, unit_price, gst_rate, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const decrement = this.db.prepare(
        "UPDATE products SET quantity = MAX(quantity - ?, 0), updated_at = datetime('now') WHERE id = ?"
      );
      const warnings = [];
      for (const { p, quantity, line_total } of lines) {
        insertItem.run(saleId, p.id, p.barcode, p.name, quantity, p.price, p.gst_rate, line_total);
        decrement.run(quantity, p.id);
        this.#move(p.id, -quantity, 'sale', saleId, null);
        const shortfall = quantity - p.quantity;
        if (shortfall > 0) {
          this.#move(p.id, shortfall, 'adjustment', saleId, `Sold ${shortfall} more than recorded stock while offline — please recount`);
          warnings.push(`${p.name}: sold ${shortfall} more than in stock — please recount`);
        }
      }

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
    return { ...sales, ...stock, udhaar_due };
  }

  #move(productId, change, reason, saleId, note, clientId = null) {
    this.db
      .prepare(
        'INSERT INTO stock_movements (product_id, change, reason, sale_id, note, client_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(productId, change, reason, saleId, note, clientId);
  }
}

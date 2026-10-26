import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

let server, base, gupta, hul, bill1;
const ALL = 'from=2000-01-01&to=2100-01-01';

before(async () => {
  server = createServer(createHandler(openDb(':memory:')));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  bill1 = (await call('/purchases', 'POST', {
    supplier_name: 'Gupta Traders', supplier_phone: '9811111111', invoice_no: 'GT-1',
    items: [
      { barcode: 'SALT', quantity: 20, unit_cost: 2300, name: 'Tata Salt 1kg', price: 2800 },
      { barcode: 'OIL', quantity: 10, unit_cost: 14000, name: 'Fortune Oil 1L', price: 16500 },
    ],
    created_at: '2026-09-10T06:00:00Z',
  })).body;
  gupta = bill1.supplier_id;
  hul = (await call('/purchases', 'POST', {
    supplier_name: 'HUL Distributor', items: [{ barcode: 'SOAP', quantity: 50, unit_cost: 3000, name: 'Lux Soap', price: 3800 }],
    paid: 150000, payment_method: 'bank', created_at: '2026-10-05T06:00:00Z',
  })).body.supplier_id;
});
after(() => server.close());

async function call(path, method = 'GET', body) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type').includes('json') ? JSON.parse(text) : text };
}

test('return against a bill: stock down, dues down, cost taken from the bill', async () => {
  // Product cost changes after the bill; the return should still value at the bill's cost.
  await call('/purchases', 'POST', { supplier_id: gupta, items: [{ barcode: 'OIL', quantity: 1, unit_cost: 15000 }], created_at: '2026-10-01T06:00:00Z' });
  const r = await call('/purchase-returns', 'POST', {
    supplier_id: gupta, purchase_id: bill1.id, reason: 'Leaking', items: [{ barcode: 'OIL', quantity: 2 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 28000);
  assert.equal(r.body.settlement, 'adjust');
  assert.equal((await call('/products/barcode/OIL')).body.quantity, 9);
  const s = (await call(`/suppliers/${gupta}`)).body;
  assert.equal(s.balance, 46000 + 140000 + 15000 - 28000);
  const moves = (await call(`/products/${r.body.items[0].product_id}/movements`)).body;
  assert.equal(moves[0].reason, 'purchase_return');
  assert.match(moves[0].note, /Returned to Gupta Traders — Leaking/);
});

test('cannot return more than was on the bill, or items not on it', async () => {
  const over = await call('/purchase-returns', 'POST', { supplier_id: gupta, purchase_id: bill1.id, items: [{ barcode: 'OIL', quantity: 9 }] });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /Only 8 of Fortune Oil 1L left to return/);
  const notOnBill = await call('/purchase-returns', 'POST', { supplier_id: gupta, purchase_id: bill1.id, items: [{ barcode: 'SOAP', quantity: 1 }] });
  assert.equal(notOnBill.status, 400);
  const wrongSupplier = await call('/purchase-returns', 'POST', { supplier_id: hul, purchase_id: bill1.id, items: [{ barcode: 'SALT', quantity: 1 }] });
  assert.equal(wrongSupplier.status, 400);
  const p = (await call(`/purchases/${bill1.id}`)).body;
  assert.deepEqual(p.returnable.map((l) => [l.barcode, l.returnable]).sort(), [['OIL', 8], ['SALT', 20]]);
});

test('cannot return more than is in stock', async () => {
  const r = await call('/purchase-returns', 'POST', { supplier_id: hul, items: [{ barcode: 'SOAP', quantity: 51 }] });
  assert.equal(r.status, 409);
  assert.equal((await call('/products/barcode/SOAP')).body.quantity, 50);
});

test('cash refund leaves the balance unchanged; return beyond dues means supplier owes you', async () => {
  const before = (await call(`/suppliers/${hul}`)).body.balance;
  assert.equal(before, 0);
  const refund = await call('/purchase-returns', 'POST', {
    supplier_id: hul, settlement: 'refund', refund_method: 'cash', items: [{ barcode: 'SOAP', quantity: 5 }],
  });
  assert.equal(refund.status, 201);
  assert.equal(refund.body.total, 15000, 'defaults to product cost without a bill');
  assert.equal((await call(`/suppliers/${hul}`)).body.balance, 0);

  await call('/purchase-returns', 'POST', { supplier_id: hul, items: [{ barcode: 'SOAP', quantity: 2, unit_cost: 2500 }] });
  const s = (await call(`/suppliers/${hul}`)).body;
  assert.equal(s.balance, -5000, 'credit with the supplier');
  assert.equal((await call(`/suppliers/${hul}/payments`, 'POST', { amount: 100 })).status, 409);
  assert.equal(s.returns.length, 2);
});

test('return retries are idempotent', async () => {
  const body = { supplier_id: gupta, items: [{ barcode: 'SALT', quantity: 1 }], client_id: 'dev1-ret-1' };
  const a = await call('/purchase-returns', 'POST', body);
  const b = await call('/purchase-returns', 'POST', body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal((await call('/products/barcode/SALT')).body.quantity, 19);
});

test('supplier report: per-supplier totals for a period', async () => {
  const all = (await call('/reports/suppliers?' + ALL)).body;
  const g = all.rows.find((r) => r.id === gupta);
  assert.equal(g.bills, 2);
  assert.equal(g.purchased, 186000 + 15000);
  assert.equal(g.returned, 28000 + 2300);
  assert.equal(g.net_purchased, 201000 - 30300);
  assert.equal(g.balance, 201000 - 30300);
  const h = all.rows.find((r) => r.id === hul);
  assert.equal(h.paid, 150000);
  assert.equal(h.refunded, 15000);
  assert.equal(all.totals.bills, 3);
  assert.equal(all.rows[0].id, gupta, 'biggest supplier first');

  // September only: just Gupta's first bill.
  const sept = (await call('/reports/suppliers?from=2026-09-01&to=2026-10-01')).body;
  assert.equal(sept.rows.find((r) => r.id === gupta).purchased, 186000);
  const hulSept = sept.rows.find((r) => r.id === hul);
  assert.equal(hulSept.bills, 0, 'no September activity…');
  assert.equal(hulSept.balance, -5000, '…but still listed because a balance is open');
});

test('supplier items report: what was bought, net of returns', async () => {
  const r = (await call(`/reports/suppliers/${gupta}?${ALL}`)).body;
  const oil = r.items.find((i) => i.barcode === 'OIL');
  assert.equal(oil.bought_qty, 11);
  assert.equal(oil.avg_cost, Math.round(155000 / 11));
  assert.equal(oil.returned_qty, 2);
  assert.equal(r.purchases.length, 2);
  assert.equal(r.returns.length, 2);
  assert.equal(r.supplier.name, 'Gupta Traders');
});

test('CSV export is spreadsheet-safe', async () => {
  await call('/suppliers', 'POST', { name: '=HYPERLINK("x")', opening_balance: 100 });
  const r = await call('/reports/suppliers?format=csv&' + ALL);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /suppliers_2000-01-01_2099-12-31\.csv/);
  const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Supplier,Phone,GSTIN,Bills,Purchased,Returned,Net purchased,Paid,Refunded,Balance due,Last purchase');
  assert.ok(lines.some((l) => l.startsWith('Gupta Traders,9811111111,,2,2010.00,303.00,1707.00,')));
  assert.ok(lines.some((l) => l.startsWith(`"'=HYPERLINK(""x"")"`)), 'formula neutralised');
  assert.match(lines.at(-1), /^Total,/);
  const items = await call(`/reports/suppliers/${gupta}?format=csv&${ALL}`);
  assert.match(items.headers.get('content-disposition'), /gupta-traders_/);
});

test('report period validation', async () => {
  assert.equal((await call('/reports/suppliers?from=yesterday')).status, 400);
  assert.equal((await call('/reports/suppliers?from=2026-10-02&to=2026-10-01')).status, 400);
  assert.equal((await call('/reports/suppliers')).status, 200, 'defaults to this month');
});

test('databases from earlier versions are upgraded without losing history', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hisaab-')), 'old.db');
  const old = new DatabaseSync(file);
  // The v0.3 shapes of the two tables whose rules changed.
  old.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, barcode TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      price INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 0, low_stock INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
      change INTEGER NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('stock_in', 'sale', 'adjustment')),
      sale_id INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, gstin TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE supplier_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      type TEXT NOT NULL CHECK (type IN ('opening', 'purchase', 'payment')), amount INTEGER NOT NULL CHECK (amount > 0),
      purchase_id INTEGER, method TEXT, note TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO products (barcode, name, price, cost, quantity) VALUES ('SALT', 'Salt', 2800, 2300, 10);
    INSERT INTO stock_movements (product_id, change, reason, note) VALUES (1, 10, 'stock_in', 'Initial stock');
    INSERT INTO suppliers (name) VALUES ('Old Supplier');
    INSERT INTO supplier_ledger (supplier_id, type, amount) VALUES (1, 'opening', 50000);
  `);
  old.close();

  const store = openDb(file);
  assert.equal(store.movements(1).length, 1);
  const r = store.createReturn({ supplier_id: 1, items: [{ barcode: 'SALT', quantity: 2 }] });
  assert.equal(r.total, 4600);
  assert.equal(store.getSupplier(1).balance, 50000 - 4600);
  assert.equal(store.movements(1)[0].reason, 'purchase_return');
  openDb(file); // reopening is a no-op
});

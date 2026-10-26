import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

let server, base, sale1, sale2, ids;
const OCT = 'from=2026-10-01&to=2026-11-01';

before(async () => {
  server = createServer(createHandler(openDb(':memory:')));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  await call('/stock-in', 'POST', { barcode: 'TEA', quantity: 10, name: 'Tea 500g', price: 10000, cost: 8000, gst_rate: 5 });
  await call('/stock-in', 'POST', { barcode: 'BISC', quantity: 50, name: 'Biscuits', price: 1000, cost: 700, gst_rate: 18 });
  await call('/stock-in', 'POST', { barcode: 'NOCOST', quantity: 10, name: 'No-cost item', price: 500 });
  // Bill 1: ₹250 subtotal, ₹25 (10%) discount, on Ramesh's udhaar.
  sale1 = (await call('/sales', 'POST', {
    items: [{ barcode: 'TEA', quantity: 2 }, { barcode: 'BISC', quantity: 5 }], discount: 2500,
    payment_method: 'credit', customer_name: 'Ramesh', customer_phone: '9876543210', created_at: '2026-10-10T05:00:00Z',
  })).body;
  // Bill 2: late evening UTC = next morning in India.
  sale2 = (await call('/sales', 'POST', {
    items: [{ barcode: 'BISC', quantity: 10 }, { barcode: 'NOCOST', quantity: 2 }], created_at: '2026-10-11T20:00:00Z',
  })).body;
  ids = Object.fromEntries((await call('/products')).body.map((p) => [p.barcode, p.id]));
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

test('a bill lists what can be returned and at what refund', async () => {
  const { body } = await call(`/sales/${sale1.id}`);
  const tea = body.returnable.find((l) => l.barcode === 'TEA');
  assert.equal(tea.returnable, 2);
  assert.equal(tea.unit_refund, 9000, 'price paid after the 10% bill discount');
  assert.equal(tea.unit_cost, 8000);
  assert.deepEqual(body.returns, []);
});

test('return against a bill: refund what was paid, restock, take it off udhaar', async () => {
  const r = await call('/sale-returns', 'POST', {
    sale_id: sale1.id, items: [{ barcode: 'TEA', quantity: 1 }], refund_method: 'khata', reason: 'Wrong flavour',
    created_at: '2026-10-15T05:00:00Z',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 9000);
  assert.equal(r.body.customer_name, 'Ramesh', 'customer taken from the bill');
  assert.equal(r.body.restock, true);
  assert.equal((await call('/products/barcode/TEA')).body.quantity, 9);

  const { body: [c] } = await call('/customers');
  assert.equal(c.balance, 22500 - 9000);
  const entry = (await call(`/customers/${c.id}`)).body.entries[0];
  assert.deepEqual([entry.type, entry.amount, entry.sale_id], ['return', 9000, sale1.id]);
  const moves = (await call(`/products/${ids.TEA}/movements`)).body;
  assert.deepEqual([moves[0].reason, moves[0].change], ['sale_return', 1]);
});

test('cannot return more than was bought, or items not on the bill', async () => {
  const over = await call('/sale-returns', 'POST', { sale_id: sale1.id, items: [{ barcode: 'TEA', quantity: 2 }] });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /Only 1 of Tea 500g left to return/);
  const notOnBill = await call('/sale-returns', 'POST', { sale_id: sale1.id, items: [{ barcode: 'NOCOST', quantity: 1 }] });
  assert.equal(notOnBill.status, 400);
  assert.equal((await call('/sale-returns', 'POST', { sale_id: 9999, items: [{ barcode: 'TEA', quantity: 1 }] })).status, 404);
});

test('return without a bill at current price; damaged goods are not restocked', async () => {
  const r = await call('/sale-returns', 'POST', {
    items: [{ barcode: 'BISC', quantity: 2 }], restock: false, refund_method: 'cash', reason: 'Crushed',
    created_at: '2026-10-15T06:00:00Z',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 2000);
  assert.equal(r.body.restock, false);
  assert.equal((await call('/products/barcode/BISC')).body.quantity, 35, 'stock unchanged');
});

test('khata refund without a bill needs a customer', async () => {
  const r = await call('/sale-returns', 'POST', { items: [{ barcode: 'BISC', quantity: 1 }], refund_method: 'khata' });
  assert.equal(r.status, 400);
  assert.equal((await call('/sale-returns', 'POST', { items: [{ barcode: 'BISC', quantity: 1 }], refund_method: 'gold' })).status, 400);
});

test('return retries are idempotent', async () => {
  const body = { sale_id: sale2.id, items: [{ barcode: 'BISC', quantity: 1 }], client_id: 'dev1-sret-1', created_at: '2026-10-16T05:00:00Z' };
  const a = await call('/sale-returns', 'POST', body);
  const b = await call('/sale-returns', 'POST', body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id);
  assert.equal((await call('/products/barcode/BISC')).body.quantity, 36);
});

test('profit report: net sales minus cost of goods, returns handled', async () => {
  // A later cost change must not rewrite the profit of sales already made.
  await call(`/products/${ids.TEA}`, 'PATCH', { cost: 9500 });
  const { body } = await call('/reports/profit?' + OCT);
  const t = body.summary;
  // Sold: TEA 2 (₹180 after discount), BISC 5 (₹45) + 10 (₹100), NOCOST 2 (₹10) = ₹335
  assert.equal(t.gross_sales, 33500);
  assert.equal(t.bills, 2);
  // Returns: TEA ₹90 (restocked), BISC ₹20 (damaged), BISC ₹10 (restocked)
  assert.equal(t.returns, 12000);
  assert.equal(t.net_sales, 21500);
  // Cost: TEA 2×80 + BISC 15×7 + NOCOST 0 = ₹265, minus restocked TEA ₹80 and BISC ₹7
  assert.equal(t.cogs, 26500 - 8000 - 700);
  assert.equal(t.gross_profit, 21500 - 17800);
  assert.equal(t.margin_pct, Math.round((3700 / 21500) * 1000) / 10);
  assert.equal(t.products_without_cost, 1);

  const by = Object.fromEntries(body.by_product.map((p) => [p.barcode, p]));
  assert.equal(by.TEA.gross_profit, (18000 - 9000) - (16000 - 8000));
  assert.equal(by.BISC.gross_profit, (14500 - 3000) - (10500 - 700));
  assert.equal(by.NOCOST.no_cost, true);
  assert.equal(body.by_product[0].barcode, 'BISC', 'most profitable first');
  // GST inside net sales: TEA 5%, BISC 18%, NOCOST 0%
  assert.equal(t.tax, Math.round(9000 * 5 / 105 + 11500 * 18 / 118));
});

test('profit by day follows the shop timezone', async () => {
  const utc = (await call('/reports/profit?' + OCT)).body.by_day.map((d) => d.day);
  const ist = (await call('/reports/profit?tz=330&' + OCT)).body.by_day.map((d) => d.day);
  assert.ok(utc.includes('2026-10-11'));
  assert.ok(!ist.includes('2026-10-11') && ist.includes('2026-10-12'), 'the 20:00 UTC bill is the next morning in India');
  assert.equal((await call('/reports/profit?tz=abc')).status, 400);
});

test('profit CSV by product and by day', async () => {
  const p = await call('/reports/profit?format=csv&' + OCT);
  assert.match(p.headers.get('content-disposition'), /profit-by-product_2026-10-01_2026-10-31\.csv/);
  const lines = p.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.match(lines[0], /^Product,Barcode,Units sold/);
  assert.ok(lines.some((l) => l.startsWith('No-cost item,NOCOST,2,0,10.00,0.00,10.00,0.00,10.00,100.0,0.00,yes')));
  assert.match(lines.at(-1), /^Total,,19,4,335\.00,120\.00,215\.00,178\.00,37\.00,/);
  const d = await call('/reports/profit?format=csv&by=day&' + OCT);
  assert.match(d.body, /^Date,Units sold/);
  assert.match(d.body, /2026-10-15,0,0\.00,110\.00,-110\.00,-80\.00,-30\.00,,/, 'no margin on a returns-only day');
});

test("today's summary shows refunds", async () => {
  const s = (await call('/summary?since=2026-10-01 00:00:00')).body;
  assert.equal(s.refunds, 12000);
});

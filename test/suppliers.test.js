import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

let server, base;

before(async () => {
  server = createServer(createHandler(openDb(':memory:')));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  await call('/stock-in', 'POST', { barcode: 'SALT', quantity: 2, name: 'Tata Salt 1kg', price: 2800, cost: 2200 });
});
after(() => server.close());

async function call(path, method = 'GET', body) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('purchase adds stock, updates cost, creates new products and the supplier', async () => {
  const r = await call('/purchases', 'POST', {
    supplier_name: 'Gupta Traders',
    supplier_phone: '9811111111',
    invoice_no: 'GT-1042',
    items: [
      { barcode: 'SALT', quantity: 20, unit_cost: 2300 },
      { barcode: 'OIL', quantity: 5, unit_cost: 14000, name: 'Fortune Oil 1L', price: 16500, gst_rate: 5 },
    ],
    paid: 30000,
    payment_method: 'upi',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 20 * 2300 + 5 * 14000);
  assert.equal(r.body.supplier_name, 'Gupta Traders');
  assert.equal(r.body.items.length, 2);

  const salt = (await call('/products/barcode/SALT')).body;
  assert.equal(salt.quantity, 22);
  assert.equal(salt.cost, 2300, 'cost price follows the latest purchase');
  const oil = (await call('/products/barcode/OIL')).body;
  assert.equal(oil.quantity, 5);
  assert.equal(oil.price, 16500);

  const moves = (await call(`/products/${salt.id}/movements`)).body;
  assert.equal(moves[0].purchase_id, r.body.id);
});

test('unpaid part of the bill becomes a supplier due', async () => {
  const { body: [s] } = await call('/suppliers');
  assert.equal(s.name, 'Gupta Traders');
  assert.equal(s.balance, 116000 - 30000);
  const { body: detail } = await call(`/suppliers/${s.id}`);
  assert.deepEqual(detail.entries.map((e) => [e.type, e.amount]).sort(), [['payment', 30000], ['purchase', 116000]]);
  assert.equal(detail.purchases.length, 1);
});

test('next purchase from the same supplier matches by phone, and paying them reduces the due', async () => {
  const r = await call('/purchases', 'POST', {
    supplier_phone: '+91 98111 11111', supplier_name: 'Gupta',
    items: [{ barcode: 'SALT', quantity: 10, unit_cost: 2300 }],
  });
  assert.equal(r.status, 201);
  assert.equal((await call('/suppliers')).body.length, 1);
  const { body: [s] } = await call('/suppliers');
  assert.equal(s.balance, 86000 + 23000);

  assert.equal((await call(`/suppliers/${s.id}/payments`, 'POST', { amount: 999999 })).status, 409);
  const pay = await call(`/suppliers/${s.id}/payments`, 'POST', { amount: 50000, method: 'bank', note: 'NEFT' });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.balance, 59000);
  assert.equal((await call('/summary?since=2000-01-01 00:00:00')).body.supplier_due, 59000);
});

test('supplier with opening balance; purchases list by supplier', async () => {
  const r = await call('/suppliers', 'POST', { name: 'Hindustan Distributors', phone: '9822222222', gstin: '07ABCDE1234F1Z5', opening_balance: 100000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance, 100000);
  assert.equal(r.body.gstin, '07ABCDE1234F1Z5');
  const due = (await call('/suppliers?due=1')).body;
  assert.equal(due[0].name, 'Hindustan Distributors', 'largest due first');
  const gupta = due.find((x) => x.name === 'Gupta Traders');
  assert.equal((await call(`/purchases?supplier_id=${gupta.id}`)).body.length, 2);
  assert.equal((await call(`/purchases?supplier_id=${r.body.id}`)).body.length, 0);
});

test('invalid purchases change nothing', async () => {
  const before = (await call('/products/barcode/SALT')).body.quantity;
  const bad = [
    { supplier_name: 'X', items: [] },
    { items: [{ barcode: 'SALT', quantity: 1, unit_cost: 100 }] },
    { supplier_name: 'X', items: [{ barcode: 'SALT', quantity: 1, unit_cost: 100 }], paid: 500 },
    { supplier_name: 'X', items: [{ barcode: 'SALT', quantity: 1, unit_cost: 100 }, { barcode: 'NEW', quantity: 1, unit_cost: 100 }] },
  ];
  for (const body of bad) assert.equal((await call('/purchases', 'POST', body)).status, 400, JSON.stringify(body));
  assert.equal((await call('/products/barcode/SALT')).body.quantity, before);
  assert.equal((await call('/products/barcode/NEW')).status, 404);
  assert.ok(!(await call('/suppliers')).body.some((s) => s.name === 'X'), 'no half-created supplier');
});

test('offline purchase and supplier payment retries are idempotent', async () => {
  const body = {
    supplier_name: 'Gupta Traders', client_id: 'dev1-pur-1', created_at: '2026-02-01T09:00:00Z',
    items: [{ barcode: 'SALT', quantity: 5, unit_cost: 2300 }],
  };
  const first = await call('/purchases', 'POST', body);
  const again = await call('/purchases', 'POST', body);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.equal(first.body.created_at, '2026-02-01 09:00:00');
  assert.equal((await call('/products/barcode/SALT')).body.quantity, 22 + 10 + 5);

  const { body: [s] } = await call('/suppliers?q=Gupta');
  const pay = { amount: 1000, client_id: 'dev1-spay-1' };
  await call(`/suppliers/${s.id}/payments`, 'POST', pay);
  const r = await call(`/suppliers/${s.id}/payments`, 'POST', pay);
  assert.equal(r.status, 200);
  assert.equal(r.body.balance, 59000 + 11500 - 1000);
});

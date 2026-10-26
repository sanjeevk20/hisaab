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

test('scanning a new barcode creates the product with stock', async () => {
  const r = await call('/stock-in', 'POST', { barcode: '8901030865278', quantity: 10, name: 'Surf Excel 1kg', price: 14500, gst_rate: 18 });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, true);
  assert.equal(r.body.product.quantity, 10);
});

test('scanning a known barcode adds to existing stock', async () => {
  const r = await call('/stock-in', 'POST', { barcode: '8901030865278', quantity: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, false);
  assert.equal(r.body.product.quantity, 15);
});

test('new barcode without name/price is rejected', async () => {
  const r = await call('/stock-in', 'POST', { barcode: '000111', quantity: 1 });
  assert.equal(r.status, 400);
});

test('sale removes sold quantity from stock and records the bill', async () => {
  const { body: p } = await call('/products/barcode/8901030865278');
  const sale = await call('/sales', 'POST', {
    items: [{ product_id: p.id, quantity: 2 }, { product_id: p.id, quantity: 1 }],
    discount: 500,
    payment_method: 'upi',
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.body.subtotal, 43500);
  assert.equal(sale.body.total, 43000);
  assert.equal(sale.body.tax, Math.round((43000 * 18) / 118));
  assert.equal(sale.body.items.length, 1, 'duplicate lines are merged');

  const { body: after } = await call(`/products/${p.id}`);
  assert.equal(after.quantity, 12);

  const { body: moves } = await call(`/products/${p.id}/movements`);
  assert.deepEqual(moves.map((m) => [m.reason, m.change]), [['sale', -3], ['stock_in', 5], ['stock_in', 10]]);
});

test('overselling fails and leaves stock untouched (all-or-nothing)', async () => {
  const { body: a } = await call('/stock-in', 'POST', { barcode: 'A1', quantity: 3, name: 'Parle-G', price: 1000 });
  const { body: b } = await call('/products/barcode/8901030865278');
  const r = await call('/sales', 'POST', {
    items: [{ product_id: a.product.id, quantity: 1 }, { product_id: b.id, quantity: 999 }],
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Only 12 of Surf Excel/);
  assert.equal((await call(`/products/${a.product.id}`)).body.quantity, 3);
  assert.equal((await call(`/products/${b.id}`)).body.quantity, 12);
});

test('selling the last unit leaves the product at zero, not deleted', async () => {
  const { body: a } = await call('/products/barcode/A1');
  await call('/sales', 'POST', { items: [{ product_id: a.id, quantity: 3 }] });
  const { body: p } = await call('/products/barcode/A1');
  assert.equal(p.quantity, 0);
  const low = await call('/products?low=1');
  assert.ok(low.body.some((x) => x.barcode === 'A1'));
});

test('manual adjustment cannot push stock below zero', async () => {
  const { body: a } = await call('/products/barcode/A1');
  const r = await call(`/products/${a.id}/stock`, 'POST', { change: -1, reason: 'adjustment' });
  assert.equal(r.status, 409);
});

test('validation and lookups', async () => {
  assert.equal((await call('/products/barcode/nope')).status, 404);
  assert.equal((await call('/sales', 'POST', { items: [] })).status, 400);
  assert.equal((await call('/sales', 'POST', { items: [{ product_id: 1, quantity: 1.5 }] })).status, 400);
  assert.equal((await call('/products', 'POST', { barcode: 'A1', name: 'Dup', price: 1 })).status, 409);
  const s = await call('/summary?since=2000-01-01 00:00:00');
  assert.equal(s.body.bills, 2);
});

test('PIN protects the API when configured', async () => {
  const locked = createServer(createHandler(openDb(':memory:'), { pin: '4321' }));
  await new Promise((r) => locked.listen(0, r));
  const url = `http://localhost:${locked.address().port}/api/products`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-hisaab-pin': '4321' } })).status, 200);
  } finally {
    locked.close();
  }
});

test('serves the web app', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Hisaab<\/title>/);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});

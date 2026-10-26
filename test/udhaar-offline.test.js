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
  await call('/stock-in', 'POST', { barcode: 'MILK', quantity: 10, name: 'Amul Milk 500ml', price: 3300 });
  await call('/stock-in', 'POST', { barcode: 'BREAD', quantity: 2, name: 'Bread', price: 4500 });
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

test('udhaar sale creates the customer and puts the bill on their khata', async () => {
  const r = await call('/sales', 'POST', {
    items: [{ barcode: 'MILK', quantity: 2 }],
    payment_method: 'credit',
    customer_name: 'Ramesh',
    customer_phone: '+91 98765 43210',
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.customer_id);
  const { body: c } = await call(`/customers/${r.body.customer_id}`);
  assert.equal(c.phone, '9876543210');
  assert.equal(c.balance, 6600);
  assert.deepEqual(c.entries.map((e) => [e.type, e.amount]), [['credit_sale', 6600]]);
});

test('second udhaar sale matches the customer by phone', async () => {
  const r = await call('/sales', 'POST', {
    items: [{ barcode: 'MILK', quantity: 1 }],
    payment_method: 'credit',
    customer_phone: '9876543210',
  });
  const { body: list } = await call('/customers');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, r.body.customer_id);
  assert.equal(list[0].balance, 9900);
});

test('udhaar by name alone matches the existing regular', async () => {
  await call('/sales', 'POST', { items: [{ barcode: 'MILK', quantity: 1 }], payment_method: 'credit', customer_name: 'Kamla' });
  await call('/sales', 'POST', { items: [{ barcode: 'MILK', quantity: 1 }], payment_method: 'credit', customer_name: 'kamla' });
  const { body } = await call('/customers?q=Kamla');
  assert.equal(body.length, 1);
  assert.equal(body[0].balance, 6600);
});

test('udhaar without a customer is rejected', async () => {
  const r = await call('/sales', 'POST', { items: [{ barcode: 'MILK', quantity: 1 }], payment_method: 'credit' });
  assert.equal(r.status, 400);
});

test('payments reduce the balance and cannot exceed it', async () => {
  const { body: [c] } = await call('/customers');
  assert.equal((await call(`/customers/${c.id}/payments`, 'POST', { amount: 99999 })).status, 409);
  const r = await call(`/customers/${c.id}/payments`, 'POST', { amount: 4900, method: 'upi' });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance, 5000);
  assert.equal((await call('/summary?since=2000-01-01 00:00:00')).body.udhaar_due, 5000 + 6600, 'Ramesh + Kamla');
});

test('customer with opening balance from a paper khata', async () => {
  const r = await call('/customers', 'POST', { name: 'Sita', phone: '9000000001', opening_balance: 25000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance, 25000);
  assert.equal((await call('/customers', 'POST', { name: 'Dup', phone: '919000000001' })).status, 409);
  const due = await call('/customers?due=1');
  assert.equal(due.body[0].name, 'Sita', 'largest balance first');
});

test('retrying an offline sale with the same client_id does not double-count', async () => {
  const sale = { items: [{ barcode: 'MILK', quantity: 1 }], client_id: 'dev1-sale-1', offline: true, created_at: '2026-01-15T10:30:00Z' };
  const first = await call('/sales', 'POST', sale);
  const again = await call('/sales', 'POST', sale);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.equal(first.body.created_at, '2026-01-15 10:30:00', 'keeps the time the sale actually happened');
  assert.equal((await call('/products/barcode/MILK')).body.quantity, 4);
});

test('offline sale that oversold is accepted, stock floors at zero, shortfall is flagged', async () => {
  const r = await call('/sales', 'POST', { items: [{ barcode: 'BREAD', quantity: 3 }], client_id: 'dev1-sale-2', offline: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.warnings.length, 1);
  const { body: p } = await call('/products/barcode/BREAD');
  assert.equal(p.quantity, 0);
  const { body: moves } = await call(`/products/${p.id}/movements`);
  assert.equal(moves.reduce((s, m) => s + m.change, 0), 0, 'ledger still adds up to stock');
  // The same oversell from an online checkout is still refused.
  assert.equal((await call('/sales', 'POST', { items: [{ barcode: 'BREAD', quantity: 1 }] })).status, 409);
});

test('offline stock-in retries are idempotent, including new products', async () => {
  const body = { barcode: 'EGGS', quantity: 30, name: 'Eggs', price: 700, client_id: 'dev1-stock-1' };
  assert.equal((await call('/stock-in', 'POST', body)).status, 201);
  const again = await call('/stock-in', 'POST', body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.product.quantity, 30);
  const restock = { barcode: 'EGGS', quantity: 6, client_id: 'dev1-stock-2' };
  await call('/stock-in', 'POST', restock);
  await call('/stock-in', 'POST', restock);
  assert.equal((await call('/products/barcode/EGGS')).body.quantity, 36);
});

test('offline payment retries are idempotent', async () => {
  const { body: [sita] } = await call('/customers?q=Sita');
  const pay = { amount: 1000, client_id: 'dev1-pay-1' };
  await call(`/customers/${sita.id}/payments`, 'POST', pay);
  const again = await call(`/customers/${sita.id}/payments`, 'POST', pay);
  assert.equal(again.status, 200);
  assert.equal(again.body.balance, 24000);
});

test('rejects a future created_at', async () => {
  const r = await call('/sales', 'POST', { items: [{ barcode: 'MILK', quantity: 1 }], created_at: '2999-01-01T00:00:00Z' });
  assert.equal(r.status, 400);
});

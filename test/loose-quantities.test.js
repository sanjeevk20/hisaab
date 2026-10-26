import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';
import { lineAmount, quantityProblem, round3 } from '../public/gst.js';

let server, base, store;
async function call(path, method = 'GET', body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const stock = async (barcode) => (await call(`/products/barcode/${barcode}`)).body.quantity;

before(async () => {
  store = openDb(':memory:');
  server = createServer(createHandler(store));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('rules: decimals only for KGS, LTR, MTR, and at most 3 places', () => {
  assert.equal(quantityProblem('Sugar', 'KGS', 0.75), null);
  assert.equal(quantityProblem('Oil', 'LTR', 1.25), null);
  assert.match(quantityProblem('Sugar', 'KGS', 0.1234), /at most 3 decimals/);
  assert.match(quantityProblem('Soap', 'NOS', 1.5), /counted in whole NOS/);
  assert.match(quantityProblem('Soap', 'NOS', 0), /more than 0/);
  assert.equal(lineAmount(4800, 0.75), 3600, '0.75 kg × ₹48 = ₹36');
  assert.equal(lineAmount(4500, 0.333), 1499, '₹14.985 rounds to ₹14.99');
});

test('stock in loose and packed goods', async () => {
  assert.equal((await call('/stock-in', 'POST', { barcode: 'SUGAR', name: 'Sugar (loose)', price: 4800, cost: 4200, unit: 'KGS', gst_rate: 5, quantity: 10.5 })).status, 201);
  assert.equal(await stock('SUGAR'), 10.5);
  const packed = await call('/stock-in', 'POST', { barcode: 'SOAP', name: 'Soap', price: 4000, unit: 'NOS', quantity: 1.5 });
  assert.equal(packed.status, 400);
  assert.match(packed.body.error, /counted in whole NOS/);
  assert.equal((await call('/stock-in', 'POST', { barcode: 'SOAP', name: 'Soap', price: 4000, unit: 'NOS', quantity: 10 })).status, 201);
  assert.equal((await call('/stock-in', 'POST', { barcode: 'SUGAR', quantity: 0.0005 })).status, 400, 'too many decimals');
});

test('selling by weight: amount to the paisa, GST adds up, stock down', async () => {
  const r = await call('/sales', 'POST', { items: [{ barcode: 'SUGAR', quantity: 0.75 }, { barcode: 'SOAP', quantity: 1 }] });
  assert.equal(r.status, 201);
  const sugar = r.body.items.find((i) => i.barcode === 'SUGAR');
  assert.equal(sugar.quantity, 0.75);
  assert.equal(sugar.line_total, 3600);
  assert.equal(r.body.total, 3600 + 4000);
  assert.equal(r.body.taxable + r.body.cgst + r.body.sgst + r.body.igst, r.body.total);
  assert.equal(await stock('SUGAR'), 9.75);
  const bad = await call('/sales', 'POST', { items: [{ barcode: 'SOAP', quantity: 0.5 }] });
  assert.equal(bad.status, 400);
});

test('many small sales never drift', async () => {
  for (let i = 0; i < 10; i++) await call('/sales', 'POST', { items: [{ barcode: 'SUGAR', quantity: 0.1 }] });
  assert.equal(await stock('SUGAR'), 8.75, 'exactly 1 kg less, not 8.749999…');
  const moves = (await call(`/products/${(await call('/products/barcode/SUGAR')).body.id}/movements`)).body;
  assert.equal(round3(moves.reduce((s, m) => s + m.change, 0)), 8.75, 'the stock history still adds up');
});

test('can’t sell more than is weighed in', async () => {
  const r = await call('/sales', 'POST', { items: [{ barcode: 'SUGAR', quantity: 8.751 }] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Only 8.75 of Sugar/);
});

test('returns, purchases and corrections by weight', async () => {
  const sale = (await call('/sales', 'POST', { items: [{ barcode: 'SUGAR', quantity: 1.5 }], discount: 600 })).body;
  const detail = (await call(`/sales/${sale.id}`)).body;
  assert.equal(detail.returnable[0].returnable, 1.5);
  const ret = await call('/sale-returns', 'POST', { sale_id: sale.id, items: [{ barcode: 'SUGAR', quantity: 0.25 }] });
  assert.equal(ret.status, 201);
  assert.equal(ret.body.total, lineAmount(Math.round((7200 - 600) / 1.5), 0.25), 'refund of what was paid per kg');
  assert.equal((await call(`/sales/${sale.id}`)).body.returnable[0].returnable, 1.25);
  assert.equal(await stock('SUGAR'), 7.5);

  const p = await call('/purchases', 'POST', { supplier_name: 'Mill', items: [{ barcode: 'SUGAR', quantity: 25.5, unit_cost: 4100 }] });
  assert.equal(p.status, 201);
  assert.equal(p.body.total, 104550);
  assert.equal(await stock('SUGAR'), 33);

  const id = (await call('/products/barcode/SUGAR')).body.id;
  assert.equal((await call(`/products/${id}/stock`, 'POST', { change: -0.3, reason: 'adjustment', note: 'Spilled' })).body.quantity, 32.7);
});

test('a product with loose stock can’t be switched to a whole-number unit', async () => {
  const id = (await call('/products/barcode/SUGAR')).body.id;
  assert.equal((await call(`/products/${id}`, 'PATCH', { unit: 'NOS' })).status, 409);
  assert.equal((await call(`/products/${id}`, 'PATCH', { unit: 'LTR' })).status, 200, 'another loose unit is fine');
  await call(`/products/${id}`, 'PATCH', { unit: 'KGS' });
});

test('reports show weights to 3 decimals', async () => {
  const p = (await call('/reports/profit?from=2000-01-01&to=2100-01-01')).body;
  const sugar = p.by_product.find((x) => x.barcode === 'SUGAR');
  assert.equal(sugar.qty_sold, 0.75 + 1 + 1.5);
  assert.equal(sugar.qty_returned, 0.25);
  const summary = (await call('/summary?since=2000-01-01 00:00:00')).body;
  assert.equal(summary.units, 32.7 + 9);
});

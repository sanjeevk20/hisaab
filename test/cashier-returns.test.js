import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

let server, base, store, owner, ravi, sita, bills;

async function call(path, method = 'GET', body, token) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const ret = (sale, barcode, quantity, token, extra = {}) =>
  call('/sale-returns', 'POST', { sale_id: sale.id, items: [{ barcode, quantity }], ...extra }, token);

before(async () => {
  store = openDb(':memory:');
  server = createServer(createHandler(store));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  owner = (await call('/auth/setup', 'POST', { name: 'Ramesh', username: 'ramesh', pin: '246810' })).body.token;
  for (const u of ['ravi', 'sita']) await call('/users', 'POST', { name: u, username: u, role: 'cashier', pin: '4321' }, owner);
  ravi = (await call('/auth/login', 'POST', { username: 'ravi', pin: '4321' })).body.token;
  sita = (await call('/auth/login', 'POST', { username: 'sita', pin: '4321' })).body.token;
  await call('/stock-in', 'POST', { barcode: 'TEA', quantity: 100, name: 'Tea', price: 10000, cost: 8000 }, owner);
  await call('/stock-in', 'POST', { barcode: 'TV', quantity: 5, name: 'TV', price: 2000000, cost: 1500000 }, owner);
  bills = {
    today: (await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 10 }, { barcode: 'TV', quantity: 1 }] }, owner)).body,
    byRavi: (await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 5 }] }, ravi)).body,
    old: (await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 5 }], created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() }, owner)).body,
  };
});
after(() => server.close());

test('by default cashiers cannot take returns', async () => {
  const r = await ret(bills.byRavi, 'TEA', 1, ravi);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Only the owner can take returns/);
  assert.equal((await call(`/sales/${bills.today.id}`, 'GET', null, ravi)).status, 403, "can't open others' bills yet");
});

test('owner sets the limits; they are validated', async () => {
  assert.equal((await call('/settings', 'PUT', { cashier_return_limit: 50000, cashier_return_daily_limit: 10000 }, owner)).status, 400,
    'daily cap below the per-return limit');
  assert.equal((await call('/settings', 'PUT', { cashier_return_limit: 1000 }, ravi)).status, 403, 'cashiers cannot change it');
  const r = await call('/settings', 'PUT', { cashier_return_limit: 50000, cashier_return_daily_limit: 80000, cashier_return_days: 7 }, owner);
  assert.equal(r.status, 200);
  const log = (await call('/audit-log?entity=settings', 'GET', null, owner)).body[0];
  assert.deepEqual(log.changes.cashier_return_limit, [0, 50000]);
});

test('within the limit: a cashier can return against any recent bill', async () => {
  assert.equal((await call(`/sales/${bills.today.id}`, 'GET', null, ravi)).status, 200, 'can open the bill to return from it');
  const r = await ret(bills.today, 'TEA', 3, ravi, { refund_method: 'cash' });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 30000);
  assert.equal(store.db.prepare('SELECT user_id FROM sale_returns WHERE id = ?').get(r.body.id).user_id,
    store.db.prepare("SELECT id FROM users WHERE username = 'ravi'").get().id, 'recorded as Ravi’s return');
});

test('bills can be found by the number on the receipt', async () => {
  const byNo = await call(`/sales/by-number/${encodeURIComponent(bills.today.invoice_no)}`, 'GET', null, ravi);
  assert.equal(byNo.status, 200);
  assert.equal(byNo.body.id, bills.today.id);
  assert.ok(Array.isArray(byNo.body.returnable));
  assert.equal((await call(`/sales/by-number/${encodeURIComponent('#' + bills.today.id)}`, 'GET', null, ravi)).body.id, bills.today.id);
  assert.equal((await call('/sales/by-number/NOPE-1', 'GET', null, ravi)).status, 404);
});

test('limits: per return, bill age, bill required', async () => {
  const big = await ret(bills.today, 'TV', 1, ravi);
  assert.equal(big.status, 403);
  assert.match(big.body.error, /Returns over ₹500 need the owner/);

  const old = await ret(bills.old, 'TEA', 1, ravi);
  assert.equal(old.status, 403);
  assert.match(old.body.error, /10 days old — returns after 7 days need the owner/);

  const noBill = await call('/sale-returns', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }] }, ravi);
  assert.equal(noBill.status, 403);
  assert.match(noBill.body.error, /against a bill/);

  assert.equal((await ret(bills.today, 'TV', 1, owner)).status, 201, 'the owner has no limit');
});

test('daily cap is per cashier and counts every return that day', async () => {
  // Ravi has used ₹300 of ₹800.
  let s = (await call('/summary', 'GET', null, ravi)).body;
  assert.deepEqual(s.returns, { per_return: 50000, daily: 80000, left_today: 50000, days: 7 });
  assert.equal((await ret(bills.today, 'TEA', 4, ravi)).status, 201, '₹400 → ₹700 used');
  const over = await ret(bills.byRavi, 'TEA', 2, ravi);
  assert.equal(over.status, 403);
  assert.match(over.body.error, /past ₹800 \(₹100 left\)/);
  assert.equal((await ret(bills.byRavi, 'TEA', 1, ravi)).status, 201, 'exactly up to the cap is fine');
  s = (await call('/summary', 'GET', null, ravi)).body;
  assert.equal(s.returns.left_today, 0);

  // Sita has her own allowance.
  assert.equal((await ret(bills.byRavi, 'TEA', 2, sita)).status, 201);
});

test('returns at the same moment cannot slip past the cap together', async () => {
  // Sita has used ₹200 of ₹800. Three ₹300 returns arrive at once: only two fit.
  const bill = (await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 9 }] }, owner)).body;
  const results = await Promise.all([1, 2, 3].map((n) => ret(bill, 'TEA', 3, sita, { client_id: `race-${n}` })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 403]);
  const sitaId = store.db.prepare("SELECT id FROM users WHERE username = 'sita'").get().id;
  assert.equal(store.cashierRefundsToday(sitaId), 80000);
});

test('turning the limit off stops cashier returns again', async () => {
  await call('/settings', 'PUT', { cashier_return_limit: 0, cashier_return_daily_limit: 0 }, owner);
  assert.equal((await ret(bills.byRavi, 'TEA', 1, ravi)).status, 403);
  assert.equal((await call('/summary', 'GET', null, ravi)).body.returns, null);
});

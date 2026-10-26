import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

let server, base, store, owner, cashier, cashierId;

async function call(path, method = 'GET', body, token) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

before(async () => {
  store = openDb(':memory:');
  server = createServer(createHandler(store));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('without logins the shop runs open, as before', async () => {
  assert.deepEqual((await call('/auth/status')).body, { setup_required: true, user: null });
  assert.equal((await call('/stock-in', 'POST', { barcode: 'TEA', quantity: 20, name: 'Tea', price: 10000, cost: 8000 })).status, 201);
  assert.equal((await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }] })).status, 201);
});

test('first owner: PIN rules, then setup closes', async () => {
  assert.equal((await call('/auth/setup', 'POST', { name: 'Ramesh', username: 'ramesh', pin: '1234' })).status, 400, 'owners need 6 digits');
  assert.equal((await call('/auth/setup', 'POST', { name: 'Ramesh', username: 'Ra mesh', pin: '123456' })).status, 400, 'bad username');
  const r = await call('/auth/setup', 'POST', { name: 'Ramesh Sharma', username: 'Ramesh', pin: '246810' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'owner');
  assert.equal(r.body.user.username, 'ramesh');
  assert.ok(!('pin_hash' in r.body.user));
  owner = r.body.token;
  assert.equal((await call('/auth/setup', 'POST', { name: 'X', username: 'intruder', pin: '999999' })).status, 409);
});

test('once set up, everything needs a sign-in', async () => {
  const r = await call('/products');
  assert.equal(r.status, 401);
  assert.equal(r.body.login_required, true);
  assert.equal((await call('/products', 'GET', null, 'not-a-token')).status, 401);
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/products', 'GET', null, owner)).status, 200);
  assert.equal((await call('/auth/status', 'GET', null, owner)).body.user.name, 'Ramesh Sharma');
});

test('PINs are stored hashed, never in plain text', () => {
  const row = store.db.prepare('SELECT pin_hash FROM users WHERE username = ?').get('ramesh');
  assert.match(row.pin_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(!row.pin_hash.includes('246810'));
  const s = store.db.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(s.token_hash, owner, 'only a hash of the session token is stored');
});

test('owner adds a cashier; cashier signs in', async () => {
  assert.equal((await call('/users', 'POST', { name: 'Ravi', username: 'ravi', role: 'cashier', pin: '12' }, owner)).status, 400);
  const u = await call('/users', 'POST', { name: 'Ravi', username: 'ravi', role: 'cashier', pin: '4321' }, owner);
  assert.equal(u.status, 201);
  cashierId = u.body.id;
  assert.equal((await call('/users', 'POST', { name: 'Ravi 2', username: 'RAVI', pin: '4321' }, owner)).status, 409, 'username taken');
  assert.equal((await call('/auth/login', 'POST', { username: 'ravi', pin: '0000' })).status, 401);
  const login = await call('/auth/login', 'POST', { username: 'Ravi', pin: '4321' });
  assert.equal(login.status, 200);
  cashier = login.body.token;
});

test('cashier can bill, take udhaar and payments, restock — and nothing else', async () => {
  const sale = await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 2 }], payment_method: 'credit', customer_name: 'Kamla' }, cashier);
  assert.equal(sale.status, 201);
  const [c] = (await call('/customers', 'GET', null, cashier)).body;
  assert.equal((await call(`/customers/${c.id}/payments`, 'POST', { amount: 5000 }, cashier)).status, 201);
  assert.equal((await call('/stock-in', 'POST', { barcode: 'TEA', quantity: 5 }, cashier)).status, 200);
  assert.equal((await call('/customers', 'POST', { name: 'New person' }, cashier)).status, 201);

  const forbidden = [
    ['/stock-in', 'POST', { barcode: 'NEW', quantity: 1, name: 'New', price: 100 }],
    ['/customers', 'POST', { name: 'Old dues', opening_balance: 5000 }],
    ['/products/1', 'PATCH', { price: 1 }],
    ['/products/1/stock', 'POST', { change: -5 }],
    ['/products/1/movements', 'GET'],
    ['/sale-returns', 'POST', { sale_id: sale.body.id, items: [{ barcode: 'TEA', quantity: 1 }] }],
    ['/purchases', 'POST', { supplier_name: 'X', items: [{ barcode: 'TEA', quantity: 1, unit_cost: 1 }] }],
    ['/suppliers', 'GET'],
    ['/reports/profit', 'GET'],
    ['/reports/gstr1?month=2026-10', 'GET'],
    ['/settings', 'PUT', { trade_name: 'Hacked' }],
    ['/users', 'GET'],
    ['/users', 'POST', { name: 'Me', username: 'me2', role: 'owner', pin: '123456' }],
    [`/users/${cashierId}`, 'PATCH', { role: 'owner' }],
    ['/audit-log', 'GET'],
    ['/backup', 'GET'],
  ];
  for (const [path, method, body] of forbidden) {
    const r = await call(path, method, body, cashier);
    assert.equal(r.status, 403, `${method} ${path} → ${r.status}`);
  }
});

test('cashiers never see cost prices', async () => {
  const products = (await call('/products', 'GET', null, cashier)).body;
  assert.ok(products.length && products.every((p) => !('cost' in p)));
  const bill = (await call('/sales', 'GET', null, cashier)).body[0];
  const full = (await call(`/sales/${bill.id}`, 'GET', null, cashier)).body;
  assert.ok(full.items.every((i) => !('unit_cost' in i)));
  assert.equal((await call('/products', 'GET', null, owner)).body[0].cost, 8000, 'owner still sees them');
});

test('cashiers see only their own bills; everything is attributed', async () => {
  const ownerSale = (await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }] }, owner)).body;
  const mine = (await call('/sales', 'GET', null, cashier)).body;
  assert.ok(mine.length === 1 && mine.every((s) => s.user_name === 'Ravi'));
  assert.equal((await call(`/sales/${ownerSale.id}`, 'GET', null, cashier)).status, 403);
  const all = (await call('/sales', 'GET', null, owner)).body;
  assert.equal(all.find((s) => s.id === ownerSale.id).user_name, 'Ramesh Sharma');
  assert.equal(all.find((s) => s.id === mine[0].id).user_name, 'Ravi');

  const summary = (await call('/summary?since=2000-01-01 00:00:00', 'GET', null, cashier)).body;
  assert.deepEqual(Object.keys(summary).sort(), ['bills', 'own', 'refunds', 'returns', 'revenue']);
  assert.equal(summary.returns, null, 'no return allowance until the owner sets one');
  assert.equal(summary.bills, 1);

  const moves = store.db.prepare("SELECT user_id FROM stock_movements WHERE reason = 'sale' ORDER BY id DESC LIMIT 2").all();
  assert.ok(moves.every((m) => m.user_id), 'stock movements are attributed');
  const pay = store.db.prepare("SELECT user_id FROM ledger_entries WHERE type = 'payment'").get();
  assert.equal(pay.user_id, cashierId);
});

test('concurrent requests are attributed to the right person', async () => {
  // Interleave many sales from both users; each must carry its own author.
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }], client_id: `c${i}` }, i % 2 ? owner : cashier)));
  const rows = store.db.prepare("SELECT client_id, user_id FROM sales WHERE client_id LIKE 'c%'").all();
  const ownerId = store.db.prepare("SELECT id FROM users WHERE username = 'ramesh'").get().id;
  for (const r of rows) assert.equal(r.user_id, Number(r.client_id.slice(1)) % 2 ? ownerId : cashierId, r.client_id);
});

test('five wrong PINs lock the account; owner reset unlocks it', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await call('/auth/login', 'POST', { username: 'ravi', pin: '9999' })).status, 401);
  assert.equal((await call('/auth/login', 'POST', { username: 'ravi', pin: '9999' })).status, 429);
  assert.equal((await call('/auth/login', 'POST', { username: 'ravi', pin: '4321' })).status, 429, 'locked even with the right PIN');
  assert.equal((await call(`/users/${cashierId}`, 'PATCH', { pin: '5678' }, owner)).status, 200);
  assert.equal((await call('/products', 'GET', null, cashier)).status, 401, 'a PIN reset signs the person out');
  const again = await call('/auth/login', 'POST', { username: 'ravi', pin: '5678' });
  assert.equal(again.status, 200);
  cashier = again.body.token;
  const log = (await call('/audit-log?entity=user', 'GET', null, owner)).body.map((r) => r.action);
  assert.ok(log.includes('locked') && log.includes('login_failed') && log.includes('login'));
});

test('deactivating a user signs them out; the last owner is protected', async () => {
  const ownerId = (await call('/auth/status', 'GET', null, owner)).body.user.id;
  assert.equal((await call(`/users/${ownerId}`, 'PATCH', { role: 'cashier' }, owner)).status, 409);
  assert.equal((await call(`/users/${ownerId}`, 'PATCH', { active: false }, owner)).status, 409);
  assert.equal((await call(`/users/${cashierId}`, 'PATCH', { active: false }, owner)).status, 200);
  assert.equal((await call('/products', 'GET', null, cashier)).status, 401);
  assert.equal((await call('/auth/login', 'POST', { username: 'ravi', pin: '5678' })).status, 401);
  const users = (await call('/users', 'GET', null, owner)).body;
  assert.ok(users.every((u) => !('pin_hash' in u)));
  assert.equal(users.find((u) => u.id === cashierId).active, false);
});

test('logout ends the session', async () => {
  const t = (await call('/auth/login', 'POST', { username: 'ramesh', pin: '246810' })).body.token;
  assert.equal((await call('/auth/logout', 'POST', {}, t)).status, 200);
  assert.equal((await call('/products', 'GET', null, t)).status, 401);
  assert.equal((await call('/products', 'GET', null, owner)).status, 200, 'other sessions unaffected');
});

// HTTP layer: a small JSON API plus static hosting for the mobile web app in /public.
// Amounts in the API are integer paise (₹1 = 100).
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './db.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const PAYMENT_METHODS = ['cash', 'upi', 'card', 'credit'];

// --- validation helpers -------------------------------------------------

function str(v, field, { required = false, max = 200 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long`);
  return s;
}

function int(v, field, { required = false, min = 0, max = 1e12 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return v;
}

function rate(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || v < 0 || v > 100) throw new HttpError(400, 'gst_rate must be 0–100');
  return v;
}

// Time an offline device says an action happened (ISO 8601) → SQLite UTC text.
function clientTime(v) {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new HttpError(400, 'created_at must be an ISO date');
  if (t > Date.now() + 5 * 60_000) throw new HttpError(400, 'created_at is in the future');
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

function productFields(body, { partial }) {
  const fields = {
    barcode: str(body.barcode, 'barcode', { required: !partial, max: 64 }),
    name: str(body.name, 'name', { required: !partial }),
    price: int(body.price, 'price', { required: !partial }),
    cost: int(body.cost, 'cost'),
    gst_rate: rate(body.gst_rate),
    low_stock: int(body.low_stock, 'low_stock', { max: 1e6 }),
  };
  if (!partial) fields.quantity = int(body.quantity, 'quantity', { max: 1e6 }) ?? 0;
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

// --- request plumbing ---------------------------------------------------

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1e6) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function pinMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || file.includes(`${sep}..`)) return send(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

// --- routes -------------------------------------------------------------

function routes(store) {
  return [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],

    ['GET', /^\/api\/summary$/, (_req, _m, url) => {
      const since = url.searchParams.get('since') ?? new Date().toISOString().slice(0, 10) + ' 00:00:00';
      return store.summary(since);
    }],

    ['GET', /^\/api\/products$/, (_req, _m, url) =>
      store.listProducts({ q: url.searchParams.get('q'), lowStock: url.searchParams.get('low') === '1' })],

    ['GET', /^\/api\/products\/barcode\/(.+)$/, (_req, m) => {
      const p = store.getByBarcode(decodeURIComponent(m[1]));
      if (!p) throw new HttpError(404, 'No product with this barcode');
      return p;
    }],

    ['POST', /^\/api\/products$/, async (req) => [201, store.createProduct(productFields(await readJson(req), { partial: false }))]],

    ['GET', /^\/api\/products\/(\d+)$/, (_req, m) => {
      const p = store.getProduct(Number(m[1]));
      if (!p) throw new HttpError(404, 'Product not found');
      return p;
    }],

    ['PATCH', /^\/api\/products\/(\d+)$/, async (req, m) =>
      store.updateProduct(Number(m[1]), productFields(await readJson(req), { partial: true }))],

    // Manual stock change: { change: +10 | -2, reason: 'stock_in' | 'adjustment', note }
    ['POST', /^\/api\/products\/(\d+)\/stock$/, async (req, m) => {
      const body = await readJson(req);
      const change = int(body.change, 'change', { required: true, min: -1e6, max: 1e6 });
      if (change === 0) throw new HttpError(400, 'change cannot be 0');
      const reason = body.reason ?? (change > 0 ? 'stock_in' : 'adjustment');
      if (!['stock_in', 'adjustment'].includes(reason)) throw new HttpError(400, 'reason must be stock_in or adjustment');
      if (reason === 'stock_in' && change < 0) throw new HttpError(400, 'stock_in must add stock');
      return store.adjustStock(Number(m[1]), change, reason, str(body.note, 'note') ?? null);
    }],

    ['GET', /^\/api\/products\/(\d+)\/movements$/, (_req, m) => store.movements(Number(m[1]))],

    // Scan-to-stock: adds quantity to an existing barcode, or creates the product if it is new.
    // A repeated client_id (an offline retry) is a no-op that returns the product.
    ['POST', /^\/api\/stock-in$/, async (req) => {
      const body = await readJson(req);
      const barcode = str(body.barcode, 'barcode', { required: true, max: 64 });
      const quantity = int(body.quantity, 'quantity', { required: true, min: 1, max: 1e6 });
      const clientId = str(body.client_id, 'client_id', { max: 64 }) ?? null;
      return store.transaction(() => {
        const seen = clientId && store.productForMovement(clientId);
        if (seen) return { created: false, duplicate: true, product: seen };
        const existing = store.getByBarcode(barcode);
        if (existing) {
          const product = store.adjustStock(existing.id, quantity, 'stock_in', str(body.note, 'note') ?? null, clientId);
          return { created: false, product };
        }
        const product = store.createProduct(productFields({ ...body, barcode, quantity }, { partial: false }), clientId);
        return [201, { created: true, product }];
      });
    }],

    ['GET', /^\/api\/customers$/, (_req, _m, url) =>
      store.listCustomers({ q: url.searchParams.get('q'), dueOnly: url.searchParams.get('due') === '1' })],

    // { name, phone?, opening_balance? } — opening_balance carries over dues from a paper khata.
    ['POST', /^\/api\/customers$/, async (req) => {
      const body = await readJson(req);
      return [201, store.createCustomer({
        name: str(body.name, 'name', { required: true }),
        phone: str(body.phone, 'phone', { max: 20 }) ?? null,
        opening_balance: int(body.opening_balance, 'opening_balance') ?? 0,
      })];
    }],

    ['GET', /^\/api\/customers\/(\d+)$/, (_req, m) => {
      const c = store.getCustomer(Number(m[1]));
      if (!c) throw new HttpError(404, 'Customer not found');
      return c;
    }],

    // { amount, method?, note?, client_id?, created_at? }
    ['POST', /^\/api\/customers\/(\d+)\/payments$/, async (req, m) => {
      const body = await readJson(req);
      const method = body.method ?? 'cash';
      if (!['cash', 'upi', 'card'].includes(method)) throw new HttpError(400, 'method must be cash, upi or card');
      const { duplicate, customer } = store.recordPayment(Number(m[1]), {
        amount: int(body.amount, 'amount', { required: true, min: 1 }),
        method,
        note: str(body.note, 'note') ?? null,
        client_id: str(body.client_id, 'client_id', { max: 64 }) ?? null,
        created_at: clientTime(body.created_at),
      });
      return [duplicate ? 200 : 201, customer];
    }],

    ['GET', /^\/api\/sales$/, (_req, _m, url) =>
      store.listSales({
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: Math.min(Number(url.searchParams.get('limit')) || 50, 500),
      })],

    ['GET', /^\/api\/sales\/(\d+)$/, (_req, m) => {
      const sale = store.getSale(Number(m[1]));
      if (!sale) throw new HttpError(404, 'Bill not found');
      return sale;
    }],

    // Checkout: { items: [{ product_id | barcode, quantity }], discount, payment_method,
    //   customer_id | customer_name + customer_phone, client_id?, created_at?, offline? }
    // payment_method 'credit' (udhaar) adds the total to the customer's khata.
    // offline: true marks a sale already made without internet; it is accepted even if stock ran short.
    ['POST', /^\/api\/sales$/, async (req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'Add at least one item');
      if (body.items.length > 500) throw new HttpError(400, 'Too many items');
      const items = body.items.map((it, i) => {
        const product_id = int(it?.product_id, `items[${i}].product_id`, { min: 1 });
        const barcode = product_id ? undefined : str(it?.barcode, `items[${i}].barcode`, { required: true, max: 64 });
        return { product_id, barcode, quantity: int(it?.quantity, `items[${i}].quantity`, { required: true, min: 1, max: 1e6 }) };
      });
      const payment_method = body.payment_method ?? 'cash';
      if (!PAYMENT_METHODS.includes(payment_method)) {
        throw new HttpError(400, `payment_method must be one of ${PAYMENT_METHODS.join(', ')}`);
      }
      const sale = store.createSale({
        items,
        discount: int(body.discount, 'discount') ?? 0,
        payment_method,
        customer_id: int(body.customer_id, 'customer_id', { min: 1 }) ?? null,
        customer_name: str(body.customer_name, 'customer_name') ?? null,
        customer_phone: str(body.customer_phone, 'customer_phone', { max: 20 }) ?? null,
        client_id: str(body.client_id, 'client_id', { max: 64 }) ?? null,
        created_at: clientTime(body.created_at),
        allowOversell: body.offline === true,
      });
      return [sale.duplicate ? 200 : 201, sale];
    }],
  ];
}

export function createHandler(store, { pin } = {}) {
  const table = routes(store);

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return await serveStatic(req, res, url.pathname);
      }
      if (pin && url.pathname !== '/api/health' && !pinMatches(req.headers['x-hisaab-pin'], pin)) {
        throw new HttpError(401, 'Shop PIN required');
      }
      for (const [method, pattern, fn] of table) {
        const m = url.pathname.match(pattern);
        if (m && req.method === method) {
          const out = await fn(req, m, url);
          return Array.isArray(out) && typeof out[0] === 'number' ? send(res, out[0], out[1]) : send(res, 200, out);
        }
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (/UNIQUE constraint failed: products\.barcode/.test(err?.message)) {
        return send(res, 409, { error: 'Another product already uses this barcode' });
      }
      if (/UNIQUE constraint failed: customers\.phone/.test(err?.message)) {
        return send(res, 409, { error: 'Another customer already uses this phone number' });
      }
      console.error(err);
      send(res, 500, { error: 'Something went wrong' });
    }
  };
}

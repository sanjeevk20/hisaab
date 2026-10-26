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
const CUSTOMER_PAY = ['cash', 'upi', 'card'];
const SUPPLIER_PAY = ['cash', 'upi', 'bank', 'cheque'];

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

function paymentFields(body, methods) {
  const method = body.method ?? 'cash';
  if (!methods.includes(method)) throw new HttpError(400, `method must be one of ${methods.join(', ')}`);
  return {
    amount: int(body.amount, 'amount', { required: true, min: 1 }),
    method,
    note: str(body.note, 'note') ?? null,
    client_id: str(body.client_id, 'client_id', { max: 64 }) ?? null,
    created_at: clientTime(body.created_at),
  };
}

// Report period from ?from=&to= (UTC). Defaults to the current calendar month.
function period(url) {
  const ok = (v) => /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(v);
  const pad = (v) => (v.length === 10 ? v + ' 00:00:00' : v);
  const now = new Date();
  const from = url.searchParams.get('from') ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = url.searchParams.get('to') ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  if (!ok(from) || !ok(to)) throw new HttpError(400, 'from and to must look like 2026-10-01 or 2026-10-01 00:00:00');
  if (pad(from) >= pad(to)) throw new HttpError(400, 'from must be before to');
  return { from: pad(from), to: pad(to) };
}

const money = (paise) => (paise / 100).toFixed(2);

// "2026-10-01_2026-10-31" for a file name; the period's end is exclusive, so show the day before.
const periodTag = ({ from, to }) =>
  `${from.slice(0, 10)}_${new Date(Date.parse(to.replace(' ', 'T') + 'Z') - 1000).toISOString().slice(0, 10)}`;

// A CSV download. The route returns this marker object; the handler writes it as a file.
function csv(filename, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Quote when needed, and neutralise leading =+-@ so spreadsheets don't run it as a formula.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return { [CSV]: true, filename, body: '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n' };
}
const CSV = Symbol('csv');

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
      const { duplicate, party } = store.recordPayment(Number(m[1]), paymentFields(await readJson(req), CUSTOMER_PAY));
      return [duplicate ? 200 : 201, party];
    }],

    ['GET', /^\/api\/suppliers$/, (_req, _m, url) =>
      store.listSuppliers({ q: url.searchParams.get('q'), dueOnly: url.searchParams.get('due') === '1' })],

    // { name, phone?, gstin?, opening_balance? } — opening_balance is what the shop already owes them.
    ['POST', /^\/api\/suppliers$/, async (req) => {
      const body = await readJson(req);
      return [201, store.createSupplier({
        name: str(body.name, 'name', { required: true }),
        phone: str(body.phone, 'phone', { max: 20 }) ?? null,
        gstin: str(body.gstin, 'gstin', { max: 20 }) ?? null,
        opening_balance: int(body.opening_balance, 'opening_balance') ?? 0,
      })];
    }],

    ['GET', /^\/api\/suppliers\/(\d+)$/, (_req, m) => {
      const s = store.getSupplier(Number(m[1]));
      if (!s) throw new HttpError(404, 'Supplier not found');
      return s;
    }],

    // Paying a supplier: { amount, method?, note?, client_id?, created_at? }
    ['POST', /^\/api\/suppliers\/(\d+)\/payments$/, async (req, m) => {
      const { duplicate, party } = store.recordSupplierPayment(Number(m[1]), paymentFields(await readJson(req), SUPPLIER_PAY));
      return [duplicate ? 200 : 201, party];
    }],

    ['GET', /^\/api\/purchases$/, (_req, _m, url) =>
      store.listPurchases({
        supplierId: Number(url.searchParams.get('supplier_id')) || undefined,
        limit: Math.min(Number(url.searchParams.get('limit')) || 50, 500),
      })],

    ['GET', /^\/api\/purchases\/(\d+)$/, (_req, m) => {
      const p = store.getPurchase(Number(m[1]));
      if (!p) throw new HttpError(404, 'Purchase not found');
      p.returnable = store.returnableFromPurchase(p.id);
      return p;
    }],

    ['GET', /^\/api\/purchase-returns$/, (_req, _m, url) =>
      store.listReturns({
        supplierId: Number(url.searchParams.get('supplier_id')) || undefined,
        limit: Math.min(Number(url.searchParams.get('limit')) || 50, 500),
      })],

    ['GET', /^\/api\/purchase-returns\/(\d+)$/, (_req, m) => {
      const r = store.getReturn(Number(m[1]));
      if (!r) throw new HttpError(404, 'Return not found');
      return r;
    }],

    // Goods back to a supplier: { supplier_id, purchase_id?, items: [{ barcode, quantity, unit_cost? }],
    //   settlement?: 'adjust' (default, reduces what you owe) | 'refund' (they paid cash back),
    //   refund_method?, reason?, client_id?, created_at? }
    ['POST', /^\/api\/purchase-returns$/, async (req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'Add at least one item');
      if (body.items.length > 500) throw new HttpError(400, 'Too many items');
      const items = body.items.map((it, i) => ({
        barcode: str(it?.barcode, `items[${i}].barcode`, { required: true, max: 64 }),
        quantity: int(it?.quantity, `items[${i}].quantity`, { required: true, min: 1, max: 1e6 }),
        unit_cost: int(it?.unit_cost, `items[${i}].unit_cost`),
      }));
      const settlement = body.settlement ?? 'adjust';
      if (!['adjust', 'refund'].includes(settlement)) throw new HttpError(400, 'settlement must be adjust or refund');
      const refund_method = settlement === 'refund' ? body.refund_method ?? 'cash' : null;
      if (refund_method && !SUPPLIER_PAY.includes(refund_method)) {
        throw new HttpError(400, `refund_method must be one of ${SUPPLIER_PAY.join(', ')}`);
      }
      const r = store.createReturn({
        supplier_id: int(body.supplier_id, 'supplier_id', { required: true, min: 1 }),
        purchase_id: int(body.purchase_id, 'purchase_id', { min: 1 }) ?? null,
        items, settlement, refund_method,
        reason: str(body.reason, 'reason') ?? null,
        client_id: str(body.client_id, 'client_id', { max: 64 }) ?? null,
        created_at: clientTime(body.created_at),
      });
      return [r.duplicate ? 200 : 201, r];
    }],

    // Supplier-wise report for a period. from/to are UTC 'YYYY-MM-DD[ HH:MM:SS]', to is exclusive;
    // default is the current month. ?format=csv downloads it for a spreadsheet or accountant.
    ['GET', /^\/api\/reports\/suppliers$/, (_req, _m, url) => {
      const report = store.supplierReport(period(url));
      if (url.searchParams.get('format') !== 'csv') return report;
      return csv(`suppliers_${periodTag(report)}.csv`, [
        ['Supplier', 'Phone', 'GSTIN', 'Bills', 'Purchased', 'Returned', 'Net purchased', 'Paid', 'Refunded', 'Balance due', 'Last purchase'],
        ...report.rows.map((r) => [r.name, r.phone, r.gstin, r.bills, money(r.purchased), money(r.returned),
          money(r.net_purchased), money(r.paid), money(r.refunded), money(r.balance), r.last_purchase_at]),
        ['Total', '', '', report.totals.bills, money(report.totals.purchased), money(report.totals.returned),
          money(report.totals.net_purchased), money(report.totals.paid), money(report.totals.refunded), money(report.totals.balance), ''],
      ]);
    }],

    ['GET', /^\/api\/reports\/suppliers\/(\d+)$/, (_req, m, url) => {
      const report = store.supplierItemsReport(Number(m[1]), period(url));
      if (url.searchParams.get('format') !== 'csv') return report;
      const slug = report.supplier.name.replace(/[^\w]+/g, '-').toLowerCase();
      return csv(`${slug}_${periodTag(report)}.csv`, [
        ['Product', 'Barcode', 'Qty bought', 'Amount', 'Avg cost', 'Qty returned', 'Returned amount', 'Net amount'],
        ...report.items.map((i) => [i.name, i.barcode, i.bought_qty, money(i.bought_amount), i.avg_cost === null ? '' : money(i.avg_cost),
          i.returned_qty, money(i.returned_amount), money(i.bought_amount - i.returned_amount)]),
      ]);
    }],

    // Supplier bill: { supplier_id | supplier_name + supplier_phone?, invoice_no?,
    //   items: [{ barcode, quantity, unit_cost, name?, price?, gst_rate?, low_stock? }],
    //   paid?, payment_method?, note?, client_id?, created_at? }
    // New barcodes need name and price (selling price). Unpaid amount goes on the supplier's khata.
    ['POST', /^\/api\/purchases$/, async (req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'Add at least one item');
      if (body.items.length > 500) throw new HttpError(400, 'Too many items');
      const items = body.items.map((it, i) => ({
        barcode: str(it?.barcode, `items[${i}].barcode`, { required: true, max: 64 }),
        quantity: int(it?.quantity, `items[${i}].quantity`, { required: true, min: 1, max: 1e6 }),
        unit_cost: int(it?.unit_cost, `items[${i}].unit_cost`, { required: true }),
        name: str(it?.name, `items[${i}].name`),
        price: int(it?.price, `items[${i}].price`),
        gst_rate: rate(it?.gst_rate),
        low_stock: int(it?.low_stock, `items[${i}].low_stock`, { max: 1e6 }),
      }));
      const supplier_id = int(body.supplier_id, 'supplier_id', { min: 1 }) ?? null;
      const supplier_name = str(body.supplier_name, 'supplier_name') ?? null;
      if (!supplier_id && !supplier_name) throw new HttpError(400, 'Choose a supplier');
      const paid = int(body.paid, 'paid') ?? 0;
      const payment_method = body.payment_method ?? 'cash';
      if (paid && !SUPPLIER_PAY.includes(payment_method)) {
        throw new HttpError(400, `payment_method must be one of ${SUPPLIER_PAY.join(', ')}`);
      }
      const purchase = store.createPurchase({
        supplier_id, supplier_name,
        supplier_phone: str(body.supplier_phone, 'supplier_phone', { max: 20 }) ?? null,
        invoice_no: str(body.invoice_no, 'invoice_no', { max: 64 }) ?? null,
        items, paid,
        payment_method: paid ? payment_method : null,
        note: str(body.note, 'note') ?? null,
        client_id: str(body.client_id, 'client_id', { max: 64 }) ?? null,
        created_at: clientTime(body.created_at),
      });
      return [purchase.duplicate ? 200 : 201, purchase];
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
          if (out?.[CSV]) {
            res.writeHead(200, {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="${out.filename}"`,
              'cache-control': 'no-store',
            });
            return res.end(out.body);
          }
          return Array.isArray(out) && typeof out[0] === 'number' ? send(res, out[0], out[1]) : send(res, 200, out);
        }
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (/UNIQUE constraint failed: products\.barcode/.test(err?.message)) {
        return send(res, 409, { error: 'Another product already uses this barcode' });
      }
      if (/UNIQUE constraint failed: suppliers\.phone/.test(err?.message)) {
        return send(res, 409, { error: 'Another supplier already uses this phone number' });
      }
      if (/UNIQUE constraint failed: customers\.phone/.test(err?.message)) {
        return send(res, 409, { error: 'Another customer already uses this phone number' });
      }
      console.error(err);
      send(res, 500, { error: 'Something went wrong' });
    }
  };
}

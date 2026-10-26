// HTTP layer: a small JSON API plus static hosting for the mobile web app in /public.
// Amounts in the API are integer paise (₹1 = 100).
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { HttpError, GST_RATES, UQC, hsnValid } from './db.js';
import { gstDate } from '../public/gst.js';
import { currentUser, requestContext } from './context.js';

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
  if (!GST_RATES.includes(v)) throw new HttpError(400, `gst_rate must be one of ${GST_RATES.join(', ')}`);
  return v;
}

function hsn(v, field = 'hsn') {
  const s = str(v === undefined || v === null ? v : String(v), field, { max: 8 });
  if (s !== undefined && !hsnValid(s)) throw new HttpError(400, `${field} must be 4, 6 or 8 digits`);
  return s;
}

function unit(v, field = 'unit') {
  if (v === undefined || v === null || v === '') return undefined;
  if (!UQC[v]) throw new HttpError(400, `${field} must be one of ${Object.keys(UQC).join(', ')}`);
  return v;
}

const bool = (v, field) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return v;
};

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

// GSTR-1 tables in the GST offline tool's CSV layout. Amounts in rupees, dates dd-Mon-yyyy.
const rateCol = (r) => String(r.rate);
const HSN_CSV = {
  header: ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount',
    'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'],
  row: (r) => [r.hsn, r.description, r.uqc, r.quantity, money(r.value), rateCol(r), money(r.taxable), money(r.igst),
    money(r.cgst), money(r.sgst), '0.00'],
};
const GSTR1_CSV = {
  b2b: {
    header: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply',
      'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
    row: (r) => [r.gstin, r.receiver_name, r.invoice_no, gstDate(r.invoice_date), money(r.invoice_value), r.place_of_supply,
      r.reverse_charge, '', r.invoice_type, '', rateCol(r), money(r.taxable), '0.00'],
  },
  b2cl: {
    header: ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate',
      'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    row: (r) => [r.invoice_no, gstDate(r.invoice_date), money(r.invoice_value), r.place_of_supply, '', rateCol(r), money(r.taxable), '0.00', ''],
  },
  b2cs: {
    header: ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    row: (r) => [r.type, r.place_of_supply, '', rateCol(r), money(r.taxable), '0.00', ''],
  },
  cdnr: {
    header: ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge',
      'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
    row: (r) => [r.gstin, r.receiver_name, r.note_no, gstDate(r.note_date), r.note_type, r.place_of_supply, r.reverse_charge,
      r.supply_type, money(r.note_value), '', rateCol(r), money(r.taxable), '0.00'],
  },
  cdnur: {
    header: ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate',
      'Rate', 'Taxable Value', 'Cess Amount'],
    row: (r) => [r.ur_type, r.note_no, gstDate(r.note_date), r.note_type, r.place_of_supply, money(r.note_value), '', rateCol(r), money(r.taxable), '0.00'],
  },
  hsn_b2b: HSN_CSV,
  hsn_b2c: HSN_CSV,
  docs: {
    header: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
    row: (r) => [r.nature, r.from, r.to, r.total, r.cancelled],
  },
};
const STREAMED = Symbol('streamed'); // the route already wrote the response

const isCashier = () => currentUser()?.role === 'cashier';

const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

// PINs are 4–12 digits; owners need at least 6, as an owner login can see and change everything.
function userFields(body, { partial, role }) {
  const out = {
    name: str(body.name, 'name', { required: !partial, max: 60 }),
    username: partial ? str(body.username, 'username') : str(body.username, 'username', { required: true, max: 30 })?.toLowerCase(),
    role: body.role === undefined && partial ? undefined : body.role ?? role,
    pin: body.pin === undefined && partial ? undefined : str(body.pin, 'pin', { required: true, max: 12 }),
  };
  if (out.username !== undefined && !/^[a-z0-9._-]{2,30}$/.test(out.username)) {
    throw new HttpError(400, 'Username: 2–30 letters, digits, dots, dashes or underscores');
  }
  if (out.role !== undefined && !['owner', 'cashier'].includes(out.role)) throw new HttpError(400, 'role must be owner or cashier');
  if (out.pin !== undefined) {
    const min = (out.role ?? role) === 'owner' ? 6 : 4;
    if (!new RegExp(`^\\d{${min},12}$`).test(out.pin)) throw new HttpError(400, `PIN must be ${min}–12 digits`);
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// What a cashier may do: bill, take udhaar and payments, add customers, restock existing products,
// see their own bills, and take returns within the owner's limits. Everything else (prices and
// costs, purchases, suppliers, reports, settings, users, backups) is the owner's. Anything not
// listed is refused.
const CASHIER_ALLOWED = [
  ['GET', /^\/api\/settings$/],
  ['GET', /^\/api\/products$/],
  ['GET', /^\/api\/products\/barcode\/.+$/],
  ['GET', /^\/api\/products\/\d+$/],
  ['POST', /^\/api\/stock-in$/],
  ['GET', /^\/api\/customers$/],
  ['POST', /^\/api\/customers$/],
  ['GET', /^\/api\/customers\/\d+$/],
  ['POST', /^\/api\/customers\/\d+\/payments$/],
  ['POST', /^\/api\/sales$/],
  ['GET', /^\/api\/sales$/],
  ['GET', /^\/api\/sales\/\d+$/],
  ['GET', /^\/api\/sales\/by-number\/.+$/],
  ['GET', /^\/api\/summary$/],
  ['POST', /^\/api\/devices$/],
  ['GET', /^\/api\/devices\/\d+$/],
  ['POST', /^\/api\/documents\/void$/],
  // Returns, within the owner's limits (checked when the return is saved).
  ['POST', /^\/api\/sale-returns$/],
];
const PUBLIC = [
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/auth\/status$/],
  ['POST', /^\/api\/auth\/login$/],
  ['POST', /^\/api\/auth\/setup$/],
];
const ANY_USER = [['POST', /^\/api\/auth\/logout$/]];
const listed = (list, method, path) => list.some(([m, re]) => m === method && re.test(path));

// Cost prices (and so margins) are the owner's business.
const HIDDEN_FROM_CASHIERS = new Set(['cost', 'unit_cost']);
function stripCosts(value) {
  if (Array.isArray(value)) return value.map(stripCosts);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !HIDDEN_FROM_CASHIERS.has(k)).map(([k, v]) => [k, stripCosts(v)]));
  }
  return value;
}

function productFields(body, { partial }) {
  const fields = {
    barcode: str(body.barcode, 'barcode', { required: !partial, max: 64 }),
    name: str(body.name, 'name', { required: !partial }),
    price: int(body.price, 'price', { required: !partial }),
    cost: int(body.cost, 'cost'),
    gst_rate: rate(body.gst_rate),
    low_stock: int(body.low_stock, 'low_stock', { max: 1e6 }),
    hsn: body.hsn === '' && partial ? null : hsn(body.hsn),
    unit: unit(body.unit),
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
  // A bill with what can still be returned from it. Cashiers open their own bills — or any bill,
  // to take a return, when the owner allows cashier returns.
  const saleDetail = (sale) => {
    if (!sale) throw new HttpError(404, 'Bill not found');
    if (isCashier() && sale.user_id !== currentUser().id && !store.getShop().cashier_return_limit) {
      throw new HttpError(403, 'You can only open bills you made');
    }
    sale.returnable = store.returnableFromSale(sale.id);
    sale.returns = store.listSaleReturns({ saleId: sale.id });
    return sale;
  };

  return [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],

    // Public: whether logins are set up, and who this token belongs to.
    ['GET', /^\/api\/auth\/status$/, () => ({ setup_required: !store.hasUsers(), user: currentUser() })],

    // First run only: create the owner login. { name, username, pin, device_id? }
    ['POST', /^\/api\/auth\/setup$/, async (req) => {
      const body = await readJson(req);
      const fields = userFields(body, { partial: false, role: 'owner' });
      return store.transaction(() => {
        if (store.hasUsers()) throw new HttpError(409, 'Logins are already set up — sign in instead');
        store.createUser({ ...fields, role: 'owner' });
        return [201, store.login(fields.username, fields.pin, int(body.device_id, 'device_id', { min: 1 }) ?? null)];
      });
    }],

    // { username, pin, device_id? } → { token, user }
    ['POST', /^\/api\/auth\/login$/, async (req) => {
      const body = await readJson(req);
      const result = store.login(
        str(body.username, 'username', { required: true, max: 30 }),
        str(body.pin, 'pin', { required: true, max: 12 }),
        int(body.device_id, 'device_id', { min: 1 }) ?? null,
      );
      if (result.failed) {
        throw new HttpError(result.locked ? 429 : 401, result.locked
          ? 'Too many wrong PINs. Try again in 15 minutes, or ask the owner to reset your PIN.'
          : 'Wrong username or PIN');
      }
      return result;
    }],

    ['POST', /^\/api\/auth\/logout$/, (req) => {
      store.logout(bearer(req));
      return { ok: true };
    }],

    ['GET', /^\/api\/users$/, () => store.listUsers()],

    // { name, username, role: owner | cashier, pin }
    ['POST', /^\/api\/users$/, async (req) => {
      const fields = userFields(await readJson(req), { partial: false, role: 'cashier' });
      return [201, store.createUser(fields)];
    }],

    // { name?, role?, pin?, active? } — a new PIN or deactivation signs the person out everywhere.
    ['PATCH', /^\/api\/users\/(\d+)$/, async (req, m) => {
      const body = await readJson(req);
      const target = store.getUser(Number(m[1]));
      if (!target) throw new HttpError(404, 'User not found');
      const fields = userFields(body, { partial: true, role: body.role ?? target.role });
      if ('username' in fields) throw new HttpError(400, 'Usernames cannot be changed');
      return store.updateUser(target.id, { ...fields, active: bool(body.active, 'active') });
    }],

    ['GET', /^\/api\/summary$/, (_req, _m, url) => {
      const since = url.searchParams.get('since') ?? new Date().toISOString().slice(0, 10) + ' 00:00:00';
      return isCashier() ? store.cashierSummary(since, currentUser().id) : store.summary(since);
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
        if (isCashier()) throw new HttpError(403, 'Only the owner can add a new product. You can restock existing ones.');
        const product = store.createProduct(productFields({ ...body, barcode, quantity }, { partial: false }), clientId);
        return [201, { created: true, product }];
      });
    }],

    ['GET', /^\/api\/customers$/, (_req, _m, url) =>
      store.listCustomers({ q: url.searchParams.get('q'), dueOnly: url.searchParams.get('due') === '1' })],

    // { name, phone?, opening_balance? } — opening_balance carries over dues from a paper khata.
    ['POST', /^\/api\/customers$/, async (req) => {
      const body = await readJson(req);
      const opening_balance = int(body.opening_balance, 'opening_balance') ?? 0;
      if (opening_balance && isCashier()) throw new HttpError(403, 'Only the owner can enter an opening balance');
      return [201, store.createCustomer({
        name: str(body.name, 'name', { required: true }),
        phone: str(body.phone, 'phone', { max: 20 }) ?? null,
        opening_balance,
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
        hsn: hsn(it?.hsn, `items[${i}].hsn`),
        unit: unit(it?.unit, `items[${i}].unit`),
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

    // Cashiers see only the bills they made.
    ['GET', /^\/api\/sales$/, (_req, _m, url) =>
      store.listSales({
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: Math.min(Number(url.searchParams.get('limit')) || 50, 500),
        userId: isCashier() ? currentUser().id : undefined,
      })],

    ['GET', /^\/api\/sales\/(\d+)$/, (_req, m) => saleDetail(store.getSale(Number(m[1])))],

    // Find a bill by the number on the customer's receipt (invoice number, or bill id).
    ['GET', /^\/api\/sales\/by-number\/(.+)$/, (_req, m) => {
      const number = decodeURIComponent(m[1]).trim();
      const sale = store.getSaleByNumber(number) ?? (/^#?\d+$/.test(number) ? store.getSale(Number(number.replace('#', ''))) : null);
      return saleDetail(sale);
    }],

    ['GET', /^\/api\/sale-returns$/, (_req, _m, url) =>
      store.listSaleReturns({
        saleId: Number(url.searchParams.get('sale_id')) || undefined,
        limit: Math.min(Number(url.searchParams.get('limit')) || 50, 500),
      })],

    ['GET', /^\/api\/sale-returns\/(\d+)$/, (_req, m) => {
      const r = store.getSaleReturn(Number(m[1]));
      if (!r) throw new HttpError(404, 'Return not found');
      return r;
    }],

    // Customer brings goods back: { sale_id?, items: [{ barcode, quantity }],
    //   refund_method?: cash | upi | card | khata, restock? (false = damaged), reason?,
    //   customer_id? | customer_name + customer_phone? (for khata without a bill), client_id?, created_at? }
    ['POST', /^\/api\/sale-returns$/, async (req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'Add at least one item');
      if (body.items.length > 500) throw new HttpError(400, 'Too many items');
      const items = body.items.map((it, i) => ({
        barcode: str(it?.barcode, `items[${i}].barcode`, { required: true, max: 64 }),
        quantity: int(it?.quantity, `items[${i}].quantity`, { required: true, min: 1, max: 1e6 }),
      }));
      const refund_method = body.refund_method ?? 'cash';
      if (!['cash', 'upi', 'card', 'khata'].includes(refund_method)) {
        throw new HttpError(400, 'refund_method must be cash, upi, card or khata');
      }
      if (body.restock !== undefined && typeof body.restock !== 'boolean') throw new HttpError(400, 'restock must be true or false');
      const r = store.createSaleReturn({
        sale_id: int(body.sale_id, 'sale_id', { min: 1 }) ?? null,
        items, refund_method,
        restock: body.restock ?? true,
        reason: str(body.reason, 'reason') ?? null,
        customer_id: int(body.customer_id, 'customer_id', { min: 1 }) ?? null,
        customer_name: str(body.customer_name, 'customer_name') ?? null,
        customer_phone: str(body.customer_phone, 'customer_phone', { max: 20 }) ?? null,
        client_id: str(body.client_id, 'client_id', { max: 64 }) ?? null,
        created_at: clientTime(body.created_at),
        note_no: str(body.note_no, 'note_no', { max: 16 }) ?? null,
      });
      return [r.duplicate ? 200 : 201, r];
    }],

    // GSTR-1 for a month: ?month=2026-10. &section=b2b|b2cl|b2cs|cdnr|cdnur|hsn_b2b|hsn_b2c|docs&format=csv
    // gives that table in the column layout of the GST offline tool.
    ['GET', /^\/api\/reports\/gstr1$/, (_req, _m, url) => {
      const report = store.gstr1(url.searchParams.get('month') ?? '');
      if (url.searchParams.get('format') !== 'csv') return report;
      const section = url.searchParams.get('section');
      const layout = GSTR1_CSV[section];
      if (!layout) throw new HttpError(400, `section must be one of ${Object.keys(GSTR1_CSV).join(', ')}`);
      return csv(`gstr1_${report.month}_${section}.csv`, [layout.header, ...report[section].map(layout.row)]);
    }],

    ['GET', /^\/api\/settings$/, () => store.getShop()],

    // Shop profile printed on invoices: { legal_name, trade_name, address, gstin, phone, email,
    //   gst_registered, hsn_digits: 4 | 6, tz_offset, invoice_terms }
    ['PUT', /^\/api\/settings$/, async (req) => {
      const body = await readJson(req);
      const fields = {
        legal_name: str(body.legal_name, 'legal_name'),
        trade_name: str(body.trade_name, 'trade_name'),
        address: str(body.address, 'address', { max: 300 }),
        gstin: str(body.gstin, 'gstin', { max: 15 }),
        state_code: str(body.state_code, 'state_code', { max: 2 }),
        phone: str(body.phone, 'phone', { max: 20 }),
        email: str(body.email, 'email', { max: 100 }),
        gst_registered: bool(body.gst_registered, 'gst_registered'),
        hsn_digits: int(body.hsn_digits, 'hsn_digits', { min: 4, max: 6 }),
        tz_offset: int(body.tz_offset, 'tz_offset', { min: -720, max: 840 }),
        invoice_terms: str(body.invoice_terms, 'invoice_terms', { max: 300 }),
        cashier_return_limit: int(body.cashier_return_limit, 'cashier_return_limit', { max: 1e9 }),
        cashier_return_daily_limit: int(body.cashier_return_daily_limit, 'cashier_return_daily_limit', { max: 1e10 }),
        cashier_return_days: int(body.cashier_return_days, 'cashier_return_days', { min: 0, max: 365 }),
      };
      // Allow clearing text fields with an empty string.
      for (const k of ['trade_name', 'phone', 'email', 'invoice_terms', 'gstin']) if (body[k] === '') fields[k] = '';
      return store.updateShop(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    }],

    // A phone or browser asks for its own invoice series: { name? }
    ['POST', /^\/api\/devices$/, async (req) => {
      const body = await readJson(req);
      return [201, store.registerDevice(str(body.name, 'name', { max: 60 }) ?? null)];
    }],

    ['GET', /^\/api\/devices\/(\d+)$/, (_req, m) => {
      const d = store.getDevice(Number(m[1]));
      if (!d) throw new HttpError(404, 'Device not found');
      return d;
    }],

    // A number a device allocated but will never issue: { number, reason? }
    ['POST', /^\/api\/documents\/void$/, async (req) => {
      const body = await readJson(req);
      return [201, store.voidNumber(str(body.number, 'number', { required: true, max: 16 }), str(body.reason, 'reason') ?? null)];
    }],

    ['GET', /^\/api\/audit-log$/, (_req, _m, url) =>
      store.listAudit({ entity: url.searchParams.get('entity') ?? undefined, limit: Math.min(Number(url.searchParams.get('limit')) || 100, 1000) })],

    // A full copy of the database, for safe keeping (Rule 57).
    ['GET', /^\/api\/backup$/, async (_req, _m, _url, res) => {
      const dir = await mkdtemp(join(tmpdir(), 'hisaab-backup-'));
      const file = join(dir, 'hisaab.db');
      store.backupTo(file);
      const name = `hisaab-backup-${new Date().toISOString().slice(0, 10)}.db`;
      res.writeHead(200, {
        'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      });
      await new Promise((resolve, reject) => createReadStream(file).on('error', reject).on('end', resolve).pipe(res));
      await rm(dir, { recursive: true, force: true });
      return STREAMED;
    }],

    // Gross profit for a period: ?from=&to= (UTC, default this month), &tz=330 (minutes east of UTC,
    // for grouping by local day). &format=csv downloads per-product rows; add &by=day for daily rows.
    ['GET', /^\/api\/reports\/profit$/, (_req, _m, url) => {
      const tz = Number(url.searchParams.get('tz') ?? 0);
      if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) throw new HttpError(400, 'tz must be minutes from UTC, e.g. 330');
      const report = store.profitReport({ ...period(url), tzOffset: tz });
      if (url.searchParams.get('format') !== 'csv') return report;
      const pct = (v) => (v === null ? '' : v.toFixed(1));
      if (url.searchParams.get('by') === 'day') {
        return csv(`profit-by-day_${periodTag(report)}.csv`, [
          ['Date', 'Units sold', 'Sales', 'Returns', 'Net sales', 'Cost of goods', 'Gross profit', 'Margin %', 'GST in sales'],
          ...report.by_day.map((d) => [d.day, d.qty_sold, money(d.gross_sales), money(d.returns), money(d.net_sales),
            money(d.cogs), money(d.gross_profit), pct(d.margin_pct), money(d.tax)]),
        ]);
      }
      const t = report.summary;
      return csv(`profit-by-product_${periodTag(report)}.csv`, [
        ['Product', 'Barcode', 'Units sold', 'Units returned', 'Sales', 'Returns', 'Net sales', 'Cost of goods', 'Gross profit', 'Margin %', 'GST in sales', 'Cost price missing'],
        ...report.by_product.map((p) => [p.name, p.barcode, p.qty_sold, p.qty_returned, money(p.gross_sales), money(p.returns),
          money(p.net_sales), money(p.cogs), money(p.gross_profit), pct(p.margin_pct), money(p.tax), p.no_cost ? 'yes' : '']),
        ['Total', '', t.qty_sold, t.qty_returned, money(t.gross_sales), money(t.returns), money(t.net_sales), money(t.cogs),
          money(t.gross_profit), pct(t.margin_pct), money(t.tax), t.products_without_cost || ''],
      ]);
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
        const item = { product_id, barcode, quantity: int(it?.quantity, `items[${i}].quantity`, { required: true, min: 1, max: 1e6 }) };
        // An offline sale sends each line as printed on the customer's invoice.
        if (body.offline === true && it?.unit_price !== undefined) {
          Object.assign(item, {
            unit_price: int(it.unit_price, `items[${i}].unit_price`),
            gst_rate: rate(it.gst_rate) ?? 0,
            hsn: hsn(it.hsn, `items[${i}].hsn`) ?? null,
            unit: unit(it.unit, `items[${i}].unit`) ?? 'NOS',
          });
        }
        return item;
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
        invoice_no: str(body.invoice_no, 'invoice_no', { max: 16 }) ?? null,
        buyer_gstin: str(body.buyer_gstin, 'buyer_gstin', { max: 15 }) ?? null,
        buyer_address: str(body.buyer_address, 'buyer_address', { max: 300 }) ?? null,
        place_of_supply: str(body.place_of_supply, 'place_of_supply', { max: 2 }) ?? null,
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
      // Logins: once an owner exists, every request needs a signed-in user, and cashiers only
      // reach the routes listed in CASHIER_ALLOWED. Before that the shop runs open, as it did.
      const user = store.userForToken(bearer(req));
      if (store.hasUsers() && !listed(PUBLIC, req.method, url.pathname)) {
        if (!user) throw Object.assign(new HttpError(401, 'Please sign in'), { extra: { login_required: true } });
        if (user.role === 'cashier' && !listed(CASHIER_ALLOWED, req.method, url.pathname) && !listed(ANY_USER, req.method, url.pathname)) {
          throw new HttpError(403, 'Only the owner can do this');
        }
      }
      for (const [method, pattern, fn] of table) {
        const m = url.pathname.match(pattern);
        if (m && req.method === method) {
          let out = await requestContext.run({ user }, () => fn(req, m, url, res));
          if (out === STREAMED) return;
          if (user?.role === 'cashier') out = stripCosts(out);
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
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
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

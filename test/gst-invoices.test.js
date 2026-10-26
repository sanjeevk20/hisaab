import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';
import { gstinValid, amountInWords, splitTax } from '../public/gst.js';

// A valid GSTIN for a made-up PAN: computes the check character.
function gstin(state, pan) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const body = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(body[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return body + chars[(36 - (sum % 36)) % 36];
}
const SHOP = gstin('29', 'ABCDE1234F');      // Karnataka
const BUYER_KA = gstin('29', 'PQRST5678K');
const BUYER_MH = gstin('27', 'LMNOP4321Q');  // Maharashtra

let server, base;

before(async () => {
  server = createServer(createHandler(openDb(':memory:')));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  await call('/stock-in', 'POST', { barcode: 'TEA', quantity: 100, name: 'Tea 500g', price: 10000, cost: 8000, gst_rate: 5, hsn: '0902', unit: 'PAC' });
  await call('/stock-in', 'POST', { barcode: 'SOAP', quantity: 100, name: 'Soap', price: 5900, cost: 4000, gst_rate: 18, hsn: '3401', unit: 'NOS' });
  await call('/stock-in', 'POST', { barcode: 'TV', quantity: 5, name: 'Television', price: 6000000, cost: 5000000, gst_rate: 18, hsn: '8528' });
  await call('/stock-in', 'POST', { barcode: 'LOOSE', quantity: 100, name: 'Loose item', price: 1000, gst_rate: 5 });
});
after(() => server.close());

async function call(path, method = 'GET', body) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

const total = (x) => x.taxable + x.cgst + x.sgst + x.igst;

test('GSTIN check digit', () => {
  assert.ok(gstinValid('27AAPFU0939F1ZV'), 'sample GSTIN from the GSTN documentation');
  assert.ok(!gstinValid('27AAPFU0939F1ZW'));
  assert.ok(!gstinValid('99AAPFU0939F1ZV'), 'unknown state');
  assert.ok(gstinValid(SHOP) && gstinValid(BUYER_MH));
});

test('amount in words, Indian numbering', () => {
  assert.equal(amountInWords(12345678950), 'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Fifty Paise Only');
  assert.equal(amountInWords(10000), 'Rupees One Hundred Only');
});

test('tax split always adds up to what was charged', () => {
  const lines = [{ amount: 333, rate: 18 }, { amount: 333, rate: 5 }, { amount: 335, rate: 40 }];
  for (const inter of [false, true]) {
    const split = splitTax(lines, 101, inter);
    assert.equal(split.reduce((s, x) => s + total(x), 0), 1001 - 101);
  }
});

test('shop registration is validated and logged', async () => {
  assert.equal((await call('/settings', 'PUT', { gstin: '29ABCDE1234F1ZX', gst_registered: true })).status, 400);
  assert.equal((await call('/settings', 'PUT', { gstin: SHOP, gst_registered: true })).status, 400, 'needs legal name and address');
  const r = await call('/settings', 'PUT', {
    gstin: SHOP.toLowerCase(), gst_registered: true, legal_name: 'Sharma General Stores', trade_name: 'Sharma Stores',
    address: '12 MG Road, Bengaluru 560001',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.gstin, SHOP, 'stored upper-case');
  assert.equal(r.body.state_code, '29', 'state from the GSTIN');
  const log = (await call('/audit-log?entity=settings')).body;
  assert.deepEqual(log[0].changes.gst_registered, [false, true]);
});

test('B2C intra-state tax invoice: FY-wise number, CGST + SGST per line', async () => {
  const r = await call('/sales', 'POST', {
    items: [{ barcode: 'TEA', quantity: 2 }, { barcode: 'SOAP', quantity: 1 }], discount: 1000, created_at: '2026-10-10T05:00:00Z',
  });
  assert.equal(r.status, 201);
  const s = r.body;
  assert.equal(s.invoice_no, '0/26-27/00001');
  assert.equal(s.place_of_supply, '29');
  assert.equal(s.inter_state, 0);
  assert.equal(s.igst, 0);
  assert.ok(s.cgst > 0 && Math.abs(s.cgst - s.sgst) <= 1);
  assert.equal(total(s), s.total);
  assert.equal(s.items.reduce((t, i) => t + total(i), 0), s.total, 'lines add up to the invoice');
  assert.deepEqual(s.items.map((i) => [i.hsn, i.unit]), [['0902', 'PAC'], ['3401', 'NOS']]);
  assert.equal((await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }], created_at: '2026-10-10T06:00:00Z' })).body.invoice_no, '0/26-27/00002');
});

test('numbering restarts on 1 April in Indian time', async () => {
  // 31 March 2027 19:00 UTC is 1 April 00:30 in India.
  const r = await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }], created_at: '2026-03-31T18:00:00Z' });
  assert.equal(r.body.invoice_no, '0/25-26/00001', '31 March 23:30 IST is still FY 25-26');
  const next = await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }], created_at: '2026-03-31T19:00:00Z' });
  assert.match(next.body.invoice_no, /^0\/26-27\//, '1 April 00:30 IST is FY 26-27');
});

test('B2B inter-state invoice: IGST, buyer details and HSN required', async () => {
  const base = { items: [{ barcode: 'SOAP', quantity: 10 }], buyer_gstin: BUYER_MH, customer_name: 'Patil Traders', place_of_supply: '27' };
  assert.equal((await call('/sales', 'POST', base)).status, 400, 'needs address');
  assert.equal((await call('/sales', 'POST', { ...base, buyer_address: 'Pune', buyer_gstin: '27LMNOP4321Q1Z0' })).status, 400, 'bad GSTIN');
  assert.equal((await call('/sales', 'POST', { ...base, buyer_address: 'Pune', buyer_gstin: SHOP })).status, 400, 'own GSTIN');
  const noHsn = await call('/sales', 'POST', { ...base, buyer_address: 'Pune', items: [{ barcode: 'LOOSE', quantity: 1 }] });
  assert.equal(noHsn.status, 400);
  assert.match(noHsn.body.error, /Loose item needs a 4-digit HSN code on a B2B invoice/);

  const r = await call('/sales', 'POST', { ...base, buyer_address: 'Shop 4, FC Road, Pune 411004' });
  assert.equal(r.status, 201);
  assert.equal(r.body.inter_state, 1);
  assert.equal(r.body.cgst + r.body.sgst, 0);
  assert.equal(r.body.igst, Math.round((59000 * 18) / 118));
  assert.equal(r.body.buyer_gstin, BUYER_MH);
  assert.equal(r.body.customer_name, 'Patil Traders');
});

test('B2B buyer in the same state is intra-state', async () => {
  const r = await call('/sales', 'POST', {
    items: [{ barcode: 'TEA', quantity: 1 }], buyer_gstin: BUYER_KA, customer_name: 'Rao & Sons', buyer_address: 'Mysuru',
  });
  assert.equal(r.body.inter_state, 0);
  assert.ok(r.body.cgst > 0);
});

test('B2C bill of ₹50,000 or more needs name and address', async () => {
  assert.equal((await call('/sales', 'POST', { items: [{ barcode: 'TV', quantity: 1 }] })).status, 400);
  const r = await call('/sales', 'POST', { items: [{ barcode: 'TV', quantity: 1 }], customer_name: 'Anita', buyer_address: 'Jayanagar' });
  assert.equal(r.status, 201);
});

test('only current GST rates; HSN format checked', async () => {
  assert.equal((await call('/stock-in', 'POST', { barcode: 'OLD12', quantity: 1, name: 'x', price: 100, gst_rate: 12 })).status, 400);
  assert.equal((await call('/stock-in', 'POST', { barcode: 'BADHSN', quantity: 1, name: 'x', price: 100, gst_rate: 5, hsn: '12' })).status, 400);
  assert.equal((await call('/stock-in', 'POST', { barcode: 'G40', quantity: 1, name: 'Pan masala', price: 1400, gst_rate: 40, hsn: '2106' })).status, 201);
});

test('device series: phones number invoices offline without clashes', async () => {
  const dev = (await call('/devices', 'POST', { name: 'Counter phone' })).body;
  assert.equal(dev.code, 'A');
  const sale = (invoice_no, extra = {}) => call('/sales', 'POST', {
    items: [{ barcode: 'TEA', quantity: 1 }], invoice_no, created_at: '2026-10-12T05:00:00Z', ...extra,
  });
  assert.equal((await sale('A/26-27/00001')).body.invoice_no, 'A/26-27/00001');
  assert.equal((await sale('A/26-27/00001')).status, 409, 'number already used');
  assert.equal((await sale('A/25-26/00002')).status, 400, 'wrong financial year');
  assert.equal((await sale('Q/26-27/00001')).status, 400, 'not a registered series');
  assert.equal((await sale('A-26-27-1')).status, 400, 'malformed');

  // A discarded offline bill: its number is voided and shows as cancelled, never reused.
  assert.equal((await call('/documents/void', 'POST', { number: 'A/26-27/00002', reason: 'Bill discarded' })).status, 201);
  assert.equal((await sale('A/26-27/00002')).status, 409);
  assert.equal((await call('/documents/void', 'POST', { number: 'A/26-27/00001' })).status, 409, 'issued numbers cannot be voided');

  const { body: d } = await call(`/devices/${dev.id}`);
  assert.deepEqual(d.counters, [{ doc: 'invoice', fy: '26-27', last: 2 }]);
  assert.equal((await call('/devices', 'POST', {})).body.code, 'B');
});

test('offline invoice is recorded exactly as printed, even if the price changed', async () => {
  const tea = (await call('/products/barcode/TEA')).body;
  await call(`/products/${tea.id}`, 'PATCH', { price: 11000 });
  const r = await call('/sales', 'POST', {
    offline: true, invoice_no: 'A/26-27/00003', created_at: '2026-10-12T06:00:00Z',
    items: [{ barcode: 'TEA', quantity: 1, unit_price: 10000, gst_rate: 5, hsn: '0902', unit: 'PAC' }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.items[0].unit_price, 10000);
  assert.equal(r.body.total, 10000);
  const log = (await call('/audit-log?entity=product')).body;
  assert.deepEqual(log[0].changes, { price: [10000, 11000] }, 'price change is in the audit log');
});

test('credit note: refers to the invoice, own series, reverses tax the same way', async () => {
  assert.equal((await call('/sale-returns', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }] })).status, 400, 'needs the invoice');
  const inv = (await call('/sales?limit=500')).body.find((s) => s.buyer_gstin === BUYER_MH);
  const r = await call('/sale-returns', 'POST', { sale_id: inv.id, items: [{ barcode: 'SOAP', quantity: 2 }], created_at: '2026-10-20T05:00:00Z' });
  assert.equal(r.status, 201);
  assert.equal(r.body.note_no, 'CN0/26-27/0001');
  assert.equal(r.body.invoice_no, inv.invoice_no);
  assert.equal(r.body.buyer_gstin, BUYER_MH);
  assert.equal(r.body.cgst + r.body.sgst, 0);
  assert.equal(r.body.igst, Math.round((11800 * 18) / 118));
  assert.equal(total(r.body), r.body.total);
  assert.deepEqual([r.body.items[0].hsn, r.body.items[0].unit], ['3401', 'NOS']);

  const dev = 'A';
  const cn = await call('/sale-returns', 'POST', {
    sale_id: inv.id, items: [{ barcode: 'SOAP', quantity: 1 }], note_no: `CN${dev}/26-27/0001`, created_at: '2026-10-20T06:00:00Z',
  });
  assert.equal(cn.body.note_no, 'CNA/26-27/0001');
  assert.equal((await call('/sale-returns', 'POST', {
    sale_id: inv.id, items: [{ barcode: 'SOAP', quantity: 1 }], note_no: 'A/26-27/00009',
  })).status, 400, 'an invoice number is not a credit note number');
});

test('credit note deadline: 30 November after the invoice’s financial year', async () => {
  // Invoice dated March 2025 (FY 24-25): credit notes allowed only until 30 Nov 2025.
  const old = (await call('/sales', 'POST', { items: [{ barcode: 'TEA', quantity: 1 }], created_at: '2025-03-10T05:00:00Z' })).body;
  const late = await call('/sale-returns', 'POST', { sale_id: old.id, items: [{ barcode: 'TEA', quantity: 1 }] });
  assert.equal(late.status, 400);
  assert.match(late.body.error, /30 Nov 2025/);
  const inTime = await call('/sale-returns', 'POST', { sale_id: old.id, items: [{ barcode: 'TEA', quantity: 1 }], created_at: '2025-11-30T10:00:00Z' });
  assert.equal(inTime.status, 201);
  assert.equal(inTime.body.note_no, 'CN0/25-26/0001', 'numbered in the credit note’s own financial year');
});

test('backup download is a complete SQLite database', async () => {
  const res = await fetch(base + '/api/backup');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /hisaab-backup-\d{4}-\d{2}-\d{2}\.db/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
});

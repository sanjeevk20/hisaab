import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

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
const BUYER_MH = gstin('27', 'LMNOP4321Q');

let server, base, report;
const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

async function call(path, method = 'GET', body) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}
const sale = async (body) => {
  const r = await call('/sales', 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  server = createServer(createHandler(openDb(':memory:')));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  await call('/settings', 'PUT', {
    gstin: gstin('29', 'ABCDE1234F'), gst_registered: true, legal_name: 'Sharma General Stores', address: 'Bengaluru',
  });
  await call('/stock-in', 'POST', { barcode: 'TEA', quantity: 100, name: 'Tea 500g', price: 10000, gst_rate: 5, hsn: '0902', unit: 'PAC' });
  await call('/stock-in', 'POST', { barcode: 'SOAP', quantity: 100, name: 'Soap', price: 5900, gst_rate: 18, hsn: '3401' });
  await call('/stock-in', 'POST', { barcode: 'TV', quantity: 5, name: 'Television', price: 12000000, gst_rate: 18, hsn: '8528' });

  // October 2026 in Indian time.
  const b2c = await sale({ items: [{ barcode: 'TEA', quantity: 2 }, { barcode: 'SOAP', quantity: 1 }], created_at: '2026-10-05T05:00:00Z' });
  const b2b = await sale({
    items: [{ barcode: 'SOAP', quantity: 10 }], buyer_gstin: BUYER_MH, customer_name: 'Patil Traders',
    buyer_address: 'Pune', place_of_supply: '27', created_at: '2026-10-10T05:00:00Z',
  });
  const b2cl = await sale({
    items: [{ barcode: 'TV', quantity: 1 }], customer_name: 'Anita', buyer_address: 'Mumbai', place_of_supply: '27',
    created_at: '2026-10-12T05:00:00Z',
  });
  await sale({ items: [{ barcode: 'SOAP', quantity: 1 }], place_of_supply: '27', created_at: '2026-10-13T05:00:00Z' });
  await sale({ items: [{ barcode: 'TEA', quantity: 1 }], created_at: '2026-09-30T19:00:00Z' }); // 1 Oct 00:30 IST — October
  await sale({ items: [{ barcode: 'TEA', quantity: 1 }], created_at: '2026-09-30T18:00:00Z' }); // 30 Sep 23:30 IST — not October

  // A device series with one number voided.
  await call('/devices', 'POST', {});
  await sale({ items: [{ barcode: 'TEA', quantity: 1 }], invoice_no: 'A/26-27/00001', created_at: '2026-10-14T05:00:00Z' });
  await call('/documents/void', 'POST', { number: 'A/26-27/00002', reason: 'Discarded offline bill' });
  await sale({ items: [{ barcode: 'TEA', quantity: 1 }], invoice_no: 'A/26-27/00003', created_at: '2026-10-15T05:00:00Z' });

  // Credit notes in October against a B2B, a B2CL and a small B2C invoice.
  for (const [id, barcode, quantity] of [[b2b.id, 'SOAP', 2], [b2cl.id, 'TV', 1], [b2c.id, 'SOAP', 1]]) {
    const r = await call('/sale-returns', 'POST', { sale_id: id, items: [{ barcode, quantity }], created_at: '2026-10-20T05:00:00Z' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  report = (await call('/reports/gstr1?month=2026-10')).body;
});
after(() => server.close());

test('month boundaries follow Indian time', () => {
  assert.equal(report.summary.invoices, 7, '1 Oct 00:30 IST included, 30 Sep 23:30 IST excluded');
  assert.equal(report.summary.credit_notes, 3);
});

test('B2B and B2CL are invoice-wise', () => {
  assert.equal(report.b2b.length, 1);
  const b = report.b2b[0];
  assert.equal(b.gstin, BUYER_MH);
  assert.equal(b.place_of_supply, '27-Maharashtra');
  assert.equal(b.rate, 18);
  assert.equal(b.invoice_value, 59000);
  assert.equal(b.igst, Math.round((59000 * 18) / 118));
  assert.equal(b.cgst + b.sgst, 0);

  assert.equal(report.b2cl.length, 1, 'inter-state B2C above ₹1 lakh');
  assert.equal(report.b2cl[0].invoice_value, 12000000);
});

test('B2CS is summed by place of supply and rate, net of credit notes', () => {
  const key = (r) => `${r.place_of_supply}@${r.rate}`;
  // Karnataka @18% is left out: the one soap sold there was returned, so it nets to zero.
  assert.deepEqual(report.b2cs.map(key), ['27-Maharashtra@18', '29-Karnataka@5']);
  const mh = report.b2cs.find((r) => key(r) === '27-Maharashtra@18');
  assert.ok(mh.igst > 0 && mh.cgst === 0, 'small inter-state B2C is IGST');
});

test('credit notes: CDNR for B2B, CDNUR for B2CL', () => {
  assert.equal(report.cdnr.length, 1);
  assert.equal(report.cdnr[0].gstin, BUYER_MH);
  assert.equal(report.cdnr[0].note_value, 11800);
  assert.match(report.cdnr[0].note_no, /^CN0\/26-27\/000\d$/);
  assert.equal(report.cdnur.length, 1);
  assert.equal(report.cdnur[0].ur_type, 'B2CL');
});

test('sections add up to the month’s tax liability', () => {
  const t = report.summary;
  for (const k of ['taxable', 'igst', 'cgst', 'sgst']) {
    const outward = sum(report.b2b, k) + sum(report.b2cl, k) + sum(report.b2cs, k) - sum(report.cdnr, k) - sum(report.cdnur, k);
    assert.equal(outward, t[k], `${k}: B2B + B2CL + B2CS − notes`);
    assert.equal(sum(report.hsn_b2b, k) + sum(report.hsn_b2c, k), t[k], `${k}: HSN summary`);
  }
  assert.equal(t.tax, t.igst + t.cgst + t.sgst);
});

test('HSN summary split B2B / B2C, net of returns', () => {
  assert.deepEqual(report.hsn_b2b.map((h) => [h.hsn, h.quantity, h.uqc]), [['3401', 8, 'NOS-NUMBERS']]);
  const tea = report.hsn_b2c.find((h) => h.hsn === '0902');
  assert.equal(tea.quantity, 2 + 1 + 1 + 1);
  assert.equal(tea.uqc, 'PAC-PACKS');
  assert.ok(!report.hsn_b2c.some((h) => h.hsn === '8528'), 'TV fully returned');
});

test('document summary counts voided and missing numbers as cancelled', () => {
  const inv = report.docs.filter((d) => d.nature === 'Invoices for outward supply');
  const a = inv.find((d) => d.from.startsWith('A/'));
  assert.deepEqual(a, { nature: 'Invoices for outward supply', from: 'A/26-27/00001', to: 'A/26-27/00003', total: 3, cancelled: 1 });
  const server0 = inv.find((d) => d.from.startsWith('0/'));
  assert.equal(server0.cancelled, 0);
  assert.equal(report.docs.find((d) => d.nature === 'Credit Note').total, 3);
});

test('CSV in the offline tool layout', async () => {
  const b2b = await call('/reports/gstr1?month=2026-10&section=b2b&format=csv');
  assert.match(b2b.headers.get('content-disposition'), /gstr1_2026-10_b2b\.csv/);
  const lines = b2b.body.trim().split('\r\n');
  assert.equal(lines[0], 'GSTIN/UIN of Recipient,Receiver Name,Invoice Number,Invoice date,Invoice Value,Place Of Supply,Reverse Charge,Applicable % of Tax Rate,Invoice Type,E-Commerce GSTIN,Rate,Taxable Value,Cess Amount');
  assert.match(lines[1], new RegExp(`^${BUYER_MH},Patil Traders,0/26-27/\\d{5},10-Oct-2026,590.00,27-Maharashtra,N,,Regular B2B,,18,500.00,0.00$`));
  for (const section of ['b2cl', 'b2cs', 'cdnr', 'cdnur', 'hsn_b2b', 'hsn_b2c', 'docs']) {
    assert.equal((await call(`/reports/gstr1?month=2026-10&section=${section}&format=csv`)).status, 200, section);
  }
  assert.equal((await call('/reports/gstr1?month=2026-10&section=nope&format=csv')).status, 400);
  assert.equal((await call('/reports/gstr1?month=Oct')).status, 400);
});

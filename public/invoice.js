// Printable tax invoice and credit note (Rules 46 and 53), plus the plain bill used when the shop
// is not GST-registered. Pure functions returning HTML; amounts are integer paise.
import { amountInWords, localDate, stateLabel } from './gst.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const rupees = (paise) => (paise < 0 ? '−₹' : '₹')
  + (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = (paise) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (ts, tz) => localDate(ts, tz).split('-').reverse().join('-');

// Tax by rate, for the summary under the items.
function taxSummary(items) {
  const rates = new Map();
  for (const i of items) {
    const r = rates.get(i.gst_rate) ?? rates.set(i.gst_rate, { rate: i.gst_rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }).get(i.gst_rate);
    for (const k of ['taxable', 'cgst', 'sgst', 'igst']) r[k] += i[k];
  }
  return [...rates.values()].sort((a, b) => a.rate - b.rate);
}

function partyBlock(title, { name, address, gstin, state }) {
  return `<div class="inv-party"><div class="inv-label">${title}</div>
    ${name ? `<strong>${esc(name)}</strong><br>` : ''}${address ? `${esc(address)}<br>` : ''}
    ${gstin ? `GSTIN: <strong>${esc(gstin)}</strong><br>` : ''}${state ? `State: ${esc(state)}` : ''}</div>`;
}

function itemsTable(items, inter) {
  const summary = taxSummary(items);
  const tax = (k) => summary.reduce((s, r) => s + r[k], 0);
  return `
    <table class="inv-items">
      <thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Taxable</th><th>GST</th><th>Amount</th></tr></thead>
      <tbody>${items.map((i, n) => `<tr>
        <td>${n + 1}</td><td>${esc(i.name)}</td><td>${esc(i.hsn ?? '')}</td><td>${i.quantity} ${esc(i.unit ?? 'NOS')}</td>
        <td>${amt(i.unit_price)}</td><td>${amt(i.taxable)}</td><td>${i.gst_rate}%</td><td>${amt(i.taxable + i.cgst + i.sgst + i.igst)}</td>
      </tr>`).join('')}</tbody>
    </table>
    <table class="inv-tax">
      <thead><tr><th>GST rate</th><th>Taxable value</th>${inter ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>'}</tr></thead>
      <tbody>${summary.map((r) => `<tr><td>${r.rate}%</td><td>${amt(r.taxable)}</td>${inter
        ? `<td>${amt(r.igst)}</td>`
        : `<td>${amt(r.cgst)} <span class="muted">@${r.rate / 2}%</span></td><td>${amt(r.sgst)} <span class="muted">@${r.rate / 2}%</span></td>`}</tr>`).join('')}
        <tr class="sep"><td><strong>Total</strong></td><td><strong>${amt(tax('taxable'))}</strong></td>${inter
          ? `<td><strong>${amt(tax('igst'))}</strong></td>`
          : `<td><strong>${amt(tax('cgst'))}</strong></td><td><strong>${amt(tax('sgst'))}</strong></td>`}</tr>
      </tbody>
    </table>`;
}

function supplierBlock(shop) {
  return `<div class="inv-head">
    <h3>${esc(shop.trade_name || shop.legal_name)}</h3>
    ${shop.trade_name && shop.legal_name && shop.trade_name !== shop.legal_name ? `<div>${esc(shop.legal_name)}</div>` : ''}
    <div>${esc(shop.address)}</div>
    <div>GSTIN: <strong>${esc(shop.gstin)}</strong> · State: ${esc(stateLabel(shop.state_code))}${shop.phone ? ` · Ph: ${esc(shop.phone)}` : ''}</div>
  </div>`;
}

const signature = (shop) => `<div class="inv-sign">For ${esc(shop.legal_name)}<br><br>Authorised signatory</div>`;

// sale: as returned by the server (or built the same way on a phone while offline).
export function taxInvoiceHtml(sale, shop, { pending = false } = {}) {
  const inter = Boolean(sale.inter_state);
  const pos = sale.place_of_supply ?? shop.state_code;
  return `<div class="receipt invoice">
    <div class="inv-title">TAX INVOICE${pending ? ' <span class="muted">(saved offline)</span>' : ''}</div>
    ${supplierBlock(shop)}
    <div class="inv-meta">
      <div>Invoice no: <strong>${esc(sale.invoice_no ?? '#' + sale.id)}</strong></div>
      <div>Date: <strong>${dmy(sale.created_at, shop.tz_offset)}</strong></div>
      <div>Place of supply: ${esc(stateLabel(pos))}</div>
      <div>Reverse charge: No</div>
    </div>
    ${sale.buyer_gstin || sale.customer_name || sale.buyer_address ? partyBlock('Bill to', {
      name: sale.customer_name, address: sale.buyer_address, gstin: sale.buyer_gstin,
      state: sale.buyer_gstin ? stateLabel(sale.buyer_gstin.slice(0, 2)) : null,
    }) : ''}
    ${itemsTable(sale.items, inter)}
    <table class="inv-totals">
      <tr><td>Items total</td><td>${rupees(sale.subtotal)}</td></tr>
      ${sale.discount ? `<tr><td>Discount</td><td>−${rupees(sale.discount)}</td></tr>` : ''}
      <tr class="sep"><td><strong>Invoice total</strong></td><td><strong>${rupees(sale.total)}</strong></td></tr>
    </table>
    <div class="inv-words">${amountInWords(sale.total)}</div>
    ${shop.invoice_terms ? `<div class="inv-terms">${esc(shop.invoice_terms)}</div>` : ''}
    ${signature(shop)}
  </div>`;
}

// note: a sale return as returned by the server (with invoice_no, invoice_date and buyer fields).
export function creditNoteHtml(note, shop, { pending = false } = {}) {
  const inter = note.items.some((i) => i.igst > 0) || Boolean(note.inter_state);
  return `<div class="receipt invoice">
    <div class="inv-title">CREDIT NOTE${pending ? ' <span class="muted">(saved offline)</span>' : ''}</div>
    ${supplierBlock(shop)}
    <div class="inv-meta">
      <div>Credit note no: <strong>${esc(note.note_no ?? '#' + note.id)}</strong></div>
      <div>Date: <strong>${dmy(note.created_at, shop.tz_offset)}</strong></div>
      <div>Against invoice: <strong>${esc(note.invoice_no ?? '')}</strong>${note.invoice_date ? ` dated ${dmy(note.invoice_date, shop.tz_offset)}` : ''}</div>
      <div>Place of supply: ${esc(stateLabel(note.place_of_supply ?? shop.state_code))}</div>
      ${note.reason ? `<div>Reason: ${esc(note.reason)}</div>` : ''}
    </div>
    ${note.buyer_gstin || note.buyer_name ? partyBlock('Issued to', {
      name: note.buyer_name, address: note.buyer_address, gstin: note.buyer_gstin,
      state: note.buyer_gstin ? stateLabel(note.buyer_gstin.slice(0, 2)) : null,
    }) : ''}
    ${itemsTable(note.items, inter)}
    <table class="inv-totals">
      <tr class="sep"><td><strong>Credit note value</strong></td><td><strong>${rupees(note.total)}</strong></td></tr>
    </table>
    <div class="inv-words">${amountInWords(note.total)}</div>
    ${signature(shop)}
  </div>`;
}

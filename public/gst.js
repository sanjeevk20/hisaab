// GST rules shared by the server and the app, so an invoice printed offline on a phone has
// exactly the same numbers the server records later. No DOM or Node APIs in here.

export const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
export const stateLabel = (code) => (STATES[code] ? `${code}-${STATES[code]}` : '');

// Rates in use after the September 2025 rationalisation (5% / 18% / 40%), plus the special
// rates for precious metals and stones, and 28% which still applies to some tobacco products.
export const GST_RATES = [0, 0.25, 3, 5, 18, 28, 40];

// Unit Quantity Codes as the GST portal names them.
export const UQC = {
  NOS: 'NUMBERS', PCS: 'PIECES', KGS: 'KILOGRAMS', GMS: 'GRAMMES', LTR: 'LITRES', MLT: 'MILILITRE', MTR: 'METERS',
  PAC: 'PACKS', BOX: 'BOX', BTL: 'BOTTLES', DOZ: 'DOZENS', SET: 'SETS', PRS: 'PAIRS', BAG: 'BAGS', ROL: 'ROLLS',
  TBS: 'TABLETS', CAN: 'CANS', OTH: 'OTHERS',
};

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Format plus the check digit in the 15th place.
export function gstinValid(gstin) {
  const g = String(gstin ?? '').toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) || !STATES[g.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

export const hsnValid = (hsn) => /^\d{4}(\d{2}){0,2}$/.test(String(hsn ?? ''));

// --- dates --------------------------------------------------------------

// Local calendar date ('YYYY-MM-DD') of a UTC SQLite timestamp, for a shop tzOffset minutes east of UTC.
export function localDate(sqlTs, tzOffset) {
  return new Date(Date.parse(sqlTs.replace(' ', 'T') + 'Z') + tzOffset * 60_000).toISOString().slice(0, 10);
}

// Financial year (1 April – 31 March) that a local date falls in: { start: 2026, short: '26-27' }.
export function financialYear(localYmd) {
  const [y, m] = localYmd.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return { start, short: `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-10-05' → '05-Oct-2026', the date format the GST offline tool expects.
export const gstDate = (ymd) => `${ymd.slice(8, 10)}-${MONTHS[Number(ymd.slice(5, 7)) - 1]}-${ymd.slice(0, 4)}`;

// --- document numbers ---------------------------------------------------
// Rule 46(b): consecutive, unique per financial year, at most 16 characters of letters, digits,
// '-' and '/'. Each device has its own series (allowed: "one or multiple series"), so phones can
// number invoices offline without clashing. 'A/26-27/00001', credit notes 'CNA/26-27/0001'.

export const invoiceNumber = (series, fy, seq) => `${series}/${fy}/${String(seq).padStart(5, '0')}`;
export const creditNoteNumber = (series, fy, seq) => `CN${series}/${fy}/${String(seq).padStart(4, '0')}`;

export function parseDocNumber(number) {
  const m = /^(CN)?([0-9A-Z]{1,3})\/(\d{2}-\d{2})\/(\d{4,5})$/.exec(String(number ?? ''));
  if (!m) return null;
  return { doc: m[1] ? 'credit_note' : 'invoice', series: m[2], fy: m[3], seq: Number(m[4]) };
}

// --- tax ----------------------------------------------------------------

// Split a bill into GST components. Prices are GST-inclusive. The bill discount is spread over the
// lines in proportion to their value (any leftover paisa goes to the last line), then each line's
// tax is taken out of what was actually charged. Intra-state supplies split tax into equal
// CGST and SGST; inter-state ones are IGST. All results are integer paise and add up exactly.
// lines: [{ amount, rate }] → [{ net, taxable, cgst, sgst, igst }]
export function splitTax(lines, discount, interState) {
  const gross = lines.reduce((s, l) => s + l.amount, 0);
  let given = 0;
  return lines.map((l, i) => {
    const share = i === lines.length - 1 ? discount - given : gross ? Math.round((discount * l.amount) / gross) : 0;
    given += share;
    return { net: l.amount - share, ...taxOf(l.amount - share, l.rate, interState) };
  });
}

// GST contained in a GST-inclusive amount.
export function taxOf(amount, rate, interState) {
  const tax = rate > 0 ? Math.round((amount * rate) / (100 + rate)) : 0;
  const cgst = interState ? 0 : Math.round(tax / 2);
  return { taxable: amount - tax, cgst, sgst: interState ? 0 : tax - cgst, igst: interState ? tax : 0 };
}

// --- invoice rules ------------------------------------------------------

// First reason a tax invoice can't be issued, or null. Used by the server and by the app before
// printing, so an offline bill is never rejected later. lines: [{ name, gst_rate, hsn }].
export function invoiceProblem(shop, lines, { buyer_gstin, customer_name, buyer_address, total }) {
  const b2b = Boolean(buyer_gstin);
  if (b2b) {
    if (!gstinValid(buyer_gstin)) return `Buyer GSTIN ${buyer_gstin} is not valid`;
    if (buyer_gstin.toUpperCase() === shop.gstin) return 'Buyer GSTIN is your own GSTIN';
    if (!customer_name || !buyer_address) return "A B2B invoice needs the buyer's legal name and address";
  } else if (total >= 50_000_00 && (!customer_name || !buyer_address)) {
    // Rule 46(e): unregistered buyer, value ₹50,000 or more.
    return "Bills of ₹50,000 or more need the customer's name and address";
  }
  for (const l of lines) {
    if (!GST_RATES.includes(l.gst_rate)) return `${l.name}: ${l.gst_rate}% is not a GST rate — update it in Inventory`;
    if (l.hsn && !hsnValid(l.hsn)) return `${l.name}: HSN ${l.hsn} should be 4, 6 or 8 digits`;
    // Notification 78/2020: HSN is required on B2B invoices (and on all invoices above ₹5 crore
    // turnover) with at least 4 or 6 digits.
    if ((b2b || shop.hsn_digits === 6) && (!l.hsn || l.hsn.length < shop.hsn_digits)) {
      return `${l.name} needs a ${shop.hsn_digits}-digit HSN code${b2b ? ' on a B2B invoice' : ''} — add it in Inventory`;
    }
  }
  return null;
}

// --- amount in words (Indian numbering) ---------------------------------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n) {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ' ' + ONES[r % 10] : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
}

function words(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  for (const [unit, size] of [['Crore', 1e7], ['Lakh', 1e5], ['Thousand', 1e3]]) {
    if (n >= size) {
      parts.push(`${unit === 'Crore' ? words(Math.floor(n / size)) : belowThousand(Math.floor(n / size))} ${unit}`);
      n %= size;
    }
  }
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

export function amountInWords(paise) {
  const rupees = Math.floor(paise / 100), p = paise % 100;
  return `Rupees ${words(rupees)}${p ? ` and ${words(p)} Paise` : ''} Only`;
}

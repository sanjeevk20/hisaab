import { Scanner, feedback } from './scanner.js';
import {
  kvGet, kvSet, newClientId, nowSql, saveCatalog, getCatalog, catalogFind, catalogUpsert, catalogChangeQty,
  enqueue, getOutbox, onOutboxChange, sync, discard, retry, clearPrivateCache,
} from './offline.js';
import {
  GST_RATES, STATES, UQC, creditNoteNumber, financialYear, gstinValid, invoiceNumber, invoiceProblem, isLoose, lineAmount,
  localDate, quantityProblem, round3, splitTax, stateLabel, taxOf,
} from './gst.js';
import { esc, rupees, taxInvoiceHtml, creditNoteHtml } from './invoice.js';

// --- helpers ------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const toPaise = (v) => Math.round((parseFloat(v) || 0) * 100);
// Loose goods (KGS, LTR, MTR) show their unit: "9.75 kg", "₹48.00/kg".
const UNIT_SHORT = { KGS: 'kg', LTR: 'L', MTR: 'm' };
const fmtQty = (q, unit) => (isLoose(unit) ? `${q} ${UNIT_SHORT[unit]}` : String(q));
const perUnit = (unit) => (isLoose(unit) ? `/${UNIT_SHORT[unit]}` : '');
const readQty = (v) => round3(parseFloat(v) || 0);
// SQLite stores UTC 'YYYY-MM-DD HH:MM:SS'; show it in local time.
const localTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const digits = (s) => String(s ?? '').replace(/\D/g, '').replace(/^91(\d{10})$/, '$1');
const PAY_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Udhaar', bank: 'Bank', cheque: 'Cheque' };
const OFFLINE_NOTE = '<p class="notice">Offline — showing the copy saved on this phone.</p>';

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 4000 : 2500);
}

// --- signing in ---------------------------------------------------------

// The signed-in person. While the shop has no logins set up there is nobody (and everyone can
// do everything, as before); after that the server decides what each role may do, and the app
// just hides what a cashier can't use.
let me = null;
let loginsOn = false;
const isOwner = () => !me || me.role === 'owner';
// Cashiers take returns only when the owner has set a limit for them.
const canReturn = () => isOwner() || shop.cashier_return_limit > 0;
const authHeader = () => {
  const token = localStorage.getItem('hisaab.token');
  return token ? { authorization: `Bearer ${token}` } : {};
};

function showLogin(message = '') {
  $('#login-shop').textContent = shopName();
  $('#login-error').textContent = message;
  $('#login-error').classList.toggle('hidden', !message);
  $('#login-screen').classList.remove('hidden');
  if (modal.open) modal.close();
  stopAllScanners();
  setTimeout(() => $('#login-form').username.focus(), 50);
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const { token, user } = await api('/auth/login', {
      method: 'POST',
      body: { username: f.username.value.trim(), pin: f.pin.value, device_id: (await kvGet('device'))?.id },
    });
    await signedIn(token, user);
    f.reset();
  } catch (err) {
    $('#login-error').textContent = err.offline ? 'Signing in needs internet' : err.message;
    $('#login-error').classList.remove('hidden');
    f.pin.value = '';
  }
};

async function signedIn(token, user) {
  localStorage.setItem('hisaab.token', token);
  me = user;
  loginsOn = true;
  await kvSet('me', me);
  await kvSet('logins-on', true);
  $('#login-screen').classList.add('hidden');
  applyRole();
  await start();
  toast(`Signed in as ${me.name}`);
}

function applyRole() {
  document.body.dataset.role = isOwner() ? 'owner' : 'cashier';
  $('#bill-mode').classList.toggle('hidden', !canReturn());
  if (!canReturn() && billMode === 'return') setBillMode('sale');
  $('#shop-status').textContent = `${shopName()}${me ? ' · ' + me.name : ''}`;
  if (!isOwner()) {
    // Leave any owner-only screen a cashier can't use.
    reportSide = 'sales';
    khataSide = 'customer';
    if (inPurchase()) purchase = emptyPurchase();
    renderPurchase();
    refreshCurrentView();
  }
}

// Before someone else signs in, everything this person did offline must reach the server under
// their own name, and their cached data is wiped from the phone.
async function signOut() {
  if ((await getOutbox()).some((e) => !e.error)) await trySync();
  const waiting = (await getOutbox()).filter((e) => !e.error).length;
  if (waiting) return toast(`${waiting} entr${waiting === 1 ? 'y has' : 'ies have'} not synced yet — connect to the internet before switching user`, true);
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('hisaab.token');
  me = null;
  await kvSet('me', null);
  await clearPrivateCache();
  cart.clear();
  resetBill();
  resetReturn();
  purchase = emptyPurchase();
  renderPurchase();
  showView('bill');
  showLogin();
}

// --- shop profile & invoice series --------------------------------------

// The shop profile printed on invoices (from the server, kept for offline use).
let shop = { gst_registered: false, state_code: '', tz_offset: 330, hsn_digits: 4 };
const shopName = () => shop.trade_name || shop.legal_name || localStorage.getItem('hisaab.shop') || 'My Shop';
const gstOn = () => Boolean(shop.gst_registered);

async function loadShop() {
  const { data } = await cachedGet('/settings').catch(() => ({ data: null }));
  if (data) shop = data;
  $('#shop-status').textContent = `${shopName()}${me ? ' · ' + me.name : ''}`;
  $('#tax-details').classList.toggle('hidden', !gstOn());
  $('#bill-mode').classList.toggle('hidden', !canReturn());
  $('#place-of-supply').value = shop.state_code;
}

// Each device numbers its own invoices and credit notes (see gst.js), so it can issue them
// offline. The series is registered once while online.
async function ensureDevice() {
  let device = await kvGet('device');
  try {
    if (!device) {
      const d = await api('/devices', { method: 'POST', body: { name: navigator.userAgent.slice(0, 60) } });
      device = { id: d.id, code: d.code };
      await kvSet('device', device);
    }
    // Carry on from the server's count, in case this phone's storage was cleared.
    for (const c of (await api(`/devices/${device.id}`)).counters) {
      const key = `seq:${c.doc}:${c.fy}`;
      if (((await kvGet(key)) ?? 0) < c.last) await kvSet(key, c.last);
    }
  } catch { /* offline: carry on with what this phone has */ }
  return device;
}

// Next number from this device's series, for a document dated now.
async function allocateNumber(doc) {
  const device = await kvGet('device');
  if (!device) throw new Error('Connect to the internet once so this phone gets its own invoice series');
  const fy = financialYear(localDate(nowSql(), shop.tz_offset)).short;
  const key = `seq:${doc}:${fy}`;
  const seq = ((await kvGet(key)) ?? 0) + 1;
  await kvSet(key, seq);
  return doc === 'invoice' ? invoiceNumber(device.code, fy, seq) : creditNoteNumber(device.code, fy, seq);
}

// A number allocated for a document that was never issued is reported to the server, so it shows
// as cancelled in GSTR-1 instead of as an unexplained gap.
function voidNumber(number, reason) {
  if (!number) return;
  api('/documents/void', { method: 'POST', body: { number, reason } }).catch(() =>
    enqueue({ kind: 'void', path: '/documents/void', body: { number, reason, client_id: newClientId() }, label: `Unused number ${number}` }));
}

// Fill the shared pickers (GST rates, units, states) wherever they appear.
function fillPickers(root = document) {
  for (const sel of root.querySelectorAll('[data-gst-rates]')) {
    const v = sel.dataset.value ?? sel.value;
    sel.innerHTML = GST_RATES.map((r) => `<option value="${r}">${r}%</option>`).join('');
    if (v !== '') sel.value = v;
  }
  for (const sel of root.querySelectorAll('[data-units]')) {
    const v = sel.dataset.value ?? sel.value;
    sel.innerHTML = Object.entries(UQC).map(([k, name]) => `<option value="${k}">${k} — ${name.toLowerCase()}</option>`).join('');
    sel.value = v || 'NOS';
  }
  for (const sel of root.querySelectorAll('[data-states]')) {
    const v = sel.dataset.value ?? sel.value;
    sel.innerHTML = Object.keys(STATES).map((c) => `<option value="${c}">${esc(stateLabel(c))}</option>`).join('');
    sel.value = v || shop.state_code;
  }
}

// Throws with err.offline = true when the server can't be reached, so callers can fall back.
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-hisaab-pin': localStorage.getItem('hisaab.pin') ?? '', ...authHeader() },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    const err = new Error('No internet connection');
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login_required) {
    showLogin('Please sign in again');
  } else if (res.status === 401 && !path.startsWith('/auth/')) {
    const pin = prompt('Enter shop PIN');
    if (pin !== null) {
      localStorage.setItem('hisaab.pin', pin);
      return api(path, { method, body });
    }
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// GET that remembers the last good answer and serves it when offline.
async function cachedGet(path) {
  try {
    const data = await api(path);
    await kvSet('get:' + path, data);
    return { data, stale: false };
  } catch (err) {
    if (!err.offline) throw err;
    return { data: await kvGet('get:' + path), stale: true };
  }
}

async function refreshCatalog() {
  try {
    await saveCatalog(await api('/products'));
  } catch { /* keep the old copy */ }
}

// Look a barcode up on the server, falling back to the saved catalog when offline.
// Returns null if the product is unknown; offline results carry `cached: true`.
async function findProduct(barcode) {
  try {
    const p = await api('/products/barcode/' + encodeURIComponent(barcode));
    await catalogUpsert(p);
    return p;
  } catch (err) {
    if (err.status === 404) return null;
    if (!err.offline) throw err;
    const p = await catalogFind(barcode);
    return p && { ...p, cached: true };
  }
}

function stockBadge(p) {
  if (p.quantity === 0) return '<span class="badge out">Out of stock</span>';
  if (p.quantity <= p.low_stock) return `<span class="badge low">${fmtQty(p.quantity, p.unit)} left</span>`;
  return `<span class="badge">${fmtQty(p.quantity, p.unit)} in stock</span>`;
}

const modal = $('#modal');
function openModal(html) {
  $('#modal-body').innerHTML = html;
  modal.showModal();
}

// --- sync ---------------------------------------------------------------

async function renderSyncStatus(box) {
  box ??= await getOutbox();
  const chip = $('#sync-status');
  const failed = box.filter((e) => e.error).length;
  const offline = !navigator.onLine;
  chip.classList.toggle('hidden', !offline && box.length === 0);
  chip.classList.toggle('offline', offline);
  chip.classList.toggle('error', failed > 0);
  chip.textContent = failed
    ? `⚠ ${failed} need attention`
    : `${offline ? 'Offline' : 'Syncing'}${box.length ? ` · ${box.length} pending` : ''}`;
}

async function trySync() {
  if (!(await getOutbox()).length) return;
  const { synced, warnings } = await sync(api);
  if (synced) {
    toast(`Synced ${synced} offline ${synced === 1 ? 'entry' : 'entries'}`);
    await refreshCatalog();
    refreshCurrentView();
  }
  if (warnings.length) setTimeout(() => toast(warnings.join(' · '), true), 2600);
}

$('#sync-status').onclick = async () => {
  const box = await getOutbox();
  openModal(`
    <h2>Waiting to sync</h2>
    <p class="muted">${navigator.onLine ? 'These will be sent to the server in order.' : 'You are offline. These are saved on this phone and will be sent when the internet is back.'}</p>
    <ul class="list">${box.map((e) => `
      <li class="${e.error ? '' : 'pending'}">
        <div class="grow">
          <div class="title">${esc(e.label)}</div>
          <div class="sub">${localTime(e.queued_at)}</div>
          ${e.error ? `<div class="sub" style="color:var(--danger)">Rejected: ${esc(e.error)}</div>` : ''}
        </div>
        ${e.error ? `<button class="btn" data-retry="${e.body.client_id}">Retry</button>
          <button class="btn danger" data-discard="${e.body.client_id}">Discard</button>` : ''}
      </li>`).join('') || '<p class="empty">Nothing pending.</p>'}</ul>
    <div class="actions">
      <button class="btn ghost" data-close>Close</button>
      <button class="btn primary" data-sync>Sync now</button>
    </div>`);
  $('[data-close]', modal).onclick = () => modal.close();
  $('[data-sync]', modal).onclick = async () => {
    modal.close();
    await trySync();
    const left = await getOutbox();
    if (left.some((e) => !e.error)) toast('Still offline — will retry automatically', true);
  };
  $('#modal-body').onclick = async (e) => {
    const { retry: r, discard: d } = e.target.dataset;
    if (r) await retry(r);
    if (d && confirm('Discard this entry? It will never reach the server.')) {
      const entry = (await getOutbox()).find((x) => x.body.client_id === d);
      voidNumber(entry?.body.invoice_no ?? entry?.body.note_no, 'Discarded before it reached the server');
      await discard(d);
    }
    if (r || d) {
      modal.close();
      if (r) trySync();
    }
  };
};

onOutboxChange(renderSyncStatus);
window.addEventListener('online', () => { renderSyncStatus(); trySync(); });
window.addEventListener('offline', () => renderSyncStatus());
setInterval(() => navigator.onLine && trySync(), 30_000);

// --- scanners -----------------------------------------------------------

const scanners = {};
function setupScanner(name, onCode) {
  const box = $(`[data-scanner="${name}"]`);
  const btn = $('.scan-toggle', box);
  const handle = (code) => {
    feedback();
    box.classList.add('flash');
    setTimeout(() => box.classList.remove('flash'), 300);
    onCode(code.trim());
  };
  const scanner = new Scanner($('video', box), handle);
  scanners[name] = { scanner, btn };
  btn.onclick = async () => {
    if (scanner.running) {
      scanner.stop();
      btn.textContent = 'Start camera';
      return;
    }
    btn.textContent = 'Starting…';
    try {
      await scanner.start();
      btn.textContent = 'Stop camera';
    } catch (err) {
      btn.textContent = 'Start camera';
      toast(err.name === 'NotAllowedError' ? 'Camera permission denied' : err.message, true);
    }
  };
  $(`[data-manual="${name}"]`).onsubmit = (e) => {
    e.preventDefault();
    const input = e.target.code;
    if (input.value.trim()) handle(input.value);
    input.value = '';
  };
}

function stopAllScanners() {
  for (const { scanner, btn } of Object.values(scanners)) {
    if (scanner.running) {
      scanner.stop();
      btn.textContent = 'Start camera';
    }
  }
}

// --- billing ------------------------------------------------------------

const cart = new Map(); // barcode -> { product, quantity }

async function addToCart(barcode) {
  let p;
  try {
    p = await findProduct(barcode);
  } catch (err) {
    return toast(err.message, true);
  }
  if (!p) return toast(`Barcode ${barcode} not in inventory — add it in Stock in`, true);
  const line = cart.get(p.barcode) ?? { product: p, quantity: 0 };
  if (isLoose(p.unit)) {
    // Sold by weight: start at 1 (or what's left) and let the cashier type the weight.
    line.product = p;
    if (!line.quantity) line.quantity = p.quantity > 0 && p.quantity < 1 ? p.quantity : 1;
    cart.set(p.barcode, line);
    renderCart();
    const input = $(`#cart input[data-weight="${CSS.escape(p.barcode)}"]`);
    input?.focus();
    input?.select();
    return toast(`${p.name}: type the weight in ${UNIT_SHORT[p.unit]}`);
  }
  if (line.quantity + 1 > p.quantity) {
    // Online stock is authoritative. Offline, the saved count may be out of date, so warn only.
    if (!p.cached) return toast(p.quantity ? `Only ${p.quantity} of ${p.name} in stock` : `${p.name} is out of stock`, true);
    toast(`${p.name}: saved stock shows ${p.quantity} — check after sync`, true);
  }
  line.product = p;
  line.quantity += 1;
  cart.set(p.barcode, line);
  if (!p.cached || line.quantity <= p.quantity) toast(`${p.name} ×${line.quantity}`);
  renderCart();
}

function cartTotals() {
  let subtotal = 0;
  for (const { product, quantity } of cart.values()) subtotal += lineAmount(product.price, quantity);
  const discount = Math.min(toPaise($('#discount').value), subtotal);
  return { subtotal, discount, total: subtotal - discount };
}

const lineText = (price, quantity, unit) =>
  `${rupees(price)}${perUnit(unit)} × ${fmtQty(quantity, unit)} = <strong>${rupees(lineAmount(price, quantity))}</strong>`;

function renderCartTotals() {
  const { subtotal, total } = cartTotals();
  $('#subtotal').textContent = rupees(subtotal);
  $('#total').textContent = rupees(total);
}

function renderCart() {
  const list = $('#cart');
  list.innerHTML = [...cart.values()].map(({ product: p, quantity }) => `
    <li>
      <div class="grow">
        <div class="title">${esc(p.name)}</div>
        <div class="sub" data-line="${esc(p.barcode)}">${lineText(p.price, quantity, p.unit)}</div>
      </div>
      ${isLoose(p.unit) ? `
      <div class="qty weight">
        <input type="number" inputmode="decimal" step="0.001" min="0.001" value="${quantity}" data-weight="${esc(p.barcode)}" aria-label="Weight">
        <span>${UNIT_SHORT[p.unit]}</span>
        <button class="btn" data-dec="${esc(p.barcode)}" data-all aria-label="Remove">×</button>
      </div>` : `
      <div class="qty">
        <button class="btn" data-dec="${esc(p.barcode)}" aria-label="Less">−</button>
        <span>${quantity}</span>
        <button class="btn" data-inc="${esc(p.barcode)}" aria-label="More">+</button>
      </div>`}
    </li>`).join('');
  const has = cart.size > 0;
  $('#cart-empty').classList.toggle('hidden', has);
  $('#checkout').classList.toggle('hidden', !has);
  renderCartTotals();
  const credit = $('input[name=pay]:checked').value === 'credit';
  $('#cust-name').placeholder = credit ? 'Customer name (required for udhaar)' : 'Customer name (optional)';
}

$('#cart').onclick = (e) => {
  const inc = e.target.dataset.inc, dec = e.target.dataset.dec;
  const line = cart.get(inc ?? dec);
  if (!line) return;
  if (inc) {
    if (line.quantity + 1 > line.product.quantity && !line.product.cached) {
      return toast(`Only ${line.product.quantity} in stock`, true);
    }
    line.quantity++;
  } else if (e.target.dataset.all !== undefined || --line.quantity <= 0) {
    cart.delete(line.product.barcode);
  }
  renderCart();
};
// Typing a weight updates that line and the totals as you type (without redrawing the list).
$('#cart').oninput = (e) => {
  const line = cart.get(e.target.dataset.weight);
  if (!line) return;
  line.quantity = readQty(e.target.value);
  $(`#cart [data-line="${CSS.escape(line.product.barcode)}"]`).innerHTML = lineText(line.product.price, line.quantity, line.product.unit);
  renderCartTotals();
};
$('#cart').addEventListener('change', (e) => {
  const line = cart.get(e.target.dataset.weight);
  if (!line) return;
  if (line.quantity > line.product.quantity && !line.product.cached) {
    toast(`Only ${fmtQty(line.product.quantity, line.product.unit)} of ${line.product.name} in stock`, true);
  }
});
$('#discount').oninput = renderCart;
$('.pay-methods').onchange = renderCart;
$('#clear-cart').onclick = () => {
  if (confirm('Clear this bill?')) resetBill();
};

function resetBill() {
  cart.clear();
  $('#discount').value = 0;
  $('#cust-name').value = '';
  $('#cust-phone').value = '';
  $('#cust-due').classList.add('hidden');
  $('input[name=pay][value=cash]').checked = true;
  $('#buyer-gstin').value = '';
  $('#buyer-address').value = '';
  $('#place-of-supply').value = shop.state_code;
  $('#tax-details').open = false;
  renderCart();
}

// Customer suggestions at checkout, from the saved customer list.
async function savedCustomers() {
  return (await kvGet('get:/customers')) ?? [];
}

async function fillCustomerList() {
  $('#customer-names').innerHTML = (await savedCustomers())
    .map((c) => `<option value="${esc(c.name)}">${c.phone ? esc(c.phone) : ''}</option>`).join('');
}

async function matchCustomer(source) {
  const customers = await savedCustomers();
  const name = $('#cust-name').value.trim().toLowerCase();
  const phone = digits($('#cust-phone').value);
  const c = source === 'phone'
    ? phone.length >= 10 && customers.find((x) => x.phone === phone)
    : name && customers.find((x) => x.name.toLowerCase() === name);
  const due = $('#cust-due');
  if (!c) return due.classList.add('hidden');
  if (source === 'name' && !$('#cust-phone').value && c.phone) $('#cust-phone').value = c.phone;
  if (source === 'phone' && !$('#cust-name').value) $('#cust-name').value = c.name;
  due.textContent = c.balance > 0 ? `${c.name} already owes ${rupees(c.balance)}` : `${c.name} has no dues`;
  due.classList.remove('hidden');
}
$('#cust-name').onchange = () => matchCustomer('name');
$('#cust-phone').onchange = () => matchCustomer('phone');

$('#do-checkout').onclick = async (e) => {
  const btn = e.currentTarget;
  const payment_method = $('input[name=pay]:checked').value;
  const customer_name = $('#cust-name').value.trim() || undefined;
  const customer_phone = $('#cust-phone').value.trim() || undefined;
  if (payment_method === 'credit' && !customer_name && !customer_phone) {
    return toast('Enter the customer name for udhaar', true);
  }
  const lines = [...cart.values()];
  for (const { product: p, quantity } of lines) {
    const problem = quantityProblem(p.name, p.unit, quantity);
    if (problem) return toast(problem, true);
    if (quantity > p.quantity && !p.cached) return toast(`Only ${fmtQty(p.quantity, p.unit)} of ${p.name} in stock`, true);
  }
  const { discount, total } = cartTotals();
  const buyer_gstin = gstOn() ? $('#buyer-gstin').value.trim().toUpperCase() || undefined : undefined;
  const buyer_address = gstOn() ? $('#buyer-address').value.trim() || undefined : undefined;
  const place_of_supply = gstOn() ? $('#place-of-supply').value || undefined : undefined;
  if (gstOn()) {
    // Same rules as the server, checked before a number is used or anything is printed.
    const problem = invoiceProblem(shop, lines.map(({ product: p }) => ({ name: p.name, gst_rate: p.gst_rate, hsn: p.hsn })),
      { buyer_gstin, customer_name, buyer_address, total });
    if (problem) {
      if (/address|name/.test(problem)) $('#tax-details').open = true;
      return toast(problem, true);
    }
  }

  btn.disabled = true;
  let invoice_no;
  try {
    if (gstOn()) invoice_no = await allocateNumber('invoice');
  } catch (err) {
    btn.disabled = false;
    return toast(err.message, true);
  }
  const body = {
    items: lines.map(({ product, quantity }) => ({ barcode: product.barcode, quantity })),
    discount, payment_method, customer_name, customer_phone,
    invoice_no, buyer_gstin, buyer_address, place_of_supply,
    client_id: newClientId(),
  };
  try {
    // Anything queued earlier (e.g. a product added offline) must reach the server first.
    if ((await getOutbox()).length) await trySync();
    const sale = await api('/sales', { method: 'POST', body });
    for (const { product, quantity } of lines) await catalogChangeQty(product.barcode, -quantity);
    if (payment_method === 'credit') cachedGet('/customers').then(fillCustomerList, () => {});
    resetBill();
    showReceipt(sale);
  } catch (err) {
    if (!err.offline) {
      voidNumber(invoice_no, `Not issued: ${err.message}`);
      return toast(err.message, true);
    }
    // No internet: the sale has happened in the shop, so keep it and sync later. The invoice is
    // worked out here exactly as the server will record it, and each line is sent as printed.
    const preview = invoicePreview({ lines, discount, payment_method, customer_name, customer_phone, buyer_gstin, buyer_address, place_of_supply, invoice_no });
    await enqueue({
      kind: 'sale',
      path: '/sales',
      body: {
        ...body, offline: true, created_at: new Date().toISOString(),
        items: preview.items.map((i) => ({ barcode: i.barcode, quantity: i.quantity, unit_price: i.unit_price, gst_rate: i.gst_rate, hsn: i.hsn ?? undefined, unit: i.unit })),
      },
      label: `${invoice_no ?? 'Bill'} ${rupees(total)} · ${PAY_LABEL[payment_method]}${customer_name ? ' · ' + customer_name : ''}`,
      preview,
    });
    for (const { product, quantity } of lines) await catalogChangeQty(product.barcode, -quantity);
    resetBill();
    showReceipt(preview);
    toast('Saved offline — will sync when internet is back');
  } finally {
    btn.disabled = false;
  }
};

// The invoice as the server will record it, for printing while offline.
function invoicePreview({ lines, discount, payment_method, customer_name, customer_phone, buyer_gstin, buyer_address, place_of_supply, invoice_no }) {
  const pos = place_of_supply ?? shop.state_code ?? null;
  const inter = Boolean(gstOn() && pos && pos !== shop.state_code);
  const items = lines.map(({ product: p, quantity }) => ({
    barcode: p.barcode, name: p.name, quantity, unit_price: p.price, line_total: lineAmount(p.price, quantity),
    gst_rate: p.gst_rate, hsn: p.hsn ?? null, unit: p.unit ?? 'NOS',
  }));
  const split = splitTax(items.map((i) => ({ amount: i.line_total, rate: i.gst_rate })), discount, inter);
  items.forEach((i, n) => {
    const { taxable, cgst, sgst, igst } = split[n];
    Object.assign(i, { taxable, cgst, sgst, igst });
  });
  const subtotal = items.reduce((t, i) => t + i.line_total, 0);
  const sum = (k) => items.reduce((t, i) => t + i[k], 0);
  return {
    id: null, invoice_no, created_at: nowSql(), subtotal, discount, total: subtotal - discount, payment_method,
    customer_name, customer_phone, buyer_gstin, buyer_address, place_of_supply: pos, inter_state: inter ? 1 : 0,
    taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), tax: sum('cgst') + sum('sgst') + sum('igst'), items,
  };
}

function receiptText(sale) {
  const lines = sale.items.map((i) => `${i.name} ${isLoose(i.unit) ? fmtQty(i.quantity, i.unit) : 'x' + i.quantity} = ${rupees(i.line_total)}`);
  return [
    `${shopName()} — ${gstOn() ? 'Tax invoice' : 'Bill'} ${sale.invoice_no ?? (sale.id ? '#' + sale.id : '')}`.trim(),
    localTime(sale.created_at),
    '',
    ...lines,
    '',
    sale.discount ? `Discount: -${rupees(sale.discount)}` : null,
    `Total: ${rupees(sale.total)} (${PAY_LABEL[sale.payment_method]})`,
    'Thank you!',
  ].filter((l) => l !== null).join('\n');
}

function whatsappLink(phone, text) {
  const p = digits(phone);
  return `https://wa.me/${p.length === 10 ? '91' + p : p}?text=${encodeURIComponent(text)}`;
}

function showReceipt(sale) {
  const returned = (sale.returns ?? []).map((r) => `<div class="muted">Credit note ${esc(r.note_no ?? '#' + r.id)} · ${localTime(r.created_at)} · −${rupees(r.total)}</div>`).join('');
  const by = sale.user_name ?? (!sale.id ? me?.name : null);
  const body = (gstOn() && (sale.invoice_no || !sale.id)
    ? taxInvoiceHtml(sale, shop, { pending: !sale.id }) + returned
    : plainReceiptHtml(sale)) + (by ? `<p class="muted">Billed by ${esc(by)}</p>` : '');
  openModal(`${body}
    <div class="actions">
      <button class="btn ghost" data-close>Close</button>
      ${sale.id && canReturn() ? '<button class="btn" data-return>↩ Return</button>' : ''}
      <button class="btn" data-print>Print</button>
      <a class="btn primary" href="${whatsappLink(sale.customer_phone, receiptText(sale))}" target="_blank" rel="noopener">WhatsApp</a>
    </div>`);
  $('[data-close]', modal).onclick = () => modal.close();
  $('[data-print]', modal).onclick = () => window.print();
  const back = $('[data-return]', modal);
  if (back) back.onclick = () => {
    modal.close();
    showView('bill');
    setBillMode('return');
    loadReturnBill(sale.id);
  };
}

// The simple bill, for shops that are not GST-registered (and bills from before registration).
function plainReceiptHtml(sale) {
  return `
    <div class="receipt">
      <h3>${esc(shopName())}</h3>
      <div>${sale.invoice_no ? `Bill ${esc(sale.invoice_no)}` : sale.id ? `Bill #${sale.id}` : 'Bill (saved offline, syncs later)'} · ${localTime(sale.created_at)}</div>
      ${sale.customer_name ? `<div>Customer: ${esc(sale.customer_name)}</div>` : ''}
      <table>
        ${sale.items.map((i) => `<tr><td>${esc(i.name)}<br><span class="muted">${fmtQty(i.quantity, i.unit)} × ${rupees(i.unit_price)}${perUnit(i.unit)}</span></td><td>${rupees(i.line_total)}</td></tr>`).join('')}
        <tr class="sep"><td>Subtotal</td><td>${rupees(sale.subtotal)}</td></tr>
        ${sale.discount ? `<tr><td>Discount</td><td>−${rupees(sale.discount)}</td></tr>` : ''}
        <tr><td><strong>Total</strong></td><td><strong>${rupees(sale.total)}</strong></td></tr>
        ${sale.tax ? `<tr><td class="muted">Incl. GST</td><td class="muted">${rupees(sale.tax)}</td></tr>` : ''}
        <tr><td>Paid by</td><td>${PAY_LABEL[sale.payment_method]}</td></tr>
        ${(sale.returns ?? []).map((r) => `<tr><td class="muted">Returned ${localTime(r.created_at)}</td><td class="muted">−${rupees(r.total)}</td></tr>`).join('')}
      </table>
    </div>`;
}

// --- customer returns ---------------------------------------------------

// Lines coming back, keyed by barcode: { barcode, name, quantity, unit_price, max }. With a bill
// loaded, every line on it is listed (max = what can still come back) and scans count them up;
// without one, scans add products at today's price.
let billMode = 'sale';
let ret = { sale: null, lines: new Map() };

function setBillMode(mode) {
  billMode = mode;
  const isReturn = mode === 'return';
  $('#bill-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#return-panel').classList.toggle('hidden', !isReturn);
  for (const sel of ['#cart', '#cart-empty', '#checkout']) $(sel).classList.toggle('hidden', isReturn);
  $('[data-manual=bill] button').textContent = isReturn ? 'Return' : 'Add';
  if (isReturn) {
    renderReturn();
    loadReturnAllowance();
  }
  else renderCart();
}
$('#bill-mode').onclick = (e) => {
  const mode = e.target.closest('button[data-mode]')?.dataset.mode;
  if (mode) setBillMode(mode);
};

function resetReturn() {
  ret = { sale: null, lines: new Map() };
  $('#return-bill-form').bill.value = '';
  $('#return-why').value = '';
  $('#return-cust-name').value = '';
  $('#return-cust-phone').value = '';
  $('#return-restock').checked = true;
  $('input[name=refund][value=cash]').checked = true;
  renderReturn();
}

// A cashier's return limits and what's left of today's allowance (from the server).
let allowance = null;
async function loadReturnAllowance() {
  const note = $('#return-limit');
  if (isOwner()) {
    allowance = null;
    return note.classList.add('hidden');
  }
  try {
    allowance = (await api('/summary')).returns;
    await kvSet('return-allowance', allowance);
  } catch {
    allowance = (await kvGet('return-allowance')) ?? null;
  }
  if (!allowance) return note.classList.add('hidden');
  note.textContent = `You can refund up to ${rupees(allowance.per_return)} per return`
    + (allowance.daily ? ` · ${rupees(allowance.left_today)} left today` : '')
    + ` · bills up to ${allowance.days} day${allowance.days === 1 ? '' : 's'} old. Bigger returns need the owner.`;
  note.classList.remove('hidden');
}

// Same rules as the server, so a cashier finds out before handing over money.
function cashierReturnProblem(total) {
  if (isOwner() || !allowance) return null;
  if (!ret.sale) return "Load the customer's bill — cashiers can only take returns against a bill";
  if (total > allowance.per_return) return `Returns over ${rupees(allowance.per_return)} need the owner`;
  if (allowance.daily && total > allowance.left_today) return `Only ${rupees(allowance.left_today)} of returns left for you today — ask the owner`;
  const age = Math.round((Date.parse(localDate(nowSql(), shop.tz_offset)) - Date.parse(localDate(ret.sale.created_at, shop.tz_offset))) / 86_400_000);
  if (age > allowance.days) return `This bill is ${age} days old — returns after ${allowance.days} days need the owner`;
  return null;
}

// id: the bill's id, or the number printed on the receipt.
async function loadReturnBill(id) {
  let sale;
  try {
    sale = await api(typeof id === 'number' ? `/sales/${id}` : `/sales/by-number/${encodeURIComponent(id)}`);
  } catch (err) {
    return toast(err.offline ? 'Loading a bill needs internet — you can still scan items without it' : err.message, true);
  }
  ret = {
    sale,
    lines: new Map(sale.returnable.map((l) => [l.barcode, {
      barcode: l.barcode, name: l.name, quantity: 0, unit_price: l.unit_refund, max: l.returnable,
      gst_rate: l.gst_rate, hsn: l.hsn, unit: l.unit,
    }])),
  };
  $('#return-bill-form').bill.value = sale.invoice_no ?? sale.id;
  // Refund the way they paid; an udhaar bill comes off the udhaar.
  const method = sale.payment_method === 'credit' ? 'khata' : sale.payment_method;
  $(`input[name=refund][value=${method}]`).checked = true;
  renderReturn();
}

$('#return-bill-form').onsubmit = (e) => {
  e.preventDefault();
  const number = e.target.bill.value.trim();
  if (number) loadReturnBill(number);
  else resetReturn();
};

async function addToReturn(barcode) {
  if (!ret.sale && gstOn()) return toast('Load the bill first — a credit note must refer to the original invoice', true);
  if (!ret.sale && !isOwner()) return toast("Load the customer's bill first — cashiers can only take returns against a bill", true);
  if (ret.sale) {
    const line = ret.lines.get(barcode);
    if (!line) return toast(`That item is not on bill ${ret.sale.invoice_no ?? '#' + ret.sale.id}`, true);
    if (isLoose(line.unit)) {
      renderReturn();
      return $(`#return-lines input[data-rweight="${CSS.escape(barcode)}"]`)?.focus();
    }
    if (line.quantity >= line.max) return toast(`Only ${line.max} of ${line.name} can come back from this bill`, true);
    line.quantity++;
    toast(`${line.name} ×${line.quantity} to return`);
    return renderReturn();
  }
  let p;
  try {
    p = await findProduct(barcode);
  } catch (err) {
    return toast(err.message, true);
  }
  if (!p) return toast(`Barcode ${barcode} is not in your inventory`, true);
  const line = ret.lines.get(p.barcode) ?? { barcode: p.barcode, name: p.name, quantity: 0, unit_price: p.price, max: null, unit: p.unit };
  line.quantity = isLoose(p.unit) ? line.quantity || 1 : line.quantity + 1;
  ret.lines.set(p.barcode, line);
  toast(`${p.name} ×${line.quantity} to return`);
  renderReturn();
}

function renderReturn() {
  const s = ret.sale;
  const lines = [...ret.lines.values()];
  $('#return-bill-info').textContent = s
    ? `${s.invoice_no ?? `Bill #${s.id}`} · ${localTime(s.created_at)} · ${rupees(s.total)} · ${PAY_LABEL[s.payment_method]}${s.customer_name ? ' · ' + s.customer_name : ''}`
      + (s.returns.length ? ` · already returned ${rupees(s.returns.reduce((t, r) => t + r.total, 0))}` : '')
    : '';
  $('#return-lines').innerHTML = lines.map((l) => `
    <li>
      <div class="grow">
        <div class="title">${esc(l.name)}</div>
        <div class="sub">${rupees(l.unit_price)}${isLoose(l.unit) ? perUnit(l.unit) : ' each'}${l.max !== null ? ` · <span class="return-max">${l.max ? `up to ${fmtQty(l.max, l.unit)}` : 'all returned already'}</span>` : ''}</div>
      </div>
      ${isLoose(l.unit) ? `
      <div class="qty weight">
        <input type="number" inputmode="decimal" step="0.001" min="0" ${l.max !== null ? `max="${l.max}"` : ''} value="${l.quantity}" data-rweight="${esc(l.barcode)}" aria-label="Weight">
        <span>${UNIT_SHORT[l.unit]}</span>
      </div>` : `
      <div class="qty">
        <button class="btn" data-rdec="${esc(l.barcode)}" aria-label="Less">−</button>
        <span>${l.quantity}</span>
        <button class="btn" data-rinc="${esc(l.barcode)}" aria-label="More">+</button>
      </div>`}
    </li>`).join('');
  const total = lines.reduce((t, l) => t + lineAmount(l.unit_price, l.quantity), 0);
  const any = lines.some((l) => l.quantity > 0);
  $('#return-empty').classList.toggle('hidden', lines.length > 0);
  $('#return-checkout').classList.toggle('hidden', !any);
  $('#return-total').textContent = rupees(total);
  const khata = $('input[name=refund]:checked').value === 'khata';
  $('#return-customer').classList.toggle('hidden', !khata || Boolean(s?.customer_id));
}

$('#return-lines').onclick = (e) => {
  const { rinc, rdec } = e.target.dataset;
  const line = ret.lines.get(rinc ?? rdec);
  if (!line) return;
  if (rinc) {
    if (line.max !== null && line.quantity >= line.max) return toast(`Only ${line.max} can come back from this bill`, true);
    line.quantity++;
  } else if (line.quantity > 0) {
    line.quantity--;
    if (!line.quantity && line.max === null) ret.lines.delete(line.barcode);
  }
  renderReturn();
};
$('#return-lines').addEventListener('change', (e) => {
  const line = ret.lines.get(e.target.dataset.rweight);
  if (!line) return;
  line.quantity = Math.max(0, readQty(e.target.value));
  if (line.max !== null && line.quantity > line.max) {
    line.quantity = line.max;
    toast(`Only ${fmtQty(line.max, line.unit)} can come back from this bill`, true);
  }
  renderReturn();
});
$('#return-refund').onchange = renderReturn;
$('#return-clear').onclick = () => confirm('Clear this return?') && resetReturn();

$('#return-save').onclick = async (e) => {
  const btn = e.currentTarget;
  const lines = [...ret.lines.values()].filter((l) => l.quantity > 0);
  const refund_method = $('input[name=refund]:checked').value;
  const restock = $('#return-restock').checked;
  const needsCustomer = refund_method === 'khata' && !ret.sale?.customer_id;
  const customer_name = needsCustomer ? $('#return-cust-name').value.trim() || undefined : undefined;
  const customer_phone = needsCustomer ? $('#return-cust-phone').value.trim() || undefined : undefined;
  if (needsCustomer && !customer_name && !customer_phone) return toast('Enter the customer whose udhaar this comes off', true);
  const total = lines.reduce((t, l) => t + lineAmount(l.unit_price, l.quantity), 0);
  if (gstOn() && !ret.sale) return toast('Load the bill first — a credit note must refer to the original invoice', true);
  const limitProblem = cashierReturnProblem(total);
  if (limitProblem) return toast(limitProblem, true);
  btn.disabled = true;
  let note_no;
  try {
    if (gstOn()) note_no = await allocateNumber('credit_note');
  } catch (err) {
    btn.disabled = false;
    return toast(err.message, true);
  }
  const body = {
    sale_id: ret.sale?.id,
    items: lines.map((l) => ({ barcode: l.barcode, quantity: l.quantity })),
    refund_method, restock, customer_name, customer_phone, note_no,
    reason: $('#return-why').value.trim() || undefined,
    client_id: newClientId(),
  };
  const who = ret.sale?.customer_name ?? customer_name ?? 'the customer';
  const sale = ret.sale;
  // The credit note as the server will record it, for printing while offline.
  const notePreview = () => {
    const inter = Boolean(sale?.inter_state);
    const items = lines.map((l) => ({
      name: l.name, hsn: l.hsn, unit: l.unit, gst_rate: l.gst_rate ?? 0, quantity: l.quantity, unit_price: l.unit_price,
      ...taxOf(lineAmount(l.unit_price, l.quantity), l.gst_rate ?? 0, inter),
    }));
    return {
      id: null, note_no, created_at: nowSql(), total, reason: body.reason, items, inter_state: sale?.inter_state,
      invoice_no: sale?.invoice_no, invoice_date: sale?.created_at, buyer_gstin: sale?.buyer_gstin,
      buyer_name: sale?.customer_name, buyer_address: sale?.buyer_address, place_of_supply: sale?.place_of_supply,
    };
  };
  const finish = async (offline, note) => {
    if (restock) for (const l of lines) await catalogChangeQty(l.barcode, l.quantity);
    resetReturn();
    openModal(`
      ${gstOn() && note ? creditNoteHtml(note, shop, { pending: offline }) : ''}
      <h2>Return saved${offline ? ' (offline)' : ''}</h2>
      <p style="font-size:20px"><strong>${refund_method === 'khata'
        ? `${rupees(total)} taken off ${esc(who)}'s udhaar`
        : `Give back ${rupees(total)} by ${PAY_LABEL[refund_method]}`}</strong></p>
      <p class="muted">${restock ? 'Items are back in stock.' : 'Marked damaged — not added back to stock.'}${offline ? ' Will sync when the internet is back.' : ''}</p>
      <div class="actions">${gstOn() ? '<button class="btn" data-print>Print credit note</button>' : ''}<button class="btn primary" data-close>Done</button></div>`);
    $('[data-close]', modal).onclick = () => modal.close();
    $('[data-print]', modal)?.addEventListener('click', () => window.print());
  };

  try {
    if ((await getOutbox()).length) await trySync();
    const note = await api('/sale-returns', { method: 'POST', body });
    if (refund_method === 'khata') cachedGet('/customers').then(fillCustomerList, () => {});
    await finish(false, note);
    loadReturnAllowance();
  } catch (err) {
    if (!err.offline) {
      voidNumber(note_no, `Not issued: ${err.message}`);
      return toast(err.message, true);
    }
    await enqueue({
      kind: 'sale_return', path: '/sale-returns',
      body: { ...body, created_at: new Date().toISOString() },
      label: `Customer return ${rupees(total)}${who !== 'the customer' ? ' · ' + who : ''}`,
      preview: { total, refund_method, customer_id: ret.sale?.customer_id ?? null, customer_name, customer_phone },
    });
    await finish(true, notePreview());
  } finally {
    btn.disabled = false;
  }
};

// --- stock in & supplier purchases -------------------------------------

// With no supplier chosen, each scan goes straight into stock ("quick stock in").
// With a supplier chosen, scans build up either that supplier's bill (saved in one go as a purchase)
// or, in return mode, a list of goods going back to them.
const stockForm = $('#stock-form');
let stockProduct = null;
// supplier: { id, name, phone } (id null = created on save); bill: purchase a return is linked to.
const emptyPurchase = () => ({ supplier: null, lines: [], mode: 'purchase', bill: null });
let purchase = emptyPurchase();
const inPurchase = () => purchase.supplier !== null;
const returning = () => inPurchase() && purchase.mode === 'return';
const savedSuppliers = async () => (await kvGet('get:/suppliers')) ?? [];
const savePurchaseDraft = () => kvSet('purchase-draft', purchase);

async function fillSupplierSelect() {
  const s = purchase.supplier;
  $('#purchase-supplier').innerHTML = '<option value="">Quick stock in (no supplier bill)</option>'
    + (await savedSuppliers()).map((x) => `<option value="${x.id}">${esc(x.name)}${
      x.balance > 0 ? ` · you owe ${rupees(x.balance)}` : x.balance < 0 ? ` · credit ${rupees(-x.balance)}` : ''}</option>`).join('')
    + (s && s.id === null ? `<option value="draft">${esc(s.name)} (new)</option>` : '')
    + '<option value="new">+ New supplier…</option>';
  $('#purchase-supplier').value = s ? String(s.id ?? 'draft') : '';
}

function afterSupplierChange() {
  savePurchaseDraft();
  fillSupplierSelect();
  renderPurchase();
  closeStockForm();
  if (returning()) fillReturnBills();
}

function resetPurchaseForm() {
  purchase = emptyPurchase();
  $('#purchase-invoice').value = '';
  $('#purchase-paid').value = 0;
  $('#return-reason').value = '';
  $('input[name=settle][value=adjust]').checked = true;
}

// Start a return to this supplier (from the Khata tab).
function startReturn(supplier) {
  resetPurchaseForm();
  purchase.supplier = { id: supplier.id, name: supplier.name, phone: supplier.phone };
  purchase.mode = 'return';
  showView('stock');
  afterSupplierChange();
}

$('#purchase-mode').onclick = (e) => {
  const mode = e.target.closest('button[data-mode]')?.dataset.mode;
  if (!mode || mode === purchase.mode) return;
  if (mode === 'return' && purchase.supplier.id === null) {
    return toast('Save a purchase from this new supplier first, then you can return goods', true);
  }
  if (purchase.lines.length && !confirm(`Clear the ${purchase.lines.length} item(s) scanned so far?`)) return;
  purchase.lines = [];
  purchase.bill = null;
  purchase.mode = mode;
  afterSupplierChange();
};

// Recent bills from this supplier, so a return can be linked to the bill the goods came on.
async function fillReturnBills() {
  const sel = $('#return-bill');
  sel.innerHTML = '<option value="">Not linked to a bill</option>';
  try {
    const s = await api(`/suppliers/${purchase.supplier.id}`);
    sel.innerHTML += s.purchases.map((p) => `<option value="${p.id}">${
      p.invoice_no ? 'Invoice ' + esc(p.invoice_no) : 'Purchase #' + p.id} · ${localTime(p.created_at)} · ${rupees(p.total)}</option>`).join('');
  } catch { /* offline: returns can still be made without linking */ }
  sel.value = purchase.bill?.id ?? '';
}

$('#return-bill').onchange = async (e) => {
  const id = Number(e.target.value);
  purchase.bill = null;
  if (id) {
    try {
      const p = await api(`/purchases/${id}`);
      purchase.bill = { id, invoice_no: p.invoice_no, returnable: p.returnable };
      // Value lines already scanned at this bill's cost.
      for (const l of purchase.lines) {
        const billLine = p.returnable.find((b) => b.barcode === l.barcode);
        if (billLine) l.unit_cost = billLine.unit_cost;
      }
    } catch (err) {
      e.target.value = '';
      toast(err.offline ? 'Linking a bill needs internet' : err.message, true);
    }
  }
  savePurchaseDraft();
  renderPurchase();
};
$('#return-settlement').onchange = renderPurchase;

$('#purchase-supplier').onchange = async (e) => {
  const v = e.target.value;
  if (v === 'draft') return;
  if (v === 'new') {
    return partyForm('supplier', { allowOffline: true }, (s) => {
      if (s) {
        purchase.supplier = { id: s.id, name: s.name, phone: s.phone };
        purchase.bill = null;
        if (s.id === null) purchase.mode = 'purchase'; // can't return to a supplier the server doesn't know yet
      }
      afterSupplierChange();
    });
  }
  if (v && purchase.lines.length && !confirm('Switch supplier? Items scanned so far stay on the bill.')) return fillSupplierSelect();
  if (!v) {
    if (purchase.lines.length && !confirm('Discard the list you are building?')) return fillSupplierSelect();
    resetPurchaseForm();
  } else {
    const s = (await savedSuppliers()).find((x) => x.id === Number(v));
    purchase.supplier = { id: s.id, name: s.name, phone: s.phone };
    purchase.bill = null;
  }
  afterSupplierChange();
};

function purchaseTotal() {
  return purchase.lines.reduce((s, l) => s + lineAmount(l.unit_cost, l.quantity), 0);
}

function renderPurchase() {
  $('#purchase').classList.toggle('hidden', !inPurchase());
  $('#stock-hint').textContent = inPurchase()
    ? ''
    : "Scan a product's barcode to add it to inventory. New barcodes ask for name and price once. Got a supplier bill? Pick the supplier above.";
  if (!inPurchase()) return;
  const ret = returning();
  const name = purchase.supplier.name;
  $('#purchase-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === purchase.mode));
  $('#purchase').querySelectorAll('.buy-only').forEach((el) => el.classList.toggle('hidden', ret));
  $('#purchase').querySelectorAll('.return-only').forEach((el) => el.classList.toggle('hidden', !ret));
  const refund = $('input[name=settle]:checked').value === 'refund';
  $('#refund-method').classList.toggle('hidden', !ret || !refund);
  $('#purchase-title').textContent = ret ? `Return to ${name}` : `Bill from ${name}`;
  $('#purchase-empty').textContent = ret ? 'Scan each item you are sending back.' : "Scan each item on the supplier's bill.";
  $('#purchase-total-label').textContent = ret ? 'Return value' : 'Bill total';
  $('#purchase-save').textContent = ret ? 'Save return' : 'Save purchase';
  $('#purchase-lines').innerHTML = purchase.lines.map((l, i) => `
    <li>
      <div class="grow">
        <div class="title">${esc(l.name)}${l.isNew ? ' <span class="badge">new</span>' : ''}</div>
        <div class="sub">${fmtQty(l.quantity, l.unit)} × ${rupees(l.unit_cost)}${perUnit(l.unit)} = <strong>${rupees(lineAmount(l.unit_cost, l.quantity))}</strong></div>
      </div>
      <button class="btn remove danger" data-remove="${i}" aria-label="Remove">×</button>
    </li>`).join('');
  $('#purchase-empty').classList.toggle('hidden', purchase.lines.length > 0);
  const total = purchaseTotal();
  $('#purchase-total').textContent = rupees(total);
  if (ret) {
    $('#purchase-due').textContent = !total ? ''
      : refund ? `${name} pays you ${rupees(total)} back; what you owe them stays the same.`
      : `${rupees(total)} will come off what you owe ${name}.`;
  } else {
    const paid = Math.min(toPaise($('#purchase-paid').value), total);
    $('#purchase-due').textContent = total - paid > 0
      ? `${rupees(total - paid)} will be added to what you owe ${name}.`
      : total ? 'Fully paid.' : '';
  }
  $('#purchase-save').disabled = purchase.lines.length === 0;
}

$('#purchase-lines').onclick = (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  purchase.lines.splice(Number(i), 1);
  savePurchaseDraft();
  renderPurchase();
};
$('#purchase-paid').oninput = renderPurchase;
$('#purchase-discard').onclick = () => {
  if (!confirm(returning() ? 'Discard this return?' : 'Discard this supplier bill?')) return;
  resetPurchaseForm();
  afterSupplierChange();
};

async function saveReturn(btn) {
  const s = purchase.supplier;
  const total = purchaseTotal();
  const settlement = $('input[name=settle]:checked').value;
  const body = {
    supplier_id: s.id,
    purchase_id: purchase.bill?.id,
    items: purchase.lines.map((l) => ({ barcode: l.barcode, quantity: l.quantity, unit_cost: l.unit_cost })),
    settlement,
    refund_method: settlement === 'refund' ? $('input[name=rmethod]:checked').value : undefined,
    reason: $('#return-reason').value.trim() || undefined,
    client_id: newClientId(),
  };
  const lines = purchase.lines;
  const done = (msg) => {
    toast(msg);
    resetPurchaseForm();
    afterSupplierChange();
  };
  const outcome = settlement === 'refund' ? 'cash refund recorded' : `${rupees(total)} off ${s.name}'s dues`;

  btn.disabled = true;
  try {
    if ((await getOutbox()).length) await trySync();
    await api('/purchase-returns', { method: 'POST', body });
    await refreshCatalog();
    await cachedGet('/suppliers').catch(() => {});
    done(`Return saved — ${outcome}`);
  } catch (err) {
    if (!err.offline) {
      btn.disabled = false;
      return toast(err.message, true);
    }
    await enqueue({
      kind: 'return', path: '/purchase-returns',
      body: { ...body, created_at: new Date().toISOString() },
      label: `Return ${rupees(total)} to ${s.name}`,
      preview: { total, settlement },
    });
    for (const l of lines) await catalogChangeQty(l.barcode, -l.quantity);
    done('Return saved offline — will sync when internet is back');
  }
}

$('#purchase-save').onclick = async (e) => {
  const btn = e.currentTarget;
  if (returning()) return saveReturn(btn);
  const s = purchase.supplier;
  const total = purchaseTotal();
  const paid = toPaise($('#purchase-paid').value);
  if (paid > total) return toast('Paid amount is more than the bill total', true);
  const body = {
    ...(s.id ? { supplier_id: s.id } : { supplier_name: s.name, supplier_phone: s.phone || undefined }),
    invoice_no: $('#purchase-invoice').value.trim() || undefined,
    items: purchase.lines.map((l) => ({
      barcode: l.barcode, quantity: l.quantity, unit_cost: l.unit_cost,
      ...(l.isNew && { name: l.name, price: l.price, gst_rate: l.gst_rate, low_stock: l.low_stock, hsn: l.hsn, unit: l.unit }),
    })),
    paid,
    payment_method: $('input[name=pmethod]:checked').value,
    client_id: newClientId(),
  };
  const due = total - paid;
  const done = (msg) => {
    toast(msg);
    resetPurchaseForm();
    afterSupplierChange();
  };

  btn.disabled = true;
  try {
    if ((await getOutbox()).length) await trySync();
    await api('/purchases', { method: 'POST', body });
    await refreshCatalog();
    await cachedGet('/suppliers').catch(() => {});
    done(`Purchase saved — ${due > 0 ? `${rupees(due)} added to ${s.name}'s dues` : 'fully paid'}`);
  } catch (err) {
    if (!err.offline) {
      btn.disabled = false;
      return toast(err.message, true);
    }
    await enqueue({
      kind: 'purchase', path: '/purchases',
      body: { ...body, created_at: new Date().toISOString() },
      label: `Purchase ${rupees(total)} from ${s.name}`,
      preview: { total, paid },
    });
    for (const l of purchase.lines) {
      if (l.isNew) {
        await catalogUpsert({ id: null, barcode: l.barcode, name: l.name, price: l.price, cost: l.unit_cost, hsn: l.hsn, unit: l.unit,
          gst_rate: l.gst_rate, low_stock: l.low_stock, quantity: l.quantity });
      } else {
        await catalogChangeQty(l.barcode, l.quantity);
      }
    }
    done('Purchase saved offline — will sync when internet is back');
  }
};

async function startStockIn(barcode) {
  stockForm.reset();
  stockForm.barcode.value = barcode;
  try {
    stockProduct = await findProduct(barcode);
  } catch (err) {
    return toast(err.message, true);
  }
  if (returning()) return startReturnLine(barcode);
  if (!stockProduct && !isOwner()) return toast(`Barcode ${barcode} is not in inventory — only the owner can add new products`, true);
  // A new product already scanned onto this bill doesn't need its details asked again.
  const draft = purchase.lines.find((l) => l.barcode === barcode);
  if (!stockProduct && draft) stockProduct = { name: draft.name, price: draft.price, cost: draft.unit_cost, quantity: 0, draft: true };

  const isNew = !stockProduct;
  const buying = inPurchase();
  $('#qty-label').textContent = 'Quantity to add';
  stockForm.dataset.mode = isNew ? 'new' : 'existing';
  $('.new-only', stockForm).classList.toggle('hidden', !isNew);
  $('.quick-only', stockForm).classList.toggle('hidden', buying);
  $('.purchase-only', stockForm).classList.toggle('hidden', !buying);
  stockForm.name.required = stockForm.price.required = isNew;
  stockForm.unit_cost.required = buying;
  if (buying && stockProduct?.cost) stockForm.unit_cost.value = stockProduct.cost / 100;
  $('#stock-submit').textContent = buying ? 'Add to bill' : 'Add to stock';
  $('#stock-title').textContent = isNew ? 'New product' : stockProduct.name;
  $('#stock-current').textContent = isNew
    ? `Barcode ${barcode} — enter details once, next time it's one scan.`
    : stockProduct.draft
      ? `Barcode ${barcode} · already on this bill`
      : `Barcode ${barcode} · ${rupees(stockProduct.price)} · ${stockProduct.quantity} in stock${stockProduct.cached ? ' (saved copy)' : ''}`;
  stockForm.classList.remove('hidden');
  $('#stock-hint').classList.add('hidden');
  (isNew ? stockForm.name : stockForm.quantity).focus();
  setQtyStep(stockForm.dataset.mode === 'new' ? stockForm.unit.value : stockProduct.unit);
  stockForm.quantity.select();
}

// Return mode: the product must already exist; cost comes from the linked bill, else its cost price.
function startReturnLine(barcode) {
  if (!stockProduct) return toast(`Barcode ${barcode} is not in your inventory — nothing to return`, true);
  const billLine = purchase.bill?.returnable.find((l) => l.barcode === barcode);
  if (purchase.bill && !billLine) {
    return toast(`${stockProduct.name} is not on ${purchase.bill.invoice_no ? 'invoice ' + purchase.bill.invoice_no : 'that bill'}`, true);
  }
  stockForm.dataset.mode = 'existing';
  $('.new-only', stockForm).classList.add('hidden');
  $('.quick-only', stockForm).classList.add('hidden');
  $('.purchase-only', stockForm).classList.remove('hidden');
  stockForm.name.required = stockForm.price.required = false;
  stockForm.unit_cost.required = true;
  stockForm.unit_cost.value = (billLine?.unit_cost ?? stockProduct.cost) / 100;
  $('#qty-label').textContent = 'Quantity to return';
  $('#stock-submit').textContent = 'Add to return';
  $('#stock-title').textContent = stockProduct.name;
  $('#stock-current').textContent = `${stockProduct.quantity} in stock${stockProduct.cached ? ' (saved copy)' : ''}`
    + (billLine ? ` · ${billLine.returnable} of ${billLine.bought} on this bill can be returned` : '');
  stockForm.classList.remove('hidden');
  $('#stock-hint').classList.add('hidden');
  stockForm.quantity.focus();
  setQtyStep(stockForm.dataset.mode === 'new' ? stockForm.unit.value : stockProduct.unit);
  stockForm.quantity.select();
}

function closeStockForm() {
  stockForm.classList.add('hidden');
  $('#stock-hint').classList.remove('hidden');
}

function addPurchaseLine(f) {
  const quantity = readQty(f.quantity.value);
  const unit_cost = toPaise(f.unit_cost.value);
  const unit = f.dataset.mode === 'new' ? f.unit.value : stockProduct.unit;
  const problem = quantityProblem(f.dataset.mode === 'new' ? f.name.value.trim() || 'This item' : stockProduct.name, unit, quantity);
  if (problem) return toast(problem, true);
  const barcode = f.barcode.value;
  const line = purchase.lines.find((l) => l.barcode === barcode);
  if (returning()) {
    const want = (line?.quantity ?? 0) + quantity;
    const billLine = purchase.bill?.returnable.find((l) => l.barcode === barcode);
    if (billLine && want > billLine.returnable) return toast(`Only ${billLine.returnable} can be returned from this bill`, true);
    if (!stockProduct.cached && want > stockProduct.quantity) return toast(`Only ${stockProduct.quantity} in stock`, true);
  }
  if (line) {
    line.quantity = round3(line.quantity + quantity);
    line.unit_cost = unit_cost;
  } else {
    purchase.lines.push(f.dataset.mode === 'new'
      ? { barcode, quantity, unit_cost, isNew: true, name: f.name.value.trim(), price: toPaise(f.price.value),
          hsn: f.hsn.value.trim() || undefined, unit: f.unit.value,
          gst_rate: Number(f.gst_rate.value), low_stock: parseInt(f.low_stock.value, 10) || 0 }
      : { barcode, quantity, unit_cost, isNew: false, name: stockProduct.name, unit: stockProduct.unit });
  }
  savePurchaseDraft();
  renderPurchase();
  toast(`${line?.name ?? purchase.lines.at(-1).name} ×${quantity} added to ${returning() ? 'return' : 'bill'}`);
  closeStockForm();
}

// Whole numbers for packets and pieces; up to 3 decimals for KGS, LTR, MTR.
function setQtyStep(unit) {
  const loose = isLoose(unit);
  Object.assign(stockForm.quantity, { step: loose ? '0.001' : '1', min: loose ? '0.001' : '1', inputMode: loose ? 'decimal' : 'numeric' });
  stockForm.low_stock.step = loose ? '0.001' : '1';
  $('#qty-unit').textContent = loose ? `(${UNIT_SHORT[unit]})` : '';
}
stockForm.unit.addEventListener('change', () => setQtyStep(stockForm.unit.value));

$('#stock-cancel').onclick = closeStockForm;
stockForm.onsubmit = async (e) => {
  e.preventDefault();
  const f = stockForm;
  if (inPurchase()) return addPurchaseLine(f);
  const body = { barcode: f.barcode.value, quantity: readQty(f.quantity.value), client_id: newClientId() };
  const problem = quantityProblem(f.dataset.mode === 'new' ? f.name.value.trim() || 'This item' : stockProduct.name,
    f.dataset.mode === 'new' ? f.unit.value : stockProduct.unit, body.quantity);
  if (problem) return toast(problem, true);
  if (f.dataset.mode === 'new') {
    Object.assign(body, {
      name: f.name.value,
      price: toPaise(f.price.value),
      cost: toPaise(f.cost.value),
      gst_rate: Number(f.gst_rate.value),
      low_stock: parseInt(f.low_stock.value, 10) || 0,
      hsn: f.hsn.value.trim() || undefined,
      unit: f.unit.value,
    });
  }
  try {
    if ((await getOutbox()).length) await trySync();
    const { product, created } = await api('/stock-in', { method: 'POST', body });
    await catalogUpsert(product);
    toast(`${created ? 'Added' : 'Restocked'} ${product.name} — now ${fmtQty(product.quantity, product.unit)} in stock`);
    closeStockForm();
  } catch (err) {
    if (!err.offline) return toast(err.message, true);
    const name = stockProduct?.name ?? body.name;
    await enqueue({ kind: 'stock_in', path: '/stock-in', body, label: `Stock in: ${name} +${body.quantity}` });
    // Make the product sellable on this phone right away.
    await catalogUpsert(stockProduct
      ? { ...stockProduct, cached: undefined, quantity: stockProduct.quantity + body.quantity }
      : { id: null, barcode: body.barcode, name: body.name, price: body.price, cost: body.cost, gst_rate: body.gst_rate, hsn: body.hsn, unit: body.unit,
          low_stock: body.low_stock, quantity: body.quantity });
    toast(`Saved offline: ${name} +${body.quantity}`);
    closeStockForm();
  }
};

// --- inventory ----------------------------------------------------------

let invTimer;
async function loadInventory() {
  const q = $('#inv-search').value.trim();
  const low = $('#inv-low').checked;
  let products, stale = false;
  try {
    products = await api('/products');
    await saveCatalog(products);
  } catch (err) {
    if (!err.offline) return toast(err.message, true);
    products = await getCatalog();
    stale = true;
  }
  const needle = q.toLowerCase();
  products = products
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.barcode.includes(q))
    .filter((p) => !low || p.quantity <= p.low_stock)
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#inv-list').innerHTML = (stale ? OFFLINE_NOTE : '') + (products.length
    ? products.map((p) => `
      <li class="tap${p.id === null ? ' pending' : ''}" data-id="${p.id ?? ''}">
        <div class="grow">
          <div class="title">${esc(p.name)}</div>
          <div class="sub">${esc(p.barcode)} · ${rupees(p.price)}${p.id === null ? ' · not synced yet' : ''}</div>
        </div>
        ${stockBadge(p)}
      </li>`).join('')
    : '<p class="empty">No products yet. Use Stock in to scan your first item.</p>');
}
$('#inv-search').oninput = () => {
  clearTimeout(invTimer);
  invTimer = setTimeout(loadInventory, 250);
};
$('#inv-low').onchange = loadInventory;
$('#inv-list').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (!li.dataset.id) return toast('This product syncs when the internet is back', true);
  if (!isOwner()) return toast('Only the owner can change products', true);
  editProduct(Number(li.dataset.id)).catch((err) =>
    toast(err.offline ? 'Editing products needs internet' : err.message, true));
};

async function editProduct(id) {
  const [p, moves] = await Promise.all([api(`/products/${id}`), api(`/products/${id}/movements`)]);
  const REASON = { stock_in: 'Stock in', sale: 'Sold', adjustment: 'Adjusted', purchase_return: 'Returned to supplier', sale_return: 'Customer return' };
  openModal(`
    <form id="edit-form">
      <h2>${esc(p.name)}</h2>
      <p class="muted">${esc(p.barcode)} · ${stockBadge(p)}</p>
      <label>Name<input name="name" value="${esc(p.name)}" required></label>
      <div class="grid2">
        <label>Selling price ₹<input name="price" type="number" step="0.01" min="0" value="${p.price / 100}" required></label>
        <label>Cost price ₹<input name="cost" type="number" step="0.01" min="0" value="${p.cost / 100}"></label>
        <label>GST %<select name="gst_rate" data-gst-rates data-value="${GST_RATES.includes(p.gst_rate) ? p.gst_rate : ''}"></select></label>
        <label>Low-stock alert<input name="low_stock" type="number" min="0" value="${p.low_stock}"></label>
        <label>HSN code<input name="hsn" inputmode="numeric" maxlength="8" value="${esc(p.hsn ?? '')}" placeholder="e.g. 0902"></label>
        <label>Unit<select name="unit" data-units data-value="${esc(p.unit ?? 'NOS')}"></select></label>
      </div>
      ${GST_RATES.includes(p.gst_rate) ? '' : `<p class="notice">${p.gst_rate}% is no longer a GST rate. Pick the current rate for this item.</p>`}
      <label>Correct stock (damaged, lost, recount): + or − units
        <input name="change" type="number" step="any" inputmode="decimal" placeholder="${isLoose(p.unit) ? 'e.g. -0.25' : 'e.g. -2'}"></label>
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Close</button>
        <button class="btn primary">Save</button>
      </div>
      <h2>History</h2>
      <ul class="list">${moves.map((m) => `
        <li><div class="grow"><div>${REASON[m.reason]}${m.sale_id ? ` · Bill #${m.sale_id}` : ''}</div>
        <div class="sub">${localTime(m.created_at)}${m.note ? ' · ' + esc(m.note) : ''}</div></div>
        <strong>${m.change > 0 ? '+' : ''}${m.change}</strong></li>`).join('')}</ul>
    </form>`);
  const form = $('#edit-form');
  fillPickers(form);
  $('[data-close]', form).onclick = () => modal.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      let updated = await api(`/products/${id}`, {
        method: 'PATCH',
        body: {
          name: form.name.value,
          price: toPaise(form.price.value),
          cost: toPaise(form.cost.value),
          gst_rate: Number(form.gst_rate.value) || 0,
          low_stock: parseInt(form.low_stock.value, 10) || 0,
          hsn: form.hsn.value.trim(),
          unit: form.unit.value,
        },
      });
      const change = readQty(form.change.value);
      if (change) updated = await api(`/products/${id}/stock`, { method: 'POST', body: { change, reason: 'adjustment', note: 'Manual correction' } });
      await catalogUpsert(updated);
      modal.close();
      toast('Saved');
      loadInventory();
    } catch (err) {
      toast(err.offline ? 'Editing products needs internet' : err.message, true);
    }
  };
}

// --- khata: udhaar from customers, dues to suppliers --------------------

const SIDES = {
  customer: {
    path: '/customers', noun: 'customer', totalLabel: 'Total udhaar outstanding', add: '+ Add customer / opening balance',
    none: 'No pending udhaar. 🎉', empty: 'No customers yet.', openingLabel: 'Already owes you (from your old khata) ₹',
    methods: ['cash', 'upi', 'card'], payLabel: 'Payment received ₹', payKind: 'payment',
    types: { opening: 'Opening balance', credit_sale: 'Udhaar bill', payment: 'Payment received', return: 'Returned goods' },
    paidMsg: (amount, name) => `Recorded ${amount} from ${name}`,
  },
  supplier: {
    path: '/suppliers', noun: 'supplier', totalLabel: 'Total you owe suppliers', add: '+ Add supplier / opening balance',
    none: 'Nothing owed to suppliers.', empty: 'No suppliers yet. Pick "New supplier" in Stock in when a delivery arrives.',
    openingLabel: 'You already owe them ₹', methods: ['cash', 'upi', 'bank', 'cheque'], payLabel: 'Amount paid ₹',
    payKind: 'supplier_payment',
    types: { opening: 'Opening balance', purchase: 'Purchase bill', payment: 'Paid', return: 'Returned goods', refund: 'Cash back for return' },
    paidMsg: (amount, name) => `Recorded ${amount} paid to ${name}`,
  },
};
let khataSide = 'customer';

// Ledger entry types that reduce a balance.
const reduces = (type) => type === 'payment' || type === 'return';

const sameParty = (party, name, phone) =>
  party.phone && phone ? digits(phone) === party.phone : !phone && name?.toLowerCase() === party.name.toLowerCase();

// Balance changes that are queued on this phone but not on the server yet.
async function pendingBalanceDelta(side, party) {
  let delta = 0;
  for (const e of await getOutbox()) {
    if (e.error) continue;
    const b = e.body;
    if (e.kind === SIDES[side].payKind && e.party_id === party.id) delta -= b.amount;
    if (side === 'customer' && e.kind === 'sale' && b.payment_method === 'credit' && sameParty(party, b.customer_name, b.customer_phone)) {
      delta += e.preview.total;
    }
    if (side === 'customer' && e.kind === 'sale_return' && b.refund_method === 'khata'
      && (e.preview.customer_id ? e.preview.customer_id === party.id : sameParty(party, b.customer_name, b.customer_phone))) {
      delta -= e.preview.total;
    }
    if (side === 'supplier' && e.kind === 'return' && b.supplier_id === party.id && b.settlement === 'adjust') {
      delta -= e.preview.total;
    }
    if (side === 'supplier' && e.kind === 'purchase'
      && (b.supplier_id ? b.supplier_id === party.id : sameParty(party, b.supplier_name, b.supplier_phone))) {
      delta += e.preview.total - e.preview.paid;
    }
  }
  return delta;
}

async function loadKhata() {
  const side = SIDES[khataSide];
  let parties, stale;
  try {
    ({ data: parties, stale } = await cachedGet(side.path));
  } catch (err) {
    return toast(err.message, true);
  }
  parties = parties ?? [];
  for (const c of parties) c.shown = c.balance + (await pendingBalanceDelta(khataSide, c));
  if (khataSide === 'customer') fillCustomerList();
  else fillSupplierSelect();

  const needle = $('#khata-search').value.trim().toLowerCase();
  const dueOnly = $('#khata-due-only').checked;
  const shown = parties
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.phone ?? '').includes(needle))
    .filter((c) => !dueOnly || c.shown > 0)
    .sort((a, b) => b.shown - a.shown);
  $('#khata-total').textContent = rupees(parties.reduce((s, c) => s + Math.max(c.shown, 0), 0));
  $('#khata-total-label').textContent = side.totalLabel;
  $('#add-party').textContent = side.add;
  $('#khata-list').innerHTML = (stale ? OFFLINE_NOTE : '') + (shown.length
    ? shown.map((c) => `
      <li class="tap" data-id="${c.id}">
        <div class="grow">
          <div class="title">${esc(c.name)}</div>
          <div class="sub">${c.phone ? esc(c.phone) : 'No phone'}${c.last_activity ? ' · last ' + localTime(c.last_activity) : ''}</div>
        </div>
        ${c.shown > 0 ? `<span class="amount-due">${rupees(c.shown)}</span>`
          : c.shown < 0 ? `<span class="amount-credit">Credit ${rupees(-c.shown)}</span>`
          : '<span class="amount-clear">Clear</span>'}
      </li>`).join('')
    : `<p class="empty">${dueOnly && parties.length ? side.none : side.empty}</p>`);
}

$('#khata-side').onclick = (e) => {
  const btn = e.target.closest('button[data-side]');
  if (!btn) return;
  khataSide = btn.dataset.side;
  $('#khata-side').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  loadKhata();
};
let khataTimer;
$('#khata-search').oninput = () => {
  clearTimeout(khataTimer);
  khataTimer = setTimeout(loadKhata, 250);
};
$('#khata-due-only').onchange = loadKhata;
$('#khata-list').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openParty(khataSide, Number(li.dataset.id));
};
$('#add-party').onclick = () => partyForm(khataSide, { allowOffline: false }, () => loadKhata());

// Add a customer or supplier. Offline, a supplier can still be used on a purchase:
// it is created on the server when that purchase syncs.
function partyForm(sideKey, { allowOffline }, onDone) {
  const side = SIDES[sideKey];
  openModal(`
    <form id="party-form">
      <h2>Add ${side.noun}</h2>
      <label>Name<input name="name" required autocomplete="off"></label>
      <label>Phone<input name="phone" inputmode="tel" autocomplete="off"></label>
      ${sideKey === 'supplier' ? '<label>GSTIN (optional)<input name="gstin" autocomplete="off"></label>' : ''}
      ${isOwner() ? `<label>${side.openingLabel}<input name="opening" type="number" min="0" step="0.01" inputmode="decimal" value="0"></label>` : ''}
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
  const form = $('#party-form');
  $('[data-close]', form).onclick = () => {
    modal.close();
    onDone(null);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: form.name.value.trim(),
      phone: form.phone.value.trim() || undefined,
      gstin: form.gstin?.value.trim() || undefined,
      opening_balance: toPaise(form.opening?.value),
    };
    try {
      const party = await api(side.path, { method: 'POST', body });
      await cachedGet(side.path).catch(() => {});
      modal.close();
      toast(`${party.name} added`);
      onDone(party);
    } catch (err) {
      if (!err.offline) return toast(err.message, true);
      if (!allowOffline) return toast(`Adding a ${side.noun} needs internet`, true);
      if (body.opening_balance) return toast('Opening balance needs internet — set it to 0 for now', true);
      modal.close();
      toast(`${body.name} will be created when this purchase syncs`);
      onDone({ id: null, name: body.name, phone: body.phone });
    }
  };
}

async function openParty(sideKey, id) {
  const side = SIDES[sideKey];
  let c, offline = false;
  try {
    c = await api(`${side.path}/${id}`);
  } catch (err) {
    if (!err.offline) return toast(err.message, true);
    c = ((await kvGet('get:' + side.path)) ?? []).find((x) => x.id === id);
    if (!c) return;
    offline = true;
  }
  const balance = c.balance + (await pendingBalanceDelta(sideKey, c));
  const invoices = Object.fromEntries((c.purchases ?? []).map((p) => [p.id, p.invoice_no]));
  const reminder = `Hello ${c.name}, this is a reminder from ${shopName()} that ${rupees(balance)} is due. Thank you!`;
  const contact = !c.phone || balance <= 0 ? ''
    : sideKey === 'customer'
      ? `<a class="btn" href="${whatsappLink(c.phone, reminder)}" target="_blank" rel="noopener">Remind</a>`
      : `<a class="btn" href="tel:${esc(c.phone)}">Call</a>`;
  openModal(`
    <form id="pay-form">
      <h2>${esc(c.name)}</h2>
      <p class="muted">${c.phone ? esc(c.phone) : 'No phone'}${c.gstin ? ' · GSTIN ' + esc(c.gstin) : ''}</p>
      <div class="row total"><span>${balance < 0 ? (sideKey === 'customer' ? 'Advance with you' : 'They owe you') : sideKey === 'customer' ? 'Balance due' : 'You owe'}</span>
        <strong class="${balance > 0 ? 'amount-due' : balance < 0 ? 'amount-credit' : ''}">${rupees(Math.abs(balance))}</strong></div>
      ${balance !== c.balance ? '<p class="muted">Includes entries waiting to sync.</p>' : ''}
      ${balance > 0 ? `
        <label>${side.payLabel}<input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${balance / 100}" required></label>
        <div class="pay-methods">${side.methods.map((m, i) => `
          <label><input type="radio" name="method" value="${m}"${i ? '' : ' checked'}> ${PAY_LABEL[m]}</label>`).join('')}
        </div>` : ''}
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Close</button>
        ${contact}
        ${balance > 0 ? '<button class="btn primary">Record payment</button>' : ''}
      </div>
      ${sideKey === 'supplier' ? `<div class="actions">
        <button class="btn" type="button" data-return>↩ Return goods</button>
        <button class="btn" type="button" data-report>📊 Report</button>
      </div>` : ''}
      <h2>Khata</h2>
      ${offline ? '<p class="notice">Offline — full history shows when the internet is back.</p>' : ''}
      <ul class="list">${(c.entries ?? []).map((e) => `
        <li><div class="grow">
          <div>${side.types[e.type]}${e.sale_id ? ` · Bill #${e.sale_id}` : ''}${e.purchase_id && e.type === 'purchase' ? ` · ${invoices[e.purchase_id] ? 'Invoice ' + esc(invoices[e.purchase_id]) : 'Purchase #' + e.purchase_id}` : ''}${e.method ? ` · ${PAY_LABEL[e.method]}` : ''}</div>
          <div class="sub">${localTime(e.created_at)}${e.note ? ' · ' + esc(e.note) : ''}</div></div>
          <strong class="${reduces(e.type) ? 'amount-clear' : 'amount-due'}">${reduces(e.type) ? '−' : '+'}${rupees(e.amount)}</strong>
        </li>`).join('')}</ul>
    </form>`);
  const form = $('#pay-form');
  $('[data-close]', form).onclick = () => modal.close();
  if (sideKey === 'supplier') {
    $('[data-return]', form).onclick = () => {
      modal.close();
      startReturn(c);
    };
    $('[data-report]', form).onclick = () => openSupplierReport(c.id, periodRange('month'));
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const amount = toPaise(form.amount.value);
    if (amount > balance) return toast(`Balance is only ${rupees(balance)}`, true);
    const path = `${side.path}/${id}/payments`;
    const body = { amount, method: form.method.value, client_id: newClientId() };
    try {
      if ((await getOutbox()).length) await trySync();
      await api(path, { method: 'POST', body });
      toast(side.paidMsg(rupees(amount), c.name));
    } catch (err) {
      if (!err.offline) return toast(err.message, true);
      await enqueue({
        kind: side.payKind, party_id: id, path,
        body: { ...body, created_at: new Date().toISOString() },
        label: `${sideKey === 'customer' ? 'Payment from' : 'Payment to'} ${c.name} ${rupees(amount)}`,
      });
      toast('Payment saved offline — will sync later');
    }
    modal.close();
    loadKhata();
  };
}

// --- sales --------------------------------------------------------------

function startOfTodayUtc() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function loadSales() {
  let s, sales, stale;
  try {
    const [a, b] = await Promise.all([cachedGet('/summary?since=' + encodeURIComponent(startOfTodayUtc())), cachedGet('/sales?limit=50')]);
    s = a.data;
    sales = b.data ?? [];
    stale = a.stale || b.stale;
  } catch (err) {
    return toast(err.message, true);
  }
  const pending = (await getOutbox()).filter((e) => e.kind === 'sale');
  const pendingTotal = pending.reduce((sum, e) => sum + e.preview.total, 0);
  $('#summary').innerHTML = (stale ? OFFLINE_NOTE : '') + (s?.own ? `
    <div><strong>${rupees(s.revenue + pendingTotal)}</strong><span>Your sales today${pending.length ? ' (incl. offline)' : ''}</span></div>
    <div><strong>${s.bills + pending.length}</strong><span>Your bills today</span></div>
    ${s.returns ? `<div><strong>${rupees(s.refunds)}</strong><span>Your refunds today</span></div>
      <div><strong>${s.returns.daily ? rupees(s.returns.left_today) : '—'}</strong><span>Returns you can still take today${s.returns.daily ? '' : ' (no daily cap)'}</span></div>` : ''}` : s ? `
    <div><strong>${rupees(s.revenue - (s.refunds ?? 0) + pendingTotal)}</strong><span>Today's sales${s.refunds ? `, after ${rupees(s.refunds)} returns` : ''}${pending.length ? ' (incl. offline)' : ''}</span></div>
    <div><strong>${s.bills + pending.length}</strong><span>Bills today</span></div>
    <div><strong>${rupees(s.udhaar_due)}</strong><span>Customers owe you</span></div>
    <div><strong>${rupees(s.supplier_due ?? 0)}</strong><span>You owe suppliers</span></div>
    <div><strong>${rupees(s.stock_value)}</strong><span>Stock value (${s.units} units)</span></div>
    <div><strong>${s.low_stock}</strong><span>Low-stock items</span></div>
    ${pending.length ? `<div><strong>${pending.length}</strong><span>Bills waiting to sync</span></div>` : ''}` : '');
  const rows = [
    ...pending.map((e, i) => ({ ...e.preview, pendingIndex: i })).reverse(),
    ...sales,
  ];
  $('#sales-list').innerHTML = rows.length
    ? rows.map((b) => `
      <li class="tap${b.id ? '' : ' pending'}" ${b.id ? `data-id="${b.id}"` : `data-pending="${b.pendingIndex}"`}>
        <div class="grow">
          <div class="title">${b.id ? esc(b.invoice_no ?? `Bill #${b.id}`) : 'Not synced yet'}${b.customer_name ? ' · ' + esc(b.customer_name) : ''}</div>
          <div class="sub">${localTime(b.created_at)} · ${PAY_LABEL[b.payment_method]}${isOwner() && b.user_name ? ' · ' + esc(b.user_name) : ''}</div>
        </div>
        <strong>${rupees(b.total)}</strong>
      </li>`).join('')
    : '<p class="empty">No bills yet.</p>';
}
$('#sales-list').onclick = async (e) => {
  const li = e.target.closest('li[data-id], li[data-pending]');
  if (!li) return;
  if (li.dataset.pending !== undefined) {
    const pending = (await getOutbox()).filter((x) => x.kind === 'sale');
    return showReceipt(pending[Number(li.dataset.pending)].preview);
  }
  try {
    showReceipt(await api('/sales/' + li.dataset.id));
  } catch (err) {
    toast(err.offline ? 'Opening old bills needs internet' : err.message, true);
  }
};

// --- supplier reports ---------------------------------------------------

const toSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// Local calendar periods → UTC bounds the server understands. `to` is exclusive.
function periodRange(key) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const at = (yy, mm) => new Date(yy, mm, 1);
  const [from, to] = {
    month: [at(y, m), at(y, m + 1)],
    'last-month': [at(y, m - 1), at(y, m)],
    quarter: [at(y, m - 2), at(y, m + 1)],
    // Indian financial year: 1 April to 31 March.
    fy: m >= 3 ? [at(y, 3), at(y + 1, 3)] : [at(y - 1, 3), at(y, 3)],
    all: [at(2000, 0), at(y + 1, 0)],
  }[key];
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    from: toSql(from), to: toSql(to),
    label: $(`#report-period option[value="${key}"]`).textContent,
    tag: `${day(from)}_${day(new Date(to - 1))}`, // local dates for file names, end inclusive
  };
}
const periodQuery = ({ from, to }) => `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

let reportSide = 'sales';
$('#report-side').onclick = (e) => {
  const btn = e.target.closest('button[data-side]');
  if (!btn) return;
  reportSide = btn.dataset.side;
  $('#report-side').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  loadReports();
};
function loadReports() {
  $('#sales-panel').classList.toggle('hidden', reportSide !== 'sales');
  $('#profit-report').classList.toggle('hidden', reportSide !== 'profit');
  $('#supplier-report').classList.toggle('hidden', reportSide !== 'suppliers');
  $('#gst-report').classList.toggle('hidden', reportSide !== 'gst');
  $('#report-toolbar').classList.toggle('hidden', reportSide === 'sales' || reportSide === 'gst');
  return { sales: loadSales, profit: loadProfit, suppliers: loadSupplierReport, gst: loadGst }[reportSide]();
}

// --- GSTR-1 ---------------------------------------------------------------

const GST_SECTIONS = [
  ['b2b', 'B2B invoices', 'Sales to GST-registered buyers, invoice by invoice'],
  ['b2cl', 'B2C large', 'Inter-state sales to unregistered buyers above ₹1 lakh'],
  ['b2cs', 'B2C small', 'All other sales, by state and rate (net of credit notes)'],
  ['cdnr', 'Credit notes — registered', 'Returns against B2B invoices'],
  ['cdnur', 'Credit notes — unregistered', 'Returns against B2C large invoices'],
  ['hsn_b2b', 'HSN summary — B2B', 'Table 12, B2B tab'],
  ['hsn_b2c', 'HSN summary — B2C', 'Table 12, B2C tab'],
  ['docs', 'Documents issued', 'Table 13: number ranges and cancelled'],
];

function fillGstMonths() {
  const sel = $('#gst-month');
  if (sel.options.length) return;
  const now = new Date();
  for (let i = 0; i < 13; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    sel.add(new Option(d.toLocaleString('en-IN', { month: 'long', year: 'numeric' }), v));
  }
  // Returns are filed for the month gone by.
  sel.selectedIndex = now.getDate() <= 11 ? 1 : 0;
}

let gstData = null;
async function loadGst() {
  fillGstMonths();
  let stale;
  try {
    ({ data: gstData, stale } = await cachedGet('/reports/gstr1?month=' + $('#gst-month').value));
  } catch (err) {
    return toast(err.message, true);
  }
  if (!gstData) {
    $('#gst-totals').innerHTML = OFFLINE_NOTE;
    $('#gst-sections').innerHTML = '';
    return;
  }
  const t = gstData.summary;
  $('#gst-totals').innerHTML = (stale ? OFFLINE_NOTE : '') + (gstData.registered ? '' : '<p class="notice">GST registration is off in Settings, so these bills are not tax invoices.</p>') + `
    <div><strong>${rupees(t.taxable)}</strong><span>Taxable value (${t.invoices} invoice${t.invoices === 1 ? '' : 's'}, ${t.credit_notes} credit note${t.credit_notes === 1 ? '' : 's'})</span></div>
    <div><strong>${rupees(t.tax)}</strong><span>Output tax</span></div>
    <div><strong>${rupees(t.cgst)} + ${rupees(t.sgst)}</strong><span>CGST + SGST</span></div>
    <div><strong>${rupees(t.igst)}</strong><span>IGST</span></div>`;
  $('#gst-warnings').innerHTML = gstData.warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join('');
  $('#gst-sections').innerHTML = GST_SECTIONS.map(([key, title, help]) => {
    const rows = gstData[key];
    return `<li>
      <div class="grow"><div class="title">${title} <span class="badge">${rows.length} row${rows.length === 1 ? '' : 's'}</span></div>
        <div class="sub">${help}</div></div>
      <button class="btn" data-gst-csv="${key}" ${rows.length ? '' : 'disabled'}>CSV</button>
    </li>`;
  }).join('');
}
$('#gst-month').onchange = loadGst;
$('#gst-sections').onclick = (e) => {
  const key = e.target.dataset.gstCsv;
  if (key) downloadFile(`/reports/gstr1?month=${$('#gst-month').value}&section=${key}&format=csv`);
};
$('#gst-csv-all').onclick = async () => {
  for (const [key] of GST_SECTIONS) {
    if (gstData?.[key]?.length) await downloadFile(`/reports/gstr1?month=${$('#gst-month').value}&section=${key}&format=csv`);
  }
};

// --- profit report ------------------------------------------------------

const TZ_OFFSET = -new Date().getTimezoneOffset(); // minutes east of UTC, e.g. 330 in India
const profitPath = (range) => `/reports/profit?tz=${TZ_OFFSET}&${periodQuery(range)}`;
let profitData = null;

async function loadProfit() {
  let stale;
  try {
    ({ data: profitData, stale } = await cachedGet(profitPath(periodRange($('#report-period').value))));
  } catch (err) {
    return toast(err.message, true);
  }
  if (!profitData) {
    $('#profit-totals').innerHTML = OFFLINE_NOTE;
    $('#profit-days').innerHTML = '';
    $('#profit-list').innerHTML = '<p class="empty">Open this report once while online to keep a copy.</p>';
    return;
  }
  const t = profitData.summary;
  $('#profit-totals').innerHTML = (stale ? OFFLINE_NOTE : '') + `
    <div><strong>${rupees(t.net_sales)}</strong><span>Net sales (${t.bills} bill${t.bills === 1 ? '' : 's'}${t.returns ? `, after ${rupees(t.returns)} returns` : ''})</span></div>
    <div><strong>${rupees(t.cogs)}</strong><span>Cost of goods sold</span></div>
    <div><strong class="${t.gross_profit < 0 ? 'amount-loss' : ''}">${rupees(t.gross_profit)}</strong><span>Gross profit</span></div>
    <div><strong>${t.margin_pct === null ? '—' : t.margin_pct + '%'}</strong><span>Margin</span></div>
    ${t.tax ? `<div><strong>${rupees(t.tax)}</strong><span>GST inside sales</span></div>
      <div><strong>${rupees(t.gross_profit - t.tax)}</strong><span>Profit after GST (if you pay GST)</span></div>` : ''}`;
  const warn = $('#profit-warning');
  warn.classList.toggle('hidden', !t.products_without_cost);
  const one = t.products_without_cost === 1;
  warn.textContent = `${t.products_without_cost} product${one ? ' has' : 's have'} no cost price, so ${one ? 'its' : 'their'} `
    + `whole sale shows as profit. Tap ${one ? 'it' : 'them'} below to set a cost price; future sales will use it.`;
  renderProfitDays();
  renderProfitList();
}

// One bar per day (per month for long periods); red bars are days that lost money.
function renderProfitDays() {
  let points = profitData.by_day.map((d) => ({ key: d.day, label: String(Number(d.day.slice(8))), profit: d.gross_profit }));
  if (points.length > 62) {
    const months = new Map();
    for (const d of profitData.by_day) {
      const k = d.day.slice(0, 7);
      months.set(k, (months.get(k) ?? 0) + d.gross_profit);
    }
    points = [...months].map(([key, profit]) => ({
      key, profit, label: new Date(key + '-01T00:00').toLocaleString('en-IN', { month: 'short' }),
    }));
  }
  const max = Math.max(1, ...points.map((p) => Math.abs(p.profit)));
  $('#profit-days').innerHTML = points.length
    ? points.map((p) => `
      <div class="bar${p.profit < 0 ? ' neg' : ''}" title="${p.key}: ${rupees(p.profit)}">
        <i style="height:${Math.round((Math.abs(p.profit) / max) * 70)}px"></i><span>${p.label}</span>
      </div>`).join('')
    : '<p class="empty" style="width:100%">No sales in this period.</p>';
}

function renderProfitList() {
  const sort = $('#profit-sort').value;
  let rows = [...profitData.by_product];
  if (sort === 'margin-low') rows = rows.filter((p) => p.margin_pct !== null).sort((a, b) => a.margin_pct - b.margin_pct);
  if (sort === 'loss') rows = rows.filter((p) => p.gross_profit < 0).sort((a, b) => a.gross_profit - b.gross_profit);
  $('#profit-list').innerHTML = rows.length
    ? rows.map((p) => `
      <li class="tap" data-id="${p.product_id}">
        <div class="grow">
          <div class="title">${esc(p.name)}${p.no_cost ? ' <span class="badge low">no cost price</span>' : ''}</div>
          <div class="sub">${p.qty_sold} sold${p.qty_returned ? ` · ${p.qty_returned} returned` : ''} · sales ${rupees(p.net_sales)}${
            p.margin_pct !== null ? ` · ${p.margin_pct}% margin` : ''}</div>
        </div>
        <strong class="${p.gross_profit < 0 ? 'amount-loss' : ''}">${rupees(p.gross_profit)}</strong>
      </li>`).join('')
    : `<p class="empty">${sort === 'loss' ? 'No product lost money in this period. 👍' : 'No sales in this period.'}</p>`;
}
$('#profit-sort').onchange = () => profitData && renderProfitList();
$('#profit-list').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) editProduct(Number(li.dataset.id)).catch((err) => toast(err.offline ? 'Editing products needs internet' : err.message, true));
};

async function loadSupplierReport() {
  const range = periodRange($('#report-period').value);
  let report, stale;
  try {
    ({ data: report, stale } = await cachedGet('/reports/suppliers?' + periodQuery(range)));
  } catch (err) {
    return toast(err.message, true);
  }
  if (!report) {
    $('#report-totals').innerHTML = OFFLINE_NOTE;
    $('#report-list').innerHTML = '<p class="empty">Open this report once while online to keep a copy.</p>';
    return;
  }
  const t = report.totals;
  const owed = report.rows.reduce((s, r) => s + Math.max(r.balance, 0), 0);
  $('#report-totals').innerHTML = (stale ? OFFLINE_NOTE : '') + `
    <div><strong>${rupees(t.net_purchased)}</strong><span>Net purchases (${t.bills} bill${t.bills === 1 ? '' : 's'})</span></div>
    <div><strong>${rupees(t.returned)}</strong><span>Returned to suppliers</span></div>
    <div><strong>${rupees(t.paid)}</strong><span>Paid to suppliers</span></div>
    <div><strong>${rupees(owed)}</strong><span>You owe now</span></div>`;
  $('#report-list').innerHTML = report.rows.length
    ? report.rows.map((r) => `
      <li class="tap report-row" data-id="${r.id}">
        <div class="grow">
          <div class="title">${esc(r.name)}</div>
          <div class="sub"><span>${r.bills} bill${r.bills === 1 ? '' : 's'}</span>${r.returned ? `<span>returned ${rupees(r.returned)}</span>` : ''}${
            r.paid ? `<span>paid ${rupees(r.paid)}</span>` : ''}<span>${r.balance > 0 ? `owe ${rupees(r.balance)}` : r.balance < 0 ? `credit ${rupees(-r.balance)}` : 'settled'}</span></div>
        </div>
        <strong>${rupees(r.net_purchased)}</strong>
      </li>`).join('')
    : '<p class="empty">No supplier activity in this period.</p>';
}
$('#report-period').onchange = loadReports;
$('#report-list').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openSupplierReport(Number(li.dataset.id), periodRange($('#report-period').value));
};
$('#report-csv').onclick = () => {
  const range = periodRange($('#report-period').value);
  if (reportSide === 'profit') return downloadFile(profitPath(range) + '&format=csv', range.tag);
  downloadFile('/reports/suppliers?format=csv&' + periodQuery(range), range.tag);
};

async function openSupplierReport(id, range) {
  let r;
  try {
    r = await api(`/reports/suppliers/${id}?${periodQuery(range)}`);
  } catch (err) {
    return toast(err.offline ? 'Supplier reports need internet' : err.message, true);
  }
  const s = r.summary;
  openModal(`
    <h2>${esc(r.supplier.name)}</h2>
    <p class="muted">${esc(range.label)}${r.supplier.gstin ? ' · GSTIN ' + esc(r.supplier.gstin) : ''}</p>
    <div class="row"><span>Purchased (${s.bills} bill${s.bills === 1 ? '' : 's'})</span><strong>${rupees(s.purchased)}</strong></div>
    <div class="row"><span>Returned</span><strong>−${rupees(s.returned)}</strong></div>
    <div class="row total"><span>Net purchases</span><strong>${rupees(s.net_purchased)}</strong></div>
    <div class="row"><span>Paid in this period</span><strong>${rupees(s.paid)}</strong></div>
    <div class="row"><span>${r.supplier.balance < 0 ? 'They owe you now' : 'You owe now'}</span>
      <strong class="${r.supplier.balance > 0 ? 'amount-due' : ''}">${rupees(Math.abs(r.supplier.balance))}</strong></div>
    <h2>Items bought</h2>
    <ul class="list">${r.items.map((i) => `
      <li><div class="grow">
        <div class="title">${esc(i.name)}</div>
        <div class="sub">${i.bought_qty} bought${i.avg_cost !== null ? ` · avg ${rupees(i.avg_cost)}` : ''}${i.returned_qty ? ` · ${i.returned_qty} returned` : ''}</div>
      </div><strong>${rupees(i.bought_amount - i.returned_amount)}</strong></li>`).join('') || '<p class="empty">Nothing bought in this period.</p>'}</ul>
    <div class="actions">
      <button class="btn ghost" data-close>Close</button>
      <button class="btn" data-csv>⬇ CSV</button>
    </div>`);
  $('[data-close]', modal).onclick = () => modal.close();
  $('[data-csv]', modal).onclick = () => downloadFile(`/reports/suppliers/${id}?format=csv&${periodQuery(range)}`, range.tag);
}

// Fetch (so the shop PIN header is sent) and hand the file (CSV, backup) to the browser.
// `tag` swaps the server's UTC dates in the file name for the shop's local ones.
async function downloadFile(path, tag) {
  try {
    const res = await fetch('/api' + path, { headers: { 'x-hisaab-pin': localStorage.getItem('hisaab.pin') ?? '', ...authHeader() } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
    let name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report.csv';
    if (tag) name = name.replace(/\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/, `${tag}.csv`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    toast(err instanceof TypeError ? 'Downloading needs internet' : err.message, true);
  }
}

// --- settings -----------------------------------------------------------

async function openSettings() {
  await loadShop();
  const device = await kvGet('device');
  const series = `<p class="muted">This phone's invoice series: <strong>${device ? esc(device.code) : 'not set up yet — connect to the internet once'}</strong>.</p>`;
  const account = me ? `
    <div class="row"><span>Signed in as <strong>${esc(me.name)}</strong> (${me.role})</span>
      <button class="btn" type="button" data-signout>Switch user</button></div>` : '';
  if (!isOwner()) {
    openModal(`<h2>${esc(shopName())}</h2>${account}${series}
      <div class="actions"><button class="btn primary" data-close>Close</button></div>`);
    $('[data-close]', modal).onclick = () => modal.close();
    $('[data-signout]', modal).onclick = signOut;
    return;
  }
  openModal(`
    <form id="settings-form">
      ${account}
      <div class="settings-section">
        ${globalThis.HISAAB_DEMO
          ? '<p class="notice">This is the demo: everything is saved in this browser only. Owner and cashier logins, shared data across phones and encrypted backups need Hisaab running on your own server.</p>'
          : loginsOn
          ? '<div class="row"><span>People who can sign in</span><button class="btn" type="button" data-people>👥 People</button></div>'
          : `<p class="notice">Anyone who opens this app can see and change everything. Set up an owner login to protect it, then add cashiers.</p>
             <button class="btn wide" type="button" data-setup>🔒 Set up owner login</button>`}
      </div>
      <h2>Shop settings</h2>
      <label class="chip"><input type="checkbox" name="gst_registered" ${shop.gst_registered ? 'checked' : ''}> Registered under GST (regular) — issue tax invoices</label>
      <label>GSTIN<input name="gstin" value="${esc(shop.gstin)}" maxlength="15" autocapitalize="characters" autocomplete="off"></label>
      <label>Legal name (as on GST registration)<input name="legal_name" value="${esc(shop.legal_name)}"></label>
      <label>Shop name on bills (trade name)<input name="trade_name" value="${esc(shop.trade_name)}"></label>
      <label>Address<input name="address" value="${esc(shop.address)}"></label>
      <div class="grid2">
        <label>Phone<input name="phone" value="${esc(shop.phone)}" inputmode="tel"></label>
        <label>Email<input name="email" value="${esc(shop.email)}" inputmode="email"></label>
      </div>
      <label>Last year's turnover
        <select name="hsn_digits">
          <option value="4" ${shop.hsn_digits === 4 ? 'selected' : ''}>Up to ₹5 crore — 4-digit HSN, needed on B2B invoices</option>
          <option value="6" ${shop.hsn_digits === 6 ? 'selected' : ''}>Above ₹5 crore — 6-digit HSN on every invoice</option>
        </select></label>
      <label>Terms printed on invoices (optional)<input name="invoice_terms" value="${esc(shop.invoice_terms)}" placeholder="e.g. Goods once sold will be exchanged within 7 days"></label>
      <div class="settings-section">
        <h2>Cashier returns</h2>
        <p class="muted">Let cashiers take customer returns against a bill, up to these limits. Anything bigger needs you. Set the first to 0 to keep returns owner-only.</p>
        <div class="grid2">
          <label>Most per return ₹<input name="ret_limit" type="number" min="0" step="1" inputmode="numeric" value="${shop.cashier_return_limit / 100}"></label>
          <label>Most per cashier per day ₹ <span class="muted">(0 = no cap)</span><input name="ret_daily" type="number" min="0" step="1" inputmode="numeric" value="${shop.cashier_return_daily_limit / 100}"></label>
          <label>Bill no older than (days)<input name="ret_days" type="number" min="0" max="365" step="1" inputmode="numeric" value="${shop.cashier_return_days}"></label>
        </div>
      </div>
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Close</button>
        <button class="btn primary">Save</button>
      </div>
      <div class="settings-section">
        <p class="muted">This phone's invoice series: <strong>${device ? esc(device.code) : 'not set up yet — connect to the internet once'}</strong>.
          Invoices from it look like ${device ? esc(invoiceNumber(device.code, financialYear(localDate(nowSql(), shop.tz_offset)).short, 1)) : '—'}.</p>
        <p id="backup-health" class="muted">Checking backups…</p>
        <div class="actions">
          ${globalThis.HISAAB_DEMO ? '' : '<button class="btn" type="button" data-backup>🛟 Backups</button>'}
          <button class="btn" type="button" data-audit>Change log</button>
        </div>
      </div>
    </form>`);
  const form = $('#settings-form');
  $('[data-close]', form).onclick = () => modal.close();
  $('[data-signout]', form)?.addEventListener('click', signOut);
  $('[data-people]', form)?.addEventListener('click', openPeople);
  $('[data-setup]', form)?.addEventListener('click', openOwnerSetup);
  $('[data-backup]', form)?.addEventListener('click', openBackups);
  $('[data-audit]', form).onclick = openAuditLog;
  if (!globalThis.HISAAB_DEMO) api('/backup/config').then((b) => {
    const el = $('#backup-health');
    if (!el) return;
    const problem = backupProblem(b);
    el.className = problem ? 'notice' : 'muted';
    el.textContent = problem ?? `Backed up ${localTime(b.status.offsite.last_ok_at.replace('T', ' ').slice(0, 19))}, encrypted and off-site.`;
  }).catch(() => $('#backup-health')?.remove());
  form.onsubmit = async (e) => {
    e.preventDefault();
    const gstin = form.gstin.value.trim().toUpperCase();
    if (gstin && !gstinValid(gstin)) return toast('That GSTIN is not valid — check for a typo', true);
    try {
      shop = await api('/settings', {
        method: 'PUT',
        body: {
          gst_registered: form.gst_registered.checked, gstin, legal_name: form.legal_name.value.trim() || undefined,
          trade_name: form.trade_name.value.trim(), address: form.address.value.trim() || undefined,
          phone: form.phone.value.trim(), email: form.email.value.trim(),
          hsn_digits: Number(form.hsn_digits.value), invoice_terms: form.invoice_terms.value.trim(),
          cashier_return_limit: toPaise(form.ret_limit.value), cashier_return_daily_limit: toPaise(form.ret_daily.value),
          cashier_return_days: parseInt(form.ret_days.value, 10) || 0,
        },
      });
      await kvSet('get:/settings', shop);
      await loadShop();
      fillPickers();
      modal.close();
      toast('Settings saved');
    } catch (err) {
      toast(err.offline ? 'Saving settings needs internet' : err.message, true);
    }
  };
}

// First owner login. Until this exists the shop has no logins at all.
function openOwnerSetup() {
  openModal(`
    <form id="setup-form">
      <h2>Set up the owner login</h2>
      <p class="muted">You'll use this to sign in on every phone. The owner can see and change everything; add cashiers afterwards.</p>
      <label>Your name<input name="name" required autocomplete="name"></label>
      <label>Username<input name="username" required autocapitalize="none" spellcheck="false" placeholder="e.g. ramesh"></label>
      <label>PIN (6–12 digits)<input name="pin" type="password" inputmode="numeric" pattern="\\d{6,12}" required autocomplete="new-password"></label>
      <label>PIN again<input name="pin2" type="password" inputmode="numeric" required autocomplete="new-password"></label>
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Cancel</button>
        <button class="btn primary">Turn on logins</button>
      </div>
    </form>`);
  const form = $('#setup-form');
  $('[data-close]', form).onclick = () => modal.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.pin.value !== form.pin2.value) return toast('The two PINs are different', true);
    try {
      const { token, user } = await api('/auth/setup', {
        method: 'POST',
        body: { name: form.name.value.trim(), username: form.username.value.trim(), pin: form.pin.value, device_id: (await kvGet('device'))?.id },
      });
      modal.close();
      await signedIn(token, user);
      openPeople();
    } catch (err) {
      toast(err.offline ? 'Setting up logins needs internet' : err.message, true);
    }
  };
}

// Owner: add cashiers (or other owners), reset PINs, switch roles, turn people off.
async function openPeople() {
  let users;
  try {
    users = await api('/users');
  } catch (err) {
    return toast(err.offline ? 'Managing people needs internet' : err.message, true);
  }
  openModal(`
    <h2>People</h2>
    <ul class="list">${users.map((u) => `
      <li class="user-row" data-id="${u.id}">
        <div class="grow">
          <div class="title">${esc(u.name)} <span class="badge ${u.role}">${u.role}</span>${u.active ? '' : ' <span class="badge out">off</span>'}</div>
          <div class="sub">@${esc(u.username)}${u.id === me?.id ? ' · you' : ''}</div>
        </div>
        <button class="btn" data-act="pin">PIN</button>
        <button class="btn" data-act="more">⋯</button>
      </li>`).join('')}</ul>
    <form id="person-form" class="card">
      <h2>Add a person</h2>
      <label>Name<input name="name" required></label>
      <div class="grid2">
        <label>Username<input name="username" required autocapitalize="none" spellcheck="false"></label>
        <label>Role<select name="role"><option value="cashier">Cashier</option><option value="owner">Owner</option></select></label>
      </div>
      <label>PIN (cashier 4–12 digits, owner 6–12)<input name="pin" type="password" inputmode="numeric" required autocomplete="new-password"></label>
      <button class="btn primary wide">Add</button>
    </form>
    <p class="muted">A cashier can bill, take udhaar and payments, add customers, restock, and take returns within the limits in Settings. They can't see cost prices, profit, suppliers or reports, or change prices and settings.</p>
    <div class="actions"><button class="btn ghost" data-close>Close</button></div>`);
  $('[data-close]', modal).onclick = () => modal.close();
  const form = $('#person-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: { name: form.name.value.trim(), username: form.username.value.trim(), role: form.role.value, pin: form.pin.value } });
      toast(`${form.name.value.trim()} can now sign in as ${form.username.value.trim().toLowerCase()}`);
      openPeople();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#modal-body .list').onclick = async (e) => {
    const act = e.target.dataset.act;
    const id = Number(e.target.closest('li[data-id]')?.dataset.id);
    const u = users.find((x) => x.id === id);
    if (!act || !u) return;
    let body;
    if (act === 'pin') {
      const pin = prompt(`New PIN for ${u.name} (${u.role === 'owner' ? '6' : '4'}–12 digits). They'll be signed out everywhere.`);
      if (!pin) return;
      body = { pin };
    } else {
      body = await new Promise((resolve) => {
        openModal(`
          <h2>${esc(u.name)}</h2>
          <p class="muted">@${esc(u.username)} · ${u.role}${u.active ? '' : ' · login turned off'}</p>
          <button class="btn wide" data-pick="role">Make ${u.role === 'owner' ? 'cashier' : 'owner'}</button>
          <button class="btn wide ${u.active ? 'danger' : ''}" data-pick="active">${u.active ? 'Turn off login (signs them out)' : 'Turn login back on'}</button>
          <div class="actions"><button class="btn ghost" data-pick="">Back</button></div>`);
        $('#modal-body').onclick = (ev) => {
          const pick = ev.target.dataset.pick;
          if (pick === undefined) return;
          resolve(pick === 'role' ? { role: u.role === 'owner' ? 'cashier' : 'owner' } : pick === 'active' ? { active: !u.active } : null);
        };
      });
      if (!body) return openPeople();
    }
    try {
      await api(`/users/${id}`, { method: 'PATCH', body });
      toast('Saved');
      if (id === me?.id && (body.pin || body.role || body.active === false)) return showLogin('Your login changed — please sign in again');
      openPeople();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// --- backups ------------------------------------------------------------

// What's wrong with the backups, if anything, in one sentence for the owner.
function backupProblem(b) {
  const lastOk = b.status?.offsite?.last_ok_at;
  if (!b.passphrase_set) return 'Backups are not encrypted and not copied off this computer. Set them up under Backups.';
  if (!b.destination) return 'Backups stay on this computer only — a theft, fire or failed disk would lose them. Add an off-site copy under Backups.';
  if (b.status?.offsite && !b.status.offsite.ok) return `The last off-site backup failed: ${b.status.offsite.error}`;
  if (!lastOk) return 'No off-site backup yet — press Back up now under Backups.';
  if (Date.now() - Date.parse(lastOk) > 2 * 86_400_000) return `The last off-site backup was ${localTime(lastOk.replace('T', ' ').slice(0, 19))}. Check the server is running.`;
  return null;
}

const DEST_FIELDS = {
  s3: [
    ['endpoint', 'Endpoint URL', 'e.g. https://<account-id>.r2.cloudflarestorage.com, https://s3.ap-south-1.amazonaws.com'],
    ['region', 'Region', 'auto for Cloudflare R2; e.g. ap-south-1 for AWS Mumbai'],
    ['bucket', 'Bucket', ''],
    ['prefix', 'Folder in the bucket (optional)', 'e.g. sharma-stores'],
    ['access_key', 'Access key ID', ''],
    ['secret_key', 'Secret access key', '', true],
  ],
  webdav: [
    ['url', 'Folder URL', 'e.g. https://cloud.example.com/remote.php/dav/files/you/Hisaab'],
    ['username', 'Username', ''],
    ['password', 'Password (an app password is best)', '', true],
  ],
  folder: [
    ['path', 'Folder on the computer running Hisaab', 'e.g. a Google Drive, Dropbox or OneDrive folder, or a USB drive'],
  ],
};

async function openBackups() {
  let b;
  try {
    b = await api('/backup/config');
  } catch (err) {
    return toast(err.offline ? 'Backups need internet' : err.message, true);
  }
  const d = b.destination ?? {};
  const when = (iso) => (iso ? localTime(iso.replace('T', ' ').slice(0, 19)) : '—');
  const st = b.status ?? {};
  const fieldsFor = (type) => (DEST_FIELDS[type] ?? []).map(([k, label, hint, secret]) => `
    <label>${label}<input name="d_${k}" ${secret ? 'type="password" autocomplete="new-password"' : 'autocomplete="off"'}
      value="${secret ? '' : esc(d.type === type ? d[k] ?? '' : '')}"
      placeholder="${secret && d.type === type && d[`${k}_set`] ? 'saved — leave empty to keep' : esc(hint)}"></label>`).join('');
  const problem = backupProblem(b);
  openModal(`
    <form id="backup-form">
      <h2>Backups</h2>
      ${problem ? `<p class="notice">${esc(problem)}</p>` : ''}
      <div class="row"><span>Last backup</span><strong>${when(st.local?.at)}${st.local ? (st.local.encrypted ? ' · 🔒 encrypted' : ' · not encrypted') : ''}</strong></div>
      <div class="row"><span>Last off-site copy</span><strong>${st.offsite ? (st.offsite.ok ? `✓ ${when(st.offsite.at)}` : `✗ failed ${when(st.offsite.at)}`) : '—'}</strong></div>
      ${st.offsite?.ok ? `<p class="muted">Sent to ${esc(st.offsite.where)}</p>` : ''}

      <div class="settings-section">
        <h2>1. Passphrase</h2>
        ${b.passphrase_from_server
          ? '<p class="muted">Set on the server (HISAAB_BACKUP_PASSPHRASE).</p>'
          : `<p class="muted">Backups are locked with this passphrase. <strong>Write it down and keep it safe</strong> — without it nobody can open the backups, not even us. ${b.passphrase_set ? 'Leave empty to keep the current one.' : ''}</p>
             <label>${b.passphrase_set ? 'New passphrase' : 'Passphrase'} (12+ characters — a short sentence is easy to remember)
               <input name="pass" type="password" autocomplete="new-password" minlength="12"></label>
             <label>Same passphrase again<input name="pass2" type="password" autocomplete="new-password"></label>`}
      </div>

      <div class="settings-section">
        <h2>2. Off-site copy</h2>
        <label>Send each day's backup to
          <select name="type">
            <option value="">Nowhere — keep on this computer only</option>
            <option value="s3" ${d.type === 's3' ? 'selected' : ''}>Cloud storage (Cloudflare R2, Backblaze B2, Wasabi, AWS S3)</option>
            <option value="webdav" ${d.type === 'webdav' ? 'selected' : ''}>Nextcloud / WebDAV</option>
            <option value="folder" ${d.type === 'folder' ? 'selected' : ''}>A synced folder or USB drive</option>
          </select></label>
        <div id="dest-fields">${fieldsFor(d.type)}</div>
        <p class="muted">Only encrypted backups ever leave this computer.</p>
      </div>

      <div class="actions">
        <button class="btn ghost" type="button" data-close>Close</button>
        <button class="btn primary">Save</button>
      </div>
      <div class="actions">
        <button class="btn" type="button" data-run>Back up now</button>
        <button class="btn" type="button" data-verify>Test restore</button>
        <button class="btn" type="button" data-download>⬇ Download</button>
      </div>
    </form>`);
  const form = $('#backup-form');
  form.type.onchange = () => ($('#dest-fields').innerHTML = fieldsFor(form.type.value));
  $('[data-close]', form).onclick = () => modal.close();
  $('[data-download]', form).onclick = () => downloadFile('/backup');
  const busy = async (btn, label, fn) => {
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = was; }
  };
  $('[data-run]', form).onclick = (e) => busy(e.target, 'Backing up…', async () => {
    try {
      const r = await api('/backup/run', { method: 'POST' });
      const o = r.status.offsite;
      toast(o && o.at === r.status.local.at ? (o.ok ? 'Backed up and copied off-site' : `Backed up here, but the off-site copy failed: ${o.error}`) : 'Backed up on this computer', o && !o.ok);
      openBackups();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('[data-verify]', form).onclick = (e) => busy(e.target, 'Checking…', async () => {
    try {
      const r = await api('/backup/verify', { method: 'POST' });
      toast(r.ok ? `✓ ${r.file} opens fine: ${r.sales} bills, ${r.products} products, ${r.customers} customers` : `Problem: ${r.integrity}`, !r.ok);
    } catch (err) {
      toast(err.message, true);
    }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    if (form.pass?.value) {
      if (form.pass.value !== form.pass2.value) return toast('The two passphrases are different', true);
      if (b.passphrase_set && !confirm('Change the passphrase? Backups made before stay locked with the old one — keep it written down too.')) return;
      body.passphrase = form.pass.value;
    }
    if (form.type.value) {
      body.destination = { type: form.type.value };
      for (const [k] of DEST_FIELDS[form.type.value]) body.destination[k] = form[`d_${k}`].value.trim();
    } else if (b.destination) {
      body.destination = null;
    }
    try {
      await api('/backup/config', { method: 'PUT', body });
      toast('Backup settings saved');
      openBackups();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// Rule 56(8): the log of edits to products, settings and voided numbers.
async function openAuditLog() {
  let rows;
  try {
    rows = await api('/audit-log?limit=200');
  } catch (err) {
    return toast(err.offline ? 'The change log needs internet' : err.message, true);
  }
  const what = (r) => r.changes
    ? Object.entries(r.changes).map(([k, v]) => Array.isArray(v) ? `${k}: ${JSON.stringify(v[0])} → ${JSON.stringify(v[1])}` : `${k}: ${JSON.stringify(v)}`).join(', ')
    : '';
  openModal(`
    <h2>Change log</h2>
    <p class="muted">Every edit to products and settings, and every invoice number that was never issued. Bills, purchases, payments and returns are never edited; corrections are new entries.</p>
    <ul class="list">${rows.map((r) => `<li class="audit-row"><div class="grow">
      <div><strong>${esc(r.entity)}${r.entity_id ? ' #' + r.entity_id : ''}</strong> · ${esc(r.action)}${r.user_name ? ' · by ' + esc(r.user_name) : ''}</div>
      <div class="sub">${localTime(r.created_at)} · ${esc(what(r))}</div></div></li>`).join('') || '<p class="empty">No changes yet.</p>'}</ul>
    <div class="actions"><button class="btn primary" data-close>Close</button></div>`);
  $('[data-close]', modal).onclick = () => modal.close();
}

// --- navigation ---------------------------------------------------------

const onShow = { stock: fillSupplierSelect, inventory: loadInventory, khata: loadKhata, sales: loadReports };
let currentView = 'bill';
function refreshCurrentView() {
  onShow[currentView]?.();
}

function showView(name) {
  stopAllScanners();
  currentView = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  refreshCurrentView();
}

document.querySelector('.tabs').onclick = (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) showView(btn.dataset.view);
};

// Release the camera when the app goes to the background.
document.addEventListener('visibilitychange', () => document.hidden && stopAllScanners());

setupScanner('bill', (code) => (billMode === 'return' ? addToReturn(code) : addToCart(code)));
setupScanner('stock', startStockIn);
$('#shop-status').textContent = shopName();
$('#shop-status').onclick = openSettings;
fillPickers();
renderCart();
renderPurchase();
renderSyncStatus();

// Warm the offline copies: catalog for scanning, customers for udhaar suggestions.
async function start() {
  await loadShop();
  fillPickers();
  await ensureDevice();
  await trySync();
  await refreshCatalog();
  await cachedGet('/customers').catch(() => {});
  if (isOwner()) await cachedGet('/suppliers').catch(() => {});
  fillCustomerList();
  if (isOwner()) {
    purchase = { ...emptyPurchase(), ...((await kvGet('purchase-draft')) ?? {}) };
    fillSupplierSelect();
  }
  renderPurchase();
  if (returning()) fillReturnBills();
  refreshCurrentView();
}

// Who is this? Online, the server says; offline, carry on as whoever last signed in on this phone.
async function boot() {
  let status = null;
  try {
    status = await api('/auth/status');
  } catch { /* offline */ }
  if (status) {
    loginsOn = !status.setup_required;
    me = status.user;
    await kvSet('me', me);
    await kvSet('logins-on', loginsOn);
  } else {
    me = (await kvGet('me')) ?? null;
    loginsOn = (await kvGet('logins-on')) === true;
  }
  await loadShop();
  if (loginsOn && !me) return showLogin(status ? '' : 'You are offline. Signing in needs internet.');
  applyRole();
  await start();
}
boot();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is a bonus, not required */ });
}

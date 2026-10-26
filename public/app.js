import { Scanner, feedback } from './scanner.js';
import {
  kvGet, kvSet, newClientId, nowSql, saveCatalog, getCatalog, catalogFind, catalogUpsert, catalogChangeQty,
  enqueue, getOutbox, onOutboxChange, sync, discard, retry,
} from './offline.js';

// --- helpers ------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const rupees = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toPaise = (v) => Math.round((parseFloat(v) || 0) * 100);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// SQLite stores UTC 'YYYY-MM-DD HH:MM:SS'; show it in local time.
const localTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const digits = (s) => String(s ?? '').replace(/\D/g, '').replace(/^91(\d{10})$/, '$1');
const SHOP_NAME = localStorage.getItem('hisaab.shop') || 'My Shop';
const PAY_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Udhaar' };
const OFFLINE_NOTE = '<p class="notice">Offline — showing the copy saved on this phone.</p>';

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 4000 : 2500);
}

// Throws with err.offline = true when the server can't be reached, so callers can fall back.
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-hisaab-pin': localStorage.getItem('hisaab.pin') ?? '' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    const err = new Error('No internet connection');
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
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
  if (p.quantity <= p.low_stock) return `<span class="badge low">${p.quantity} left</span>`;
  return `<span class="badge">${p.quantity} in stock</span>`;
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
    if (d && confirm('Discard this entry? It will never reach the server.')) await discard(d);
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
  for (const { product, quantity } of cart.values()) subtotal += product.price * quantity;
  const discount = Math.min(toPaise($('#discount').value), subtotal);
  return { subtotal, discount, total: subtotal - discount };
}

function renderCart() {
  const list = $('#cart');
  list.innerHTML = [...cart.values()].map(({ product: p, quantity }) => `
    <li>
      <div class="grow">
        <div class="title">${esc(p.name)}</div>
        <div class="sub">${rupees(p.price)} × ${quantity} = <strong>${rupees(p.price * quantity)}</strong></div>
      </div>
      <div class="qty">
        <button class="btn" data-dec="${esc(p.barcode)}" aria-label="Less">−</button>
        <span>${quantity}</span>
        <button class="btn" data-inc="${esc(p.barcode)}" aria-label="More">+</button>
      </div>
    </li>`).join('');
  const has = cart.size > 0;
  $('#cart-empty').classList.toggle('hidden', has);
  $('#checkout').classList.toggle('hidden', !has);
  const { subtotal, total } = cartTotals();
  $('#subtotal').textContent = rupees(subtotal);
  $('#total').textContent = rupees(total);
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
  } else if (--line.quantity <= 0) {
    cart.delete(line.product.barcode);
  }
  renderCart();
};
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
  const { subtotal, discount, total } = cartTotals();
  const body = {
    items: lines.map(({ product, quantity }) => ({ barcode: product.barcode, quantity })),
    discount, payment_method, customer_name, customer_phone,
    client_id: newClientId(),
  };

  btn.disabled = true;
  try {
    // Anything queued earlier (e.g. a product added offline) must reach the server first.
    if ((await getOutbox()).length) await trySync();
    const sale = await api('/sales', { method: 'POST', body });
    for (const { product, quantity } of lines) await catalogChangeQty(product.barcode, -quantity);
    if (payment_method === 'credit') cachedGet('/customers').then(fillCustomerList, () => {});
    resetBill();
    showReceipt(sale);
  } catch (err) {
    if (!err.offline) return toast(err.message, true);
    // No internet: the sale has happened in the shop, so keep it and sync later.
    const created_at = new Date().toISOString();
    await enqueue({
      kind: 'sale',
      path: '/sales',
      body: { ...body, offline: true, created_at },
      label: `Bill ${rupees(total)} · ${PAY_LABEL[payment_method]}${customer_name ? ' · ' + customer_name : ''}`,
      preview: {
        id: null, subtotal, discount, total, tax: 0, payment_method, customer_name, customer_phone,
        created_at: nowSql(),
        items: lines.map(({ product: p, quantity }) => ({
          name: p.name, quantity, unit_price: p.price, line_total: p.price * quantity,
        })),
      },
    });
    for (const { product, quantity } of lines) await catalogChangeQty(product.barcode, -quantity);
    const sale = (await getOutbox()).at(-1).preview;
    resetBill();
    showReceipt(sale);
    toast('Saved offline — will sync when internet is back');
  } finally {
    btn.disabled = false;
  }
};

function receiptText(sale) {
  const lines = sale.items.map((i) => `${i.name} x${i.quantity} = ${rupees(i.line_total)}`);
  return [
    `${SHOP_NAME} — Bill${sale.id ? ' #' + sale.id : ''}`,
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
  openModal(`
    <div class="receipt">
      <h3>${esc(SHOP_NAME)}</h3>
      <div>${sale.id ? `Bill #${sale.id}` : 'Bill (saved offline, syncs later)'} · ${localTime(sale.created_at)}</div>
      ${sale.customer_name ? `<div>Customer: ${esc(sale.customer_name)}</div>` : ''}
      <table>
        ${sale.items.map((i) => `<tr><td>${esc(i.name)}<br><span class="muted">${i.quantity} × ${rupees(i.unit_price)}</span></td><td>${rupees(i.line_total)}</td></tr>`).join('')}
        <tr class="sep"><td>Subtotal</td><td>${rupees(sale.subtotal)}</td></tr>
        ${sale.discount ? `<tr><td>Discount</td><td>−${rupees(sale.discount)}</td></tr>` : ''}
        <tr><td><strong>Total</strong></td><td><strong>${rupees(sale.total)}</strong></td></tr>
        ${sale.tax ? `<tr><td class="muted">Incl. GST</td><td class="muted">${rupees(sale.tax)}</td></tr>` : ''}
        <tr><td>Paid by</td><td>${PAY_LABEL[sale.payment_method]}</td></tr>
      </table>
    </div>
    <div class="actions">
      <button class="btn ghost" data-close>Close</button>
      <button class="btn" data-print>Print</button>
      <a class="btn primary" href="${whatsappLink(sale.customer_phone, receiptText(sale))}" target="_blank" rel="noopener">WhatsApp</a>
    </div>`);
  $('[data-close]', modal).onclick = () => modal.close();
  $('[data-print]', modal).onclick = () => window.print();
}

// --- stock in -----------------------------------------------------------

const stockForm = $('#stock-form');
let stockProduct = null;

async function startStockIn(barcode) {
  stockForm.reset();
  stockForm.barcode.value = barcode;
  try {
    stockProduct = await findProduct(barcode);
  } catch (err) {
    return toast(err.message, true);
  }
  const isNew = !stockProduct;
  stockForm.dataset.mode = isNew ? 'new' : 'existing';
  $('.new-only', stockForm).classList.toggle('hidden', !isNew);
  stockForm.name.required = stockForm.price.required = isNew;
  $('#stock-title').textContent = isNew ? 'New product' : stockProduct.name;
  $('#stock-current').textContent = isNew
    ? `Barcode ${barcode} — enter details once, next time it's one scan.`
    : `Barcode ${barcode} · ${rupees(stockProduct.price)} · ${stockProduct.quantity} in stock${stockProduct.cached ? ' (saved copy)' : ''}`;
  stockForm.classList.remove('hidden');
  $('#stock-hint').classList.add('hidden');
  (isNew ? stockForm.name : stockForm.quantity).focus();
  stockForm.quantity.select();
}

function closeStockForm() {
  stockForm.classList.add('hidden');
  $('#stock-hint').classList.remove('hidden');
}

$('#stock-cancel').onclick = closeStockForm;
stockForm.onsubmit = async (e) => {
  e.preventDefault();
  const f = stockForm;
  const body = { barcode: f.barcode.value, quantity: parseInt(f.quantity.value, 10), client_id: newClientId() };
  if (f.dataset.mode === 'new') {
    Object.assign(body, {
      name: f.name.value,
      price: toPaise(f.price.value),
      cost: toPaise(f.cost.value),
      gst_rate: Number(f.gst_rate.value),
      low_stock: parseInt(f.low_stock.value, 10) || 0,
    });
  }
  try {
    if ((await getOutbox()).length) await trySync();
    const { product, created } = await api('/stock-in', { method: 'POST', body });
    await catalogUpsert(product);
    toast(`${created ? 'Added' : 'Restocked'} ${product.name} — now ${product.quantity} in stock`);
    closeStockForm();
  } catch (err) {
    if (!err.offline) return toast(err.message, true);
    const name = stockProduct?.name ?? body.name;
    await enqueue({ kind: 'stock_in', path: '/stock-in', body, label: `Stock in: ${name} +${body.quantity}` });
    // Make the product sellable on this phone right away.
    await catalogUpsert(stockProduct
      ? { ...stockProduct, cached: undefined, quantity: stockProduct.quantity + body.quantity }
      : { id: null, barcode: body.barcode, name: body.name, price: body.price, cost: body.cost, gst_rate: body.gst_rate,
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
  editProduct(Number(li.dataset.id)).catch((err) =>
    toast(err.offline ? 'Editing products needs internet' : err.message, true));
};

async function editProduct(id) {
  const [p, moves] = await Promise.all([api(`/products/${id}`), api(`/products/${id}/movements`)]);
  const REASON = { stock_in: 'Stock in', sale: 'Sold', adjustment: 'Adjusted' };
  openModal(`
    <form id="edit-form">
      <h2>${esc(p.name)}</h2>
      <p class="muted">${esc(p.barcode)} · ${stockBadge(p)}</p>
      <label>Name<input name="name" value="${esc(p.name)}" required></label>
      <div class="grid2">
        <label>Selling price ₹<input name="price" type="number" step="0.01" min="0" value="${p.price / 100}" required></label>
        <label>Cost price ₹<input name="cost" type="number" step="0.01" min="0" value="${p.cost / 100}"></label>
        <label>GST %<input name="gst_rate" type="number" min="0" max="100" step="0.01" value="${p.gst_rate}"></label>
        <label>Low-stock alert<input name="low_stock" type="number" min="0" value="${p.low_stock}"></label>
      </div>
      <label>Correct stock (damaged, lost, recount): + or − units
        <input name="change" type="number" step="1" placeholder="e.g. -2"></label>
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
        },
      });
      const change = parseInt(form.change.value, 10);
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

// --- udhaar khata -------------------------------------------------------

// Balance changes that are queued on this phone but not on the server yet.
async function pendingBalanceDelta(customer) {
  let delta = 0;
  for (const e of await getOutbox()) {
    if (e.error) continue;
    if (e.kind === 'payment' && e.customer_id === customer.id) delta -= e.body.amount;
    if (e.kind === 'sale' && e.body.payment_method === 'credit') {
      const samePhone = customer.phone && digits(e.body.customer_phone) === customer.phone;
      const sameName = !e.body.customer_phone && e.body.customer_name?.toLowerCase() === customer.name.toLowerCase();
      if (samePhone || sameName) delta += e.preview.total;
    }
  }
  return delta;
}

async function loadUdhaar() {
  let customers, stale;
  try {
    ({ data: customers, stale } = await cachedGet('/customers'));
  } catch (err) {
    return toast(err.message, true);
  }
  customers = customers ?? [];
  for (const c of customers) c.shown = c.balance + (await pendingBalanceDelta(c));
  fillCustomerList();

  const needle = $('#cust-search').value.trim().toLowerCase();
  const dueOnly = $('#cust-due-only').checked;
  const shown = customers
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.phone ?? '').includes(needle))
    .filter((c) => !dueOnly || c.shown > 0)
    .sort((a, b) => b.shown - a.shown);
  $('#udhaar-total').textContent = rupees(customers.reduce((s, c) => s + Math.max(c.shown, 0), 0));
  $('#cust-list').innerHTML = (stale ? OFFLINE_NOTE : '') + (shown.length
    ? shown.map((c) => `
      <li class="tap" data-id="${c.id}">
        <div class="grow">
          <div class="title">${esc(c.name)}</div>
          <div class="sub">${c.phone ? esc(c.phone) : 'No phone'}${c.last_activity ? ' · last ' + localTime(c.last_activity) : ''}</div>
        </div>
        <span class="${c.shown > 0 ? 'amount-due' : 'amount-clear'}">${c.shown > 0 ? rupees(c.shown) : 'Clear'}</span>
      </li>`).join('')
    : `<p class="empty">${dueOnly ? 'No pending udhaar. 🎉' : 'No customers yet.'}</p>`);
}

let custTimer;
$('#cust-search').oninput = () => {
  clearTimeout(custTimer);
  custTimer = setTimeout(loadUdhaar, 250);
};
$('#cust-due-only').onchange = loadUdhaar;
$('#cust-list').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openCustomer(Number(li.dataset.id));
};

$('#add-customer').onclick = () => {
  openModal(`
    <form id="cust-form">
      <h2>Add customer</h2>
      <label>Name<input name="name" required autocomplete="off"></label>
      <label>Phone<input name="phone" inputmode="tel" autocomplete="off"></label>
      <label>Already owes (from your old khata) ₹<input name="opening" type="number" min="0" step="0.01" inputmode="decimal" value="0"></label>
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`);
  const form = $('#cust-form');
  $('[data-close]', form).onclick = () => modal.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/customers', {
        method: 'POST',
        body: { name: form.name.value, phone: form.phone.value || undefined, opening_balance: toPaise(form.opening.value) },
      });
      modal.close();
      toast('Customer added');
      loadUdhaar();
    } catch (err) {
      toast(err.offline ? 'Adding a customer needs internet — or just bill them on udhaar' : err.message, true);
    }
  };
};

async function openCustomer(id) {
  let c, offline = false;
  try {
    c = await api(`/customers/${id}`);
  } catch (err) {
    if (!err.offline) return toast(err.message, true);
    c = (await savedCustomers()).find((x) => x.id === id);
    if (!c) return;
    offline = true;
  }
  const balance = c.balance + (await pendingBalanceDelta(c));
  const TYPE = { opening: 'Opening balance', credit_sale: 'Udhaar bill', payment: 'Payment received' };
  const reminder = `Hello ${c.name}, this is a reminder from ${SHOP_NAME} that ${rupees(balance)} is due. Thank you!`;
  openModal(`
    <form id="pay-form">
      <h2>${esc(c.name)}</h2>
      <p class="muted">${c.phone ? esc(c.phone) : 'No phone'}</p>
      <div class="row total"><span>Balance due</span><strong class="${balance > 0 ? 'amount-due' : ''}">${rupees(balance)}</strong></div>
      ${balance !== c.balance ? '<p class="muted">Includes entries waiting to sync.</p>' : ''}
      ${balance > 0 ? `
        <label>Payment received ₹<input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${balance / 100}" required></label>
        <div class="pay-methods">
          <label><input type="radio" name="method" value="cash" checked> Cash</label>
          <label><input type="radio" name="method" value="upi"> UPI</label>
          <label><input type="radio" name="method" value="card"> Card</label>
        </div>` : ''}
      <div class="actions">
        <button class="btn ghost" type="button" data-close>Close</button>
        ${c.phone && balance > 0 ? `<a class="btn" href="${whatsappLink(c.phone, reminder)}" target="_blank" rel="noopener">Remind</a>` : ''}
        ${balance > 0 ? '<button class="btn primary">Record payment</button>' : ''}
      </div>
      <h2>Khata</h2>
      ${offline ? '<p class="notice">Offline — full history shows when the internet is back.</p>' : ''}
      <ul class="list">${(c.entries ?? []).map((e) => `
        <li><div class="grow">
          <div>${TYPE[e.type]}${e.sale_id ? ` · Bill #${e.sale_id}` : ''}${e.method ? ` · ${PAY_LABEL[e.method]}` : ''}</div>
          <div class="sub">${localTime(e.created_at)}${e.note ? ' · ' + esc(e.note) : ''}</div></div>
          <strong class="${e.type === 'payment' ? 'amount-clear' : 'amount-due'}">${e.type === 'payment' ? '−' : '+'}${rupees(e.amount)}</strong>
        </li>`).join('')}</ul>
    </form>`);
  const form = $('#pay-form');
  $('[data-close]', form).onclick = () => modal.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const amount = toPaise(form.amount.value);
    if (amount > balance) return toast(`${c.name} owes only ${rupees(balance)}`, true);
    const body = { amount, method: form.method.value, client_id: newClientId() };
    try {
      if ((await getOutbox()).length) await trySync();
      await api(`/customers/${id}/payments`, { method: 'POST', body });
      toast(`Recorded ${rupees(amount)} from ${c.name}`);
    } catch (err) {
      if (!err.offline) return toast(err.message, true);
      await enqueue({
        kind: 'payment', customer_id: id, path: `/customers/${id}/payments`,
        body: { ...body, created_at: new Date().toISOString() },
        label: `Payment ${rupees(amount)} from ${c.name}`,
      });
      toast('Payment saved offline — will sync later');
    }
    modal.close();
    loadUdhaar();
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
  $('#summary').innerHTML = (stale ? OFFLINE_NOTE : '') + (s ? `
    <div><strong>${rupees(s.revenue + pendingTotal)}</strong><span>Today's sales${pending.length ? ' (incl. offline)' : ''}</span></div>
    <div><strong>${s.bills + pending.length}</strong><span>Bills today</span></div>
    <div><strong>${rupees(s.udhaar_due)}</strong><span>Udhaar outstanding</span></div>
    <div><strong>${rupees(s.stock_value)}</strong><span>Stock value (${s.units} units)</span></div>
    <div><strong>${s.low_stock}</strong><span>Low-stock items</span></div>
    <div><strong>${pending.length}</strong><span>Bills waiting to sync</span></div>` : '');
  const rows = [
    ...pending.map((e, i) => ({ ...e.preview, pendingIndex: i })).reverse(),
    ...sales,
  ];
  $('#sales-list').innerHTML = rows.length
    ? rows.map((b) => `
      <li class="tap${b.id ? '' : ' pending'}" ${b.id ? `data-id="${b.id}"` : `data-pending="${b.pendingIndex}"`}>
        <div class="grow">
          <div class="title">${b.id ? `Bill #${b.id}` : 'Not synced yet'}${b.customer_name ? ' · ' + esc(b.customer_name) : ''}</div>
          <div class="sub">${localTime(b.created_at)} · ${PAY_LABEL[b.payment_method]}</div>
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

// --- navigation ---------------------------------------------------------

const onShow = { inventory: loadInventory, udhaar: loadUdhaar, sales: loadSales };
let currentView = 'bill';
function refreshCurrentView() {
  onShow[currentView]?.();
}

document.querySelector('.tabs').onclick = (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  stopAllScanners();
  currentView = btn.dataset.view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + currentView));
  refreshCurrentView();
};

// Release the camera when the app goes to the background.
document.addEventListener('visibilitychange', () => document.hidden && stopAllScanners());

setupScanner('bill', addToCart);
setupScanner('stock', startStockIn);
$('#shop-status').textContent = SHOP_NAME;
$('#shop-status').onclick = () => {
  const name = prompt('Shop name (printed on bills)', SHOP_NAME);
  if (name?.trim()) {
    localStorage.setItem('hisaab.shop', name.trim());
    location.reload();
  }
};
renderCart();
renderSyncStatus();

// Warm the offline copies: catalog for scanning, customers for udhaar suggestions.
(async () => {
  await trySync();
  await refreshCatalog();
  await cachedGet('/customers').catch(() => {});
  fillCustomerList();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is a bonus, not required */ });
}

import { Scanner, feedback } from './scanner.js';

// --- helpers ------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const rupees = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toPaise = (v) => Math.round((parseFloat(v) || 0) * 100);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// SQLite stores UTC 'YYYY-MM-DD HH:MM:SS'; show it in local time.
const localTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const SHOP_NAME = localStorage.getItem('hisaab.shop') || 'My Shop';

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-hisaab-pin': localStorage.getItem('hisaab.pin') ?? '' },
    body: body ? JSON.stringify(body) : undefined,
  });
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

const cart = new Map(); // product_id -> { product, quantity }

async function addToCart(barcode) {
  try {
    const p = await api('/products/barcode/' + encodeURIComponent(barcode));
    const line = cart.get(p.id) ?? { product: p, quantity: 0 };
    if (line.quantity + 1 > p.quantity) {
      return toast(p.quantity ? `Only ${p.quantity} of ${p.name} in stock` : `${p.name} is out of stock`, true);
    }
    line.product = p;
    line.quantity += 1;
    cart.set(p.id, line);
    toast(`${p.name} ×${line.quantity}`);
    renderCart();
  } catch (err) {
    toast(err.status === 404 ? `Barcode ${barcode} not in inventory — add it in Stock in` : err.message, true);
  }
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
        <button class="btn" data-dec="${p.id}" aria-label="Less">−</button>
        <span>${quantity}</span>
        <button class="btn" data-inc="${p.id}" aria-label="More">+</button>
      </div>
    </li>`).join('');
  const has = cart.size > 0;
  $('#cart-empty').classList.toggle('hidden', has);
  $('#checkout').classList.toggle('hidden', !has);
  const { subtotal, total } = cartTotals();
  $('#subtotal').textContent = rupees(subtotal);
  $('#total').textContent = rupees(total);
}

$('#cart').onclick = (e) => {
  const inc = e.target.dataset.inc, dec = e.target.dataset.dec;
  const line = cart.get(Number(inc ?? dec));
  if (!line) return;
  if (inc) {
    if (line.quantity + 1 > line.product.quantity) return toast(`Only ${line.product.quantity} in stock`, true);
    line.quantity++;
  } else if (--line.quantity <= 0) {
    cart.delete(line.product.id);
  }
  renderCart();
};
$('#discount').oninput = renderCart;
$('#clear-cart').onclick = () => {
  if (confirm('Clear this bill?')) resetBill();
};

function resetBill() {
  cart.clear();
  $('#discount').value = 0;
  $('#cust-name').value = '';
  $('#cust-phone').value = '';
  renderCart();
}

$('#do-checkout').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const sale = await api('/sales', {
      method: 'POST',
      body: {
        items: [...cart.values()].map(({ product, quantity }) => ({ product_id: product.id, quantity })),
        discount: cartTotals().discount,
        payment_method: $('input[name=pay]:checked').value,
        customer_name: $('#cust-name').value || undefined,
        customer_phone: $('#cust-phone').value || undefined,
      },
    });
    resetBill();
    showReceipt(sale);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
};

const PAY_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Udhaar (credit)' };

function receiptText(sale) {
  const lines = sale.items.map((i) => `${i.name} x${i.quantity} = ${rupees(i.line_total)}`);
  return [
    `${SHOP_NAME} — Bill #${sale.id}`,
    localTime(sale.created_at),
    '',
    ...lines,
    '',
    sale.discount ? `Discount: -${rupees(sale.discount)}` : null,
    `Total: ${rupees(sale.total)} (${PAY_LABEL[sale.payment_method]})`,
    'Thank you!',
  ].filter((l) => l !== null).join('\n');
}

function showReceipt(sale) {
  const phone = (sale.customer_phone || '').replace(/\D/g, '');
  const waPhone = phone.length === 10 ? '91' + phone : phone;
  const waLink = `https://wa.me/${waPhone}?text=${encodeURIComponent(receiptText(sale))}`;
  openModal(`
    <div class="receipt">
      <h3>${esc(SHOP_NAME)}</h3>
      <div>Bill #${sale.id} · ${localTime(sale.created_at)}</div>
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
      <a class="btn primary" href="${waLink}" target="_blank" rel="noopener">WhatsApp</a>
    </div>`);
  $('[data-close]', modal).onclick = () => modal.close();
  $('[data-print]', modal).onclick = () => window.print();
}

// --- stock in -----------------------------------------------------------

const stockForm = $('#stock-form');

async function startStockIn(barcode) {
  stockForm.reset();
  stockForm.barcode.value = barcode;
  let product = null;
  try {
    product = await api('/products/barcode/' + encodeURIComponent(barcode));
  } catch (err) {
    if (err.status !== 404) return toast(err.message, true);
  }
  const isNew = !product;
  stockForm.dataset.mode = isNew ? 'new' : 'existing';
  $('.new-only', stockForm).classList.toggle('hidden', !isNew);
  stockForm.name.required = stockForm.price.required = isNew;
  $('#stock-title').textContent = isNew ? 'New product' : product.name;
  $('#stock-current').textContent = isNew
    ? `Barcode ${barcode} — enter details once, next time it's one scan.`
    : `Barcode ${barcode} · ${rupees(product.price)} · ${product.quantity} in stock`;
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
  const body = { barcode: f.barcode.value, quantity: parseInt(f.quantity.value, 10) };
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
    const { product, created } = await api('/stock-in', { method: 'POST', body });
    toast(`${created ? 'Added' : 'Restocked'} ${product.name} — now ${product.quantity} in stock`);
    closeStockForm();
  } catch (err) {
    toast(err.message, true);
  }
};

// --- inventory ----------------------------------------------------------

let invTimer;
async function loadInventory() {
  const q = $('#inv-search').value.trim();
  const low = $('#inv-low').checked ? '1' : '';
  const params = new URLSearchParams({ ...(q && { q }), ...(low && { low }) });
  try {
    const products = await api('/products?' + params);
    $('#inv-list').innerHTML = products.length
      ? products.map((p) => `
        <li class="tap" data-id="${p.id}">
          <div class="grow">
            <div class="title">${esc(p.name)}</div>
            <div class="sub">${esc(p.barcode)} · ${rupees(p.price)}</div>
          </div>
          ${stockBadge(p)}
        </li>`).join('')
      : '<p class="empty">No products yet. Use Stock in to scan your first item.</p>';
  } catch (err) {
    toast(err.message, true);
  }
}
$('#inv-search').oninput = () => {
  clearTimeout(invTimer);
  invTimer = setTimeout(loadInventory, 250);
};
$('#inv-low').onchange = loadInventory;
$('#inv-list').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) editProduct(Number(li.dataset.id));
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
      await api(`/products/${id}`, {
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
      if (change) await api(`/products/${id}/stock`, { method: 'POST', body: { change, reason: 'adjustment', note: 'Manual correction' } });
      modal.close();
      toast('Saved');
      loadInventory();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// --- sales --------------------------------------------------------------

function startOfTodayUtc() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function loadSales() {
  try {
    const [s, sales] = await Promise.all([api('/summary?since=' + encodeURIComponent(startOfTodayUtc())), api('/sales?limit=50')]);
    $('#summary').innerHTML = `
      <div><strong>${rupees(s.revenue)}</strong><span>Today's sales</span></div>
      <div><strong>${s.bills}</strong><span>Bills today</span></div>
      <div><strong>${rupees(s.stock_value)}</strong><span>Stock value (${s.units} units)</span></div>
      <div><strong>${s.low_stock}</strong><span>Low-stock items</span></div>`;
    $('#sales-list').innerHTML = sales.length
      ? sales.map((b) => `
        <li class="tap" data-id="${b.id}">
          <div class="grow">
            <div class="title">Bill #${b.id}${b.customer_name ? ' · ' + esc(b.customer_name) : ''}</div>
            <div class="sub">${localTime(b.created_at)} · ${PAY_LABEL[b.payment_method]}</div>
          </div>
          <strong>${rupees(b.total)}</strong>
        </li>`).join('')
      : '<p class="empty">No bills yet.</p>';
  } catch (err) {
    toast(err.message, true);
  }
}
$('#sales-list').onclick = async (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) showReceipt(await api('/sales/' + li.dataset.id));
};

// --- navigation ---------------------------------------------------------

const onShow = { inventory: loadInventory, sales: loadSales };
document.querySelector('.tabs').onclick = (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  stopAllScanners();
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
  onShow[btn.dataset.view]?.();
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

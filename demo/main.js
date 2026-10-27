// Hisaab demo for GitHub Pages: the real server code (server/app.js + server/db.js) runs inside the
// browser on SQLite compiled to WebAssembly. The app's /api requests never leave the page, and the
// database is saved in this browser's IndexedDB. Logins and backups need a real server, so they
// are switched off here.
import { Buffer } from 'buffer';
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

globalThis.HISAAB_DEMO = true;
const GITHUB = 'https://github.com/sanjeevk20/hisaab';
const NOT_IN_DEMO = /^\/api\/(auth\/(setup|login)|users|backup)/;

// --- saved database --------------------------------------------------------------------------

const idb = new Promise((resolve, reject) => {
  const req = indexedDB.open('hisaab-demo', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const idbDo = async (mode, fn) => {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
};

let store, handler, saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const bytes = store.db.raw.export();
    store.db.exec('PRAGMA foreign_keys = ON'); // export() reopens the database
    idbDo('readwrite', (s) => s.put(bytes, 'db'));
  }, 300);
}

// --- requests: the app's fetch('/api/…') is answered here ------------------------------------

function handle(url, init = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = Object.fromEntries([...new Headers(init.headers ?? {})].map(([k, v]) => [k.toLowerCase(), v]));
  const body = init.body == null ? null : Buffer.from(init.body);
  if (NOT_IN_DEMO.test(url.pathname)) {
    return Promise.resolve(Response.json(
      { error: 'Logins and backups need Hisaab running on your own server. This demo keeps everything in this browser.' },
      { status: 403 },
    ));
  }
  const req = {
    method, url: url.pathname + url.search, headers,
    async *[Symbol.asyncIterator]() { if (body) yield body; },
  };
  return new Promise((resolve) => {
    let status = 200, out = {};
    const res = {
      writeHead(s, h = {}) { status = s; out = h; },
      end(b) {
        if (method !== 'GET' && status < 400) saveSoon();
        resolve(new Response(b ?? null, { status, headers: out }));
      },
    };
    handler(req, res);
  });
}

const ready = (async () => {
  const SQL = await initSqlJs({ locateFile: () => new URL('sql-wasm.wasm', import.meta.url).href });
  const bytes = await idbDo('readonly', (s) => s.get('db'));
  globalThis.__hisaabSql = { SQL, bytes };
  store = openDb(':memory:');
  handler = createHandler(store);
  if (!bytes) await seed();
})();

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  await ready;
  return handle(url, init);
};

// --- sample shop, loaded on the first visit -------------------------------------------------------

// Check character for a made-up GSTIN, so the sample shop's GSTIN is valid-looking but nobody's.
function sampleGstin(state, pan) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const body = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(body[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return body + chars[(36 - (sum % 36)) % 36];
}

async function seed() {
  const call = async (path, method, body) => {
    const r = await handle(new URL('/api' + path, location.href), { method, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) console.warn('demo seed', path, data.error);
    return data;
  };
  // d days ago at about h o'clock, but never later than a minute ago (early in the day, "today at 11" is still ahead).
  const daysAgo = (d, h = 11) => new Date(Math.min(
    Date.now() - d * 86_400_000 - (new Date().getHours() - h) * 3_600_000, Date.now() - 60_000,
  )).toISOString();

  await call('/settings', 'PUT', {
    legal_name: 'Sharma General Stores', trade_name: 'Sharma Kirana (demo)', address: '12 MG Road, Bengaluru 560001',
    gstin: sampleGstin('29', 'ZZDEM0000Z'), phone: '9800000000', gst_registered: true,
  });
  const products = [
    ['8901063010017', 'Britannia Good Day 100g', 3000, 2400, 18, '1905', 'PAC'],
    ['8901725181116', 'Tata Salt 1kg', 2800, 2200, 5, '2501', 'PAC'],
    ['8901030865278', 'Surf Excel Matic 1kg', 24500, 20500, 18, '3402', 'PAC'],
    ['8901058000290', 'Maggi Noodles 70g', 1400, 1150, 18, '1902', 'PAC'],
    ['8901262010016', 'Amul Butter 100g', 6000, 5300, 5, '0405', 'PAC'],
    ['8901499008667', 'Fortune Sunflower Oil 1L', 16500, 14200, 5, '1512', 'BTL'],
    ['8901396393209', 'Dettol Soap 75g', 4000, 3100, 18, '3401', 'NOS'],
    ['8904109450303', 'Aashirvaad Atta 5kg', 28500, 25000, 5, '1101', 'BAG'],
    ['SUGAR', 'Sugar (loose)', 4800, 4200, 5, '1701', 'KGS'],
  ];
  await call('/purchases', 'POST', {
    supplier_name: 'Gupta Wholesale', supplier_phone: '9811100000', invoice_no: 'GW-2291', paid: 500000, payment_method: 'upi',
    items: products.map(([barcode, name, price, cost, gst_rate, hsn, unit]) => ({
      barcode, name, price, unit_cost: cost, gst_rate, hsn, unit, quantity: barcode.endsWith('278') ? 6 : unit === 'KGS' ? 25.5 : 30,
    })),
    created_at: daysAgo(6, 9),
  });
  const baskets = [
    [6, [[0, 2], [1, 1], [3, 4]], 'cash'], [5, [[2, 1], [6, 2]], 'upi'], [5, [[7, 1], [5, 1]], 'cash'],
    [4, [[3, 6], [4, 1]], 'upi'], [3, [[1, 2], [0, 3], [6, 1]], 'cash'], [2, [[5, 2], [7, 1]], 'card'],
    [1, [[2, 1], [3, 2], [8, 1.5]], 'upi'], [0, [[0, 2], [4, 1], [8, 0.75]], 'cash'],
  ];
  const bills = [];
  for (const [d, items, payment_method] of baskets) {
    bills.push(await call('/sales', 'POST', { items: items.map(([i, quantity]) => ({ barcode: products[i][0], quantity })), payment_method, created_at: daysAgo(d) }));
  }
  const udhaar = await call('/sales', 'POST', {
    items: [{ barcode: products[7][0], quantity: 1 }, { barcode: products[5][0], quantity: 1 }],
    payment_method: 'credit', customer_name: 'Kamla Devi', customer_phone: '9876500000', created_at: daysAgo(3, 18),
  });
  await call(`/customers/${udhaar.customer_id}/payments`, 'POST', { amount: 20000, method: 'cash', created_at: daysAgo(1) });
  await call('/sale-returns', 'POST', { sale_id: bills[4].id, items: [{ barcode: products[1][0], quantity: 1 }], reason: 'Torn packet', created_at: daysAgo(2, 16) });
  saveSoon();
}

// --- demo bar --------------------------------------------------------------------------------

const bar = document.createElement('div');
bar.className = 'demo-bar';
bar.innerHTML = `<span><strong>Demo</strong> · saved in this browser</span>
  <button type="button" data-reset>Start over</button><a href="${GITHUB}" target="_blank" rel="noopener">Get Hisaab</a>`;
document.body.prepend(bar);
bar.querySelector('[data-reset]').onclick = async () => {
  if (!confirm('Delete everything in this demo and start again with the sample shop?')) return;
  await idbDo('readwrite', (s) => s.clear());
  indexedDB.deleteDatabase('hisaab');
  localStorage.clear();
  location.reload();
};

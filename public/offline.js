// Offline support: a small IndexedDB key-value store, a cached product catalog, and an
// outbox of actions (sales, stock-ins, udhaar payments) that are replayed to the server in
// order once the connection returns. Every queued action carries a client_id, so a retry
// after a lost response is recognised by the server and never recorded twice.

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('hisaab', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function kv(mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
export const kvGet = (key) => kv('readonly', (s) => s.get(key));
export const kvSet = (key, value) => kv('readwrite', (s) => s.put(value, key));

// On sign-out, forget cached business data (reports, costs, customers) so the next person on this
// phone only sees what their own login allows. The outbox and this device's invoice series stay.
export async function clearPrivateCache() {
  const keys = await kv('readonly', (s) => s.getAllKeys());
  const keep = (k) => k === 'outbox' || k === 'device' || String(k).startsWith('seq:') || k === 'get:/settings';
  await kv('readwrite', (s) => {
    for (const k of keys) if (!keep(k)) s.delete(k);
  });
}

export const newClientId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// SQLite-style UTC timestamp, matching what the server returns.
export const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// --- catalog ------------------------------------------------------------

export async function getCatalog() {
  return (await kvGet('catalog')) ?? [];
}

export async function saveCatalog(products) {
  // Keep products created offline that the server doesn't know about yet.
  const pending = (await getCatalog()).filter((p) => p.id === null);
  const known = new Set(products.map((p) => p.barcode));
  await kvSet('catalog', [...products, ...pending.filter((p) => !known.has(p.barcode))]);
}

export async function catalogFind(barcode) {
  return (await getCatalog()).find((p) => p.barcode === barcode) ?? null;
}

// Apply a change to the cached copy of a product (or add it) so offline screens stay current.
export async function catalogUpsert(product) {
  const list = await getCatalog();
  const i = list.findIndex((p) => p.barcode === product.barcode);
  if (i >= 0) list[i] = { ...list[i], ...product };
  else list.push(product);
  await kvSet('catalog', list);
}

export async function catalogChangeQty(barcode, delta) {
  const p = await catalogFind(barcode);
  if (p) await catalogUpsert({ ...p, quantity: Math.max(0, p.quantity + delta) });
}

// --- outbox -------------------------------------------------------------

const listeners = new Set();
export const onOutboxChange = (fn) => listeners.add(fn);
const notify = (box) => listeners.forEach((fn) => fn(box));

export async function getOutbox() {
  return (await kvGet('outbox')) ?? [];
}

async function setOutbox(box) {
  await kvSet('outbox', box);
  notify(box);
}

// entry: { kind: 'sale' | 'stock_in' | 'payment', path, body, label }
export async function enqueue(entry) {
  const box = await getOutbox();
  box.push({ ...entry, queued_at: nowSql(), error: null });
  await setOutbox(box);
}

export async function discard(clientId) {
  await setOutbox((await getOutbox()).filter((e) => e.body.client_id !== clientId));
}

let syncing = null;

// Replays queued actions oldest-first. Stops at the first network failure (still offline)
// or server error (try later); a rejected action (4xx) is kept with its error for review.
export function sync(send) {
  syncing ??= (async () => {
    let synced = 0;
    const warnings = [];
    try {
      for (const entry of await getOutbox()) {
        if (entry.error) continue;
        try {
          const result = await send(entry.path, { method: 'POST', body: entry.body });
          await setOutbox((await getOutbox()).filter((e) => e.body.client_id !== entry.body.client_id));
          synced++;
          if (result?.warnings) warnings.push(...result.warnings);
        } catch (err) {
          if (err.offline || err.status >= 500 || err.status === 401) break;
          const box = await getOutbox();
          const stuck = box.find((e) => e.body.client_id === entry.body.client_id);
          if (stuck) stuck.error = err.message;
          await setOutbox(box);
        }
      }
    } finally {
      syncing = null;
    }
    return { synced, warnings };
  })();
  return syncing;
}

// Retry an action that the server rejected, e.g. after fixing the product it referred to.
export async function retry(clientId) {
  const box = await getOutbox();
  const entry = box.find((e) => e.body.client_id === clientId);
  if (entry) entry.error = null;
  await setOutbox(box);
}

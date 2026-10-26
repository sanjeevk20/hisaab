// Service worker: keeps the app shell (and the iPhone barcode library) available offline.
// App files are network-first so updates show up as soon as the shop is online; the API is
// never cached here — offline data lives in IndexedDB (see offline.js).
const CACHE = 'hisaab-v5';
const SHELL = ['/', '/app.js', '/scanner.js', '/offline.js', '/styles.css', '/manifest.webmanifest', '/icon.svg'];
const ZXING = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await cache.add(new Request(ZXING, { mode: 'cors' })).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  if (request.url === ZXING) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
    return;
  }
  if (url.origin !== location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(request)) ?? (await cache.match('/'));
    }
  })());
});

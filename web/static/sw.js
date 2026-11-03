// LingoLens service worker: keeps the app itself (HTML, scripts, styles, fonts)
// so it opens without a connection. The account's data is kept by offline.js in
// IndexedDB; API calls pass straight through and are never cached here.
//
// Files are fetched from the network first, so a new version shows up on the next
// load; the cached copy is used when the network fails or is too slow.

const CACHE = 'lingolens-app-v1';

// Every file the app needs. internal/server tests check this list against web/static.
const APP_FILES = [
  './',
  'style.css',
  'theme.js',
  'i18n.js',
  'api.js',
  'library.js',
  'offline.js',
  'app.js',
  'vendor/marked.min.js',
  'vendor/purify.min.js',
  'vendor/fonts/literata-latin.woff2',
  'vendor/fonts/literata-latin-italic.woff2',
];

const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('lingolens-app-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/skills/') || url.pathname === '/sw.js') return;
  // Every page of the app is index.html (routes live in the #hash).
  const key = req.mode === 'navigate' ? './' : req;
  event.respondWith(networkFirst(req, key));
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((resp) => {
    if (resp.ok && resp.type === 'basic') cache.put(key, resp.clone());
    return resp;
  });
  network.catch(() => {}); // a late failure after the cache answered
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT); });
  try {
    const first = await Promise.race([network, slow]);
    if (first) return first;
    return (await cache.match(key)) || (await network); // slow network: cached copy if any
  } catch {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw new Error('offline and not cached');
  } finally {
    clearTimeout(timer);
  }
}

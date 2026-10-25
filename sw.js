// Daily Ledger offline support.
// Bump CACHE when you change the app files, so every device picks up the new version.
const CACHE = 'daily-ledger-v4';

const APP_FILES = ['./', './index.html', './styles.css', './app.js', './config.js'];
const CDN_FILES = [
  'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/@babel/standalone@7.24.7/babel.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES);
    for (const url of CDN_FILES) {
      try {
        const res = await fetch(url, { mode: 'no-cors' });
        await cache.put(url, res);
      } catch (err) { /* if a CDN file cannot be cached, the app still installs */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Database requests are never cached here. The app queues them itself.
  if (url.hostname.endsWith('supabase.co')) return;

  // Your own files: try the network first so updates arrive, fall back to the saved copy offline.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        return (await caches.match(req, { ignoreSearch: true })) || caches.match('./index.html');
      }
    })());
    return;
  }

  // Library files from the CDN: use the saved copy first.
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
      return res;
    } catch (err) {
      return Response.error();
    }
  })());
});

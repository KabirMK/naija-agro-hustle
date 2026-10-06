/* Naija Agro-Hustle service worker: makes the game installable and playable offline.
   Bump CACHE whenever you deploy changed assets so old caches are purged. */
const CACHE = 'nah-v2';
const ASSETS = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase & other APIs always go to the network

  // Game page: network-first so players get updates, cached copy when offline (common on Nigerian data).
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then(res => { if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); } return res; })
      .catch(() => caches.match('./')));
    return;
  }

  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});

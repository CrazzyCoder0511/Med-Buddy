/* Offline shell. MedBuddy has no backend, so caching the files is
   enough to make it work with no connection at all. */

/* Bump CACHE whenever the ?v= query on the assets changes. */
const CACHE = 'dosenote-v38';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=38',
  './parser.js?v=38',
  './doctors.js?v=38',
  './scanner.js?v=38',
  './insurance.js?v=38',
  './cloud.js?v=38',
  './sheet-controller.js?v=38',
  './app.js?v=38',
  './manifest.json',
  './medbuddy-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  /* The page itself is fetched network-first. A cached shell points at
     old ?v= asset URLs, so serving it from cache is exactly how a fresh
     deploy stays invisible until the user hard-refreshes. Falls back to
     the cached copy when offline. */
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* Everything else is cache-first: those URLs carry a version query,
     so a new build asks for new URLs and never gets a stale hit. */
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});

/* Tapping the dose notification brings the app forward. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

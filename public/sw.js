/* VroomMates service worker — cached app shell, live API, push-ready.
 * Bump CACHE_VERSION whenever you ship asset changes (e.g. /style.css?v=6). */
const CACHE_VERSION = 'vroommates-v13';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

const PRECACHE = [
  '/',
  '/index.html',
  '/style.css?v=17',
  '/logo.png',
  '/favicon.svg',
  '/favicon.png',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Live data — never cache API or socket.io traffic.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Same-origin static assets: cache-first (versioned with ?v=).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Cross-origin CDNs (Leaflet, socket.io, fonts): stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
        }
        return response;
      });
      return cached || network;
    })
  );
});

// ── Web Push (skeleton) ─────────────────────────────────────────────────────
// To activate: add POST /api/push/subscribe + web-push server-side, then the
// app can receive notifications while closed. The handler below is ready.
self.addEventListener('push', (event) => {
  let data = { title: 'VroomMates', body: 'New update', url: '/' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) { /* fall back to defaults */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/favicon.png',
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          client.navigate(url).catch(() => {});
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});

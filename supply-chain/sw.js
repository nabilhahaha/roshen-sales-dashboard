// Roshen / Relia Supply Chain — service worker.
//
// Strategy:
//   · APP SHELL (this origin: html / js / css / icons / manifest):
//     network-first with cache fallback → the UI loads even offline, and a
//     new deployment is picked up on the next online load (automatic updates:
//     fresh bytes win whenever the network is available).
//   · BUSINESS DATA (Supabase REST / storage) and any non-GET request:
//     network ONLY — live order data is never served stale from a cache.
//   · CDN libraries (xlsx / supabase / pdf.js): cache-first (versioned URLs).
//
// PUSH NOTIFICATIONS — architecture prepared, not activated: the handlers
// below are inert until a push subscription is created server-side
// (see src/services/notifications/push.service.js).
const SHELL_CACHE = 'sc-shell-v1';
const LIB_CACHE = 'sc-libs-v1';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/src/styles/app.css',
  '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting(); // automatic updates: a new worker takes over immediately
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL_CACHE, LIB_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // uploads / writes: network only
  const url = new URL(req.url);

  // business data: never cached — always live
  if (url.hostname.endsWith('.supabase.co')) return;

  // CDN libraries: cache-first (URLs are versioned)
  if (url.hostname !== self.location.hostname) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(LIB_CACHE)).put(req, res.clone());
        return res;
      } catch (err) { return hit || Response.error(); }
    })());
    return;
  }

  // app shell: network-first, cache fallback (offline shell)
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(SHELL_CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('/index.html');
      return Response.error();
    }
  })());
});

// ---- push notifications: infrastructure only (no active subscription) ------
self.addEventListener('push', (e) => {
  if (!e.data) return;
  let payload = {};
  try { payload = e.data.json(); } catch (err) { payload = { title: 'Supply Chain', body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(payload.title || 'Roshen / Relia Supply Chain', {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: payload.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(url); return; } }
    await self.clients.openWindow(url);
  })());
});

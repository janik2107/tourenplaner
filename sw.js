// Tourenplaner Service Worker: App-Dateien offline, CDN-Bibliotheken im Cache
const VERSION = 'tp-v18';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'tessdata.projectnaptha.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== VERSION && k !== 'tp-cdn').map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // stale-while-revalidate für die App selbst
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req, {ignoreSearch: true});
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('tp-cdn').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
  }
  // Geocoding/Routing (Nominatim, OSRM) und Kartenkacheln: immer Netzwerk
});

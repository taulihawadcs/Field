// FieldGrid Pro Service Worker — offline-first cache
// Bumps version to invalidate old caches when assets change
const CACHE_VERSION = 'fg-v6.3';
const APP_CACHE   = CACHE_VERSION + '-app';
const TILE_CACHE  = CACHE_VERSION + '-tiles';

// Core assets the Record page needs to function offline
const CORE_ASSETS = [
  './',
  './FieldGrid_Pro_v6.html',
  'https://fonts.googleapis.com/css2?family=Archivo+Black&family=JetBrains+Mono:wght@400;700&display=swap',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// ── INSTALL: pre-cache core assets ───────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(CORE_ASSETS.map(u => new Request(u, {mode:'no-cors'}))))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache partial fail:', err))
  );
});

// ── ACTIVATE: clean up old cache versions ────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: stale-while-revalidate for app, cache-first for tiles ──
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isTile = /tile\.openstreetmap|arcgisonline|opentopomap/.test(url.hostname);
  const isAPI  = /api\.groq\.com|googleapis\.com\/v1beta/.test(url.hostname);

  // Skip caching for AI API calls (always need fresh)
  if (isAPI) return;

  if (isTile) {
    // Map tiles: cache-first with background update
    event.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(req).then(cached => {
          const fetchPromise = fetch(req).then(resp => {
            if (resp && resp.status === 200) cache.put(req, resp.clone());
            return resp;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // App assets: stale-while-revalidate
  event.respondWith(
    caches.open(APP_CACHE).then(cache =>
      cache.match(req).then(cached => {
        const fetchPromise = fetch(req).then(resp => {
          if (resp && (resp.status === 200 || resp.type === 'opaque')) {
            cache.put(req, resp.clone()).catch(() => {});
          }
          return resp;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    )
  );
});

// ── MESSAGE: allow manual cache purge from app ───────────────────
self.addEventListener('message', event => {
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});

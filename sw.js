/* ════════════════════════════════════════════════════════════════════════
   FieldGrid — Service Worker
   ------------------------------------------------------------------------
   Gives the app offline capability so a surveyor can keep recording poles,
   editing data and viewing already-loaded map tiles with no signal.

   STRATEGY
   • App shell (the HTML page + same-origin assets) → network-first, fall back
     to cache. This means you always get the freshest app when online, but it
     still opens when offline.
   • CDN libraries (Leaflet, xlsx-js-style, jsPDF, Font Awesome, Google Fonts)
     → stale-while-revalidate. Served instantly from cache, refreshed in the
     background when a connection exists.
   • Map tiles (OpenStreetMap, OpenTopoMap, ArcGIS, Google) → cache-first with a
     rolling cap, so tiles you have already viewed stay available offline. New
     tiles are fetched and cached as you pan/zoom while online.

   HOW TO USE
   • Place this sw.js file in the SAME folder and at the SAME path as the
     FieldGrid HTML file, then serve both over http(s) (not file://).
     A service worker cannot run from a file:// URL.
   • Bump CACHE_VERSION whenever you ship a new build to force an update.
   ════════════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'v18';
const SHELL_CACHE = 'fieldgrid-shell-' + CACHE_VERSION;
const LIB_CACHE   = 'fieldgrid-libs-'  + CACHE_VERSION;
const TILE_CACHE  = 'fieldgrid-tiles-' + CACHE_VERSION;

// Cap on cached map tiles to avoid unbounded storage growth.
const MAX_TILES = 1500;

// Same-origin shell files to pre-cache. The HTML itself is added at runtime
// (its filename varies), so we keep this list to the relative roots.
const SHELL_URLS = [
  './',
  './index.html'
];

// CDN libraries the app depends on. Cached on first use (stale-while-revalidate).
const LIB_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// Tile server hosts. Matched loosely so subdomains (a/b/c.tile…) also match.
const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'server.arcgisonline.com',
  'google.com'            // mt0-3.google.com satellite tiles
];

// ── INSTALL ───────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS).catch(() => {/* ok if some 404 */}))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE — clean out old cache versions ────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => ![SHELL_CACHE, LIB_CACHE, TILE_CACHE].includes(k))
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Allow the page to trigger an immediate update via postMessage.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const isTile = url => TILE_HOSTS.some(h => url.hostname.endsWith(h) || url.hostname.includes(h));
const isLib  = url => LIB_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));

// ── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never cache writes
  const url = new URL(req.url);

  // 1) Navigation requests (opening the app) → network-first, cache fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html') || caches.match('./')))
    );
    return;
  }

  // 2) Map tiles → cache-first with rolling cap.
  if (isTile(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(req).then(hit => {
          if (hit) return hit;
          return fetch(req).then(res => {
            if (res && (res.ok || res.type === 'opaque')) {
              cache.put(req, res.clone());
              trimCache(TILE_CACHE, MAX_TILES);
            }
            return res;
          }).catch(() => hit); // offline & uncached → let Leaflet show its blank tile
        })
      )
    );
    return;
  }

  // 3) CDN libraries → stale-while-revalidate.
  if (isLib(url)) {
    event.respondWith(
      caches.open(LIB_CACHE).then(cache =>
        cache.match(req).then(hit => {
          const network = fetch(req).then(res => {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
            return res;
          }).catch(() => hit);
          return hit || network;
        })
      )
    );
    return;
  }

  // 4) Other same-origin GETs → cache-first, then network.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit))
    );
  }
});

// ── Keep the tile cache from growing without bound (FIFO eviction) ──────────
function trimCache(cacheName, maxItems) {
  caches.open(cacheName).then(cache =>
    cache.keys().then(keys => {
      if (keys.length <= maxItems) return;
      // Delete the oldest entries beyond the cap.
      const remove = keys.length - maxItems;
      for (let i = 0; i < remove; i++) cache.delete(keys[i]);
    })
  );
}

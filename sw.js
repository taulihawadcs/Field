/* ════════════════════════════════════════════════════════════════════════
   FieldGrid — Service Worker
   Built for: FieldGrid_Pro_v24.html
   ------------------------------------------------------------------------
   Gives the app offline capability so a surveyor can keep recording poles,
   editing data and viewing already-loaded map tiles with no signal.

   CACHING STRATEGY
   • App shell (the HTML page + any same-origin files) → network-first, fall
     back to cache. You always get the freshest build online and the app still
     opens offline.
   • CDN libraries (Leaflet, xlsx-js-style, ExcelJS, jsPDF, Font Awesome,
     Google Fonts) → stale-while-revalidate. Served instantly from cache,
     refreshed in the background. Excel/PDF export keeps working offline.
   • Map tiles (OpenStreetMap, OpenTopoMap, ArcGIS imagery, Google satellite)
     → cache-first with a rolling cap. Areas you have already viewed stay
     available offline; new tiles cache as you pan/zoom while online.

   HOW TO USE
   • Put this sw.js file in the SAME folder as the FieldGrid HTML, and serve
     both over http(s) — not file://. A service worker cannot run from a
     file:// URL.
   • Bump CACHE_VERSION below whenever you ship a new build so clients drop
     the old cache on their next load.
   ════════════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'v24';
const SHELL_CACHE = 'fieldgrid-shell-' + CACHE_VERSION;
const LIB_CACHE   = 'fieldgrid-libs-'  + CACHE_VERSION;
const TILE_CACHE  = 'fieldgrid-tiles-' + CACHE_VERSION;

// Cap on cached map tiles to avoid unbounded storage growth.
const MAX_TILES = 1500;

// Same-origin shell URLs to try to pre-cache. The actual HTML filename may
// vary (FieldGrid_Pro_v24.html, app.html, index.html, …) so we keep this
// list to relative roots; the HTML is also cached at runtime when fetched.
const SHELL_URLS = [
  './',
  './index.html'
];

// CDN libraries the app depends on (matches v24's <script>/<link> imports).
// Matched loosely so subdomains of these hosts also match.
const LIB_HOSTS = [
  'unpkg.com',                    // Leaflet JS + CSS
  'cdn.jsdelivr.net',             // xlsx-js-style
  'cdnjs.cloudflare.com',         // ExcelJS, jsPDF, Font Awesome
  'fonts.googleapis.com',         // Segoe UI fallback CSS
  'fonts.gstatic.com'             // font files referenced by the CSS above
];

// Map tile hosts. Subdomain wildcards (a/b/c.tile…) and mt0-mt3 are matched.
const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'server.arcgisonline.com',
  'google.com'                    // mt0-3.google.com satellite tiles
];

// ── INSTALL ────────────────────────────────────────────────────────────────
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

// Let the page trigger an immediate activation when a new SW is waiting.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const isTile = url => TILE_HOSTS.some(h => url.hostname.endsWith(h) || url.hostname.includes(h));
const isLib  = url => LIB_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));

// ── FETCH ──────────────────────────────────────────────────────────────────
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

// ── Keep the tile cache from growing without bound (FIFO eviction) ─────────
function trimCache(cacheName, maxItems) {
  caches.open(cacheName).then(cache =>
    cache.keys().then(keys => {
      if (keys.length <= maxItems) return;
      const remove = keys.length - maxItems;
      for (let i = 0; i < remove; i++) cache.delete(keys[i]);
    })
  );
}

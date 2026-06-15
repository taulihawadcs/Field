/* ════════════════════════════════════════════════════════════════════════
   FieldGrid / NAAPJAACH — Service Worker
   Built for: NAAPJAACH_FINAL_pro.html
   ------------------------------------------------------------------------
   Gives the app offline capability so a surveyor can keep recording poles,
   editing data and viewing already-loaded map tiles with no signal.

   CACHING STRATEGY
   • App shell (the HTML page itself + same-origin files) → network-first,
     fall back to whatever HTML page is cached. You always get the freshest
     build online, and the app still opens offline regardless of the HTML
     filename (NAAPJAACH_FINAL_pro.html, index.html, …).
   • CDN libraries (Leaflet, xlsx-js-style, ExcelJS, jsPDF, Font Awesome,
     Google Fonts) → stale-while-revalidate. Served instantly from cache,
     refreshed in the background. Excel/PDF export keeps working offline.
   • Map tiles (OpenStreetMap, OpenTopoMap, ArcGIS imagery, Google satellite)
     → cache-first with a rolling cap. Areas already viewed stay available
     offline; new tiles cache as you pan/zoom while online.

   HOW TO USE
   • Put this sw.js in the SAME folder as the HTML, and serve both over
     http(s) — not file://. A service worker cannot run from a file:// URL.
   • Bump CACHE_VERSION below whenever you ship a new build so clients drop
     the old cache on their next load.
   ════════════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'v26';
const SHELL_CACHE = 'fieldgrid-shell-' + CACHE_VERSION;
const LIB_CACHE   = 'fieldgrid-libs-'  + CACHE_VERSION;
const TILE_CACHE  = 'fieldgrid-tiles-' + CACHE_VERSION;

// Cap on cached map tiles to avoid unbounded storage growth.
const MAX_TILES = 1500;

// Same-origin shell URLs to TRY to pre-cache. The real HTML filename varies,
// so we keep this to relative roots; the actual HTML page is also cached at
// runtime the first time it is fetched (see the navigate handler).
const SHELL_URLS = [
  './',
  './index.html',
  './NAAPJAACH_FINAL_pro.html',
  './NAAPJAACH_FINAL.html'        // kept for older bookmarks / filenames
];

// CDN libraries the app depends on (matches the HTML's <script>/<link>).
// Matched so subdomains of these hosts also match.
const LIB_HOSTS = [
  'unpkg.com',                    // Leaflet JS + CSS
  'cdn.jsdelivr.net',             // xlsx-js-style
  'cdnjs.cloudflare.com',         // ExcelJS, jsPDF, Font Awesome
  'fonts.googleapis.com',         // Google Fonts CSS
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
      // addAll is atomic — one 404 aborts the whole batch — so cache each URL
      // individually and ignore any that 404 (e.g. index.html may not exist).
      .then(cache => Promise.all(
        SHELL_URLS.map(u =>
          cache.add(u).catch(() => { /* ok if this particular URL 404s */ })
        )
      ))
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
// The HTML posts 'SKIP_WAITING' to the installing/waiting worker.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const isTile = url => TILE_HOSTS.some(h => url.hostname.endsWith(h) || url.hostname.includes(h));
const isLib  = url => LIB_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));

// Find any cached HTML document to use as an offline navigation fallback,
// whatever its filename. Tries the known shell URLs first, then scans the
// shell cache for the first cached navigation/HTML response.
async function offlineShellFallback(req) {
  const cache = await caches.open(SHELL_CACHE);
  // 1) Exact request (the page the user is on)
  const exact = await cache.match(req, { ignoreSearch: true });
  if (exact) return exact;
  // 2) Known shell roots
  for (const u of SHELL_URLS) {
    const hit = await cache.match(u);
    if (hit) return hit;
  }
  // 3) Anything HTML we cached at runtime
  const keys = await cache.keys();
  for (const k of keys) {
    if (/\.html?($|\?)/i.test(k.url) || k.url.endsWith('/')) {
      const hit = await cache.match(k);
      if (hit) return hit;
    }
  }
  return Response.error();
}

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
        .catch(() => offlineShellFallback(req))
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
          }).catch(() => hit); // offline & uncached → Leaflet shows its blank tile
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

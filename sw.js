/**
 * MotoDash — sw.js  (Service Worker)
 *
 * SECURITY & CACHE ARCHITECTURE
 * ════════════════════════════════════════════════════════════════
 * As of this version, ALL static libraries (Leaflet, Leaflet Routing
 * Machine, jsmediatags, fonts) are SELF-HOSTED under vendor/ and css/ —
 * there is no third-party CDN dependency for any static file. The only
 * external network calls this app makes are to 3 live data APIs that
 * cannot be self-hosted (they are dynamic services, not static files):
 *
 *   1. nominatim.openstreetmap.org — address/place search results
 *   2. router.project-osrm.org     — turn-by-turn route calculation
 *   3. *.basemaps.cartocdn.com     — map tile images
 *
 * CACHE RULES (explicit TTL per cache type — no indefinite caching):
 * ────────────────────────────────────────────────────────────────
 *   SHELL  → Stale-While-Revalidate, no TTL (versioned by CACHE_VERSION)
 *   TILES  → Cache-First, TTL 7 days  (map imagery changes rarely)
 *   API    → Network-First, TTL 1 hour (search results go stale fast)
 *   ROUTE  → Network-Only, never cached (routes must always be fresh)
 *
 * COOKIE POLICY:
 * This Service Worker and the app it serves NEVER set cookies. All
 * persistent state uses localStorage (same-origin only, never sent
 * over the network). This file does not read or forward any cookie
 * header for any request it intercepts.
 */

'use strict';

/* Bump this version string on every deploy that changes cached files.
 * Old caches are purged automatically in the 'activate' event below. */
const CACHE_VERSION = 'v2-selfhosted';

const CACHE_SHELL = `motodash-shell-${CACHE_VERSION}`;
const CACHE_TILES = `motodash-tiles-${CACHE_VERSION}`;
const CACHE_API   = `motodash-api-${CACHE_VERSION}`;

/* TTL in milliseconds — explicit expiry per cache type */
const TTL_TILES = 7  * 24 * 60 * 60 * 1000;  // 7 days
const TTL_API   = 1  * 60 * 60 * 1000;       // 1 hour

/* App shell — every file is now same-origin (self-hosted) */
const SHELL_URLS = [
    './index.html',
    './css/style.css',
    './css/fonts.css',
    './js/utilities.js',
    './js/trip.js',
    './js/speedometer.js',
    './js/maps.js',
    './js/bluetooth.js',
    './js/voice.js',
    './js/media.js',
    './js/app.js',
    './manifest.json',
    './assets/icons/icon.svg',

    /* Self-hosted vendor libraries */
    './vendor/leaflet/leaflet.css',
    './vendor/leaflet/leaflet.js',
    './vendor/leaflet/images/layers.png',
    './vendor/leaflet/images/layers-2x.png',
    './vendor/leaflet/images/marker-icon.png',
    './vendor/leaflet/images/marker-icon-2x.png',
    './vendor/leaflet/images/marker-shadow.png',
    './vendor/leaflet-routing-machine/leaflet-routing-machine.css',
    './vendor/leaflet-routing-machine/leaflet-routing-machine.js',
    './vendor/leaflet-routing-machine/leaflet.routing.icons.png',
    './vendor/leaflet-routing-machine/routing-icon.png',
    './vendor/jsmediatags/jsmediatags.js',

    /* Self-hosted fonts */
    './vendor/fonts/orbitron-latin-400-normal.woff2',
    './vendor/fonts/orbitron-latin-600-normal.woff2',
    './vendor/fonts/orbitron-latin-700-normal.woff2',
    './vendor/fonts/orbitron-latin-900-normal.woff2',
    './vendor/fonts/rajdhani-latin-300-normal.woff2',
    './vendor/fonts/rajdhani-latin-400-normal.woff2',
    './vendor/fonts/rajdhani-latin-500-normal.woff2',
    './vendor/fonts/rajdhani-latin-600-normal.woff2',
    './vendor/fonts/rajdhani-latin-700-normal.woff2',
    './vendor/fonts/share-tech-mono-latin-400-normal.woff2'
];

// ═══════════════════════════════════════════════════════════
//  INSTALL — cache shell files individually
//  (one missing file, e.g. icon-192.png not yet generated,
//   must NOT abort the entire install — so we fetch one by one
//   instead of using cache.addAll which fails atomically)
// ═══════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_SHELL);
            for (const url of SHELL_URLS) {
                try {
                    const res = await fetch(url);
                    if (res.ok) await cache.put(url, res);
                } catch { /* file not available yet — skip, non-fatal */ }
            }
            await self.skipWaiting();
            console.log('[SW] Installed —', CACHE_VERSION);
        })()
    );
});

// ═══════════════════════════════════════════════════════════
//  ACTIVATE — purge every cache that doesn't match current version
// ═══════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
    const KEEP = new Set([CACHE_SHELL, CACHE_TILES, CACHE_API]);
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
    console.log('[SW] Activated —', CACHE_VERSION);
});

// ═══════════════════════════════════════════════════════════
//  FETCH — explicit routing by exact allow-listed destination
// ═══════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    /* ── Map tiles (CartoDB) → Cache-First, 7-day TTL ──────────── */
    if (url.hostname.endsWith('.basemaps.cartocdn.com')) {
        event.respondWith(cacheFirstWithTTL(req, CACHE_TILES, TTL_TILES));
        return;
    }

    /* ── Nominatim search → Network-First, 1-hour TTL ──────────── */
    if (url.hostname === 'nominatim.openstreetmap.org') {
        event.respondWith(networkFirstWithTTL(req, CACHE_API, TTL_API));
        return;
    }

    /* ── OSRM routing → Network-Only, NEVER cached ─────────────── */
    if (url.hostname === 'router.project-osrm.org') {
        event.respondWith(
            fetch(req).catch(() =>
                new Response(JSON.stringify({ code: 'NoRoute', message: 'Offline' }),
                    { headers: { 'Content-Type': 'application/json' } })
            )
        );
        return;
    }

    /* ── Anything else cross-origin → pass through untouched ────── */
    if (url.origin !== self.location.origin) {
        event.respondWith(fetch(req));
        return;
    }

    /* ── Same-origin app shell → Stale-While-Revalidate ─────────── */
    event.respondWith(staleWhileRevalidate(req, CACHE_SHELL));
});

// ═══════════════════════════════════════════════════════════
//  STRATEGIES — each cached entry is timestamped (X-Cached-At)
//  so TTL expiry can be checked precisely, not just "cache exists"
// ═══════════════════════════════════════════════════════════

/** Cache-First with explicit TTL. Expired entries are refetched. */
async function cacheFirstWithTTL(req, cacheName, ttlMs) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(req);

    if (cached) {
        const cachedAt = Number(cached.headers.get('X-Cached-At') || 0);
        const isExpired = Date.now() - cachedAt > ttlMs;
        if (!isExpired) return cached;
    }

    try {
        const res = await fetch(req);
        if (res.ok) await putWithTimestamp(cache, req, res.clone());
        return res;
    } catch {
        return cached || new Response('', { status: 503 });
    }
}

/** Network-First with explicit TTL fallback when offline or slow. */
async function networkFirstWithTTL(req, cacheName, ttlMs) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(req);
        if (res.ok) await putWithTimestamp(cache, req, res.clone());
        return res;
    } catch {
        const cached = await cache.match(req);
        if (cached) {
            const cachedAt = Number(cached.headers.get('X-Cached-At') || 0);
            if (Date.now() - cachedAt <= ttlMs) return cached;
        }
        return new Response('', { status: 503 });
    }
}

/** Stale-While-Revalidate for the app shell — instant load, background update. */
async function staleWhileRevalidate(req, cacheName) {
    const cache    = await caches.open(cacheName);
    const cached   = await cache.match(req);
    const fetchPrm = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
    }).catch(() => null);
    return cached || fetchPrm;
}

/** Store a response with an X-Cached-At timestamp header for TTL checks. */
async function putWithTimestamp(cache, req, res) {
    const headers = new Headers(res.headers);
    headers.set('X-Cached-At', String(Date.now()));
    const body  = await res.arrayBuffer();
    const stamped = new Response(body, { status: res.status, statusText: res.statusText, headers });
    await cache.put(req, stamped);
}

// ═══════════════════════════════════════════════════════════
//  MESSAGES
// ═══════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/**
 * MotoDash — sw.js  (v3 — MapLibre + PMTiles build)
 *
 * WHAT THIS SW DOES:
 * ──────────────────
 * 1. Caches the entire app shell on first install so the app loads
 *    instantly and works offline (except live data APIs).
 * 2. MapLibre font glyphs (.pbf) are cached aggressively — they never
 *    change and are the heaviest asset to re-download.
 * 3. Nominatim search responses are cached 1 hour (stale-ok offline).
 * 4. OSRM routes are NEVER cached (routes must always reflect live
 *    road conditions).
 * 5. PMTiles range-requests are NOT intercepted — the pmtiles.js
 *    library handles its own caching via the browser's HTTP cache.
 *
 * CACHE VERSION: bump on every deploy that changes any cached file.
 */
'use strict';

const CACHE_VERSION = 'v8-car-launcher-poi';
const CACHE_SHELL   = `motodash-shell-${CACHE_VERSION}`;
const CACHE_API     = `motodash-api-${CACHE_VERSION}`;
const TTL_API       = 60 * 60 * 1000;   // 1 hour

const SHELL_URLS = [
    /* App pages */
    './index.html',
    './manifest.json',

    /* CSS */
    './css/fonts.css',
    './css/tokens.css',
    './css/themes/origin.css',
    './css/themes/nexus.css',
    './css/themes/techno.css',
    './css/style.css',

    /* App JS */
    './js/utilities.js',
    './js/core/config.js',
    './js/trip.js',
    './js/speedometer.js',
    './js/core/map-provider-interface.js',
    './js/map-providers/maplibre-provider.js',
    './js/maps.js',
    './js/bluetooth.js',
    './js/voice.js',
    './js/media.js',
    './js/widgets/weather.js',
    './js/app.js',

    /* Map style JSONs — theme × day/night matrix */
    './js/map-styles/origin-night.json',
    './js/map-styles/origin-day.json',
    './js/map-styles/nexus-night.json',
    './js/map-styles/nexus-day.json',
    './js/map-styles/techno-night.json',
    './js/map-styles/techno-day.json',
    './js/map-styles/mapstyle-street.json',
    './js/map-styles/mapstyle-dark.json',
    './js/map-styles/mapstyle-grayscale.json',
    './js/map-styles/mapstyle-minimal.json',

    /* MapLibre GL JS engine (self-hosted) */
    './vendor/maplibre/maplibre-gl.js',
    './vendor/maplibre/maplibre-gl-csp-worker.js',
    './vendor/maplibre/maplibre-gl.css',

    /* PMTiles protocol library */
    './vendor/pmtiles/pmtiles.js',

    /* Map sprite sheets (dark + light, 1x + 2x) */
    './vendor/maplibre/sprites/dark.png',
    './vendor/maplibre/sprites/dark@2x.png',
    './vendor/maplibre/sprites/dark.json',
    './vendor/maplibre/sprites/light.png',
    './vendor/maplibre/sprites/light@2x.png',
    './vendor/maplibre/sprites/light.json',

    /* Media tag reader */
    './vendor/jsmediatags/jsmediatags.js',

    /* PWA icons */
    './assets/icons/icon.svg',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    './assets/icons/icon-192-maskable.png',
    './assets/icons/icon-512-maskable.png',
    './assets/icons/beat-logo.png',   /* splash screen logo */
];

/* ── INSTALL ── */
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_SHELL);
        // Fetch individually — one missing optional file won't abort install
        let ok = 0, skip = 0;
        for (const url of SHELL_URLS) {
            try {
                const res = await fetch(url);
                if (res.ok) { await cache.put(url, res); ok++; }
                else skip++;
            } catch { skip++; }
        }
        console.log(`[SW] Installed ${CACHE_VERSION} — cached ${ok}, skipped ${skip}`);
        await self.skipWaiting();
    })());
});

/* ── ACTIVATE — purge old caches ── */
self.addEventListener('activate', event => {
    const KEEP = new Set([CACHE_SHELL, CACHE_API]);
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
    console.log('[SW] Activated —', CACHE_VERSION);
});

/* ── FETCH ── */
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    /* MapLibre glyph fonts (.pbf) — Cache-First, very long TTL.
       These are requested per-tile-view; cache them aggressively so
       labels load instantly after first render even offline. */
    if (url.pathname.endsWith('.pbf') && url.pathname.includes('/fonts/')) {
        event.respondWith(cacheFirst(req, CACHE_SHELL));
        return;
    }

    /* PMTiles source — let browser HTTP cache handle it.
       Range requests from pmtiles.js work correctly with the browser's
       own cache; intercepting them in the SW would break the Range
       header handling. */
    if (url.hostname === 'data.source.coop') {
        event.respondWith(fetch(req));
        return;
    }

    /* Nominatim search — Network-First, 1-hour TTL for offline fallback */
    if (url.hostname === 'nominatim.openstreetmap.org') {
        event.respondWith(networkFirstWithTTL(req, CACHE_API, TTL_API));
        return;
    }

    /* OSRM routing — Network-Only (routes must always be fresh) */
    if (url.hostname === 'router.project-osrm.org') {
        event.respondWith(
            fetch(req).catch(() =>
                new Response(JSON.stringify({ code: 'NoRoute', message: 'Offline' }),
                    { headers: { 'Content-Type': 'application/json' } })
            )
        );
        return;
    }

    /* Open-Meteo weather — Network-First, best-effort */
    if (url.hostname === 'api.open-meteo.com') {
        event.respondWith(networkFirstWithTTL(req, CACHE_API, TTL_API));
        return;
    }

    /* Any other cross-origin — pass through */
    if (url.origin !== self.location.origin) {
        event.respondWith(fetch(req));
        return;
    }

    /* Same-origin app shell — Stale-While-Revalidate */
    event.respondWith(staleWhileRevalidate(req, CACHE_SHELL));
});

/* ── STRATEGIES ── */
async function cacheFirst(req, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
    } catch {
        return new Response('', { status: 503 });
    }
}

async function networkFirstWithTTL(req, cacheName, ttlMs) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(req);
        if (res.ok) {
            const h = new Headers(res.headers);
            h.set('X-Cached-At', String(Date.now()));
            const body    = await res.arrayBuffer();
            const stamped = new Response(body, { status: res.status, headers: h });
            await cache.put(req, stamped);
            return new Response(body, { status: res.status, headers: res.headers });
        }
        return res;
    } catch {
        const cached  = await cache.match(req);
        const cachedAt = Number(cached?.headers?.get('X-Cached-At') || 0);
        if (cached && (Date.now() - cachedAt) <= ttlMs) return cached;
        return new Response('', { status: 503 });
    }
}

async function staleWhileRevalidate(req, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(req);
    const revalidate = fetch(req)
        .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
    return cached || await revalidate || new Response('', { status: 503 });
}

self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

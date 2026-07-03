/**
 * MotoDash — config.js
 * Central, single-source-of-truth configuration.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * Per the plugin/provider architecture, no other file should hardcode
 * a map data-source URL, provider name, or environment constant. If
 * you need to point this app at a different PMTiles archive, a self-
 * hosted region extract, or swap the rendering engine entirely, this
 * is the only file you touch.
 */

'use strict';

window.MotoDashConfig = {

    map: {
        /**
         * Active map rendering engine. The app talks to maps through
         * MapProviderInterface (js/core/map-provider-interface.js) —
         * business logic (search, routing, markers, follow-mode) is
         * 100% provider-agnostic. Today only 'maplibre' ships; the
         * interface exists so a future provider (or a Leaflot fallback
         * for environments without WebGL) can be added by writing one
         * new file, never by editing maps.js.
         */
        provider: 'maplibre',

        /**
         * PMTiles vector basemap source — a single, swappable URL.
         *
         * Default: Protomaps' official "latest daily build" mirror on
         * Source Cooperative. This URL is STABLE (it always serves the
         * current build, unlike https://build.protomaps.com/<date>.pmtiles
         * which is deleted after ~1 week — Protomaps explicitly
         * discourages hotlinking those dated URLs). Thanks to the
         * PMTiles format's HTTP Range Request design, the browser only
         * ever downloads the handful of vector tiles needed for the
         * visible viewport — never the full ~120GB planet archive.
         *
         * PRODUCTION RECOMMENDATION: for a public/high-traffic
         * deployment, extract just your riding region with the
         * `pmtiles` CLI and host the resulting (much smaller, much
         * faster) file yourself on Cloudflare R2 (free egress) or
         * GitHub Releases. See README.md → "Self-hosting your own
         * map region" for the exact command. Then change ONLY the
         * line below — nothing else in the app needs to change.
         */
        pmtilesUrl: 'https://data.source.coop/protomaps/openstreetmap/tiles/v3.pmtiles',

        /** Self-hosted glyphs/sprites — see vendor/maplibre/. */
        glyphsUrl: 'vendor/maplibre/fonts/{fontstack}/{range}.pbf',
        spritesDarkUrl : 'vendor/maplibre/sprites/dark',
        spritesLightUrl: 'vendor/maplibre/sprites/light',

        /** Pre-generated style JSON per [color-theme]-[time]. */
        styleDir: 'js/map-styles',

        /** Geocoding (place search) — Nominatim, no API key. */
        geocoder: {
            provider: 'nominatim',
            endpoint: 'https://nominatim.openstreetmap.org/search'
        },

        /** Turn-by-turn routing — OSRM public demo server, no API key. */
        router: {
            provider: 'osrm',
            endpoint: 'https://router.project-osrm.org/route/v1/driving'
        },

        /** Default camera if GPS hasn't produced a fix yet. */
        defaultCenter: { lat: -6.2088, lng: 106.8456 }, // Jakarta
        defaultZoom: 14,
        maxZoom: 19
    },

    weather: {
        /** Open-Meteo — free, no API key, used for the Weather widget. */
        endpoint: 'https://api.open-meteo.com/v1/forecast',
        refreshIntervalMs: 15 * 60 * 1000 // 15 min
    }
};

console.log('[Config] Loaded ✓');

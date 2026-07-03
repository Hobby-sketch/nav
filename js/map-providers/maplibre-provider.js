/**
 * MotoDash — maplibre-provider.js
 * MapLibre GL JS + PMTiles implementation of MapProviderInterface.
 *
 * Renders the self-hosted Protomaps vector basemap (see config.js for
 * the PMTiles source + js/map-styles/*.json for the 6 themed styles
 * generated from the Ducati/Zontes/Origin reference palettes).
 *
 * Routing is implemented directly against the public OSRM API (the
 * same backend the app always used) — Leaflet Routing Machine is no
 * longer a dependency; this file owns a small, focused OSRM client
 * instead, giving full control over turn-by-turn step parsing and
 * route line styling.
 */

'use strict';

class MapLibreProvider extends MapProviderInterface {

    constructor() {
        super();
        this.map = null;
        this.userMarker = null;
        this.destMarker = null;
        this._listeners = {};
        this._protocolRegistered = false;
        this._currentTheme = 'origin';
        this._currentTime  = 'night';
    }

    // ─────────────────────────────────────────────────────
    //  INIT
    // ─────────────────────────────────────────────────────
    async init(containerId, opts = {}) {
        this._registerPmtilesProtocol();

        const cfg = window.MotoDashConfig.map;
        this._currentTheme = opts.theme || 'origin';
        this._currentTime  = opts.time  || 'night';

        // CSP-safe worker: ship maplibre-gl-csp-worker.js explicitly so
        // MapLibre never falls back to a blob: URL worker (which our
        // strict worker-src 'self' CSP would block).
        maplibregl.setWorkerUrl('vendor/maplibre/maplibre-gl-csp-worker.js');

        const style = await this._loadStyle(this._currentTheme, this._currentTime);
        const center = opts.center || cfg.defaultCenter;

        this.map = new maplibregl.Map({
            container: containerId,
            style,
            center: [center.lng, center.lat],
            zoom: opts.zoom ?? cfg.defaultZoom,
            maxZoom: cfg.maxZoom,
            attributionControl: false,
            dragRotate: true,
            pitchWithRotate: false,
            touchPitch: false
        });

        this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), 'bottom-right');

        this.map.on('dragstart', () => this._emit('userdrag', {}));
        this.map.on('click', (e) => this._emit('click', { lat: e.lngLat.lat, lng: e.lngLat.lng }));

        await new Promise((resolve) => {
            if (this.map.loaded()) return resolve();
            this.map.on('load', resolve);
        });

        this._ensureRouteLayer();
        console.log('[MapLibreProvider] Initialized ✓');
    }

    _registerPmtilesProtocol() {
        if (this._protocolRegistered) return;
        const protocol = new pmtiles.Protocol();
        maplibregl.addProtocol('pmtiles', protocol.tile);
        this._protocolRegistered = true;
    }

    async _loadStyle(theme, time) {
        const cfg = window.MotoDashConfig.map;
        const url = `${cfg.styleDir}/${theme}-${time}.json`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Style not found: ${url}`);
        const style = await resp.json();
        // Patch the placeholder PMTiles URL with the configured source —
        // the single point of truth in config.js. Style JSON files are
        // never edited directly to change the tile source.
        style.sources.protomaps.url = `pmtiles://${cfg.pmtilesUrl}`;
        return style;
    }

    // ─────────────────────────────────────────────────────
    //  CAMERA
    // ─────────────────────────────────────────────────────
    setView(lat, lng, zoom, animate = true) {
        if (!this.map) return;
        const fn = animate ? 'easeTo' : 'jumpTo';
        this.map[fn]({ center: [lng, lat], zoom: zoom ?? this.map.getZoom() });
    }

    getZoom() { return this.map ? this.map.getZoom() : 0; }
    setZoom(z) { this.map?.setZoom(z); }

    resize() { this.map?.resize(); }

    // ─────────────────────────────────────────────────────
    //  MARKERS
    // ─────────────────────────────────────────────────────
    _motoMarkerEl(heading = 0) {
        const el = document.createElement('div');
        el.className = 'moto-marker-wrap';
        el.style.transform = `rotate(${heading}deg)`;
        el.innerHTML = `
          <svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
            <circle cx="22" cy="22" r="20" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="2"/>
            <polygon points="22,6 28,34 22,29 16,34" fill="currentColor"/>
            <circle cx="22" cy="22" r="4" fill="#FFFFFF" opacity="0.9"/>
            <circle cx="22" cy="22" r="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4" class="moto-pulse"/>
          </svg>`;
        return el;
    }

    updateUserMarker(lat, lng, headingDeg = 0) {
        if (!this.map) return;
        if (!this.userMarker) {
            const el = this._motoMarkerEl(headingDeg);
            this.userMarker = new maplibregl.Marker({ element: el, pitchAlignment: 'map' })
                .setLngLat([lng, lat]).addTo(this.map);
            this.userMarker._motoEl = el;
        } else {
            this.userMarker.setLngLat([lng, lat]);
            this.userMarker._motoEl.style.transform = `rotate(${headingDeg}deg)`;
        }
    }

    placeDestinationMarker(lat, lng, label = 'Destination') {
        if (!this.map) return;
        this.removeDestinationMarker();
        const el = document.createElement('div');
        el.className = 'dest-pin';
        el.innerHTML = `
          <svg width="32" height="44" viewBox="0 0 32 44">
            <path d="M16 0C7.16 0 0 7.16 0 16 0 28 16 44 16 44S32 28 32 16C32 7.16 24.84 0 16 0Z" fill="#FF4444"/>
            <circle cx="16" cy="16" r="8" fill="white" opacity="0.9"/>
          </svg>`;
        this.destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([lng, lat])
            .setPopup(new maplibregl.Popup({ offset: 24, closeButton: false }).setText(label.slice(0, 40)))
            .addTo(this.map);
    }

    removeDestinationMarker() {
        this.destMarker?.remove();
        this.destMarker = null;
    }

    fitBounds(points, paddingPx = 40) {
        if (!this.map || !points.length) return;
        const lngs = points.map(p => p.lng), lats = points.map(p => p.lat);
        this.map.fitBounds(
            [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
            { padding: paddingPx, animate: true }
        );
    }

    // ─────────────────────────────────────────────────────
    //  ROUTE LINE (GeoJSON source/layer — replaces Leaflet
    //  Routing Machine's polyline, themed via brand tokens)
    // ─────────────────────────────────────────────────────
    _ensureRouteLayer() {
        if (this.map.getSource('route')) return;
        this.map.addSource('route', {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
        });
        this.map.addLayer({
            id: 'route-casing',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#000000', 'line-width': 9, 'line-opacity': 0.35 }
        });
        this.map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': Utils.getCSSVar('--brand-primary', '#3DDBC4'),
                'line-width': 5,
                'line-opacity': 0.92
            }
        });
    }

    drawRoute(coordinatesLatLng) {
        if (!this.map) return;
        this._ensureRouteLayer();
        const coords = coordinatesLatLng.map(p => [p.lng, p.lat]);
        this.map.getSource('route').setData({
            type: 'Feature', geometry: { type: 'LineString', coordinates: coords }
        });
        // Re-read the live brand color each time a route is drawn so the
        // line always matches the active theme without a style reload.
        if (this.map.getLayer('route-line')) {
            this.map.setPaintProperty('route-line', 'line-color', Utils.getCSSVar('--brand-primary', '#3DDBC4'));
        }
    }

    clearRoute() {
        this.map?.getSource('route')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
    }

    // ─────────────────────────────────────────────────────
    //  GEOCODING — Nominatim (unchanged backend, same as before)
    // ─────────────────────────────────────────────────────
    async geocode(query) {
        const cfg = window.MotoDashConfig.map.geocoder;
        const url = `${cfg.endpoint}?q=${encodeURIComponent(query)}&format=json&limit=6&addressdetails=1`;
        const resp = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'MotoDash/2.0 (https://github.com/motodash)' }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const results = await resp.json();
        return results.map(r => ({
            lat: +r.lat, lng: +r.lon,
            name: r.display_name.split(',')[0],
            address: r.display_name.split(',').slice(1, 3).join(', '),
            fullName: r.display_name
        }));
    }

    // ─────────────────────────────────────────────────────
    //  ROUTING — direct OSRM client (turn-by-turn step parser)
    // ─────────────────────────────────────────────────────
    /** Maps OSRM maneuver {type, modifier} → display arrow + label. */
    static MANEUVER_ICONS = {
        'depart'            : { arrow: '⬆', label: 'Start' },
        'arrive'            : { arrow: '🏁', label: 'Arrive at destination' },
        'turn-straight'     : { arrow: '⬆', label: 'Continue straight' },
        'turn-slight right' : { arrow: '↗', label: 'Slight right' },
        'turn-right'        : { arrow: '➡', label: 'Turn right' },
        'turn-sharp right'  : { arrow: '↪', label: 'Sharp right' },
        'turn-slight left'  : { arrow: '↖', label: 'Slight left' },
        'turn-left'         : { arrow: '⬅', label: 'Turn left' },
        'turn-sharp left'   : { arrow: '↩', label: 'Sharp left' },
        'turn-uturn'        : { arrow: '↩', label: 'U-turn' },
        'roundabout'        : { arrow: '🔄', label: 'Enter roundabout' },
        'rotary'            : { arrow: '🔄', label: 'Enter roundabout' },
        'merge'             : { arrow: '↗', label: 'Merge' },
        'fork'              : { arrow: '↗', label: 'Keep right at fork' },
        'end of road'       : { arrow: '➡', label: 'At the end of the road' },
        'continue'          : { arrow: '⬆', label: 'Continue' },
        'new name'          : { arrow: '⬆', label: 'Continue' },
        'default'           : { arrow: '⬆', label: 'Continue' }
    };

    static _iconFor(maneuver) {
        const key = maneuver.modifier
            ? `${maneuver.type}-${maneuver.modifier}`
            : maneuver.type;
        return MapLibreProvider.MANEUVER_ICONS[key] || MapLibreProvider.MANEUVER_ICONS[maneuver.type] || MapLibreProvider.MANEUVER_ICONS.default;
    }

    async route(from, to) {
        const cfg = window.MotoDashConfig.map.router;
        const url = `${cfg.endpoint}/${from.lng},${from.lat};${to.lng},${to.lat}` +
                    `?overview=full&geometries=geojson&steps=true&alternatives=false`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.code !== 'Ok' || !data.routes?.length) throw new Error(`OSRM: ${data.code || 'no route'}`);

        const r = data.routes[0];
        const coordinates = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

        const steps = [];
        r.legs.forEach(leg => leg.steps.forEach(s => {
            const icon = MapLibreProvider._iconFor(s.maneuver);
            steps.push({
                type: s.maneuver.type,
                modifier: s.maneuver.modifier || null,
                name: s.name || '',
                distanceM: s.distance,
                durationS: s.duration,
                location: { lat: s.maneuver.location[1], lng: s.maneuver.location[0] },
                arrow: icon.arrow,
                label: s.name ? `${icon.label} onto ${s.name}` : icon.label
            });
        }));

        return { coordinates, distanceM: r.distance, durationS: r.duration, steps };
    }

    // ─────────────────────────────────────────────────────
    //  THEME / STYLE SWAP
    // ─────────────────────────────────────────────────────
    async setStyle(theme, time) {
        if (!this.map) return;
        this._currentTheme = theme;
        this._currentTime  = time;
        const style = await this._loadStyle(theme, time);
        this.map.setStyle(style);
        this.map.once('styledata', () => {
            this._ensureRouteLayer();
            this._emit('styleload', { theme, time });
        });
    }

    /**
     * Load one of the independent Map Style presets (mapstyle-street,
     * mapstyle-dark, mapstyle-grayscale, mapstyle-minimal) — these are
     * NOT theme-tinted, they're neutral basemap looks a rider can pick
     * regardless of the active color theme (see js/widgets quick
     * settings → "Map Style: Street/Dark/Grayscale/Minimal").
     */
    async setStylePreset(presetId) {
        if (!this.map) return;
        const cfg = window.MotoDashConfig.map;
        const url = `${cfg.styleDir}/${presetId}.json`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Style preset not found: ${url}`);
        const style = await resp.json();
        style.sources.protomaps.url = `pmtiles://${cfg.pmtilesUrl}`;
        this.map.setStyle(style);
        this.map.once('styledata', () => {
            this._ensureRouteLayer();
            this._emit('styleload', { preset: presetId });
        });
    }

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────
    on(event, handler) {
        (this._listeners[event] ||= []).push(handler);
    }
    off(event, handler) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    }
    _emit(event, payload) {
        (this._listeners[event] || []).forEach(h => { try { h(payload); } catch (e) { console.error(e); } });
    }

    // ─────────────────────────────────────────────────────
    //  CLEANUP
    // ─────────────────────────────────────────────────────
    destroy() {
        this.map?.remove();
        this.map = null;
        this._listeners = {};
    }
}

window.MapLibreProvider = MapLibreProvider;
console.log('[MapLibreProvider] Loaded ✓');

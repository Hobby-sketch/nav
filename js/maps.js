/**
 * MotoDash — maps.js
 * Map business logic: search UX, navigation state machine, trip
 * integration, follow mode. Talks ONLY to MapProviderInterface
 * (js/core/map-provider-interface.js) — this file has zero knowledge
 * of MapLibre, Leaflet, or any specific rendering engine. Swapping
 * the engine never requires touching anything below.
 *
 * Feature parity with the previous Leaflet+LRM implementation:
 * Nominatim search (debounced dropdown), OSRM turn-by-turn routing,
 * ETA/remaining-distance display, step-by-step progress tracking,
 * voice-driven navigation, follow mode, toolbar controls.
 */

'use strict';

class MapsModule {
    constructor() {
        this.provider        = null;
        this.currentPos      = null;  // { lat, lng }
        this.isFollowing     = true;
        this.isNavigating    = false;
        this.routeSteps      = [];
        this.currentStepIdx  = 0;
        this.totalDist       = 0;     // meters
        this.totalTime       = 0;     // seconds
        this._searchResults  = [];
        this._searchDebounce = null;

        this._init();
    }

    // ─────────────────────────────────────────────────────
    //  INITIALISE
    // ─────────────────────────────────────────────────────
    async _init() {
        const cfg = window.MotoDashConfig.map;

        // Provider selection — today only 'maplibre' ships, but this
        // is the one line that would change to add a second engine.
        this.provider = cfg.provider === 'maplibre' ? new MapLibreProvider() : null;
        if (!this.provider) {
            console.error(`[Maps] FATAL: unknown map provider "${cfg.provider}"`);
            Utils.showToast('Peta gagal dimuat — provider tidak dikenal', 'error', 6000);
            return;
        }

        const theme = document.documentElement.getAttribute('data-color-theme') || 'origin';
        const time  = document.documentElement.getAttribute('data-time') || 'night';

        try {
            await this.provider.init('map', { theme, time });

        // Immediately resize the canvas to fill its container.
        // On first load the map panel is already active (display:flex set
        // by app.js switchPanel('maps')), but the MapLibre canvas still
        // needs one explicit resize call to measure the correct dimensions.
        setTimeout(() => this.provider.resize(), 80);
        setTimeout(() => this.provider.resize(), 400);

        // Hide the "LOADING MAP…" placeholder now that init succeeded
        const loadingEl = document.getElementById('map-loading');
        if (loadingEl) loadingEl.style.display = 'none';
        } catch (err) {
            console.error('[Maps] FATAL: provider init failed:', err);
            const mapEl = document.getElementById('map');
            if (mapEl) {
                mapEl.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;
                                justify-content:center;height:100%;padding:24px;
                                text-align:center;color:#FF4444;font-family:sans-serif;">
                        <div style="font-size:40px;margin-bottom:12px;">⚠️</div>
                        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">
                            Peta gagal dimuat
                        </div>
                        <div style="font-size:13px;color:#7A9BB5;max-width:320px;line-height:1.6;">
                            Engine peta (MapLibre GL JS) gagal diinisialisasi. Cek folder
                            <code>vendor/</code> ter-upload, dan Console (F12) untuk detail.
                        </div>
                    </div>`;
            }
            Utils.showToast('Peta gagal dimuat — cek Console', 'error', 6000);
            return;
        }

        // Stop auto-follow when the rider drags the map
        this.provider.on('userdrag', () => { this.isFollowing = false; });

        this._setupSearch();
        this._setupToolbarButtons();
        this._subscribeGPS();
        this._subscribeEvents();

        console.log('[Maps] Initialized ✓ (provider: maplibre)');
    }

    /** Called by app.js whenever the map container becomes visible/resized. */
    resize() {
        this.provider?.resize();
    }

    /**
     * Reload the basemap style. Called by app.js whenever color
     * theme, day/night, or the Map Style quick-setting changes.
     * @param {string} theme        'origin' | 'nexus' | 'techno'
     * @param {string} time         'day' | 'night'
     * @param {string} mapStyleSetting  'theme' (follow theme/time) or a
     *                                  'mapstyle-*' preset id
     */
    applyStyleFromSettings(theme, time, mapStyleSetting) {
        if (!this.provider) return;
        if (!mapStyleSetting || mapStyleSetting === 'theme') {
            this.provider.setStyle(theme, time);
        } else {
            // Independent preset (Street/Dark/Grayscale/Minimal) —
            // decoupled from the color-theme system entirely.
            this.provider.setStylePreset(mapStyleSetting);
        }
    }

    // ─────────────────────────────────────────────────────
    //  GPS SUBSCRIPTION
    // ─────────────────────────────────────────────────────
    _subscribeGPS() {
        Utils.EventBus.on('gps:update', ({ lat, lng, heading, speed }) => {
            this.currentPos = { lat, lng };
            this.provider.updateUserMarker(lat, lng, heading || 0);

            if (this.isFollowing) {
                this.provider.setView(lat, lng, this.provider.getZoom(), true);
            }

            if (this.isNavigating) {
                this._checkStepProgress(lat, lng, speed);
            }
        });
    }

    // ─────────────────────────────────────────────────────
    //  SEARCH (Nominatim, via provider.geocode())
    // ─────────────────────────────────────────────────────
    _setupSearch() {
        const input = document.getElementById('search-input');
        const btn   = document.getElementById('search-btn');

        btn?.addEventListener('click',  () => this._doSearch());
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._doSearch(); });
        input?.addEventListener('input', () => {
            clearTimeout(this._searchDebounce);
            const q = input.value.trim();
            if (q.length >= 3) {
                this._searchDebounce = setTimeout(() => this._doSearch(true), 650);
            } else {
                this._hideResults();
            }
        });

        /* Close dropdown when clicking outside */
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#map-toolbar') && !e.target.closest('#search-results'))
                this._hideResults();
        });
    }

    async _doSearch(silent = false) {
        const input = document.getElementById('search-input');
        const q     = input?.value?.trim();
        if (!q || q.length < 2) return;

        try {
            const results = await this.provider.geocode(q);
            this._searchResults = results;
            this._showResults(results);
        } catch (err) {
            console.error('[Maps] Search error:', err);
            if (!silent) Utils.showToast('Search failed — check network', 'error');
        }
    }

    _showResults(results) {
        const box = document.getElementById('search-results');
        if (!box) return;

        if (!results.length) {
            box.innerHTML = '<div class="search-no-result">No results found</div>';
            box.style.display = 'block';
            return;
        }

        box.innerHTML = results.map((r, i) => `
            <div class="search-result-item" data-i="${i}">
              <svg class="sr-pin" width="14" height="14" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              <div class="sr-text">
                <div class="sr-name">${r.name}</div>
                <div class="sr-addr">${r.address}</div>
              </div>
            </div>`).join('');
        box.style.display = 'block';

        box.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                const r = this._searchResults[+el.dataset.i];
                if (r) this._selectDestination(r.lat, r.lng, r.fullName);
            });
        });
    }

    _hideResults() {
        const box = document.getElementById('search-results');
        if (box) box.style.display = 'none';
    }

    // ─────────────────────────────────────────────────────
    //  SELECT & NAVIGATE
    // ─────────────────────────────────────────────────────
    _selectDestination(lat, lng, name) {
        this._hideResults();
        const label = name.split(',')[0];
        const input = document.getElementById('search-input');
        if (input) input.value = label;

        this.provider.placeDestinationMarker(lat, lng, label);
        this.provider.fitBounds([
            { lat: this.currentPos?.lat ?? lat - 0.01, lng: this.currentPos?.lng ?? lng - 0.01 },
            { lat, lng }
        ], 40);

        if (this.currentPos) {
            this._startNavigation(this.currentPos.lat, this.currentPos.lng, lat, lng, label);
        } else {
            Utils.showToast('Waiting for GPS fix to begin navigation…', 'warning');
        }
    }

    // ─────────────────────────────────────────────────────
    //  ROUTING  (direct OSRM client inside MapLibreProvider)
    // ─────────────────────────────────────────────────────
    async _startNavigation(fromLat, fromLng, toLat, toLng, destName) {
        this.isNavigating   = true;
        this.currentStepIdx = 0;
        Utils.showToast('Calculating route…', 'info');

        try {
            const result = await this.provider.route(
                { lat: fromLat, lng: fromLng }, { lat: toLat, lng: toLng }
            );

            this.routeSteps = result.steps;
            this.totalDist  = result.distanceM;
            this.totalTime  = result.durationS;
            this.currentStepIdx = 0;

            this.provider.drawRoute(result.coordinates);

            this._showNavBar(true);
            this._showNavStopBtn(true);
            this._renderStep(0);

            const d = Utils.formatDistance(this.totalDist);
            const t = Utils.formatETA(this.totalTime);
            Utils.showToast(`Route found: ${d} · ETA ${t}`, 'success');

            Utils.EventBus.emit('voice:announce',
                { text: `Route calculated. ${d}. Estimated ${t}.` }
            );
        } catch (err) {
            console.error('[Maps] Routing error:', err);
            Utils.showToast('Route calculation failed', 'error');
            this.isNavigating = false;
        }
    }

    stopNavigation() {
        this.provider.clearRoute();
        this.provider.removeDestinationMarker();
        this.isNavigating   = false;
        this.routeSteps     = [];
        this.currentStepIdx = 0;

        this._showNavBar(false);
        this._showNavStopBtn(false);

        const input = document.getElementById('search-input');
        if (input) input.value = '';

        Utils.showToast('Navigation stopped', 'info');
    }

    // ─────────────────────────────────────────────────────
    //  TURN-BY-TURN RENDERING
    // ─────────────────────────────────────────────────────
    _renderStep(idx) {
        if (!this.routeSteps.length || idx >= this.routeSteps.length) return;
        const step  = this.routeSteps[idx];
        const dist  = Utils.formatDistance(step.distanceM || 0);
        const text  = step.label || 'Continue';

        /* Remaining distance / time from current step onward */
        let remDist = this.totalDist;
        let remTime = this.totalTime;
        for (let i = 0; i < idx; i++) {
            remDist -= (this.routeSteps[i]?.distanceM || 0);
            remTime -= (this.routeSteps[i]?.durationS || 0);
        }
        remDist = Math.max(0, remDist);
        remTime = Math.max(0, remTime);

        Utils.setEl('nav-turn-icon',        step.arrow || '⬆');
        Utils.setEl('nav-instruction-text', text);
        Utils.setEl('nav-step-distance',    dist);
        Utils.setEl('nav-remaining',        Utils.formatDistance(remDist));

        /* Arrival time */
        const eta  = new Date(Date.now() + remTime * 1000);
        const etaS = `${String(eta.getHours()).padStart(2,'0')}:${String(eta.getMinutes()).padStart(2,'0')}`;
        Utils.setEl('nav-eta', `ETA ${etaS}`);
    }

    _checkStepProgress(lat, lng, speed) {
        if (!this.routeSteps.length) return;
        const step = this.routeSteps[this.currentStepIdx];
        if (!step?.location) return;

        const dist = Utils.haversineDistance(lat, lng, step.location.lat, step.location.lng);
        /* Advance step when within 25 m of waypoint */
        if (dist < 25 && this.currentStepIdx < this.routeSteps.length - 1) {
            this.currentStepIdx++;
            this._renderStep(this.currentStepIdx);
            const nextStep = this.routeSteps[this.currentStepIdx];
            if (nextStep?.label) {
                Utils.EventBus.emit('voice:announce', { text: nextStep.label });
            }
        }
    }

    // ─────────────────────────────────────────────────────
    //  VOICE-DRIVEN NAVIGATE
    // ─────────────────────────────────────────────────────
    async navigateTo(query) {
        try {
            const results = await this.provider.geocode(query);
            if (results.length) {
                this._selectDestination(results[0].lat, results[0].lng, results[0].fullName);
                return true;
            }
            Utils.showToast(`Location not found: ${query}`, 'warning');
        } catch {
            Utils.showToast('Navigation search failed', 'error');
        }
        return false;
    }

    // ─────────────────────────────────────────────────────
    //  MAP CONTROLS
    // ─────────────────────────────────────────────────────
    centerOnLocation() {
        if (!this.currentPos) { Utils.showToast('GPS not available', 'warning'); return; }
        this.isFollowing = true;
        this.provider.setView(this.currentPos.lat, this.currentPos.lng, 16, true);
    }

    zoomIn()  { this.provider?.setZoom(this.provider.getZoom() + 1); }
    zoomOut() { this.provider?.setZoom(this.provider.getZoom() - 1); }

    // ─────────────────────────────────────────────────────
    //  NAV UI HELPERS
    // ─────────────────────────────────────────────────────
    _showNavBar(visible) {
        const el = document.getElementById('nav-instruction-bar');
        if (el) el.style.display = visible ? 'flex' : 'none';
    }
    _showNavStopBtn(visible) {
        const el = document.getElementById('nav-stop-btn');
        if (el) el.style.display = visible ? 'flex' : 'none';
    }

    // ─────────────────────────────────────────────────────
    //  TOOLBAR BUTTONS
    // ─────────────────────────────────────────────────────
    _setupToolbarButtons() {
        document.getElementById('center-map-btn')
            ?.addEventListener('click', () => this.centerOnLocation());
        document.getElementById('nav-stop-btn')
            ?.addEventListener('click', () => this.stopNavigation());
    }

    // ─────────────────────────────────────────────────────
    //  EVENT BUS
    // ─────────────────────────────────────────────────────
    _subscribeEvents() {
        Utils.EventBus.on('navigate:to', ({ destination }) => this.navigateTo(destination));
        Utils.EventBus.on('map:zoom-in',  () => this.zoomIn());
        Utils.EventBus.on('map:zoom-out', () => this.zoomOut());
        Utils.EventBus.on('map:center',   () => this.centerOnLocation());
        Utils.EventBus.on('nav:stop',     () => this.stopNavigation());
    }
}

/* ── Bootstrap ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    /* Small delay — ensures the map <div> is painted */
    setTimeout(() => {
        /*
         * DEFENSIVE CHECK: if MapLibre GL JS or pmtiles failed to load
         * (vendor/ folder not deployed, network issue), show a clear
         * visible error instead of silently failing with a blank map.
         */
        if (typeof maplibregl === 'undefined' || typeof pmtiles === 'undefined') {
            const mapEl = document.getElementById('map');
            if (mapEl) {
                mapEl.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;
                                justify-content:center;height:100%;padding:24px;
                                text-align:center;color:#FF4444;font-family:sans-serif;">
                        <div style="font-size:40px;margin-bottom:12px;">⚠️</div>
                        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">
                            Peta gagal dimuat
                        </div>
                        <div style="font-size:13px;color:#7A9BB5;max-width:320px;line-height:1.6;">
                            File vendor/maplibre/maplibre-gl.js atau vendor/pmtiles/pmtiles.js
                            tidak berhasil dimuat. Pastikan folder <code>vendor/</code> ikut
                            ter-upload ke GitHub. Cek juga Console (F12) untuk detail error.
                        </div>
                    </div>`;
            }
            console.error('[Maps] FATAL: maplibregl or pmtiles is not defined — vendor/ failed to load.');
            Utils.showToast?.('Peta gagal dimuat — cek folder vendor/', 'error', 6000);
            return;
        }

        window.mapsModule = new MapsModule();
        console.log('[Maps] Ready ✓');
    }, 150);
});

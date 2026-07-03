/**
 * MotoDash — weather.js
 * Weather widget: Open-Meteo (https://open-meteo.com), no API key,
 * informational only — never used to alter ride simulation/state.
 * Updates the status-bar weather pill (#weather-widget) using the
 * rider's current GPS position, refreshing periodically and whenever
 * the rider has moved far enough that the last reading is stale.
 */

'use strict';

class WeatherWidget {
    constructor() {
        this.lastFetchPos  = null;   // { lat, lng } at last successful fetch
        this.lastFetchTime = 0;
        this._minMoveKm    = 10;     // re-fetch if moved further than this
        this._init();
    }

    _init() {
        Utils.EventBus.on('gps:update', ({ lat, lng }) => this._maybeFetch(lat, lng));
        console.log('[Weather] Initialized ✓');
    }

    _maybeFetch(lat, lng) {
        const cfg  = window.MotoDashConfig.weather;
        const now  = Date.now();
        const due  = (now - this.lastFetchTime) >= cfg.refreshIntervalMs;

        let movedFar = true;
        if (this.lastFetchPos) {
            const d = Utils.haversineDistance(
                this.lastFetchPos.lat, this.lastFetchPos.lng, lat, lng
            );
            movedFar = (d / 1000) >= this._minMoveKm;
        }

        if (due || movedFar) this._fetch(lat, lng);
    }

    async _fetch(lat, lng) {
        const cfg = window.MotoDashConfig.weather;
        try {
            const url = `${cfg.endpoint}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
                        `&current=temperature_2m,weather_code&timezone=auto`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();

            this.lastFetchPos  = { lat, lng };
            this.lastFetchTime = Date.now();

            this._render(data.current?.temperature_2m, data.current?.weather_code);
        } catch (err) {
            // Weather is purely informational — fail silently (no toast
            // spam), just leave the widget hidden/stale.
            console.warn('[Weather] fetch failed:', err.message);
        }
    }

    /** WMO weather codes → a compact glyph set (https://open-meteo.com/en/docs, "WMO Weather interpretation codes"). */
    static ICONS = {
        0: '☀',  1: '🌤', 2: '⛅', 3: '☁',
        45: '🌫', 48: '🌫',
        51: '🌦', 53: '🌦', 55: '🌦',
        61: '🌧', 63: '🌧', 65: '🌧',
        66: '🌧', 67: '🌧',
        71: '🌨', 73: '🌨', 75: '🌨', 77: '🌨',
        80: '🌦', 81: '🌧', 82: '⛈',
        85: '🌨', 86: '🌨',
        95: '⛈', 96: '⛈', 99: '⛈'
    };

    _render(tempC, code) {
        const widget = document.getElementById('weather-widget');
        const iconEl = document.getElementById('weather-icon');
        const tempEl = document.getElementById('weather-temp');
        if (!widget) return;

        if (typeof tempC === 'number') {
            if (tempEl) tempEl.textContent = `${Math.round(tempC)}°`;
            if (iconEl) iconEl.textContent = WeatherWidget.ICONS[code] ?? '—';
            widget.style.display = 'flex';
        }
    }
}

// ── Bootstrap ────────────────────────────────────────────
window.weatherWidget = new WeatherWidget();
console.log('[Weather] Ready ✓');

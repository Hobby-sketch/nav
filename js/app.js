/**
 * MotoDash — app.js
 * Main Application Controller:
 * panel switching, status bar, Wake Lock, Screen Orientation,
 * settings UI, auto theme, dial pad, PWA service worker.
 */

'use strict';

class MotoDash {
    constructor() {
        this.currentPanel = 'maps';
        this.wakeLock     = null;
        this.settings     = this._loadSettings();

        this._init();
        console.log('[MotoDash] Application started ✓');
    }

    // ─────────────────────────────────────────────────────
    //  INITIALISE
    // ─────────────────────────────────────────────────────
    _init() {
        this._setupDock();
        this._startClock();
        this._watchNetworkStatus();
        this._requestBattery();
        this._requestWakeLock();
        this._lockOrientation();
        this._applySettings();
        this._setupSettingsUI();
        this._setupQuickSettings();
        this._setupDialPad();
        this._applyAutoTheme();
        this._registerSW();
        this._subscribeEvents();

        /* Switch to maps on start */
        this.switchPanel('maps');

        setTimeout(() => Utils.showToast('MotoDash ready — ride safe! 🏍', 'success'), 800);
    }

    // ─────────────────────────────────────────────────────
    //  DOCK & PANEL SWITCHING
    // ─────────────────────────────────────────────────────
    _setupDock() {
        document.querySelectorAll('.dock-btn').forEach(btn =>
            btn.addEventListener('click', () => this.switchPanel(btn.dataset.panel))
        );
    }

    switchPanel(name) {
        this.currentPanel = name;

        document.querySelectorAll('.content-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.dock-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.panel === name)
        );

        const target = document.getElementById(`panel-${name}`);
        if (target) target.classList.add('active');

        /*
         * The map provider needs to be told whenever its container
         * becomes visible/resized (true for MapLibre's WebGL canvas
         * just as it was for Leaflet). Uses a 300ms delay to cover
         * both: (a) the MapsModule init delay on first load, and
         * (b) the CSS fade-slide animation on subsequent switches.
         * Goes through the provider-agnostic resize() — maps.js never
         * exposes which engine is active.
         */
        if (name === 'maps') {
            setTimeout(() => window.mapsModule?.resize(), 300);
        }
    }

    // ─────────────────────────────────────────────────────
    //  CLOCK & DATE  (status bar)
    // ─────────────────────────────────────────────────────
    _startClock() {
        const tick = () => {
            Utils.setEl('current-time', Utils.getCurrentTime());
            Utils.setEl('current-date', Utils.getCurrentDate());
        };
        tick();
        setInterval(tick, 1000);
    }

    // ─────────────────────────────────────────────────────
    //  NETWORK STATUS
    // ─────────────────────────────────────────────────────
    _watchNetworkStatus() {
        const update = () => {
            const online = navigator.onLine;
            const ico    = document.getElementById('wifi-icon');
            if (ico) ico.style.opacity = online ? '1' : '0.3';
        };
        update();
        window.addEventListener('online',  () => { update(); Utils.showToast('Back online ✓', 'success'); });
        window.addEventListener('offline', () => { update(); Utils.showToast('Offline mode',  'warning'); });
        setInterval(update, 30000);
    }

    // ─────────────────────────────────────────────────────
    //  BATTERY STATUS
    // ─────────────────────────────────────────────────────
    async _requestBattery() {
        if (!('getBattery' in navigator)) return;
        try {
            const bat = await navigator.getBattery();
            const upd = () => {
                const lvl  = Math.round(bat.level * 100);
                this.batteryLevel = lvl; // expose for other modules (e.g. Origin cluster warning icon)
                Utils.setEl('battery-percent', `${lvl}%`);
                const fill = document.getElementById('battery-fill');
                if (fill) {
                    fill.style.width      = `${lvl}%`;
                    fill.style.background = lvl <= 20 ? '#FF4444' :
                                            lvl <= 50 ? '#FFAA00' : '#00FF66';
                }
            };
            upd();
            bat.addEventListener('levelchange',   upd);
            bat.addEventListener('chargingchange', upd);
        } catch { /* Battery API optional */ }
    }

    // ─────────────────────────────────────────────────────
    //  WAKE LOCK  (prevent screen sleep while riding)
    // ─────────────────────────────────────────────────────
    async _requestWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            console.log('[App] Wake Lock acquired');

            /* Re-acquire after tab visibility change */
            document.addEventListener('visibilitychange', async () => {
                if (document.visibilityState === 'visible') {
                    try { this.wakeLock = await navigator.wakeLock.request('screen'); }
                    catch { /* ignore */ }
                }
            });
        } catch (e) { console.warn('[App] Wake Lock:', e.message); }
    }

    // ─────────────────────────────────────────────────────
    //  SCREEN ORIENTATION  (force landscape)
    // ─────────────────────────────────────────────────────
    _lockOrientation() {
        screen.orientation?.lock?.('landscape').catch(() => {/* non-critical */});
    }

    // ─────────────────────────────────────────────────────
    //  FULLSCREEN
    // ─────────────────────────────────────────────────────
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            (document.documentElement.requestFullscreen?.() ||
             document.documentElement.webkitRequestFullscreen?.());
            Utils.setEl('fullscreen-btn-label', 'Exit Fullscreen');
        } else {
            (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
            Utils.setEl('fullscreen-btn-label', 'Enter Fullscreen');
        }
    }

    // ─────────────────────────────────────────────────────
    //  SETTINGS
    // ─────────────────────────────────────────────────────
    _loadSettings() {
        const defaults = {
            brightness  : 100,
            autoTheme   : true,
            highAccuracy: true,
            colorTheme  : 'origin',
            timeMode    : 'night',
            mapStyle    : 'theme'   // 'theme' = follow color-theme/day-night; or a mapstyle-* preset id
        };
        // Merge with defaults so users upgrading from an older version
        // (whose saved settings predate colorTheme/timeMode/mapStyle)
        // still get valid values instead of undefined.
        return { ...defaults, ...Utils.Storage.get('app_settings', {}) };
    }

    _saveSettings() { Utils.Storage.set('app_settings', this.settings); }

    _applySettings() {
        document.body.style.filter = `brightness(${this.settings.brightness}%)`;
        document.documentElement.setAttribute('data-color-theme', this.settings.colorTheme);

        // If auto day/night is off, restore the user's last manual choice
        // immediately (otherwise the page would sit at whatever static
        // default is in the HTML, ignoring their saved preference).
        if (!this.settings.autoTheme) {
            document.documentElement.setAttribute('data-time', this.settings.timeMode);
        }
    }

    _setupSettingsUI() {
        /* Brightness slider */
        const brightSlider = document.getElementById('brightness-slider');
        if (brightSlider) {
            brightSlider.value = this.settings.brightness;
            brightSlider.addEventListener('input', () => {
                this.settings.brightness = +brightSlider.value;
                Utils.setEl('brightness-value', `${brightSlider.value}%`);
                document.body.style.filter = `brightness(${brightSlider.value}%)`;
                this._saveSettings();
            });
        }

        /* Auto theme toggle */
        const autoTheme = document.getElementById('auto-theme-toggle');
        if (autoTheme) {
            autoTheme.checked = this.settings.autoTheme;
            autoTheme.addEventListener('change', () => {
                this.settings.autoTheme = autoTheme.checked;
                this._saveSettings();
                this._applyAutoTheme(); // re-engage time-based switching immediately
            });
        }

        /* Color Theme swatches (Origin / Nexus / Techno) — sync active
         * state to loaded settings, since the HTML default may not match
         * what the user previously chose. Also covers the Quick
         * Settings chips (.qs-chip[data-theme]) — one selector, one
         * handler, no duplicated logic between the two surfaces. */
        document.querySelectorAll('.theme-swatch, .qs-chip[data-theme]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === this.settings.colorTheme);
            btn.addEventListener('click', () => this.setColorTheme(btn.dataset.theme));
        });

        /* Manual Day / Night override buttons — same sync logic, also
         * covers Quick Settings day/night chips. */
        document.querySelectorAll('.daynight-btn, .qs-chip[data-time]:not(.qs-chip-auto)').forEach(btn => {
            btn.classList.toggle('active', !this.settings.autoTheme && btn.dataset.time === this.settings.timeMode);
            btn.addEventListener('click', () => this.setTimeMode(btn.dataset.time, true));
        });

        /* Quick Settings "AUTO" chip — re-engages time-based switching */
        document.querySelectorAll('.qs-chip-auto').forEach(btn => {
            btn.classList.toggle('active', this.settings.autoTheme);
            btn.addEventListener('click', () => {
                this.settings.autoTheme = true;
                const autoToggle = document.getElementById('auto-theme-toggle');
                if (autoToggle) autoToggle.checked = true;
                this._saveSettings();
                this._applyAutoTheme();
                Utils.showToast('Auto Day/Night re-enabled', 'info');
            });
        });

        /* High GPS accuracy toggle */
        const hiAcc = document.getElementById('high-accuracy-toggle');
        if (hiAcc) {
            hiAcc.checked = this.settings.highAccuracy;
            hiAcc.addEventListener('change', () => {
                this.settings.highAccuracy = hiAcc.checked;
                Utils.Storage.set('high_accuracy', hiAcc.checked);
                this._saveSettings();
                Utils.showToast('GPS accuracy updated — restart app to apply', 'info');
            });
        }

        /* Fullscreen button */
        document.getElementById('fullscreen-btn')
            ?.addEventListener('click', () => this.toggleFullscreen());

        /* Reset trip */
        document.getElementById('reset-trip-btn')
            ?.addEventListener('click', () => {
                if (confirm('Reset all trip data?')) window.tripComputer?.reset();
            });

        /* Clear cache */
        document.getElementById('clear-cache-btn')
            ?.addEventListener('click', async () => {
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                }
                Utils.showToast('Cache cleared ✓', 'success');
            });

        /* Export GPX */
        document.getElementById('export-gpx-btn')
            ?.addEventListener('click', () => window.tripComputer?.exportGPX());

        /* NOTE: save-calibration & reset-calibration are bound in speedometer.js._setupUI()
         * Do NOT add listeners here — would cause double-firing. */
    }

    // ─────────────────────────────────────────────────────
    //  COLOR THEME  (Cyber / Inferno / Purple)
    // ─────────────────────────────────────────────────────
    setColorTheme(theme) {
        this.settings.colorTheme = theme;
        document.documentElement.setAttribute('data-color-theme', theme);

        document.querySelectorAll('.theme-swatch, .qs-chip[data-theme]').forEach(b =>
            b.classList.toggle('active', b.dataset.theme === theme)
        );

        this._saveSettings();
        window.mapsModule?.applyStyleFromSettings(theme, document.documentElement.getAttribute('data-time'), this.settings.mapStyle);
        Utils.showToast(`Theme: ${theme.toUpperCase()}`, 'success');
    }

    // ─────────────────────────────────────────────────────
    //  DAY / NIGHT THEME — auto (by time) or manual override
    // ─────────────────────────────────────────────────────
    _applyAutoTheme() {
        const apply = () => {
            if (!this.settings.autoTheme) return;
            const h = new Date().getHours();
            const mode = (h >= 6 && h < 19) ? 'day' : 'night';
            document.documentElement.setAttribute('data-time', mode);
            document.querySelectorAll('.daynight-btn, .qs-chip[data-time]:not(.qs-chip-auto)').forEach(b =>
                b.classList.toggle('active', b.dataset.time === mode)
            );
            window.mapsModule?.applyStyleFromSettings(this.settings.colorTheme, mode, this.settings.mapStyle);
        };
        apply();
        if (this._autoThemeInterval) clearInterval(this._autoThemeInterval);
        this._autoThemeInterval = setInterval(apply, 60_000);
    }

    /**
     * Manually force Day or Night mode. Called by the DAY/NIGHT buttons
     * in Settings. Automatically disables "Auto Day/Night" so the manual
     * choice isn't immediately overwritten by the time-based check.
     */
    setTimeMode(mode, fromManualClick = false) {
        this.settings.timeMode = mode;
        document.documentElement.setAttribute('data-time', mode);

        document.querySelectorAll('.daynight-btn, .qs-chip[data-time]:not(.qs-chip-auto)').forEach(b =>
            b.classList.toggle('active', b.dataset.time === mode)
        );

        if (fromManualClick) {
            this.settings.autoTheme = false;
            const autoToggle = document.getElementById('auto-theme-toggle');
            if (autoToggle) autoToggle.checked = false;
            document.querySelectorAll('.qs-chip-auto').forEach(b => b.classList.remove('active'));
            Utils.showToast(`${mode === 'day' ? '☀ Day' : '🌙 Night'} mode`, 'success');
        }

        this._saveSettings();
        window.mapsModule?.applyStyleFromSettings(this.settings.colorTheme, mode, this.settings.mapStyle);
    }

    // ─────────────────────────────────────────────────────
    //  DIAL PAD
    // ─────────────────────────────────────────────────────
    _setupDialPad() {
        let num = '';

        document.querySelectorAll('.dial-key').forEach(btn =>
            btn.addEventListener('click', () => {
                num += btn.dataset.key;
                Utils.setEl('dial-number', num);
            })
        );

        document.getElementById('dial-backspace')
            ?.addEventListener('click', () => {
                num = num.slice(0, -1);
                Utils.setEl('dial-number', num || '--');
            });

        document.getElementById('dial-call')
            ?.addEventListener('click', () => {
                if (num) window.location.href = `tel:${num}`;
            });
    }

    // ─────────────────────────────────────────────────────
    //  EVENT BUS
    // ─────────────────────────────────────────────────────
    _subscribeEvents() {
        Utils.EventBus.on('panel:switch', ({ panel }) => this.switchPanel(panel));
    }

    // ─────────────────────────────────────────────────────
    //  MAP STYLE  ('theme' = follow color-theme/day-night, or an
    //  independent mapstyle-* preset — see js/map-styles/)
    // ─────────────────────────────────────────────────────
    setMapStyle(value) {
        this.settings.mapStyle = value;
        this._saveSettings();
        document.querySelectorAll('#map-style-select, #qs-map-style-select').forEach(sel => { sel.value = value; });
        window.mapsModule?.applyStyleFromSettings(
            this.settings.colorTheme,
            document.documentElement.getAttribute('data-time'),
            value
        );
    }

    _setupMapStyleSelects() {
        document.querySelectorAll('#map-style-select, #qs-map-style-select').forEach(sel => {
            sel.value = this.settings.mapStyle;
            sel.addEventListener('change', () => this.setMapStyle(sel.value));
        });
    }

    // ─────────────────────────────────────────────────────
    //  QUICK SETTINGS — fast slide-down panel from the status bar.
    //  Reuses the exact same setColorTheme/setTimeMode/setMapStyle
    //  methods as the full Settings panel (see _setupSettingsUI) —
    //  no duplicated state, just a faster surface to reach them.
    // ─────────────────────────────────────────────────────
    _setupQuickSettings() {
        const panel = document.getElementById('quick-settings-panel');
        const btn   = document.getElementById('quick-settings-btn');
        if (btn && panel) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                panel.classList.toggle('open');
            });
            document.addEventListener('click', (e) => {
                if (panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn) {
                    panel.classList.remove('open');
                }
            });
        }

        /* Brightness — mirrors the full Settings slider */
        const qsBright = document.getElementById('qs-brightness-slider');
        if (qsBright) {
            qsBright.value = this.settings.brightness;
            qsBright.addEventListener('input', () => {
                this.settings.brightness = +qsBright.value;
                Utils.setEl('qs-brightness-value', `${qsBright.value}%`);
                const fullSlider = document.getElementById('brightness-slider');
                if (fullSlider) { fullSlider.value = qsBright.value; Utils.setEl('brightness-value', `${qsBright.value}%`); }
                document.body.style.filter = `brightness(${qsBright.value}%)`;
                this._saveSettings();
            });
        }

        this._setupMapStyleSelects();

        /* Language — drives the Voice Assistant's recognition/TTS
         * language (see js/voice.js setLanguage). Keeps both the
         * full-Settings and Quick-Settings selects in sync. */
        document.querySelectorAll('#voice-language, #qs-language-select').forEach(sel => {
            sel.addEventListener('change', () => {
                document.querySelectorAll('#voice-language, #qs-language-select').forEach(s => { s.value = sel.value; });
                window.voiceModule?.setLanguage(sel.value);
            });
        });
    }

    // ─────────────────────────────────────────────────────
    //  SERVICE WORKER
    // ─────────────────────────────────────────────────────
    _registerSW() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[App] SW registered:', reg.scope))
            .catch(e  => console.error('[App] SW failed:', e));
    }
}

/* ── Bootstrap ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    window.app = new MotoDash();
});

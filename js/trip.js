/**
 * MotoDash — trip.js
 * Trip Computer: distance, avg/max speed, duration, GPX recording.
 * Also tracks a Lifetime Odometer (total distance ever traveled with
 * this app installed) — separate from the resettable Trip Meter,
 * mirroring the "ODO" readout found on OEM motorcycle clusters, but
 * honestly GPS-derived since this app has no connection to the
 * vehicle's actual odometer/ECU.
 * Persists session state in LocalStorage.
 */

'use strict';

class TripComputer {
    constructor() {
        // ── Trip metrics (resettable) ─────────────────────
        this.totalDistance   = 0;    // meters
        this.maxSpeed        = 0;    // km/h
        this.speedReadings   = [];   // rolling buffer for avg
        this.elapsedSeconds  = 0;
        this.lastPosition    = null; // { lat, lng }

        // ── Lifetime Odometer (NEVER reset by Trip Reset) ──
        this.lifetimeDistance = 0;   // meters, persists forever

        // ── GPX track recording ───────────────────────────
        this.trackPoints     = [];   // { lat, lng, speed, time }

        // ── Internals ─────────────────────────────────────
        this._timer          = null;

        this._loadState();
        this._loadLifetimeOdo();
        this._startTimer();
        this._setupUI();
        console.log('[TripComputer] Initialized ✓');
    }

    // ─────────────────────────────────────────────────────
    //  UI BINDINGS
    // ─────────────────────────────────────────────────────
    _setupUI() {
        // Maps panel trip meter reset button
        document.getElementById('trip-reset-btn')
            ?.addEventListener('click', () => {
                if (confirm('Reset semua data trip (jarak, rata-rata, kecepatan maks, durasi)?')) {
                    this.reset();
                }
            });
        // Trip panel detailed reset button
        document.getElementById('trip-reset-btn-detail')
            ?.addEventListener('click', () => {
                if (confirm('Reset semua data trip?')) this.reset();
            });
        // GPX export
        document.getElementById('export-gpx-btn')
            ?.addEventListener('click', () => this.exportGPX());
    }

    // ─────────────────────────────────────────────────────
    //  PERSISTENCE
    // ─────────────────────────────────────────────────────
    _loadState() {
        const s = Utils.Storage.get('trip_state', null);
        if (s) {
            this.totalDistance  = s.totalDistance  || 0;
            this.maxSpeed       = s.maxSpeed       || 0;
            this.speedReadings  = s.speedReadings  || [];
            this.elapsedSeconds = s.elapsedSeconds || 0;
        }
    }

    _saveState() {
        Utils.Storage.set('trip_state', {
            totalDistance  : this.totalDistance,
            maxSpeed       : this.maxSpeed,
            speedReadings  : this.speedReadings.slice(-100),
            elapsedSeconds : this.elapsedSeconds
        });
    }

    /** Lifetime odometer uses its OWN storage key — reset() never touches it. */
    _loadLifetimeOdo() {
        this.lifetimeDistance = Utils.Storage.get('lifetime_odo_m', 0);
    }

    _saveLifetimeOdo() {
        Utils.Storage.set('lifetime_odo_m', this.lifetimeDistance);
    }

    // ─────────────────────────────────────────────────────
    //  TIMER
    // ─────────────────────────────────────────────────────
    _startTimer() {
        const tick = () => {
            const formatted = Utils.formatDuration(this.elapsedSeconds);
            Utils.setEl('ride-duration', formatted);
            Utils.setEl('ride-duration-detail', formatted);
            if (this.elapsedSeconds % 30 === 0) {
                this._saveState();
                this._saveLifetimeOdo();
            }
            this.elapsedSeconds++;
        };
        tick(); // render immediately
        this._timer = setInterval(tick, 1000);
    }

    // ─────────────────────────────────────────────────────
    //  UPDATE  (called by Speedometer on every GPS fix)
    // ─────────────────────────────────────────────────────
    update(lat, lng, speedKmh) {
        const now = Date.now();

        // ── Record track point ────────────────────────────
        if (lat && lng) {
            this.trackPoints.push({ lat, lng, speed: speedKmh, time: now });
            if (this.trackPoints.length > 2000) this.trackPoints.shift();
        }

        // ── Distance accumulation (trip + lifetime, same validated delta) ──
        if (this.lastPosition && lat && lng) {
            const d = Utils.haversineDistance(
                this.lastPosition.lat, this.lastPosition.lng, lat, lng
            );
            // Accept movement only when >3 m and speed meaningful
            if (d > 3 && speedKmh > 2) {
                this.totalDistance    += d;
                this.lifetimeDistance += d; // never reset by Trip Reset
            }
        }

        // ── Max speed ─────────────────────────────────────
        if (speedKmh > this.maxSpeed) this.maxSpeed = speedKmh;

        // ── Speed buffer (exclude near-zero) ──────────────
        if (speedKmh >= 0) {
            this.speedReadings.push(speedKmh);
            if (this.speedReadings.length > 300) this.speedReadings.shift();
        }

        if (lat && lng) this.lastPosition = { lat, lng };

        this._render();
    }

    // ─────────────────────────────────────────────────────
    //  COMPUTED
    // ─────────────────────────────────────────────────────
    get averageSpeed() {
        const moving = this.speedReadings.filter(s => s > 3);
        if (!moving.length) return 0;
        return moving.reduce((a, b) => a + b, 0) / moving.length;
    }

    get distanceKm() { return this.totalDistance / 1000; }
    get lifetimeKm() { return this.lifetimeDistance / 1000; }

    // ─────────────────────────────────────────────────────
    //  RENDER
    // ─────────────────────────────────────────────────────
    _render() {
        // Maps panel strip (always visible below map)
        Utils.setEl('trip-distance', `${this.distanceKm.toFixed(1)} km`);
        Utils.setEl('avg-speed',     `${Math.round(this.averageSpeed)} km/h`);
        Utils.setEl('max-speed',     `${Math.round(this.maxSpeed)} km/h`);

        // Trip panel detail cards (visible when TRIP tab is active)
        Utils.setEl('trip-distance-detail', this.distanceKm.toFixed(1));
        Utils.setEl('avg-speed-detail',     Math.round(this.averageSpeed));
        Utils.setEl('max-speed-detail',     Math.round(this.maxSpeed));
        Utils.setEl('lifetime-odo-detail',  this.lifetimeKm.toFixed(0));

        // Shared left-panel cluster readouts
        Utils.setEl('cluster-odo', `${this.lifetimeKm.toFixed(0)} km`);
        Utils.setEl('cluster-avg', `${Math.round(this.averageSpeed)} km/h`);
    }

    // ─────────────────────────────────────────────────────
    //  PUBLIC ACTIONS
    // ─────────────────────────────────────────────────────
    reset() {
        this.totalDistance  = 0;
        this.maxSpeed       = 0;
        this.speedReadings  = [];
        this.trackPoints    = [];
        this.lastPosition   = null;
        this.elapsedSeconds = 0;
        Utils.Storage.remove('trip_state');
        this._render();
        Utils.setEl('ride-duration', '00:00');
        Utils.showToast('Trip data reset ✓', 'success');
    }

    exportGPX() {
        if (this.trackPoints.length < 2) {
            Utils.showToast('Not enough data to export', 'warning');
            return;
        }
        const date  = new Date().toISOString().slice(0, 10);
        const gpx   = Utils.generateGPX(this.trackPoints, `MotoDash ${date}`);
        Utils.downloadFile(gpx, `motodash-${date}.gpx`, 'application/gpx+xml');
        Utils.showToast('GPX exported ✓', 'success');
    }

    destroy() {
        clearInterval(this._timer);
        this._saveState();
        this._saveLifetimeOdo();
    }
}

// ── Bootstrap ────────────────────────────────────────────
window.tripComputer = new TripComputer();
console.log('[TripComputer] Ready ✓');

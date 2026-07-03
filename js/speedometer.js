/**
 * MotoDash — speedometer.js
 * GPS Speedometer: watchPosition, Kalman filter, Haversine speed,
 * animated arc gauges (3 themed faces), DeviceOrientation compass,
 * GPS calibration, vehicle status.
 *
 * GAUGE GEOMETRY — design rationale
 * ───────────────────────────────────
 * ORIGIN : numbered 270° ring (unchanged — the app's clean OEM
 *          baseline look, polished but structurally as-is).
 * NEXUS  : tick-mark ring + progress arc, modelled on the Ducati
 *          Multistrada V4 reference photo — 21 radial ticks (major
 *          every 40 km/h), the top of the scale rendered in red to
 *          echo the tachometer's redline, large minimal digital
 *          readout, vehicle-status text where the photo shows gear.
 * TECHNO : gear/sprocket-toothed outer bezel + progress arc, modelled
 *          on the Zontes 368E reference photo's mechanical ring, plus
 *          the existing LED bargraph kept as-is (it already nails the
 *          "digital segment" feel the photo's fuel/temp arc has).
 *
 * The status-icon column and bottom info strip used to exist only on
 * the Origin face. They are now shared across all three themes (see
 * #cluster-status-col / #cluster-info-strip in index.html) — purely a
 * feature-parity fix, nothing removed, GPS/BT/Voice/Battery and
 * ODO/AVG/TIME are now visible no matter which theme is active.
 */

'use strict';

class SpeedometerModule {
    constructor() {
        // ── Speed state ───────────────────────────────────
        this.targetSpeed  = 0;   // Kalman-filtered GPS speed (km/h)
        this.displaySpeed = 0;   // Animated display speed
        this.vehicleStatus = 'STOPPED';

        // ── GPS state ─────────────────────────────────────
        this.watchId      = null;
        this.lastPosition = null;   // { lat, lng }
        this.lastTimestamp = null;
        this.gpsAccuracy  = null;
        this.heading      = null;
        this.altitude     = null;
        this.gpsSignal    = 'SEARCHING';
        this.gpsPosition  = null;   // Exposed to other modules

        // ── Kalman filter  (1-D, speed) ───────────────────
        // Fixed, balanced tuning — smooths GPS noise without lagging
        // behind real speed changes.
        this.kf = { Q: 0.0001, R: 0.01, P: 1.0, x: 0.0 };

        // ── SVG arc geometry per face (all 270° sweep, 135°→405°,
        //    so every gauge shares one mental model: 0 km/h at lower-
        //    left, 200 km/h at lower-right, straight up = 100 km/h) ──
        this.ARC_MAX_KMH          = 200;
        this.ORIGIN_RING_R        = 95;
        this.NEXUS_RING_R         = 80;
        this.TECHNO_RING_R        = 80;
        this.ORIGIN_VISIBLE       = 2 * Math.PI * this.ORIGIN_RING_R * 0.75;
        this.ORIGIN_TOTAL         = 2 * Math.PI * this.ORIGIN_RING_R;
        this.NEXUS_VISIBLE        = 2 * Math.PI * this.NEXUS_RING_R  * 0.75;
        this.NEXUS_TOTAL          = 2 * Math.PI * this.NEXUS_RING_R;
        this.TECHNO_VISIBLE       = 2 * Math.PI * this.TECHNO_RING_R * 0.75;
        this.TECHNO_TOTAL         = 2 * Math.PI * this.TECHNO_RING_R;

        // ── GPS calibration ───────────────────────────────
        this.calibration  = Utils.Storage.get('gps_calibration', { lat: 0, lng: 0 });

        // ── Animation frame ───────────────────────────────
        this._animFrame   = null;

        this._init();
    }

    // ─────────────────────────────────────────────────────
    //  INIT
    // ─────────────────────────────────────────────────────
    _init() {
        this._setupUI();
        this._generateOriginBars();
        this._generateNexusTicks();
        this._generateTechnoGearRing();
        this._generateTechnoLEDs();
        this._startGPS();
        this._startAnimation();
        this._setupCompass();
        this._loadCalibrationUI();
        console.log('[Speedometer] Initialized ✓');
    }

    /**
     * ORIGIN face: numbered speed-scale ring (0,40,80,120,160,200 km/h)
     * with a progress arc — purely GPS-speed-driven, NOT RPM/gear,
     * since this app has no ECU/engine connection. Unchanged from the
     * original implementation; kept exactly as-is per "polish only".
     */
    _generateOriginBars() {
        const g = document.getElementById('origin-ticks');
        if (!g) return;
        const cx = 110, cy = 110, rLabel = 78;
        const labels = [0, 40, 80, 120, 160, 200];
        let svg = '';
        labels.forEach((val, i) => {
            const angleDeg = 135 + (i / 5) * 270;
            const rad = (angleDeg * Math.PI) / 180;
            const x = cx + rLabel * Math.cos(rad);
            const y = cy + rLabel * Math.sin(rad);
            svg += `<text class="origin-tick-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${val}</text>`;
        });
        g.innerHTML = svg;
    }

    /**
     * NEXUS face: 21 radial tick marks around the dial (0→200 km/h in
     * steps of 10), major ticks every 40 km/h drawn longer, and the
     * top portion of the scale (160-200 km/h) rendered in the
     * universal danger color to echo the Ducati tachometer's redline
     * — exactly where a sport-touring cluster puts its redline, at
     * the top of the sweep. Generated procedurally (same convention
     * as the other two faces) rather than hand-typed in the markup.
     */
    _generateNexusTicks() {
        const g = document.getElementById('nexus-ticks');
        if (!g) return;
        const cx = 110, cy = 110, rOuter = 106;
        const sweep = 270, startAngle = 135;
        let svg = '';
        for (let i = 0; i <= 20; i++) {
            const val = i * 10;
            const angleDeg = startAngle + (i / 20) * sweep;
            const rad = (angleDeg * Math.PI) / 180;
            const major = (val % 40 === 0);
            const redzone = val >= 160;
            const r1 = rOuter;
            const r2 = rOuter - (major ? 13 : 6);
            const x1 = cx + r1 * Math.cos(rad), y1 = cy + r1 * Math.sin(rad);
            const x2 = cx + r2 * Math.cos(rad), y2 = cy + r2 * Math.sin(rad);
            const cls = (major ? 'nexus-tick-major' : 'nexus-tick-minor') + (redzone ? ' nexus-tick-red' : '');
            svg += `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
        }
        g.innerHTML = svg;
    }

    /**
     * TECHNO face: 14-tooth gear/sprocket ring framing the dial —
     * the defining motif of the Zontes 368E reference photo's
     * tachometer bezel. Built as a single closed polygon (alternating
     * tooth-tip / tooth-root vertices), generated procedurally so the
     * tooth count/proportions are a one-line tweak, not a hand-edited
     * 42-point path.
     */
    _generateTechnoGearRing() {
        const g = document.getElementById('techno-gear-ring-container');
        if (!g) return;
        const cx = 110, cy = 110, teeth = 14, rTip = 106, rRoot = 95, halfWidthDeg = 7;
        const pts = [];
        for (let i = 0; i < teeth; i++) {
            const centerA = (360 / teeth) * i;
            const a1 = centerA - halfWidthDeg, a2 = centerA + halfWidthDeg;
            const nextCenterA = (360 / teeth) * (i + 1);
            const a3 = nextCenterA - halfWidthDeg;
            const rad1 = a1 * Math.PI / 180, rad2 = a2 * Math.PI / 180, radRoot = ((a2 + a3) / 2) * Math.PI / 180;
            pts.push(`${(cx + rTip * Math.cos(rad1)).toFixed(1)},${(cy + rTip * Math.sin(rad1)).toFixed(1)}`);
            pts.push(`${(cx + rTip * Math.cos(rad2)).toFixed(1)},${(cy + rTip * Math.sin(rad2)).toFixed(1)}`);
            pts.push(`${(cx + rRoot * Math.cos(radRoot)).toFixed(1)},${(cy + rRoot * Math.sin(radRoot)).toFixed(1)}`);
        }
        g.innerHTML = `<polygon class="techno-gear-ring" points="${pts.join(' ')}"/>`;
    }

    /**
     * TECHNO face: horizontal LED bargraph (14 segments), classic
     * equalizer/VU-meter look, lights up left→right with speed.
     * Unchanged — already matches the "digital segment" language of
     * the Zontes cluster's fuel/temperature arc.
     */
    _generateTechnoLEDs() {
        const bar = document.getElementById('techno-led-bar');
        if (!bar) return;
        this.TECHNO_SEGMENTS = 14;
        let html = '';
        for (let i = 0; i < this.TECHNO_SEGMENTS; i++) {
            html += '<div class="techno-led-segment"></div>';
        }
        bar.innerHTML = html;
        this._technoSegmentEls = [...bar.children];
    }

    // ─────────────────────────────────────────────────────
    //  KALMAN FILTER  (unchanged — core telemetry logic)
    // ─────────────────────────────────────────────────────
    _kalman(measurement) {
        const { Q, R } = this.kf;
        this.kf.P += Q;                                     // predict
        const K    = this.kf.P / (this.kf.P + R);          // gain
        this.kf.x += K * (measurement - this.kf.x);        // update
        this.kf.P  = (1 - K) * this.kf.P;
        return Math.max(0, this.kf.x);
    }

    // ─────────────────────────────────────────────────────
    //  GPS  (unchanged — core telemetry logic)
    // ─────────────────────────────────────────────────────
    _startGPS() {
        if (!navigator.geolocation) {
            this._setSignalEl('GPS NOT SUPPORTED', '');
            Utils.showToast('Geolocation not supported', 'error');
            return;
        }

        const options = {
            enableHighAccuracy : Utils.Storage.get('high_accuracy', true),
            timeout            : 10000,
            maximumAge         : 0
        };

        this.watchId = navigator.geolocation.watchPosition(
            (pos) => this._onFix(pos),
            (err) => this._onError(err),
            options
        );
        this._setSignalEl('ACQUIRING', 'gps-searching');
    }

    _onFix(position) {
        const { latitude, longitude, accuracy, speed, heading, altitude } = position.coords;
        const ts = position.timestamp;

        // Apply calibration offsets
        const lat = latitude  + this.calibration.lat;
        const lng = longitude + this.calibration.lng;

        // Expose for maps module
        this.gpsPosition  = { lat, lng, accuracy, heading, altitude };
        this.gpsAccuracy  = Math.round(accuracy);
        this.altitude     = altitude !== null ? Math.round(altitude) : null;

        // Update GPS signal quality indicator
        this._updateSignalQuality(accuracy);

        // ── Heading ───────────────────────────────────────
        if (heading !== null && !isNaN(heading)) {
            this.heading = Math.round(heading);
        } else if (this.lastPosition) {
            this.heading = Math.round(
                Utils.calculateBearing(this.lastPosition.lat, this.lastPosition.lng, lat, lng)
            );
        }

        // ── Speed calculation ─────────────────────────────
        let rawSpeed = 0;

        if (speed !== null && speed >= 0) {
            // Native GPS speed (m/s) → km/h
            rawSpeed = speed * 3.6;
        } else if (this.lastPosition && this.lastTimestamp) {
            // Haversine fallback
            const distM  = Utils.haversineDistance(
                this.lastPosition.lat, this.lastPosition.lng, lat, lng
            );
            const dtSecs = (ts - this.lastTimestamp) / 1000;
            if (dtSecs > 0.05) rawSpeed = (distM / dtSecs) * 3.6;
        }

        // Clamp implausible jumps (>350 km/h)
        rawSpeed = Math.min(Math.max(rawSpeed, 0), 350);

        // Apply Kalman smoothing
        const smoothed    = this._kalman(rawSpeed);
        this.targetSpeed  = Math.round(smoothed);

        // Vehicle status
        this.vehicleStatus = this.targetSpeed > 3 ? 'MOVING' : 'STOPPED';

        // Update info displays
        this._updateGPSInfo();
        this._updateStatusBadge();
        this._updateCompass(this.heading);

        // Store last fix
        this.lastPosition  = { lat, lng };
        this.lastTimestamp = ts;

        // Broadcast for maps, trip, voice
        Utils.EventBus.emit('gps:update', {
            lat, lng,
            speed   : this.targetSpeed,
            heading : this.heading,
            accuracy: this.gpsAccuracy,
            altitude: this.altitude,
            status  : this.vehicleStatus,
            timestamp: ts
        });

        // Update trip computer
        window.tripComputer?.update(lat, lng, this.targetSpeed);
    }

    _onError(error) {
        const msgs = {
            1: 'PERMISSION DENIED',
            2: 'POSITION UNAVAILABLE',
            3: 'GPS TIMEOUT'
        };
        const msg = msgs[error.code] || 'GPS ERROR';
        this._setSignalEl(msg, 'gps-poor');
        Utils.showToast(`GPS: ${msg}`, 'error');
    }

    // ─────────────────────────────────────────────────────
    //  GPS SIGNAL QUALITY  (unchanged)
    // ─────────────────────────────────────────────────────
    _updateSignalQuality(accuracy) {
        let label, cls;
        if      (accuracy <= 5)   { label = 'EXCELLENT'; cls = 'gps-excellent'; }
        else if (accuracy <= 10)  { label = 'GOOD';      cls = 'gps-good';      }
        else if (accuracy <= 25)  { label = 'FAIR';      cls = 'gps-fair';      }
        else if (accuracy <= 100) { label = 'POOR';      cls = 'gps-poor';      }
        else                      { label = 'SEARCHING'; cls = 'gps-searching'; }
        this.gpsSignal = label;
        this._setSignalEl(label, cls);

        // Status-bar GPS icon colour
        const ico = document.getElementById('gps-icon');
        if (ico) ico.className = `status-icon ${cls}`;
    }

    _setSignalEl(label, cls) {
        const el = document.getElementById('gps-signal');
        if (!el) return;
        el.textContent = label;
        el.className   = `info-value ${cls}`;
    }

    // ─────────────────────────────────────────────────────
    //  ANIMATION LOOP — smooth speed towards target (unchanged)
    // ─────────────────────────────────────────────────────
    _startAnimation() {
        const tick = () => {
            const diff = this.targetSpeed - this.displaySpeed;

            // Slower deceleration easing when stopped (engine wind-down feel)
            const factor = this.vehicleStatus === 'STOPPED' ? 0.04 : 0.14;
            this.displaySpeed += diff * factor;
            if (Math.abs(diff) < 0.15) this.displaySpeed = this.targetSpeed;

            this._renderSpeed();
            this._animFrame = requestAnimationFrame(tick);
        };
        this._animFrame = requestAnimationFrame(tick);
    }

    // ─────────────────────────────────────────────────────
    //  RENDER — drives all 3 speed faces simultaneously.
    //  CSS shows only the one matching the active color theme; updating
    //  all three unconditionally is cheap (3 cheap DOM writes) and
    //  avoids JS branching on which theme is active. The shared
    //  status column / info strip is updated once here (not 3×).
    // ─────────────────────────────────────────────────────
    _renderSpeed() {
        const spd = Math.round(this.displaySpeed);
        const zone = spd >= 140 ? 'danger' : (spd >= 100 ? 'warning' : 'normal');

        this._renderFaceOrigin(spd, zone);
        this._renderFaceNexus(spd, zone);
        this._renderFaceTechno(spd, zone);
        this._updateClusterStatusIcons();
        this._updateClusterInfoStrip();
    }

    /* ── FACE 1: Origin numbered ring (unchanged) ─────────── */
    _renderFaceOrigin(spd, zone) {
        const valEl = document.getElementById('speed-value-origin');
        if (valEl) {
            valEl.className = 'origin-value';
            if (zone === 'danger')       valEl.classList.add('speed-danger');
            else if (zone === 'warning') valEl.classList.add('speed-warning');
            valEl.textContent = spd;
        }

        const ringEl = document.getElementById('origin-ring-fill');
        if (ringEl) {
            const pct = Math.min(this.displaySpeed / this.ARC_MAX_KMH, 1);
            const filled = this.ORIGIN_VISIBLE * pct;
            ringEl.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${(this.ORIGIN_TOTAL - filled).toFixed(1)}`);

            ringEl.classList.remove('origin-ring-normal', 'origin-ring-warning', 'origin-ring-danger');
            ringEl.classList.add(`origin-ring-${zone}`);
        }
    }

    /**
     * Shared status icon column — 100% honest, app-derived signals
     * only. No engine/ABS/side-stand/fuel warnings (no ECU connection
     * exists). Visible behind all 3 themes (was Origin-only before).
     */
    _updateClusterStatusIcons() {
        const gpsIcon = document.getElementById('cluster-icon-gps');
        if (gpsIcon) {
            const good = this.gpsSignal === 'EXCELLENT' || this.gpsSignal === 'GOOD';
            gpsIcon.classList.toggle('active', good);
        }

        const btIcon = document.getElementById('cluster-icon-bt');
        if (btIcon) {
            btIcon.classList.toggle('active', !!window.bluetoothModule?.hasConnectedDevice);
        }

        const voiceIcon = document.getElementById('cluster-icon-voice');
        if (voiceIcon) {
            voiceIcon.classList.toggle('active', !!window.voiceModule?.isListening);
        }

        const battIcon = document.getElementById('cluster-icon-battery');
        if (battIcon) {
            const lvl = window.app?.batteryLevel;
            const low = typeof lvl === 'number' && lvl <= 15;
            battIcon.style.display = low ? 'flex' : 'none';
        }
    }

    /** Shared bottom info strip: lifetime ODO + average speed + time. */
    _updateClusterInfoStrip() {
        Utils.setEl('cluster-time', Utils.getCurrentTime());
        // ODO and AVG are updated by TripComputer._render() directly
        // (it targets #cluster-odo / #cluster-avg) — nothing further
        // needed here, kept for clarity of render flow.
    }

    /* ── FACE 2: Nexus tick-ring (Ducati-inspired) ────────── */
    _renderFaceNexus(spd, zone) {
        const valEl    = document.getElementById('speed-value-nexus');
        const ringEl   = document.getElementById('nexus-ring-fill');
        const statusEl = document.getElementById('nexus-status-text');
        const badgeEl  = document.getElementById('nexus-signal-badge');

        if (valEl) {
            valEl.className = 'nexus-value';
            if (zone === 'danger')       valEl.classList.add('speed-danger');
            else if (zone === 'warning') valEl.classList.add('speed-warning');
            valEl.textContent = spd;
        }

        if (ringEl) {
            const pct = Math.min(this.displaySpeed / this.ARC_MAX_KMH, 1);
            const filled = this.NEXUS_VISIBLE * pct;
            ringEl.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${(this.NEXUS_TOTAL - filled).toFixed(1)}`);

            ringEl.classList.remove('nexus-progress-normal', 'nexus-progress-warning', 'nexus-progress-danger');
            ringEl.classList.add(`nexus-progress-${zone}`);
        }

        if (statusEl) statusEl.textContent = this.vehicleStatus;

        if (badgeEl) {
            const good = this.gpsSignal === 'EXCELLENT' || this.gpsSignal === 'GOOD';
            badgeEl.textContent = this.gpsSignal;
            badgeEl.classList.toggle('nexus-badge-ok', good);
        }
    }

    /* ── FACE 3: Techno gear-ring (Zontes-inspired) + LED bar ── */
    _renderFaceTechno(spd, zone) {
        const valEl    = document.getElementById('speed-value-techno');
        const ringEl   = document.getElementById('techno-ring-fill');
        const statusEl = document.getElementById('techno-status-text');

        if (valEl) {
            valEl.className = 'techno-value';
            if (zone === 'danger')       valEl.classList.add('speed-danger');
            else if (zone === 'warning') valEl.classList.add('speed-warning');
            valEl.textContent = spd;
        }

        const pct = Math.min(this.displaySpeed / this.ARC_MAX_KMH, 1);

        if (ringEl) {
            const filled = this.TECHNO_VISIBLE * pct;
            ringEl.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${(this.TECHNO_TOTAL - filled).toFixed(1)}`);

            ringEl.classList.remove('techno-progress-normal', 'techno-progress-warning', 'techno-progress-danger');
            ringEl.classList.add(`techno-progress-${zone}`);
        }

        if (statusEl) statusEl.textContent = `SIG:${this.gpsSignal}`;

        if (this._technoSegmentEls) {
            const litCount = Math.round(pct * this.TECHNO_SEGMENTS);
            this._technoSegmentEls.forEach((seg, i) => {
                const isLit = i < litCount;
                seg.classList.toggle('lit', isLit);
                seg.classList.remove('seg-warning', 'seg-danger');
                if (isLit && zone === 'danger')       seg.classList.add('seg-danger');
                else if (isLit && zone === 'warning') seg.classList.add('seg-warning');
            });
        }
    }

    _updateStatusBadge() {
        const el = document.getElementById('vehicle-status');
        if (!el) return;
        el.textContent = `● ${this.vehicleStatus}`;
        el.className   = `vehicle-status ${this.vehicleStatus.toLowerCase()}`;
    }

    _updateGPSInfo() {
        if (this.gpsAccuracy !== null)
            Utils.setEl('gps-accuracy', `±${this.gpsAccuracy} m`);
        if (this.altitude !== null)
            Utils.setEl('current-altitude', `${this.altitude} m`);
    }

    // ─────────────────────────────────────────────────────
    //  COMPASS  (DeviceOrientationEvent) — unchanged
    // ─────────────────────────────────────────────────────
    _setupCompass() {
        if (!window.DeviceOrientationEvent) return;

        const attach = () => {
            window.addEventListener('deviceorientation', (e) => {
                if (e.webkitCompassHeading !== undefined) {
                    // iOS gives compass heading directly
                    this._updateCompass(e.webkitCompassHeading);
                } else if (e.alpha !== null) {
                    this._updateCompass((360 - e.alpha) % 360);
                }
            }, { passive: true });
        };

        // iOS 13+ requires explicit permission
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            document.addEventListener('click', async function once() {
                try {
                    const perm = await DeviceOrientationEvent.requestPermission();
                    if (perm === 'granted') attach();
                } catch (e) { /* ignore */ }
                document.removeEventListener('click', once);
            }, { once: true });
        } else {
            attach();
        }
    }

    _updateCompass(angle) {
        if (angle === null || isNaN(angle)) return;
        const needle = document.getElementById('compass-needle');
        if (needle) needle.setAttribute('transform', `rotate(${angle.toFixed(0)} 30 30)`);
        Utils.setEl('current-heading', `${Math.round(angle)}°`);
    }

    // ─────────────────────────────────────────────────────
    //  GPS CALIBRATION  (unchanged)
    // ─────────────────────────────────────────────────────
    saveCalibration() {
        const lat = parseFloat(document.getElementById('lat-offset')?.value) || 0;
        const lng = parseFloat(document.getElementById('lng-offset')?.value) || 0;
        this.calibration = { lat, lng };
        Utils.Storage.set('gps_calibration', this.calibration);
        Utils.showToast('GPS calibration saved ✓', 'success');
    }

    resetCalibration() {
        this.calibration = { lat: 0, lng: 0 };
        Utils.Storage.remove('gps_calibration');
        const latEl = document.getElementById('lat-offset');
        const lngEl = document.getElementById('lng-offset');
        if (latEl) latEl.value = '0';
        if (lngEl) lngEl.value = '0';
        Utils.showToast('GPS calibration reset', 'info');
    }

    _loadCalibrationUI() {
        const latEl = document.getElementById('lat-offset');
        const lngEl = document.getElementById('lng-offset');
        if (latEl) latEl.value = this.calibration.lat;
        if (lngEl) lngEl.value = this.calibration.lng;
    }

    // ─────────────────────────────────────────────────────
    //  UI BINDINGS  (unchanged)
    // ─────────────────────────────────────────────────────
    _setupUI() {
        document.getElementById('save-calibration')
            ?.addEventListener('click', () => this.saveCalibration());
        document.getElementById('reset-calibration')
            ?.addEventListener('click', () => this.resetCalibration());
    }

    // ─────────────────────────────────────────────────────
    //  CLEANUP  (unchanged)
    // ─────────────────────────────────────────────────────
    destroy() {
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        if (this._animFrame)       cancelAnimationFrame(this._animFrame);
    }
}

// ── Bootstrap ────────────────────────────────────────────
window.speedometer = new SpeedometerModule();
console.log('[Speedometer] Ready ✓');

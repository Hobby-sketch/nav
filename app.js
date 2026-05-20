/**
 * ═══════════════════════════════════════════════════════════════
 *  HUD NAV — SMART SPEEDOMETER NAVIGATION DASHBOARD
 *  app.js — Production-ready, modular, realtime
 * ═══════════════════════════════════════════════════════════════
 *
 *  CONFIGURATION: Update APPS_SCRIPT_URL before deploying.
 *  Replace with your published Google Apps Script Web App URL.
 */

const CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwRCtIjyWzL0dc-he_WY39nk2HTptw9RtqAydMMOIAxZ6VXnCB52A0xojt3WmrATxtA/exec',
  MAP_TILE_DARK:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  MAP_TILE_LIGHT: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  NOMINATIM_URL:  'https://nominatim.openstreetmap.org',
  GPS_OPTIONS: {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0
  },
  SPEED_FILTER_ALPHA: 0.3,      // EMA smoothing factor for speed
  SPEEDO_MAX_SPEED: 150,        // km/h max on dial
  SPEEDO_CANVAS_SIZE: 320,
  AUTO_SAVE_INTERVAL: 30000,    // ms — auto-save trip every 30s
};

/* ═══════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════ */
const State = {
  theme: localStorage.getItem('hudnav-theme') || 'dark',
  gps: {
    watchId: null,
    position: null,
    speed: 0,
    smoothedSpeed: 0,
    maxSpeed: 0,
    avgSpeed: 0,
    totalDist: 0,
    odometer: parseFloat(localStorage.getItem('hudnav-odometer') || '0'),
    bearing: 0,
    altitude: null,
    accuracy: null,
    speedReadings: [],
    prevLat: null, prevLng: null,
    sessionDist: 0,
    active: false,
    error: false,
  },
  nav: {
    routing: null,
    originLatLng: null,
    destLatLng: null,
    navigating: false,
  },
  map: {
    instance: null,
    userMarker: null,
    tileLayer: null,
    accuracyCircle: null,
  },
  ui: {
    searchPanelOpen: true,
    fullscreen: false,
  },
  trip: {
    startTime: null,
    waypoints: [],
    autoSaveTimer: null,
  },
  perf: {
    fps: 0,
    lastFrame: 0,
    frameCount: 0,
    fpsTimer: 0,
  },
  speedo: {
    needleAngle: -135,
    targetAngle: -135,
    animFrame: null,
  },
  online: navigator.onLine,
};

/* ═══════════════════════════════════════════════════════════════
   SPLASH SCREEN
═══════════════════════════════════════════════════════════════ */
const Splash = {
  messages: [
    'INITIALIZING SYSTEMS...',
    'LOADING GPS ENGINE...',
    'CALIBRATING SENSORS...',
    'LOADING MAPS...',
    'STARTING NAVIGATION...',
    'ALL SYSTEMS READY',
  ],
  bar: null,
  statusEl: null,
  progress: 0,
  timer: null,

  init() {
    this.bar = document.getElementById('splashBar');
    this.statusEl = document.getElementById('splashStatus');
    this.animate();
  },

  animate() {
    let step = 0;
    const steps = this.messages.length;
    const tick = () => {
      if (step >= steps) { this.done(); return; }
      this.progress = Math.round(((step + 1) / steps) * 100);
      this.bar.style.width = this.progress + '%';
      this.statusEl.textContent = this.messages[step];
      step++;
      const delay = step === steps ? 400 : 350 + Math.random() * 200;
      setTimeout(tick, delay);
    };
    tick();
  },

  done() {
    const splash = document.getElementById('splashScreen');
    setTimeout(() => {
      splash.classList.add('fade-out');
      setTimeout(() => {
        splash.classList.add('hidden');
        App.reveal();
      }, 800);
    }, 200);
  }
};

/* ═══════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
═══════════════════════════════════════════════════════════════ */
const Toast = {
  container: null,
  icons: { info: 'ℹ', success: '✓', warning: '⚠', error: '✕' },

  init() { this.container = document.getElementById('toastContainer'); },

  show(message, type = 'info', duration = 3500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <span class="toast-icon">${this.icons[type]}</span>
      <span>${message}</span>
    `;
    this.container.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-out');
      setTimeout(() => el.remove(), 300);
    }, duration);
    return el;
  }
};

/* ═══════════════════════════════════════════════════════════════
   CLOCK & FPS
═══════════════════════════════════════════════════════════════ */
const Clock = {
  el: null,
  fpsEl: null,

  init() {
    this.el = document.getElementById('realtimeClock');
    this.fpsEl = document.getElementById('fpsDisplay');
    this.tick();
    setInterval(() => this.tick(), 1000);
  },

  tick() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    this.el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  },

  updateFPS(fps) {
    this.fpsEl.textContent = fps;
  }
};

/* ═══════════════════════════════════════════════════════════════
   MAP ENGINE
═══════════════════════════════════════════════════════════════ */
const MapEngine = {

  init() {
    State.map.instance = L.map('mapContainer', {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    }).setView([0, 0], 15);

    this.setTile();
    this.initUserMarker();
    this.bindSearchInputs();
  },

  setTile() {
    const url = State.theme === 'dark' ? CONFIG.MAP_TILE_DARK : CONFIG.MAP_TILE_LIGHT;
    if (State.map.tileLayer) State.map.tileLayer.remove();
    State.map.tileLayer = L.tileLayer(url, {
      attribution: '© CartoDB © OSM',
      maxZoom: 19,
    }).addTo(State.map.instance);
  },

  initUserMarker() {
    const icon = L.divIcon({
      className: '',
      html: '<div class="user-marker-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    State.map.userMarker = L.marker([0, 0], { icon, zIndexOffset: 1000 })
      .addTo(State.map.instance);
  },

  updateUserPosition(lat, lng, accuracy) {
    const latlng = [lat, lng];
    State.map.userMarker.setLatLng(latlng);

    if (State.map.accuracyCircle) State.map.accuracyCircle.remove();
    State.map.accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      color: 'var(--accent-primary)',
      fillColor: 'var(--accent-primary)',
      fillOpacity: 0.05,
      weight: 1,
      dashArray: '4 4',
    }).addTo(State.map.instance);

    if (!State.nav.navigating) {
      State.map.instance.panTo(latlng, { animate: true, duration: 0.5 });
    }
  },

  bindSearchInputs() {
    const originInput = document.getElementById('originInput');
    const destInput   = document.getElementById('destInput');
    let originTimer, destTimer;

    originInput.addEventListener('input', () => {
      clearTimeout(originTimer);
      originTimer = setTimeout(() => this.autocomplete(originInput.value, 'originList', 'origin'), 500);
    });
    destInput.addEventListener('input', () => {
      clearTimeout(destTimer);
      destTimer = setTimeout(() => this.autocomplete(destInput.value, 'destList', 'dest'), 500);
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.search-field')) {
        document.getElementById('originList').classList.add('hidden');
        document.getElementById('destList').classList.add('hidden');
      }
    });
  },

  async autocomplete(query, listId, type) {
    const list = document.getElementById(listId);
    if (!query || query.length < 3) { list.classList.add('hidden'); return; }
    if (!State.online) return;

    try {
      const res = await fetch(
        `${CONFIG.NOMINATIM_URL}/search?format=json&q=${encodeURIComponent(query)}&limit=5`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const data = await res.json();
      list.innerHTML = '';

      if (!data.length) { list.classList.add('hidden'); return; }

      data.forEach(item => {
        const div = document.createElement('div');
        div.className = 'autocomplete-item';
        div.textContent = item.display_name.substring(0, 60) + (item.display_name.length > 60 ? '…' : '');
        div.addEventListener('click', () => {
          const lat = parseFloat(item.lat);
          const lng = parseFloat(item.lon);
          if (type === 'origin') {
            State.nav.originLatLng = [lat, lng];
            document.getElementById('originInput').value = item.display_name.substring(0, 40);
          } else {
            State.nav.destLatLng = [lat, lng];
            document.getElementById('destInput').value = item.display_name.substring(0, 40);
          }
          list.classList.add('hidden');
          State.map.instance.flyTo([lat, lng], 14);
          L.popup().setLatLng([lat, lng]).setContent(`<b>${type === 'origin' ? 'FROM' : 'TO'}</b><br>${item.display_name.substring(0, 60)}`).openOn(State.map.instance);
        });
        list.appendChild(div);
      });
      list.classList.remove('hidden');
    } catch {
      list.classList.add('hidden');
    }
  },

  buildRoute() {
    if (!State.nav.originLatLng || !State.nav.destLatLng) {
      Toast.show('Set both origin and destination first.', 'warning');
      return;
    }

    if (State.nav.routing) {
      State.map.instance.removeControl(State.nav.routing);
      State.nav.routing = null;
    }

    State.nav.routing = L.Routing.control({
      waypoints: [
        L.latLng(...State.nav.originLatLng),
        L.latLng(...State.nav.destLatLng),
      ],
      routeWhileDragging: false,
      showAlternatives: false,
      fitSelectedRoutes: true,
      lineOptions: {
        styles: [
          { color: 'var(--accent-primary)', opacity: 0.9, weight: 5 },
          { color: '#fff', opacity: 0.2, weight: 2 },
        ]
      },
      createMarker: () => null,
    })
    .on('routesfound', e => {
      const route = e.routes[0];
      const distKm = (route.summary.totalDistance / 1000).toFixed(1);
      const etaMin = Math.round(route.summary.totalTime / 60);
      const arrTime = new Date(Date.now() + route.summary.totalTime * 1000);
      const pad = n => String(n).padStart(2, '0');

      document.getElementById('routeDistance').textContent = distKm + ' km';
      document.getElementById('routeETA').textContent = etaMin + ' min';
      document.getElementById('routeArrival').textContent =
        `${pad(arrTime.getHours())}:${pad(arrTime.getMinutes())}`;

      document.getElementById('routeInfo').classList.remove('hidden');
      Toast.show(`Route found: ${distKm} km, ~${etaMin} min`, 'success');
    })
    .on('routingerror', () => Toast.show('Routing failed. Try different waypoints.', 'error'))
    .addTo(State.map.instance);
  },

  resetRoute() {
    if (State.nav.routing) {
      State.map.instance.removeControl(State.nav.routing);
      State.nav.routing = null;
    }
    State.nav.originLatLng = null;
    State.nav.destLatLng = null;
    State.nav.navigating = false;
    document.getElementById('originInput').value = '';
    document.getElementById('destInput').value = '';
    document.getElementById('routeInfo').classList.add('hidden');
    document.getElementById('navStatusText').textContent = 'STANDBY';
    document.getElementById('navStatusText').classList.remove('active');
  }
};

/* ═══════════════════════════════════════════════════════════════
   GPS ENGINE
═══════════════════════════════════════════════════════════════ */
const GPSEngine = {

  gpsDot: null,
  gpsLabel: null,

  init() {
    this.gpsDot   = document.getElementById('gpsDot');
    this.gpsLabel = document.getElementById('gpsLabel');
    this.start();
  },

  start() {
    if (!('geolocation' in navigator)) {
      Toast.show('GPS not available on this device.', 'error');
      this.setStatus('error');
      return;
    }

    Toast.show('Acquiring GPS signal...', 'info', 2500);
    State.gps.watchId = navigator.geolocation.watchPosition(
      pos => this.onPosition(pos),
      err => this.onError(err),
      CONFIG.GPS_OPTIONS
    );
  },

  stop() {
    if (State.gps.watchId !== null) {
      navigator.geolocation.clearWatch(State.gps.watchId);
      State.gps.watchId = null;
    }
  },

  onPosition(pos) {
    const { latitude: lat, longitude: lng, speed, altitude, accuracy, heading } = pos.coords;
    const gps = State.gps;

    // Speed: GPS speed (m/s → km/h), EMA filter
    const rawSpeed = speed != null ? speed * 3.6 : 0;
    gps.smoothedSpeed = gps.smoothedSpeed * (1 - CONFIG.SPEED_FILTER_ALPHA)
                      + rawSpeed           *      CONFIG.SPEED_FILTER_ALPHA;
    gps.speed = Math.max(0, gps.smoothedSpeed);

    // Max Speed
    if (gps.speed > gps.maxSpeed) gps.maxSpeed = gps.speed;

    // Distance
    if (gps.prevLat !== null) {
      const d = this.haversine(gps.prevLat, gps.prevLng, lat, lng);
      if (d > 0.001 && d < 0.5) {          // filter teleport > 500m
        gps.sessionDist += d;
        gps.totalDist   += d;
        gps.odometer    += d;
        localStorage.setItem('hudnav-odometer', gps.odometer.toFixed(3));
        if (State.trip.startTime) State.trip.waypoints.push({ lat, lng, spd: gps.speed, ts: Date.now() });
      }
    }
    gps.prevLat = lat; gps.prevLng = lng;

    // Average speed
    gps.speedReadings.push(gps.speed);
    if (gps.speedReadings.length > 60) gps.speedReadings.shift();
    gps.avgSpeed = gps.speedReadings.reduce((a, b) => a + b, 0) / gps.speedReadings.length;

    // Bearing / heading
    gps.bearing = heading != null ? heading : (gps.bearing || 0);

    // Extras
    gps.altitude = altitude;
    gps.accuracy = accuracy;
    gps.position = [lat, lng];
    gps.active   = true;
    gps.error    = false;

    // Update map
    MapEngine.updateUserPosition(lat, lng, accuracy);

    // Update coordinate display
    document.getElementById('coordDisplay').textContent =
      `${lat.toFixed(5)}° / ${lng.toFixed(5)}°`;

    // Update compass
    this.updateCompass(gps.bearing);

    // GPS status indicator
    if (accuracy < 20)       this.setStatus('good');
    else if (accuracy < 60)  this.setStatus('warn');
    else                     this.setStatus('poor');

    // UI updates
    UIUpdater.update();
  },

  onError(err) {
    State.gps.error = true;
    this.setStatus('error');
    const msgs = {
      1: 'GPS permission denied. Please allow location access.',
      2: 'GPS signal lost. Move to an open area.',
      3: 'GPS timed out. Retrying...',
    };
    Toast.show(msgs[err.code] || 'GPS error.', 'error', 5000);
    if (err.code === 3) setTimeout(() => this.start(), 5000);
  },

  setStatus(s) {
    const dot   = this.gpsDot;
    const label = this.gpsLabel;
    dot.className = 'status-dot';
    if      (s === 'good')  { dot.classList.add('active'); label.textContent = 'GPS'; }
    else if (s === 'warn')  { dot.classList.add('warn');   label.textContent = 'WEAK'; }
    else if (s === 'poor')  { dot.classList.add('warn');   label.textContent = 'POOR'; }
    else                    { dot.classList.add('error');  label.textContent = 'NO GPS'; }
  },

  updateCompass(bearing) {
    const dial = document.getElementById('compassDial');
    const needle = dial.querySelector('.compass-needle');
    const bearingEl = document.getElementById('compassBearing');
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    const dir  = dirs[Math.round(bearing / 45) % 8];
    needle.style.transform = `rotate(${bearing}deg)`;
    bearingEl.textContent  = Math.round(bearing) + '°';
    document.getElementById('speedDirection').textContent = dir;
  },

  haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) ** 2 +
              Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
              Math.sin(dLon/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
};

/* ═══════════════════════════════════════════════════════════════
   SPEEDOMETER RENDERER
═══════════════════════════════════════════════════════════════ */
const Speedo = {
  canvas: null,
  ctx: null,
  size: CONFIG.SPEEDO_CANVAS_SIZE,
  cx: 0, cy: 0, r: 0,

  init() {
    this.canvas = document.getElementById('speedoCanvas');
    this.canvas.width  = this.size;
    this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d');
    this.cx = this.size / 2;
    this.cy = this.size / 2;
    this.r  = this.size / 2 - 16;

    this.startAnimation();
    this.startupAnimation();
  },

  /* Startup sweep animation */
  startupAnimation() {
    let sweep = 0;
    const maxSweep = CONFIG.SPEEDO_MAX_SPEED;
    const timer = setInterval(() => {
      sweep = Math.min(sweep + 6, maxSweep);
      State.speedo.targetAngle = this.speedToAngle(sweep);
      if (sweep >= maxSweep) {
        clearInterval(timer);
        setTimeout(() => { State.speedo.targetAngle = this.speedToAngle(0); }, 600);
      }
    }, 16);
  },

  speedToAngle(speed) {
    const pct = Math.min(speed / CONFIG.SPEEDO_MAX_SPEED, 1);
    return -135 + pct * 270;
  },

  startAnimation() {
    const loop = (ts) => {
      this.updateNeedle(ts);
      this.draw();
      State.speedo.animFrame = requestAnimationFrame(loop);
      this.updateFPS(ts);
    };
    State.speedo.animFrame = requestAnimationFrame(loop);
  },

  updateNeedle(ts) {
    const target = this.speedToAngle(State.gps.speed);
    State.speedo.targetAngle = target;
    const diff = State.speedo.targetAngle - State.speedo.needleAngle;
    State.speedo.needleAngle += diff * 0.18;
  },

  updateFPS(ts) {
    State.perf.frameCount++;
    if (ts - State.perf.fpsTimer > 1000) {
      State.perf.fps = State.perf.frameCount;
      State.perf.frameCount = 0;
      State.perf.fpsTimer = ts;
      Clock.updateFPS(State.perf.fps);
    }
  },

  /* ── MAIN DRAW ── */
  draw() {
    const { ctx, cx, cy, r } = this;
    const theme = State.theme;
    const speed = State.gps.speed;
    const angle = State.speedo.needleAngle;

    ctx.clearRect(0, 0, this.size, this.size);

    // Determine color zone
    let zoneColor, glowColor;
    if (speed < 60)       { zoneColor = '#00ff88'; glowColor = 'rgba(0,255,136,0.6)'; }
    else if (speed < 100) { zoneColor = '#ffcc00'; glowColor = 'rgba(255,204,0,0.6)'; }
    else                  { zoneColor = '#ff3344'; glowColor = 'rgba(255,51,68,0.6)'; }

    // Outer ring glow
    const outerGrad = ctx.createRadialGradient(cx, cy, r - 4, cx, cy, r + 4);
    outerGrad.addColorStop(0, 'rgba(0,212,255,0.2)');
    outerGrad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = outerGrad;
    ctx.lineWidth = 8;
    ctx.stroke();

    // Background track
    ctx.beginPath();
    ctx.arc(cx, cy, r - 10, this.degToRad(-135), this.degToRad(135), false);
    ctx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Colored fill arc (progress)
    const fillEnd = this.degToRad(angle);
    if (angle > -135) {
      ctx.beginPath();
      ctx.arc(cx, cy, r - 10, this.degToRad(-135), fillEnd, false);
      ctx.strokeStyle = zoneColor;
      ctx.lineWidth = 12;
      ctx.lineCap = 'round';
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Tick marks
    this.drawTicks(ctx, cx, cy, r);

    // Speed labels
    this.drawLabels(ctx, cx, cy, r);

    // Needle
    this.drawNeedle(ctx, cx, cy, angle, zoneColor, glowColor);

    // Center hub
    this.drawHub(ctx, cx, cy);
  },

  drawTicks(ctx, cx, cy, r) {
    const totalTicks = 41;
    for (let i = 0; i <= totalTicks; i++) {
      const pct = i / totalTicks;
      const angle = -135 + pct * 270;
      const rad   = this.degToRad(angle);
      const isMajor = i % 4 === 0;
      const len = isMajor ? 14 : 7;
      const w   = isMajor ? 2 : 1;

      const x1 = cx + (r - 22) * Math.cos(rad);
      const y1 = cy + (r - 22) * Math.sin(rad);
      const x2 = cx + (r - 22 - len) * Math.cos(rad);
      const y2 = cy + (r - 22 - len) * Math.sin(rad);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = w;
      ctx.stroke();
    }
  },

  drawLabels(ctx, cx, cy, r) {
    const labels = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200];
    ctx.font = `bold ${this.size * 0.038}px Orbitron, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';

    labels.forEach(val => {
      const pct = val / CONFIG.SPEEDO_MAX_SPEED;
      const angle = -135 + pct * 270;
      const rad = this.degToRad(angle);
      const dist = r - 44;
      const x = cx + dist * Math.cos(rad);
      const y = cy + dist * Math.sin(rad);
      ctx.fillText(String(val), x, y);
    });
  },

  drawNeedle(ctx, cx, cy, angle, zoneColor, glowColor) {
    const rad = this.degToRad(angle);
    const needleLen = this.r - 32;
    const tailLen   = 16;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad);

    // Glow
    ctx.shadowColor = glowColor;
    ctx.shadowBlur  = 20;

    // Needle body
    const grad = ctx.createLinearGradient(0, -needleLen, 0, tailLen);
    grad.addColorStop(0, zoneColor);
    grad.addColorStop(0.7, zoneColor);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(-2, tailLen);
    ctx.lineTo(0, -needleLen);
    ctx.lineTo(2, tailLen);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.restore();
  },

  drawHub(ctx, cx, cy) {
    const hubR = 14;
    const grad = ctx.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, hubR);
    grad.addColorStop(0, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(0,212,255,0.2)');
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,212,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner dot
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,212,255,0.9)';
    ctx.fill();
  },

  degToRad: deg => (deg * Math.PI) / 180,
};

/* ═══════════════════════════════════════════════════════════════
   UI UPDATER
═══════════════════════════════════════════════════════════════ */
const UIUpdater = {
  update() {
    const g = State.gps;
    const fmt = (n, dec=1) => isFinite(n) ? n.toFixed(dec) : '--';

    // Speed display
    const speedEl = document.getElementById('speedValue');
    speedEl.textContent = fmt(g.speed, 0);

    // Color the speed value
    if (g.speed < 60)       speedEl.style.color = 'var(--speed-green)';
    else if (g.speed < 100) speedEl.style.color = 'var(--speed-yellow)';
    else                    speedEl.style.color  = 'var(--speed-red)';

    // Stats
    document.getElementById('avgSpeed').innerHTML   = `${fmt(g.avgSpeed, 0)} <span class="stat-unit">km/h</span>`;
    document.getElementById('maxSpeed').innerHTML   = `${fmt(g.maxSpeed, 0)} <span class="stat-unit">km/h</span>`;
    document.getElementById('totalDist').innerHTML  = `${fmt(g.sessionDist, 2)} <span class="stat-unit">km</span>`;
    document.getElementById('altValue').innerHTML   = g.altitude != null ? `${fmt(g.altitude, 0)} <span class="stat-unit">m</span>` : `-- <span class="stat-unit">m</span>`;
    document.getElementById('gpsAccuracy').innerHTML = g.accuracy != null ? `${fmt(g.accuracy, 0)} <span class="stat-unit">m</span>` : `-- <span class="stat-unit">m</span>`;
    document.getElementById('odometer').innerHTML   = `${g.odometer.toFixed(3)} <span class="stat-unit">km</span>`;
  }
};

/* ═══════════════════════════════════════════════════════════════
   NETWORK MONITOR
═══════════════════════════════════════════════════════════════ */
const Network = {
  dot: null,
  label: null,

  init() {
    this.dot   = document.getElementById('netDot');
    this.label = document.getElementById('netLabel');
    window.addEventListener('online',  () => this.setOnline(true));
    window.addEventListener('offline', () => this.setOnline(false));
    this.setOnline(navigator.onLine);
  },

  setOnline(online) {
    State.online = online;
    this.dot.className  = 'status-dot' + (online ? ' active' : ' error');
    this.label.textContent = online ? 'ONLINE' : 'OFFLINE';
    if (!online) Toast.show('Connection lost. Maps may be unavailable.', 'warning');
    else         Toast.show('Connection restored.', 'success', 2000);
  }
};

/* ═══════════════════════════════════════════════════════════════
   BACKEND API (Google Apps Script)
═══════════════════════════════════════════════════════════════ */
const Backend = {

  async saveTrip(data) {
    if (!State.online) { Toast.show('Offline — trip not saved to cloud.', 'warning'); return; }
    if (CONFIG.APPS_SCRIPT_URL.includes('YOUR_SCRIPT_ID')) {
      Toast.show('Apps Script URL not configured.', 'warning', 4000); return;
    }
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveTrip', ...data }),
      });
      Toast.show('Trip saved to cloud ✓', 'success');
    } catch (e) {
      Toast.show('Failed to save trip.', 'error');
    }
  },

  async getHistory() {
    if (CONFIG.APPS_SCRIPT_URL.includes('YOUR_SCRIPT_ID')) return [];
    try {
      const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=getHistory`);
      const data = await res.json();
      return data.history || [];
    } catch {
      return [];
    }
  }
};

/* ═══════════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════════ */
const App = {

  reveal() {
    document.getElementById('appContainer').classList.remove('hidden');
    this.applyTheme(State.theme);
    MapEngine.init();
    GPSEngine.init();
    Speedo.init();
    Clock.init();
    Network.init();
    this.tryFullscreen();
    this.startTripAutoSave();
    Toast.show('HUD NAV ready. Acquiring GPS...', 'info', 2500);
  },

  applyTheme(theme) {
    State.theme = theme;
    document.getElementById('appBody').className = `theme-${theme}`;
    document.getElementById('themeIcon').textContent = theme === 'dark' ? '☀' : '☾';
    localStorage.setItem('hudnav-theme', theme);
    if (State.map.instance) MapEngine.setTile();
  },

  toggleTheme() {
    this.applyTheme(State.theme === 'dark' ? 'light' : 'dark');
  },

  toggleFullscreen() {
    if (!document.fullscreenElement) this.requestFullscreen();
    else document.exitFullscreen();
  },

  async requestFullscreen() {
    try {
      await document.documentElement.requestFullscreen();
      State.ui.fullscreen = true;
      this.dismissModal();
    } catch {
      Toast.show('Fullscreen not available in this browser.', 'warning');
    }
  },

  tryFullscreen() {
    setTimeout(async () => {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        document.getElementById('fullscreenModal').classList.remove('hidden');
      }
    }, 1000);
  },

  dismissModal() {
    document.getElementById('fullscreenModal').classList.add('hidden');
  },

  toggleSearchPanel() {
    const panel = document.getElementById('searchPanel');
    State.ui.searchPanelOpen = !State.ui.searchPanelOpen;
    panel.classList.toggle('collapsed', !State.ui.searchPanelOpen);
  },

  /* ── NAV ACTIONS ── */
  searchOrigin() {
    const q = document.getElementById('originInput').value;
    if (q) MapEngine.autocomplete(q, 'originList', 'origin');
  },

  searchDest() {
    const q = document.getElementById('destInput').value;
    if (q) MapEngine.autocomplete(q, 'destList', 'dest');
  },

  startNavigation() {
    if (!State.nav.originLatLng && State.gps.position) {
      State.nav.originLatLng = State.gps.position;
      document.getElementById('originInput').value = 'Current Location';
    }
    if (!State.nav.destLatLng) { Toast.show('Set a destination first.', 'warning'); return; }

    MapEngine.buildRoute();
    State.nav.navigating = true;
    State.trip.startTime = Date.now();
    State.trip.waypoints = [];
    document.getElementById('navStatusText').textContent = 'NAVIGATING';
    document.getElementById('navStatusText').classList.add('active');
    Toast.show('Navigation started!', 'success');
  },

  myLocation() {
    if (State.gps.position) {
      State.map.instance.flyTo(State.gps.position, 16, { duration: 1.2 });
      State.nav.originLatLng = State.gps.position;
      document.getElementById('originInput').value = 'Current Location';
      Toast.show('Centered on your location.', 'info', 2000);
    } else {
      Toast.show('GPS not available yet.', 'warning');
    }
  },

  resetRoute() {
    MapEngine.resetRoute();
    State.trip.startTime = null;
    State.trip.waypoints = [];
    Toast.show('Route reset.', 'info', 2000);
  },

  resetStats() {
    const g = State.gps;
    g.speed = 0; g.smoothedSpeed = 0; g.maxSpeed = 0;
    g.avgSpeed = 0; g.sessionDist = 0;
    g.speedReadings = [];
    UIUpdater.update();
    Toast.show('Statistics reset.', 'info', 2000);
  },

  saveTrip() {
    if (!State.trip.startTime) { Toast.show('No active trip to save.', 'warning'); return; }
    const duration = Math.round((Date.now() - State.trip.startTime) / 1000);
    const tripData = {
      timestamp: new Date().toISOString(),
      duration,
      distance: State.gps.sessionDist.toFixed(3),
      maxSpeed: State.gps.maxSpeed.toFixed(1),
      avgSpeed: State.gps.avgSpeed.toFixed(1),
      latitude:  State.gps.position ? State.gps.position[0] : null,
      longitude: State.gps.position ? State.gps.position[1] : null,
      waypoints: State.trip.waypoints.length,
    };
    Backend.saveTrip(tripData);
  },

  startTripAutoSave() {
    setInterval(() => {
      if (State.trip.startTime && State.gps.sessionDist > 0.01) {
        this.saveTrip();
      }
    }, CONFIG.AUTO_SAVE_INTERVAL);
  },

  /* ── MAP CONTROLS ── */
  zoomIn()    { State.map.instance.zoomIn(); },
  zoomOut()   { State.map.instance.zoomOut(); },
  centerMap() {
    if (State.gps.position)
      State.map.instance.flyTo(State.gps.position, 16, { duration: 0.8 });
  },
};

/* ═══════════════════════════════════════════════════════════════
   BOOTSTRAP
═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  Toast.init();
  Splash.init();
});

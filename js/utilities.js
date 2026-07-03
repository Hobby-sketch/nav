/**
 * MotoDash — utilities.js
 * Core helper functions: Haversine, Kalman, EventBus,
 * Storage, formatters, GPX export, DOM helpers.
 */

'use strict';

// ═══════════════════════════════════════════════════════════
//  HAVERSINE FORMULA
// ═══════════════════════════════════════════════════════════
/**
 * Calculate distance in meters between two GPS coordinates.
 * @param {number} lat1  Starting latitude
 * @param {number} lon1  Starting longitude
 * @param {number} lat2  Ending latitude
 * @param {number} lon2  Ending longitude
 * @returns {number} Distance in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R   = 6371000; // Earth radius in meters
    const φ1  = (lat1 * Math.PI) / 180;
    const φ2  = (lat2 * Math.PI) / 180;
    const Δφ  = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ  = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(Δφ / 2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// ═══════════════════════════════════════════════════════════
//  BEARING CALCULATION
// ═══════════════════════════════════════════════════════════
/**
 * Calculate true bearing (0–360°) from point A → point B.
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ═══════════════════════════════════════════════════════════
//  LOCAL STORAGE WRAPPER
// ═══════════════════════════════════════════════════════════
const Storage = {
    get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item !== null ? JSON.parse(item) : defaultValue;
        } catch { return defaultValue; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (e) { console.error('[Storage] set failed:', e); return false; }
    },
    remove(key) { localStorage.removeItem(key); },
    clear()     { localStorage.clear(); }
};

// ═══════════════════════════════════════════════════════════
//  EVENT BUS
// ═══════════════════════════════════════════════════════════
const EventBus = {
    emit(event, detail = {}) {
        window.dispatchEvent(new CustomEvent(event, { detail }));
    },
    on(event, handler) {
        window.addEventListener(event, (e) => handler(e.detail));
    },
    off(event, handler) {
        window.removeEventListener(event, handler);
    }
};

// ═══════════════════════════════════════════════════════════
//  TOAST NOTIFICATION
// ═══════════════════════════════════════════════════════════
let _toastTimer = null;
/**
 * Display a transient toast message.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} type
 * @param {number} duration  milliseconds
 */
function showToast(message, type = 'info', duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(_toastTimer);
    toast.textContent  = message;
    toast.className    = `toast toast-${type} show`;
    _toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ═══════════════════════════════════════════════════════════
//  FORMATTERS
// ═══════════════════════════════════════════════════════════
/** Format seconds → MM:SS  or  HH:MM:SS */
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Format meters → "X m" or "X.X km" */
function formatDistance(meters) {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}

/** Format seconds → "X min" or "Xh Ymin" */
function formatETA(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}min` : `${m} min`;
}

/** Current time as HH:MM */
function getCurrentTime() {
    const n = new Date();
    return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
}

/** Current date as "WED 04 JUN" */
function getCurrentDate() {
    const n = new Date();
    const days   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return `${days[n.getDay()]} ${n.getDate()} ${months[n.getMonth()]}`;
}

// ═══════════════════════════════════════════════════════════
//  GPX EXPORT
// ═══════════════════════════════════════════════════════════
/**
 * Generate GPX XML string from an array of track points.
 * @param {Array<{lat,lng,speed,time}>} points
 * @param {string} name  Track name
 */
function generateGPX(points, name = 'MotoDash Track') {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MotoDash v1.0"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
`;
    const footer = `    </trkseg>\n  </trk>\n</gpx>`;
    const trkpts = points.map(p =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">\n` +
        `        <time>${new Date(p.time).toISOString()}</time>\n` +
        `        <extensions><speed>${(p.speed / 3.6).toFixed(3)}</speed></extensions>\n` +
        `      </trkpt>`
    ).join('\n');
    return header + trkpts + '\n' + footer;
}

/** Trigger a browser file-download. */
function downloadFile(content, filename, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ═══════════════════════════════════════════════════════════
//  DOM HELPERS
// ═══════════════════════════════════════════════════════════
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** Safely set textContent of an element by id. */
function setEl(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/**
 * Read the current computed value of a CSS custom property (e.g. '--clr-primary').
 * Used by JS-drawn elements (Leaflet markers, route lines, canvas/SVG colors)
 * so they stay correct across color themes and day/night mode without
 * hardcoding hex values that would otherwise go stale when the theme changes.
 */
function getCSSVar(name, fallback = '') {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name);
    return val ? val.trim() : fallback;
}

// ═══════════════════════════════════════════════════════════
//  GLOBAL EXPORT
// ═══════════════════════════════════════════════════════════
window.Utils = {
    haversineDistance,
    calculateBearing,
    Storage,
    EventBus,
    showToast,
    formatDuration,
    formatDistance,
    formatETA,
    getCurrentTime,
    getCurrentDate,
    generateGPX,
    downloadFile,
    $, $$, setEl,
    getCSSVar
};

console.log('[Utils] Loaded ✓');

/**
 * MotoDash — bluetooth.js
 * Web Bluetooth API: scan, connect, battery level, device list.
 * Supports headsets, speakers, and generic BT devices.
 */

'use strict';

class BluetoothModule {
    constructor() {
        this.isSupported     = 'bluetooth' in navigator;
        this.devices         = new Map();   // id → DeviceInfo
        this.scanning        = false;

        this._init();
        console.log('[Bluetooth] Initialized, supported:', this.isSupported);
    }

    _init() {
        this._setupUI();
        if (!this.isSupported) this._showUnsupported();
    }

    // ─────────────────────────────────────────────────────
    //  UI SETUP
    // ─────────────────────────────────────────────────────
    _setupUI() {
        document.getElementById('bt-scan-btn')
            ?.addEventListener('click', () => this.scan());
    }

    _showUnsupported() {
        const el = document.getElementById('bt-status-text');
        if (el) {
            el.textContent  = 'Web Bluetooth not supported (requires Chrome/Edge + HTTPS)';
            el.style.color  = 'var(--color-danger)';
        }
        const btn = document.getElementById('bt-scan-btn');
        if (btn) btn.disabled = true;
    }

    // ─────────────────────────────────────────────────────
    //  SCAN
    // ─────────────────────────────────────────────────────
    async scan() {
        if (!this.isSupported) {
            Utils.showToast('Web Bluetooth not supported on this browser', 'error');
            return;
        }

        this.scanning = true;
        this._setScanBtn(true);
        this._setStatus('Scanning for nearby devices…');

        try {
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices : true,
                optionalServices : [
                    'battery_service',
                    'device_information',
                    'generic_access'
                ]
            });
            await this._connect(device);
        } catch (err) {
            if (err.name === 'NotFoundError') {
                this._setStatus('No device selected');
            } else {
                console.error('[BT] Scan error:', err);
                Utils.showToast(`Bluetooth error: ${err.message}`, 'error');
                this._setStatus(`Error: ${err.message}`);
            }
        } finally {
            this.scanning = false;
            this._setScanBtn(false);
        }
    }

    // ─────────────────────────────────────────────────────
    //  CONNECT
    // ─────────────────────────────────────────────────────
    async _connect(device) {
        this._setStatus(`Connecting to ${device.name || 'device'}…`);
        try {
            const server = await device.gatt.connect();
            const info   = {
                id          : device.id,
                name        : device.name || 'Unknown Device',
                device,
                server,
                connected   : true,
                batteryLevel: null
            };

            /* Try battery service */
            try {
                const svc  = await server.getPrimaryService('battery_service');
                const char = await svc.getCharacteristic('battery_level');
                info.batteryLevel = (await char.readValue()).getUint8(0);

                await char.startNotifications();
                char.addEventListener('characteristicvaluechanged', (e) => {
                    info.batteryLevel = e.target.value.getUint8(0);
                    this._render();
                });
            } catch { /* battery_service optional */ }

            /* Disconnect listener */
            device.addEventListener('gattserverdisconnected', () => {
                info.connected = false;
                this._render();
                this._updateStatusBarIcon();
                Utils.showToast(`${info.name} disconnected`, 'warning');
            });

            this.devices.set(device.id, info);
            this._render();
            this._updateStatusBarIcon();
            this._setStatus(`Connected to ${info.name}`);
            Utils.showToast(`Connected: ${info.name}`, 'success');

        } catch (err) {
            console.error('[BT] Connect error:', err);
            Utils.showToast(`Connection failed: ${err.message}`, 'error');
            this._setStatus('Connection failed');
        }
    }

    // ─────────────────────────────────────────────────────
    //  DISCONNECT
    // ─────────────────────────────────────────────────────
    async disconnect(deviceId) {
        const info = this.devices.get(deviceId);
        if (!info) return;
        try {
            if (info.device.gatt.connected) await info.device.gatt.disconnect();
        } catch { /* ignore */ }
        this.devices.delete(deviceId);
        this._render();
        this._updateStatusBarIcon();
        this._setStatus('Device disconnected');
        Utils.showToast('Device disconnected', 'info');
    }

    // ─────────────────────────────────────────────────────
    //  RENDER DEVICE LIST
    // ─────────────────────────────────────────────────────
    _render() {
        const container = document.getElementById('bt-devices');
        if (!container) return;

        if (!this.devices.size) {
            container.innerHTML = `
              <div class="device-placeholder">
                <svg width="52" height="52" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="1">
                  <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>
                </svg>
                <p>No devices connected</p>
                <p class="sub">Tap SCAN to pair a device</p>
              </div>`;
            return;
        }

        container.innerHTML = [...this.devices.values()].map(d => `
          <div class="bt-device-card ${d.connected ? 'conn' : 'disc'}">
            <div class="bt-dev-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2">
                <path d="M3 18v-6a9 9 0 0118 0v6"/>
                <path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3v5z
                         M3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3v5z"/>
              </svg>
            </div>
            <div class="bt-dev-info">
              <div class="bt-dev-name">${d.name}</div>
              <div class="bt-dev-status ${d.connected ? 'conn' : 'disc'}">
                ${d.connected ? '● CONNECTED' : '○ DISCONNECTED'}
              </div>
              ${d.batteryLevel !== null
                ? `<div class="bt-dev-batt">🔋 ${d.batteryLevel}%</div>`
                : ''}
            </div>
            <button class="bt-disc-btn" data-id="${d.id}">
              ${d.connected ? 'DISCONNECT' : 'REMOVE'}
            </button>
          </div>`).join('');

        container.querySelectorAll('.bt-disc-btn').forEach(btn =>
            btn.addEventListener('click', () => this.disconnect(btn.dataset.id))
        );
    }

    // ─────────────────────────────────────────────────────
    //  HELPERS
    // ─────────────────────────────────────────────────────
    _setScanBtn(scanning) {
        const btn = document.getElementById('bt-scan-btn');
        if (!btn) return;
        btn.disabled     = scanning;
        btn.querySelector('span')
            ? (btn.querySelector('span').textContent = scanning ? 'SCANNING…' : 'SCAN DEVICES')
            : (btn.textContent = scanning ? '⏳ SCANNING…' : '🔍 SCAN DEVICES');
    }

    _setStatus(msg) {
        Utils.setEl('bt-status-text', msg);
    }

    _updateStatusBarIcon() {
        const hasConn   = [...this.devices.values()].some(d => d.connected);
        const ico       = document.getElementById('bt-status-icon');
        if (ico) ico.className = `status-icon${hasConn ? ' bt-connected' : ''}`;
    }

    get hasConnectedDevice() {
        return [...this.devices.values()].some(d => d.connected);
    }
}

/* ── Bootstrap ─────────────────────────────────────────── */
window.bluetoothModule = new BluetoothModule();
console.log('[Bluetooth] Ready ✓');

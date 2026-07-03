/**
 * MotoDash — media.js  (v2 — Internal Audio Player)
 *
 * WHY THIS WAS REWRITTEN:
 * ─────────────────────────────────────────────────
 * The previous implementation used navigator.mediaSession.metadata
 * to try reading track info from Spotify / YouTube Music / etc.
 *
 * This is technically impossible:
 *   • navigator.mediaSession.metadata is set BY the page that owns
 *     the <audio> element — it cannot be READ from another app.
 *   • Android's app sandbox prevents any cross-app data access
 *     from a browser context.
 *   • Chrome Android does NOT bridge native-app media metadata
 *     into the Web page's mediaSession object.
 *
 * SOLUTION: Internal HTML5 audio player
 * ─────────────────────────────────────────────────
 *   • User loads local audio files (MP3, AAC, OGG, WAV, FLAC)
 *   • ID3/metadata tags read with jsmediatags library
 *   • Full controls: play/pause/prev/next/seek/shuffle/repeat
 *   • Album art extracted from embedded cover art
 *   • Media Session API used CORRECTLY: to WRITE metadata to OS
 *     notification bar + hardware button support
 */

'use strict';

class MediaModule {
    constructor() {
        /** @type {HTMLAudioElement} */
        this.audio       = null;

        /** @type {Array<{file:File, url:string, title:string, artist:string, album:string, cover:string|null, duration:number}>} */
        this.playlist    = [];
        this.currentIdx  = -1;

        this.isPlaying   = false;
        this.isShuffle   = false;
        this.isRepeat    = false;
        this.volume      = 0.85;

        // Timer references for cleanup
        this._syncMetaT  = null;   // was causing leak in v1 — now properly tracked

        this._init();
    }

    // ─────────────────────────────────────────────────────
    //  INIT
    // ─────────────────────────────────────────────────────
    _init() {
        this._setupAudio();
        this._setupUI();
        this._setupMediaSession();
        console.log('[Media] Internal audio player ready ✓');
    }

    // ─────────────────────────────────────────────────────
    //  AUDIO ELEMENT
    // ─────────────────────────────────────────────────────
    _setupAudio() {
        this.audio = document.getElementById('audio-player');
        if (!this.audio) {
            // Fallback: create element if not in DOM
            this.audio = document.createElement('audio');
            this.audio.id = 'audio-player';
            document.body.appendChild(this.audio);
        }

        this.audio.volume   = this.volume;
        this.audio.preload  = 'metadata';

        // Audio events
        this.audio.addEventListener('play', () => {
            this.isPlaying = true;
            this._renderPlayBtn();
            this._updateMediaSessionMeta();
        });

        this.audio.addEventListener('pause', () => {
            this.isPlaying = false;
            this._renderPlayBtn();
        });

        this.audio.addEventListener('ended', () => this._onEnded());

        this.audio.addEventListener('timeupdate', () => this._renderProgress());

        this.audio.addEventListener('loadedmetadata', () => {
            Utils.setEl('track-total', this._fmtTime(this.audio.duration));
        });

        this.audio.addEventListener('error', (e) => {
            const codes = { 1:'ABORTED', 2:'NETWORK', 3:'DECODE', 4:'NOT_SUPPORTED' };
            const code  = codes[e.target?.error?.code] || 'UNKNOWN';
            console.error(`[Media] Audio error: ${code}`);
            Utils.showToast(`Playback error (${code}) — skipping`, 'error');
            setTimeout(() => this._next(), 1200);
        });
    }

    // ─────────────────────────────────────────────────────
    //  FILE LOADING
    // ─────────────────────────────────────────────────────
    async _loadFiles(files) {
        if (!files || !files.length) return;

        const audioFiles = Array.from(files).filter(f =>
            f.type.startsWith('audio/') || /\.(mp3|aac|ogg|wav|flac|m4a|opus)$/i.test(f.name)
        );

        if (!audioFiles.length) {
            Utils.showToast('No audio files found', 'warning');
            return;
        }

        Utils.showToast(`Loading ${audioFiles.length} file(s)…`, 'info');

        const startIdx = this.playlist.length;

        for (const file of audioFiles) {
            const track = {
                file,
                url   : URL.createObjectURL(file),
                title : file.name.replace(/\.[^/.]+$/, ''), // strip extension
                artist: 'Unknown Artist',
                album : 'Unknown Album',
                cover : null,
                duration: 0
            };

            // Read ID3 tags if jsmediatags is available
            if (window.jsmediatags) {
                await new Promise((resolve) => {
                    window.jsmediatags.read(file, {
                        onSuccess: (tag) => {
                            const t = tag.tags;
                            if (t.title)  track.title  = t.title;
                            if (t.artist) track.artist = t.artist;
                            if (t.album)  track.album  = t.album;

                            if (t.picture) {
                                try {
                                    const { data, format } = t.picture;
                                    const bytes = new Uint8Array(data);
                                    const blob  = new Blob([bytes], { type: format });
                                    track.cover = URL.createObjectURL(blob);
                                } catch { /* ignore cover art errors */ }
                            }
                            resolve();
                        },
                        onError: () => resolve()
                    });
                });
            }

            this.playlist.push(track);
        }

        this._renderPlaylist();
        this._updateTrackCount();

        // Auto-play first new track if nothing is playing
        if (this.currentIdx === -1) {
            this._playIndex(startIdx);
        }

        Utils.showToast(`✓ ${audioFiles.length} track(s) loaded`, 'success');
    }

    // ─────────────────────────────────────────────────────
    //  PLAYBACK CONTROL
    // ─────────────────────────────────────────────────────
    _playIndex(idx) {
        if (idx < 0 || idx >= this.playlist.length) return;
        this.currentIdx = idx;
        const track = this.playlist[idx];

        this.audio.src = track.url;
        this.audio.load();
        this.audio.play().catch(e => console.warn('[Media] play() rejected:', e.message));

        this._renderMeta(track);
        this._renderPlaylist();
    }

    _onEnded() {
        if (this.isRepeat) {
            this.audio.currentTime = 0;
            this.audio.play();
        } else {
            this._next();
        }
    }

    _next() {
        if (!this.playlist.length) return;
        let idx;
        if (this.isShuffle) {
            do { idx = Math.floor(Math.random() * this.playlist.length); }
            while (this.playlist.length > 1 && idx === this.currentIdx);
        } else {
            idx = (this.currentIdx + 1) % this.playlist.length;
        }
        this._playIndex(idx);
    }

    _prev() {
        if (!this.playlist.length) return;
        // < 3s played → go to previous track; else restart
        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
        } else {
            const idx = (this.currentIdx - 1 + this.playlist.length) % this.playlist.length;
            this._playIndex(idx);
        }
    }

    // ─────────────────────────────────────────────────────
    //  PUBLIC API  (called by Voice module + UI buttons)
    // ─────────────────────────────────────────────────────
    playPause() {
        if (!this.audio.src || this.audio.src === window.location.href) {
            Utils.showToast('Load audio files first (tap 📁)', 'warning');
            return;
        }
        if (this.isPlaying) {
            this.audio.pause();
        } else {
            this.audio.play().catch(e => console.warn('[Media] play():', e.message));
        }
    }

    next()     { this._next(); }
    previous() { this._prev(); }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
        if (this.audio) this.audio.volume = this.volume;
    }

    // ─────────────────────────────────────────────────────
    //  SHUFFLE / REPEAT
    // ─────────────────────────────────────────────────────
    _toggleShuffle() {
        this.isShuffle = !this.isShuffle;
        const btn = document.getElementById('btn-shuffle');
        if (btn) {
            btn.style.opacity   = this.isShuffle ? '1' : '0.35';
            btn.style.color     = this.isShuffle ? 'var(--clr-secondary)' : '';
        }
        Utils.showToast(`Shuffle: ${this.isShuffle ? 'ON' : 'OFF'}`, 'info');
    }

    _toggleRepeat() {
        this.isRepeat = !this.isRepeat;
        const btn = document.getElementById('btn-repeat');
        if (btn) {
            btn.style.opacity = this.isRepeat ? '1' : '0.35';
            btn.style.color   = this.isRepeat ? 'var(--clr-primary)' : '';
        }
        Utils.showToast(`Repeat: ${this.isRepeat ? 'ON' : 'OFF'}`, 'info');
    }

    // ─────────────────────────────────────────────────────
    //  PLAYLIST MANAGEMENT
    // ─────────────────────────────────────────────────────
    removeTrack(idx) {
        const track = this.playlist[idx];
        if (!track) return;

        // Revoke blob URLs to free memory
        URL.revokeObjectURL(track.url);
        if (track.cover) URL.revokeObjectURL(track.cover);

        this.playlist.splice(idx, 1);

        if (this.currentIdx === idx) {
            this.audio.pause();
            this.audio.src = '';
            this.currentIdx = -1;
            this._resetUI();
        } else if (this.currentIdx > idx) {
            this.currentIdx--;
        }

        this._renderPlaylist();
        this._updateTrackCount();
    }

    clearPlaylist() {
        this.audio.pause();
        this.audio.src = '';
        this.playlist.forEach(t => {
            URL.revokeObjectURL(t.url);
            if (t.cover) URL.revokeObjectURL(t.cover);
        });
        this.playlist    = [];
        this.currentIdx  = -1;
        this.isPlaying   = false;
        this._resetUI();
        this._renderPlaylist();
        this._updateTrackCount();
        Utils.showToast('Playlist cleared', 'info');
    }

    // ─────────────────────────────────────────────────────
    //  MEDIA SESSION API  (CORRECT USE: WRITE to OS, not read)
    //  Exposes controls to Android notification bar & headset buttons
    // ─────────────────────────────────────────────────────
    _setupMediaSession() {
        if (!('mediaSession' in navigator)) return;

        const ms = navigator.mediaSession;

        const safe = (action, fn) => {
            try { ms.setActionHandler(action, fn); } catch { /* not supported */ }
        };

        safe('play',          () => this.playPause());
        safe('pause',         () => this.playPause());
        safe('previoustrack', () => this.previous());
        safe('nexttrack',     () => this.next());
        safe('stop',          () => { this.audio.pause(); this.audio.currentTime = 0; });
    }

    _updateMediaSessionMeta() {
        if (!('mediaSession' in navigator) || this.currentIdx < 0) return;
        const t = this.playlist[this.currentIdx];
        if (!t) return;

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title : t.title,
                artist: t.artist,
                album : t.album,
                artwork: t.cover
                    ? [{ src: t.cover, sizes: '256x256', type: 'image/jpeg' }]
                    : []
            });
        } catch { /* ignore */ }
    }

    // ─────────────────────────────────────────────────────
    //  RENDER FUNCTIONS
    // ─────────────────────────────────────────────────────
    _renderMeta(track) {
        Utils.setEl('track-title',  track.title);
        Utils.setEl('track-artist', track.artist);
        Utils.setEl('track-album',  track.album);

        // Album art
        const imgEl         = document.getElementById('cover-img');
        const imgWrap       = document.getElementById('album-art-img');
        const placeholder   = document.getElementById('album-art-placeholder');

        if (track.cover && imgEl) {
            imgEl.src = track.cover;
            if (imgWrap)     imgWrap.style.display     = 'block';
            if (placeholder) placeholder.style.display = 'none';
        } else {
            if (imgWrap)     imgWrap.style.display     = 'none';
            if (placeholder) placeholder.style.display = 'flex';
        }
    }

    _renderPlayBtn() {
        const playIco  = document.querySelector('#btn-play-pause .play-icon');
        const pauseIco = document.querySelector('#btn-play-pause .pause-icon');
        if (playIco)  playIco.style.display  = this.isPlaying ? 'none'  : 'block';
        if (pauseIco) pauseIco.style.display = this.isPlaying ? 'block' : 'none';
    }

    _renderProgress() {
        if (!this.audio || isNaN(this.audio.duration) || this.audio.duration === 0) return;
        const pct  = this.audio.currentTime / this.audio.duration;
        const fill = document.getElementById('progress-fill');
        const cur  = document.getElementById('track-current');
        if (fill) fill.style.width   = `${(pct * 100).toFixed(1)}%`;
        if (cur)  cur.textContent    = this._fmtTime(this.audio.currentTime);
    }

    _renderPlaylist() {
        const container = document.getElementById('playlist-items');
        if (!container) return;

        if (!this.playlist.length) {
            container.innerHTML = `
                <div class="playlist-empty">
                    <p>No tracks loaded</p>
                    <p class="sub">Tap 📁 Load Files to add music</p>
                </div>`;
            return;
        }

        container.innerHTML = this.playlist.map((t, i) => `
            <div class="playlist-item ${i === this.currentIdx ? 'pl-active' : ''}" data-idx="${i}">
                <span class="pl-num">${i === this.currentIdx
                    ? '<span class="pl-playing-dot">▶</span>'
                    : (i + 1)}</span>
                <div class="pl-info">
                    <div class="pl-title">${this._esc(t.title)}</div>
                    <div class="pl-artist">${this._esc(t.artist)}</div>
                </div>
                <button class="pl-remove-btn" data-idx="${i}" title="Remove">✕</button>
            </div>`
        ).join('');

        // Play on click
        container.querySelectorAll('.playlist-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.pl-remove-btn')) return;
                const idx = +el.dataset.idx;
                this._playIndex(idx);
            });
        });

        // Remove button
        container.querySelectorAll('.pl-remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeTrack(+btn.dataset.idx);
            });
        });
    }

    _updateTrackCount() {
        const label = this.playlist.length === 1 ? '1 track' : `${this.playlist.length} tracks`;
        Utils.setEl('playlist-count-label', label);
    }

    _resetUI() {
        Utils.setEl('track-title',  'No file loaded');
        Utils.setEl('track-artist', '--');
        Utils.setEl('track-album',  '--');
        Utils.setEl('track-current', '0:00');
        Utils.setEl('track-total',   '0:00');
        const fill = document.getElementById('progress-fill');
        if (fill) fill.style.width = '0%';
        const imgWrap     = document.getElementById('album-art-img');
        const placeholder = document.getElementById('album-art-placeholder');
        if (imgWrap)     imgWrap.style.display     = 'none';
        if (placeholder) placeholder.style.display = 'flex';
        this.isPlaying = false;
        this._renderPlayBtn();
    }

    _esc(str) {
        return String(str)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    _fmtTime(secs) {
        if (!secs || isNaN(secs) || !isFinite(secs)) return '0:00';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    // ─────────────────────────────────────────────────────
    //  UI SETUP
    // ─────────────────────────────────────────────────────
    _setupUI() {
        // File input
        const fileInput = document.getElementById('media-file-input');
        fileInput?.addEventListener('change', (e) => {
            this._loadFiles(e.target.files);
            e.target.value = ''; // allow reselecting same files
        });

        // Load files button
        document.getElementById('media-load-btn')
            ?.addEventListener('click', () =>
                document.getElementById('media-file-input')?.click()
            );

        // Drag and drop zone
        const dropZone = document.getElementById('media-drop-zone');
        if (dropZone) {
            ['dragenter','dragover'].forEach(ev =>
                dropZone.addEventListener(ev, (e) => {
                    e.preventDefault();
                    dropZone.classList.add('drag-over');
                })
            );
            ['dragleave','dragend'].forEach(ev =>
                dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over'))
            );
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
                this._loadFiles(e.dataTransfer.files);
            });
        }

        // Controls
        document.getElementById('btn-play-pause')
            ?.addEventListener('click', () => this.playPause());
        document.getElementById('btn-prev')
            ?.addEventListener('click', () => this.previous());
        document.getElementById('btn-next')
            ?.addEventListener('click', () => this.next());
        document.getElementById('btn-shuffle')
            ?.addEventListener('click', () => this._toggleShuffle());
        document.getElementById('btn-repeat')
            ?.addEventListener('click', () => this._toggleRepeat());
        document.getElementById('btn-clear-playlist')
            ?.addEventListener('click', () => {
                if (this.playlist.length && confirm('Clear all tracks?'))
                    this.clearPlaylist();
            });

        // Progress bar — click to seek
        const progressClick = document.getElementById('progress-bar-click');
        if (progressClick) {
            progressClick.style.cursor = 'pointer';
            progressClick.addEventListener('click', (e) => {
                if (!this.audio || isNaN(this.audio.duration)) return;
                const rect = progressClick.getBoundingClientRect();
                const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                this.audio.currentTime = pct * this.audio.duration;
            });
        }

        // Volume
        const vol = document.getElementById('volume-slider');
        if (vol) {
            vol.value = Math.round(this.volume * 100);
            vol.addEventListener('input', () => this.setVolume(+vol.value / 100));
        }

        // Shuffle/repeat initial opacity
        ['btn-shuffle','btn-repeat'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.opacity = '0.35';
        });
    }

    // ─────────────────────────────────────────────────────
    //  CLEANUP
    // ─────────────────────────────────────────────────────
    destroy() {
        clearInterval(this._syncMetaT);
        if (this.audio) { this.audio.pause(); this.audio.src = ''; }
        this.playlist.forEach(t => {
            URL.revokeObjectURL(t.url);
            if (t.cover) URL.revokeObjectURL(t.cover);
        });
    }
}

/* ── Bootstrap ─────────────────────────────────────────── */
window.mediaModule = new MediaModule();
console.log('[Media] Ready ✓');

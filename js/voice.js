/**
 * MotoDash — voice.js
 * Voice Assistant: Web Speech API recognition + SpeechSynthesis.
 * Supports navigation, map control, media, settings commands.
 */

'use strict';

class VoiceModule {
    constructor() {
        this.isSupported  = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
        this.synth        = window.speechSynthesis;
        this.recognition  = null;
        this.isListening  = false;
        this.language     = Utils.Storage.get('voice_language', 'en-US');

        this._commands    = this._buildCommands();

        this._init();
        console.log('[Voice] Initialized, supported:', this.isSupported);
    }

    // ─────────────────────────────────────────────────────
    //  INIT
    // ─────────────────────────────────────────────────────
    _init() {
        if (this.isSupported) this._setupRecognition();
        this._setupUI();
        this._subscribeEvents();
    }

    _setupRecognition() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const r  = new SR();
        r.lang              = this.language;
        r.continuous        = false;
        r.interimResults    = true;
        r.maxAlternatives   = 3;

        r.onresult = (e) => {
            const result     = e.results[e.results.length - 1];
            const transcript = result[0].transcript.trim().toLowerCase();
            const isFinal    = result.isFinal;
            this._updateTranscript(transcript, isFinal);
            if (isFinal) this._process(transcript);
        };

        r.onerror = (e) => {
            if (e.error !== 'no-speech' && e.error !== 'aborted') {
                Utils.showToast(`Voice: ${e.error}`, 'error');
            }
            this._setListening(false);
        };

        r.onend = () => this._setListening(false);

        this.recognition = r;
    }

    // ─────────────────────────────────────────────────────
    //  COMMAND DEFINITIONS
    // ─────────────────────────────────────────────────────
    _buildCommands() {
        return [
            /* Navigation */
            {
                patterns: [/^navigate to (.+)$/, /^go to (.+)$/, /^directions to (.+)$/],
                fn: (m) => {
                    const dest = m[1].trim();
                    this.speak(`Navigating to ${dest}`);
                    Utils.EventBus.emit('navigate:to',  { destination: dest });
                    Utils.EventBus.emit('panel:switch', { panel: 'maps' });
                }
            },
            /* Maps */
            {
                patterns: [/open maps?/, /show maps?/, /switch to maps?/],
                fn: () => {
                    Utils.EventBus.emit('panel:switch', { panel: 'maps' });
                    this.speak('Opening maps');
                }
            },
            /* Centre map */
            {
                patterns: [/current location/, /where am i/, /center map/, /centre map/, /my location/],
                fn: () => {
                    Utils.EventBus.emit('map:center', {});
                    this.speak('Centering on your current location');
                }
            },
            /* Speed */
            {
                patterns: [/show speed/, /what.?s my speed/, /how fast am i/, /current speed/],
                fn: () => {
                    const spd = window.speedometer?.targetSpeed ?? 0;
                    this.speak(`Your current speed is ${spd} kilometers per hour`);
                }
            },
            /* Zoom */
            {
                patterns: [/zoom in/],
                fn: () => { Utils.EventBus.emit('map:zoom-in', {}); this.speak('Zooming in'); }
            },
            {
                patterns: [/zoom out/],
                fn: () => { Utils.EventBus.emit('map:zoom-out', {}); this.speak('Zooming out'); }
            },
            /* Stop nav */
            {
                patterns: [/stop navigation/, /cancel navigation/, /end navigation/, /stop route/],
                fn: () => { Utils.EventBus.emit('nav:stop', {}); this.speak('Navigation stopped'); }
            },
            /* Settings */
            {
                patterns: [/open settings?/, /settings?/],
                fn: () => {
                    Utils.EventBus.emit('panel:switch', { panel: 'settings' });
                    this.speak('Opening settings');
                }
            },
            /* Bluetooth */
            {
                patterns: [/open bluetooth/, /bluetooth settings?/],
                fn: () => {
                    Utils.EventBus.emit('panel:switch', { panel: 'bluetooth' });
                    this.speak('Opening Bluetooth');
                }
            },
            /* Media */
            {
                patterns: [/play music/, /^play$/],
                fn: () => { window.mediaModule?.playPause(); this.speak('Playing'); }
            },
            {
                patterns: [/pause music/, /^pause$/],
                fn: () => { window.mediaModule?.playPause(); this.speak('Paused'); }
            },
            {
                patterns: [/next (track|song)/, /^next$/],
                fn: () => { window.mediaModule?.next(); this.speak('Next track'); }
            },
            {
                patterns: [/previous (track|song)/, /^previous$/, /^back$/],
                fn: () => { window.mediaModule?.previous(); this.speak('Previous track'); }
            },
            /* Open music */
            {
                patterns: [/open music/, /music panel/],
                fn: () => {
                    Utils.EventBus.emit('panel:switch', { panel: 'music' });
                    this.speak('Opening music');
                }
            }
        ];
    }

    // ─────────────────────────────────────────────────────
    //  PROCESS TRANSCRIPT
    // ─────────────────────────────────────────────────────
    _process(transcript) {
        console.log('[Voice] Recognized:', transcript);

        for (const cmd of this._commands) {
            for (const pattern of cmd.patterns) {
                const m = transcript.match(pattern);
                if (m) { cmd.fn(m); return; }
            }
        }

        this.speak("Command not recognized. Try: navigate to, show speed, or zoom in.");
        Utils.showToast('Command not recognized', 'warning');
    }

    // ─────────────────────────────────────────────────────
    //  CONTROL
    // ─────────────────────────────────────────────────────
    startListening() {
        if (!this.isSupported) {
            Utils.showToast('Voice recognition not supported on this browser', 'error');
            return;
        }
        try {
            this.recognition.lang = this.language;
            this.recognition.start();
            this._setListening(true);
            Utils.showToast('Listening…', 'info');
        } catch (e) {
            console.error('[Voice] Start error:', e);
        }
    }

    stopListening() {
        this.recognition?.stop();
        this._setListening(false);
    }

    toggleListening() {
        this.isListening ? this.stopListening() : this.startListening();
    }

    speak(text) {
        if (!this.synth || !text) return;
        this.synth.cancel();
        const u    = new SpeechSynthesisUtterance(text);
        u.lang     = this.language;
        u.rate     = 1.05;
        u.pitch    = 1.0;
        u.volume   = 1.0;
        this.synth.speak(u);
    }

    setLanguage(lang) {
        this.language = lang;
        Utils.Storage.set('voice_language', lang);
        if (this.recognition) this.recognition.lang = lang;
    }

    // ─────────────────────────────────────────────────────
    //  UI STATE
    // ─────────────────────────────────────────────────────
    _setListening(val) {
        this.isListening = val;

        const orb     = document.getElementById('voice-orb');
        const status  = document.getElementById('voice-status-text');
        const btnText = document.getElementById('voice-btn-text');

        orb?.classList.toggle('listening', val);
        if (status)  status.textContent  = val ? 'Listening…'      : 'Tap to activate';
        if (btnText) btnText.textContent = val ? '🔴 STOP LISTENING' : '🎤 START LISTENING';
    }

    _updateTranscript(text, isFinal) {
        const el = document.getElementById('transcript-text');
        if (!el) return;
        el.textContent  = text || '--';
        el.style.opacity = isFinal ? '1' : '0.5';
    }

    // ─────────────────────────────────────────────────────
    //  UI SETUP
    // ─────────────────────────────────────────────────────
    _setupUI() {
        document.getElementById('voice-toggle-btn')
            ?.addEventListener('click', () => this.toggleListening());

        const langSel = document.getElementById('voice-language');
        if (langSel) {
            langSel.value = this.language;
            langSel.addEventListener('change', () => this.setLanguage(langSel.value));
        }

        /* If voice not supported, dim the UI */
        if (!this.isSupported) {
            const orb = document.getElementById('voice-orb');
            if (orb) orb.style.opacity = '0.3';
            Utils.setEl('voice-status-text', 'Not supported on this browser');
            const btn = document.getElementById('voice-toggle-btn');
            if (btn) btn.disabled = true;
        }
    }

    // ─────────────────────────────────────────────────────
    //  EVENT BUS
    // ─────────────────────────────────────────────────────
    _subscribeEvents() {
        /* Navigation module can trigger speech announcements */
        Utils.EventBus.on('voice:announce', ({ text }) => { if (text) this.speak(text); });
    }
}

/* ── Bootstrap ─────────────────────────────────────────── */
window.voiceModule = new VoiceModule();
console.log('[Voice] Ready ✓');

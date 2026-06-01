// ============================================
// Audio System (Web Audio API)
// Placeholder hooks for future asset integration
// ============================================

let audioCtx = null;
let masterGain = null;
let sfxGain = null;
let initialized = false;

// ---- Mixer settings (persisted to localStorage) ----
// musicVolume / sfxVolume are 0..1 slider levels feeding the music/sfx gain
// nodes; muted gates both to silence without losing the slider positions.
const AUDIO_SETTINGS_KEY = 'zb_audio_settings';
let musicVolume = 0.5;
let sfxVolume = 0.7;
let muted = false;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function loadAudioSettings() {
    try {
        const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (typeof s.musicVolume === 'number') musicVolume = clamp01(s.musicVolume);
        if (typeof s.sfxVolume === 'number') sfxVolume = clamp01(s.sfxVolume);
        if (typeof s.muted === 'boolean') muted = s.muted;
    } catch (e) {
        // Corrupt/unavailable storage — keep defaults.
    }
}

function saveAudioSettings() {
    try {
        localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ musicVolume, sfxVolume, muted }));
    } catch (e) {
        // Storage unavailable (private mode etc.) — settings just won't persist.
    }
}

// Push the current settings onto the audio outputs.
function applyVolumes() {
    if (sfxGain) sfxGain.gain.value = muted ? 0 : sfxVolume;
    // Music plays through a plain <audio> element (NOT the Web Audio graph), so
    // its level is the element's own .volume. Routing music through Web Audio
    // is fragile across the context's suspended/resumed states; a bare element
    // plays reliably the moment the browser's autoplay gate opens.
    if (musicEl) musicEl.volume = muted ? 0 : musicVolume;
}

// Sound definitions (ready for asset swap)
const SOUNDS = {
    weapon_fire: { frequency: 200, duration: 0.08, type: 'square', gain: 0.15 },
    weapon_fire_heavy: { frequency: 120, duration: 0.15, type: 'sawtooth', gain: 0.2 },
    weapon_laser: { frequency: 800, duration: 0.03, type: 'sine', gain: 0.1 },
    weapon_tesla: { frequency: 400, duration: 0.1, type: 'square', gain: 0.12 },
    hit_zombie: { frequency: 150, duration: 0.06, type: 'triangle', gain: 0.12 },
    enemy_death: { frequency: 100, duration: 0.2, type: 'sawtooth', gain: 0.15 },
    combo_ding: { frequency: 1200, duration: 0.08, type: 'sine', gain: 0.1 },
    combo_break: { frequency: 200, duration: 0.15, type: 'sawtooth', gain: 0.08 },
    player_hurt: { frequency: 80, duration: 0.12, type: 'square', gain: 0.18 },
    player_dash: { frequency: 600, duration: 0.1, type: 'sine', gain: 0.08 },
    weapon_switch: { frequency: 500, duration: 0.05, type: 'sine', gain: 0.06 },
    weapon_reload: { frequency: 300, duration: 0.3, type: 'triangle', gain: 0.08 },
    wave_start: { frequency: 400, duration: 0.4, type: 'square', gain: 0.1 },
    boss_appear: { frequency: 60, duration: 0.8, type: 'sawtooth', gain: 0.2 },
    game_over: { frequency: 150, duration: 1.0, type: 'sawtooth', gain: 0.15 },
};

function initAudio() {
    if (initialized) return;

    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.5;
        masterGain.connect(audioCtx.destination);

        sfxGain = audioCtx.createGain();
        sfxGain.gain.value = 0.7;
        sfxGain.connect(masterGain);

        loadAudioSettings();
        applyVolumes();

        initialized = true;
    } catch (e) {
        console.warn('Web Audio API not available:', e);
    }
}

function resumeAudio() {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// Play a procedural sound effect
function playSFX(soundName) {
    if (!initialized || !audioCtx) return;

    const def = SOUNDS[soundName];
    if (!def) return;

    try {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        osc.type = def.type;
        osc.frequency.setValueAtTime(def.frequency, audioCtx.currentTime);

        // Frequency sweep for some effects
        if (soundName === 'enemy_death') {
            osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + def.duration);
        } else if (soundName === 'combo_ding') {
            osc.frequency.setValueAtTime(def.frequency + Math.random() * 400, audioCtx.currentTime);
        } else if (soundName === 'boss_appear') {
            osc.frequency.exponentialRampToValueAtTime(30, audioCtx.currentTime + def.duration);
        }

        gainNode.gain.setValueAtTime(def.gain, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + def.duration);

        osc.connect(gainNode);
        gainNode.connect(sfxGain);

        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + def.duration + 0.01);
    } catch (e) {
        // Ignore audio errors
    }
}

// Procedural zombie growl — layered detuned saw oscillators with an LFO "warble"
// and a closing lowpass sweep for a guttural, organic snarl. Pitch is randomized
// per call so repeats from the horde don't sound mechanical.
//   opts.volume     — 0..1, attenuates the growl (used for distance falloff)
//   opts.aggressive — shorter, higher, sharper snarl for attack lunges
function playGrowl(opts = {}) {
    if (!initialized || !audioCtx) return;

    const volume = Math.max(0, Math.min(1, opts.volume ?? 1));
    if (volume <= 0.01) return;
    const aggressive = !!opts.aggressive;

    try {
        const now = audioCtx.currentTime;
        const duration = aggressive ? 0.32 : 0.45 + Math.random() * 0.3;
        // Low guttural base pitch, randomized per growl.
        const base = (aggressive ? 110 : 70) + Math.random() * 40;
        const peak = (aggressive ? 0.32 : 0.26) * volume;

        // Output envelope (quick attack, decay over the duration) + distance volume.
        const out = audioCtx.createGain();
        out.gain.setValueAtTime(0.0001, now);
        out.gain.exponentialRampToValueAtTime(peak, now + 0.05);
        out.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        // Lowpass keeps it muffled/throaty, sweeping down for the growl tail-off.
        const lp = audioCtx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(aggressive ? 1400 : 900, now);
        lp.frequency.exponentialRampToValueAtTime(300, now + duration);
        lp.Q.value = 6;

        // Two slightly detuned saw oscillators for a thick, dissonant body, each
        // sliding down in pitch for the classic growl fall-off.
        [-7, 7].forEach((detune) => {
            const osc = audioCtx.createOscillator();
            osc.type = 'sawtooth';
            osc.detune.value = detune;
            osc.frequency.setValueAtTime(base * (aggressive ? 1.4 : 1.2), now);
            osc.frequency.exponentialRampToValueAtTime(base * 0.6, now + duration);
            osc.connect(lp);
            osc.start(now);
            osc.stop(now + duration + 0.02);
        });

        // LFO warble modulates the output gain to create the rough "rrrr".
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        lfo.type = 'sine';
        lfo.frequency.value = (aggressive ? 22 : 14) + Math.random() * 8;
        lfoGain.gain.value = peak * 0.5;
        lfo.connect(lfoGain);
        lfoGain.connect(out.gain);
        lfo.start(now);
        lfo.stop(now + duration + 0.02);

        lp.connect(out);
        out.connect(sfxGain);
    } catch (e) {
        // Ignore audio errors
    }
}

// Music playlist — the tracks play one after the other and loop back to the
// first after the last. Played via a plain <audio> element; the music-volume
// setting (and mute) drives the element's .volume in applyVolumes().
const MUSIC_TRACKS = [
    'assets/Music/ZombieBlaster_1.mp3',
    'assets/Music/ZombieBlaster_2.mp3',
];
let musicEl = null;
let musicTrackIndex = 0;
let musicPlaying = false;

// Lazily create the shared <audio> element and its playlist auto-advance.
function ensureMusicEl() {
    if (musicEl) return;
    musicEl = new Audio();
    musicEl.preload = 'auto';

    // Advance through the playlist; wrap to the first track after the last
    // so the soundtrack loops indefinitely.
    musicEl.addEventListener('ended', () => {
        musicTrackIndex = (musicTrackIndex + 1) % MUSIC_TRACKS.length;
        musicEl.src = MUSIC_TRACKS[musicTrackIndex];
        if (musicPlaying) musicEl.play().catch(() => {});
    });

    musicEl.src = MUSIC_TRACKS[musicTrackIndex];
    applyVolumes();
}

// Attempt playback of the current track. Calling play() on an already-playing
// element is a harmless no-op (it does NOT restart the track), while a
// pre-gesture attempt rejects asynchronously — so not gating on a flag here
// means the first real user gesture reliably starts playback even if an earlier
// blocked attempt's rejection hasn't landed yet.
function playCurrentTrack() {
    musicPlaying = true;
    const p = musicEl.play();
    if (p) p.catch(() => {});
}

function startMusic() {
    ensureMusicEl();
    playCurrentTrack();
}

// Switch to the next track in the playlist (restarting it from the top) and
// play it. Used when starting a new game so gameplay gets a different track
// than the menu.
function nextMusicTrack() {
    ensureMusicEl();
    musicTrackIndex = (musicTrackIndex + 1) % MUSIC_TRACKS.length;
    musicEl.src = MUSIC_TRACKS[musicTrackIndex];
    playCurrentTrack();
}

function stopMusic() {
    musicPlaying = false;
    if (musicEl) musicEl.pause();
}

// ---- Mixer controls (wired to the settings UI) ----
function setMusicVolume(vol) {
    musicVolume = clamp01(vol);
    applyVolumes();
    saveAudioSettings();
}

function setSfxVolume(vol) {
    sfxVolume = clamp01(vol);
    applyVolumes();
    saveAudioSettings();
}

function setMuted(value) {
    muted = !!value;
    applyVolumes();
    saveAudioSettings();
}

function toggleMute() {
    setMuted(!muted);
    return muted;
}

function getAudioSettings() {
    return { musicVolume, sfxVolume, muted };
}

function setMasterVolume(vol) {
    if (masterGain) masterGain.gain.value = clamp01(vol);
}

export {
    initAudio, resumeAudio,
    playSFX, playGrowl, SOUNDS,
    startMusic, stopMusic, nextMusicTrack,
    setMusicVolume, setSfxVolume, setMuted, toggleMute, getAudioSettings,
    setMasterVolume,
};

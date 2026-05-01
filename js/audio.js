// ============================================
// Audio System (Web Audio API)
// Placeholder hooks for future asset integration
// ============================================

let audioCtx = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;
let initialized = false;

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

        musicGain = audioCtx.createGain();
        musicGain.gain.value = 0.3;
        musicGain.connect(masterGain);

        sfxGain = audioCtx.createGain();
        sfxGain.gain.value = 0.7;
        sfxGain.connect(masterGain);

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

// Simple background music (procedural arcade loop)
let musicOscillators = [];
let musicPlaying = false;
let musicInterval = null;

function startMusic() {
    if (!initialized || musicPlaying) return;
    musicPlaying = true;

    // Simple bass loop
    const bassNotes = [60, 60, 72, 60, 55, 55, 67, 55];
    let noteIndex = 0;

    musicInterval = setInterval(() => {
        if (!musicPlaying || !audioCtx) {
            clearInterval(musicInterval);
            return;
        }

        try {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(bassNotes[noteIndex], audioCtx.currentTime);
            gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
            osc.connect(gain);
            gain.connect(musicGain);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.22);

            noteIndex = (noteIndex + 1) % bassNotes.length;
        } catch (e) {
            // Ignore
        }
    }, 200); // ~150 BPM
}

function stopMusic() {
    musicPlaying = false;
    if (musicInterval) {
        clearInterval(musicInterval);
        musicInterval = null;
    }
}

function setMasterVolume(vol) {
    if (masterGain) masterGain.gain.value = Math.max(0, Math.min(1, vol));
}

export {
    initAudio, resumeAudio,
    playSFX, SOUNDS,
    startMusic, stopMusic,
    setMasterVolume,
};

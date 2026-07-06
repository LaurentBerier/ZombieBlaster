// AudioManager — the Zombie Blaster audio on the new engine, ported from the flat audio.js.
// Procedural Web-Audio SFX (no sound files — each effect is a shaped oscillator) + a 2-track
// music playlist played through a plain <audio> element (reliable across the autoplay gate).
// A single instance lives on the 'Audio' entity; gameplay components look it up and call
// Play('name') / Growl(). Mixer settings persist to localStorage under zb_audio_settings.

import Component from '../../Component.js'

const AUDIO_SETTINGS_KEY = 'zb_audio_settings'
const clamp01 = (v) => Math.max(0, Math.min(1, v))

// Procedural SFX table: {frequency, duration, type, gain}. Some get a frequency sweep (below).
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
}

const MUSIC_TRACKS = [
  'assets/Music/ZombieBlaster_1.mp3',
  'assets/Music/ZombieBlaster_2.mp3',
]

export default class AudioManager extends Component {
  constructor() {
    super()
    this.name = 'AudioManager'
    this.audioCtx = null
    this.masterGain = null
    this.sfxGain = null
    this.ready = false

    this.musicVolume = 0.5
    this.sfxVolume = 0.7
    this.muted = false

    this.musicEl = null
    this.musicTrackIndex = 0
    this.musicPlaying = false
  }

  Initialize() {
    this.loadSettings()
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      this.audioCtx = new Ctx()
      this.masterGain = this.audioCtx.createGain()
      this.masterGain.gain.value = 0.5
      this.masterGain.connect(this.audioCtx.destination)
      this.sfxGain = this.audioCtx.createGain()
      this.sfxGain.gain.value = 0.7
      this.sfxGain.connect(this.masterGain)
      this.applyVolumes()
      this.ready = true
    } catch (e) {
      console.warn('[audio] Web Audio unavailable:', e.message)
    }
  }

  // The AudioContext starts suspended until a user gesture (the START click) resumes it.
  Resume() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume()
  }

  // ---- Settings ----

  loadSettings() {
    try {
      const raw = window.localStorage.getItem(AUDIO_SETTINGS_KEY)
      if (!raw) return
      const s = JSON.parse(raw)
      if (typeof s.musicVolume === 'number') this.musicVolume = clamp01(s.musicVolume)
      if (typeof s.sfxVolume === 'number') this.sfxVolume = clamp01(s.sfxVolume)
      if (typeof s.muted === 'boolean') this.muted = s.muted
    } catch (e) { /* keep defaults */ }
  }

  saveSettings() {
    try {
      window.localStorage.setItem(AUDIO_SETTINGS_KEY,
        JSON.stringify({ musicVolume: this.musicVolume, sfxVolume: this.sfxVolume, muted: this.muted }))
    } catch (e) { /* private mode */ }
  }

  applyVolumes() {
    if (this.sfxGain) this.sfxGain.gain.value = this.muted ? 0 : this.sfxVolume
    if (this.musicEl) this.musicEl.volume = this.muted ? 0 : this.musicVolume
  }

  setMusicVolume(v) { this.musicVolume = clamp01(v); this.applyVolumes(); this.saveSettings() }
  setSfxVolume(v) { this.sfxVolume = clamp01(v); this.applyVolumes(); this.saveSettings() }
  setMuted(v) { this.muted = !!v; this.applyVolumes(); this.saveSettings() }
  toggleMute() { this.setMuted(!this.muted); return this.muted }
  getSettings() { return { musicVolume: this.musicVolume, sfxVolume: this.sfxVolume, muted: this.muted } }

  // ---- SFX ----

  Play(name) {
    if (!this.ready || !this.audioCtx) return
    const def = SOUNDS[name]
    if (!def) return
    try {
      const t = this.audioCtx.currentTime
      const osc = this.audioCtx.createOscillator()
      const gain = this.audioCtx.createGain()
      osc.type = def.type
      osc.frequency.setValueAtTime(def.frequency, t)
      if (name === 'enemy_death') osc.frequency.exponentialRampToValueAtTime(40, t + def.duration)
      else if (name === 'combo_ding') osc.frequency.setValueAtTime(def.frequency + Math.random() * 400, t)
      else if (name === 'boss_appear') osc.frequency.exponentialRampToValueAtTime(30, t + def.duration)
      gain.gain.setValueAtTime(def.gain, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + def.duration)
      osc.connect(gain); gain.connect(this.sfxGain)
      osc.start(t); osc.stop(t + def.duration + 0.01)
    } catch (e) { /* ignore */ }
  }

  // Procedural zombie growl — two detuned saws + LFO warble + lowpass sweep.
  //   opts.volume (0..1 distance falloff), opts.aggressive (attack lunge)
  Growl(opts = {}) {
    if (!this.ready || !this.audioCtx) return
    const volume = clamp01(opts.volume ?? 1)
    if (volume <= 0.01) return
    const aggressive = !!opts.aggressive
    try {
      const now = this.audioCtx.currentTime
      const duration = aggressive ? 0.32 : 0.45 + Math.random() * 0.3
      const base = (aggressive ? 110 : 70) + Math.random() * 40
      const peak = (aggressive ? 0.32 : 0.26) * volume

      const out = this.audioCtx.createGain()
      out.gain.setValueAtTime(0.0001, now)
      out.gain.exponentialRampToValueAtTime(peak, now + 0.05)
      out.gain.exponentialRampToValueAtTime(0.0001, now + duration)

      const lp = this.audioCtx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(aggressive ? 1400 : 900, now)
      lp.frequency.exponentialRampToValueAtTime(300, now + duration)
      lp.Q.value = 6

      ;[-7, 7].forEach((detune) => {
        const osc = this.audioCtx.createOscillator()
        osc.type = 'sawtooth'
        osc.detune.value = detune
        osc.frequency.setValueAtTime(base * (aggressive ? 1.4 : 1.2), now)
        osc.frequency.exponentialRampToValueAtTime(base * 0.6, now + duration)
        osc.connect(lp)
        osc.start(now); osc.stop(now + duration + 0.02)
      })

      const lfo = this.audioCtx.createOscillator()
      const lfoGain = this.audioCtx.createGain()
      lfo.type = 'sine'
      lfo.frequency.value = (aggressive ? 22 : 14) + Math.random() * 8
      lfoGain.gain.value = peak * 0.5
      lfo.connect(lfoGain); lfoGain.connect(out.gain)
      lfo.start(now); lfo.stop(now + duration + 0.02)

      lp.connect(out); out.connect(this.sfxGain)
    } catch (e) { /* ignore */ }
  }

  // ---- Music (plain <audio> playlist, auto-advancing + looping) ----

  ensureMusicEl() {
    if (this.musicEl) return
    this.musicEl = new Audio()
    this.musicEl.preload = 'auto'
    this.musicEl.addEventListener('ended', () => {
      this.musicTrackIndex = (this.musicTrackIndex + 1) % MUSIC_TRACKS.length
      this.musicEl.src = MUSIC_TRACKS[this.musicTrackIndex]
      if (this.musicPlaying) this.musicEl.play().catch(() => {})
    })
    this.musicEl.src = MUSIC_TRACKS[this.musicTrackIndex]
    this.applyVolumes()
  }

  playCurrentTrack() {
    this.musicPlaying = true
    const p = this.musicEl.play()
    if (p) p.catch(() => {})
  }

  StartMusic() { this.ensureMusicEl(); this.playCurrentTrack() }

  // Advance to the next track (used at game start so gameplay differs from the menu).
  NextMusicTrack() {
    this.ensureMusicEl()
    this.musicTrackIndex = (this.musicTrackIndex + 1) % MUSIC_TRACKS.length
    this.musicEl.src = MUSIC_TRACKS[this.musicTrackIndex]
    this.playCurrentTrack()
  }

  StopMusic() {
    this.musicPlaying = false
    if (this.musicEl) this.musicEl.pause()
  }
}

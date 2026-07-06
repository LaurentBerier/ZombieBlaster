// UIManager — the Zombie Blaster HUD on the new engine. Health/ammo/weapon are PUSHED by
// PlayerHealth / WeaponManager (event-driven); score/combo/wave are PULLED from the
// GameDirector each frame (like the original ui.js updateHUD). Also owns the wave-announce
// banner and the game-over screen population. Title/onboarding screens are driven by entry.js.

import Component from '../../Component.js'

export default class UIManager extends Component {
  constructor() {
    super()
    this.name = 'UIManager'
    this._score = -1
    this._wave = -1
    this._mult = -1
    this._waveTimer = 0
  }

  Initialize() {
    this.director = this.FindEntity('GameDirector')?.GetComponent('GameDirector') || null
    this.ShowHud()
    // Announce each wave as it starts (chain any existing callback).
    if (this.director) {
      const prev = this.director.onWaveStart
      this.director.onWaveStart = (n) => { prev && prev(n); this.AnnounceWave(n) }
    }
  }

  ShowHud() {
    const el = document.getElementById('hud')
    if (el) el.classList.remove('hidden')
  }

  // ---- Pushed by gameplay components ----

  SetAmmo(mag, rest) {
    const el = document.getElementById('ammo-count')
    if (el) el.innerText = `${mag}/${rest === Infinity ? '∞' : rest}`
  }

  SetWeaponName(name) {
    const el = document.getElementById('weapon-name')
    if (el) el.innerText = name
  }

  SetHealth(health) {
    const pct = Math.max(0, Math.min(100, health))
    const bar = document.getElementById('health-bar')
    const val = document.getElementById('health-value')
    if (bar) {
      bar.style.width = `${pct}%`
      // Colour thresholds inline (robust to CSS class naming): green → orange → red.
      bar.style.background = pct < 25 ? '#ff3131' : (pct < 50 ? '#ff9f1c' : '#7CFC00')
    }
    if (val) val.innerText = Math.round(health)
  }

  // Red screen vignette on taking a hit — snap on, fade out next frame (restarts on rapid hits).
  FlashDamage() {
    const el = document.getElementById('damage-overlay')
    if (!el) return
    el.classList.remove('hidden')
    el.style.transition = 'none'
    el.style.opacity = '0.85'
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.6s ease'
      el.style.opacity = '0'
    })
  }

  // The zombie crosshair is a fixed "+" mark; the engine's reticle-bloom feel is deferred.
  SetReticleSize() { /* no-op */ }

  // ---- Wave banner + game over ----

  AnnounceWave(n) {
    const box = document.getElementById('wave-announce')
    const txt = document.getElementById('wave-announce-text')
    if (!box) return
    if (txt) txt.innerText = `WAVE ${n}`
    box.classList.remove('hidden')
    this._waveTimer = 2.5
  }

  ShowGameOver(state) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v }
    set('final-score', (state.score || 0).toLocaleString())
    set('final-waves', Math.max(1, state.currentWave || 1))
    set('final-combo', 'x' + (state.maxComboMultiplier || 1))
    set('final-kills', state.totalKills || 0)
    set('gameover-high-score', (state.highScore || 0).toLocaleString())
    const nh = document.getElementById('new-high-score')
    if (nh) nh.classList.toggle('hidden', !state.isNewHigh)
    const go = document.getElementById('gameover-screen')
    if (go) go.classList.remove('hidden')
  }

  Update(dt) {
    if (this._waveTimer > 0) {
      this._waveTimer -= dt
      if (this._waveTimer <= 0) {
        const b = document.getElementById('wave-announce')
        if (b) b.classList.add('hidden')
      }
    }

    const d = this.director && this.director.state
    if (!d) return
    if (d.score !== this._score) {
      this._score = d.score
      const el = document.getElementById('hud-score')
      if (el) el.innerText = d.score.toLocaleString()
    }
    const wave = Math.max(1, d.currentWave)
    if (wave !== this._wave) {
      this._wave = wave
      const el = document.getElementById('hud-wave')
      if (el) el.innerText = wave
    }
    if (d.comboMultiplier !== this._mult) {
      this._mult = d.comboMultiplier
      const el = document.getElementById('combo-multiplier')
      if (el) el.innerText = 'x' + d.comboMultiplier
      const disp = document.getElementById('combo-display')
      if (disp) disp.style.opacity = d.comboMultiplier > 1 ? '1' : '0.4'
    }
  }
}

// GameDirector — the Zombie Blaster gameplay brain on the new engine, ported from the flat
// gameLogic.js (score/combo/high-score) + the enemies.js wave/spawn director. A single
// instance lives on the 'GameDirector' entity; it owns score + wave state, drives the
// ZombieSpawner wave-by-wave, tallies kills reported by the zombies, and ends the run when
// the player dies (waves are ENDLESS — death is the only game-over, faithful to the original).
//
// Coupling is event-light: ZombieController.Die() calls ReportKill(); PlayerHealth.TakeHit()
// calls OnPlayerDamaged(). The HUD (UIManager) reads this.state each frame.
//
// NOTE (M3 scope): only Zombie_1 is loaded, so waves spawn the regular zombie scaled by wave
// number; the boss / fast / tank / mega-boss types + their announce beats land in M4 when
// those enemy types + navmesh come in. The wave SIZE/CADENCE/scaling math is the real thing.

import Component from '../../Component.js'
import { activeZombies } from '../NPC/ZombieController.js'
import { statsFor, pickRegularType, bossTypeForWave } from '../NPC/enemyTypes.js'

const HIGH_SCORE_KEY = 'zombieBlasterHighScore'

// Combo: killStreak-based step multiplier, hard-reset after COMBO_WINDOW seconds with no kill.
const COMBO_WINDOW = 3.0
function multiplierForStreak(streak) {
  if (streak >= 20) return 8
  if (streak >= 15) return 5
  if (streak >= 10) return 4
  if (streak >= 5) return 3
  if (streak >= 3) return 2
  return 1
}

// Wave shape (from enemies.js startWave): horde size + spawn cadence scale with the wave.
const WAVE_DELAY = 3.0          // seconds between waves
const FIRST_WAVE_DELAY = 2.0
function regularToSpawn(wave) { return Math.min(5 + wave * 3, 40) }
function spawnInterval(wave) { return Math.max(0.3, 1.5 - wave * 0.08) }
// One wave-boss closes each wave (the original scaled to (wave-1) Zombie_4s — capped here so
// high waves stay fair; tune later).
const BOSSES_PER_WAVE = 1

export default class GameDirector extends Component {
  constructor() {
    super()
    this.name = 'GameDirector'

    this.state = {
      // Score / combo
      score: 0,
      highScore: 0,
      comboMultiplier: 1,
      maxComboMultiplier: 1,
      comboTimer: 0,
      killStreak: 0,
      maxKillStreak: 0,
      totalKills: 0,
      // Waves
      currentWave: 0,        // becomes 1 when the first wave starts
      waveActive: false,
      waveDelayTimer: FIRST_WAVE_DELAY,
      enemiesToSpawn: 0,
      enemiesSpawned: 0,
      enemiesRemaining: 0,
      regularCount: 0,       // horde size (grunts/fast/tank); bosses spawn once these are out
      bossCount: 0,
      bossType: null,
      spawnTimer: 0,
      spawnIntervalCur: 1.5,
      // Flow
      gameOver: false,
    }

    // Callbacks the HUD/audio can subscribe to (set by whoever wires them; all optional).
    this.onWaveStart = null      // (waveNumber) => void
    this.onKill = null           // (points, killStreak, comboMultiplier, worldPos) => void
    this.onGameOver = null       // (state) => void
  }

  Initialize() {
    this.state.highScore = this.loadHighScore()
    this.spawner = this.FindEntity('ZombieSpawner')?.GetComponent('ZombieSpawner') || null
    const player = this.FindEntity('Player')
    this.playerHealth = player ? player.GetComponent('PlayerHealth') : null
    this.audio = this.FindEntity('Audio')?.GetComponent('AudioManager') || null
  }

  loadHighScore() {
    try {
      const v = parseInt(window.localStorage.getItem(HIGH_SCORE_KEY) || '0', 10)
      return Number.isFinite(v) ? v : 0
    } catch (e) { return 0 }
  }

  saveHighScore() {
    const s = this.state
    if (s.score > s.highScore) {
      s.highScore = s.score
      try { window.localStorage.setItem(HIGH_SCORE_KEY, String(s.score)) } catch (e) { /* private mode */ }
      return true
    }
    return false
  }

  // ---- Kill / combo / score (ReportKill is the ONLY score source) ----

  // Called by ZombieController.Die(). scoreValue is the dead zombie's worth; worldPos is its
  // position (for the HUD combo pop / floating text).
  ReportKill(scoreValue = 100, worldPos = null) {
    const s = this.state
    if (s.gameOver) return 0

    s.killStreak++
    s.totalKills++
    s.maxKillStreak = Math.max(s.maxKillStreak, s.killStreak)
    s.comboTimer = COMBO_WINDOW
    s.comboMultiplier = multiplierForStreak(s.killStreak)
    s.maxComboMultiplier = Math.max(s.maxComboMultiplier, s.comboMultiplier)

    const points = Math.round(scoreValue * s.comboMultiplier)
    s.score += points

    // Wave bookkeeping.
    s.enemiesRemaining = Math.max(0, s.enemiesRemaining - 1)

    if (this.audio) { this.audio.Play('enemy_death'); this.audio.Play('combo_ding') }
    if (this.onKill) this.onKill(points, s.killStreak, s.comboMultiplier, worldPos)
    return points
  }

  // Taking damage bleeds the streak (gameLogic.onPlayerDamaged).
  OnPlayerDamaged() {
    const s = this.state
    s.killStreak = Math.max(0, s.killStreak - 2)
    if (s.killStreak < 3) s.comboMultiplier = 1
  }

  updateCombo(dt) {
    const s = this.state
    if (s.comboTimer > 0) {
      s.comboTimer -= dt
      if (s.comboTimer <= 0) { s.killStreak = 0; s.comboMultiplier = 1 }
    }
  }

  // ---- Waves ----

  startWave() {
    const s = this.state
    s.currentWave++
    s.regularCount = regularToSpawn(s.currentWave)
    s.bossCount = BOSSES_PER_WAVE
    s.bossType = bossTypeForWave(s.currentWave)
    s.enemiesToSpawn = s.regularCount + s.bossCount
    s.enemiesSpawned = 0
    s.enemiesRemaining = s.enemiesToSpawn
    s.spawnIntervalCur = spawnInterval(s.currentWave)
    s.spawnTimer = 0
    s.waveActive = true
    if (this.audio) this.audio.Play('wave_start')
    if (this.onWaveStart) this.onWaveStart(s.currentWave)
  }

  updateWaves(dt) {
    const s = this.state
    if (!s.waveActive) {
      s.waveDelayTimer -= dt
      if (s.waveDelayTimer <= 0) this.startWave()
      return
    }

    // Spawn the wave on cadence: the grunt/fast/tank horde first, then the wave-boss(es).
    if (s.enemiesSpawned < s.enemiesToSpawn) {
      s.spawnTimer -= dt
      if (s.spawnTimer <= 0) {
        s.spawnTimer = s.spawnIntervalCur
        if (this.spawner) {
          const isBoss = s.enemiesSpawned >= s.regularCount
          const type = isBoss ? s.bossType : pickRegularType(s.currentWave)
          this.spawner.spawnType(type, statsFor(type, s.currentWave))
        }
        s.enemiesSpawned++
      }
    }

    // Wave clears once every spawned zombie is dead.
    if (s.enemiesRemaining <= 0 && s.enemiesSpawned >= s.enemiesToSpawn) {
      s.waveActive = false
      s.waveDelayTimer = WAVE_DELAY
    }
  }

  // ---- Flow ----

  GameOver() {
    const s = this.state
    if (s.gameOver) return
    s.gameOver = true
    const isNewHigh = this.saveHighScore()
    if (this.audio) { this.audio.Play('game_over'); this.audio.StopMusic() }
    if (this.onGameOver) this.onGameOver({ ...s, isNewHigh })
  }

  Reset() {
    const highScore = this.state.highScore
    Object.assign(this.state, {
      score: 0, highScore, comboMultiplier: 1, maxComboMultiplier: 1, comboTimer: 0,
      killStreak: 0, maxKillStreak: 0, totalKills: 0,
      currentWave: 0, waveActive: false, waveDelayTimer: FIRST_WAVE_DELAY,
      enemiesToSpawn: 0, enemiesSpawned: 0, enemiesRemaining: 0,
      regularCount: 0, bossCount: 0, bossType: null, spawnTimer: 0, spawnIntervalCur: 1.5,
      gameOver: false,
    })
  }

  Update(dt) {
    const s = this.state
    if (s.gameOver) return

    this.updateCombo(dt)
    this.updateWaves(dt)

    // Endless mode: death is the only game-over.
    if (this.playerHealth && this.playerHealth.health <= 0) this.GameOver()
  }
}

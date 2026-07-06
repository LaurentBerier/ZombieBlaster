// Enemy roster — the full zombie cast, ported from the original enemies.js ENEMY_TYPES +
// spawnEnemy stat table. Every one of the 5 zombie character models is used: three grunt
// variants (Zombie_1/2/3), plus the fast/tank gameplay variants, plus the two wave-bosses
// (Zombie_4/5). Data only — the GameDirector picks a type per spawn, ZombieSpawner maps the
// type to its loaded GLB set, and ZombieController takes the per-type stats.
//
// (The original's procedural 2.5x mega-BOSS every 5th wave has no character art and is left
// for later; the Zombie_4/5 wave-bosses carry the boss beat here. Their one-shot telegraph is
// simplified to strong-but-survivable melee — a full windup/dash-escape port is a follow-up.)

export const ENEMY_TYPES = {
  ZOMBIE: 'zombie',
  ZOMBIE_2: 'zombie_2',
  ZOMBIE_3: 'zombie_3',
  FAST: 'fast_zombie',
  TANK: 'tank_zombie',
  ZOMBIE_4: 'zombie_4',   // wave-boss (waves 2+)
  ZOMBIE_5: 'zombie_5',   // debut wave-boss (wave 1)
}

// type -> loaded GLB asset-set key (see entry.js zombieAssetsByType). Fast/tank reuse a grunt
// model at a different scale, exactly as the original did.
export const TYPE_MODEL = {
  [ENEMY_TYPES.ZOMBIE]: 'Zombie_1',
  [ENEMY_TYPES.ZOMBIE_2]: 'Zombie_2',
  [ENEMY_TYPES.ZOMBIE_3]: 'Zombie_3',
  [ENEMY_TYPES.FAST]: 'Zombie_1',
  [ENEMY_TYPES.TANK]: 'Zombie_2',
  [ENEMY_TYPES.ZOMBIE_4]: 'Zombie_4',
  [ENEMY_TYPES.ZOMBIE_5]: 'Zombie_5',
}

const rand = (a, b) => a + Math.random() * (b - a)

// Per-type stats, scaled by the current wave (mirrors enemies.js spawnEnemy).
export function statsFor(type, wave = 1) {
  const w = wave
  switch (type) {
    case ENEMY_TYPES.ZOMBIE:
      return { type, health: 30 + w * 3, speed: rand(2.0, 3.0), damage: 8 + w, hitRadius: 0.7, scoreValue: 100, scale: 1.0, walkAnimScale: 1.3, attackRange: 1.8, attackCooldown: 1.0 }
    case ENEMY_TYPES.ZOMBIE_2:
      return { type, health: 30 + w * 3, speed: rand(2.0, 3.0), damage: 8 + w, hitRadius: 0.7, scoreValue: 120, scale: 1.0, walkAnimScale: 1.3, attackRange: 1.8, attackCooldown: 1.0 }
    case ENEMY_TYPES.ZOMBIE_3:
      return { type, health: 30 + w * 3, speed: rand(2.0, 3.0), damage: 8 + w, hitRadius: 0.7, scoreValue: 120, scale: 1.0, walkAnimScale: 1.3, attackRange: 1.8, attackCooldown: 1.0 }
    case ENEMY_TYPES.FAST:
      return { type, health: 20 + w * 2, speed: rand(4.5, 6.0), damage: 6 + w, hitRadius: 0.5, scoreValue: 150, scale: 0.8, walkAnimScale: 1.9, attackRange: 1.6, attackCooldown: 0.8 }
    case ENEMY_TYPES.TANK:
      return { type, health: 100 + w * 10, speed: rand(1.2, 1.7), damage: 20 + w * 2, hitRadius: 1.0, scoreValue: 300, scale: 1.4, walkAnimScale: 0.9, attackRange: 2.0, attackCooldown: 1.3 }
    case ENEMY_TYPES.ZOMBIE_4:
    case ENEMY_TYPES.ZOMBIE_5:
      // Big, tanky, slow wave-boss with heavy (but survivable) melee.
      return { type, health: 400 + w * 50, speed: 1.5, damage: 40, hitRadius: 1.2, scoreValue: 1000, scale: 1.8, walkAnimScale: 0.6, attackRange: 2.2, attackCooldown: 1.6 }
    default:
      return statsFor(ENEMY_TYPES.ZOMBIE, w)
  }
}

// Regular-horde type per spawn (probabilistic, difficulty ramps with the wave). Mirrors the
// original: tanks appear from wave 3, fast from wave 2, with grunt variety otherwise.
export function pickRegularType(wave = 1) {
  const r = Math.random()
  if (wave >= 3 && r < 0.15) return ENEMY_TYPES.TANK
  if (wave >= 2 && r < 0.35) return ENEMY_TYPES.FAST
  if (r < 0.55) return ENEMY_TYPES.ZOMBIE_2
  if (r < 0.78) return ENEMY_TYPES.ZOMBIE_3
  return ENEMY_TYPES.ZOMBIE
}

// The boss that closes a wave: Zombie_5 debuts on wave 1, Zombie_4 from wave 2 on.
export function bossTypeForWave(wave = 1) {
  return wave === 1 ? ENEMY_TYPES.ZOMBIE_5 : ENEMY_TYPES.ZOMBIE_4
}

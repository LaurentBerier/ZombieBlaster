// Weapon registry — the funky arsenal, ported from the original weapons.js WEAPON_DEFS.
// Data only. entry.js clones each `glbKey` GLB into the visible in-hand mesh; WeaponManager
// builds a projectile Weapon per entry; PlayerBody seats the visible mesh at the per-weapon
// `grip` on switch. Each gun keeps its projectile type / colour / status so it plays like the
// original (green Franken bolts, blue Soda stream + acid, rocket AoE, freezing blob).
//
// Grips are hand-local (cm / degrees), tuned in-game with the WeaponPlacementDebug ` panel.
// FRANKEN-GUN is tuned; the others start from it and want their own ` pass (switch to the gun,
// nudge, paste its snippet here).

import * as THREE from 'three'

const grip = (px, py, pz, rx, ry, rz) => ({
  position: new THREE.Vector3(px, py, pz),
  rotationEuler: new THREE.Euler(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz)),
})

export const WEAPON_DEFS = [
  {
    name: 'FRANKEN-GUN', glbKey: 'frankenGun',
    fireRate: 0.15, damage: 15, magSize: 30,
    projectileType: 'plasma', projectileSpeed: 45, projectileRadius: 0.18, spread: 0.02,
    projectileColor: 0x7FFF00, bulletStyle: 'green', knockback: 3.0, sound: 'weapon_tesla',
    grip: grip(-22.2, -4.4, 0.7, 90, -20, 362),
    fx: { element: 'shock', status: { type: 'shock', duration: 0.4, dps: 0 }, decalType: 'blood', decalScale: 1.0 },
    // Score-gated evolution tiers (shared thresholds 0/2000/5000): more damage, faster fire.
    evolutionLevels: [
      { scoreThreshold: 0, name: 'FRANKEN-GUN Mk.I', damage: 15, fireRate: 0.15, color: 0xFF00FF },
      { scoreThreshold: 2000, name: 'FRANKEN-GUN Mk.II', damage: 22, fireRate: 0.12, color: 0xFF69B4 },
      { scoreThreshold: 5000, name: 'FRANKEN-GUN Mk.III', damage: 30, fireRate: 0.10, color: 0xFFFF00 },
    ],
  },
  {
    name: 'BOWLING LAUNCHER', glbKey: 'bowlingGun',
    fireRate: 0.8, damage: 60, magSize: 8,
    projectileType: 'rocket', projectileSpeed: 22, projectileRadius: 0.3, spread: 0.0,
    projectileColor: 0xFF7F00, bulletStyle: null, knockback: 6.0, aoe: true, aoeRadius: 3.5, sound: 'weapon_fire_heavy',
    grip: grip(-22.2, -4.4, 0.7, 90, -20, 362),
    fx: { element: 'fire', status: { type: 'burn', duration: 2.5, dps: 8 }, splash: 'explosion', explosionRadius: 3.5, decalType: 'burn', decalScale: 1.7 },
    evolutionLevels: [
      { scoreThreshold: 0, name: 'BOWLING LAUNCHER Mk.I', damage: 60, fireRate: 0.8, color: 0xFF7F00 },
      { scoreThreshold: 2000, name: 'BOWLING LAUNCHER Mk.II', damage: 85, fireRate: 0.65, color: 0xFFFF00 },
      { scoreThreshold: 5000, name: 'BOWLING LAUNCHER Mk.III', damage: 120, fireRate: 0.5, color: 0xFF0000 },
    ],
  },
  {
    name: 'SODA LASER', glbKey: 'sodaGun',
    fireRate: 0.05, damage: 5, magSize: 100,
    projectileType: 'liquid', projectileSpeed: 35, projectileRadius: 0.12, spread: 0.025,
    projectileColor: 0x3a86ff, bulletStyle: 'blue', knockback: 0.8, sound: 'weapon_laser',
    grip: grip(-22.2, -4.4, 0.7, 90, -20, 362),
    fx: { element: 'acid', status: { type: 'corrode', duration: 1.5, dps: 3 }, splash: 'liquid',
      acidPoolChance: 0.3, acidPoolRadius: 1.2, acidPoolDuration: 2.0, acidPoolDps: 5, decalType: 'plasma', decalScale: 0.9 },
    evolutionLevels: [
      { scoreThreshold: 0, name: 'SODA LASER Mk.I', damage: 5, fireRate: 0.05, color: 0x00FFFF },
      { scoreThreshold: 2000, name: 'SODA LASER Mk.II', damage: 8, fireRate: 0.04, color: 0x7FFF00 },
      { scoreThreshold: 5000, name: 'SODA LASER Mk.III', damage: 12, fireRate: 0.03, color: 0x00FF00 },
    ],
  },
  {
    name: 'CRYO BLASTER', glbKey: 'cryoGun',
    fireRate: 0.06, damage: 7, magSize: 80,
    projectileType: 'blob', projectileSpeed: 32, projectileRadius: 0.18, spread: 0.02,
    projectileColor: 0x00FFFF, bulletStyle: null, knockback: 0.6, sound: 'weapon_laser',
    grip: grip(-22.2, -4.4, 0.7, 90, -20, 362),
    fx: { element: 'freeze', status: { type: 'freeze', duration: 0.5, dps: 0 }, splash: 'liquid', splashCount: 6, decalType: 'slime', decalScale: 1.0 },
    evolutionLevels: [
      { scoreThreshold: 0, name: 'CRYO BLASTER Mk.I', damage: 7, fireRate: 0.06, color: 0x00FFFF },
      { scoreThreshold: 2000, name: 'CRYO BLASTER Mk.II', damage: 10, fireRate: 0.05, color: 0x66e6ff },
      { scoreThreshold: 5000, name: 'CRYO BLASTER Mk.III', damage: 14, fireRate: 0.04, color: 0xFFFFFF },
    ],
  },
]

// asset id -> GLB url, for entry.js to preload.
export const WEAPON_GLBS = {
  frankenGun: 'assets/Weapons/1_Neon_Biohazard_Blaste_0415181024_texture.glb',
  bowlingGun: 'assets/Weapons/2_Meshy_AI_Neon_Coil_Plasma_Rifl_0416160536_texture.glb',
  sodaGun: 'assets/Weapons/New_Gun/3_Shotgun_futuristic.glb',
  cryoGun: 'assets/Weapons/4_Meshy_AI_Neon_Plasma_Blaster_0416221538_texture.glb',
}

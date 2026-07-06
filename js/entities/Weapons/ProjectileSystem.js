// ProjectileSystem — the funky projectile weapons on the new engine. Ported from the
// original weapons.js: a pooled bolt with the animated liquid SPRITE bullet (the
// Franken-Gun/Soda-Laser signature look), a colored bullet-light, per-type flight,
// and a sphere hit-test against the live zombies. Instead of the template's hitscan,
// the weapon fires one of these from the real muzzle toward the crosshair target, and
// on contact it broadcasts the decoupled 'hit' event to the zombie entity (which runs
// its damage + ragdoll). Keeps the projectile funk while adopting the rifle rig.

import * as THREE from 'three'
import Component from '../../Component.js'
import { COLORS, makeChannelRotatedTexture } from '../Common/NeonMaterials.js'
import { activeZombies } from '../NPC/ZombieController.js'

const MAX_PROJECTILES = 48
const MAX_BULLET_LIGHTS = 6
const SHEET = { columns: 3, rows: 4, frames: 12, fps: 24 }
const SODA_GLOW = 0x3a86ff

const TYPE_CFG = {
  plasma: { lifetime: 1.2, gravity: 0 },
  liquid: { lifetime: 0.9, gravity: 4.0 },
  blob: { lifetime: 0.9, gravity: 5.0 },
  default: { lifetime: 1.4, gravity: 0 },
}

export default class ProjectileSystem extends Component {
  constructor(scene, spriteTexture) {
    super()
    this.name = 'ProjectileSystem'
    this.scene = scene
    this.spriteTexture = spriteTexture || null
    this.projectiles = []
    this.bulletLights = []
    this._animTime = 0
    this._frame = -1
    this._origin = new THREE.Vector3()
    this._dir = new THREE.Vector3()
    this._cand = []
  }

  Initialize() {
    this.controls = this.GetComponent('PlayerControls')
    this.body = this.GetComponent('PlayerBody')
    this.camera = this.controls ? this.controls.camera : null

    this.buildSpriteMaterials()
    this.buildPool()
  }

  buildSpriteMaterials() {
    let tex = this.spriteTexture
    if (!tex) { tex = new THREE.TextureLoader().load('assets/FX/LiquidSpriteSheet2.png') }
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(1 / SHEET.columns, 1 / SHEET.rows)
    tex.minFilter = tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding
    this.greenTex = tex
    this.setFrame(0)

    const mat = (map, color, opacity) => new THREE.SpriteMaterial({
      map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
    this.greenCore = mat(tex, 0xffffff, 1.0)
    this.greenGlow = mat(tex, COLORS.lime, 0.45)
    // Blue (Soda Laser) variant — RGB-rotated sheet, animated in lockstep with green.
    this.blueTex = makeChannelRotatedTexture(tex)
    this.blueCore = mat(this.blueTex, 0xffffff, 1.0)
    this.blueGlow = mat(this.blueTex, SODA_GLOW, 0.45)
  }

  setFrame(frame) {
    if (!this.greenTex) return
    const w = frame % SHEET.frames
    const col = w % SHEET.columns
    const row = Math.floor(w / SHEET.columns)
    const ox = col / SHEET.columns
    const oy = 1 - ((row + 1) / SHEET.rows)
    this.greenTex.offset.set(ox, oy)
    if (this.blueTex) this.blueTex.offset.set(ox, oy)
    this._frame = w
  }

  buildPool() {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const g = new THREE.Group()
      const core = new THREE.Sprite(this.greenCore)
      const glow = new THREE.Sprite(this.greenGlow)
      core.renderOrder = 8; glow.renderOrder = 7
      g.add(glow); g.add(core)
      g.visible = false
      g.userData = { active: false, velocity: new THREE.Vector3(), damage: 0, lifetime: 0, gravity: 0, color: COLORS.lime, knockback: 0, core, glow, coreScale: 1, glowScale: 1 }
      this.scene.add(g)
      this.projectiles.push(g)
    }
    for (let i = 0; i < MAX_BULLET_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 11, 2)
      light.position.set(0, -1000, 0)
      this.scene.add(light)
      this.bulletLights.push(light)
    }
  }

  acquire() {
    let oldest = null
    for (const p of this.projectiles) {
      if (!p.userData.active) return p
      if (!oldest || p.userData.lifetime < oldest.userData.lifetime) oldest = p
    }
    if (oldest) this.deactivate(oldest)
    return oldest
  }

  deactivate(p) { p.userData.active = false; p.visible = false }

  // Called by WeaponManager when a projectile-mode weapon fires.
  Fire(weapon) {
    // Muzzle origin: the socketed gun's pivot, nudged forward; fall back to the camera.
    const dir = this._dir
    const target = this.controls && this.controls.aimTarget
    const valid = this.controls && this.controls.aimTargetValid

    if (this.body && this.body.weaponPivot) this.body.weaponPivot.getWorldPosition(this._origin)
    else if (this.camera) this.camera.getWorldPosition(this._origin)

    if (valid && target) dir.copy(target).sub(this._origin)
    else if (this.controls && this.controls.aimDir) dir.copy(this.controls.aimDir)
    else if (this.camera) this.camera.getWorldDirection(dir)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1)
    dir.normalize()
    // Per-axis spread so the stream scatters like the original (tighter while aiming).
    const spread = (weapon.spread ?? 0.02) * (this.controls && this.controls.aiming ? 0.25 : 1)
    if (spread > 1e-5) {
      dir.x += (Math.random() - 0.5) * spread
      dir.y += (Math.random() - 0.5) * spread
      dir.z += (Math.random() - 0.5) * spread
      dir.normalize()
    }
    this._origin.addScaledVector(dir, 0.4)

    const style = weapon.bulletStyle || 'green'
    const speed = weapon.projectileSpeed || 45
    const cfg = TYPE_CFG[weapon.projectileType] || TYPE_CFG.default

    const p = this.acquire()
    if (!p) return
    const u = p.userData
    u.active = true
    u.velocity.copy(dir).multiplyScalar(speed)
    u.damage = weapon.damage ?? 15
    u.lifetime = cfg.lifetime
    u.gravity = cfg.gravity
    u.color = weapon.projectileColor ?? COLORS.lime
    u.knockback = weapon.knockback ?? 0
    u.core.material = style === 'blue' ? this.blueCore : this.greenCore
    u.glow.material = style === 'blue' ? this.blueGlow : this.greenGlow
    const s = Math.max(0.72, (weapon.projectileRadius || 0.18) * 4.2)
    u.coreScale = s; u.glowScale = s * 2
    u.core.scale.set(s, s, 1)
    u.glow.scale.set(s * 2, s * 2, 1)
    p.position.copy(this._origin)
    p.visible = true
  }

  Update(dt) {
    // Advance the shared sprite frame.
    this._animTime = (this._animTime + dt * SHEET.fps) % SHEET.frames
    const nf = Math.floor(this._animTime)
    if (nf !== this._frame) this.setFrame(nf)

    const player = this.parent   // the player entity (used as 'from' for hits)
    for (const p of this.projectiles) {
      const u = p.userData
      if (!u.active) continue
      u.lifetime -= dt
      if (u.lifetime <= 0) { this.deactivate(p); continue }
      if (u.gravity) u.velocity.y -= u.gravity * dt
      p.position.addScaledVector(u.velocity, dt)

      // Sprite pulse.
      const pulse = 1 + Math.sin(u.lifetime * 36) * 0.08
      u.core.scale.setScalar(u.coreScale * pulse)
      u.glow.scale.setScalar(u.glowScale * (1 + Math.sin(u.lifetime * 22) * 0.14))

      // Ground / stray bolt.
      if (p.position.y <= 0.03) { this.deactivate(p); continue }

      // Sphere hit-test against live zombies (body-centre, like the original).
      let hit = false
      for (const z of activeZombies) {
        if (!z.alive || z.dying) continue
        const cx = z.root.position.x, cy = z.hitCenterY ?? 1.0, cz = z.root.position.z
        const dx = p.position.x - cx, dy = p.position.y - cy, dz = p.position.z - cz
        const reach = (z.hitRadius || 0.7) + 0.3 + 0.5
        if (dx * dx + dy * dy + dz * dz < reach * reach) {
          this._dir.copy(u.velocity).normalize()
          z.parent.Broadcast({
            topic: 'hit', amount: u.damage, from: player,
            knockbackDir: this._dir, knockbackStrength: u.knockback,
            hitResult: { intersectionPoint: p.position.clone(), intersectionNormal: this._dir.clone().multiplyScalar(-1) },
          })
          hit = true
          break
        }
      }
      if (hit) this.deactivate(p)
    }

    this.updateBulletLights()
  }

  updateBulletLights() {
    this._cand.length = 0
    for (const p of this.projectiles) if (p.userData.active) this._cand.push(p)
    // Park lights on the nearest few bolts (constant light count => no shader recompiles).
    const cam = this.camera ? this.camera.position : null
    if (cam) this._cand.sort((a, b) => a.position.distanceToSquared(cam) - b.position.distanceToSquared(cam))
    for (let i = 0; i < this.bulletLights.length; i++) {
      const light = this.bulletLights[i]
      const p = this._cand[i]
      if (p) {
        light.position.copy(p.position)
        light.color.setHex(p.userData.color)
        light.intensity = 6
      } else {
        light.intensity = 0
      }
    }
  }
}

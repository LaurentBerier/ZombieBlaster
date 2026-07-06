// ProjectileSystem — the funky projectile weapons on the new engine. Ported from the
// original weapons.js: a pooled bolt with either the animated liquid SPRITE bullet
// (Franken-Gun green / Soda-Laser blue — the signature look) or a colored emissive MESH
// bolt (Bowling rocket / Cryo blob), a colored bullet-light, per-type flight (gravity),
// spread, and a sphere hit-test against the live zombies. The weapon fires one from the
// real muzzle toward the crosshair target; on contact it broadcasts the decoupled 'hit'
// (amount + knockback + status) to the zombie entity, which runs its damage + ragdoll,
// and spawns a green-blood impact burst.

import * as THREE from 'three'
import Component from '../../Component.js'
import { COLORS, makeChannelRotatedTexture } from '../Common/NeonMaterials.js'
import { activeZombies } from '../NPC/ZombieController.js'
import { ARENA } from '../Level/ArenaSetup.js'

const MAX_PROJECTILES = 48
const MAX_BULLET_LIGHTS = 6
const SHEET = { columns: 3, rows: 4, frames: 12, fps: 24 }
const SODA_GLOW = 0x3a86ff
const GROUND_Y = 0.035

// Environment-collision scratch (single-threaded update loop).
const _GROUND_NORMAL = new THREE.Vector3(0, 1, 0)
const _impactPoint = new THREE.Vector3()
const _wallPoint = new THREE.Vector3()
const _wallNormal = new THREE.Vector3()
const _wallSurface = { point: _wallPoint, normal: _wallNormal }

function clampValue(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Parametric position (0..1) where segment p0->p1 first enters the wall AABB, or null.
// Slab method — resolves a fast gravity-free bolt against the surface it actually reaches
// first this frame instead of tunnelling through thin walls.
function segmentAABBEntryT(p0, p1, wall) {
  const bounds = [
    [p0.x, p1.x - p0.x, wall.minX, wall.maxX],
    [p0.y, p1.y - p0.y, wall.minY ?? 0, wall.maxY ?? Infinity],
    [p0.z, p1.z - p0.z, wall.minZ, wall.maxZ],
  ]
  let tEnter = 0, tExit = 1
  for (let i = 0; i < 3; i++) {
    const start = bounds[i][0], delta = bounds[i][1], lo = bounds[i][2], hi = bounds[i][3]
    if (Math.abs(delta) < 1e-9) {
      if (start < lo || start > hi) return null // parallel & outside slab
    } else {
      let t0 = (lo - start) / delta, t1 = (hi - start) / delta
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp }
      if (t0 > tEnter) tEnter = t0
      if (t1 < tExit) tExit = t1
      if (tEnter > tExit) return null
    }
  }
  return tEnter
}

// Parametric entry (0..1) where segment p0->p1 first crosses a vertical cylinder collider
// (round props), or null. 2D ray/circle in XZ, gated by the cylinder's Y span.
function segmentCylinderEntryT(p0, p1, wall) {
  const dx = p1.x - p0.x, dz = p1.z - p0.z
  const a = dx * dx + dz * dz
  if (a < 1e-9) return null
  const ox = p0.x - wall.cx, oz = p0.z - wall.cz
  const b = 2 * (ox * dx + oz * dz)
  const c = ox * ox + oz * oz - wall.radius * wall.radius
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  let t = (-b - Math.sqrt(disc)) / (2 * a)
  if (t < 0) t = 0
  if (t > 1) return null
  const y = p0.y + t * (p1.y - p0.y)
  if (y < wall.minY || y > wall.maxY) return null
  return t
}

// Nearest AABB face to the impact point → { point, normal } clamped onto that face.
function getWallImpactSurface(point, wall) {
  let bestDistance = Infinity, nx = 0, ny = 0, nz = 1, axis = 'z', planeValue = wall.maxZ
  const testFace = (distance, x, y, z, faceAxis, facePlane) => {
    if (distance >= bestDistance) return
    bestDistance = distance; nx = x; ny = y; nz = z; axis = faceAxis; planeValue = facePlane
  }
  testFace(Math.abs(point.x - wall.minX), -1, 0, 0, 'x', wall.minX)
  testFace(Math.abs(point.x - wall.maxX), 1, 0, 0, 'x', wall.maxX)
  testFace(Math.abs(point.z - wall.minZ), 0, 0, -1, 'z', wall.minZ)
  testFace(Math.abs(point.z - wall.maxZ), 0, 0, 1, 'z', wall.maxZ)
  if (wall.maxY !== undefined) testFace(Math.abs(point.y - wall.maxY), 0, 1, 0, 'y', wall.maxY)

  _wallPoint.set(
    clampValue(point.x, wall.minX, wall.maxX),
    clampValue(point.y, wall.minY ?? 0, wall.maxY ?? point.y),
    clampValue(point.z, wall.minZ, wall.maxZ)
  )
  if (axis === 'x') _wallPoint.x = planeValue
  else if (axis === 'y') _wallPoint.y = planeValue
  else _wallPoint.z = planeValue
  _wallNormal.set(nx, ny, nz).normalize()
  return _wallSurface
}

// Impact surface on a cylinder collider: the point on the round side nearest the hit, with
// an outward radial normal.
function getCylinderImpactSurface(point, wall) {
  let nx = point.x - wall.cx, nz = point.z - wall.cz
  const len = Math.hypot(nx, nz) || 1
  nx /= len; nz /= len
  _wallNormal.set(nx, 0, nz)
  _wallPoint.set(wall.cx + nx * wall.radius, point.y, wall.cz + nz * wall.radius)
  return _wallSurface
}

const TYPE_CFG = {
  plasma: { lifetime: 1.2, gravity: 0 },
  rocket: { lifetime: 4.0, gravity: 0 },
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
    const level = this.FindEntity('Level')
    this.fx = level ? level.GetComponent('Fx') : null
    this.decals = level ? level.GetComponent('Decals') : null
    this.audio = this.FindEntity('Audio')?.GetComponent('AudioManager') || null

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
    this.blueTex = makeChannelRotatedTexture(tex)
    this.blueCore = mat(this.blueTex, 0xffffff, 1.0)
    this.blueGlow = mat(this.blueTex, SODA_GLOW, 0.45)
  }

  setFrame(frame) {
    if (!this.greenTex) return
    const w = frame % SHEET.frames
    const col = w % SHEET.columns
    const row = Math.floor(w / SHEET.columns)
    this.greenTex.offset.set(col / SHEET.columns, 1 - ((row + 1) / SHEET.rows))
    if (this.blueTex) this.blueTex.offset.copy(this.greenTex.offset)
    this._frame = w
  }

  buildPool() {
    const coreGeo = new THREE.SphereGeometry(0.13, 8, 8)
    const glowGeo = new THREE.SphereGeometry(0.24, 6, 6)
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const g = new THREE.Group()
      const core = new THREE.Sprite(this.greenCore)
      const glow = new THREE.Sprite(this.greenGlow)
      core.renderOrder = 8; glow.renderOrder = 7
      g.add(glow); g.add(core)
      // Mesh bolt (rocket/blob) — colored per shot; sprite + mesh never shown together.
      const meshCore = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }))
      const meshGlow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }))
      meshCore.visible = false; meshGlow.visible = false
      g.add(meshGlow); g.add(meshCore)
      g.visible = false
      g.userData = {
        active: false, velocity: new THREE.Vector3(), damage: 0, lifetime: 0, gravity: 0,
        color: COLORS.lime, knockback: 0, status: null, sprite: true, radius: 0.18,
        core, glow, meshCore, meshGlow, coreScale: 1, glowScale: 1,
        prevPos: new THREE.Vector3(),
      }
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
    // Per-axis spread (tighter while aiming).
    const spread = (weapon.projectileSpread ?? 0.02) * (this.controls && this.controls.aiming ? 0.25 : 1)
    if (spread > 1e-5) {
      dir.x += (Math.random() - 0.5) * spread
      dir.y += (Math.random() - 0.5) * spread
      dir.z += (Math.random() - 0.5) * spread
      dir.normalize()
    }
    this._origin.addScaledVector(dir, 0.4)

    const style = weapon.bulletStyle   // 'green' | 'blue' | null
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
    u.status = weapon.fx && weapon.fx.status ? weapon.fx.status : null
    u.radius = weapon.projectileRadius || 0.18
    u.aoe = !!weapon.aoe
    u.aoeRadius = weapon.aoeRadius || 3.0
    // Impact-decal params (per-weapon body splat + environment splat style).
    u.decalType = (weapon.fx && weapon.fx.decalType) || null
    u.decalScale = (weapon.fx && weapon.fx.decalScale) || 1
    u.impactStyle = style   // 'green' | 'blue' | null — env splat tint / whether to splat walls
    u.projectileType = weapon.projectileType

    if (style) {
      u.sprite = true
      u.core.visible = true; u.glow.visible = true
      u.meshCore.visible = false; u.meshGlow.visible = false
      u.core.material = style === 'blue' ? this.blueCore : this.greenCore
      u.glow.material = style === 'blue' ? this.blueGlow : this.greenGlow
      const s = Math.max(0.72, u.radius * 4.2)
      u.coreScale = s; u.glowScale = s * 2
      u.core.scale.set(s, s, 1); u.glow.scale.set(s * 2, s * 2, 1)
    } else {
      u.sprite = false
      u.core.visible = false; u.glow.visible = false
      u.meshCore.visible = true; u.meshGlow.visible = true
      u.meshCore.material.color.setHex(u.color)
      u.meshGlow.material.color.setHex(u.color)
      const s = Math.max(0.6, u.radius / 0.15)
      u.coreScale = s
      u.meshCore.scale.setScalar(s); u.meshGlow.scale.setScalar(s * 1.4)
    }

    p.position.copy(this._origin)
    u.prevPos.copy(this._origin)
    p.rotation.set(0, 0, 0)
    p.visible = true

    if (this.audio) this.audio.Play(weapon.sound || 'weapon_fire')
  }

  // Splash damage nearby zombies at a detonation point (rocket AoE), with radial falloff.
  explodeAoE(point, u, player) {
    if (!u.aoe) return
    for (const other of activeZombies) {
      if (!other.alive || other.dying) continue
      const ox = other.root.position.x - point.x
      const oy = (other.root.position.y + (other.hitCenterY ?? 1)) - point.y
      const oz = other.root.position.z - point.z
      const d2 = ox * ox + oy * oy + oz * oz
      if (d2 < u.aoeRadius * u.aoeRadius) {
        const falloff = 1 - Math.sqrt(d2) / u.aoeRadius
        other.parent.Broadcast({ topic: 'hit', amount: u.damage * falloff * 0.6, from: player, status: u.status ? { ...u.status } : null })
      }
    }
  }

  Update(dt) {
    this._animTime = (this._animTime + dt * SHEET.fps) % SHEET.frames
    const nf = Math.floor(this._animTime)
    if (nf !== this._frame) this.setFrame(nf)

    const player = this.parent
    for (const p of this.projectiles) {
      const u = p.userData
      if (!u.active) continue
      u.lifetime -= dt
      if (u.lifetime <= 0) { this.deactivate(p); continue }
      if (u.gravity) u.velocity.y -= u.gravity * dt
      u.prevPos.copy(p.position)
      p.position.addScaledVector(u.velocity, dt)

      const pulse = 1 + Math.sin(u.lifetime * 36) * 0.08
      if (u.sprite) {
        u.core.scale.setScalar(u.coreScale * pulse)
        u.glow.scale.setScalar(u.glowScale * (1 + Math.sin(u.lifetime * 22) * 0.14))
      } else {
        u.meshCore.scale.setScalar(u.coreScale * pulse)
        p.rotation.z += dt * 2
      }

      let hit = false
      for (const z of activeZombies) {
        if (!z.alive || z.dying) continue
        const cx = z.root.position.x, cy = z.root.position.y + (z.hitCenterY ?? 1.0), cz = z.root.position.z
        const dx = p.position.x - cx, dy = p.position.y - cy, dz = p.position.z - cz
        const reach = (z.hitRadius || 0.7) + 0.3 + 0.5
        if (dx * dx + dy * dy + dz * dz < reach * reach) {
          this._dir.copy(u.velocity).normalize()
          z.parent.Broadcast({
            topic: 'hit', amount: u.damage, from: player,
            knockbackDir: this._dir, knockbackStrength: u.knockback,
            status: u.status ? { ...u.status } : null,
            hitResult: { intersectionPoint: p.position.clone(), intersectionNormal: this._dir.clone().multiplyScalar(-1) },
          })
          if (this.fx) this.fx.SpawnGreenBloodImpact(p.position, { scale: 0.9 })
          if (this.audio) this.audio.Play('hit_zombie')
          // Stamp the shader-projected body splat (rides the animation + ragdoll).
          if (this.decals && u.decalType) {
            this.decals.SpawnImpact(z, p.position, this._dir, u.decalType, { scaleMult: u.decalScale })
          }
          // AoE (rocket): splash-damage nearby zombies with falloff.
          if (u.aoe) {
            for (const other of activeZombies) {
              if (other === z || !other.alive || other.dying) continue
              const ox = other.root.position.x - p.position.x
              const oy = (other.root.position.y + (other.hitCenterY ?? 1)) - p.position.y
              const oz = other.root.position.z - p.position.z
              const d2 = ox * ox + oy * oy + oz * oz
              if (d2 < u.aoeRadius * u.aoeRadius) {
                const falloff = 1 - Math.sqrt(d2) / u.aoeRadius
                other.parent.Broadcast({ topic: 'hit', amount: u.damage * falloff * 0.6, from: player, status: u.status ? { ...u.status } : null })
              }
            }
          }
          hit = true
          break
        }
      }
      if (hit) { this.deactivate(p); continue }

      // Environment collision: resolve the bolt against the ground plane + arena walls this
      // frame (whichever it reaches first), stamp a splat where it lands, and deactivate. Bolts
      // no longer pass through walls/floor. Only sprite-bullet weapons ('green'/'blue') leave a
      // splat; rockets additionally detonate (AoE) on wall impact.
      const prev = u.prevPos
      const groundY = ARENA.floorY ?? GROUND_Y   // splat/stop on the visible floor, not y=0
      let bestT = Infinity, groundHit = false, wallHit = false, hitWall = null

      if (u.velocity.y < -0.001 && prev.y > groundY && p.position.y <= groundY) {
        const denom = prev.y - p.position.y
        const tGround = denom > 0.0001 ? (prev.y - groundY) / denom : 1
        bestT = Math.max(0, Math.min(1, tGround))
        groundHit = true
      }
      for (let w = 0; w < ARENA.walls.length; w++) {
        const wall = ARENA.walls[w]
        const tWall = wall.shape === 'cylinder'
          ? segmentCylinderEntryT(prev, p.position, wall)
          : segmentAABBEntryT(prev, p.position, wall)
        if (tWall !== null && tWall < bestT) { bestT = tWall; hitWall = wall; wallHit = true; groundHit = false }
      }

      if (groundHit) {
        _impactPoint.lerpVectors(prev, p.position, bestT)
        _impactPoint.y = groundY
        if (u.impactStyle && this.fx) {
          this.fx.SpawnEnvironmentSplat(_impactPoint, { normal: _GROUND_NORMAL, scale: 0.62, blue: u.impactStyle === 'blue' })
        }
        this.deactivate(p); continue
      }
      if (wallHit && hitWall) {
        _impactPoint.lerpVectors(prev, p.position, bestT)
        const surf = hitWall.shape === 'cylinder'
          ? getCylinderImpactSurface(_impactPoint, hitWall)
          : getWallImpactSurface(_impactPoint, hitWall)
        if (u.impactStyle && this.fx) {
          this.fx.SpawnEnvironmentSplat(surf.point, { normal: surf.normal, scale: 0.58, blue: u.impactStyle === 'blue' })
        }
        if (u.projectileType === 'rocket') this.explodeAoE(surf.point, u, player)
        this.deactivate(p); continue
      }
    }

    this.updateBulletLights()
  }

  updateBulletLights() {
    this._cand.length = 0
    for (const p of this.projectiles) if (p.userData.active) this._cand.push(p)
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

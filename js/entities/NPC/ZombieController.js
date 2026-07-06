// ZombieController — one zombie enemy as an ECS component, ported from the original
// flat enemies.js. Keeps the current zombies' look + animations (walk/attack/death
// clips crossfaded), the direct-chase AI (face + move + separation + arena wall
// collision), and adds a PHYSICS RAGDOLL on death via the template's Ragdoll.
//
// Damage is decoupled the template way: the projectile system (or anything) does
// entity.Broadcast({topic:'hit', amount, from, hitResult}); this component's TakeHit
// applies it. The live zombie has no Ammo body (the projectile weapons sphere-test
// against activeZombies); on death the Ragdoll runs its own verlet sim against the
// static level. Melee is a 'hit' broadcast back to the Player entity.

import * as THREE from 'three'
import Component from '../../Component.js'
import Ragdoll from './Ragdoll.js'
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { ARENA } from '../Level/ArenaSetup.js'

// Live zombie controllers — the separation pass and the projectile hit-test read this.
export const activeZombies = []

const ZOMBIE_TARGET_HEIGHT = 2.0
const ZOMBIE_EXTRA_SCALE = 0.01
const ZOMBIE_GROUND_OFFSET = 0.08
const ENEMY_TOP_Y = 2.0
const KNOCKBACK_DECAY = 0.0025
// Movement/animation slow while a status is active (shock/freeze stagger; DoT types don't slow).
const STATUS_SPEED_MULT = { shock: 0.3, freeze: 0.5, burn: 1.0, corrode: 1.0 }

const _bbox = new THREE.Box3()
const _bboxSize = new THREE.Vector3()
const _v = new THREE.Vector3()

// Default stats (Zombie_1). The spawner can override per-type later.
const DEFAULT_STATS = {
  health: 40, speed: 2.4, damage: 10, hitRadius: 0.7, scoreValue: 100,
  walkAnimScale: 1.3, attackRange: 1.8, attackCooldown: 1.0,
}

export default class ZombieController extends Component {
  // assets = { scene, walk, attack, death }  (shared; cloned per instance)
  constructor(assets, scene, physicsWorld, stats = {}) {
    super()
    this.name = 'ZombieController'
    this.assets = assets
    this.scene = scene
    this.world = physicsWorld
    this.stats = { ...DEFAULT_STATS, ...stats }

    this.alive = true
    this.dying = false
    this.lingerTimer = 0
    this.attackTimer = 0
    this.hitFlashTimer = 0
    this.knockbackVel = new THREE.Vector3()
    this.statusEffect = { type: null, duration: 0, dpsTimer: 0, dps: 0 }

    this.health = this.stats.health
    this.maxHealth = this.stats.health
    this.speed = this.stats.speed
    this.damage = this.stats.damage
    this.hitRadius = this.stats.hitRadius
    this.scoreValue = this.stats.scoreValue
    this.attackRange = this.stats.attackRange
    this.attackCooldown = this.stats.attackCooldown
    this.hitCenterY = ZOMBIE_TARGET_HEIGHT / 2

    this.root = new THREE.Group()
    this.bodyGroup = new THREE.Group()
    this.root.add(this.bodyGroup)
    this.mixer = null
    this.walkAction = this.attackAction = this.deathAction = null
    this.activeAnim = null
    this.skinnedMesh = null
    this.headBone = null
    // Skeleton bones the impact-decal system anchors splats to (all bones but the Armature
    // root). Populated in buildModel; read by Decals.SpawnImpact to pick the nearest bone.
    this.impactBones = []
    this.decals = null
    this.ragdoll = null
  }

  Initialize() {
    // Seat the root at the entity's spawn position.
    this.root.position.copy(this.parent.Position)
    this.root.rotation.y = Math.random() * Math.PI * 2
    this.scene.add(this.root)

    // The shader-projected impact-decal system lives on the 'Level' entity (may be absent in
    // a minimal harness — the splats are then simply skipped).
    const level = this.FindEntity('Level')
    this.decals = level ? level.GetComponent('Decals') : null
    // The gameplay brain that tallies kills/score (absent in the bare POC harness).
    this.director = this.FindEntity('GameDirector')?.GetComponent('GameDirector') || null

    this.buildModel()
    if (this.decals) this.decals.PrepareEnemy(this)

    this.parent.RegisterEventHandler(this.TakeHit, 'hit')
    activeZombies.push(this)
  }

  buildModel() {
    const model = SkeletonUtils.clone(this.assets.scene)

    // Auto-fit to target height, then the extra knockdown the raw export needs.
    _bbox.setFromObject(model)
    _bbox.getSize(_bboxSize)
    const rawHeight = _bboxSize.y || 1
    const scale = (ZOMBIE_TARGET_HEIGHT / rawHeight) * ZOMBIE_EXTRA_SCALE
    model.scale.setScalar(scale)

    // Ground-anchor on the 'Armature' node (foot origin); fall back to bbox min.
    const armature = model.getObjectByName('Armature')
    if (armature) {
      model.updateMatrixWorld(true)
      armature.getWorldPosition(_v)
      model.position.y = -_v.y + ZOMBIE_GROUND_OFFSET
    } else {
      model.position.y = -_bbox.min.y * scale + ZOMBIE_GROUND_OFFSET
    }
    model.rotation.y = 0

    model.traverse(child => {
      child.frustumCulled = false            // skinned-sphere culling wrongly hides close zombies
      if (child.isSkinnedMesh && !this.skinnedMesh) this.skinnedMesh = child
      // Cache every real bone (skip the Armature root) for decal anchoring.
      if (child.isBone && child.name !== 'Armature') this.impactBones.push(child)
    })
    this.headBone = model.getObjectByName('Head') || null
    this.bodyGroup.add(model)
    this.model = model

    // Per-instance mixer bound to the cloned skeleton; clips bind by bone name.
    this.mixer = new THREE.AnimationMixer(model)
    if (this.assets.walk) {
      const wa = this.mixer.clipAction(this.assets.walk)
      wa.setLoop(THREE.LoopRepeat, Infinity)
      wa.timeScale = this.stats.walkAnimScale
      wa.time = Math.random() * this.assets.walk.duration
      wa.play()
      this.walkAction = wa
      this.activeAnim = 'walk'
    }
    if (this.assets.attack) {
      const aa = this.mixer.clipAction(this.assets.attack)
      aa.setLoop(THREE.LoopRepeat, Infinity)
      this.attackAction = aa
    }
    if (this.assets.death) {
      const da = this.mixer.clipAction(this.assets.death)
      da.setLoop(THREE.LoopOnce, 1)
      da.clampWhenFinished = true
      this.deathClipDuration = this.assets.death.duration
      this.deathAction = da
    }
  }

  TakeHit = (msg) => {
    if (this.dying || !this.alive) return
    const amount = (msg && msg.amount) ? msg.amount : 10
    this.health -= amount
    this.hitFlashTimer = 0.15
    if (msg && msg.knockbackDir && msg.knockbackStrength) {
      this.knockbackVel.copy(msg.knockbackDir).setY(0).normalize().multiplyScalar(msg.knockbackStrength)
    }
    // Status effect (max-duration stacking on same type): shock/freeze slow, burn/corrode DoT.
    if (msg && msg.status && msg.status.type) {
      const s = this.statusEffect, inc = msg.status
      if (s.type !== inc.type || inc.duration > s.duration) {
        s.type = inc.type; s.duration = inc.duration; s.dps = inc.dps || 0; s.dpsTimer = 0
      }
    }
    if (this.health <= 0) this.Die(msg)
  }

  Die(msg) {
    this.dying = true
    this.alive = false
    const i = activeZombies.indexOf(this)
    if (i !== -1) activeZombies.splice(i, 1)

    // Tally the kill (score + combo + wave progress). All death paths funnel through Die().
    if (this.director) this.director.ReportKill(this.scoreValue, this.root.position)

    // Knock the corpse away from the shooter.
    const impulse = new THREE.Vector3(0, 2.6, 0)
    const from = msg && msg.from && msg.from.Position ? msg.from.Position : null
    if (from) {
      _v.copy(this.root.position).sub(from).setY(0)
      if (_v.lengthSq() > 1e-4) impulse.addScaledVector(_v.normalize(), 5.0)
    }
    const twist = (Math.random() - 0.5) * 4

    if (this.mixer) this.mixer.stopAllAction()
    try {
      if (this.skinnedMesh) {
        this.ragdoll = new Ragdoll(this.skinnedMesh, {
          groundY: ARENA.floorY, impulse, twist, physicsWorld: this.world,
        })
      }
    } catch (e) {
      console.warn('[zombie] ragdoll build failed, falling back to sink:', e.message)
      this.ragdoll = null
    }
    this.lingerTimer = 4.2
  }

  Update(dt) {
    if (this.dying) {
      if (this.ragdoll) this.ragdoll.update(dt)
      else { this.root.position.y -= dt * 0.6; this.bodyGroup.scale.y = Math.max(0.1, this.bodyGroup.scale.y - dt) }
      this.lingerTimer -= dt
      if (this.lingerTimer <= 0) this.parent.parent.Remove(this.parent)
      return
    }

    // Status effect: shock/freeze slow the shamble + animation; burn/corrode tick damage.
    const status = this.statusEffect
    const speedMult = STATUS_SPEED_MULT[status.type] ?? 1.0
    if (status.type && status.duration > 0) {
      status.duration -= dt
      if (status.dps > 0) {
        status.dpsTimer += dt
        if (status.dpsTimer >= 0.25) {
          status.dpsTimer = 0
          this.hitFlashTimer = Math.max(this.hitFlashTimer, 0.08)
          this.health -= status.dps * 0.25
          if (this.health <= 0) { this.Die({}); return }
        }
      }
      if (status.duration <= 0) { status.type = null; status.dps = 0 }
    }

    if (this.mixer) this.mixer.update(dt * speedMult)

    // Hit-flash squash (from a stable base so repeated hits don't drift).
    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer -= dt
      const r = Math.max(0, this.hitFlashTimer / 0.15)
      this.bodyGroup.scale.set(1 + r * 0.15, 1 - r * 0.1, 1 + r * 0.15)
    } else {
      this.bodyGroup.scale.lerp(_v.set(1, 1, 1), dt * 8)
    }

    // Knockback impulse decays exponentially.
    if (this.knockbackVel.lengthSq() > 1e-4) {
      this.root.position.addScaledVector(this.knockbackVel, dt)
      this.knockbackVel.multiplyScalar(Math.pow(KNOCKBACK_DECAY, dt))
    }
    const stunned = this.knockbackVel.lengthSq() > 0.5

    const player = this.FindEntity('Player')
    const playerPos = player ? player.Position : null
    if (!playerPos) return

    const toPlayer = _v.set(playerPos.x - this.root.position.x, 0, playerPos.z - this.root.position.z)
    const dist = toPlayer.length()

    // Walk <-> attack crossfade on engagement range (the .enabled=true is load-bearing
    // in r127: play() doesn't re-enable a faded-out action, so a later fadeIn -> T-pose).
    if (this.walkAction && this.attackAction) {
      const desired = (dist <= this.attackRange && !stunned) ? 'attack' : 'walk'
      if (this.activeAnim !== desired) {
        if (desired === 'attack') {
          this.walkAction.fadeOut(0.2)
          this.attackAction.enabled = true
          this.attackAction.reset().play().fadeIn(0.2)
        } else {
          this.attackAction.fadeOut(0.2)
          this.walkAction.enabled = true
          this.walkAction.play().fadeIn(0.2)
        }
        this.activeAnim = desired
      }
    }

    const chasing = dist > this.attackRange && !stunned
    const preX = this.root.position.x, preZ = this.root.position.z
    if (chasing) {
      toPlayer.normalize()
      const eff = this.speed * speedMult
      this.root.position.x += toPlayer.x * eff * dt
      this.root.position.z += toPlayer.z * eff * dt
      this.root.rotation.y = Math.atan2(toPlayer.x, toPlayer.z)
    } else if (!stunned) {
      // Melee: chip the player on cooldown while in range.
      this.attackTimer -= dt
      if (this.attackTimer <= 0) {
        this.attackTimer = this.attackCooldown
        if (player) player.Broadcast({ topic: 'hit', amount: this.damage, from: this.parent })
      }
    }

    // Separation from other zombies, then push out of arena walls (final say).
    this.separate()
    this.resolveWalls()

    if (chasing) {
      const dx = this.root.position.x - preX, dz = this.root.position.z - preZ
      if (dx * dx + dz * dz > 1e-5) this.root.rotation.y = Math.atan2(dx, dz)
    }

    // Keep the entity position in sync (used by e.from.Position for hit feedback).
    this.parent.position.copy(this.root.position)
  }

  separate() {
    const pos = this.root.position
    for (const other of activeZombies) {
      if (other === this || !other.alive) continue
      const dx = pos.x - other.root.position.x
      const dz = pos.z - other.root.position.z
      const d = Math.hypot(dx, dz)
      const minD = this.hitRadius + other.hitRadius
      if (d < minD && d > 0.01) {
        const push = (minD - d) * 0.5
        pos.x += (dx / d) * push
        pos.z += (dz / d) * push
      }
    }
  }

  resolveWalls() {
    const radius = this.hitRadius * 0.7
    const r2 = radius * radius
    const pos = this.root.position
    for (const wall of ARENA.walls) {
      if (wall.isPlatform || wall.minY >= ENEMY_TOP_Y) continue
      if (wall.shape === 'cylinder') {
        const dx = pos.x - wall.cx, dz = pos.z - wall.cz
        const d2 = dx * dx + dz * dz
        const reach = radius + wall.radius
        if (d2 < reach * reach && d2 > 1e-4) {
          const d = Math.sqrt(d2)
          pos.x = wall.cx + (dx / d) * reach
          pos.z = wall.cz + (dz / d) * reach
        }
        continue
      }
      const insideX = pos.x > wall.minX && pos.x < wall.maxX
      const insideZ = pos.z > wall.minZ && pos.z < wall.maxZ
      if (insideX && insideZ) {
        const left = pos.x - wall.minX, right = wall.maxX - pos.x
        const near = pos.z - wall.minZ, far = wall.maxZ - pos.z
        const m = Math.min(left, right, near, far)
        if (m === left) pos.x = wall.minX - radius
        else if (m === right) pos.x = wall.maxX + radius
        else if (m === near) pos.z = wall.minZ - radius
        else pos.z = wall.maxZ + radius
        continue
      }
      const cx = insideX ? pos.x : (pos.x < wall.minX ? wall.minX : wall.maxX)
      const cz = insideZ ? pos.z : (pos.z < wall.minZ ? wall.minZ : wall.maxZ)
      const dx = pos.x - cx, dz = pos.z - cz
      const d2 = dx * dx + dz * dz
      if (d2 < r2 && d2 > 1e-4) {
        const d = Math.sqrt(d2)
        pos.x = cx + (dx / d) * radius
        pos.z = cz + (dz / d) * radius
      }
    }
  }

  GetHeadWorldPos(target) {
    if (this.headBone) return this.headBone.getWorldPosition(target)
    return target.copy(this.root.position).add(_v.set(0, 1.65, 0))
  }

  Dispose() {
    const i = activeZombies.indexOf(this)
    if (i !== -1) activeZombies.splice(i, 1)
    // Drop this body's splats + release the per-enemy patched material clones.
    if (this.decals) { try { this.decals.DisposeEnemy(this.bodyGroup) } catch (e) { /* noop */ } }
    if (this.ragdoll) { try { this.ragdoll.dispose() } catch (e) { /* noop */ } }
    if (this.root.parent) this.root.parent.remove(this.root)
  }
}

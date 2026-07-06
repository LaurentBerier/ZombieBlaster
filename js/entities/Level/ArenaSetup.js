// ArenaSetup — the neon Silo arena on the new engine (POC scope).
//
// Ports the procedural geometry from the original Zombie Blaster arena.js: a
// neon-walled room with a floor grid, hazard vats, pump units, ceiling pipes,
// platforms, and colored point lights. For the POC this builds ONE large OPEN
// room (the multi-room designer level from data/levelData.json + its GLB kit
// props is brought in a later milestone). It also builds Ammo STATIC colliders
// (floor + walls + props) so the player capsule, camera boom, ragdoll and weapon
// rays interact with the level. The `ARENA` export (walls[], spawnPoints[],
// group) feeds the zombie AI (direct-chase wall collision) and FX raycasts, same
// contract the old flat modules used.

import * as THREE from 'three'
import Component from '../../Component.js'
import { Ammo, CollisionFilterGroups } from '../../AmmoLib.js'
import { COLORS, NEON_PALETTE, createToonMaterial, addOutline } from '../Common/NeonMaterials.js'

// Shared arena data (mirrors the old arena.js ARENA object).
export const ARENA = {
  rooms: [],
  walls: [],        // AABB {minX,maxX,minY,maxY,minZ,maxZ} or {shape:'cylinder',cx,cz,radius,minY,maxY}
  spawnPoints: [],
  navPoints: [],
  group: null,
}

// POC layout: one large open neon room.
const ROOM = { name: 'silo_main', cx: 0, cz: 0, w: 46, h: 10, d: 46 }

// Props placed INSIDE the room (kept well within the walls).
const VAT_POSITIONS = [
  { x: -8, z: -8 }, { x: 8, z: -8 }, { x: -8, z: 8 }, { x: 8, z: 8 },
  { x: -16, z: 0 }, { x: 16, z: 0 }, { x: 0, z: 16 }, { x: 0, z: -16 },
]
const PUMP_POSITIONS = [
  { x: -14, z: -14, ry: 0 }, { x: 14, z: -14, ry: Math.PI },
  { x: -14, z: 14, ry: Math.PI / 2 }, { x: 14, z: 14, ry: -Math.PI / 2 },
]
const PLATFORMS = [
  { x: -10, y: 2.5, z: -10, w: 5, d: 5 },
  { x: 10, y: 2.5, z: -10, w: 5, d: 5 },
  { x: -10, y: 2.5, z: 10, w: 5, d: 5 },
  { x: 10, y: 2.5, z: 10, w: 5, d: 5 },
  { x: 0, y: 3.5, z: 0, w: 4, d: 4 },
]
const LIGHTS = [
  { x: -12, y: 4, z: -12, color: COLORS.magenta, intensity: 1.5, dist: 20 },
  { x: 12, y: 4, z: -12, color: COLORS.cyan, intensity: 1.5, dist: 20 },
  { x: -12, y: 4, z: 12, color: COLORS.lime, intensity: 1.5, dist: 20 },
  { x: 12, y: 4, z: 12, color: COLORS.orange, intensity: 1.5, dist: 20 },
  { x: 0, y: 6, z: 0, color: COLORS.violet, intensity: 2.2, dist: 30 },
  { x: -20, y: 5, z: 0, color: COLORS.cyan, intensity: 1.4, dist: 20 },
  { x: 20, y: 5, z: 0, color: COLORS.hotPink, intensity: 1.4, dist: 20 },
  { x: 0, y: 5, z: -20, color: COLORS.violet, intensity: 1.6, dist: 20 },
  { x: 0, y: 5, z: 20, color: COLORS.magenta, intensity: 1.6, dist: 20 },
]

export default class ArenaSetup extends Component {
  constructor(scene, physicsWorld) {
    super()
    this.name = 'ArenaSetup'
    this.scene = scene
    this.world = physicsWorld
    this._bodies = []
  }

  Initialize() {
    // Reset shared state (defensive against a re-boot without a page reload).
    ARENA.rooms.length = 0
    ARENA.walls.length = 0
    ARENA.spawnPoints.length = 0
    ARENA.navPoints.length = 0

    const group = new THREE.Group()
    group.name = 'arena'
    this.buildRoom(group, ROOM)
    this.addProps(group)
    this.addPipes(group)
    this.addPlatforms(group)
    this.addNeonLighting(group)
    this.scene.add(group)
    ARENA.group = group

    this.buildColliders()
    console.log(`[arena] built: ${ARENA.walls.length} wall/prop colliders, ${ARENA.spawnPoints.length} spawn points`)
  }

  buildRoom(parent, def) {
    const { cx, cz, w, h, d, name } = def
    const room = new THREE.Group()
    room.name = name

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), createToonMaterial(0x1a1a2e))
    floor.rotation.x = -Math.PI / 2
    floor.position.set(cx, 0, cz)
    floor.receiveShadow = true
    room.add(floor)

    const grid = new THREE.GridHelper(Math.max(w, d), Math.floor(Math.max(w, d) / 2), 0x2a2a4e, 0x1a1a3e)
    grid.position.set(cx, 0.02, cz)
    room.add(grid)

    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), createToonMaterial(0x0d0d1a))
    ceil.rotation.x = Math.PI / 2
    ceil.position.set(cx, h, cz)
    room.add(ceil)

    const wallThickness = 0.5
    const wallColor = 0x1e1e3a
    const accentColor = NEON_PALETTE[Math.floor(Math.random() * NEON_PALETTE.length)]

    const wallDefs = [
      { px: cx, pz: cz - d / 2, sx: w, sy: h, roty: 0 },
      { px: cx, pz: cz + d / 2, sx: w, sy: h, roty: Math.PI },
      { px: cx + w / 2, pz: cz, sx: d, sy: h, roty: -Math.PI / 2 },
      { px: cx - w / 2, pz: cz, sx: d, sy: h, roty: Math.PI / 2 },
    ]
    wallDefs.forEach(wd => {
      const wallGeo = new THREE.BoxGeometry(wd.sx, wd.sy, wallThickness)
      const wall = new THREE.Mesh(wallGeo, createToonMaterial(wallColor))
      wall.position.set(wd.px, wd.sy / 2, wd.pz)
      wall.rotation.y = wd.roty
      wall.receiveShadow = true
      room.add(wall)
      addOutline(wall, wallGeo, 1.01)

      const stripeGeo = new THREE.BoxGeometry(wd.sx, 0.15, wallThickness + 0.05)
      const stripe = new THREE.Mesh(stripeGeo, createToonMaterial(accentColor, accentColor, 0.3))
      stripe.position.set(wd.px, h * 0.75, wd.pz)
      stripe.rotation.y = wd.roty
      room.add(stripe)
      const stripe2 = stripe.clone(); stripe2.position.y = 0.3; room.add(stripe2)

      // Collision wall AABB.
      let minX, maxX, minZ, maxZ
      if (wd.roty === 0 || Math.abs(wd.roty) === Math.PI) {
        minX = wd.px - wd.sx / 2; maxX = wd.px + wd.sx / 2
        minZ = wd.pz - wallThickness / 2; maxZ = wd.pz + wallThickness / 2
      } else {
        minX = wd.px - wallThickness / 2; maxX = wd.px + wallThickness / 2
        minZ = wd.pz - wd.sx / 2; maxZ = wd.pz + wd.sx / 2
      }
      ARENA.walls.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: wd.sy })
    })

    const m = 4
    ARENA.spawnPoints.push(
      { x: cx - w / 2 + m, z: cz - d / 2 + m, room: name },
      { x: cx + w / 2 - m, z: cz - d / 2 + m, room: name },
      { x: cx - w / 2 + m, z: cz + d / 2 - m, room: name },
      { x: cx + w / 2 - m, z: cz + d / 2 - m, room: name },
      { x: cx, z: cz - d / 2 + m, room: name },
      { x: cx, z: cz + d / 2 - m, room: name },
    )
    ARENA.rooms.push({ name, cx, cz, w, h, d })
    parent.add(room)
  }

  addProps(parent) {
    const props = new THREE.Group(); props.name = 'props'
    VAT_POSITIONS.forEach((pos, i) => {
      const vat = this.createHazardVat(i)
      vat.position.set(pos.x, 0, pos.z)
      props.add(vat)
      ARENA.walls.push({ minX: pos.x - 0.9, maxX: pos.x + 0.9, minZ: pos.z - 0.9, maxZ: pos.z + 0.9, minY: 0, maxY: 2.5 })
    })
    PUMP_POSITIONS.forEach((pos, i) => {
      const pump = this.createPumpUnit(i)
      pump.position.set(pos.x, 0, pos.z)
      pump.rotation.y = pos.ry ?? 0
      props.add(pump)
      ARENA.walls.push({ minX: pos.x - 1.0, maxX: pos.x + 1.0, minZ: pos.z - 0.7, maxZ: pos.z + 0.7, minY: 0, maxY: 2.0 })
    })
    parent.add(props)
  }

  createHazardVat(index) {
    const root = new THREE.Group(); root.name = 'prop_hazard_vat'
    const glowColor = index % 2 === 0 ? COLORS.cyan : COLORS.lime
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 2.0, 12), createToonMaterial(0x333340))
    body.position.y = 1.0; root.add(body); addOutline(body, body.geometry, 1.04)
    const stripeMat = createToonMaterial(COLORS.yellow)
    const stripe1 = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.15, 12), stripeMat)
    stripe1.position.y = 1.7; root.add(stripe1)
    const stripe2 = stripe1.clone(); stripe2.position.y = 0.3; root.add(stripe2)
    const liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.6, 12), createToonMaterial(glowColor, glowColor, 1.0))
    liquid.position.y = 1.0; root.add(liquid)
    const light = new THREE.PointLight(glowColor, 0.6, 6); light.position.y = 1.0; root.add(light)
    return root
  }

  createPumpUnit(index) {
    const root = new THREE.Group(); root.name = 'prop_machinery_pump'
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 1.2), createToonMaterial(COLORS.magenta))
    body.position.y = 0.8; root.add(body); addOutline(body, body.geometry, 1.03)
    const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.8, 8), createToonMaterial(0x444455))
    piston.position.set(0, 1.8, 0); root.add(piston)
    const ledGeo = new THREE.SphereGeometry(0.06, 6, 6)
    const led1 = new THREE.Mesh(ledGeo, createToonMaterial(COLORS.magenta, COLORS.magenta, 1.0))
    const led2 = new THREE.Mesh(ledGeo, createToonMaterial(COLORS.cyan, COLORS.cyan, 1.0))
    led1.position.set(-0.2, 2.25, 0); led2.position.set(0.2, 2.25, 0); root.add(led1, led2)
    return root
  }

  addPipes(parent) {
    for (let x = -16; x <= 16; x += 8) {
      const pipe = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, ROOM.d, 6),
        createToonMaterial(0x2a2a40, NEON_PALETTE[Math.abs(x) % NEON_PALETTE.length], 0.2))
      pipe.rotation.x = Math.PI / 2
      pipe.position.set(x, ROOM.h - 1.5, 0)
      parent.add(pipe)
    }
  }

  addPlatforms(parent) {
    PLATFORMS.forEach(p => {
      const platGeo = new THREE.BoxGeometry(p.w, 0.4, p.d)
      const plat = new THREE.Mesh(platGeo, createToonMaterial(0x2a2a50, COLORS.cyan, 0.1))
      plat.position.set(p.x, p.y, p.z); plat.receiveShadow = true
      parent.add(plat); addOutline(plat, platGeo, 1.02)
      const edge = new THREE.Mesh(new THREE.BoxGeometry(p.w + 0.1, 0.05, p.d + 0.1), createToonMaterial(COLORS.cyan, COLORS.cyan, 0.5))
      edge.position.set(p.x, p.y + 0.21, p.z); parent.add(edge)
      ARENA.walls.push({
        minX: p.x - p.w / 2, maxX: p.x + p.w / 2, minZ: p.z - p.d / 2, maxZ: p.z + p.d / 2,
        minY: 0, maxY: p.y + 0.2, isPlatform: true, topY: p.y + 0.2,
      })
    })
  }

  addNeonLighting(parent) {
    LIGHTS.forEach(ld => {
      const light = new THREE.PointLight(ld.color, ld.intensity, ld.dist)
      light.position.set(ld.x, ld.y, ld.z)
      parent.add(light)
    })
  }

  // --- Ammo static colliders (floor + every ARENA.walls entry). ---
  buildColliders() {
    // Floor slab under the whole room.
    this._addStaticBox(ROOM.cx, -0.5, ROOM.cz, ROOM.w / 2 + 2, 0.5, ROOM.d / 2 + 2)
    for (const w of ARENA.walls) {
      if (w.shape === 'cylinder') {
        this._addStaticCylinder(w.cx, w.cz, w.radius, w.minY, w.maxY)
      } else {
        const cx = (w.minX + w.maxX) / 2, cy = (w.minY + w.maxY) / 2, cz = (w.minZ + w.maxZ) / 2
        const hx = Math.max(0.05, (w.maxX - w.minX) / 2)
        const hy = Math.max(0.05, (w.maxY - w.minY) / 2)
        const hz = Math.max(0.05, (w.maxZ - w.minZ) / 2)
        this._addStaticBox(cx, cy, cz, hx, hy, hz)
      }
    }
  }

  _addStaticBody(shape, cx, cy, cz) {
    const t = new Ammo.btTransform(); t.setIdentity()
    t.setOrigin(new Ammo.btVector3(cx, cy, cz))
    const motion = new Ammo.btDefaultMotionState(t)
    const inertia = new Ammo.btVector3(0, 0, 0)
    const info = new Ammo.btRigidBodyConstructionInfo(0, motion, shape, inertia)
    const body = new Ammo.btRigidBody(info)
    body.setFriction(1)
    this.world.addRigidBody(body, CollisionFilterGroups.StaticFilter, CollisionFilterGroups.AllFilter)
    this._bodies.push(body)
    return body
  }

  _addStaticBox(cx, cy, cz, hx, hy, hz) {
    this._addStaticBody(new Ammo.btBoxShape(new Ammo.btVector3(hx, hy, hz)), cx, cy, cz)
  }

  _addStaticCylinder(cx, cz, radius, minY, maxY) {
    const hy = Math.max(0.05, (maxY - minY) / 2)
    const shape = new Ammo.btCylinderShape(new Ammo.btVector3(radius, hy, radius))
    this._addStaticBody(shape, cx, (minY + maxY) / 2, cz)
  }

  Dispose() {
    for (const b of this._bodies) { try { this.world.removeRigidBody(b) } catch (e) { /* noop */ } }
    this._bodies.length = 0
  }
}

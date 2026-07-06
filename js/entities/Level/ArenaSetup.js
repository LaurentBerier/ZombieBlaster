// ArenaSetup — the REAL neon Silo arena, built from data/levelData.json + the GLB kit
// props (CorridorKit / arenaKit), ported from the original arena.js buildArena. Builds the
// room shell, instantiates the 70+ designer-placed custom-prop GLBs (cloned from a cache
// preloaded in entry.js), applies the designer AABB colliders, fits box/cylinder colliders
// to the solid props, and adds the level's point lights. Also builds Ammo STATIC colliders
// (floor + walls + props) for the player capsule / camera / ragdoll / weapon rays.
//
// The `ARENA` export (walls[], spawnPoints[], group, playerSpawn) feeds the zombie AI
// (direct-chase wall collision), the projectile FX, and the player spawn — same contract
// the old flat modules used.

import * as THREE from 'three'
import Component from '../../Component.js'
import { Ammo, CollisionFilterGroups } from '../../AmmoLib.js'
import { COLORS, NEON_PALETTE, createToonMaterial, addOutline } from '../Common/NeonMaterials.js'

export const ARENA = {
  rooms: [], walls: [], spawnPoints: [], navPoints: [], group: null, playerSpawn: null,
  // World Y of the visible standing surface. The designer floor prop sits ABOVE the synthetic
  // room-shell floor (y=0); this is measured from it in generatePropColliders so the floor
  // collider, ground splats, zombie feet + ragdoll all line up with the mesh the player sees.
  floorY: 0,
}

const DEFAULT_KIT = 'CorridorKit'
const ENEMY_TOP_Y = 2.0

export default class ArenaSetup extends Component {
  // levelData: parsed data/levelData.json. propCache: Map(url -> loaded gltf scene) for cloning.
  // kitMap: { filename -> kitFolder } from data/assetKits.json.
  constructor(scene, physicsWorld, levelData, propCache, kitMap) {
    super()
    this.name = 'ArenaSetup'
    this.scene = scene
    this.world = physicsWorld
    this.levelData = levelData || {}
    this.propCache = propCache || new Map()
    this.kitMap = kitMap || {}
    this._bodies = []
    this.room = null
  }

  Initialize() {
    ARENA.rooms.length = 0
    ARENA.walls.length = 0
    ARENA.spawnPoints.length = 0
    ARENA.navPoints.length = 0
    ARENA.floorY = 0

    const d = this.levelData
    const group = new THREE.Group()
    group.name = 'arena'

    const rooms = (d.rooms || []).length ? d.rooms : [{ id: 'main_hall', cx: 0, cz: 0, w: 40, h: 12, d: 40 }]
    rooms.forEach(r => this.buildRoom(group, { name: r.id, cx: r.cx, cz: r.cz, w: r.w, h: r.h, d: r.d }))
    this.room = { cx: rooms[0].cx, cz: rooms[0].cz, w: rooms[0].w, d: rooms[0].d }

    this.addCustomProps(group, d.customProps || [])
    this.addColliders(d.colliders || [])
    this.addLights(group, d.lights || [])

    this.scene.add(group)
    ARENA.group = group
    group.updateMatrixWorld(true)
    this.generatePropColliders(group)
    this.detectFloorY(group)

    ARENA.spawnPoints = (d.enemySpawns && d.enemySpawns.length)
      ? d.enemySpawns.map(s => ({ x: s.x, z: s.z }))
      : (ARENA.spawnPoints.length ? ARENA.spawnPoints : [{ x: rooms[0].cx, z: rooms[0].cz }])
    ARENA.playerSpawn = d.playerSpawn || { x: rooms[0].cx, y: 1.6, z: rooms[0].cz }

    this.buildColliders()
    console.log(`[arena] real level: ${(d.customProps || []).length} props, ${ARENA.walls.length} colliders, ${ARENA.spawnPoints.length} spawns`)
  }

  propUrl(asset) {
    const kit = this.kitMap[asset] ?? DEFAULT_KIT
    return `assets/${kit}/${asset}`
  }

  cloneProp(url) {
    const g = this.propCache.get(url)
    return g ? g.clone(true) : null
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
    const accent = NEON_PALETTE[Math.floor(Math.random() * NEON_PALETTE.length)]
    const wallDefs = [
      { px: cx, pz: cz - d / 2, sx: w, roty: 0 },
      { px: cx, pz: cz + d / 2, sx: w, roty: Math.PI },
      { px: cx + w / 2, pz: cz, sx: d, roty: -Math.PI / 2 },
      { px: cx - w / 2, pz: cz, sx: d, roty: Math.PI / 2 },
    ]
    wallDefs.forEach(wd => {
      const wallGeo = new THREE.BoxGeometry(wd.sx, h, wallThickness)
      const wall = new THREE.Mesh(wallGeo, createToonMaterial(0x1e1e3a))
      wall.position.set(wd.px, h / 2, wd.pz)
      wall.rotation.y = wd.roty
      wall.receiveShadow = true
      room.add(wall)
      addOutline(wall, wallGeo, 1.01)
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(wd.sx, 0.15, wallThickness + 0.05), createToonMaterial(accent, accent, 0.3))
      stripe.position.set(wd.px, h * 0.5, wd.pz)
      stripe.rotation.y = wd.roty
      room.add(stripe)

      let minX, maxX, minZ, maxZ
      if (wd.roty === 0 || Math.abs(wd.roty) === Math.PI) {
        minX = wd.px - wd.sx / 2; maxX = wd.px + wd.sx / 2
        minZ = wd.pz - wallThickness / 2; maxZ = wd.pz + wallThickness / 2
      } else {
        minX = wd.px - wallThickness / 2; maxX = wd.px + wallThickness / 2
        minZ = wd.pz - wd.sx / 2; maxZ = wd.pz + wd.sx / 2
      }
      ARENA.walls.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: h })
    })

    ARENA.rooms.push({ name, cx, cz, w, h, d })
    parent.add(room)
  }

  // Decide a collider shape from the prop filename (matches the original arena.js rules).
  classifyPropCollider(asset) {
    const a = (asset || '').toLowerCase()
    if (/floor|cieling|ceiling/.test(a)) return 'skip'
    if (/door|arch|entran|frame|gate|portal/.test(a)) return 'skip'
    if (/tank|barrel/.test(a)) return 'cylinder'
    return 'box'
  }

  addCustomProps(parent, defs) {
    const props = new THREE.Group()
    props.name = 'props'
    let added = 0, skipped = 0
    for (const def of defs) {
      if (!def || !def.asset) { skipped++; continue }
      const url = this.propUrl(def.asset)
      const root = new THREE.Group()
      root.name = def.id || 'custom'
      root.userData.colliderKind = this.classifyPropCollider(def.asset)
      root.userData.isFloor = /floor/.test((def.asset || '').toLowerCase())
      root.position.set(def.x ?? 0, def.y ?? 0, def.z ?? 0)
      root.rotation.set(def.rx ?? 0, def.ry ?? 0, def.rz ?? 0)
      let sx, sy, sz
      if (typeof def.sx === 'number' || typeof def.sy === 'number' || typeof def.sz === 'number') {
        sx = def.sx ?? 1; sy = def.sy ?? 1; sz = def.sz ?? 1
      } else { sx = sy = sz = def.scale ?? 1 }
      root.scale.set(sx, sy, sz)

      const mesh = this.cloneProp(url)
      if (mesh) {
        mesh.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
        if (sx * sy * sz < 0) this.applyDoubleSide(mesh)  // mirrored: flip culling
        root.add(mesh)
        props.add(root)
        added++
      } else { skipped++ }
    }
    parent.add(props)
    console.log(`[arena] custom props: ${added} placed, ${skipped} skipped`)
  }

  applyDoubleSide(root) {
    root.traverse(child => {
      if (!child.isMesh || !child.material) return
      const clone = m => { const c = m.clone(); c.side = THREE.DoubleSide; return c }
      child.material = Array.isArray(child.material) ? child.material.map(clone) : clone(child.material)
    })
  }

  // Fit a box/cylinder collider to each solid custom prop (matrices must be current).
  generatePropColliders(group) {
    const props = group.getObjectByName('props')
    if (!props) return
    const box = new THREE.Box3(), size = new THREE.Vector3(), center = new THREE.Vector3()
    let boxes = 0, cyl = 0
    props.children.forEach(root => {
      const kind = root.userData && root.userData.colliderKind
      if (!kind || kind === 'skip') return
      box.setFromObject(root)
      if (box.isEmpty()) return
      box.getSize(size); box.getCenter(center)
      if (kind === 'cylinder') {
        ARENA.walls.push({ shape: 'cylinder', cx: center.x, cz: center.z, radius: Math.max(0.1, (size.x + size.z) / 4), minY: box.min.y, maxY: box.max.y })
        cyl++
      } else {
        ARENA.walls.push({ minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y, minZ: box.min.z, maxZ: box.max.z })
        boxes++
      }
    })
    console.log(`[arena] fitted ${boxes} box + ${cyl} cylinder prop colliders`)
  }

  // Measure the visible standing surface directly under the player spawn: a downward ray from
  // high above it against the built arena. The highest hit below head height is the floor the
  // player lands on (the designer floor prop, ABOVE the synthetic shell floor at y=0). Robust
  // to raised floor-edge trim that a bbox-max heuristic would over-read.
  detectFloorY(group) {
    const s = this.levelData.playerSpawn || { x: this.room.cx, z: this.room.cz }
    const ray = new THREE.Raycaster(new THREE.Vector3(s.x, 100, s.z), new THREE.Vector3(0, -1, 0))
    ray.far = 200
    const hits = ray.intersectObject(group, true)
    let best = 0
    for (const h of hits) { if (h.point.y <= 2.0 && h.point.y > best) best = h.point.y }
    ARENA.floorY = best
    console.log(`[arena] floor surface under spawn: y=${best.toFixed(3)}`)
  }

  // Designer-authored AABB colliders (cx/cy/cz centre, w/h/d full extents).
  addColliders(defs) {
    let added = 0
    for (const c of defs) {
      const w = c.w ?? 0, h = c.h ?? 0, d = c.d ?? 0
      if (w <= 0 || h <= 0 || d <= 0) continue
      const cx = c.cx ?? 0, cy = c.cy ?? 0, cz = c.cz ?? 0
      ARENA.walls.push({ minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2, minZ: cz - d / 2, maxZ: cz + d / 2 })
      added++
    }
    console.log(`[arena] ${added} designer colliders`)
  }

  addLights(parent, defs) {
    for (const l of defs) {
      const color = Number(l.color)
      const light = new THREE.PointLight(isNaN(color) ? 0xffffff : color, l.intensity ?? 1, l.distance ?? 15)
      light.position.set(l.x ?? 0, l.y ?? 0, l.z ?? 0)
      parent.add(light)
    }
  }

  // --- Ammo static colliders (floor slab + every ARENA.walls entry). ---
  buildColliders() {
    const r = this.room
    // Floor slab: 1 m thick, its TOP flush with the visible floor (ARENA.floorY) so the player
    // capsule rests on the mesh it sees instead of sinking to y=0.
    if (r) this._addStaticBox(r.cx, ARENA.floorY - 0.5, r.cz, r.w / 2 + 2, 0.5, r.d / 2 + 2)
    for (const w of ARENA.walls) {
      if (w.shape === 'cylinder') {
        this._addStaticCylinder(w.cx, w.cz, w.radius, w.minY, w.maxY)
      } else {
        const cx = (w.minX + w.maxX) / 2, cy = (w.minY + w.maxY) / 2, cz = (w.minZ + w.maxZ) / 2
        this._addStaticBox(cx, cy, cz, Math.max(0.05, (w.maxX - w.minX) / 2), Math.max(0.05, (w.maxY - w.minY) / 2), Math.max(0.05, (w.maxZ - w.minZ) / 2))
      }
    }
  }

  _addStaticBody(shape, cx, cy, cz) {
    const t = new Ammo.btTransform(); t.setIdentity()
    t.setOrigin(new Ammo.btVector3(cx, cy, cz))
    const motion = new Ammo.btDefaultMotionState(t)
    const info = new Ammo.btRigidBodyConstructionInfo(0, motion, shape, new Ammo.btVector3(0, 0, 0))
    const body = new Ammo.btRigidBody(info)
    body.setFriction(1)
    this.world.addRigidBody(body, CollisionFilterGroups.StaticFilter, CollisionFilterGroups.AllFilter)
    this._bodies.push(body)
  }

  _addStaticBox(cx, cy, cz, hx, hy, hz) {
    this._addStaticBody(new Ammo.btBoxShape(new Ammo.btVector3(hx, hy, hz)), cx, cy, cz)
  }

  _addStaticCylinder(cx, cz, radius, minY, maxY) {
    const hy = Math.max(0.05, (maxY - minY) / 2)
    this._addStaticBody(new Ammo.btCylinderShape(new Ammo.btVector3(radius, hy, radius)), cx, (minY + maxY) / 2, cz)
  }

  // Debug: which collider AABBs/cylinders cover a given XZ within `margin` (diagnose spawn-blocking props).
  DebugCollidersAt(x, z, margin = 0) {
    return ARENA.walls.filter(w => w.shape === 'cylinder'
      ? Math.hypot(x - w.cx, z - w.cz) < w.radius + margin
      : (x >= w.minX - margin && x <= w.maxX + margin && z >= w.minZ - margin && z <= w.maxZ + margin))
      .map(w => w.shape === 'cylinder'
        ? { cyl: true, yTop: +w.maxY.toFixed(2), yBot: +w.minY.toFixed(2), r: +w.radius.toFixed(2) }
        : { yTop: +w.maxY.toFixed(2), yBot: +w.minY.toFixed(2), w: +(w.maxX - w.minX).toFixed(1), d: +(w.maxZ - w.minZ).toFixed(1) })
      .sort((a, b) => b.yTop - a.yTop)
  }

  Dispose() {
    for (const b of this._bodies) { try { this.world.removeRigidBody(b) } catch (e) { /* noop */ } }
    this._bodies.length = 0
  }
}

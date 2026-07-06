// ZombieSpawner — keeps a small live zombie population for the POC. Spawns zombie
// entities at runtime from the arena spawn points, up to a cap, on a timer. (The
// full wave/boss director from the old enemies.js/gameLogic.js comes in a later
// milestone — this just proves the enemies chase + ragdoll continuously.)
//
// Runtime entities are created AFTER EntityManager.EndSetup(), so their components
// are Initialized manually here rather than by EndSetup.

import * as THREE from 'three'
import Component from '../../Component.js'
import Entity from '../../Entity.js'
import ZombieController, { activeZombies } from './ZombieController.js'
import { ARENA } from '../Level/ArenaSetup.js'
import { ENEMY_TYPES, TYPE_MODEL, statsFor } from './enemyTypes.js'

export default class ZombieSpawner extends Component {
  // assetsByType = { Zombie_1: {scene,walk,attack,death}, Zombie_2: {...}, ... } — one GLB set
  // per character model; the enemy TYPE picks which via TYPE_MODEL.
  constructor(assetsByType, scene, physicsWorld, opts = {}) {
    super()
    this.name = 'ZombieSpawner'
    this.assetsByType = assetsByType
    this.scene = scene
    this.world = physicsWorld
    this.maxAlive = opts.maxAlive ?? 8
    this.interval = opts.interval ?? 1.8
    this.timer = opts.firstDelay ?? 1.0
    this._id = 0
  }

  Initialize() {
    this.manager = this.parent.parent   // EntityManager
    // When a GameDirector is present it drives spawning wave-by-wave; the spawner then only
    // provides spawnOne() and does NOT auto-spawn. Absent a director (bare POC harness) it
    // falls back to the old continuous trickle so the enemies still appear.
    this.director = this.FindEntity('GameDirector')?.GetComponent('GameDirector') || null
  }

  Update(dt) {
    if (this.director) return    // director-controlled — see GameDirector.updateWaves
    this.timer -= dt
    if (this.timer > 0) return
    if (activeZombies.length >= this.maxAlive) { this.timer = 0.5; return }
    this.timer = this.interval
    this.spawnType(ENEMY_TYPES.ZOMBIE, statsFor(ENEMY_TYPES.ZOMBIE, 1))
  }

  // Spawn a specific enemy TYPE (its GLB set via TYPE_MODEL) with the given per-wave stats.
  // Returns the new ZombieController.
  spawnType(type, stats = {}) {
    const model = TYPE_MODEL[type] || 'Zombie_1'
    const assets = this.assetsByType[model] || this.assetsByType.Zombie_1
    if (!assets) return null

    const points = ARENA.spawnPoints
    let x = (Math.random() - 0.5) * 30, z = (Math.random() - 0.5) * 30
    if (points && points.length) {
      const p = points[Math.floor(Math.random() * points.length)]
      x = p.x + (Math.random() - 0.5) * 4
      z = p.z + (Math.random() - 0.5) * 4
    }

    const entity = new Entity()
    entity.SetName(`Zombie${this._id++}`)
    entity.SetPosition(new THREE.Vector3(x, ARENA.floorY, z))
    const controller = new ZombieController(assets, this.scene, this.world, stats)
    entity.AddComponent(controller)
    this.manager.Add(entity)
    // EndSetup already ran — initialize this runtime entity's components now.
    for (const k in entity.components) entity.components[k].Initialize()
    return controller
  }

  // Back-compat: spawn a base grunt (used by the director-less fallback + the test probes).
  spawnOne(stats) {
    return this.spawnType(ENEMY_TYPES.ZOMBIE, stats || statsFor(ENEMY_TYPES.ZOMBIE, 1))
  }
}

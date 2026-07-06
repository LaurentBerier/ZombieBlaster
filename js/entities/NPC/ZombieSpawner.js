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

export default class ZombieSpawner extends Component {
  // assets = { scene, walk, attack, death } shared across all zombies.
  constructor(assets, scene, physicsWorld, opts = {}) {
    super()
    this.name = 'ZombieSpawner'
    this.assets = assets
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
    this.spawnOne()
  }

  // Spawn one zombie at a random arena spawn point. `stats` (optional) overrides the per-wave
  // health/speed/damage/scoreValue. Returns the new ZombieController.
  spawnOne(stats = {}) {
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
    const controller = new ZombieController(this.assets, this.scene, this.world, stats)
    entity.AddComponent(controller)
    this.manager.Add(entity)
    // EndSetup already ran — initialize this runtime entity's components now.
    for (const k in entity.components) entity.components[k].Initialize()
    return controller
  }
}

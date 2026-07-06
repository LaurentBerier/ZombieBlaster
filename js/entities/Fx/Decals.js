// Decals — runtime SHADER-PROJECTED impact splats on the skinned zombies, ported from the
// original flat js/decals.js DecalManager onto the template's Entity/Component framework.
//
// Bullet impacts stamp opaque comic-paint splats (green gore / blue plasma / cyan slime /
// burn) onto the zombie surface at the hit location. The enemy materials are patched
// (onBeforeCompile) with up to 8 projector slots each; each projector is an oriented box
// anchored to the skeleton bone the shot passed closest to, rebuilt from that bone's live
// matrixWorld EVERY FRAME — so the splat rides the walk/attack animation AND the death
// ragdoll by construction, and no CPU code ever samples skinned vertices (unreliable for
// SkeletonUtils clones in three r127/r129).
//
// A single instance lives on the 'Level' entity. ZombieController.buildModel() calls
// PrepareEnemy() to clone+patch the zombie's materials; ProjectileSystem calls SpawnImpact()
// on a landed hit; ZombieController.Dispose() calls DisposeEnemy() before the body is dropped.
//
// This port keeps the shader path + a curved-shell bone fallback (for the rare material the
// shader can't patch); the original's static-target DecalGeometry path is dropped — the
// zombies are always skinned with impactBones, so they never took it. Splat art is fully
// procedural (comic paint drawn to a canvas atlas), so no texture assets are required.

import * as THREE from 'three'
import Component from '../../Component.js'

// Hard limits keep draw calls and fill rate bounded during sustained fire
// (the Soda Laser lands ~20 hits/sec on a single target).
const MAX_TOTAL_DECALS = 80
// Also the projector-slot count baked into the patched enemy shader.
const MAX_DECALS_PER_ENEMY = 8
const PER_ENEMY_SPAWN_INTERVAL = 0.09 // min seconds between decals on one enemy
const DECAL_LIFETIME = 7.0
const DECAL_FADE_TIME = 1.6
const QUICK_FADE_TIME = 0.3  // fade used when a cap evicts the oldest decal
// A bone sits inside the body, so the fallback shell is pushed this far along the hit normal.
const BONE_SURFACE_OFFSET = 0.2
// Shader path: the projector box centre is pushed this far out from the bone toward the skin
// so the surface sits near box centre (full opacity) while the box stays shallow — deep enough
// to cover the body-part thickness, not enough to reach a second part (a forearm over the chest).
const SHADER_BOX_SURFACE_OFFSET = 0.18
// Shell curvature: unit-width patch wrapping a radius-1.4 cylinder (~40 deg arc).
const SHELL_WRAP_RADIUS = 1.4

// Decal type registry. Each stamps as OPAQUE paint that REPLACES the zombie texture (not
// additive) with a `glow` emissive floor so the splat stays vivid in the dark neon corridors.
const DECAL_TYPE_DEFS = {
  blood:   { procedural: { core: '96,208,40',  edge: '30,92,14',  variants: 2 }, opacity: 1.0, glow: 0.3 },
  slime:   { procedural: { core: '40,205,245', edge: '6,80,120',  variants: 2 }, opacity: 1.0, glow: 0.22 },
  toxic:   { procedural: { core: '150,255,50', edge: '30,120,10', variants: 2 }, opacity: 1.0, glow: 0.22 },
  dirt:    { procedural: { core: '135,105,72', edge: '60,44,28',  variants: 2 }, opacity: 1.0, glow: 0.1 },
  burn:    { procedural: { core: '34,28,24',   edge: '10,8,8', ember: '255,120,25', variants: 2 }, opacity: 1.0, glow: 0.12 },
  generic: { procedural: { core: '120,120,132', edge: '40,40,48', variants: 1 }, opacity: 1.0, glow: 0.15 },
  plasma:  { procedural: { core: '80,150,255', edge: '24,60,150', variants: 2 }, opacity: 1.0, glow: 0.3 },
}
DECAL_TYPE_DEFS.acid = DECAL_TYPE_DEFS.toxic

// ---- Injected GLSL (skinned enemies). Vertex stage exports the deformed world pos/normal;
// fragment stage tests each projector box and stamps the atlas splat where the surface lies
// inside it. r127 chunk names (<skinning_vertex>, <map_fragment>, roughness/metalness) match. ----

const DECAL_VERTEX_PARS = `
varying vec3 vDecalWorldPos;
varying vec3 vDecalWorldNormal;
`

const DECAL_VERTEX_MAIN = `
vDecalWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vDecalWorldNormal = normalize( transpose( inverse( mat3( modelMatrix ) ) ) * objectNormal );
`

const DECAL_FRAGMENT_PARS = `
uniform sampler2D uDecalAtlas;
uniform int uDecalCount;
uniform mat4 uDecalMatrix[${MAX_DECALS_PER_ENEMY}];
uniform vec4 uDecalUvRect[${MAX_DECALS_PER_ENEMY}];
uniform vec4 uDecalColor[${MAX_DECALS_PER_ENEMY}];
uniform vec4 uDecalParams[${MAX_DECALS_PER_ENEMY}];
varying vec3 vDecalWorldPos;
varying vec3 vDecalWorldNormal;
`

function decalFragmentMain(hasEmissive) {
  const emitLine = hasEmissive
    ? 'decalEmissive += decalGlow;'
    : 'diffuseColor.rgb += decalGlow;'
  return `
vec3 decalEmissive = vec3( 0.0 );
float gDecalMask = 0.0;
{
    vec3 decalWorldNormal = normalize( vDecalWorldNormal );
    for ( int i = 0; i < ${MAX_DECALS_PER_ENEMY}; i ++ ) {
        if ( i >= uDecalCount ) break;
        if ( uDecalColor[ i ].a <= 0.001 ) continue;
        vec4 decalPos = uDecalMatrix[ i ] * vec4( vDecalWorldPos, 1.0 );
        vec3 decalAbs = abs( decalPos.xyz );
        if ( decalAbs.x > 0.5 || decalAbs.y > 0.5 || decalAbs.z > 0.5 ) continue;
        vec3 decalNormal = normalize( mat3( uDecalMatrix[ i ] ) * decalWorldNormal );
        if ( decalNormal.z < 0.1 ) continue;
        vec2 decalUv = uDecalUvRect[ i ].xy + ( decalPos.xy + 0.5 ) * uDecalUvRect[ i ].zw;
        vec4 decalTexel = sRGBToLinear( texture2D( uDecalAtlas, decalUv ) );
        float decalFade = uDecalColor[ i ].a
            * smoothstep( 0.5, 0.47, decalAbs.z )
            * smoothstep( 0.1, 0.16, decalNormal.z );
        float decalCore = smoothstep( 0.32, 0.6, decalTexel.a );
        float decalRim = smoothstep( 0.14, 0.3, decalTexel.a )
            * ( 1.0 - smoothstep( 0.32, 0.58, decalTexel.a ) );
        vec3 decalRgb = decalTexel.rgb * uDecalColor[ i ].rgb * 1.1;
        float coreA = decalCore * decalFade;
        float rimA = clamp( decalRim * decalFade * 0.85, 0.0, 1.0 );
        if ( uDecalParams[ i ].x > 0.5 ) {
            vec3 decalGlow = decalRgb * coreA;
            ${emitLine}
        } else {
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.0 ), rimA );
            diffuseColor.rgb = mix( diffuseColor.rgb, decalRgb, coreA );
            vec3 decalGlow = decalRgb * coreA * uDecalParams[ i ].y;
            ${emitLine}
            gDecalMask = max( gDecalMask, max( coreA, rimA ) );
        }
    }
}
`
}

// Bump when the injected GLSL changes — it IS the program cache key, so all patched enemy
// materials with equal base parameters share one compile.
const DECAL_SHADER_CACHE_KEY = 'sandscape_impact_decals_v13'

// Shared scratch (single-threaded render loop).
const _FORWARD = new THREE.Vector3(0, 0, 1)
const _dir = new THREE.Vector3()
const _normal = new THREE.Vector3()
const _burstPoint = new THREE.Vector3()
const _anchor = new THREE.Vector3()
const _bonePos = new THREE.Vector3()
const _rayOrigin = new THREE.Vector3()
const _ray = new THREE.Ray()
const _projQuat = new THREE.Quaternion()
const _rollQuat = new THREE.Quaternion()
const _decalSize = new THREE.Vector3()
const _projWorld = new THREE.Matrix4()
const _worldQuat = new THREE.Quaternion()
const _parentQuat = new THREE.Quaternion()
const _parentScale = new THREE.Vector3()
const _tintColor = new THREE.Color()
const _rootsUpdated = new Set()

function isSupportedDecalMaterial(material) {
  return !!material && (
    material.isMeshStandardMaterial || material.isMeshPhysicalMaterial
    || material.isMeshPhongMaterial || material.isMeshLambertMaterial
    || material.isMeshBasicMaterial
  )
}

export default class Decals extends Component {
  constructor(scene, camera) {
    super()
    this.name = 'Decals'
    this.scene = scene
    this.camera = camera || null

    this.shellGeometry = null
    this.atlasTexture = null
    this.atlasUniform = null
    // def object -> [{ material, aspect }] for the shell fallback path.
    this.typePrototypes = new Map()
    // enemy -> per-enemy shader state (uniform banks + slot bookkeeping).
    this.decalStates = new WeakMap()
    // enemy -> managerTime of its last decal (throttle).
    this.lastSpawnTimes = new WeakMap()
    this.activeDecals = []
    this.managerTime = 0
  }

  Initialize() {
    this.shellGeometry = this.createShellGeometry()
    this.buildDecalAtlas()
    Object.values(DECAL_TYPE_DEFS).forEach(def => {
      if (this.typePrototypes.has(def)) return // alias already built
      this.typePrototypes.set(def, this.buildTypePrototypes(def))
    })
  }

  // ---- Public API (called by ZombieController / ProjectileSystem) ----

  // Clone + patch a freshly built zombie's skinned materials for shader decals. cloneAsset
  // shares materials across GLB instances, so per-enemy uniforms require per-enemy clones.
  PrepareEnemy(enemy) {
    if (!enemy || !enemy.bodyGroup) return

    let state = this.decalStates.get(enemy)
    if (!state) {
      state = createDecalState()
      this.decalStates.set(enemy, state)
    }
    for (let i = 0; i < MAX_DECALS_PER_ENEMY; i++) {
      state.slots[i] = null
      state.uColors.value[i].w = 0
    }
    state.uCount.value = 0
    state.patched = false

    enemy.bodyGroup.traverse(child => {
      if (!child.isSkinnedMesh || !child.material) return
      if (Array.isArray(child.material)) {
        child.material = child.material.map(mat => {
          if (!isSupportedDecalMaterial(mat)) return mat
          const clone = mat.clone()
          this.patchDecalMaterial(clone, state)
          state.patched = true
          return clone
        })
      } else if (isSupportedDecalMaterial(child.material)) {
        const clone = child.material.clone()
        this.patchDecalMaterial(clone, state)
        child.material = clone
        state.patched = true
      }
    })
  }

  // Dispose the per-enemy patched material clones before the old GLB is discarded, so the
  // renderer program refcounts are released (a slow leak otherwise over a long session).
  DisposeEnemy(bodyGroup) {
    if (!bodyGroup) return
    // Drop any live decals belonging to this body first.
    for (let i = this.activeDecals.length - 1; i >= 0; i--) {
      const e = this.activeDecals[i]
      if (e.owner && e.owner.bodyGroup === bodyGroup) this.destroyDecal(e)
    }
    bodyGroup.traverse(child => {
      const mat = child.material
      if (!mat) return
      const mats = Array.isArray(mat) ? mat : [mat]
      mats.forEach(m => { if (m && m.userData && m.userData.decalState) m.dispose() })
    })
  }

  // Stamp an impact decal on an enemy at the bullet hit location.
  //   opts.scale / scaleMult / count / ignoreThrottle / lifetime / tint
  SpawnImpact(enemy, hitPoint, impactDir, type = 'blood', opts = {}) {
    if (!enemy || !enemy.alive || !hitPoint) return

    if (!opts.ignoreThrottle) {
      const last = this.lastSpawnTimes.get(enemy)
      if (last !== undefined && this.managerTime - last < PER_ENEMY_SPAWN_INTERVAL) return
      this.lastSpawnTimes.set(enemy, this.managerTime)
    }

    const def = DECAL_TYPE_DEFS[type] || DECAL_TYPE_DEFS.generic

    if (impactDir && impactDir.lengthSq() > 0.0001) {
      _dir.copy(impactDir)
    } else if (this.camera) {
      _dir.copy(hitPoint).sub(this.camera.position)
    } else {
      _dir.set(0, 0, -1)
    }
    if (_dir.lengthSq() < 0.0001) _dir.set(0, 0, -1)
    _dir.normalize()
    _normal.copy(_dir).multiplyScalar(-1)

    const count = Math.max(1, Math.floor(opts.count ?? 1))
    const scaleMult = opts.scaleMult ?? 1
    const baseScale = (opts.scale
      ?? Math.min(0.55, Math.max(0.26, (enemy.hitRadius || 0.7) * 0.42))) * scaleMult
    const spread = (enemy.hitRadius || 0.7) * 0.6

    for (let n = 0; n < count; n++) {
      if (n === 0) {
        _burstPoint.copy(hitPoint)
      } else {
        _burstPoint.set(
          hitPoint.x + (Math.random() - 0.5) * spread,
          hitPoint.y + (Math.random() - 0.5) * spread,
          hitPoint.z + (Math.random() - 0.5) * spread
        )
      }
      const size = baseScale * (0.9 + Math.random() * 0.4)
      const roll = Math.random() * Math.PI * 2

      let entry = null
      if (enemy.impactBones && enemy.impactBones.length > 0) {
        entry = this.spawnShaderDecal(enemy, _burstPoint, _dir, _normal, size, roll, def, opts)
      }
      if (!entry) {
        entry = this.spawnBoneShellDecal(enemy, _burstPoint, _dir, _normal, size, roll, def, opts)
      }
      if (!entry) continue

      this.activeDecals.push(entry)
    }

    this.enforceCaps(enemy)
  }

  // ---- Component tick ----

  Update(dt) {
    this.managerTime += dt
    _rootsUpdated.clear()

    for (let i = this.activeDecals.length - 1; i >= 0; i--) {
      const entry = this.activeDecals[i]
      const owner = entry.owner
      // Owner despawned: drop instantly so no splat lingers where a corpse was.
      if (owner && !owner.alive && !owner.dying) {
        this.destroyDecal(entry)
        continue
      }
      entry.lifetime -= dt
      if (entry.lifetime <= 0) { this.destroyDecal(entry); continue }
      const fade = entry.lifetime < entry.fadeTime ? entry.lifetime / entry.fadeTime : 1

      if (entry.kind === 'shader') {
        if (owner && !_rootsUpdated.has(owner)) {
          owner.root.updateWorldMatrix(true, true)
          _rootsUpdated.add(owner)
        }
        _projWorld.multiplyMatrices(entry.bone.matrixWorld, entry.localMatrix)
        entry.state.uMatrices.value[entry.slot].copy(_projWorld).invert()
        entry.state.uColors.value[entry.slot].w = entry.baseOpacity * fade
      } else if (fade < 1) {
        entry.mesh.material.opacity = entry.baseOpacity * fade
      }
    }
  }

  Dispose() {
    while (this.activeDecals.length > 0) this.destroyDecal(this.activeDecals[0])
  }

  // ---- Shader path ----

  patchDecalMaterial(material, state) {
    material.userData.decalState = state
    material.customProgramCacheKey = () => DECAL_SHADER_CACHE_KEY
    const atlasUniform = this.atlasUniform
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uDecalAtlas = atlasUniform
      shader.uniforms.uDecalCount = state.uCount
      shader.uniforms.uDecalMatrix = state.uMatrices
      shader.uniforms.uDecalUvRect = state.uRects
      shader.uniforms.uDecalColor = state.uColors
      shader.uniforms.uDecalParams = state.uParams

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + DECAL_VERTEX_PARS)
        .replace('#include <skinning_vertex>', '#include <skinning_vertex>\n' + DECAL_VERTEX_MAIN)

      const hasEmissive = shader.fragmentShader.includes('#include <emissivemap_fragment>')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + DECAL_FRAGMENT_PARS)
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + decalFragmentMain(hasEmissive))
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, 0.92, gDecalMask );')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = mix( metalnessFactor, 0.0, gDecalMask );')
      if (hasEmissive) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= ( 1.0 - gDecalMask );\n\ttotalEmissiveRadiance += decalEmissive;'
        )
      }
    }
    material.needsUpdate = true
  }

  // The bone the shot line passed closest to (tie-break toward the impact point).
  pickImpactBone(enemy, hitPoint, dir) {
    const bones = enemy.impactBones
    if (!bones || bones.length === 0) return null
    enemy.root.updateWorldMatrix(true, true)
    _rayOrigin.copy(hitPoint).addScaledVector(dir, -4.0)
    _ray.set(_rayOrigin, dir)

    let bestBone = null
    let bestScore = Infinity
    for (let i = 0; i < bones.length; i++) {
      bones[i].getWorldPosition(_bonePos)
      const score = _ray.distanceSqToPoint(_bonePos)
        + _bonePos.distanceToSquared(hitPoint) * 0.15
      if (score < bestScore) { bestScore = score; bestBone = bones[i] }
    }
    return bestBone
  }

  // Claim a projector slot in the enemy's patched shader; store the projector bone-relative
  // so Update can rebuild the world->projector matrix from the bone's live pose each frame.
  spawnShaderDecal(enemy, hitPoint, dir, normal, size, roll, def, opts) {
    const state = this.decalStates.get(enemy)
    if (!state || !state.patched || !def.rects || def.rects.length === 0) return null
    const bone = this.pickImpactBone(enemy, hitPoint, dir)
    if (!bone) return null

    bone.getWorldPosition(_anchor)
    _anchor.addScaledVector(normal, SHADER_BOX_SURFACE_OFFSET)
    _projQuat.setFromUnitVectors(_FORWARD, normal)
    _rollQuat.setFromAxisAngle(_FORWARD, roll)
    _projQuat.multiply(_rollQuat)
    _decalSize.set(size, size, Math.min(0.72, Math.max(size, 0.5)))
    _projWorld.compose(_anchor, _projQuat, _decalSize)

    let slot = state.slots.indexOf(null)
    if (slot === -1) {
      let oldest = state.slots[0]
      for (let i = 1; i < MAX_DECALS_PER_ENEMY; i++) {
        if (state.slots[i].spawnTime < oldest.spawnTime) oldest = state.slots[i]
      }
      slot = oldest.slot
      this.destroyDecal(oldest)
    }

    const localMatrix = new THREE.Matrix4()
      .copy(bone.matrixWorld).invert().multiply(_projWorld)

    const rect = def.rects[Math.floor(Math.random() * def.rects.length)]
    const baseOpacity = def.opacity ?? 0.85
    _tintColor.setHex(opts.tint ?? def.tint ?? 0xffffff)
    state.uRects.value[slot].copy(rect)
    state.uColors.value[slot].set(_tintColor.r, _tintColor.g, _tintColor.b, baseOpacity)
    state.uParams.value[slot].set(def.additive ? 1 : 0, def.glow ?? 0, 0, 0)
    state.uMatrices.value[slot].copy(_projWorld).invert()
    if (state.uCount.value < slot + 1) state.uCount.value = slot + 1

    const entry = {
      kind: 'shader',
      owner: enemy,
      state, slot, bone, localMatrix,
      lifetime: opts.lifetime ?? DECAL_LIFETIME,
      fadeTime: DECAL_FADE_TIME,
      baseOpacity,
      spawnTime: this.managerTime,
    }
    state.slots[slot] = entry
    return entry
  }

  // ---- Shell fallback (skinned enemy whose material couldn't be shader-patched) ----

  spawnBoneShellDecal(enemy, hitPoint, dir, normal, size, roll, def, opts) {
    const prototypes = this.typePrototypes.get(def)
    if (!prototypes || prototypes.length === 0) return null
    if (!enemy.impactBones || enemy.impactBones.length === 0) return null
    const bone = this.pickImpactBone(enemy, hitPoint, dir)
    if (!bone) return null

    const proto = prototypes[Math.floor(Math.random() * prototypes.length)]
    const material = proto.material.clone()
    if (opts.tint !== undefined) material.color.setHex(opts.tint)

    bone.getWorldPosition(_anchor)
    _anchor.addScaledVector(normal, BONE_SURFACE_OFFSET)
    const mesh = this.spawnShellDecalAt(_anchor, normal, size, proto.aspect, roll, material, bone)
    mesh.name = 'impact_decal'
    mesh.renderOrder = 6
    mesh.frustumCulled = false

    return {
      kind: 'mesh',
      mesh,
      owner: enemy,
      lifetime: opts.lifetime ?? DECAL_LIFETIME,
      fadeTime: DECAL_FADE_TIME,
      baseOpacity: material.opacity,
      spawnTime: this.managerTime,
    }
  }

  // Place a shell decal at a world position/orientation, then re-parent to `parent` (bone),
  // preserving the world transform and countering the bone's inherited unit-correction scale.
  spawnShellDecalAt(worldPos, normal, size, aspect, roll, material, parent) {
    const mesh = new THREE.Mesh(this.shellGeometry, material)
    mesh.position.copy(worldPos)
    mesh.quaternion.setFromUnitVectors(_FORWARD, normal)
    mesh.rotateZ(roll)
    mesh.scale.set(size * aspect, size, size)

    parent.updateWorldMatrix(true, false)
    _worldQuat.copy(mesh.quaternion)
    parent.worldToLocal(mesh.position)
    parent.getWorldQuaternion(_parentQuat).invert()
    parent.getWorldScale(_parentScale)
    const inherited = Math.max(0.0001,
      (Math.abs(_parentScale.x) + Math.abs(_parentScale.y) + Math.abs(_parentScale.z)) / 3)
    mesh.quaternion.copy(_worldQuat).premultiply(_parentQuat)
    mesh.scale.multiplyScalar(1 / inherited)
    parent.add(mesh)
    return mesh
  }

  // ---- Lifetime / caps / cleanup ----

  enforceCaps(enemy) {
    let count = 0
    let oldest = null
    for (let i = 0; i < this.activeDecals.length; i++) {
      const entry = this.activeDecals[i]
      if (entry.kind !== 'mesh' || entry.owner !== enemy) continue
      if (entry.fadeTime === QUICK_FADE_TIME) continue
      count++
      if (!oldest) oldest = entry
    }
    if (count > MAX_DECALS_PER_ENEMY && oldest) {
      oldest.lifetime = Math.min(oldest.lifetime, QUICK_FADE_TIME)
      oldest.fadeTime = QUICK_FADE_TIME
    }
    while (this.activeDecals.length > MAX_TOTAL_DECALS) {
      this.destroyDecal(this.activeDecals[0])
    }
  }

  destroyDecal(entry) {
    const idx = this.activeDecals.indexOf(entry)
    if (idx !== -1) this.activeDecals.splice(idx, 1)

    if (entry.kind === 'shader') {
      const state = entry.state
      if (state.slots[entry.slot] === entry) {
        state.slots[entry.slot] = null
        state.uColors.value[entry.slot].w = 0
        refreshSlotCount(state)
      }
      return
    }

    const mesh = entry.mesh
    if (!mesh) return
    if (mesh.parent) mesh.parent.remove(mesh)
    if (mesh.geometry && mesh.geometry !== this.shellGeometry) mesh.geometry.dispose()
    mesh.material.dispose()
  }

  // ---- Geometry / texture setup ----

  createShellGeometry() {
    const geo = new THREE.PlaneGeometry(1, 1, 6, 1)
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const theta = pos.getX(i) / SHELL_WRAP_RADIUS
      pos.setX(i, Math.sin(theta) * SHELL_WRAP_RADIUS)
      pos.setZ(i, (Math.cos(theta) - 1) * SHELL_WRAP_RADIUS)
    }
    geo.computeVertexNormals()
    return geo
  }

  // Compose every splat variant into one atlas (256px cells, 4 columns) and record each
  // type's uv rects. Fully procedural (no art assets needed).
  buildDecalAtlas() {
    const defs = []
    const seenDefs = new Set()
    Object.values(DECAL_TYPE_DEFS).forEach(def => {
      if (seenDefs.has(def)) return
      seenDefs.add(def)
      defs.push(def)
    })

    const cells = []
    defs.forEach(def => {
      def.rects = []
      const variants = def.procedural?.variants ?? 1
      for (let v = 0; v < variants; v++) cells.push({ def })
    })

    const CELL = 256
    const COLS = 4
    const rows = Math.max(1, Math.ceil(cells.length / COLS))
    const canvas = document.createElement('canvas')
    canvas.width = COLS * CELL
    canvas.height = rows * CELL
    const ctx = canvas.getContext('2d')

    cells.forEach((cell, i) => {
      const ox = (i % COLS) * CELL
      const oy = Math.floor(i / COLS) * CELL
      drawProceduralSplat(ctx, ox, oy, CELL, cell.def.procedural || {})
      cell.def.rects.push(new THREE.Vector4(
        ox / canvas.width, oy / canvas.height,
        CELL / canvas.width, CELL / canvas.height
      ))
    })

    const tex = new THREE.CanvasTexture(canvas)
    tex.flipY = false
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    this.atlasTexture = tex
    this.atlasUniform = { value: tex }
  }

  buildTypePrototypes(def) {
    const variants = def.procedural?.variants ?? 1
    const entries = []
    for (let i = 0; i < variants; i++) {
      entries.push(createDecalMaterial(def, createProceduralSplatTexture(def.procedural)))
    }
    return entries.map(material => ({ material, aspect: 1 }))
  }
}

// ---- Module helpers (no per-instance state) ----

function createDecalState() {
  const bank = Ctor => ({
    value: Array.from({ length: MAX_DECALS_PER_ENEMY }, () => new Ctor()),
  })
  return {
    patched: false,
    slots: new Array(MAX_DECALS_PER_ENEMY).fill(null),
    uCount: { value: 0 },
    uMatrices: bank(THREE.Matrix4),
    uRects: bank(THREE.Vector4),
    uColors: bank(THREE.Vector4), // rgb tint, a opacity (0 = slot off)
    uParams: bank(THREE.Vector4), // x = additive flag, y = glow
  }
}

function refreshSlotCount(state) {
  let count = 0
  for (let i = 0; i < MAX_DECALS_PER_ENEMY; i++) {
    if (state.slots[i]) count = i + 1
  }
  state.uCount.value = count
}

function createDecalMaterial(def, texture) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    color: def.tint ?? 0xffffff,
    transparent: true,
    opacity: def.opacity ?? 0.85,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
    alphaTest: 0.02,
    blending: def.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: !def.additive,
  })
}

function configureDecalTexture(texture) {
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  if ('colorSpace' in texture && THREE.SRGBColorSpace) {
    texture.colorSpace = THREE.SRGBColorSpace
  } else if ('encoding' in texture && THREE.sRGBEncoding) {
    texture.encoding = THREE.sRGBEncoding
  }
}

function createProceduralSplatTexture(spec = {}) {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  drawProceduralSplat(canvas.getContext('2d'), 0, 0, size, spec)
  const texture = new THREE.CanvasTexture(canvas)
  configureDecalTexture(texture)
  return texture
}

// Placeholder splat: FLAT solid-color comic paint — irregular blobby core with splash lobes
// and flung droplets, all hard-edged and fully opaque so the stamp reads as paint replacing
// the surface, never as an airbrushed glow. Art stays >=4px inside the cell so the atlas's
// linear filtering never bleeds a neighbouring splat.
function drawProceduralSplat(ctx, ox, oy, cell, spec = {}) {
  const s = cell / 128
  const cx = ox + cell / 2
  const cy = oy + cell / 2
  const core = spec.core ?? '200,200,200'
  const edge = spec.edge ?? '120,120,120'

  ctx.fillStyle = `rgb(${core})`
  ctx.beginPath()
  ctx.arc(cx, cy, 24 * s, 0, Math.PI * 2)
  ctx.fill()
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + Math.random() * 0.6
    const dist = (10 + Math.random() * 14) * s
    const r = (7 + Math.random() * 12) * s
    ctx.beginPath()
    ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = 0; i < 10; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = (22 + Math.random() * 8) * s
    const r = (2.5 + Math.random() * 5) * s
    ctx.beginPath()
    ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.fillStyle = `rgb(${edge})`
  for (let i = 0; i < 9; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = Math.random() * 18 * s
    const r = (1.5 + Math.random() * 4.5) * s
    ctx.beginPath()
    ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.fillStyle = `rgb(${core})`
  for (let i = 0; i < 14; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = (30 + Math.random() * 22) * s
    const r = (1.8 + Math.random() * 4) * s
    ctx.beginPath()
    ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = 0; i < 5; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = (30 + Math.random() * 16) * s
    const len = (5 + Math.random() * 8) * s
    const w = (1.5 + Math.random() * 2) * s
    ctx.beginPath()
    ctx.ellipse(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, len, w, ang, 0, Math.PI * 2)
    ctx.fill()
  }

  if (spec.ember) {
    ctx.strokeStyle = `rgb(${spec.ember})`
    ctx.lineWidth = 2.5 * s
    ctx.beginPath()
    ctx.arc(cx, cy, (28 + Math.random() * 5) * s, 0, Math.PI * 2)
    ctx.stroke()
  }
}

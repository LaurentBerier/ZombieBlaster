// Fx — the zombie game's sprite-sheet hit FX on the new engine. POC scope: the
// green-blood impact burst (the most visible on-hit VFX). Ported from effects.js: it
// pre-slices the 4x2 atlas into 8 per-frame CanvasTextures and swaps material.map per
// frame (the technique the original used, distinct from the bullet's UV-offset method),
// as an additive, billboarded Sprite that grows + fades. Pooled. Added to the 'Level'
// entity; the ProjectileSystem fires it on a landed hit.
//
// The richer FX (damage numbers, death splat, screen shake) and the shader-projected
// SKINNED decals are a later milestone.

import * as THREE from 'three'
import Component from '../../Component.js'
import { makeChannelRotatedTexture } from '../Common/NeonMaterials.js'

const ATLAS = { url: 'assets/FX/Green_Spill_juice_SpriteSheet3.png', columns: 4, rows: 2, frames: 8, fps: 18 }
const FRAME_SIZE = { width: 384, height: 256 }
const MAX_GREEN_BLOOD = 24

// Environment splat (wall/floor bolt marks) — pooled oriented planes, ported from effects.js
// spawnFrankenImpactDecal. Two authored splat shapes, RGB-rotated to blue for the Soda Laser.
const MAX_ENV_SPLATS = 18
const ENV_SPLAT_LIFETIME = 6.0
const ENV_SPLAT_FADE_TIME = 1.4
const _splatForward = new THREE.Vector3(0, 0, 1)

export default class Fx extends Component {
  constructor(scene, greenBloodTexture, decalTex1, decalTex2) {
    super()
    this.name = 'Fx'
    this.scene = scene
    this.sourceTexture = greenBloodTexture || null
    this.frameTextures = []
    this.impacts = []
    // Environment splat state.
    this.envSplatSources = [
      { texture: decalTex1 || null, aspect: 720 / 463 },
      { texture: decalTex2 || null, aspect: 500 / 463 },
    ].filter(s => s.texture)
    this.envSplatSourcesBlue = null   // lazily RGB-rotated on first blue splat
    this.envSplats = []
  }

  Initialize() {
    this.envSplatSources.forEach(s => this._configTex(s.texture))
    this.buildFrameTextures()
    for (let i = 0; i < MAX_GREEN_BLOOD; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.frameTextures[0] || null, color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      })
      const sprite = new THREE.Sprite(material)
      sprite.visible = false
      sprite.renderOrder = 9
      this.scene.add(sprite)
      this.impacts.push({ sprite, active: false, age: 0, lifetime: 0, maxLifetime: ATLAS.frames / ATLAS.fps + 0.08, baseScale: 1, frame: -1 })
    }
  }

  _configTex(t) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    t.minFilter = t.magFilter = THREE.LinearFilter
    t.generateMipmaps = false
    if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding
    return t
  }

  buildFrameTextures() {
    const src = this.sourceTexture
    const image = src && src.image
    const sw = image ? (image.naturalWidth || image.width || 0) : 0
    const sh = image ? (image.naturalHeight || image.height || 0) : 0
    if (!image || sw <= 0) { if (src) { this._configTex(src); this.frameTextures = [src] } return }

    const fw = sw / ATLAS.columns, fh = sh / ATLAS.rows
    for (let i = 0; i < ATLAS.frames; i++) {
      const col = i % ATLAS.columns, row = Math.floor(i / ATLAS.columns)
      const canvas = document.createElement('canvas')
      canvas.width = FRAME_SIZE.width; canvas.height = FRAME_SIZE.height
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(image, col * fw, row * fh, fw, fh, 0, 0, canvas.width, canvas.height)
      this.frameTextures.push(this._configTex(new THREE.CanvasTexture(canvas)))
    }
  }

  SpawnGreenBloodImpact(position, opts = {}) {
    const entry = this.impacts.find(i => !i.active)
      || this.impacts.reduce((o, c) => (c.lifetime < o.lifetime ? c : o), this.impacts[0])
    if (!entry) return
    entry.active = true
    entry.age = 0
    entry.lifetime = entry.maxLifetime
    entry.baseScale = opts.scale ?? (0.75 + Math.random() * 0.3)
    entry.frame = -1
    const impactY = Math.max(position.y, 0.7)
    entry.sprite.position.set(position.x, impactY + 0.05, position.z)
    entry.sprite.material.opacity = opts.opacity ?? 1.0
    entry.sprite.material.rotation = Math.random() * Math.PI * 2
    entry.sprite.material.map = this.frameTextures[0] || entry.sprite.material.map
    entry.sprite.scale.setScalar(entry.baseScale)
    entry.sprite.visible = true
  }

  _envSources(blue) {
    if (!blue) return this.envSplatSources
    if (!this.envSplatSourcesBlue) {
      this.envSplatSourcesBlue = this.envSplatSources.map(s => {
        const texture = makeChannelRotatedTexture(s.texture)
        this._configTex(texture)
        return { texture, aspect: s.aspect }
      })
    }
    return this.envSplatSourcesBlue
  }

  // Stamp a surface-oriented splat where a bolt landed on a wall/prop/floor.
  //   opts.normal  outward surface normal (defaults to facing up)
  //   opts.scale   base size; opts.blue picks the Soda-Laser blue variant
  SpawnEnvironmentSplat(position, opts = {}) {
    const sources = this._envSources(!!opts.blue)
    if (!position || sources.length === 0) return

    while (this.envSplats.length >= MAX_ENV_SPLATS) this._destroyEnvSplat(this.envSplats[0])

    const src = sources[Math.floor(Math.random() * sources.length)]
    const baseSize = opts.scale ?? (0.5 + Math.random() * 0.16)
    const height = baseSize * (0.88 + Math.random() * 0.22)
    const width = height * src.aspect
    const geometry = new THREE.PlaneGeometry(width, height)
    const material = new THREE.MeshBasicMaterial({
      map: src.texture,
      color: 0xffffff,
      transparent: true,
      opacity: opts.opacity ?? 0.82,
      alphaTest: 0.03,
      // depthTest ON so a far-wall splat can't paint over a nearer zombie; depthWrite OFF +
      // strong polygonOffset so it still wins the coplanar depth fight on its own surface.
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'env_impact_splat'
    mesh.renderOrder = 6

    const normal = _splatForward.clone()
    if (opts.normal && opts.normal.lengthSq() > 0.0001) normal.copy(opts.normal).normalize()
    else normal.set(0, 1, 0)
    mesh.position.copy(position).addScaledVector(normal, 0.025)
    mesh.quaternion.setFromUnitVectors(_splatForward, normal)
    mesh.rotateZ(Math.random() * Math.PI * 2)
    this.scene.add(mesh)

    const lifetime = opts.lifetime ?? ENV_SPLAT_LIFETIME
    this.envSplats.push({ mesh, lifetime, baseOpacity: material.opacity })
  }

  _destroyEnvSplat(entry) {
    if (!entry || !entry.mesh) return
    if (entry.mesh.parent) entry.mesh.parent.remove(entry.mesh)
    entry.mesh.geometry.dispose()
    entry.mesh.material.dispose()
    const idx = this.envSplats.indexOf(entry)
    if (idx !== -1) this.envSplats.splice(idx, 1)
  }

  Update(dt) {
    for (let i = this.envSplats.length - 1; i >= 0; i--) {
      const s = this.envSplats[i]
      s.lifetime -= dt
      if (s.lifetime <= 0) { this._destroyEnvSplat(s); continue }
      if (s.lifetime < ENV_SPLAT_FADE_TIME) {
        s.mesh.material.opacity = s.baseOpacity * (s.lifetime / ENV_SPLAT_FADE_TIME)
      }
    }

    for (const entry of this.impacts) {
      if (!entry.active) continue
      entry.age += dt
      entry.lifetime -= dt
      if (entry.lifetime <= 0) { entry.active = false; entry.sprite.visible = false; continue }
      const frame = Math.min(ATLAS.frames - 1, Math.floor(entry.age * ATLAS.fps))
      if (frame !== entry.frame) {
        entry.frame = frame
        entry.sprite.material.map = this.frameTextures[frame] || this.frameTextures[0] || null
        entry.sprite.material.needsUpdate = true
      }
      const t = entry.age / entry.maxLifetime
      entry.sprite.scale.setScalar(entry.baseScale * (1 + t * 0.45))
      entry.sprite.material.opacity = Math.max(0, Math.min(1, (1 - t) * 1.35))
      entry.sprite.position.y += dt * 0.18
    }
  }

  Dispose() {
    for (const e of this.impacts) if (e.sprite.parent) e.sprite.parent.remove(e.sprite)
    this.impacts.length = 0
    while (this.envSplats.length > 0) this._destroyEnvSplat(this.envSplats[0])
  }
}

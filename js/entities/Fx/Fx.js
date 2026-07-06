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

const ATLAS = { url: 'assets/FX/Green_Spill_juice_SpriteSheet3.png', columns: 4, rows: 2, frames: 8, fps: 18 }
const FRAME_SIZE = { width: 384, height: 256 }
const MAX_GREEN_BLOOD = 24

export default class Fx extends Component {
  constructor(scene, greenBloodTexture) {
    super()
    this.name = 'Fx'
    this.scene = scene
    this.sourceTexture = greenBloodTexture || null
    this.frameTextures = []
    this.impacts = []
  }

  Initialize() {
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

  Update(dt) {
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
  }
}

// Shared neon/toon material helpers, ported from the original Zombie Blaster scene.js.
// Used by the arena, the funky weapons, and the FX so the whole game keeps its
// comic-book neon look on the new engine. Pure THREE — no scene/global state.

import * as THREE from 'three'

export const COLORS = {
  magenta: 0xFF00FF,
  cyan: 0x00FFFF,
  lime: 0x7FFF00,
  orange: 0xFF7F00,
  violet: 0xBF00FF,
  yellow: 0xFFFF00,
  hotPink: 0xFF1493,
  darkBg: 0x111111,
  grey: 0x555555,
  lightGrey: 0xCCCCCC,
  red: 0xFF3B30,
  green: 0x4CD964,
  white: 0xFFFFFF,
  black: 0x000000,
}

export const NEON_PALETTE = [
  COLORS.magenta, COLORS.cyan, COLORS.lime, COLORS.orange, COLORS.violet, COLORS.hotPink, COLORS.yellow,
]

// Matte, hard-edged (flat-shaded) toon material — the comic-book look.
export function createToonMaterial(color, emissiveColor = 0x000000, emissiveIntensity = 0) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.8, metalness: 0.0,
    emissive: emissiveColor, emissiveIntensity,
    flatShading: true,
  })
}

// Comic-book 2px outline (BackSide-hull technique).
export function createOutlineMesh(geometry, scale = 1.04) {
  const outline = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }))
  outline.scale.multiplyScalar(scale)
  outline.renderOrder = -1
  return outline
}

export function addOutline(parent, geometry, scale = 1.05) {
  const outline = createOutlineMesh(geometry, scale)
  parent.add(outline)
  return outline
}

// RGB-rotate a texture (R,G,B) -> (B,R,G) so the green liquid-bullet sheet reads
// blue for the Soda Laser, keeping alpha/layout/UV animation. Returns the source
// unchanged if its image isn't decoded yet.
export function makeChannelRotatedTexture(srcTexture) {
  const img = srcTexture && srcTexture.image
  if (!img || !img.width) return srcTexture
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = data.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2]
    d[i] = b; d[i + 1] = r; d[i + 2] = g
  }
  ctx.putImageData(data, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = srcTexture.wrapS
  tex.wrapT = srcTexture.wrapT
  tex.repeat.copy(srcTexture.repeat)
  tex.offset.copy(srcTexture.offset)
  tex.minFilter = srcTexture.minFilter
  tex.magFilter = srcTexture.magFilter
  tex.generateMipmaps = srcTexture.generateMipmaps
  if ('colorSpace' in srcTexture) tex.colorSpace = srcTexture.colorSpace
  else if ('encoding' in srcTexture) tex.encoding = srcTexture.encoding
  tex.needsUpdate = true
  return tex
}

/**
 * entry.js — Zombie Blaster on the TPS/FPS engine (PROOF-OF-CONCEPT slice)
 *
 * Boots the template's Entity/Component + Ammo.js framework inside the Zombie
 * Blaster repo. This POC stands up the PLAYER (UE Mannequin body + AK, dual
 * TPS/FPS spring-arm camera, aim-IK, physics capsule) on a placeholder ground.
 * Subsequent steps replace the ground with the neon arena, add the zombie
 * enemies + ragdoll, port the hit FX/decals, and rig the Franken-Gun.
 *
 * Adapted from ThreeJS_UE_TPS_FPS/js/entry.js (kept here as entry.reference.js).
 * The old flat Zombie Blaster modules (arena.js, weapons.js, …) remain in js/ as
 * reference during the port and are not loaded at runtime.
 */

import * as THREE from 'three'
import { AmmoHelper, Ammo, createConvexHullShape, CollisionFilterGroups } from './AmmoLib.js'
import EntityManager from './EntityManager.js'
import Entity from './Entity.js'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js'

import Input from './Input.js'
import PlayerControls from './entities/Player/PlayerControls.js'
import PlayerPhysics from './entities/Player/PlayerPhysics.js'
import PlayerBody from './entities/Player/PlayerBody.js'
import Hands from './entities/Player/Hands.js'
import WeaponManager from './entities/Player/WeaponManager.js'
import PlayerHealth from './entities/Player/PlayerHealth.js'
import WeaponPlacementDebug from './entities/Player/WeaponPlacementDebug.js'
import WeaponAimDebug from './entities/Player/WeaponAimDebug.js'
import UIManager from './entities/UI/UIManager.js'
import ArenaSetup from './entities/Level/ArenaSetup.js'
import ZombieSpawner from './entities/NPC/ZombieSpawner.js'
import ProjectileSystem from './entities/Weapons/ProjectileSystem.js'
import Fx from './entities/Fx/Fx.js'
import Decals from './entities/Fx/Decals.js'
import GameDirector from './entities/Game/GameDirector.js'
import AudioManager from './entities/Audio/AudioManager.js'
import { WEAPON_DEFS, WEAPON_GLBS } from './entities/Weapons/weaponDefs.js'
import { adaptClipToPreOriented } from './entities/Common/UeMannequin.js'

// --- Buildless asset URLs (relative to index.html). ---
// UE Mannequin player body MESH (Y-up, metre-scaled, baked PBR) + its clip source.
const ueChar = 'assets/Characters/ue/SK_Mannequin_new.glb'
// Player body MESH: the Tripo "Frog" (from the ThreeJS_UE_TPS_FPS template) — rigged to the
// SAME UE Mannequin skeleton, so the shared ueAnims drive it by bone name with no re-bake and
// the aim-IK resolves its sockets exactly like the mannequin. The mannequin (ueChar) stays
// loaded as the canonical reference rig / one-line fallback (swap frogModel -> ueModel).
const frogChar = 'assets/Characters/Sandscape_Frog_2_optimized.glb'
const ueClipsSrc = 'assets/Characters/ue/SK_Mannequin.glb'
const ueRollSrc = 'assets/Characters/ue/RollForward.glb'
const ueSlideSrc = 'assets/Characters/ue/Slide.glb'
const ueCrouchIdleSrc = 'assets/Characters/ue/CrouchIdle.glb'

// Zombie enemies — the full cast (Draco-compressed GLBs). Per model: a walk-with-skin GLB
// (mesh source + walk clip) plus Charged/Dead GLBs that contribute only their attack/death
// clips (bound by bone name to the walk skeleton). All 5 models are loaded so the wave
// director can field grunts (Zombie_1/2/3), fast/tank variants, and the Zombie_4/5 bosses.
const ZOMBIE_MODELS = {
  Zombie_1: { walk: 'Zombie_1_Unsteady_Walk_withSkin.glb', attack: 'Zombie_1__Charged_1.glb', death: 'Zombie_1__Dead.glb' },
  Zombie_2: { walk: 'Zombie_2_Unsteady_Walk_withSkin.glb', attack: 'Zombie_2__Charged_1.glb', death: 'Zombie_2__Dead.glb' },
  Zombie_3: { walk: 'Zombie_3_Unsteady_Walk_withSkin.glb', attack: 'Zombie_3_Charged_1.glb', death: 'Zombie_3_Dead.glb' },
  Zombie_4: { walk: 'Zombie_4_Unsteady_Walk_withSkin.glb', attack: 'Zombie_4__Charged_1.glb', death: 'Zombie_4__Dead.glb' },
  Zombie_5: { walk: 'Zombie_5__Walking_1.glb', attack: 'Zombie_5__Charged_1.glb', death: 'Zombie_5__Dead.glb' },
}

// Funky weapon: the Franken-Gun (Neon Biohazard Blaster) GLB — the VISIBLE gun
// socketed to the hand (aim-IK'd like the rifle) — plus the animated liquid sprite
// sheet its bolts render with (the signature look), reused RGB-rotated for Soda later.
const frankenGun = 'assets/Weapons/1_Neon_Biohazard_Blaste_0415181024_texture.glb'
const frankenSheet = 'assets/FX/LiquidSpriteSheet2.png'
// Green-blood impact burst spritesheet (8-frame 4x2 atlas) — the on-hit VFX.
const greenBloodSheet = 'assets/FX/Green_Spill_juice_SpriteSheet3.png'
// Environment splat art (wall/floor bolt marks) — RGB-rotated to blue for the Soda Laser.
const decalSplat1 = 'assets/FX/Blood_decal_1.png'
const decalSplat2 = 'assets/FX/Blood_Decal_2.png'

// Third-person weapon (socketed to the hand) + its magazine-reload clip.
const ak47Tps = 'assets/guns/New/SK_AK47.FBX'
const ak47Reload = 'assets/guns/New/AK47_Reload.glb'
// First-person arms viewmodel gun + muzzle flash + shot sound.
const ak47 = 'assets/guns/ak47/ak47.glb'
const muzzleFlash = 'assets/muzzle_flash.glb'
const ak47Shot = 'assets/sounds/ak47_shot.wav'

// Onboarding fade timings (must match #screen-fade opacity transition in css/style.css: 420ms).
const FADE_MS = 440
const MIN_LOADING_MS = 700
const HIGH_SCORE_KEY = 'zombieBlasterHighScore'

class FPSGameApp {
  constructor() {
    this.lastFrameTime = null
    this.assets = {}
    this.animFrameId = 0
    this.playing = false   // true only during live gameplay (gates pointer lock + pause)
    this.paused = false
    AmmoHelper.Init(() => { this.Init() })
  }

  Init() {
    this.LoadAssets()
    this.SetupGraphics()
    this.SetupStartButton()
  }

  SetupGraphics() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0d0d20)
    this.scene.fog = new THREE.FogExp2(0x0d0d20, 0.012)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.3
    this.renderer.outputEncoding = THREE.sRGBEncoding

    this.camera = new THREE.PerspectiveCamera()
    this.camera.fov = 60
    this.camera.near = 0.01
    this.camera.far = 500

    this.listener = new THREE.AudioListener()
    this.camera.add(this.listener)

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.WindowResizeHanlder()
    window.addEventListener('resize', this.WindowResizeHanlder)
    document.body.appendChild(this.renderer.domElement)

    // Lighting/background/fog are added in SetupSceneLights (called by StartGame AFTER
    // scene.clear()); the render loop only starts once gameplay begins, so nothing is
    // drawn before then.

    this.stats = new Stats()
    document.body.appendChild(this.stats.dom)
  }

  SetupPhysics() {
    const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration()
    const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration)
    const broadphase = new Ammo.btDbvtBroadphase()
    const solver = new Ammo.btSequentialImpulseConstraintSolver()
    this.physicsWorld = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, collisionConfiguration)
    this.physicsWorld.setGravity(new Ammo.btVector3(0.0, -9.81, 0.0))
    const fp = Ammo.addFunction(this.PhysicsUpdate, 'vif')
    this.physicsWorld.setInternalTickCallback(fp)
    this.physicsWorld.getBroadphase().getOverlappingPairCache().setInternalGhostPairCallback(new Ammo.btGhostPairCallback())
  }

  PromiseProgress(proms, progress_cb) {
    let d = 0
    progress_cb(0)
    for (const p of proms) {
      p.then(() => { d++; progress_cb((d / proms.length) * 100) })
    }
    return Promise.all(proms)
  }

  AddAsset(asset, loader, name) {
    return loader.loadAsync(asset).then(result => { this.assets[name] = result })
  }

  OnProgress(p) {
    const bar = document.getElementById('loading-bar')
    if (bar) bar.style.width = `${p}%`
  }

  HideProgress() { this.OnProgress(0) }

  SetupStartButton() {
    document.getElementById('btn-start')?.addEventListener('click', this.StartGame)
    document.getElementById('btn-retry')?.addEventListener('click', this.StartGame)
    document.getElementById('btn-menu')?.addEventListener('click', this.QuitToMenu)
    // Controls overlay (simple show/hide) — reachable from the title AND the pause screen.
    const controls = document.getElementById('controls-overlay')
    document.getElementById('btn-controls')?.addEventListener('click', () => controls?.classList.remove('hidden'))
    document.getElementById('btn-pause-controls')?.addEventListener('click', () => controls?.classList.remove('hidden'))
    document.getElementById('btn-close-controls')?.addEventListener('click', () => controls?.classList.add('hidden'))
    // Pause screen.
    document.getElementById('btn-resume')?.addEventListener('click', this.ResumeGame)
    document.getElementById('btn-quit')?.addEventListener('click', this.QuitToMenu)
    // Losing the pointer lock during live gameplay (Esc) pauses the game.
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.playing && !this.paused) this.PauseGame()
    })
  }

  // ---- Pause ----
  PauseGame = () => {
    if (!this.playing || this.paused) return
    this.paused = true
    this._toggleHidden('pause-screen', true)   // cursor is already free (pointer unlocked)
  }

  ResumeGame = () => {
    if (!this.paused) return
    this.paused = false
    this._toggleHidden('pause-screen', false)
    document.getElementById('controls-overlay')?.classList.add('hidden')
    // Re-grab the pointer (this click is the required user gesture).
    if (document.body.requestPointerLock) document.body.requestPointerLock()
  }

  _toggleHidden(id, visible) { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !visible) }
  ShowMenu(visible = true) { this._toggleHidden('title-screen', visible) }
  ShowLoading(visible = true) { this._toggleHidden('loading-screen', visible) }

  RefreshTitleHighScore() {
    let hs = 0
    try { hs = parseInt(window.localStorage.getItem(HIGH_SCORE_KEY) || '0', 10) || 0 } catch (e) { /* private mode */ }
    const el = document.getElementById('title-high-score')
    if (el) el.innerText = hs.toLocaleString()
  }

  FadeTo(opaque) {
    document.getElementById('screen-fade').style.opacity = opaque ? '1' : '0'
    return new Promise(res => setTimeout(res, FADE_MS))
  }
  Delay(ms) { return new Promise(res => setTimeout(res, ms)) }

  // Called by the GameDirector when the player dies: reveal the game-over screen + free the
  // cursor so the retry/menu buttons are clickable.
  OnGameOver = (state) => {
    // Stop gameplay BEFORE releasing the pointer, so the pointerlockchange handler doesn't
    // mistake the game-over unlock for a pause.
    this.playing = false
    this.paused = false
    this._toggleHidden('pause-screen', false)
    const ui = this.entityManager?.Get('UIManager')?.GetComponent('UIManager')
    ui && ui.ShowGameOver(state)
    if (document.exitPointerLock) document.exitPointerLock()
  }

  // Back to the title screen from the game-over screen.
  QuitToMenu = async () => {
    if (this.starting) return
    this.playing = false
    this.paused = false
    this.entityManager?.Get('Audio')?.GetComponent('AudioManager')?.StopMusic()
    if (document.exitPointerLock && document.pointerLockElement) document.exitPointerLock()
    await this.FadeTo(true)
    window.cancelAnimationFrame(this.animFrameId)
    this._toggleHidden('pause-screen', false)
    this._toggleHidden('gameover-screen', false)
    this._toggleHidden('hud', false)
    this.scene.clear()
    this.renderer.render(this.scene, this.camera)
    this.RefreshTitleHighScore()
    this.ShowMenu(true)
    await this.FadeTo(false)
  }

  async LoadAssets() {
    const gltfLoader = new GLTFLoader()
    // The zombie GLBs are Draco-compressed (KHR_draco_mesh_compression). Reuse the
    // JS decoder already vendored in the repo (js/lib/draco/gltf/). Harmless for the
    // non-Draco GLBs — the extension is only invoked when present.
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('js/lib/draco/gltf/')
    dracoLoader.setDecoderConfig({ type: 'js' })
    dracoLoader.preload()
    gltfLoader.setDRACOLoader(dracoLoader)
    // SK_AK47.FBX references a weapon-tint texture we don't ship; resolve it to a 1x1 px.
    const akManager = new THREE.LoadingManager()
    akManager.setURLModifier(url =>
      /T_WeaponColors\.png$/i.test(url)
        ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        : url)
    const akFbxLoader = new FBXLoader(akManager)
    const audioLoader = new THREE.AudioLoader()
    const texLoader = new THREE.TextureLoader()
    const promises = []

    // Fetch the REAL level (data/levelData.json) + the asset-kit manifest, then queue every
    // unique designer custom-prop GLB for preload (cloned per placement by ArenaSetup).
    this.levelData = await fetch('data/levelData.json', { cache: 'no-store' }).then(r => r.json()).catch(() => ({}))
    this.kitMap = await fetch('data/assetKits.json', { cache: 'no-store' }).then(r => r.json()).catch(() => ({}))
    this.propCache = new Map()
    const propUrls = new Set()
    for (const p of (this.levelData.customProps || [])) {
      if (p && p.asset) propUrls.add(`assets/${this.kitMap[p.asset] ?? 'CorridorKit'}/${p.asset}`)
    }
    for (const url of propUrls) {
      promises.push(gltfLoader.loadAsync(url).then(g => this.propCache.set(url, g.scene)).catch(e => console.warn('[prop] load failed:', url, e.message)))
    }

    promises.push(this.AddAsset(ueChar, gltfLoader, 'ueChar'))
    promises.push(this.AddAsset(frogChar, gltfLoader, 'frogChar'))
    promises.push(this.AddAsset(ueClipsSrc, gltfLoader, 'ueClips'))
    promises.push(this.AddAsset(ueRollSrc, gltfLoader, 'ueRoll'))
    promises.push(this.AddAsset(ueSlideSrc, gltfLoader, 'ueSlide'))
    promises.push(this.AddAsset(ueCrouchIdleSrc, gltfLoader, 'ueCrouchIdle'))
    promises.push(this.AddAsset(ak47Tps, akFbxLoader, 'ak47Tps'))
    promises.push(this.AddAsset(ak47Reload, gltfLoader, 'ak47Reload'))
    promises.push(this.AddAsset(ak47, gltfLoader, 'ak47'))
    promises.push(this.AddAsset(muzzleFlash, gltfLoader, 'muzzleFlash'))
    promises.push(this.AddAsset(ak47Shot, audioLoader, 'ak47Shot'))
    // Zombie enemies — all 5 models' walk/attack/death GLBs (Draco).
    for (const [model, files] of Object.entries(ZOMBIE_MODELS)) {
      promises.push(this.AddAsset(`assets/Characters/${model}/${files.walk}`, gltfLoader, `${model}_walk`))
      promises.push(this.AddAsset(`assets/Characters/${model}/${files.attack}`, gltfLoader, `${model}_attack`))
      promises.push(this.AddAsset(`assets/Characters/${model}/${files.death}`, gltfLoader, `${model}_death`))
    }
    // Funky weapon + its sprite-bullet sheet.
    // The full funky arsenal (Franken / Bowling / Soda / Cryo GLBs), keyed by registry glbKey.
    for (const [key, url] of Object.entries(WEAPON_GLBS)) {
      promises.push(this.AddAsset(url, gltfLoader, key))
    }
    promises.push(this.AddAsset(frankenSheet, texLoader, 'frankenSheet'))
    promises.push(this.AddAsset(greenBloodSheet, texLoader, 'greenBloodSheet'))
    promises.push(this.AddAsset(decalSplat1, texLoader, 'decal1'))
    promises.push(this.AddAsset(decalSplat2, texLoader, 'decal2'))

    await this.PromiseProgress(promises, this.OnProgress)

    // Per-model zombie asset sets: the walk GLB is the mesh source; the Charged/Dead GLBs
    // contribute only their first clip (attack/death), bound by bone name at play time.
    this.zombieAssetsByType = {}
    for (const model of Object.keys(ZOMBIE_MODELS)) {
      const walk = this.assets[`${model}_walk`], attack = this.assets[`${model}_attack`], death = this.assets[`${model}_death`]
      this.zombieAssetsByType[model] = {
        scene: walk.scene,
        walk: walk.animations[0],
        attack: attack && attack.animations[0],
        death: death && death.animations[0],
      }
    }

    // The funky arsenal: one runtime per registry entry, each with its own cloned visible GLB
    // (swapped onto the hand by PlayerBody on weapon switch) + the def (fire params + grip).
    this.weaponRuntimes = WEAPON_DEFS.map(def => ({ def, mesh: this.assets[def.glbKey].scene.clone(true) }))

    this.assets['muzzleFlash'] = this.assets['muzzleFlash'].scene
    // The FP arms viewmodel (Hands) reads its idle/shoot/reload clips off the scene's
    // .animations; the GLTFLoader puts them on the gltf, not the scene — copy them over.
    this.assets['ak47'].scene.animations = this.assets['ak47'].animations

    // Player body mesh + shared UE rifle clips, adapted onto the pre-oriented rig. The Frog is
    // the player body (same UE skeleton); the mannequin stays as the fallback reference rig.
    this.ueModel = this.assets['ueChar'].scene
    this.frogModel = this.assets['frogChar'].scene
    const ueClips = this.assets['ueClips'].animations
    const byName = (n) => { const c = ueClips.find(c => c.name === n); return c ? adaptClipToPreOriented(c) : undefined }
    const rollSrc = this.assets['ueRoll'] ? this.assets['ueRoll'].animations : []
    const rollRaw = rollSrc.find(c => c.name === 'roll') || rollSrc[0]
    const rollClip = rollRaw ? adaptClipToPreOriented(rollRaw) : undefined
    const slideSrc = this.assets['ueSlide'] ? this.assets['ueSlide'].animations : []
    const slideRaw = slideSrc.find(c => c.name === 'slide') || slideSrc[0]
    const slideClip = slideRaw ? adaptClipToPreOriented(slideRaw) : undefined
    const crouchSrc = this.assets['ueCrouchIdle'] ? this.assets['ueCrouchIdle'].animations : []
    const crouchRaw = crouchSrc.find(c => c.name === 'crouch_idle') || crouchSrc[0]
    const crouchIdleClip = crouchRaw ? adaptClipToPreOriented(crouchRaw) : undefined
    const walkClip = byName('walk')
    this.ueAnims = {
      idle: byName('idle'),
      aim: byName('aim'),
      walk: walkClip,
      run: walkClip ? walkClip.clone() : undefined,
      reload: byName('reload'),
      shoot: byName('shoot'),
      jogF: walkClip,
      jogB: byName('jog_bwd'),
      jogL: byName('jog_left'),
      jogR: byName('jog_right'),
      jumpStart: byName('jump_start'),
      jumpFall: byName('jump_fall'),
      roll: rollClip,
      slide: slideClip,
      crouchIdle: crouchIdleClip,
    }
    this.ueTextures = null

    // The SK_AK47 FBX ships no usable r127 material; give it a neutral gunmetal.
    this.assets['ak47Tps'].traverse(child => {
      if (child.isMesh || child.isSkinnedMesh) {
        child.material = new THREE.MeshStandardMaterial({
          color: 0x2b2e33, metalness: 0.9, roughness: 0.45, skinning: child.isSkinnedMesh,
        })
      }
    })

    // In-hand AK magazine-reload clip: strip the whole-gun 'Root' tracks so the gun stays
    // socketed in the hand (it follows hand_r via the body reload anim); keep 'Magazine'.
    const akReloadClips = this.assets['ak47Reload'] ? this.assets['ak47Reload'].animations : []
    const akReloadRaw = akReloadClips.find(c => c.name === 'reload') || akReloadClips[0]
    this.akMagReloadClip = undefined
    if (akReloadRaw) {
      const clip = akReloadRaw.clone()
      clip.tracks = clip.tracks.filter(t => !t.name.startsWith('Root.'))
      clip.name = 'gun_reload'
      this.akMagReloadClip = clip
    }

    this.HideProgress()
    this.RefreshTitleHighScore()
    this.assetsReady = true
    this.ShowMenu()
    await this.FadeTo(false)
  }

  EntitySetup() {
    this.entityManager = new EntityManager()

    // The neon arena (visible geometry + Ammo static colliders). Named 'Level' so
    // components that look it up (PlayerHealth's BloodFx, later the FX/Decals) resolve.
    const levelEntity = new Entity()
    levelEntity.SetName('Level')
    levelEntity.AddComponent(new ArenaSetup(this.scene, this.physicsWorld, this.levelData, this.propCache, this.kitMap))
    levelEntity.AddComponent(new Fx(this.scene, this.assets['greenBloodSheet'], this.assets['decal1'], this.assets['decal2']))
    // Shader-projected impact splats on the zombies (procedural art; needs the camera for the
    // fallback hit direction). Zombie/Projectile components look it up as GetComponent('Decals').
    levelEntity.AddComponent(new Decals(this.scene, this.camera))
    this.entityManager.Add(levelEntity)

    const playerEntity = new Entity()
    playerEntity.SetName('Player')
    playerEntity.AddComponent(new PlayerPhysics(this.physicsWorld, Ammo))
    playerEntity.AddComponent(new PlayerControls(this.camera, this.scene))
    // The VISIBLE in-hand gun is the Franken-Gun GLB (socketed to hand_r + aim-IK'd by
    // PlayerBody exactly like the rifle). buildUeMannequin recenters/auto-scales it, and
    // WeaponAimIK auto-resolves the muzzle/grips from its bbox + the posed hands, so it
    // aims at the crosshair with no per-weapon ikConfig (tunable later with the ` panel).
    // magReload clip is null — the Franken-Gun has no 'Magazine' bone to animate.
    playerEntity.AddComponent(new PlayerBody(
      SkeletonUtils.clone(this.frogModel), this.ueAnims, this.scene, this.camera,
      this.ueTextures, this.weaponRuntimes[0].mesh, true, null
    ))
    playerEntity.AddComponent(new Hands(this.camera, this.assets['ak47'].scene))
    playerEntity.AddComponent(new WeaponManager(this.camera, this.physicsWorld, this.assets['muzzleFlash'], this.assets['ak47Shot'], this.listener, this.weaponRuntimes))
    playerEntity.AddComponent(new ProjectileSystem(this.scene, this.assets['frankenSheet']))
    playerEntity.AddComponent(new PlayerHealth())
    playerEntity.AddComponent(new WeaponPlacementDebug())
    playerEntity.AddComponent(new WeaponAimDebug())
    // Spawn at the designer's player-spawn from the level data (capsule settles onto the floor).
    const ps = (this.levelData && this.levelData.playerSpawn) || { x: 0, y: 1.6, z: 0 }
    playerEntity.SetPosition(new THREE.Vector3(ps.x, Math.max(1.5, ps.y), ps.z))
    this.entityManager.Add(playerEntity)

    const uimanagerEntity = new Entity()
    uimanagerEntity.SetName('UIManager')
    uimanagerEntity.AddComponent(new UIManager())
    this.entityManager.Add(uimanagerEntity)

    // Audio: procedural SFX + the music playlist. Looked up as GetComponent('AudioManager').
    const audioEntity = new Entity()
    audioEntity.SetName('Audio')
    audioEntity.AddComponent(new AudioManager())
    this.entityManager.Add(audioEntity)

    // The gameplay brain: score/combo/high-score + the wave/spawn director + game-over.
    const directorEntity = new Entity()
    directorEntity.SetName('GameDirector')
    const director = new GameDirector()
    director.onGameOver = this.OnGameOver
    directorEntity.AddComponent(director)
    this.entityManager.Add(directorEntity)

    // Zombie population — driven wave-by-wave by the GameDirector (the maxAlive/interval only
    // apply to the director-less POC fallback).
    const spawnerEntity = new Entity()
    spawnerEntity.SetName('ZombieSpawner')
    spawnerEntity.AddComponent(new ZombieSpawner(this.zombieAssetsByType, this.scene, this.physicsWorld, { maxAlive: 8, interval: 1.6 }))
    this.entityManager.Add(spawnerEntity)

    this.entityManager.EndSetup()
    this.scene.add(this.camera)
    this.animFrameId = window.requestAnimationFrame(this.OnAnimationFrameHandler)
  }

  StartGame = async () => {
    if (this.starting || !this.assetsReady) { return }
    this.starting = true
    this.playing = false
    this.paused = false
    await this.FadeTo(true)
    // Hide the title + any lingering game-over / pause / controls screens (retry path).
    this.ShowMenu(false)
    this._toggleHidden('gameover-screen', false)
    this._toggleHidden('pause-screen', false)
    document.getElementById('controls-overlay')?.classList.add('hidden')
    this.ShowLoading(true)
    await this.FadeTo(false)

    window.cancelAnimationFrame(this.animFrameId)
    Input.ClearEventListners()
    this.scene.clear()
    // Re-add the camera + lights the scene.clear() removed.
    this.SetupSceneLights()
    this.SetupPhysics()
    await this.Delay(0)
    this.EntitySetup()

    // Kick off the soundtrack (the START click is the gesture that opens the autoplay gate).
    const audio = this.entityManager.Get('Audio')?.GetComponent('AudioManager')
    if (audio) { audio.Resume(); audio.StartMusic() }

    await this.Delay(MIN_LOADING_MS)

    await this.FadeTo(true)
    this.ShowLoading(false)
    this.ShowMenu(false)
    await this.FadeTo(false)
    this.starting = false
    this.paused = false
    this.playing = true    // gameplay is live — clicks now grab the pointer; Esc pauses
  }

  // Lights live outside SetupGraphics so StartGame can restore them after scene.clear().
  // Kept dim on purpose — the arena's colored point lights carry the neon mood; these
  // just lift the shadows enough to read the character/props without washing out the neon.
  SetupSceneLights() {
    this.scene.background = new THREE.Color(0x0d0d20)
    this.scene.fog = new THREE.FogExp2(0x0d0d20, 0.02)
    this.scene.add(new THREE.AmbientLight(0x2a2050, 0.6))
    const dir = new THREE.DirectionalLight(0x9977dd, 0.55)
    dir.position.set(12, 24, 8)
    dir.castShadow = true
    dir.shadow.mapSize.set(1024, 1024)
    dir.shadow.camera.near = 1; dir.shadow.camera.far = 80
    dir.shadow.camera.left = -30; dir.shadow.camera.right = 30
    dir.shadow.camera.top = 30; dir.shadow.camera.bottom = -30
    this.scene.add(dir)
    this.scene.add(new THREE.HemisphereLight(0x4433aa, 0x150a22, 0.4))
  }

  WindowResizeHanlder = () => {
    const { innerHeight, innerWidth } = window
    this.renderer.setSize(innerWidth, innerHeight)
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
  }

  OnAnimationFrameHandler = (t) => {
    if (this.lastFrameTime === null) { this.lastFrameTime = t }
    const delta = t - this.lastFrameTime
    const timeElapsed = Math.min(1.0 / 30.0, delta * 0.001)
    this.Step(timeElapsed)
    this.lastFrameTime = t
    this.animFrameId = window.requestAnimationFrame(this.OnAnimationFrameHandler)
  }

  PhysicsUpdate = (world, timeStep) => {
    this.entityManager.PhysicsUpdate(world, timeStep)
  }

  Step(elapsedTime) {
    // Frozen while paused — keep rendering the last frame, but stop physics + all component
    // updates (the wave director, zombies, weapons all halt).
    if (!this.paused) {
      this.physicsWorld.stepSimulation(elapsedTime, 10)
      this.entityManager.Update(elapsedTime)
    }
    this.renderer.render(this.scene, this.camera)
    this.stats.update()
  }
}

let _APP = null
window.addEventListener('DOMContentLoaded', () => {
  _APP = new FPSGameApp()
  window._APP = _APP
})

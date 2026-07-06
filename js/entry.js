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
import { adaptClipToPreOriented } from './entities/Common/UeMannequin.js'

// --- Buildless asset URLs (relative to index.html). ---
// UE Mannequin player body MESH (Y-up, metre-scaled, baked PBR) + its clip source.
const ueChar = 'assets/Characters/ue/SK_Mannequin_new.glb'
const ueClipsSrc = 'assets/Characters/ue/SK_Mannequin.glb'
const ueRollSrc = 'assets/Characters/ue/RollForward.glb'
const ueSlideSrc = 'assets/Characters/ue/Slide.glb'
const ueCrouchIdleSrc = 'assets/Characters/ue/CrouchIdle.glb'

// Third-person weapon (socketed to the hand) + its magazine-reload clip.
const ak47Tps = 'assets/guns/New/SK_AK47.FBX'
const ak47Reload = 'assets/guns/New/AK47_Reload.glb'
// First-person arms viewmodel gun + muzzle flash + shot sound.
const ak47 = 'assets/guns/ak47/ak47.glb'
const muzzleFlash = 'assets/muzzle_flash.glb'
const ak47Shot = 'assets/sounds/ak47_shot.wav'

// Onboarding fade timings (must match #fade opacity transition in the CSS).
const FADE_MS = 600
const MIN_LOADING_MS = 700

class FPSGameApp {
  constructor() {
    this.lastFrameTime = null
    this.assets = {}
    this.animFrameId = 0
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
    const bar = document.getElementById('progress')
    if (bar) bar.style.width = `${p}%`
  }

  HideProgress() { this.OnProgress(0) }

  SetupStartButton() {
    document.getElementById('start_game').addEventListener('click', this.StartGame)
  }

  ShowMenu(visible = true) { document.getElementById('menu').style.visibility = visible ? 'visible' : 'hidden' }
  ShowLoading(visible = true) { document.getElementById('loading').style.visibility = visible ? 'visible' : 'hidden' }

  FadeTo(opaque) {
    document.getElementById('fade').style.opacity = opaque ? '1' : '0'
    return new Promise(res => setTimeout(res, FADE_MS))
  }
  Delay(ms) { return new Promise(res => setTimeout(res, ms)) }

  async LoadAssets() {
    const gltfLoader = new GLTFLoader()
    // SK_AK47.FBX references a weapon-tint texture we don't ship; resolve it to a 1x1 px.
    const akManager = new THREE.LoadingManager()
    akManager.setURLModifier(url =>
      /T_WeaponColors\.png$/i.test(url)
        ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        : url)
    const akFbxLoader = new FBXLoader(akManager)
    const audioLoader = new THREE.AudioLoader()
    const promises = []

    promises.push(this.AddAsset(ueChar, gltfLoader, 'ueChar'))
    promises.push(this.AddAsset(ueClipsSrc, gltfLoader, 'ueClips'))
    promises.push(this.AddAsset(ueRollSrc, gltfLoader, 'ueRoll'))
    promises.push(this.AddAsset(ueSlideSrc, gltfLoader, 'ueSlide'))
    promises.push(this.AddAsset(ueCrouchIdleSrc, gltfLoader, 'ueCrouchIdle'))
    promises.push(this.AddAsset(ak47Tps, akFbxLoader, 'ak47Tps'))
    promises.push(this.AddAsset(ak47Reload, gltfLoader, 'ak47Reload'))
    promises.push(this.AddAsset(ak47, gltfLoader, 'ak47'))
    promises.push(this.AddAsset(muzzleFlash, gltfLoader, 'muzzleFlash'))
    promises.push(this.AddAsset(ak47Shot, audioLoader, 'ak47Shot'))

    await this.PromiseProgress(promises, this.OnProgress)

    this.assets['muzzleFlash'] = this.assets['muzzleFlash'].scene
    // The FP arms viewmodel (Hands) reads its idle/shoot/reload clips off the scene's
    // .animations; the GLTFLoader puts them on the gltf, not the scene — copy them over.
    this.assets['ak47'].scene.animations = this.assets['ak47'].animations

    // Player body mesh + shared UE rifle clips, adapted onto the pre-oriented rig.
    this.ueModel = this.assets['ueChar'].scene
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
    this.ShowMenu()
    await this.FadeTo(false)
  }

  EntitySetup() {
    this.entityManager = new EntityManager()

    // The neon arena (visible geometry + Ammo static colliders). Named 'Level' so
    // components that look it up (PlayerHealth's BloodFx, later the FX/Decals) resolve.
    const levelEntity = new Entity()
    levelEntity.SetName('Level')
    levelEntity.AddComponent(new ArenaSetup(this.scene, this.physicsWorld))
    this.entityManager.Add(levelEntity)

    const playerEntity = new Entity()
    playerEntity.SetName('Player')
    playerEntity.AddComponent(new PlayerPhysics(this.physicsWorld, Ammo))
    playerEntity.AddComponent(new PlayerControls(this.camera, this.scene))
    playerEntity.AddComponent(new PlayerBody(
      SkeletonUtils.clone(this.ueModel), this.ueAnims, this.scene, this.camera,
      this.ueTextures, SkeletonUtils.clone(this.assets['ak47Tps']), true, this.akMagReloadClip
    ))
    playerEntity.AddComponent(new Hands(this.camera, this.assets['ak47'].scene))
    playerEntity.AddComponent(new WeaponManager(this.camera, this.physicsWorld, this.assets['muzzleFlash'], this.assets['ak47Shot'], this.listener))
    playerEntity.AddComponent(new PlayerHealth())
    playerEntity.AddComponent(new WeaponPlacementDebug())
    playerEntity.AddComponent(new WeaponAimDebug())
    // Spawn in a clear patch of floor (away from the props/platform pillars), facing
    // down the room (-Z) so the arena reads on spawn.
    playerEntity.SetPosition(new THREE.Vector3(0, 1.6, -6))
    this.entityManager.Add(playerEntity)

    const uimanagerEntity = new Entity()
    uimanagerEntity.SetName('UIManager')
    uimanagerEntity.AddComponent(new UIManager())
    this.entityManager.Add(uimanagerEntity)

    this.entityManager.EndSetup()
    this.scene.add(this.camera)
    this.animFrameId = window.requestAnimationFrame(this.OnAnimationFrameHandler)
  }

  StartGame = async () => {
    if (this.starting) { return }
    this.starting = true
    await this.FadeTo(true)
    this.ShowMenu(false)
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
    await this.Delay(MIN_LOADING_MS)

    await this.FadeTo(true)
    this.ShowLoading(false)
    this.ShowMenu(false)
    await this.FadeTo(false)
    this.starting = false
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
    this.physicsWorld.stepSimulation(elapsedTime, 10)
    this.entityManager.Update(elapsedTime)
    this.renderer.render(this.scene, this.camera)
    this.stats.update()
  }
}

let _APP = null
window.addEventListener('DOMContentLoaded', () => {
  _APP = new FPSGameApp()
  window._APP = _APP
})

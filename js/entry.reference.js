/**
 * entry.js
 * 
 * This is the first file loaded. It sets up the Renderer, 
 * Scene, Physics and Entities. It also starts the render loop and 
 * handles window resizes.
 * 
 */

import * as THREE from 'three'
import {AmmoHelper, Ammo, createConvexHullShape} from './AmmoLib.js'
import EntityManager from './EntityManager.js'
import Entity from './Entity.js'
import Sky from './entities/Sky/Sky2.js'
import Clouds from './entities/Sky/Clouds.js'
import LevelSetup from './entities/Level/LevelSetup.js'
import Terrain from './entities/Level/Terrain.js'
import PlayerControls from './entities/Player/PlayerControls.js'
import PlayerPhysics from './entities/Player/PlayerPhysics.js'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import {  FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import {  GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {  OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import {  SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js'
import NpcCharacterController from './entities/NPC/CharacterController.js'
import UeSoldierController from './entities/NPC/UeSoldierController.js'
import UeSoldierCollision from './entities/NPC/UeSoldierCollision.js'
import { Faction } from './entities/NPC/Factions.js'
import Input from './Input.js'

// Buildless asset URLs. Webpack used `import x from './assets/..'` (file-loader
// turned each into a hashed URL string); native ESM has no such loader, so these
// are plain root-relative URL strings the Three.js loaders fetch directly.
// Paths are relative to index.html (the document base), not this module.
const level = 'assets/level.glb'
const navmesh = 'assets/navmesh.obj'

// Onboarding fade timings. FADE_MS must match the #fade opacity transition in
// style.css; MIN_LOADING_MS keeps the loading screen up long enough to read even
// though the assets are already pre-loaded and entity setup is near-instant.
const FADE_MS = 600
const MIN_LOADING_MS = 900

// Enemy NPC keeps the mutant rig (root-motion locomotion). Spaces URL-encoded.
const mutant = 'assets/animations/mutant.fbx'
const idleAnim = 'assets/animations/mutant%20breathing%20idle.fbx'
const attackAnim = 'assets/animations/mutant%20punch.fbx'
const walkAnim = 'assets/animations/mutant%20walking.fbx'
const runAnim = 'assets/animations/mutant%20run.fbx'
const dieAnim = 'assets/animations/mutant%20dying.fbx'

// UE Mannequin player body MESH: a Y-up, metre-scaled GLB exported from Blender
// (our FBXtoGLB converter) with PBR materials + OpenGL normal maps baked in. It
// drops straight into three's Y-up world — no tilt, scale or material rebuild
// (PlayerBody/UeSoldierController build it with preOriented:true). This is the new
// house convention: all assets ship Y-up for smoother Three.js integration.
const ueChar = 'assets/characters/ue/SK_Mannequin_new.glb'

// Human ENEMY body MESH (replaces the UE Mannequin for the AI soldiers). A Tripo-generated
// character ("Liz") rigged to the SAME UE Mannequin skeleton: identical 67 bone names and bind
// offsets, so the shared rifle clips (ueAnims) drive it by name with NO re-bake. Tripo fit the
// differing body proportions by baking PER-BONE SCALES into the rest pose (e.g. hand/foot/limb
// scales) that COMPOSE back to ~unit at the leaf bones — so joint world positions stay nearly
// co-located with the mannequin's (the gun on hand_r keeps its size, the feet sit at y=0, the
// height matches ~1.83 m). It ships Y-up + metre-scaled with baked PBR like SK_Mannequin_new, so
// UeSoldierController builds it with preOriented:true exactly like the mannequin. The PLAYER body
// still uses the mannequin (ueChar). NOTE: the raw Tripo export was ~1M verts / 100 MB; this is the
// DECIMATED build (meshopt simplify -> ~70k verts, textures 4K->2K JPEG, ~6 MB) produced by
// d:/tmp/lizdecimate/decimate.mjs. The skeleton (all 67 bones + the per-bone rest scales the
// retarget relies on) is byte-identical to the raw export — only mesh density + texture size changed.
const lizChar = 'assets/characters/Sandscape_Liz_decimated.glb'

// PLAYER body MESH: a Tripo-generated character ("Frog") rigged to the SAME UE Mannequin skeleton as
// the soldiers' Liz mesh — identical 67 bone names, same Y-up + 0.01-root-scale (cm bones) convention,
// height ~1.83 m with feet at y=0, baked PBR (JPEG) materials. So the shared rifle clips (ueAnims)
// drive it by bone name with NO re-bake, and PlayerBody builds it with preOriented:true exactly like
// the mannequin. The body proportions differ from the mannequin (shorter arms, lower head) but the
// clips carry absolute per-bone rotations, so the animated pose retargets for free (same as the Liz
// soldiers); the self-calibrating Foot/WeaponAim IK re-captures the rest/grip pose at init. This is a
// re-rigged Frog with cleaner skinning weights (bind pose now matches the mannequin exactly, pelvis
// y=0.9675). Shipped at FULL mesh detail (209k verts) on purpose — decimating would soften the joint
// deformation we want to keep — and it's only ~21 MB because its baked PBR textures are already 1K
// (mesh geometry is the bulk; a single hero character at 209k verts is fine on the GPU). The mannequin
// (ueChar) is kept loaded as the canonical reference rig / one-line fallback (swap frogModel -> ueModel).
const frogChar = 'assets/characters/Sandscape_Frog_2_optimized.glb'

// The new mesh GLB carries no animation, so the 4 named UE rifle clips
// (idle/walk/reload/shoot) still come from the legacy bake (mesh + clips, baked by
// tools/ue_fbx_to_glb.html). Both are the SAME UE Mannequin skeleton with identical
// bone names, so the clips drive the new rig by name. (r127's FBXLoader cannot parse
// the UE2020 animation FBX, hence the offline glTF bake.)
const ueClipsSrc = 'assets/characters/ue/SK_Mannequin.glb'

// Forward combat roll clip, baked the SAME way as the other UE clips (FBX -> GLB via
// tools/roll_to_glb.html, since r127's FBXLoader can't parse these UE2020 anim takes).
// A small skeleton-only GLB carrying one clip named 'roll'; the game pulls animations[0]
// and adapts it onto the pre-oriented rig like every other clip. Drives the player's
// double-tap-Ctrl dodge roll in both TPS and FPS.
const ueRollSrc = 'assets/characters/ue/RollForward.glb'

// Forward SLIDE clip, baked the SAME way as the roll (FBX -> GLB, since r127's FBXLoader can't parse
// these UE2020 anim takes). A small skeleton-only GLB carrying ONE clip named 'slide'; the game pulls
// animations[0] and adapts it onto the pre-oriented rig like every other clip. Drives the player's
// double-tap-direction dodge (which used to play the roll). Baked IN PLACE (the source's horizontal
// pelvis drift is neutralized at bake time, keeping the vertical body-drop), so PlayerControls owns
// the travel exactly like the roll. See d:/tmp/jogcheck/bake_slide.mjs / tools/slide_to_glb.html.
const ueSlideSrc = 'assets/characters/ue/Slide.glb'

// Crouch-idle clip, baked the SAME way as the roll (FBX -> GLB via tools/run_crouchidle_bake.mjs,
// since r127's FBXLoader can't parse A_Rifle_Crouch_Idle.fbx — it throws in parseAnimationLayers).
// A small skeleton-only GLB carrying ONE clip named 'crouch_idle'; the game pulls animations[0] and
// adapts it onto the pre-oriented rig like every other clip. Drives the player's crouch-IDLE pose
// (bent knees + lowered hips are AUTHORED in the clip), so entering crouch is a smooth mixer
// crossfade — no procedural body-drop + FootIK knee-snap. Crouch-WALK stays procedural (jog + drop).
const ueCrouchIdleSrc = 'assets/characters/ue/CrouchIdle.glb'

// Third-person weapon: a UE SkeletalMesh AK exported as FBX (v7300, which r127's
// FBXLoader parses fine). Socketed into the mannequin's right hand in TPS; the
// first-person view keeps its own arms+gun viewmodel (Hands/WeaponManager).
const ak47Tps = 'assets/guns/New/SK_AK47.FBX'

// Magazine-reload clip for the in-hand third-person AK, baked offline from
// A_SK_AK47_Rifle_Reload_.fbx into a tiny skeleton+clip GLB (FBX->GLB via
// tools/ak47_reload_to_glb.html; r127's FBXLoader can't parse that UE 7500 export).
// Carries ONE clip 'reload' (2.2333s, same length as the body reload) that drops/reseats
// the gun's 'Magazine' bone; the player drives the socketed SK_AK47 by bone name, synced
// to the body reload. See PlayerBody / the akMagReload extraction below.
const ak47Reload = 'assets/guns/New/AK47_Reload.glb'

//AK47 Model and textures
const ak47 = 'assets/guns/ak47/ak47.glb'
const muzzleFlash = 'assets/muzzle_flash.glb'
//Shot sound
const ak47Shot = 'assets/sounds/ak47_shot.wav'

//Ammo box
const ammobox = 'assets/ammo/AmmoBox.fbx'
const ammoboxTexD = 'assets/ammo/AmmoBox_D.tga.png'
const ammoboxTexN = 'assets/ammo/AmmoBox_N.tga.png'
const ammoboxTexM = 'assets/ammo/AmmoBox_M.tga.png'
const ammoboxTexR = 'assets/ammo/AmmoBox_R.tga.png'
const ammoboxTexAO = 'assets/ammo/AmmoBox_AO.tga.png'

//Bullet Decal
const decalColor = 'assets/decals/decal_c.jpg'
const decalNormal = 'assets/decals/decal_n.jpg'
const decalAlpha = 'assets/decals/decal_a.jpg'

// Blood decals (sprayed onto the ENEMY geometry where a bullet lands — see BloodDecals). Two authored
// RGBA splatter shapes, picked at random per hit for variety.
const bloodDecal1 = 'assets/decals/Blood_decal_1.png'
const bloodDecal2 = 'assets/decals/Blood_Decal_2.png'
// Animated blood-splash spritesheet (8 frames in a horizontal strip) that replaces the procedural
// droplet burst as the hero impact VFX — see BloodFx.
const bloodSheet = 'assets/VFX/Blood_SpriteSheet.png'

//Sky
const skyTex = 'assets/sky.jpg'

// Heightmap for the uneven terrain (gentle hills/slopes that replace the flat ground). Sampled at load
// into a height grid + a static collider by the Terrain component; see entities/Level/Terrain.js.
const heightmap = 'assets/World/heightmaps_20260609_150752_1584m.png'

import DebugDrawer from './DebugDrawer.js'
import Navmesh from './entities/Level/Navmesh.js'
import AttackTrigger from './entities/NPC/AttackTrigger.js'
import DirectionDebug from './entities/NPC/DirectionDebug.js'
import CharacterCollision from './entities/NPC/CharacterCollision.js'
import Hands from './entities/Player/Hands.js'
import WeaponManager from './entities/Player/WeaponManager.js'
import PlayerBody from './entities/Player/PlayerBody.js'
import { adaptClipToPreOriented } from './entities/Common/UeMannequin.js'
import WeaponPlacementDebug from './entities/Player/WeaponPlacementDebug.js'
import WeaponAimDebug from './entities/Player/WeaponAimDebug.js'
import UIManager from './entities/UI/UIManager.js'
import AmmoBox from './entities/AmmoBox/AmmoBox.js'
import LevelBulletDecals from './entities/Level/BulletDecals.js'
import BloodFx from './entities/Common/BloodFx.js'
import BloodDecals from './entities/Common/BloodDecals.js'
import PlayerHealth from './entities/Player/PlayerHealth.js'
import UeExporter from './export/UeExporter.js'

class FPSGameApp{

  constructor(){
    this.lastFrameTime = null;
    this.assets = {};
    this.animFrameId = 0;

    AmmoHelper.Init(()=>{this.Init();});
  }

  Init(){
    this.LoadAssets();
    this.SetupGraphics();
    this.SetupStartButton();
  }

  SetupGraphics(){
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({antialias: true});
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.renderer.toneMapping = THREE.ReinhardToneMapping;
		this.renderer.toneMappingExposure = 1;
		this.renderer.outputEncoding = THREE.sRGBEncoding;

    this.camera = new THREE.PerspectiveCamera();
    this.camera.fov = 60;   // wider base FOV (precise-aim still zooms to its own tight FOV)
    this.camera.near = 0.01;

    // create an AudioListener and add it to the camera
    this.listener = new THREE.AudioListener();
    this.camera.add( this.listener );

    // renderer. CAP the device pixel ratio: rendering at full native DPI on a HiDPI display (Windows
    // scaling 125–200% => dpr 1.25–2.0) draws 1.5–4x the pixels for a barely-perceptible sharpness gain,
    // and with antialias + a soft-shadow pass that was the bulk of the recent frame-time cost. 1.5 keeps
    // the image crisp while cutting fill-rate hard on high-DPI panels. Raise toward 2 if you want sharper.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    this.WindowResizeHanlder();
    window.addEventListener('resize', this.WindowResizeHanlder);

    document.body.appendChild( this.renderer.domElement );

    // Stats.js
    this.stats = new Stats();
    document.body.appendChild(this.stats.dom);
  }

  SetupPhysics() {
    // Physics configuration
    const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration();
    const dispatcher = new Ammo.btCollisionDispatcher( collisionConfiguration );
    const broadphase = new Ammo.btDbvtBroadphase();
    const solver = new Ammo.btSequentialImpulseConstraintSolver();
    this.physicsWorld = new Ammo.btDiscreteDynamicsWorld( dispatcher, broadphase, solver, collisionConfiguration );
    this.physicsWorld.setGravity( new Ammo.btVector3( 0.0, -9.81, 0.0 ) );
    // The WASM Ammo build requires an Emscripten signature for addFunction
    // (the asm.js build the reference used inferred it). The internal tick
    // callback is void(btDynamicsWorld* world, btScalar timeStep) => 'vif'
    // (void; i32 pointer; float). The asm.js build ignores the extra arg, so
    // this stays compatible if the vendored build is ever swapped.
    const fp = Ammo.addFunction(this.PhysicsUpdate, 'vif');
    this.physicsWorld.setInternalTickCallback(fp);
    this.physicsWorld.getBroadphase().getOverlappingPairCache().setInternalGhostPairCallback(new Ammo.btGhostPairCallback());

    //Physics debug drawer
    //this.debugDrawer = new DebugDrawer(this.scene, this.physicsWorld);
    //this.debugDrawer.enable();
  }

  SetAnim(name, obj){
    const clip = obj.animations[0];
    this.mutantAnims[name] = clip;
  }

  PromiseProgress(proms, progress_cb){
    let d = 0;
    progress_cb(0);
    for (const p of proms) {
      p.then(()=> {    
        d++;
        progress_cb( (d / proms.length) * 100 );
      });
    }
    return Promise.all(proms);
  }

  AddAsset(asset, loader, name){
    return loader.loadAsync(asset).then( result =>{
      this.assets[name] = result;
    });
  }

  OnProgress(p){
    const progressbar = document.getElementById('progress');
    progressbar.style.width = `${p}%`;
  }

  HideProgress(){
    this.OnProgress(0);
  }

  SetupStartButton(){
    document.getElementById('start_game').addEventListener('click', this.StartGame);
  }

  ShowMenu(visible=true){
    document.getElementById('menu').style.visibility = visible?'visible':'hidden';
  }

  ShowLoading(visible=true){
    document.getElementById('loading').style.visibility = visible?'visible':'hidden';
  }

  // Drive the full-screen black curtain (#fade). opaque=true fades to black,
  // opaque=false fades back to clear. Resolves once the CSS transition has elapsed
  // (FADE_MS mirrors the 0.6s opacity transition in style.css).
  FadeTo(opaque){
    document.getElementById('fade').style.opacity = opaque ? '1' : '0';
    return new Promise(res => setTimeout(res, FADE_MS));
  }

  Delay(ms){ return new Promise(res => setTimeout(res, ms)); }

  async LoadAssets(){
    const gltfLoader = new GLTFLoader();
    const fbxLoader = new FBXLoader();
    // SK_AK47.FBX references a weapon-tint texture (T_WeaponColors.png) we neither
    // ship nor need — the gunmetal material is applied at runtime. Resolve that one
    // reference to a 1x1 pixel so the FBX import doesn't 404 in the console.
    const akManager = new THREE.LoadingManager();
    akManager.setURLModifier(url =>
      /T_WeaponColors\.png$/i.test(url)
        ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        : url);
    const akFbxLoader = new FBXLoader(akManager);
    const objLoader = new OBJLoader();
    const audioLoader = new THREE.AudioLoader();
    const texLoader = new THREE.TextureLoader();
    const promises = [];

    //Level
    promises.push(this.AddAsset(level, gltfLoader, "level"));
    promises.push(this.AddAsset(navmesh, objLoader, "navmesh"));
    //Mutant (enemy NPC)
    promises.push(this.AddAsset(mutant, fbxLoader, "mutant"));
    promises.push(this.AddAsset(idleAnim, fbxLoader, "idleAnim"));
    promises.push(this.AddAsset(walkAnim, fbxLoader, "walkAnim"));
    promises.push(this.AddAsset(runAnim, fbxLoader, "runAnim"));
    promises.push(this.AddAsset(attackAnim, fbxLoader, "attackAnim"));
    promises.push(this.AddAsset(dieAnim, fbxLoader, "dieAnim"));
    //UE Mannequin player body: Y-up mesh GLB (baked PBR) + legacy GLB for the clips
    promises.push(this.AddAsset(ueChar, gltfLoader, "ueChar"));
    //Human enemy body (Tripo "Liz") — same UE skeleton, drives the shared clips by bone name
    promises.push(this.AddAsset(lizChar, gltfLoader, "lizChar"));
    //Player body (Tripo "Frog") — same UE skeleton, drives the shared clips by bone name
    promises.push(this.AddAsset(frogChar, gltfLoader, "frogChar"));
    promises.push(this.AddAsset(ueClipsSrc, gltfLoader, "ueClips"));
    promises.push(this.AddAsset(ueRollSrc, gltfLoader, "ueRoll"));
    promises.push(this.AddAsset(ueSlideSrc, gltfLoader, "ueSlide"));
    promises.push(this.AddAsset(ueCrouchIdleSrc, gltfLoader, "ueCrouchIdle"));
    //Third-person AK
    promises.push(this.AddAsset(ak47Tps, akFbxLoader, "ak47Tps"));
    //In-hand AK magazine-reload clip (drives the SK_AK47 'Magazine' bone, synced to body reload)
    promises.push(this.AddAsset(ak47Reload, gltfLoader, "ak47Reload"));
    //AK47
    promises.push(this.AddAsset(ak47, gltfLoader, "ak47"));
    promises.push(this.AddAsset(muzzleFlash, gltfLoader, "muzzleFlash"));
    promises.push(this.AddAsset(ak47Shot, audioLoader, "ak47Shot"));
    //Ammo box
    promises.push(this.AddAsset(ammobox, fbxLoader, "ammobox"));
    promises.push(this.AddAsset(ammoboxTexD, texLoader, "ammoboxTexD"));
    promises.push(this.AddAsset(ammoboxTexN, texLoader, "ammoboxTexN"));
    promises.push(this.AddAsset(ammoboxTexM, texLoader, "ammoboxTexM"));
    promises.push(this.AddAsset(ammoboxTexR, texLoader, "ammoboxTexR"));
    promises.push(this.AddAsset(ammoboxTexAO, texLoader, "ammoboxTexAO"));
    //Decal
    promises.push(this.AddAsset(decalColor, texLoader, "decalColor"));
    promises.push(this.AddAsset(decalNormal, texLoader, "decalNormal"));
    promises.push(this.AddAsset(decalAlpha, texLoader, "decalAlpha"));
    //Blood decals + blood-splash spritesheet
    promises.push(this.AddAsset(bloodDecal1, texLoader, "bloodDecal1"));
    promises.push(this.AddAsset(bloodDecal2, texLoader, "bloodDecal2"));
    promises.push(this.AddAsset(bloodSheet, texLoader, "bloodSheet"));

    promises.push(this.AddAsset(skyTex, texLoader, "skyTex"));
    //Heightmap (uneven terrain)
    promises.push(this.AddAsset(heightmap, texLoader, "heightmap"));

    await this.PromiseProgress(promises, this.OnProgress);

    this.assets['level'] = this.assets['level'].scene;
    this.assets['muzzleFlash'] = this.assets['muzzleFlash'].scene;

    // Blood textures are authored colour (sRGB) — tag them so they read at the right colour under the
    // sRGB output pass (untagged they'd render washed-out/pink). The spritesheet additionally keeps its
    // default clamp-to-edge wrap so a frame's UV window never bleeds the neighbouring frame.
    for(const k of ['bloodDecal1', 'bloodDecal2', 'bloodSheet']){
      const t = this.assets[k];
      if(t){ t.encoding = THREE.sRGBEncoding; t.needsUpdate = true; }
    }

    //Extract mutant anims (enemy NPC)
    this.mutantAnims = {};
    this.SetAnim('idle', this.assets['idleAnim']);
    this.SetAnim('walk', this.assets['walkAnim']);
    this.SetAnim('run', this.assets['runAnim']);
    this.SetAnim('attack', this.assets['attackAnim']);
    this.SetAnim('die', this.assets['dieAnim']);

    //Extract UE Mannequin (player body): new Y-up mesh GLB (baked PBR materials) + the named
    //clips from the legacy bake (SK_Mannequin.glb now carries idle, the forward jog ('walk'),
    //the directional jogs (jog_bwd/left/right), the jump pair (jump_start/jump_fall), reload and
    //shoot). The clips drive the new rig by bone name (same UE skeleton); textures are baked into
    //the mesh, so no external texture set is needed.
    this.ueModel = this.assets['ueChar'].scene;
    // Human-enemy body mesh (same UE skeleton, different proportions via baked per-bone scales).
    // The AI soldiers clone THIS instead of the mannequin; the shared ueAnims drive it by bone name.
    this.lizModel = this.assets['lizChar'].scene;
    // Player body mesh (Tripo "Frog"): same UE skeleton again, so the shared ueAnims drive it by
    // bone name with no re-bake. The player clones THIS instead of the mannequin (this.ueModel).
    this.frogModel = this.assets['frogChar'].scene;
    const ueClips = this.assets['ueClips'].animations;
    // Adapt each legacy clip onto the pre-oriented rig (drop 'root', rotate pelvis;
    // see adaptClipToPreOriented). Adapt once and share across player + soldier.
    const byName = (n) => { const c = ueClips.find(c => c.name === n); return c ? adaptClipToPreOriented(c) : undefined; };
    // The forward-roll ships in its own GLB (ueRoll); adapt it the same way. Match by name, else
    // take the only clip in that file.
    const rollSrcClips = this.assets['ueRoll'] ? this.assets['ueRoll'].animations : [];
    const rollRaw = rollSrcClips.find(c => c.name === 'roll') || rollSrcClips[0];
    const rollClip = rollRaw ? adaptClipToPreOriented(rollRaw) : undefined;
    // The forward SLIDE ships in its own GLB (ueSlide), baked in place the same way as the roll.
    // Adapt it onto the pre-oriented rig like every other clip; drives the double-tap dodge (the
    // roll now serves the hard-landing animation instead). Player-only.
    const slideSrcClips = this.assets['ueSlide'] ? this.assets['ueSlide'].animations : [];
    const slideRaw = slideSrcClips.find(c => c.name === 'slide') || slideSrcClips[0];
    const slideClip = slideRaw ? adaptClipToPreOriented(slideRaw) : undefined;
    // Crouch-idle ships in its own GLB (ueCrouchIdle), baked from A_Rifle_Crouch_Idle.fbx the same
    // way as the roll. Adapt it onto the pre-oriented rig like every other clip; player-only.
    const crouchSrcClips = this.assets['ueCrouchIdle'] ? this.assets['ueCrouchIdle'].animations : [];
    const crouchIdleRaw = crouchSrcClips.find(c => c.name === 'crouch_idle') || crouchSrcClips[0];
    const crouchIdleClip = crouchIdleRaw ? adaptClipToPreOriented(crouchIdleRaw) : undefined;
    const walkClip = byName('walk');
    // The AI soldier still uses a 'run' (chase) state which reuses the jog clip — but it must
    // be a SEPARATE clip instance, not the same object as 'walk'. Within one AnimationMixer two
    // actions bound to the SAME clip share the underlying property bindings; crossfading
    // walk<->run then briefly leaves the skeleton with no action driving it, snapping it to the
    // bind (T) pose for a few frames. Cloning gives 'run' its own bindings.
    this.ueAnims = {
      idle: byName('idle'),
      // Dedicated down-the-sights aim pose (drives the torso while ADS — replaces the old
      // idle-upper placeholder). Player-only; the soldier ignores unknown clips. Falls back
      // to the idle-upper pose in PlayerBody if this clip didn't bake.
      aim: byName('aim'),
      walk: walkClip,                          // forward jog (soldier 'walk' / player 'jogF')
      run: walkClip ? walkClip.clone() : undefined,   // soldier chase (separate instance)
      reload: byName('reload'),
      shoot: byName('shoot'),
      // Player directional locomotion + jump anim graph (see PlayerBody). Forward jog reuses the
      // 'walk' clip (the player splits it per-layer, so sharing the object is safe); the rest are
      // the new directional / jump clips, adapted to the pre-oriented rig like the others.
      jogF: walkClip,
      jogB: byName('jog_bwd'),
      jogL: byName('jog_left'),
      jogR: byName('jog_right'),
      jumpStart: byName('jump_start'),
      jumpFall: byName('jump_fall'),
      // Directional dodge SLIDE (double-tap a movement key) + the forward ROLL, now repurposed as the
      // hard-landing recovery. Both are full-body ground moves that conform to terrain (see PlayerBody).
      // Player-only; the soldier ignores unknown clips.
      roll: rollClip,
      slide: slideClip,
      // Authored crouch-idle pose (player-only; soldier ignores it). Drives the crouch-idle legs+torso.
      crouchIdle: crouchIdleClip,
    };
    this.ueTextures = null;   // baked into the mesh GLB

    // The SK_AK47 FBX ships no usable r127 material; give it a neutral gunmetal.
    // It's a SkeletalMesh, so match material.skinning to the mesh type or the
    // shadow pass warns and mis-renders skinned parts.
    this.assets['ak47Tps'].traverse(child => {
      if(child.isMesh || child.isSkinnedMesh){
        child.material = new THREE.MeshStandardMaterial({
          color: 0x2b2e33, metalness: 0.9, roughness: 0.45, skinning: child.isSkinnedMesh,
        });
      }
    });

    this.assets['ak47'].scene.animations = this.assets['ak47'].animations;

    // In-hand AK magazine reload clip. Strip the whole-gun 'Root' tracks so the gun stays
    // SOCKETED in the hand (it follows hand_r via the body reload anim); keep the 'Magazine'
    // tracks so only the mag drops out and reseats. The clip drives the in-hand SK_AK47 by
    // bone name on the player body's own mixer (the gun is a descendant of the rig), so it
    // stays frame-locked to the character reload — both run 2.2333s. Cloned before filtering
    // so the source asset is left intact.
    const akReloadClips = this.assets['ak47Reload'] ? this.assets['ak47Reload'].animations : [];
    const akReloadRaw = akReloadClips.find(c => c.name === 'reload') || akReloadClips[0];
    this.akMagReloadClip = undefined;
    if(akReloadRaw){
      const clip = akReloadRaw.clone();
      clip.tracks = clip.tracks.filter(t => !t.name.startsWith('Root.'));
      clip.name = 'gun_reload';
      this.akMagReloadClip = clip;
    }

    //Set ammo box textures and other props
    this.assets['ammobox'].scale.set(0.01, 0.01, 0.01);
    this.assets['ammobox'].traverse(child =>{
      child.castShadow = true;
      child.receiveShadow = true;
      
      child.material = new THREE.MeshStandardMaterial({
        map: this.assets['ammoboxTexD'],
        aoMap: this.assets['ammoboxTexAO'],
        normalMap: this.assets['ammoboxTexN'],
        metalness: 1,
        metalnessMap: this.assets['ammoboxTexM'],
        roughnessMap: this.assets['ammoboxTexR'],
        color: new THREE.Color(0.4, 0.4, 0.4)
      });
      
    });

    this.assets['ammoboxShape'] = createConvexHullShape(this.assets['ammobox']);

    this.HideProgress();
    // Reveal the start menu by fading the black boot curtain out from over it.
    this.ShowMenu();
    await this.FadeTo(false);
  }

  EntitySetup(){
    this.entityManager = new EntityManager();

    const levelEntity = new Entity();
    levelEntity.SetName('Level');
    // Build the uneven terrain FIRST: its collider + HeightAt must exist before the level + every spawn is
    // snapped onto it. Added as a component so the NPC controllers can ride it (FindEntity('Level')).
    const terrain = new Terrain(this.scene, this.physicsWorld, this.assets['heightmap'].image);
    levelEntity.AddComponent(terrain);
    levelEntity.AddComponent(new LevelSetup(this.assets['level'], this.scene, this.physicsWorld, terrain));
    levelEntity.AddComponent(new Navmesh(this.scene, this.assets['navmesh']));
    levelEntity.AddComponent(new LevelBulletDecals(this.scene, this.assets['decalColor'], this.assets['decalNormal'], this.assets['decalAlpha']));
    // Shared blood-splatter burst — spritesheet-animated splash cards + a fine droplet mist (pooled).
    // One instance; combatants fetch it on hit (FindEntity('Level').GetComponent('BloodFx')).
    levelEntity.AddComponent(new BloodFx(this.scene, this.camera, this.assets['bloodSheet']));
    // Shared blood DECALS sprayed onto the enemy body geometry where a bullet lands (bone-attached, so
    // they ride the animation + ragdoll). Combatants fetch it on hit, like BloodFx.
    levelEntity.AddComponent(new BloodDecals(this.scene, this.assets['bloodDecal1'], this.assets['bloodDecal2']));
    this.entityManager.Add(levelEntity);

    const skyEntity = new Entity();
    skyEntity.SetName("Sky");
    skyEntity.AddComponent(new Sky(this.scene, this.assets['skyTex']));
    // Drifting bright-day cloud deck (ported from SkibidiTower, re-graded for daylight).
    skyEntity.AddComponent(new Clouds(this.scene));
    this.entityManager.Add(skyEntity);

    const playerEntity = new Entity();
    playerEntity.SetName("Player");
    playerEntity.AddComponent(new PlayerPhysics(this.physicsWorld, Ammo));
    playerEntity.AddComponent(new PlayerControls(this.camera, this.scene));
    playerEntity.AddComponent(new PlayerBody(SkeletonUtils.clone(this.frogModel), this.ueAnims, this.scene, this.camera, this.ueTextures, SkeletonUtils.clone(this.assets['ak47Tps']), true, this.akMagReloadClip));
    playerEntity.AddComponent(new Hands(this.camera, this.assets['ak47'].scene));
    playerEntity.AddComponent(new WeaponManager(this.camera, this.physicsWorld, this.assets['muzzleFlash'], this.assets['ak47Shot'], this.listener ));
    playerEntity.AddComponent(new PlayerHealth());
    // Dev aid: press ` in TPS to nudge the in-hand AK and copy a WEAPON_GRIP snippet.
    // Added after PlayerBody so its weaponPivot exists when this initializes.
    playerEntity.AddComponent(new WeaponPlacementDebug());
    // Dev aid: press K to visualize the weapon aim-alignment + two-hand IK (aim target, crosshair
    // ray, barrel vs corrected direction, IK grip sockets, live blend value). Toggles, off by default.
    playerEntity.AddComponent(new WeaponAimDebug());
    // Spawn the player on the terrain (the physics capsule then settles onto it). 1.48 = capsule centre
    // above the ground; add the terrain height so it isn't dropped from inside a hill / above a valley.
    playerEntity.SetPosition(new THREE.Vector3(5.64, 1.48 + terrain.HeightAt(5.64, -1.36), -1.36));
    playerEntity.SetRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), -Math.PI * 0.5));
    this.entityManager.Add(playerEntity);

    const npcLocations = [
      [10.8, 0.0, 22.0],
    ];

    npcLocations.forEach((v,i)=>{
      const npcEntity = new Entity();
      npcEntity.SetPosition(new THREE.Vector3(v[0], v[1] + terrain.HeightAt(v[0], v[2]), v[2]));
      npcEntity.SetName(`Mutant${i}`);
      npcEntity.AddComponent(new NpcCharacterController(SkeletonUtils.clone(this.assets['mutant']), this.mutantAnims, this.scene, this.physicsWorld));
      npcEntity.AddComponent(new AttackTrigger(this.physicsWorld));
      npcEntity.AddComponent(new CharacterCollision(this.physicsWorld));
      npcEntity.AddComponent(new DirectionDebug(this.scene));
      this.entityManager.Add(npcEntity);
    });

    // Velocity-driven UE Mannequin soldiers: same rig/textures/AK as the player, but
    // AI-driven and moved by an explicit velocity (path-follow at a target speed) with the
    // animation chosen from the measured speed. Five human enemies wired into the faction
    // system (see Factions.js). The humans are ONE COOPERATIVE SIDE now: every soldier is an
    // ENEMY that hunts the PLAYER and the BEAST and NEVER fires on a fellow human — no more
    // friendly-fire free-for-all. Per-instance combat STYLE (aggression / preferred range /
    // flank side / cadence) is still randomized in the controller, so the squad keeps its
    // variety without any faction infighting.
    const soldiers = [
      { pos: [13.0, 0.0, 22.0], faction: Faction.ENEMY },
      // Was [20,17] — that point sits in a navmesh gap (under a container), so FindClearSpawn ->
      // NearestWalkablePoint couldn't resolve it (the spawn Y is the terrain height ~-0.5 m, ~1 m
      // below the navmesh at ~0.5 m, and the group lookup is Y-sensitive) and fell back to the
      // world ORIGIN — the soldier spawned at (0,0,0). [21,23] resolves cleanly onto a walkable
      // node (~21.4, 23.5), well clear of the other four spawns.
      { pos: [21.0, 0.0, 23.0], faction: Faction.ENEMY },
      { pos: [27.0, 0.0, 29.0], faction: Faction.ENEMY },
      { pos: [30.0, 0.0, 19.0], faction: Faction.ENEMY },
      { pos: [16.0, 0.0, 31.0], faction: Faction.ENEMY },
    ];

    soldiers.forEach((s,i)=>{
      const soldierEntity = new Entity();
      soldierEntity.SetPosition(new THREE.Vector3(s.pos[0], s.pos[1] + terrain.HeightAt(s.pos[0], s.pos[2]), s.pos[2]));
      soldierEntity.SetName(`UeSoldier${i}`);
      // Body = the "Liz" human-enemy mesh (cloned per soldier). SkeletonUtils.clone SHARES the
      // geometry buffers across clones (only the skeleton/bones are cloned), so the decimated ~70k-vert
      // mesh lives in memory once; each soldier still skins it per frame. preOriented:true exactly as the
      // mannequin — Liz is the same Y-up/metre pre-oriented rig, so the shared clips + IK apply.
      soldierEntity.AddComponent(new UeSoldierController(SkeletonUtils.clone(this.lizModel), this.ueAnims, this.scene, this.physicsWorld, this.ueTextures, SkeletonUtils.clone(this.assets['ak47Tps']), true, this.assets['ak47Shot'], this.listener, s.faction));
      soldierEntity.AddComponent(new AttackTrigger(this.physicsWorld));
      soldierEntity.AddComponent(new UeSoldierCollision(this.physicsWorld));
      this.entityManager.Add(soldierEntity);
    });

    const uimanagerEntity = new Entity();
    uimanagerEntity.SetName("UIManager");
    uimanagerEntity.AddComponent(new UIManager());
    this.entityManager.Add(uimanagerEntity);

    // UE export layer (press P to download level_ue.glb + mechanics.json).
    const exporterEntity = new Entity();
    exporterEntity.SetName("UeExporter");
    exporterEntity.AddComponent(new UeExporter(this.scene, this.entityManager));
    this.entityManager.Add(exporterEntity);

    const ammoLocations = [
       [14.37, 0.0, 10.45],
       [32.77, 0.0, 33.84],
    ];

    ammoLocations.forEach((loc, i) => {
      const box = new Entity();
      box.SetName(`AmmoBox${i}`);
      box.AddComponent(new AmmoBox(this.scene, this.assets['ammobox'].clone(), this.assets['ammoboxShape'], this.physicsWorld));
      box.SetPosition(new THREE.Vector3(loc[0], loc[1] + terrain.HeightAt(loc[0], loc[2]) + 0.1, loc[2]));
      this.entityManager.Add(box);
    });

    this.entityManager.EndSetup();

    // Pre-warm the blood-decal projection path (cold V8 JIT + DecalGeometry is ~1.5s on its first calls)
    // behind the loading screen, using a freshly-built enemy mesh, so the first in-combat hit doesn't hitch.
    const warmSoldier = this.entityManager.Get('UeSoldier0');
    const warmCtrl = warmSoldier && warmSoldier.GetComponent('UeSoldierController');
    const bloodDecals = levelEntity.GetComponent('BloodDecals');
    if(warmCtrl && warmCtrl.skinnedmesh && bloodDecals){ bloodDecals.Prewarm(warmCtrl.skinnedmesh); }

    this.scene.add(this.camera);
    this.animFrameId = window.requestAnimationFrame(this.OnAnimationFrameHandler);
  }

  StartGame = async ()=>{
    // Guard against a double-click re-entering the transition mid-fade.
    if(this.starting){ return; }
    this.starting = true;

    // 1. Fade the menu out to black, then swap it for the loading screen.
    await this.FadeTo(true);
    this.ShowMenu(false);
    this.ShowLoading(true);
    // 2. Fade the loading screen in from black.
    await this.FadeTo(false);

    // 3. Build the game behind the loading screen (its opaque bg hides the live
    //    render that begins inside EntitySetup). Yield a frame first so the loading
    //    screen paints before the synchronous setup briefly blocks the main thread.
    window.cancelAnimationFrame(this.animFrameId);
    Input.ClearEventListners();
    this.scene.clear();
    this.SetupPhysics();
    await this.Delay(0);
    this.EntitySetup();
    await this.Delay(MIN_LOADING_MS);

    // 4. Fade to black over the loading screen, hide it, then fade gameplay in.
    await this.FadeTo(true);
    this.ShowLoading(false);
    this.ShowMenu(false);
    await this.FadeTo(false);

    this.starting = false;
  }

  // resize
  WindowResizeHanlder = () => { 
    const { innerHeight, innerWidth } = window;
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // render loop
  OnAnimationFrameHandler = (t) => {
    if(this.lastFrameTime===null){
      this.lastFrameTime = t;
    }

    const delta = t-this.lastFrameTime;
    let timeElapsed = Math.min(1.0 / 30.0, delta * 0.001);
    this.Step(timeElapsed);
    this.lastFrameTime = t;

    this.animFrameId = window.requestAnimationFrame(this.OnAnimationFrameHandler);
  }

  PhysicsUpdate = (world, timeStep)=>{
    this.entityManager.PhysicsUpdate(world, timeStep);
  }

  Step(elapsedTime){
    this.physicsWorld.stepSimulation( elapsedTime, 10 );
    //this.debugDrawer.update();

    this.entityManager.Update(elapsedTime);

    this.renderer.render(this.scene, this.camera);
    this.stats.update();
  }

}

let _APP = null;
window.addEventListener('DOMContentLoaded', () => {
  _APP = new FPSGameApp();
  // Expose for debugging / automated QA (inspect scene, physics, entities).
  window._APP = _APP;
});
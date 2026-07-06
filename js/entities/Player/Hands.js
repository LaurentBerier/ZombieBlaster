import * as THREE from 'three'
import Component from '../../Component.js'
import WeaponFSM from './WeaponFSM.js';


// First-person viewmodel: the rigged arms that hold whatever weapon is equipped.
// Owns the arms skeleton, the animation mixer/FSM (idle/shoot/reload), the weapon
// bob and aim-down-sights behaviours, and exposes the `gun` bone as the socket that
// weapons attach to. The actual weapon meshes are owned by WeaponManager — Hands is
// deliberately weapon-agnostic so any weapon can ride the same arm animations.
export default class Hands extends Component{
    constructor(camera, model){
        super();
        this.name = 'Hands';
        this.camera = camera;
        this.model = model;
        this.animations = {};

        // The currently equipped weapon, set by WeaponManager. The animation FSM
        // polls this for shoot/ammo state so it never needs to know which gun it is.
        this.activeWeapon = null;

        // Weapon bob (walk/sprint wobble). basePos is the resting hip offset; the
        // bob is added on top of the current offset each frame based on move speed.
        this.basePos = new THREE.Vector3(0.04, -0.02, 0.0);
        this.bobTime = 0.0;
        this.bobIntensity = 0.0;
        this.playerControls = null;

        // Aim down sights (hold right click): the arms ease toward adsPos, the
        // camera FOV zooms toward adsFov, and the bob is damped for precision.
        this.aiming = false;
        this.adsPos = new THREE.Vector3(-0.032, 0.01, 0.0);
        this.currentOffset = this.basePos.clone();
        this.defaultFov = 50;
        this.adsFov = 17;
        this.adsLerpSpeed = 14;

        // Arm orientation. baseRot is the angled hip pose; adsRot squares the arms
        // up with the camera (barrel straight down the view) while aiming.
        this.baseRotEuler = new THREE.Euler(THREE.MathUtils.degToRad(5), THREE.MathUtils.degToRad(185), 0);
        this.adsRotEuler  = new THREE.Euler(THREE.MathUtils.degToRad(-1), THREE.MathUtils.degToRad(177.5), THREE.MathUtils.degToRad(-0.5));
        this.baseRotQuat = new THREE.Quaternion().setFromEuler(this.baseRotEuler);
        this.adsRotQuat  = new THREE.Quaternion().setFromEuler(this.adsRotEuler);
        // How much of the idle sway animation to keep while aiming (0 = frozen,
        // 1 = full). Kept slightly above zero so the arms still breathe a little.
        this.adsIdleWeight = 0.15;

        // The FP arms/weapon viewmodel only makes sense in first-person. Default
        // is third-person, so they start hidden and skip their FP-only updates.
        this.cameraMode = 'TPS';
    }

    SetAnim(name, clip){
        const action = this.mixer.clipAction(clip);
        this.animations[name] = {clip, action};
    }

    SetAnimations(){
        this.mixer = new THREE.AnimationMixer( this.model );
        this.SetAnim('idle', this.model.animations[1]);
        this.SetAnim('reload', this.model.animations[2]);
        this.SetAnim('shoot', this.model.animations[0]);
    }

    Initialize(){
        const scene = this.model;
        scene.scale.set(0.05, 0.05, 0.05);
        scene.position.copy(this.basePos);
        scene.quaternion.copy(this.baseRotQuat);

        scene.traverse(child=>{
            if(!child.isSkinnedMesh){
                return;
            }

            child.receiveShadow = true;
        });

        this.camera.add(scene);

        // The combined model ships arms (SkeletalMeshComponent0) + the AK mesh
        // (SMDImport) on one armature. The gun's moving parts (magazine, slider,
        // trigger) are bones in this same metarig, animated by the fire/idle/reload
        // clips. To keep that sub-animation (e.g. the magazine drop on reload) we
        // leave the weapon mesh skinned to the metarig and let WeaponManager toggle
        // it / swap in tinted clones bound to the same skeleton. Hidden until equipped.
        this.weaponMesh = scene.getObjectByName('SMDImport');
        this.weaponMesh.visible = false;

        this.SetAnimations();

        this.stateMachine = new WeaponFSM(this);
        this.stateMachine.SetState('idle');

        this.playerControls = this.GetComponent("PlayerControls");

        // Capture the camera's resting FOV so we can zoom back to it after aiming.
        this.defaultFov = this.camera.fov;
        this.currentOffset.copy(this.basePos);

        // Hide/show with the camera mode (default TPS => arms hidden).
        this.parent.RegisterEventHandler(this.OnCameraMode, 'camera.mode');
        this.SetCameraMode(this.cameraMode);
    }

    OnCameraMode = (msg) => { this.SetCameraMode(msg.mode); }

    SetCameraMode(mode){
        this.cameraMode = mode;
        // First-person now renders the full body avatar (the camera rides its head
        // bone), so the separate arms viewmodel is never drawn in either mode. It
        // stays alive purely as the animation FSM + ADS/FOV driver, so keep it hidden.
        this.model.visible = false;
        if(mode !== 'FPS'){
            // Leaving FP: drop any aim zoom so the TPS camera keeps the default FOV.
            this.aiming = false;
            this.camera.fov = this.defaultFov;
            this.camera.updateProjectionMatrix();
        }
    }

    // ---- API consumed by WeaponManager ----
    GetSkinnedWeaponMesh(){ return this.weaponMesh; }
    GetModelRoot(){ return this.model; }
    SetActiveWeapon(weapon){ this.activeWeapon = weapon; }
    PlayReload(){ this.stateMachine.SetState('reload'); }

    // ---- Pass-throughs so the animation FSM can stay weapon-agnostic ----
    get shoot(){ return this.activeWeapon ? this.activeWeapon.shoot : false; }
    get magAmmo(){ return this.activeWeapon ? this.activeWeapon.magAmmo : 0; }
    ReloadDone(){ this.activeWeapon && this.activeWeapon.ReloadDone(); }

    // Aim down sights: ease the camera FOV and the arms' resting offset toward
    // their ADS targets while right click is held.
    Aim(t){
        const lerpFactor = Math.min(1, t * this.adsLerpSpeed);

        const targetFov = this.aiming ? this.adsFov : this.defaultFov;
        this.camera.fov += (targetFov - this.camera.fov) * lerpFactor;
        this.camera.updateProjectionMatrix();

        const targetOffset = this.aiming ? this.adsPos : this.basePos;
        this.currentOffset.lerp(targetOffset, lerpFactor);

        // Square the arms up with the camera while aiming (removes the hip angle).
        const targetRot = this.aiming ? this.adsRotQuat : this.baseRotQuat;
        this.model.quaternion.slerp(targetRot, lerpFactor);
    }

    // Steady the arms while aiming by fading down the idle sway animation's weight
    // (the mixer blends the rest of the way toward the steady rest pose). Only
    // touches the idle state so it never fights the shoot/reload transitions.
    SteadyAim(t){
        const state = this.stateMachine.currentState;
        if(!state || state.Name !== 'idle'){
            return;
        }

        const idleAction = this.animations['idle'].action;
        const targetWeight = this.aiming ? this.adsIdleWeight : 1.0;
        const lerpFactor = Math.min(1, t * this.adsLerpSpeed);
        const weight = THREE.MathUtils.lerp(idleAction.getEffectiveWeight(), targetWeight, lerpFactor);
        idleAction.setEffectiveWeight(weight);
    }

    // Walk/sprint bob: a sin/cos sway added to the current resting offset. Amplitude
    // and frequency scale with the player's speed, so sprinting wobbles wider and
    // faster than walking. Damped while aiming so the sights stay steady.
    WeaponBob(t){
        const controls = this.playerControls;
        if(!controls){
            return;
        }

        const speed = controls.HorizontalSpeed;
        const moving = speed > 0.5 && controls.IsGrounded;

        const target = moving ? 1.0 : 0.0;
        this.bobIntensity = THREE.MathUtils.lerp(this.bobIntensity, target, 1 - Math.pow(0.0025, t));

        const speedRatio = THREE.MathUtils.clamp(speed / controls.walkSpeed, 0.0, 2.0);
        const bobScale = this.aiming ? 0.35 : 1.0;

        const freq = 8.0 * (0.6 + 0.4 * speedRatio);
        this.bobTime += t * freq;

        const bobX = Math.sin(this.bobTime) * 0.010 * speedRatio * this.bobIntensity * bobScale;
        const bobY = Math.abs(Math.cos(this.bobTime)) * 0.014 * speedRatio * this.bobIntensity * bobScale;

        this.model.position.set(
            this.currentOffset.x + bobX,
            this.currentOffset.y + bobY,
            this.currentOffset.z
        );
    }

    Update(t){
        // The arms viewmodel is permanently invisible (first-person renders the full-body avatar and the
        // camera rides its head bone), so only the animation FSM still matters — it advances the
        // shoot/reload state WeaponManager polls. The old FP-only block (ADS FOV zoom, idle steady, weapon
        // bob) is intentionally gone: PlayerControls now owns the camera FOV in BOTH modes (fpsFov /
        // fpsAimFov), and Hands writing camera.fov every frame FOUGHT that — two easers dragging the FOV to
        // a wrong compromise (~46° instead of the intended 72° ADS) and wobbling it through aim transitions
        // (a first-person "FOV breathing" that read as camera shake). Aim/SteadyAim/WeaponBob only ever
        // moved the invisible model or that contested FOV, so dropping them is purely corrective.
        this.mixer.update(t);
        this.stateMachine.Update(t);
    }
}

import * as THREE from 'three'
import Component from '../../Component.js'
import Input from '../../Input.js'

import Weapon from './Weapon.js'
import { WEAPON_DEFS } from '../Weapons/weaponDefs.js'


// Owns the weapon loadout and swaps weapons on the Hands viewmodel's socket bone.
// Weapons are independent rigid meshes; switching just holsters one and attaches the
// next to the same hand socket, reusing the shared arm animations. Adding a real
// weapon later = one registry entry + a mesh.
export default class WeaponManager extends Component{
    constructor(camera, world, flash, shotSoundBuffer, audioListner, weaponRuntimes = []){
        super();
        this.name = 'WeaponManager';
        this.camera = camera;
        this.world = world;
        this.flash = flash;
        this.shotSoundBuffer = shotSoundBuffer;
        this.audioListner = audioListner;
        // [{ def, mesh }] — the funky arsenal: each entry's visible GLB is swapped onto the
        // hand by PlayerBody on equip; the def carries the fire params + grip.
        this.weaponRuntimes = weaponRuntimes;

        this.weapons = [];
        this.activeIndex = -1;
        this.hands = null;
        this.uimanager = null;

        // Reticle SPREAD (centre-to-tick gap, in vw — see UIManager.SetReticleSize / the CSS reticle).
        // Hipfire opens WIDE to convey the loose accuracy; ADS pulls in tight for precision. The tick
        // thickness is fixed in CSS, so only the gap changes — the precise (ADS) reticle and the wide
        // (hipfire) one share the exact same outline weight. A small bloom while the muzzle flash is lit
        // still reads firing as recoil (re-armed every shot, so it holds open under auto-fire).
        this.hipReticle = 1.5;
        this.aimReticle = 0.55;
        this.fireBloom = 0.4;
    }

    get active(){
        return this.activeIndex >= 0 ? this.weapons[this.activeIndex] : null;
    }

    Initialize(){
        this.hands = this.GetComponent('Hands');
        this.uimanager = this.FindEntity('UIManager').GetComponent('UIManager');
        this.controls = this.GetComponent('PlayerControls');
        this.body = this.GetComponent('PlayerBody');
        // The funky projectile weapons spawn their sprite bolts through this (may be
        // absent in a hitscan-only build).
        this.projectiles = this.GetComponent('ProjectileSystem');

        this.SetupMuzzleFlash();
        this.SetupSound();
        this.BuildLoadout();
        this.SetupInput();

        this.parent.RegisterEventHandler(this.AmmoPickup, 'AmmoPickup');
        // The third-person body reload anim finishing refills the mag (see PlayerBody).
        this.parent.RegisterEventHandler(this.OnReloadDone, 'reload.done');

        this.EquipWeapon(0);

        // After the loadout is equipped (FPS flash parented, in-hand AK socketed).
        this.SetupTpsMuzzleFlash();
    }

    SetupMuzzleFlash(){
        this.flash.children[0].material.blending = THREE.AdditiveBlending;
    }

    // Third-person muzzle flash. The FPS flash above rides the arms viewmodel, which
    // is hidden in TPS, so the body needs its own. Clone the flash quad + an
    // independent additive material and drop it straight in the world; each frame
    // UpdateTpsMuzzleFlash parks it just past the in-hand AK's muzzle and fades it in
    // lock-step with the active weapon's flash life.
    SetupTpsMuzzleFlash(){
        this.tpsFlash = null;
        this.weaponPivot = this.body ? this.body.weaponPivot : null;
        if(!this.body || !this.weaponPivot){ return; }

        this.tpsFlash = this.flash.clone(true);
        const mat = this.tpsFlash.children[0].material.clone();
        mat.blending = THREE.AdditiveBlending;
        mat.transparent = true;
        mat.depthWrite = false;
        this.tpsFlash.children[0].material = mat;
        this.tpsFlash.visible = false;
        this.tpsFlash.renderOrder = 999;   // additive flash draws last, over the gun
        this.body.scene.add(this.tpsFlash);

        // The body's AK muzzle flash is rendered in BOTH camera modes now (the full
        // body avatar is shown in FPS too, camera on its head bone). Size it per mode:
        // big for the ~3 m third-person boom, small for the point-blank first-person
        // muzzle right under the camera. Measure the quad's native size once at unit
        // scale; UpdateTpsMuzzleFlash scales to the active mode's world size each shot.
        this._tpsFlashSize = 0.45;   // metres, third-person
        this._fpsFlashSize = 0.26;   // metres, first-person (muzzle is ~0.5 m away) — 2x: the point-blank FPS flash read too small
        this._flashStretch = 1.0;    // per-shot width variety (set in TriggerTpsFlash)
        this.tpsFlash.scale.set(1, 1, 1);
        this.tpsFlash.updateMatrixWorld(true);
        const native = new THREE.Box3().setFromObject(this.tpsFlash).getSize(new THREE.Vector3());
        this._flashLongest = Math.max(native.x, native.y, native.z) || 1;
        this.tpsFlash.scale.setScalar(this._tpsFlashSize / this._flashLongest);

        // Anchor the flash at the AK's real muzzle, in the gun's own frame, so it
        // tracks the barrel regardless of camera angle (placing it by camera-forward
        // drifts off the tip because the view isn't aligned with the barrel).
        this.BuildMuzzleAnchor();
        this.tpsFlashRaise = 0.08;   // world-up nudge (m) onto the barrel line

        // Scratch + per-shot variety, reused each frame.
        this._tpsRoll = 0;
    }

    // Drop an empty anchor at the in-hand AK's muzzle. The gun's barrel is its
    // longest local axis; the muzzle is the end of that axis farther from the wrist
    // (hand bone), taken at the centre of the bbox's front face. Computed in the
    // weapon pivot's local frame so it rides the gun's animation/orientation.
    BuildMuzzleAnchor(){
        const pivot = this.weaponPivot;
        pivot.updateWorldMatrix(true, true);
        const toLocal = new THREE.Matrix4().copy(pivot.matrixWorld).invert();

        // Gather the gun geometry's bounding box expressed in pivot-local space.
        const local = new THREE.Box3();
        const corner = new THREE.Vector3();
        pivot.traverse(o => {
            if(!o.isMesh || !o.geometry){ return; }
            o.geometry.computeBoundingBox();
            const bb = o.geometry.boundingBox;
            for(let i = 0; i < 8; i++){
                corner.set(
                    (i & 1) ? bb.max.x : bb.min.x,
                    (i & 2) ? bb.max.y : bb.min.y,
                    (i & 4) ? bb.max.z : bb.min.z,
                );
                corner.applyMatrix4(o.matrixWorld).applyMatrix4(toLocal);
                local.expandByPoint(corner);
            }
        });

        const size = local.getSize(new THREE.Vector3());
        const center = local.getCenter(new THREE.Vector3());
        const axis = (size.x >= size.y && size.x >= size.z) ? 'x'
                   : (size.y >= size.z ? 'y' : 'z');

        // The two end-faces along the barrel axis (other axes at the bbox centre).
        const endA = center.clone(); endA[axis] = local.max[axis];
        const endB = center.clone(); endB[axis] = local.min[axis];

        // Muzzle = whichever end is farther from the wrist (hand bone). pivot.parent
        // is the hand_r bone that the gun is socketed to.
        const handPos = new THREE.Vector3();
        (pivot.parent || pivot).getWorldPosition(handPos);
        const wa = endA.clone().applyMatrix4(pivot.matrixWorld);
        const wb = endB.clone().applyMatrix4(pivot.matrixWorld);
        const muzzleLocal = wa.distanceToSquared(handPos) >= wb.distanceToSquared(handPos) ? endA : endB;

        this.muzzleAnchor = new THREE.Object3D();
        this.muzzleAnchor.position.copy(muzzleLocal);
        pivot.add(this.muzzleAnchor);
    }

    // Re-roll the body flash's spin and width on each shot.
    TriggerTpsFlash(){
        if(!this.tpsFlash){ return; }
        this._tpsRoll = Math.PI * Math.random();
        this._flashStretch = Math.random() * (1.5 - 0.8) + 0.8;
    }

    UpdateTpsMuzzleFlash(){
        if(!this.tpsFlash){ return; }
        const life = this.flash.life;
        if(life <= 0 || !this.active){
            this.tpsFlash.visible = false;
            return;
        }
        // Scale to the active camera mode (small up-close in FPS, large for the TPS
        // boom), with the per-shot width stretch on the local X.
        const fps = this.controls && this.controls.cameraMode === 'FPS';
        const base = (fps ? this._fpsFlashSize : this._tpsFlashSize) / this._flashLongest;
        this.tpsFlash.scale.set(base * this._flashStretch, base, base);

        // Park the flash at the AK's muzzle anchor (in the gun's own frame, so it
        // sits on the barrel tip whatever the camera/gun orientation), nudged up a
        // touch since the barrel runs along the top of the gun's bounding box.
        this.muzzleAnchor.getWorldPosition(this.tpsFlash.position);
        this.tpsFlash.position.y += this.tpsFlashRaise;
        // Billboard toward the camera, with the per-shot roll for variety.
        this.tpsFlash.quaternion.copy(this.camera.quaternion);
        this.tpsFlash.rotateZ(this._tpsRoll);
        this.tpsFlash.children[0].material.opacity = life / this.active.fireRate;
        this.tpsFlash.visible = true;
    }

    SetupSound(){
        // One shared shot sound is fine while weapons reuse the AK report; give each
        // weapon its own buffer here later for distinct audio.
        this.shotSound = new THREE.Audio(this.audioListner);
        this.shotSound.setBuffer(this.shotSoundBuffer);
        this.shotSound.setLoop(false);
    }

    BuildLoadout(){
        // The fire-logic mesh is the AK skinned mesh on the arms metarig — it drives the
        // shoot/reload FSM (mag drop, slider) and stays invisible in normal play; the
        // VISIBLE gun is the body's socketed weapon, swapped per weapon on equip.
        const akMesh = this.hands.GetSkinnedWeaponMesh();

        // Build a projectile Weapon per registry entry (the funky arsenal). All share the
        // invisible arms mesh for the FSM; each keeps its own fire params + bolt style.
        const defs = this.weaponRuntimes.length ? this.weaponRuntimes.map(r => r.def) : WEAPON_DEFS;
        this.weapons = defs.map(def => new Weapon(def.name, akMesh, {
            fireRate: def.fireRate, damage: def.damage, magSize: def.magSize, infiniteAmmo: true,
            fireMode: 'projectile', projectileSpeed: def.projectileSpeed, projectileType: def.projectileType,
            projectileRadius: def.projectileRadius, projectileColor: def.projectileColor,
            bulletStyle: def.bulletStyle, knockback: def.knockback, spread: def.spread,
            aoe: def.aoe, aoeRadius: def.aoeRadius, fx: def.fx,
        }));
        for(const weapon of this.weapons){
            weapon.owner = this.parent;
            weapon.Init({
                camera: this.camera,
                world: this.world,
                flash: this.flash,
                shotSound: this.shotSound,
                uimanager: this.uimanager,
                root: this.hands.GetModelRoot(),
            });
        }
    }

    _tint(material){
        const m = material.clone();
        m.color = new THREE.Color(0.45, 0.6, 1.0);
        return m;
    }

    EquipWeapon(index){
        if(index < 0 || index >= this.weapons.length || index === this.activeIndex){
            return;
        }

        this.active && this.active.Holster();

        this.activeIndex = index;
        const weapon = this.active;
        weapon.Attach();

        // Swap the VISIBLE in-hand gun to this weapon's GLB + grip (PlayerBody reseats it in
        // the hand pivot, updates the TPS grip seat, and re-resolves the aim-IK sockets).
        const runtime = this.weaponRuntimes[index];
        if(this.body && this.body.SetVisibleWeapon && runtime){
            this.body.SetVisibleWeapon(runtime.mesh, runtime.def.grip);
        }

        // Re-point the aim-IK at the new weapon: reseed the aim low-pass (OnWeaponChanged) so a swap
        // WHILE aiming glides instead of snapping, then apply any per-weapon overrides. Grip sockets are
        // NOT re-captured on a swap — re-reading the foregrip from the IK-rotated hand mid-aim would
        // record a wrong socket (see WeaponAimIK.OnWeaponChanged). Both registry weapons share the
        // in-hand pivot, so the init-captured sockets already fit; a genuinely different rigged mesh
        // supplies its own sockets via ikConfig (SetWeaponConfig).
        if(this.body && this.body.weaponAimIK){
            this.body.weaponAimIK.OnWeaponChanged();
            if(weapon.ikConfig){ this.body.weaponAimIK.SetWeaponConfig(weapon.ikConfig); }
        }

        this.hands.SetActiveWeapon(weapon);
        this.hands.stateMachine.SetState('idle');

        weapon.RefreshUI();
        this.uimanager.SetWeaponName && this.uimanager.SetWeaponName(weapon.name);
    }

    CycleWeapon(dir){
        const count = this.weapons.length;
        const next = (this.activeIndex + dir + count) % count;
        this.EquipWeapon(next);
    }

    // Tell the world the player just fired: broadcast a 'noise' to every entity carrying the player's
    // current position. AI controllers that registered a 'noise' handler (soldiers, the beast) decide
    // for themselves whether it's within earshot and react — so shooting (hit OR miss) draws nearby
    // enemies, not just a landed hit. Non-AI entities have no 'noise' handler, so the broadcast no-ops.
    NotifyNoise(){
        const manager = this.parent && this.parent.parent;   // EntityManager owning all entities
        if(!manager || !manager.entities){ return; }
        const pos = this.parent.Position;
        for(const entity of manager.entities){
            if(entity === this.parent){ continue; }
            entity.Broadcast({topic: 'noise', position: pos, source: this.parent, kind: 'gunfire'});
        }
    }

    AmmoPickup = () => {
        this.active && this.active.AddAmmo(30);
        this.active && this.active.RefreshUI();
    }

    OnReloadDone = () => {
        this.active && this.active.ReloadDone();
    }

    Reload(){
        const weapon = this.active;
        if(!weapon || !weapon.CanReload()){
            return;
        }

        weapon.BeginReload();
        this.hands.PlayReload();
        // Drive the third-person body's full-body reload one-shot too (no-op in FP
        // where the body is hidden, but keeps TPS in sync).
        this.Broadcast({topic: 'weapon.reload'});
    }

    SetupInput(){
        // Left click to fire. Capture the trigger intent even WHILE reloading: Weapon.Shoot still
        // refuses to fire mid-reload (its own `!this.reloading` guard), so latching shoot here just
        // means a press/hold during a reload resumes firing the instant the reload finishes. Swallowing
        // the click instead (the old `|| reloading` early-out) left the trigger "dead" — most visible
        // after a dodge roll, which cancels the fast third-person reload and leaves the long
        // first-person one running, so every fire press during that window was silently dropped and the
        // player had to click again. (Auto-reload is unchanged: it keys off magAmmo===0 && !reloading.)
        Input.AddMouseDownListner( e => {
            if(e.button != 0 || !this.active){
                return;
            }
            this.active.shoot = true;
            this.active.shootTimer = 0.0;
        });

        Input.AddMouseUpListner( e => {
            if(e.button != 0 || !this.active){
                return;
            }
            this.active.shoot = false;
        });

        // Right click to aim down sights (handled by the Hands viewmodel).
        Input.AddMouseDownListner( e => {
            if(e.button === 2){ this.hands.aiming = true; }
        });
        Input.AddMouseUpListner( e => {
            if(e.button === 2){ this.hands.aiming = false; }
        });

        // Suppress the context menu so right click can aim.
        document.addEventListener('contextmenu', e => e.preventDefault());

        Input.AddKeyDownListner(e => {
            if(e.repeat){ return; }

            if(e.code == 'KeyR'){
                this.Reload();
            }else if(e.code == 'Digit1'){
                this.EquipWeapon(0);
            }else if(e.code == 'Digit2'){
                this.EquipWeapon(1);
            }else if(e.code == 'Digit3'){
                this.EquipWeapon(2);
            }else if(e.code == 'Digit4'){
                this.EquipWeapon(3);
            }
        });

        // Mouse wheel cycles weapons.
        Input.AddMouseWheelListner(e => {
            this.CycleWeapon(e.deltaY > 0 ? 1 : -1);
        });
    }

    // Size the on-screen crosshair from the aim state: wider for hipfire, tighter for ADS, plus a
    // brief bloom while the muzzle flash is lit (re-armed every shot, so it holds open under auto-fire).
    UpdateReticle(aiming, weapon){
        if(!this.uimanager || !this.uimanager.SetReticleSize){ return; }
        const firing = !!(weapon && weapon.flash && weapon.flash.life > 0);
        let size = aiming ? this.aimReticle : this.hipReticle;
        if(firing){ size += this.fireBloom; }
        this.uimanager.SetReticleSize(size);
    }

    Update(t){
        const weapon = this.active;
        if(!weapon){
            return;
        }

        // ADS state (right-click in either camera mode): tightens the shot cone AND the reticle.
        const aiming = !!((this.controls && this.controls.aiming) || (this.hands && this.hands.aiming));
        weapon.aiming = aiming;
        this.UpdateReticle(aiming, weapon);

        // Auto-reload when trying to fire an empty mag (matches the old behaviour).
        if(weapon.shoot && weapon.magAmmo === 0 && !weapon.reloading){
            this.Reload();
        }

        if(weapon.Shoot(t)){
            // Drive the third-person body's full-body shoot one-shot (no-op in FP
            // where the body is hidden) and re-roll the TPS muzzle flash.
            this.Broadcast({topic: 'weapon.shoot'});
            this.TriggerTpsFlash();
            // Projectile weapons spawn their bolt from the muzzle toward the crosshair here.
            if(weapon.fireMode === 'projectile' && this.projectiles){
                this.projectiles.Fire(weapon);
            }
            // Gunfire is loud: let nearby AI HEAR the shot (hit or miss) so they react instantly
            // instead of only noticing a landed hit / a player who wandered into their view cone.
            this.NotifyNoise();
        }

        weapon.AnimateMuzzle(t);
        this.UpdateTpsMuzzleFlash();
    }
}

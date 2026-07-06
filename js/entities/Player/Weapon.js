import * as THREE from 'three'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'


// A single weapon instance, owned and driven by WeaponManager. The mesh is a
// SkinnedMesh bound to the arms metarig, so the fire/idle/reload clips animate the
// weapon's own parts (the magazine drops, the slider racks). Equipping just toggles
// visibility — swapping weapons shows a different skinned mesh on the same hands.
export default class Weapon{
    constructor(name, mesh, config = {}){
        this.name = name;
        this.mesh = mesh;

        this.fireRate = config.fireRate ?? 0.1;
        this.damage = config.damage ?? 2;
        this.ammoPerMag = config.magSize ?? 30;
        this.magAmmo = this.ammoPerMag;
        // Infinite reserve: the magazine still depletes per shot (so reloads still
        // trigger and play), but the reserve never runs out. Reload math is unchanged
        // since Infinity - n === Infinity, so the mag just refills full each time.
        this.infiniteAmmo = config.infiniteAmmo ?? false;
        this.ammo = this.infiniteAmmo ? Infinity : (config.ammo ?? 100);
        // Muzzle-flash anchor in the model-root space (same frame the original AK
        // used), so the flash sits at the barrel.
        this.barrelOffset = config.barrelOffset ?? new THREE.Vector3(-0.3, -0.5, 8.3);

        // --- Accuracy. The shot is a camera-centre ray; here we jitter it within a cone so hipfire
        // scatters and aiming (ADS) is near-pinpoint. WeaponManager sets `aiming` each frame from the
        // right-click ADS state. The crosshair/barrel still point dead-centre — only the bullet
        // deviates, so the spread reads off the reticle (which also opens up for hipfire).
        this.hipSpread = config.hipSpread ?? THREE.MathUtils.degToRad(3.0);   // hipfire cone half-angle (rad)
        this.aimSpread = config.aimSpread ?? THREE.MathUtils.degToRad(0.35);  // ADS cone half-angle (rad)
        this.aiming = false;
        this._worldUp = new THREE.Vector3(0, 1, 0);
        this._worldX = new THREE.Vector3(1, 0, 0);

        // Optional per-weapon aim-IK overrides (sockets/offsets/forward-axis, all in the in-hand
        // weaponPivot's local space) consumed by WeaponAimIK on equip. null => auto-resolve from the
        // gun's bbox + the posed hands. This is where a real rigged weapon declares its right/left grip
        // sockets, muzzle/aim socket, muzzleForwardAxis and hand offsets. See WeaponAimIK.SetWeaponConfig.
        this.ikConfig = config.ikConfig ?? null;

        this.shoot = false;
        this.shootTimer = 0.0;
        this.reloading = false;
        this.hitResult = {intersectionPoint: new THREE.Vector3(), intersectionNormal: new THREE.Vector3()};

        this.mesh.visible = false;
    }

    // Shared dependencies injected by WeaponManager. `root` is the arms model root
    // the muzzle flash parents to.
    Init({camera, world, flash, shotSound, uimanager, root}){
        this.camera = camera;
        this.world = world;
        this.flash = flash;
        this.shotSound = shotSound;
        this.uimanager = uimanager;
        this.root = root;
    }

    // ---- Equip / holster ----
    Attach(){
        this.mesh.visible = true;

        this.flash.position.copy(this.barrelOffset);
        this.flash.rotation.set(0, 0, 0);
        this.flash.rotateY(Math.PI);
        this.root.add(this.flash);
        this.flash.life = 0.0;

        this.shoot = false;
        this.shootTimer = 0.0;
        this.reloading = false;
    }

    Holster(){
        if(this.flash.parent === this.root){
            this.root.remove(this.flash);
        }
        this.mesh.visible = false;
        this.shoot = false;
    }

    RefreshUI(){
        this.uimanager && this.uimanager.SetAmmo(this.magAmmo, this.ammo);
    }

    // ---- Reload ----
    CanReload(){
        return !(this.reloading || this.magAmmo == this.ammoPerMag || this.ammo == 0);
    }

    BeginReload(){
        this.reloading = true;
    }

    ReloadDone(){
        // Idempotent: the FP-arms and TP-body reload clips both try to finish the
        // reload (whichever ends first wins); ignore the later, redundant call.
        if(!this.reloading){ return; }
        this.reloading = false;
        const bulletsNeeded = this.ammoPerMag - this.magAmmo;
        this.magAmmo = Math.min(this.ammo + this.magAmmo, this.ammoPerMag);
        this.ammo = Math.max(0, this.ammo - bulletsNeeded);
        this.RefreshUI();
    }

    AddAmmo(amount){
        this.ammo += amount;
    }

    // ---- Firing ----
    Raycast(){
        const start = new THREE.Vector3(0.0, 0.0, -1.0);
        start.unproject(this.camera);
        const end = new THREE.Vector3(0.0, 0.0, 1.0);
        end.unproject(this.camera);

        // Spread: nudge the far end off-axis within a cone (wide hipfire, tight ADS) so the bullet
        // deviates from dead-centre. Area-uniform disk sample (sqrt(rand)) at radius len*tan(spread).
        const spread = this.aiming ? this.aimSpread : this.hipSpread;
        if(spread > 1e-5){
            const dir = end.clone().sub(start);
            const len = dir.length();
            if(len > 1e-4){
                dir.multiplyScalar(1 / len);
                const ref = Math.abs(dir.y) < 0.95 ? this._worldUp : this._worldX;   // avoid a degenerate cross
                const u = new THREE.Vector3().crossVectors(dir, ref).normalize();
                const v = new THREE.Vector3().crossVectors(dir, u);                   // unit, completes the basis
                const radius = len * Math.tan(spread) * Math.sqrt(Math.random());
                const ang = Math.random() * Math.PI * 2;
                end.addScaledVector(u, radius * Math.cos(ang)).addScaledVector(v, radius * Math.sin(ang));
            }
        }

        const collisionMask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;

        if(AmmoHelper.CastRay(this.world, start, end, this.hitResult, collisionMask)){
            const ghostBody = Ammo.castObject( this.hitResult.collisionObject, Ammo.btPairCachingGhostObject );
            const rigidBody = Ammo.castObject( this.hitResult.collisionObject, Ammo.btRigidBody );
            const entity = ghostBody.parentEntity || rigidBody.parentEntity;

            entity && entity.Broadcast({'topic': 'hit', from: this.owner, amount: this.damage, hitResult: this.hitResult});
        }
    }

    // Returns true if a shot was fired this frame so the manager can react.
    Shoot(t){
        // Don't fire mid-reload. The mousedown handler blocks STARTING a shot while reloading, but a
        // trigger HELD from before the reload would otherwise keep firing through it — each round
        // broadcasts 'weapon.shoot', which hijacks the TPS body's upper layer from the reload one-shot
        // to the fire pose (the reload animation visibly cuts to recoil) while the mag silently refills.
        // Gating here keeps the reload one-shot intact and its 'reload.done' in sync. (Auto-reload is
        // unaffected — it keys off magAmmo===0 && !reloading separately in WeaponManager.)
        if(!this.shoot || !this.magAmmo || this.reloading){
            return false;
        }

        let fired = false;

        if(this.shootTimer <= 0.0 ){
            this.flash.life = this.fireRate;
            this.flash.rotateZ(Math.PI * Math.random());
            const scale = Math.random() * (1.5 - 0.8) + 0.8;
            this.flash.scale.set(scale, 1, 1);
            this.shootTimer = this.fireRate;
            this.magAmmo = Math.max(0, this.magAmmo - 1);
            this.RefreshUI();

            this.Raycast();

            this.shotSound.isPlaying && this.shotSound.stop();
            this.shotSound.play();
            fired = true;
        }

        this.shootTimer = Math.max(0.0, this.shootTimer - t);
        return fired;
    }

    AnimateMuzzle(t){
        const mat = this.flash.children[0].material;
        const ratio = this.flash.life / this.fireRate;
        mat.opacity = ratio;
        this.flash.life = Math.max(0.0, this.flash.life - t);
    }
}

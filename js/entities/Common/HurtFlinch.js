import * as THREE from 'three'


// Procedural ADDITIVE upper-body "hurt" pose — a reusable hit-react flinch for any of the rigs in
// this template (the UE Mannequin player/soldier AND the Mutant beast). It is NOT an animation clip:
// no hit-react clip ships with the assets, so the flinch is synthesised the same way PlayerBody's
// aim lean is — an additive rotation layered on top of whatever the mixer posed this frame, masked
// to the UPPER body only (the spine chain + neck + head), so the legs keep walking/strafing and the
// torso jolts. It composes cleanly with the aim lean, the weapon IK and the head aim (all additive),
// so a soldier flinches mid-strafe-fire and the player flinches without dropping aim.
//
// FEEL. Each hit injects an impulse into a lightly-damped spring (a quick jerk that overshoots once
// and settles in ~0.4 s), not a fixed pose — so repeated hits stack into a believable stagger and a
// single shot reads as a sharp twitch. The torso recoils (pitch) and twists to a random side (yaw),
// with the magnitude scaled by the hit's damage so a heavy blow rocks the body harder than a graze.
//
// RIG-AGNOSTIC. It finds the torso/head bones by NAME pattern (spine / neck / head), excluding arm,
// leg, finger, twist and face helper bones — so it needs no per-rig bone list and is a graceful
// no-op on a rig that has none. Bones are collected root->tip (traverse order) and given equal
// weights summing to ~1, so the bend distributes up the chain and totals ~the spring angle at the
// head (same accumulation trick as PlayerBody.UpdateAimPose).
const FLINCH_INCLUDE = /(spine|neck|head)/i;
const FLINCH_EXCLUDE = /(twist|_ik|ik_|corrective|_offset|tip|_end$|eye|jaw|ear|tongue|teeth|face)/i;

export default class HurtFlinch{
    // model : the character's THREE scene/skeleton root (bones are found by traversal)
    // opts  : { maxPitch, maxYaw, stiffness, damping, kickPitch, kickYaw }
    constructor(model, opts = {}){
        this.model = model;

        // Spring tuning. stiffness/damping give a snappy jerk that overshoots once then settles in
        // ~0.4 s (underdamped: damping < 2*sqrt(stiffness) = ~29). kick* are the per-hit velocity
        // impulses (rad/s) at full strength; max* clamp the rendered angle so a burst can't fold the
        // torso in half. Tunable per character via opts.
        this.stiffness = opts.stiffness ?? 210;          // spring constant (omega ~= 14.5 rad/s)
        this.damping   = opts.damping   ?? 17;           // < 2*sqrt(k): one small overshoot then rest
        this.kickPitch = opts.kickPitch ?? 3.4;          // rad/s recoil-back impulse at strength 1
        this.kickYaw   = opts.kickYaw   ?? 2.2;          // rad/s side-twist impulse at strength 1
        this.maxPitch  = opts.maxPitch ?? THREE.MathUtils.degToRad(22);
        this.maxYaw    = opts.maxYaw   ?? THREE.MathUtils.degToRad(16);
        this.sleepEps  = 1e-4;                           // below this combined amplitude the flinch is idle

        // Spring state (the additive flinch ANGLES, rad, and their velocities).
        this._pitch = 0; this._pitchVel = 0;             // recoil back/forward about the body's right axis
        this._yaw = 0;   this._yawVel = 0;               // twist to one side about world up

        // Resolve the masked upper-body bones (root->tip) once.
        this.bones = [];
        model.traverse(o => {
            if(!o.isBone){ return; }
            if(FLINCH_INCLUDE.test(o.name) && !FLINCH_EXCLUDE.test(o.name)){ this.bones.push(o); }
        });
        // Equal weights summing to ~1 so the additive bend distributes up the chain and totals ~the
        // spring angle at the head. A touch over 1 (1.1) so the recoil reads with a little authority.
        const n = this.bones.length || 1;
        this.weights = this.bones.map(() => 1.1 / n);

        // Scratch (no per-frame allocation).
        this._right = new THREE.Vector3();
        this._up = new THREE.Vector3(0, 1, 0);
        this._qPitch = new THREE.Quaternion();
        this._qYaw = new THREE.Quaternion();
        this._qWorld = new THREE.Quaternion();
        this._pW = new THREE.Quaternion();
        this._pWInv = new THREE.Quaternion();
        this._delta = new THREE.Quaternion();
    }

    // Trigger a flinch. strength scales the impulse (e.g. damage / referenceDamage, clamped). When a
    // `pushDir` (world-space horizontal direction the hit shoves the body — i.e. shooter -> victim) and
    // the victim's `facingYaw` are given, the flinch recoils AWAY from the shooter: the torso pitches in
    // the push direction (shot from the front => leans back; from behind => pitches forward) and twists
    // to the struck side, instead of the old always-back + random-twist. Omitting pushDir keeps the
    // legacy behaviour (used by the player). The kicks ADD to the current velocity so a fresh hit during
    // an in-progress flinch compounds into a harder stagger rather than resetting.
    Trigger(strength = 1, pushDir = null, facingYaw = 0){
        const s = THREE.MathUtils.clamp(strength, 0.35, 2.2);
        if(pushDir && (pushDir.x * pushDir.x + pushDir.z * pushDir.z) > 1e-6){
            // Decompose the push into the body's forward/right (same axis convention as Update). fwdComp
            // > 0 => pushed forward (shot from behind); rightComp > 0 => pushed to the body's right.
            const inv = 1 / Math.hypot(pushDir.x, pushDir.z);
            const dx = pushDir.x * inv, dz = pushDir.z * inv;
            const fwdComp = dx * Math.sin(facingYaw) + dz * Math.cos(facingYaw);
            const rightComp = dx * Math.cos(facingYaw) - dz * Math.sin(facingYaw);
            // Sign so the torso recoils ALONG the push (away from the shooter). If this ever reads
            // reversed on a given rig, flip the sign on this one line.
            this._pitchVel += this.kickPitch * s * Math.sign(fwdComp || -1);
            this._yawVel += this.kickYaw * s * Math.sign(rightComp || (Math.random() - 0.5));
        }else{
            // Legacy: recoil back + twist to a random side.
            this._pitchVel += this.kickPitch * s;
            this._yawVel += this.kickYaw * s * ((Math.random() * 2 - 1) >= 0 ? 1 : -1);
        }
    }

    get active(){
        return Math.abs(this._pitch) + Math.abs(this._yaw)
             + Math.abs(this._pitchVel) + Math.abs(this._yawVel) > this.sleepEps;
    }

    // Integrate the spring and apply the additive pose. Call AFTER the mixer (and after any other
    // additive spine pose) each frame, passing the character's facing yaw (so the recoil pitch is
    // about the body's true right axis). yaw = the model's world facing about +Y.
    Update(t, yaw = 0){
        if(!this.bones.length){ return; }

        // Semi-implicit Euler on the two damped springs (stable at the rates used here). Sub-step if
        // the frame is long so a low FPS spike can't overshoot the spring into instability.
        const steps = t > 1 / 50 ? 2 : 1;
        const h = t / steps;
        for(let i = 0; i < steps; i++){
            this._pitchVel += (-this.stiffness * this._pitch - this.damping * this._pitchVel) * h;
            this._pitch += this._pitchVel * h;
            this._yawVel += (-this.stiffness * this._yaw - this.damping * this._yawVel) * h;
            this._yaw += this._yawVel * h;
        }
        if(!this.active){ this._pitch = this._yaw = this._pitchVel = this._yawVel = 0; return; }

        const pitchA = THREE.MathUtils.clamp(this._pitch, -this.maxPitch, this.maxPitch);
        const yawA   = THREE.MathUtils.clamp(this._yaw,   -this.maxYaw,   this.maxYaw);

        // Character right axis in world (local +X carried through the yaw-only facing) — matches
        // PlayerBody.UpdateAimPose so pitch is a clean forward/back recoil regardless of bone axis.
        this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));

        for(let i = 0; i < this.bones.length; i++){
            const bone = this.bones[i];
            const w = this.weights[i];
            // World-space additive rotation for this bone's share: recoil pitch about the body's right
            // axis, twist about world up. Compose (yaw * pitch) then convert into the bone's local frame.
            this._qPitch.setFromAxisAngle(this._right, pitchA * w);
            this._qYaw.setFromAxisAngle(this._up, yawA * w);
            this._qWorld.copy(this._qYaw).multiply(this._qPitch);
            bone.parent.getWorldQuaternion(this._pW);     // reflects the mixer + any earlier edits up-chain
            this._pWInv.copy(this._pW).invert();
            // newLocal = parentW^-1 * delta * parentW * oldLocal
            this._delta.copy(this._pWInv).multiply(this._qWorld).multiply(this._pW);
            bone.quaternion.premultiply(this._delta);
        }
    }
}

import * as THREE from 'three'
import { IKChainSolver } from '../Common/IKUtils.js'
import { AmmoHelper, CollisionFilterGroups } from '../../AmmoLib.js'


// Weapon aim-alignment + two-hand IK solver (reusable; the player wires one of these in PlayerBody).
//
// WHAT IT FIXES. The visible gun is the AK socketed into hand_r (weaponPivot), posed only by the
// rifle clips + the additive spine lean (PlayerBody.UpdateAimPose). That lean APPROXIMATES pointing
// the gun at the look altitude, but it never accounts for the over-the-shoulder parallax between the
// TPS camera and the gun — so the barrel can read as pointing BESIDE the crosshair even though the
// bullet (a camera-centre ray) goes dead-centre. This solver makes the barrel point EXACTLY at the
// aim target (PlayerControls.aimTarget — the same point the shot ray hits), so the visual and the
// projectile agree, then IKs the support hand back onto the foregrip so both hands stay attached.
//
// HOW. Two layers, both eased in only while aiming/shooting and out otherwise (so idle/jog/locomotion
// are untouched when you're not aiming):
//   1) WEAPON ALIGNMENT — rotate weaponPivot about the WRIST (hand_r origin, the bone it hangs from)
//      so its muzzle-forward axis points from the muzzle at the aim target. Rotating about the wrist
//      keeps the dominant hand attached for free (the gun is the hand's child; the grip stays in the
//      palm and the gun pivots at the wrist, exactly how a shooter fine-aims). Clamped so an extreme
//      look can't wrench the gun, low-passed so it's smooth but responsive, and a refine pass nails
//      the convergence (the muzzle moves as it rotates about the wrist).
//   2) SUPPORT-HAND IK — once the gun has rotated, its foregrip has moved off where the animation put
//      the left hand, so a two-bone analytic IK (upperarm_l -> lowerarm_l -> hand_l) plants the left
//      hand back on the foregrip socket. The elbow keeps the animation's bend plane (no flip), so no
//      broken wrist / twisted elbow.
//
// STATELESS PER FRAME. The mixer rewrites every arm bone each frame BEFORE this runs, so the solver
// reads the freshly-animated pose, applies its deltas on top, and never accumulates — blending all
// the way out returns to the pure animation with no drift and no snap. The dominant hand needs no IK
// (the gun is its child); only the support arm is solved.
//
// SOCKETS are in weaponPivot-LOCAL space. The muzzle + barrel axis are derived from the gun's bbox
// (deterministic); the grip sockets are captured from where the rifle clips actually pose the hands
// on the gun (so engaging aim doesn't shift the hands). All are overridable per weapon via
// SetWeaponConfig for a real rigged weapon with authored sockets.
//
// NETWORKING. This template is single-player, so there's nothing to replicate here. If multiplayer
// is added later this layer stays purely COSMETIC and CLIENT-SIDE: each client already needs a
// remote player's look orientation / aim point to render them, and feeding that as `aimTarget` makes
// the remote avatar's barrel + hands resolve identically on every client with no extra state to sync
// (the solve is deterministic from the pose + aim target). Authoritative hit detection stays where it
// is — the camera-centre shot ray — independent of this visual alignment.
export default class WeaponAimIK{
    constructor(model, weaponPivot, opts = {}){
        this.model = model;
        this.weaponPivot = weaponPivot;
        this.handBoneR = weaponPivot ? weaponPivot.parent : null;   // hand_r — the wrist we pivot the gun about

        // ---- Designer-facing tuning (the names the feature request asks for) ----
        this.AimAlignmentBlendSpeed = opts.AimAlignmentBlendSpeed ?? 12;   // ease rate (1/s) blending the whole correction in/out
        this.WeaponIKBlendAlpha     = opts.WeaponIKBlendAlpha     ?? 1.0;  // max weight of the SUPPORT-HAND IK (0..1)
        this.AimCorrectionStrength  = opts.AimCorrectionStrength  ?? 1.0;  // 0..1 — how fully the barrel snaps onto the target
        this.MaxAimCorrectionAngle  = opts.MaxAimCorrectionAngle  ?? THREE.MathUtils.degToRad(55); // clamp on the barrel rotation
        this.AimSmoothingSpeed      = opts.AimSmoothingSpeed      ?? 20;   // low-pass rate (1/s) on the aim DIRECTION (responsive, not floaty)
        this.MuzzleForwardAxis      = opts.MuzzleForwardAxis ? opts.MuzzleForwardAxis.clone() : null; // local barrel axis (auto-detected if null)
        this.RightHandOffset        = opts.RightHandOffset ? opts.RightHandOffset.clone() : new THREE.Vector3(); // dominant grip socket nudge (pivot-local)
        this.LeftHandOffset         = opts.LeftHandOffset  ? opts.LeftHandOffset.clone()  : new THREE.Vector3(); // support grip socket nudge (pivot-local)
        this.twoHanded              = opts.twoHanded ?? true;              // false => one-handed (skip support-hand foregrip IK)
        // One-handed off-hand relax: for a single-handed weapon (twoHanded:false) the support hand has no
        // foregrip to grab, so instead of leaving it reaching for a phantom grip (the rifle clips pose it
        // there), ease the support arm toward HANGING DOWN. Rig-agnostic (blends the shoulder->elbow
        // direction toward world-down), weighted by the grip blend. 0 = leave on the animation.
        this.offHandRelax           = opts.offHandRelax ?? 0.6;
        this.minAimDistance         = opts.minAimDistance ?? 0.9;         // target closer than this to the muzzle => aim down camera-forward instead
        this.refineIterations       = opts.refineIterations ?? 1;         // muzzle-move refine passes for exact convergence

        // Support-hand WRIST LOCK. On by default: the support hand is glued to the gun in BOTH
        // translation (the two-bone IK plants it on the foregrip) AND orientation (the palm keeps the
        // exact hand-vs-gun rotation the animation had at rest, carried by the gun as it aims). This is
        // what kills the "the hand drifts off the gun / the contact offsets" glitch — without it the
        // wrist follows the forearm as animated and slides on the grip when the gun rotates to aim. The
        // rest relationship is CAPTURED from the posed hand (CaptureGripSockets), so it self-calibrates
        // to whatever grip the rifle clips author — no per-rig hand-tuned angle needed.
        this.lockSupportHand       = opts.lockSupportHand ?? true;
        this.leftGripQuatLocal     = new THREE.Quaternion();   // hand_l orientation in weaponPivot-local frame (rest)
        this._leftGripQuatCaptured = false;
        this.rightGripQuatLocal    = new THREE.Quaternion();   // hand_r orientation in weaponPivot-local frame (rest)
        this._rightGripQuatCaptured = false;
        // Legacy explicit-offset path (a real weapon can author a palm angle instead of the captured
        // rest). When matchHandToGrip is on it overrides the captured lock with weaponWorld*offset.
        this.matchHandToGrip       = opts.matchHandToGrip ?? false;
        this.LeftHandRotationOffset = opts.LeftHandRotationOffset ? opts.LeftHandRotationOffset.clone() : new THREE.Quaternion();

        // ---- Resolved rig + sockets ----
        this.bones = { upperarm_l: null, lowerarm_l: null, hand_l: null,
                       upperarm_r: null, lowerarm_r: null, hand_r: null };
        this.muzzleLocal = new THREE.Vector3();      // barrel tip, weaponPivot-local (muzzle flash / trace origin)
        this.aimSocketLocal = new THREE.Vector3();   // aim-alignment socket (the point the barrel ray emanates from) — defaults to the muzzle
        this.forwardLocal = new THREE.Vector3(0, 0, 1); // unit barrel-forward, weaponPivot-local
        this.rightGripLocal = new THREE.Vector3();   // dominant hand contact on the gun (debug / 1-handed)
        this.leftGripLocal = new THREE.Vector3();    // support hand contact (foregrip) — the IK target
        this._aimSocketOverridden = false;           // true once a weapon supplies its own aim socket
        this._barrelResolved = false;
        this._socketsCaptured = false;

        // ---- Base weapon placement (the static WEAPON_GRIP from buildUeMannequin). The TPS AK is not
        // animated, so its local transform is constant; we recompute the aim correction from this base
        // every frame so there's no drift. ----
        this._baseQuat = new THREE.Quaternion();
        this._basePos = new THREE.Vector3();
        this._baseCaptured = false;

        // ---- Eased state ----
        // TWO independent blends (the split that kills the idle<->aim<->shoot hand SNAP). Previously a
        // single `_alpha` gated BOTH the barrel alignment AND the support-hand grip together, eased in
        // only while aiming/shooting — so leaving aim RELEASED the support hand from the foregrip back
        // to the raw clip pose (the visible snap). Now:
        //   * _gripAlpha — eases toward 1 whenever a two-handed weapon is HELD (independent of aim).
        //     Drives the support-hand two-bone IK + wrist-lock, so the hands are ALWAYS glued to the
        //     gun and never release. At rest the captured socket == the animated hand, so it's a no-op
        //     until the gun actually moves (aim/lean/locomotion). The clip becomes elbow-pose influence.
        //   * _aimAlpha — eases in/out with aiming/shooting exactly as the old `_alpha` did. Drives ONLY
        //     the hand_r barrel rotation (the gun's aim DIRECTION). So engaging aim only swings the
        //     barrel; the hands stay put and the support arm re-solves onto the moved foregrip smoothly.
        this._gripAlpha = 0;                          // 0..1 support-hand grip blend (always-on for 2-handed)
        this._aimAlpha = 0;                           // 0..1 barrel-alignment blend (aim/shoot only)
        this.GripBlendSpeed = opts.GripBlendSpeed ?? 8; // grip ease rate (1/s) — a touch slower so the hand GLIDES onto the gun on spawn
        this._aimDir = new THREE.Vector3(0, 0, -1);  // low-passed world aim direction
        this._aimDirSeeded = false;

        // ---- Scratch (no per-frame allocation) ----
        this._P = new THREE.Vector3();               // wrist world position (rotation pivot)
        this._aimW = new THREE.Vector3();            // aim-socket world position (alignment ray origin)
        this._fwdW = new THREE.Vector3();
        this._desired = new THREE.Vector3();
        this._rawDesired = new THREE.Vector3();
        this._qA = new THREE.Quaternion();
        this._qB = new THREE.Quaternion();
        this._qFull = new THREE.Quaternion();
        this._qApplied = new THREE.Quaternion();
        this._qLocal = new THREE.Quaternion();
        this._handWQ = new THREE.Quaternion();
        this._handWQInv = new THREE.Quaternion();
        this._hq1 = new THREE.Quaternion();          // scratch: optional wrist-wrap target
        this._hq2 = new THREE.Quaternion();          // scratch: optional wrist-wrap blend
        this._weaponWQ = new THREE.Quaternion();
        this._tmpV = new THREE.Vector3();
        this._tmpV2 = new THREE.Vector3();
        this._leftTarget = new THREE.Vector3();
        this._ikE = new THREE.Vector3();
        // Off-hand relax scratch (one-handed weapons).
        this._offA = new THREE.Vector3(); this._offB = new THREE.Vector3();
        this._offCur = new THREE.Vector3(); this._offDes = new THREE.Vector3();
        this._offDown = new THREE.Vector3(0, -1, 0); this._offQ = new THREE.Quaternion();
        // Two-bone IK scratch.
        this._R = new THREE.Vector3(); this._M = new THREE.Vector3(); this._E = new THREE.Vector3();
        this._v1 = new THREE.Vector3();
        this._n = new THREE.Vector3(); this._u = new THREE.Vector3();
        this._Mp = new THREE.Vector3(); this._Ep = new THREE.Vector3();
        this._re = new THREE.Vector3(); this._rt = new THREE.Vector3(); this._rt2 = new THREE.Vector3();
        this._pW = new THREE.Quaternion(); this._pWInv = new THREE.Quaternion();
        this._qDelta = new THREE.Quaternion(); this._qWorld = new THREE.Quaternion();
        this._idQ = new THREE.Quaternion();          // permanent identity (slerp base) — never mutated
        this._scaleQ = new THREE.Quaternion();       // scratch for _scaleQuatAngle
        this._perp = new THREE.Vector3();            // scratch for the straight-arm bend-plane fallback
        // Elbow-pole stabilization (kills the support-arm flip on extreme cross-body aim): a stable
        // anatomical reference the support elbow should bend toward (down + a touch forward), and the
        // scratch it's resolved into.
        this._poleRef  = new THREE.Vector3();        // reference pole (world-down) projected into the bend plane
        this._poleDown = new THREE.Vector3(0, -1, 0);// the support elbow hangs DOWN — a fixed, gimbal-free ref
        // How strongly the support elbow is locked to the down reference (0 = pure animation/gimbal,
        // 1 = always straight down). High enough to kill the swivel/gimbal as the aim sweeps while still
        // reading natural for a rifle grip.
        this.supportElbowStabilize = 0.7;
        // Optional STRONGER support-elbow stabilize for the FPS dual-hand grip (set by the owner). The
        // shared 0.7 leaves ~30% of the animated bend in, so when the support hand reaches cross-body to
        // the foregrip the elbow only half-commits to the raised/left pole and can read as bending the
        // wrong way. A higher value here commits the FPS support elbow firmly onto its pole (down-and-
        // LEFT) so it bends correctly. null => fall back to supportElbowStabilize.
        this.supportElbowStabilizeDual = null;
        // Dominant (right) elbow stabilize for the FPS dual-hand grip — LOWER than the support arm so the
        // IK mostly PRESERVES the animated rifle-grip bend (the right hand only reaches ~the seat offset,
        // never an extreme cross-body target), biasing toward world-down just enough to avoid a flip.
        // Raise toward 1 if the right elbow swivels; lower toward 0 to follow the animation more.
        this.dominantElbowStabilize = 0.35;

        // --- Muzzle wall-clearance (stops the barrel poking THROUGH walls — the reported bug). After the
        // barrel is aimed, a small sphere is swept from the wrist to the muzzle tip against the STATIC
        // level; if it hits (the barrel would cross a wall) the gun is pitched UP about its horizontal
        // right axis so the muzzle lifts out of the wall — the shooter "ports" the weapon up against
        // cover. Eased in/out so it never pops; a pure no-op in the open (no hit => lift eases to 0). The
        // physics world is fed in per-frame by the owner (PlayerBody.UpdateWeaponAim). Runs whenever the
        // gun is held (gripActive), in TPS and FPS alike, so the barrel never clips regardless of aim.
        this.muzzleClearRadius = 0.05;      // wrist->muzzle sweep sphere radius (m)
        this.muzzleClearGain = 2.4;         // lift (rad) per unit blocked fraction of the wrist->muzzle span
        this.muzzleClearMax = THREE.MathUtils.degToRad(55);  // clamp on the lift
        this.muzzleClearLerp = 14;          // ease rate (1/s) for the lift in/out
        this._muzzleLift = 0;               // eased current lift (rad)
        this._clrFrom = new THREE.Vector3();
        this._clrTo = new THREE.Vector3();
        this._clrFwd = new THREE.Vector3();
        this._clrAxis = new THREE.Vector3();
        this._clrUp = new THREE.Vector3(0, 1, 0);
        this._clrQ = new THREE.Quaternion();
        this._clrRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };

        // --- FPS dual-hand grip. A first-person ADS seat floats the gun OFF the dominant wrist (so it
        // reads centred down the sights), which the wrist-rotation aim path below can't keep the right
        // hand on (that only works when the gun grips AT the wrist). When this is set (PlayerBody, FPS),
        // _updateDualHand instead IKs BOTH arms onto the gun's captured grips, so the gun stays at its
        // placed seat and both hands reach it. ---
        this.dualHandGrip = opts.dualHandGrip ?? false;
        // Optional per-frame world-space pole for the FPS support (left) elbow. When the dual-hand grip
        // hangs the support elbow straight DOWN (_poleDown) the cross-body reach onto the foregrip can
        // collapse the arm into the chest — a broken-looking pose while ADS. The owner (PlayerBody, FPS)
        // feeds a raised pole here (player-left + up, eased in while aiming) so the elbow lifts into a
        // natural rifle-support "chicken wing" instead of caving in. null => fall back to _poleDown.
        this._supportPoleOverride = null;
        this._dhGunMat = new THREE.Matrix4();   // the desired weapon world matrix (both hands grip THIS)
        this._dhGunRot = new THREE.Quaternion();
        this._dhLocalMat = new THREE.Matrix4();  // scratch: the placed gun pose re-expressed local to the IK'd wrist
        // Scratch for the FPS camera-authoritative solve (SolveFpsViewmodel) + the dual-hand re-pin: the gun's
        // decomposed world position/orientation/scale (scale is preserved across the camera-relative recompose).
        this._dhP = new THREE.Vector3(); this._dhQ = new THREE.Quaternion(); this._dhS = new THREE.Vector3();

        // Shared two-bone IK solver (analytic, sign-safe). Owns its own scratch pool so the support-arm
        // solve never clobbers the leg solves' intermediates. The two-bone scratch declared above is now
        // unused (the solver owns it) but left in place to keep this refactor behaviour-neutral; _pW/
        // _pWInv/_poleDown/_idQ/_scaleQ ARE still used directly below (wrist-lock, clamp, pole hint).
        this.ik = new IKChainSolver();

        // Debug snapshot for WeaponAimDebug (filled each frame; read-only for consumers).
        this._debug = {
            active: false, alpha: 0, gripAlpha: 0, valid: false, distance: 0,
            aimTarget: new THREE.Vector3(),
            muzzle: new THREE.Vector3(),
            barrelFwd: new THREE.Vector3(),     // where the barrel actually points after correction
            correctedDir: new THREE.Vector3(),  // muzzle -> aim target (desired)
            rightGrip: new THREE.Vector3(),
            leftGrip: new THREE.Vector3(),
            handTarget: new THREE.Vector3(),
        };

        if(this.weaponPivot){ this.ResolveBones(); }
    }

    // Find the arm chain + hands by UE bone name (confirmed present on SK_Mannequin: upperarm_l,
    // lowerarm_l, hand_l, hand_r). Missing bones leave the solver a graceful no-op for that part.
    ResolveBones(){
        const want = this.bones;
        this.model.traverse(o => {
            if(!o.isBone){ return; }
            if(o.name in want && !want[o.name]){ want[o.name] = o; }
        });
        // The wrist we pivot the gun about is the bone the weapon is parented to (hand_r).
        if(!this.handBoneR){ this.handBoneR = want.hand_r; }
    }

    // Muzzle + barrel-forward axis from the gun's bounding box, in weaponPivot-local space — the same
    // derivation WeaponManager.BuildMuzzleAnchor uses for the flash, so they agree. The barrel is the
    // gun's longest local axis; the muzzle is the end of it farther from the wrist; forward points
    // from the gun centre out the muzzle. Deterministic (geometry-relative), so it needs no posed
    // frame — resolved once, lazily, on the first Update.
    ResolveBarrel(){
        const pivot = this.weaponPivot;
        if(!pivot){ return; }
        pivot.updateWorldMatrix(true, true);
        const toLocal = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
        const box = new THREE.Box3();
        const corner = new THREE.Vector3();
        let any = false;
        pivot.traverse(o => {
            if(!o.isMesh || !o.geometry){ return; }
            o.geometry.computeBoundingBox();
            const bb = o.geometry.boundingBox;
            for(let i = 0; i < 8; i++){
                corner.set((i & 1) ? bb.max.x : bb.min.x, (i & 2) ? bb.max.y : bb.min.y, (i & 4) ? bb.max.z : bb.min.z);
                corner.applyMatrix4(o.matrixWorld).applyMatrix4(toLocal);
                box.expandByPoint(corner);
                any = true;
            }
        });
        if(!any){ this.forwardLocal.set(0, 0, 1); this._barrelResolved = true; return; }

        const size = box.getSize(this._tmpV);
        const center = box.getCenter(this._tmpV2);
        const axis = (size.x >= size.y && size.x >= size.z) ? 'x' : (size.y >= size.z ? 'y' : 'z');

        const endA = center.clone(); endA[axis] = box.max[axis];
        const endB = center.clone(); endB[axis] = box.min[axis];
        // Muzzle = the barrel end farther from the wrist (hand_r), measured in world space.
        const handPos = new THREE.Vector3();
        (this.handBoneR || pivot).getWorldPosition(handPos);
        const wa = endA.clone().applyMatrix4(pivot.matrixWorld);
        const wb = endB.clone().applyMatrix4(pivot.matrixWorld);
        const muzzle = wa.distanceToSquared(handPos) >= wb.distanceToSquared(handPos) ? endA : endB;
        this.muzzleLocal.copy(muzzle);
        // The aim-alignment socket defaults to the muzzle (a weapon can override it to e.g. a sight).
        if(!this._aimSocketOverridden){ this.aimSocketLocal.copy(muzzle); }
        // Forward = from gun centre toward the muzzle (unit), unless overridden per weapon.
        if(this.MuzzleForwardAxis){ this.forwardLocal.copy(this.MuzzleForwardAxis).normalize(); }
        else{ this.forwardLocal.copy(muzzle).sub(center).normalize(); }
        this._barrelResolved = true;
    }

    // Capture the static base placement of the weapon (the WEAPON_GRIP transform). Done once; the TPS
    // AK is never animated, so this is constant and is the clean base every aim correction starts from.
    CaptureBase(){
        if(!this.weaponPivot){ return; }
        this._baseQuat.copy(this.weaponPivot.quaternion);
        this._basePos.copy(this.weaponPivot.position);
        this._baseCaptured = true;
    }

    // Capture the grip sockets from where the rifle clips currently pose the hands ON the gun, so
    // engaging aim doesn't shift the hands (the IK target equals the animated hand position at rest).
    // Must run with the weapon at its base transform and a posed (idle) frame — called on first Update.
    CaptureGripSockets(){
        const pivot = this.weaponPivot;
        if(!pivot){ return; }
        pivot.updateWorldMatrix(true, false);
        if(this.bones.hand_l){
            this.bones.hand_l.getWorldPosition(this._tmpV);
            this.leftGripLocal.copy(pivot.worldToLocal(this._tmpV.clone()));
            // Capture hand_l's orientation RELATIVE to the gun at rest (pivot-local). The wrist lock
            // keeps exactly this hand-vs-gun rotation as the gun rotates to aim, so the palm stays
            // wrapped on the foregrip instead of sliding/twisting off it — self-calibrating, no offset.
            pivot.getWorldQuaternion(this._pW);
            this.bones.hand_l.getWorldQuaternion(this._hq2);
            this.leftGripQuatLocal.copy(this._pW).invert().multiply(this._hq2);
            this._leftGripQuatCaptured = true;
        }else{
            // No left hand bone: default the foregrip to ~35% up the barrel from centre.
            this.leftGripLocal.copy(this.muzzleLocal).multiplyScalar(0.55);
        }
        if(this.bones.hand_r){
            this.bones.hand_r.getWorldPosition(this._tmpV);
            this.rightGripLocal.copy(pivot.worldToLocal(this._tmpV.clone()));
            // hand_r's orientation RELATIVE to the gun at rest (pivot-local), mirroring the support hand.
            // The dual-hand FPS grip re-imposes this so the gun keeps its PLACED orientation while the
            // right arm IKs out to a seat that floats the gun off the wrist.
            pivot.getWorldQuaternion(this._pW);
            this.bones.hand_r.getWorldQuaternion(this._hq2);
            this.rightGripQuatLocal.copy(this._pW).invert().multiply(this._hq2);
            this._rightGripQuatCaptured = true;
        }
        this._socketsCaptured = true;
    }

    // Per-weapon override: authored sockets/offsets/forward-axis (pivot-local). Any field omitted keeps
    // the auto-resolved/captured value. Resets the low-pass so a switch mid-aim doesn't snap.
    SetWeaponConfig(cfg = {}){
        if(cfg.muzzle){ this.muzzleLocal.copy(cfg.muzzle); this._barrelResolved = true; }
        if(cfg.aimSocket){ this.aimSocketLocal.copy(cfg.aimSocket); this._aimSocketOverridden = true; }
        if(cfg.muzzleForwardAxis){ this.MuzzleForwardAxis = cfg.muzzleForwardAxis.clone(); this.forwardLocal.copy(cfg.muzzleForwardAxis).normalize(); }
        if(cfg.rightGrip){ this.rightGripLocal.copy(cfg.rightGrip); }
        if(cfg.leftGrip){ this.leftGripLocal.copy(cfg.leftGrip); this._socketsCaptured = true; }
        if(cfg.LeftHandOffset){ this.LeftHandOffset.copy(cfg.LeftHandOffset); }
        if(cfg.RightHandOffset){ this.RightHandOffset.copy(cfg.RightHandOffset); }
        if(cfg.LeftHandRotationOffset){ this.LeftHandRotationOffset.copy(cfg.LeftHandRotationOffset); }
        if(cfg.matchHandToGrip !== undefined){ this.matchHandToGrip = cfg.matchHandToGrip; }
        if(cfg.twoHanded !== undefined){ this.twoHanded = cfg.twoHanded; }
        if(cfg.offHandRelax !== undefined){ this.offHandRelax = cfg.offHandRelax; }
        if(cfg.AimCorrectionStrength !== undefined){ this.AimCorrectionStrength = cfg.AimCorrectionStrength; }
        if(cfg.MaxAimCorrectionAngle !== undefined){ this.MaxAimCorrectionAngle = cfg.MaxAimCorrectionAngle; }
        if(cfg.AimSmoothingSpeed !== undefined){ this.AimSmoothingSpeed = cfg.AimSmoothingSpeed; }
        if(cfg.AimAlignmentBlendSpeed !== undefined){ this.AimAlignmentBlendSpeed = cfg.AimAlignmentBlendSpeed; }
        this._aimDirSeeded = false;   // reseed the low-pass to avoid a visible swing on the swap
    }

    // Called by WeaponManager when the active weapon changes. Only the aim low-pass is reseeded so a
    // switch WHILE aiming glides. Sockets/barrel are NOT re-derived here: re-capturing the grip from the
    // posed hand mid-aim reads it at the IK-rotated position (a wrong socket) and snaps the support arm.
    // All weapons in this template share the in-hand mesh, so the init-captured sockets already fit; a
    // genuinely different rigged mesh supplies its own via ikConfig (SetWeaponConfig), applied on equip.
    OnWeaponChanged(){
        this._aimDirSeeded = false;
        // The FPS camera-authoritative viewmodel re-derives the gun pose from the camera every frame and the
        // barrel/sockets are geometry-relative (re-resolved on the next Update), so there is no stored aim
        // reference to invalidate here. PlayerBody re-derives its camera-relative seat offsets on a swap.
    }

    // Hard-reset the eased correction to fully OFF. Used when the body hands the whole pose off to a
    // dodge roll: Update is skipped for the roll's duration, so without this the master blend stays
    // FROZEN at its pre-roll value (~1 if you rolled while firing) and re-applies the full barrel/
    // support-hand correction in a single frame at roll recovery — a one-frame pop. Reset to 0 so it
    // eases back in from nothing (and reseed the aim low-pass so it doesn't swing in from a stale dir).
    Reset(){
        this._gripAlpha = 0;
        this._aimAlpha = 0;
        this._aimDirSeeded = false;
    }

    // Main solve. Call AFTER the mixer + spine lean each frame.
    //   active        : aim/shoot is engaged (drives the BARREL alignment; eases out otherwise)
    //   gripActive    : a weapon is held and the hands should be glued to it (drives the SUPPORT-hand
    //                   grip; on for a held weapon except during a reload). Defaults to `active` so a
    //                   caller that doesn't opt into the always-on grip behaves exactly as before.
    //   aimTarget     : world point under the crosshair (PlayerControls.aimTarget)
    //   aimValid      : the crosshair ray hit geometry (else aimTarget is a far fallback)
    //   cameraForward : unit camera-forward (fallback aim direction for too-close / behind targets)
    //   world         : the Ammo physics world (for the muzzle wall-clearance sweep; optional)
    //   t             : delta seconds
    Update(t, { active, gripActive = active, aimTarget, aimValid = true, cameraForward = null, world = null, dualHand = false, supportPole = null }){
        const pivot = this.weaponPivot;
        if(!pivot || !this.handBoneR){ return; }
        // Stash the optional support-elbow pole for _updateDualHand.
        this._supportPoleOverride = (supportPole && supportPole.lengthSq() > 1e-8) ? supportPole : null;

        // Ease the TWO blends independently (the split that kills the hand snap). Grip is always-on for
        // a held weapon (so the hands never release the gun); aim eases in/out with aiming/shooting.
        const targetGrip = gripActive ? 1 : 0;
        const targetAim  = active ? 1 : 0;
        this._gripAlpha += (targetGrip - this._gripAlpha) * (1 - Math.exp(-this.GripBlendSpeed * t));
        this._aimAlpha  += (targetAim  - this._aimAlpha)  * (1 - Math.exp(-this.AimAlignmentBlendSpeed * t));
        // Keep the aim direction unseeded while aim is released, so re-aiming seeds straight to the live
        // target with no swing-in (the grip path may still run below, but the barrel apply is ~identity).
        if(this._aimAlpha < 1e-3){ this._aimDirSeeded = false; }

        // One-time lazy resolves on the FIRST update. The grip-socket capture reads where the rifle clip
        // poses hand_l ON the gun, so the FIRST update MUST land on a CLIP-posed frame, not the bind/
        // T-pose — else the always-on support IK plants the hand at the bind-pose socket (the "support
        // arm flung in the air" NPC bug). The owner guarantees this by playing an idle rifle action in its
        // Initialize BEFORE the first Update (PlayerBody + UeSoldierController both do), so frame 1 is
        // posed with the hand on the gun. NOT re-run on a weapon switch (OnWeaponChanged).
        if(!this._baseCaptured){ this.CaptureBase(); }
        if(!this._barrelResolved){ this.ResolveBarrel(); }
        if(!this._socketsCaptured){ this.CaptureGripSockets(); }

        // Both blends fully released: leave the weapon + arm entirely to the animation (so idle reads
        // exactly as authored). The mixer rewrites the arm each frame, so nothing lingers. With the
        // always-on grip this is rare while a two-handed weapon is held (grip stays engaged) — it mainly
        // fires during a reload (grip eased out so the hands work the mag) or with no weapon.
        if(this._gripAlpha < 1e-3 && this._aimAlpha < 1e-3){
            this._debug.active = false;
            this._debug.alpha = 0;
            this._aimDirSeeded = false;
            return;
        }

        // Refresh world matrices for clean reads (the spine lean just edited the chain).
        this.model.updateMatrixWorld(true);

        // FPS dual-hand grip: the gun is seated OFF the wrist, so IK both arms onto it (the wrist-
        // rotation aim path below only holds the dominant hand when the gun grips AT the wrist).
        if(dualHand){
            this._updateDualHand();
            return;
        }

        // --- Reset the weapon to its static base, then compute the barrel correction from it. ---
        pivot.quaternion.copy(this._baseQuat);
        pivot.position.copy(this._basePos);
        pivot.updateWorldMatrix(false, false);

        this.handBoneR.getWorldPosition(this._P);                 // wrist = rotation pivot
        pivot.getWorldQuaternion(this._weaponWQ);
        this._aimW.copy(this.aimSocketLocal).applyMatrix4(pivot.matrixWorld);   // base aim socket (world)
        this._fwdW.copy(this.forwardLocal).applyQuaternion(this._weaponWQ).normalize();   // base forward (world)

        // Desired aim direction = aim socket -> aim target, low-passed. Fall back to camera-forward
        // when the target is too close to the socket or behind it (a wall hugged point-blank), so the
        // barrel never whips to point at something inside the gun.
        this._rawDesired.copy(aimTarget).sub(this._aimW);
        const dist = this._rawDesired.length();
        const behind = cameraForward && this._rawDesired.dot(cameraForward) < 0;
        if(dist < this.minAimDistance || behind || dist < 1e-4){
            if(cameraForward){ this._rawDesired.copy(cameraForward); }
            else{ this._rawDesired.copy(this._fwdW); }
        }
        this._rawDesired.normalize();
        // Low-pass the direction (smooth but responsive). Seed on first use so it doesn't swing in.
        if(!this._aimDirSeeded){ this._aimDir.copy(this._rawDesired); this._aimDirSeeded = true; }
        else{ this._aimDir.lerp(this._rawDesired, 1 - Math.exp(-this.AimSmoothingSpeed * t)).normalize(); }
        this._desired.copy(this._aimDir);

        // --- Barrel alignment quaternion (with a refine pass: the muzzle moves as it rotates about
        // the wrist, so realign once for exact convergence). ---
        this._qA.setFromUnitVectors(this._fwdW, this._desired);
        this._qFull.copy(this._qA);
        // Refine: simulate applying qA about the wrist, recompute muzzle/forward, realign.
        for(let i = 0; i < this.refineIterations; i++){
            this._fwdW.applyQuaternion(this._qA).normalize();                 // forward after qA
            this._tmpV.copy(this._aimW).sub(this._P).applyQuaternion(this._qA).add(this._P); // aim socket after qA
            this._aimW.copy(this._tmpV);
            this._rawDesired.copy(aimTarget).sub(this._aimW);
            if(this._rawDesired.length() < 1e-4){ break; }
            this._rawDesired.normalize();
            this._qB.setFromUnitVectors(this._fwdW, this._rawDesired);
            this._qFull.premultiply(this._qB);                               // compose total
            this._qA.copy(this._qB);
        }

        // Clamp the total correction angle, scale by strength, then ease by the AIM blend (so the barrel
        // only swings while aiming/shooting — at rest _aimAlpha≈0 and this is ~identity, leaving the gun
        // at its base while the support hand still grips it via _gripAlpha below).
        this._clampQuatAngle(this._qFull, this.MaxAimCorrectionAngle);
        if(this.AimCorrectionStrength < 0.999){ this._scaleQuatAngle(this._qFull, this.AimCorrectionStrength); }
        this._qApplied.copy(this._idQ).slerp(this._qFull, this._aimAlpha);

        // Apply the aim correction to the WRIST BONE (hand_r) about its origin, NOT to the gun pivot.
        // The gun is a child of hand_r, so rotating the wrist lands the barrel in the SAME world pose a
        // pivot rotation would (the rotation is about the same point — the wrist — so muzzle position &
        // direction, and hence convergence, are identical). The difference is that the dominant hand's
        // FINGER bones are also children of hand_r, so they now rotate WITH the gun — the grip stays
        // glued in the palm. The old pivot-only rotation left the fingers at the animated (un-aimed)
        // pose while the gun swung, so the gun slid out from under them: the "hand slides a bit on the
        // gun when aiming" glitch, worst at up/down aim where the correction angle is largest. The
        // pivot stays at its captured base (reset above); the wrist articulates by the (clamped)
        // correction — exactly how a shooter cocks the wrist to fine-aim. The support hand is still
        // re-planted on the foregrip by the IK below, so BOTH hands stay attached.
        this._applyWorldQuat(this.handBoneR, this._qApplied);
        this.handBoneR.updateWorldMatrix(false, true);   // refresh the gun (child) world for the IK + debug reads

        // Muzzle wall-clearance: lift the gun out of any wall the barrel would cross, BEFORE the support
        // hand re-plants on the (now-lifted) foregrip so both hands follow the ported weapon. No-op in the open.
        this._applyMuzzleClearance(world, gripActive, t);

        // --- Support-hand IK: plant hand_l on the (now-rotated) foregrip socket. Weighted by the GRIP
        // blend (always-on for a held two-handed weapon), NOT the aim blend — so the support hand stays
        // glued to the gun at idle and through aim/shoot transitions (no release/re-grab snap). ---
        const ikW = this._gripAlpha * this.WeaponIKBlendAlpha;
        this._tmpV.copy(this.leftGripLocal).add(this.LeftHandOffset);
        this._leftTarget.copy(this._tmpV).applyMatrix4(pivot.matrixWorld);   // foregrip world (post-rotation)
        if(this.twoHanded && this._socketsCaptured && this.bones.upperarm_l && this.bones.lowerarm_l && this.bones.hand_l){
            this.bones.hand_l.getWorldPosition(this._ikE);
            // Blend the effector target from the animated hand to the foregrip by the IK weight, so the
            // support hand eases on/off with the aim and never snaps.
            this._tmpV2.copy(this._ikE).lerp(this._leftTarget, ikW);
            // Support-arm elbow: lock the bend plane to a FIXED world-down reference (not the animated
            // pole, and NOT an aim-relative hint — an aim-direction component made the elbow swivel/gimbal
            // as the crosshair swept). supportElbowStabilize biases the elbow to hang consistently below
            // the shoulder->hand line, killing the gimbal while the flip-guard in the solver still stops
            // an outright reverse bend on extreme cross-body aim.
            this._solveTwoBone(this.bones.upperarm_l, this.bones.lowerarm_l, this.bones.hand_l, this._tmpV2,
                this._poleDown, this.supportElbowStabilize);

            // Wrist LOCK: orient hand_l to the gun so the palm stays glued to the foregrip as the gun
            // aims (translation is already planted by the IK above). The desired world orientation is
            // the gun's world quat times the captured rest hand-vs-gun rotation (lockSupportHand, on by
            // default — self-calibrating), or an authored offset (matchHandToGrip). Blended by the IK
            // weight so it eases in/out with the aim and never snaps.
            if((this.lockSupportHand && this._leftGripQuatCaptured) || this.matchHandToGrip){
                const hand = this.bones.hand_l;
                pivot.getWorldQuaternion(this._weaponWQ);
                if(this.matchHandToGrip){ this._hq1.copy(this._weaponWQ).multiply(this.LeftHandRotationOffset); }
                else{ this._hq1.copy(this._weaponWQ).multiply(this.leftGripQuatLocal); }
                hand.getWorldQuaternion(this._hq2).slerp(this._hq1, ikW);               // blend from animated
                hand.parent.getWorldQuaternion(this._pW);
                hand.quaternion.copy(this._pWInv.copy(this._pW).invert()).multiply(this._hq2);
            }
        }else if(!this.twoHanded && this.offHandRelax > 0 && this.bones.upperarm_l && this.bones.lowerarm_l){
            // ONE-HANDED weapon: no foregrip to grab — relax the support arm toward hanging down instead
            // of leaving it reaching for a phantom grip. Eased by the grip blend (ikW).
            this._applyOffHandRest(ikW);
        }

        // --- Debug snapshot ---
        const d = this._debug;
        d.active = true; d.alpha = this._aimAlpha; d.gripAlpha = this._gripAlpha; d.valid = aimValid; d.distance = dist;
        d.aimTarget.copy(aimTarget);
        d.muzzle.copy(this.muzzleLocal).applyMatrix4(pivot.matrixWorld);
        d.barrelFwd.copy(this.forwardLocal).applyQuaternion(pivot.getWorldQuaternion(this._weaponWQ)).normalize();
        d.correctedDir.copy(aimTarget).sub(d.muzzle).normalize();
        d.rightGrip.copy(this.rightGripLocal).add(this.RightHandOffset).applyMatrix4(pivot.matrixWorld);
        d.leftGrip.copy(this._leftTarget);
        d.handTarget.copy(this._leftTarget);
    }

    // FPS DUAL-HAND GRIP (non-camera consumer). Both arms IK onto the gun at its placed seat: the gun is
    // left where the clip seats it (relative to the animated hand) and the dominant + support arms reach
    // for its captured grip sockets, so both hands land on it. The first-person PLAYER no longer uses this —
    // its gun is camera-authoritative (SolveFpsViewmodel below) — but it stays for any dual-hand consumer
    // that just wants the hands glued to the seated gun.
    _updateDualHand(){
        const pivot = this.weaponPivot;
        // Reset the gun to its placed seat and refresh hand_r (from its animated ancestors) + the gun.
        pivot.quaternion.copy(this._baseQuat);
        pivot.position.copy(this._basePos);
        this.handBoneR.updateWorldMatrix(true, true);
        this._dhGunMat.copy(pivot.matrixWorld);   // both hands grip THIS
        pivot.getWorldQuaternion(this._dhGunRot);
        this._solveDualHandGrip();
    }

    // FPS CAMERA-AUTHORITATIVE VIEWMODEL (first-person player only). The crosshair/camera is the SOURCE OF
    // TRUTH: the gun's world pose is computed analytically from the camera every frame — its pivot placed at
    // a camera-relative offset (PlayerBody: eye + camQuat·offset, blended hip<->ADS + procedural) and the
    // barrel ROTATED so forwardLocal points exactly at the aim target — then both hands IK onto it. NO
    // stored/animated pose feeds the result, so it is correct on frame 1 of ANY locomotion state
    // (run/jump/crouch/strafe/land/enter-exit-aim): there is nothing to "drift" or "eventually correct".
    // Must run as the LAST pose write (after FootIK + the final eye placement) so the body can move
    // underneath while the gun stays on the reticle. PlayerBody.UpdateFpsViewmodel computes the inputs.
    //   gunPosWorld  : desired gun-pivot world position (eye + camQuat·offset + procedural)
    //   baseGunQuat  : desired gun-pivot world orientation BEFORE the barrel swing (camQuat·camLocalRest)
    //   aimTarget    : world point under the crosshair (pc.aimTarget)
    //   cameraForward: unit camera-forward (fallback for a too-close / behind-the-muzzle target)
    //   recoilQuat   : optional world-space additive kick applied AFTER alignment (decaying), or null
    //   raiseW       : 1 = raised & crosshair-aligned (aim/shoot); 0 = relaxed (gun follows the idle anim)
    SolveFpsViewmodel(t, { gunPosWorld, baseGunQuat, aimTarget, aimValid = true, cameraForward = null, recoilQuat = null, raiseW = 1 }){
        const pivot = this.weaponPivot;
        if(!pivot || !this.handBoneR || !gunPosWorld || !baseGunQuat){ return; }
        // Always-on grip blend (hands glued to the held gun). _aimAlpha tracks 1 for the FPS viewmodel (the
        // gun is always aim-driven here); kept eased only for the debug overlay's alpha readout.
        this._gripAlpha += (1 - this._gripAlpha) * (1 - Math.exp(-this.GripBlendSpeed * t));
        this._aimAlpha  += (1 - this._aimAlpha)  * (1 - Math.exp(-this.AimAlignmentBlendSpeed * t));
        // Lazy one-time resolves (need a posed frame — guaranteed, this runs after the mixer).
        if(!this._baseCaptured){ this.CaptureBase(); }
        if(!this._barrelResolved){ this.ResolveBarrel(); }
        if(!this._socketsCaptured){ this.CaptureGripSockets(); }
        this.model.updateMatrixWorld(true);

        // Keep the gun's own world SCALE (the skeleton is ~0.01-scaled); position+orientation come from the
        // camera. _dhS holds the scale, reused in every compose below.
        pivot.matrixWorld.decompose(this._dhP, this._dhQ, this._dhS);

        // Base gun pose: camera-relative position + the camera-relative rest orientation (PlayerBody blends
        // hip<->ADS). The barrel is then swung onto the exact aim target.
        this._dhGunRot.copy(baseGunQuat);
        this._dhGunMat.compose(gunPosWorld, this._dhGunRot, this._dhS);

        // --- Barrel alignment (authoritative). Rotate the gun about its pivot origin so forwardLocal points
        // at the aim target. The aim socket moves as the gun rotates, so REFINE: realign from the recomputed
        // socket so the muzzle ray converges exactly on the reticle (mirrors the TPS refine). The direction
        // is low-passed on the FIRST pass only (a jittery crosshair raycast must not buzz the barrel); the
        // refine passes use the raw recomputed direction. Falls back to camera-forward for a too-close /
        // behind-the-muzzle target. ORIENTATION is never otherwise smoothed — the barrel is on target each frame.
        for(let i = 0; i <= this.refineIterations; i++){
            this._aimW.copy(this.aimSocketLocal).applyMatrix4(this._dhGunMat);     // aim socket (world)
            this._rawDesired.copy(aimTarget).sub(this._aimW);
            const dist = this._rawDesired.length();
            const behind = cameraForward && this._rawDesired.dot(cameraForward) < 0;
            if(dist < this.minAimDistance || behind || dist < 1e-4){
                if(cameraForward){ this._rawDesired.copy(cameraForward); }
                else { break; }
            }
            this._rawDesired.normalize();
            if(i === 0){
                if(!this._aimDirSeeded){ this._aimDir.copy(this._rawDesired); this._aimDirSeeded = true; }
                else { this._aimDir.lerp(this._rawDesired, 1 - Math.exp(-this.AimSmoothingSpeed * t)).normalize(); }
                this._desired.copy(this._aimDir);
            }else{
                this._desired.copy(this._rawDesired);
            }
            this._fwdW.copy(this.forwardLocal).applyQuaternion(this._dhGunRot).normalize();   // gun forward (world)
            this._qA.setFromUnitVectors(this._fwdW, this._desired);
            this._dhGunRot.premultiply(this._qA);
            this._dhGunMat.compose(gunPosWorld, this._dhGunRot, this._dhS);
        }

        // Recoil: a decaying additive kick applied AFTER alignment, so the muzzle climbs off the reticle on
        // a shot and returns — organic, on top of an otherwise on-target base (PlayerBody owns the decay).
        if(recoilQuat){
            this._dhGunRot.premultiply(recoilQuat);
            this._dhGunMat.compose(gunPosWorld, this._dhGunRot, this._dhS);
        }

        // RELAX/RAISE blend: ease the whole gun pose between the RAISED camera-authoritative pose (raiseW=1,
        // barrel on the reticle) and the RELAXED animated SEAT pose (raiseW=0 — the gun rides the idle clip
        // at WEAPON_GRIP_FPS: lowered/sideways). _dhP/_dhQ still hold the animated seat pose decomposed at the
        // top (untouched by the align/recoil above). The dual-hand IK then grips whatever blends out, so at
        // idle the arms read as the idle animation, and aiming/shooting lifts the gun onto the crosshair.
        if(raiseW < 0.999){
            this._tmpV2.copy(gunPosWorld).lerp(this._dhP, 1 - raiseW);
            this._dhGunRot.slerp(this._dhQ, 1 - raiseW);
            this._dhGunMat.compose(this._tmpV2, this._dhGunRot, this._dhS);
        }

        // Hand the debug overlay the aim target/validity/range; _solveDualHandGrip fills the live barrel
        // geometry + convergence direction off the re-pinned gun.
        this._debug.aimTarget.copy(aimTarget);
        this._debug.valid = aimValid;
        this._debug.distance = this._tmpV.copy(aimTarget).sub(this._aimW).length();

        // Both hands IK onto the placed gun (shared with _updateDualHand).
        this._solveDualHandGrip();
    }

    // Plant BOTH hands on the gun whose desired world pose is in _dhGunMat / _dhGunRot: two-bone IK each arm
    // onto its captured grip socket + wrist-lock, then re-pin the gun local to the IK'd dominant wrist so it
    // sits EXACTLY at the desired pose while the hands grip it. Shared by _updateDualHand + SolveFpsViewmodel.
    _solveDualHandGrip(){
        const pivot = this.weaponPivot;
        const ikW = this._gripAlpha * this.WeaponIKBlendAlpha;

        // DOMINANT (right) hand -> the gun's right grip. Two-bone IK reaches the grip; the wrist lock
        // re-imposes the captured hand-vs-gun rotation so the bent forearm doesn't tip the placed gun.
        if(this._socketsCaptured && this.bones.upperarm_r && this.bones.lowerarm_r && this.bones.hand_r){
            this._tmpV.copy(this.rightGripLocal).add(this.RightHandOffset).applyMatrix4(this._dhGunMat);
            this.bones.hand_r.getWorldPosition(this._ikE);
            this._tmpV2.copy(this._ikE).lerp(this._tmpV, ikW);            // ease from the animated hand onto the grip
            this._solveTwoBone(this.bones.upperarm_r, this.bones.lowerarm_r, this.bones.hand_r,
                this._tmpV2, this._poleDown, this.dominantElbowStabilize);
            if(this._rightGripQuatCaptured){
                const hand = this.bones.hand_r;
                this._hq1.copy(this._dhGunRot).multiply(this.rightGripQuatLocal);   // desired hand_r world rot
                hand.getWorldQuaternion(this._hq2).slerp(this._hq1, ikW);
                hand.parent.getWorldQuaternion(this._pW);
                hand.quaternion.copy(this._pWInv.copy(this._pW).invert()).multiply(this._hq2);
            }
            // The gun rides hand_r, so the IK just shoved it off the placement by the seat offset. PIN it
            // back: re-express the captured placement (_dhGunMat) LOCAL to the now-IK'd wrist and write
            // that onto the pivot, so the gun sits EXACTLY where you placed it while the hand grips it.
            this.handBoneR.updateWorldMatrix(true, false);
            this._dhLocalMat.copy(this.handBoneR.matrixWorld).invert().multiply(this._dhGunMat);
            this._dhLocalMat.decompose(pivot.position, pivot.quaternion, this._tmpV2);   // _tmpV2 = throwaway scale
            pivot.updateWorldMatrix(false, false);
        }

        // SUPPORT (left) hand -> the foregrip on the (now placed) gun — same solve as the TPS path.
        if(this.twoHanded && this._socketsCaptured && this.bones.upperarm_l && this.bones.lowerarm_l && this.bones.hand_l){
            this._leftTarget.copy(this.leftGripLocal).add(this.LeftHandOffset).applyMatrix4(pivot.matrixWorld);
            this.bones.hand_l.getWorldPosition(this._ikE);
            this._tmpV2.copy(this._ikE).lerp(this._leftTarget, ikW);
            // Raised support-elbow pole (owner-supplied, eased) so the left elbow lifts up/out while
            // aiming instead of caving the arm into the chest; falls back to straight-down at rest. A
            // stronger dual-hand stabilize (if set) commits the elbow firmly onto that pole.
            const supportPole = this._supportPoleOverride || this._poleDown;
            const supportStab = this.supportElbowStabilizeDual != null
                ? this.supportElbowStabilizeDual : this.supportElbowStabilize;
            this._solveTwoBone(this.bones.upperarm_l, this.bones.lowerarm_l, this.bones.hand_l,
                this._tmpV2, supportPole, supportStab);
            if((this.lockSupportHand && this._leftGripQuatCaptured) || this.matchHandToGrip){
                const hand = this.bones.hand_l;
                pivot.getWorldQuaternion(this._weaponWQ);
                if(this.matchHandToGrip){ this._hq1.copy(this._weaponWQ).multiply(this.LeftHandRotationOffset); }
                else{ this._hq1.copy(this._weaponWQ).multiply(this.leftGripQuatLocal); }
                hand.getWorldQuaternion(this._hq2).slerp(this._hq1, ikW);
                hand.parent.getWorldQuaternion(this._pW);
                hand.quaternion.copy(this._pWInv.copy(this._pW).invert()).multiply(this._hq2);
            }
        }

        // Debug snapshot: barrel/grip read off the live, re-pinned gun. aimTarget/valid/distance are set by
        // the caller (SolveFpsViewmodel) before this runs; correctedDir = muzzle->target lets the overlay
        // compare the real barrel direction against the line to the reticle (the convergence readout).
        const d = this._debug;
        d.active = true; d.alpha = this._aimAlpha; d.gripAlpha = this._gripAlpha;
        d.muzzle.copy(this.muzzleLocal).applyMatrix4(pivot.matrixWorld);
        d.barrelFwd.copy(this.forwardLocal).applyQuaternion(pivot.getWorldQuaternion(this._weaponWQ)).normalize();
        d.correctedDir.copy(d.aimTarget).sub(d.muzzle);
        if(d.correctedDir.lengthSq() > 1e-8){ d.correctedDir.normalize(); }
        d.rightGrip.copy(this.rightGripLocal).add(this.RightHandOffset).applyMatrix4(pivot.matrixWorld);
        d.leftGrip.copy(this._leftTarget);
        d.handTarget.copy(this._leftTarget);
    }

    // Muzzle wall-clearance. Sweep a small sphere from the wrist (the gun's rotation pivot) to the muzzle
    // tip against the STATIC level; if the barrel would cross a wall, pitch the gun UP about its
    // horizontal-right axis so the muzzle lifts out of the wall (a natural "weapon up against cover"
    // port). The lift is eased so it never pops, and is a pure no-op in the open (no hit => eases to 0).
    // Applied to the WRIST bone (hand_r) about its origin, like the aim correction, so the gun + dominant
    // hand stay together; the support hand re-plants on the lifted foregrip in the IK that follows.
    _applyMuzzleClearance(world, gripActive, t){
        const pivot = this.weaponPivot;
        let target = 0;
        if(world && gripActive && pivot && this.handBoneR){
            pivot.updateWorldMatrix(false, false);
            this._clrTo.copy(this.muzzleLocal).applyMatrix4(pivot.matrixWorld);   // muzzle tip (world)
            this._clrFrom.copy(this._P);                                          // wrist (world) — sweep start
            if(AmmoHelper.SphereSweep(world, this.muzzleClearRadius, this._clrFrom, this._clrTo,
                this._clrRes, CollisionFilterGroups.StaticFilter) && this._clrRes.fraction < 1){
                // Blocked: lift in proportion to how early the barrel hits the wall (deeper => bigger lift).
                target = THREE.MathUtils.clamp(
                    this.muzzleClearGain * (1 - this._clrRes.fraction), 0, this.muzzleClearMax);
            }
        }
        this._muzzleLift += (target - this._muzzleLift) * (1 - Math.exp(-this.muzzleClearLerp * t));
        if(this._muzzleLift < 1e-3){ return; }
        // Lift axis = barrelForward × worldUp (rotating the forward about it by +angle tilts it toward up,
        // raising the muzzle). Degenerate only when the barrel is near-vertical — then skip (no clean "up").
        pivot.getWorldQuaternion(this._weaponWQ);
        this._clrFwd.copy(this.forwardLocal).applyQuaternion(this._weaponWQ).normalize();
        this._clrAxis.copy(this._clrFwd).cross(this._clrUp);
        if(this._clrAxis.lengthSq() < 1e-6){ return; }
        this._clrAxis.normalize();
        this._clrQ.setFromAxisAngle(this._clrAxis, this._muzzleLift);
        this._applyWorldQuat(this.handBoneR, this._clrQ);
        this.handBoneR.updateWorldMatrix(false, true);   // refresh the lifted gun for the support-hand IK
    }

    // One-handed off-hand relax: rotate the support upper arm so its shoulder->elbow direction eases
    // toward world-DOWN by offHandRelax*w, so the off-hand hangs naturally rather than reaching for a
    // foregrip that a one-handed weapon doesn't have. Rig-agnostic (works in world directions); the
    // forearm/hand follow as children. Applied about the shoulder so the arm just lowers.
    _applyOffHandRest(w){
        const up = this.bones.upperarm_l, lo = this.bones.lowerarm_l;
        up.getWorldPosition(this._offA);
        lo.getWorldPosition(this._offB);
        this._offCur.copy(this._offB).sub(this._offA);
        if(this._offCur.lengthSq() < 1e-8){ return; }
        this._offCur.normalize();
        this._offDes.copy(this._offCur).lerp(this._offDown, this.offHandRelax * w);
        if(this._offDes.lengthSq() < 1e-8){ return; }
        this._offDes.normalize();
        this._offQ.setFromUnitVectors(this._offCur, this._offDes);
        this._applyWorldQuat(up, this._offQ);
    }

    // Analytic two-bone IK — now delegated to the shared IKChainSolver (see IKUtils.js). The maths are
    // identical to the version this class used to own; extracting it lets FootIK reuse the exact same
    // sign-safe, pole-stabilized solver. Kept as a thin wrapper so the callsites below are unchanged.
    _solveTwoBone(root, mid, end, targetWorld, poleHint = null, poleStabilize = 0){
        this.ik.solveTwoBone(root, mid, end, targetWorld, poleHint, poleStabilize);
    }

    // Apply a world-space rotation qW to a bone about its origin (delegated to the shared solver):
    // newLocal = parentW^-1 * qW * parentW * oldLocal.
    _applyWorldQuat(bone, qW){
        this.ik.applyWorldQuat(bone, qW);
    }

    // Clamp a quaternion's rotation angle to maxAngle (radians), in place.
    _clampQuatAngle(q, maxAngle){
        q.normalize();
        if(q.w < 0){ q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }   // canonical: measure the SHORT arc
        const half = Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));        // half-angle
        const angle = 2 * half;
        if(angle <= maxAngle || angle < 1e-6){ return; }
        const s = Math.sin(maxAngle * 0.5) / Math.max(1e-6, Math.sin(half));
        q.x *= s; q.y *= s; q.z *= s; q.w = Math.cos(maxAngle * 0.5);
        q.normalize();
    }

    // Scale a quaternion's rotation angle by k (0..1), in place (slerp from identity).
    _scaleQuatAngle(q, k){
        this._scaleQ.copy(this._idQ).slerp(q, k);
        q.copy(this._scaleQ);
    }
}

import * as THREE from 'three'
import { IKChainSolver } from '../Common/IKUtils.js'
import { AmmoHelper, CollisionFilterGroups } from '../../AmmoLib.js'


// Procedural FOOT / LEG IK — terrain adaptation on top of the locomotion clip. Reusable: the player
// (PlayerBody) and the enemy soldier (UeSoldierController) each own one (both are the SAME UE rig).
// The clip stays the base influence; this layer raycasts the ground under each foot and, eased, (a)
// lowers the whole avatar (modelRoot, world metres) so the lower-ground foot can reach, (b) two-bone
// solves each leg (thigh→calf→foot) so the ankle plants on the ground, and (c) tilts the foot to the
// surface normal. On flat ground it's a near no-op.
//
// WHY modelRoot (not the pelvis bone) for the hip drop: modelRoot is a top-level scene Group, so its
// position is WORLD metres — unambiguous, no rig unit-scale to reverse-engineer — and it is NOT touched
// by PlayerBody.StabilizeHips (which low-passes the pelvis BONE), so the terrain drop can't feed back
// into the hip-stabilizer's settled reference. Crouch also lowers modelRoot (PlayerBody), so the crouch
// drop + the terrain drop compose for free, and the same foot plant that conforms to terrain is what
// bends the knees into the crouch.
//
// FOOT-SYNCED LOCOMOTION: the jogs' playback rate tracks ground speed, so a hard ankle-plant while the
// legs are cycling fights the clip and skates. So the WHOLE layer fades out with ground speed (full at
// idle / crouch-idle / slow creep — where terrain conform matters most — and off by a jog), via the
// eased master weight. Airborne / rolling / dead callers pass enabled:false and it eases fully out.
const LEGS = [
    { thigh: 'thigh_l', calf: 'calf_l', foot: 'foot_l', ball: 'ball_l' },
    { thigh: 'thigh_r', calf: 'calf_r', foot: 'foot_r', ball: 'ball_r' },
];

export default class FootIK{
    // model      : the skinned GLB scene (bones live here)
    // modelRoot  : the top-level Group positioned in world space each frame (we lower its .y for terrain)
    // physicsWorld: the Ammo world to raycast the ground against (StaticFilter = the level colliders)
    constructor(model, modelRoot, physicsWorld, opts = {}){
        this.model = model;
        this.modelRoot = modelRoot;
        this.world = physicsWorld;
        this.ik = new IKChainSolver();

        // ---- Tuning ----
        this.rayUp        = opts.rayUp        ?? 0.8;   // ground ray starts this far ABOVE the foot (m) — wider for stronger slopes
        this.maxDrop      = opts.maxDrop      ?? 1.15;  // ...and reaches this far below it (m) — deeper so a foot over a dip still finds ground
        this.maxHipDrop   = opts.maxHipDrop   ?? 0.55;  // most the avatar lowers for terrain (m) — more headroom for the stronger terrain
        this.footOrientMax= opts.footOrientMax?? THREE.MathUtils.degToRad(30); // clamp on the foot-to-slope tilt (calmer on the stronger terrain)
        this.normalLerp   = opts.normalLerp   ?? 10;    // low-pass rate (1/s) for the faceted terrain ground normal
        this.weightLerp   = opts.weightLerp   ?? 10;    // master-weight ease rate (1/s)
        this.hipDropLerp  = opts.hipDropLerp  ?? 8;     // terrain hip-drop ease rate (1/s)
        this.plantFadeLow = opts.plantFadeLow ?? 1.0;   // full foot IK at/below this ground speed (m/s)
        this.plantFadeHigh= opts.plantFadeHigh?? 3.5;   // ...fading to OFF at/above this (so the jog isn't fought)
        this.poleStabilize= opts.poleStabilize?? 0;     // 0 = preserve the clip's knee bend (pole only guards a flip)
        // CROUCH knee stabilization. Crouch-walking bends the knees deep, where the clip's animated knee
        // pole can swing across / go degenerate frame-to-frame and the two-bone solve snaps the knee
        // side-to-side ("popping/glitchy"). So, scaled by crouch, we bias the knee pole HARD toward the
        // fixed body-forward reference (the "up/forward vector" technique) — the knee then bends in one
        // consistent forward plane instead of chasing the noisy animated pole. 0 at standing (clip knee
        // preserved), ramping to crouchPoleStabilize at full crouch.
        this.crouchPoleStabilize = opts.crouchPoleStabilize ?? 0.85;
        // CROUCH foot flatten. A deep crouch knee-bend rotates the foot off the floor (toe down/up AND a
        // side roll) — it reads as "crooked feet". Fix: at calibration we snapshot each foot's true FLAT
        // world orientation (its standing pose, sole on the ground) and its heading. While crouched we drive
        // the foot back to that flat pose — re-yawed to the foot's CURRENT heading (so it still points where
        // the leg points) and tilted to the live ground normal (slopes) — blended by crouch. This corrects
        // BOTH pitch and roll, unlike a toe-only projection. 0 standing (clip foot preserved).
        this.crouchFootFlatten = opts.crouchFootFlatten ?? 1.0;
        // PENETRATION GUARD ease rate (1/s). The guard is a one-sided anti-clip pass that runs even while
        // the full plant has faded out for a fast jog, lifting ONLY feet that have sunk below their planted
        // rest height back onto the ground — so the feet never disappear into the uneven terrain (and never
        // pin a swing foot, so no skate). See _guardPenetration. Fast ease so a sudden bump is caught quickly.
        this.guardLerp = opts.guardLerp ?? 14;
        // CROUCH-WALK guard ATTACK ease rate (1/s). Standing, the guard snaps a clipping foot up INSTANTLY
        // (a fast jog onto a rise must never flash a foot through the ground). But crouch-WALKING the body
        // rides a touch low, so the planted foot sits just under its rest height every footfall — an instant
        // snap there re-solves the knee in ONE frame (the residual footfall "leg snap"). While crouched we
        // ease the attack over a few frames instead (still fast — the shallow crouch-walk drop can't visibly
        // clip in 3-4 frames), blended in by the crouch amount so standing terrain safety is untouched.
        this.guardCrouchAttackLerp = opts.guardCrouchAttackLerp ?? 22;
        // TOE-GROUND CONFORM. The leg solve plants the ANKLE (foot bone) but the toe (ball bone) is a LEAF
        // the solve never touches, so the clip's toe angle is carried rigidly. On this UE rig the foot plants
        // with the ANKLE ~0.12 m up and a steep ~33° metatarsal (ankle->ball), and the pointed boot toe —
        // modelled hanging BELOW the toe bone's near-horizontal forward axis — droops THROUGH the floor (the
        // reported "toes not aligned with the feet and the ground"). A bone-axis toe-tip plant is a no-op here
        // (the bone toe is already flat); the VISIBLE droop tracks the metatarsal. So this pass, run LAST,
        // measures the metatarsal pitch (foot->ball, from two bone positions — robust, no leaf axis to resolve)
        // and pitches the BALL bone up about its side axis until the toe sits at a natural rest pitch
        // (toeTargetPitch) below horizontal, lifting the boot's pointed toe out of the ground. Clamped +
        // weighted by the master plant weight AND a tighter speed fade so a moving foot keeps its toe-off.
        this.toeFlatten     = opts.toeFlatten     ?? 1.0;  // master strength of the toe-ground conform (0 = off)
        this.toeTargetPitch = opts.toeTargetPitch ?? THREE.MathUtils.degToRad(8);  // toe rest angle below horizontal (boot toe lands just on the ground)
        this.toeMaxAngle    = opts.toeMaxAngle    ?? THREE.MathUtils.degToRad(40); // clamp on the toe pitch correction
        this.toeFadeLow     = opts.toeFadeLow     ?? 0.6;  // full toe conform at/below this ground speed (m/s)
        this.toeFadeHigh    = opts.toeFadeHigh    ?? 1.9;  // ...fading to OFF by here so the walk toe-off reads naturally
        this._ball = new THREE.Vector3();
        this._toe  = new THREE.Vector3();
        this._flatQ = new THREE.Quaternion();
        this._flatTarget = new THREE.Quaternion();   // desired flat world orientation (rest, re-aimed + slope-tilted)
        this._flatCur = new THREE.Quaternion();      // foot's current world orientation
        this._yawQ = new THREE.Quaternion();         // heading re-aim (yaw about world up)
        this._heading = new THREE.Vector3();         // current foot heading (horizontal toe dir)
        // PER-FOOT ankle-rest height = the foot bone's height above the detected ground at REST. Captured
        // per foot so that on FLAT ground the IK target equals the clip's own foot placement => a true
        // NO-OP (foot IK never changes the flat-ground look; it only adapts to terrain DEVIATIONS and
        // anchors the feet for crouch). Calibrated as the MINIMUM (footY - groundY) over a short idle
        // window so a transiently-lifted foot (idle weight-shift) can't inflate it. Clamp guards a wild
        // value from a mid-air calibration. Target ankle Y = detectedGroundY + this foot's offset.
        // ankleRest is the ankle-bone-to-sole height — a RIG constant ~0.1-0.15 m. The max is kept tight
        // (0.2) so a bad calibration can never bake feet that float a third of a metre off the ground (the
        // regression). Calibration is also gated on genuinely-grounded frames (see Pass A) and SHARED across
        // both feet, so a sloped/airborne settle can't bake a too-large or left/right-asymmetric rest.
        this.ankleRestMin = 0.04; this.ankleRestMax = 0.2;
        this.ankleRestDefault = 0.12;
        this.calibFrames = 30;     // idle frames to take the planted minimum over
        this._calibCount = 0;

        // ---- Eased state ----
        this._weight = 0;          // master 0..1 (grounded & slow => 1, airborne/fast => 0)
        this._hipDrop = 0;         // eased terrain hip drop (m, >= 0)
        this._calibrated = false;
        this._calibBodyYaw = 0;    // body facing captured with restQuat, so the flatten re-aims by the yaw delta
        this._resolved = false;
        this.legs = null;

        // ---- Scratch (no per-frame allocation) ----
        this._footPos = new THREE.Vector3();
        this._origin  = new THREE.Vector3();
        this._dest    = new THREE.Vector3();
        this._target  = new THREE.Vector3();
        this._pole    = new THREE.Vector3();
        this._normal  = new THREE.Vector3();
        this._up      = new THREE.Vector3(0, 1, 0);
        this._idQ     = new THREE.Quaternion();    // identity (slerp base) — never mutated
        this._orientQ = new THREE.Quaternion();
        this._orientApplied = new THREE.Quaternion();
        this._hit = { intersectionPoint: new THREE.Vector3(), intersectionNormal: new THREE.Vector3() };
        // Toe-conform scratch (no per-frame allocation).
        this._toeDir     = new THREE.Vector3();      // current metatarsal dir (foot->ball, world)
        this._ballPos    = new THREE.Vector3();      // ball (toe base) world pos
        this._toeHeading = new THREE.Vector3();      // horizontal heading of the metatarsal
        this._toeTarget  = new THREE.Vector3();      // desired toe-forward (world, rest-pitched)
        this._toeRot     = new THREE.Quaternion();   // current -> target rotation
        this._toeApplied = new THREE.Quaternion();   // weighted, clamped toe rotation
    }

    // Resolve the two leg chains by UE bone name. Ball (toe) is optional (used only as a reference).
    ResolveBones(){
        const byName = {};
        this.model.traverse(o => { if(o.isBone){ byName[o.name] = o; } });
        this.legs = [];
        for(const L of LEGS){
            const thigh = byName[L.thigh], calf = byName[L.calf], foot = byName[L.foot];
            if(thigh && calf && foot){
                this.legs.push({
                    thigh, calf, foot, ball: byName[L.ball] || null,
                    ankleRest: this.ankleRestDefault, calibMin: Infinity,
                    hit: false, ground: 0, fx: 0, fy: 0, fz: 0,
                    nx: 0, ny: 1, nz: 0,
                    guard: 0,   // eased 0..1 penetration-guard amount (anti-ground-clip; see _guardPenetration)
                    // The foot's flat (standing) world orientation + heading, snapshot at calibration; the
                    // crouch flatten drives the foot back to this (re-aimed to the live heading). See _flattenFoot.
                    restQuat: new THREE.Quaternion(), restHeading: new THREE.Vector3(0, 0, 1),
                });
            }
        }
        this._resolved = this.legs.length > 0;
    }

    // Ease everything back to OFF (called on roll exit / despawn so the legs re-engage from zero
    // instead of thawing at a frozen pose — mirrors PlayerBody.ResetAimPoseAccumulators).
    Reset(){
        this._weight = 0;
        this._hipDrop = 0;
        if(this.legs){ for(const leg of this.legs){ leg.guard = 0; } }
    }

    // Per frame. opts:
    //   enabled : grounded && !rolling && alive — gates the full PLANT (else the plant eases out)
    //   guard   : gates ONLY the one-sided anti-ground-clip pass; BROADER than enabled (stays on during a
    //             brief airborne crest of the terrain) so a fast walk/jump never punches a foot through a
    //             hill. No-ops when the feet are well above the surface (a real jump's apex). Defaults to
    //             enabled, so the soldier (never airborne) is unchanged.
    //   speed   : horizontal ground speed (m/s) — fades the layer out as it rises (anti-skate)
    //   bodyYaw : facing yaw (rad), for the forward knee pole
    //   floor   : minimum weight while enabled (0..1). The player passes the eased CROUCH amount: a
    //             crouched body is lowered, so the feet MUST stay planted (knees bent) even while
    //             crouch-walking, or they'd sink through the floor when the speed-fade turned the layer
    //             off. The trade is a slightly flattened swing-foot lift at speed — preferable to feet
    //             clipping the ground. Standing (floor 0) keeps the full speed-fade (swing lift intact).
    Update(t, { enabled = true, guard = enabled, speed = 0, bodyYaw = 0, floor = 0, crouch = 0 } = {}){
        if(!this._resolved){ this.ResolveBones(); if(!this._resolved){ return; } }

        // Master weight: on when grounded AND slow, off when airborne/dead or moving fast (so the
        // foot-synced jog isn't fought into a skate) — but never below `floor` while enabled (crouch).
        const speedFactor = 1 - THREE.MathUtils.smoothstep(speed, this.plantFadeLow, this.plantFadeHigh);
        const target = enabled ? Math.max(speedFactor, THREE.MathUtils.clamp(floor, 0, 1)) : 0;
        this._weight += (target - this._weight) * (1 - Math.exp(-this.weightLerp * t));
        // Bail only when the PLANT has faded AND the anti-clip GUARD is off (rolling/dead): nothing to do,
        // the legs follow the air/roll clip. With `guard` on we keep going even at ~0 plant weight — so a
        // fast jog OR a brief airborne crest still gets its feet lifted out of the ground.
        if(this._weight < 1e-3 && !guard){
            this._hipDrop *= Math.exp(-this.hipDropLerp * t);   // bleed any residual drop (it's not applied here)
            return;
        }

        // Refresh from the ROOT (not `model`): we read absolute foot WORLD-Y and we move modelRoot.y
        // (Pass B), so the refresh must recompute modelRoot.matrixWorld itself — a child refresh would
        // read a stale parent matrix and miss this frame's crouch / terrain drop. Falls back to model.
        const root = this.modelRoot || this.model;
        root.updateMatrixWorld(true);

        // --- PASS A: raycast the ground under each foot's CURRENT animated position. ---
        let anyHit = false, slow = speed < 0.6;
        for(const leg of this.legs){
            leg.foot.getWorldPosition(this._footPos);
            this._origin.copy(this._footPos); this._origin.y += this.rayUp;
            this._dest.copy(this._footPos);   this._dest.y   -= this.maxDrop;
            leg.hit = AmmoHelper.CastRay(this.world, this._origin, this._dest, this._hit, CollisionFilterGroups.StaticFilter);
            if(!leg.hit){ continue; }
            anyHit = true;
            leg.ground = this._hit.intersectionPoint.y;
            // LOW-PASS the ground normal. The terrain collider is a triangle mesh, so the raycast returns
            // FACETED per-triangle normals; on the stronger slopes a foot crossing triangles would snap its
            // tilt (the "crooked / not-flat feet"). Easing the normal smooths the foot's slope-tilt across
            // facets. Seeded at world-up, so flat ground stays flat.
            const nlp = 1 - Math.exp(-this.normalLerp * t);
            leg.nx += (this._hit.intersectionNormal.x - leg.nx) * nlp;
            leg.ny += (this._hit.intersectionNormal.y - leg.ny) * nlp;
            leg.nz += (this._hit.intersectionNormal.z - leg.nz) * nlp;
            leg.fx = this._footPos.x; leg.fy = this._footPos.y; leg.fz = this._footPos.z;
            // Track each foot's MINIMUM rest offset over the idle window — ONLY from genuinely GROUNDED
            // frames (`enabled`). Without that gate, the spawn fall / a jump (where the now-broader guard
            // keeps Pass A running while the body is still HIGH above the ground) baked a huge offset and
            // the feet ended up floating ~0.3 m off the floor (the regression).
            if(!this._calibrated && slow && enabled){
                const offset = this._footPos.y - leg.ground;
                if(offset < leg.calibMin){ leg.calibMin = offset; }
            }
        }
        // Latch the ankle rest after the window of GROUNDED idle frames. ankleRest is a RIG constant (same
        // for both feet), so take the MIN across both feet (the most-planted offset) and SHARE it — a sloped
        // or asymmetric settle then can't bake a left/right difference that tilts the body ("crooked feet").
        if(!this._calibrated && anyHit && slow && enabled && ++this._calibCount >= this.calibFrames){
            let shared = Infinity;
            for(const leg of this.legs){ if(Number.isFinite(leg.calibMin)){ shared = Math.min(shared, leg.calibMin); } }
            shared = Number.isFinite(shared)
                ? THREE.MathUtils.clamp(shared, this.ankleRestMin, this.ankleRestMax) : this.ankleRestDefault;
            for(const leg of this.legs){
                leg.ankleRest = shared;
                // Snapshot the foot's flat STANDING world orientation (the crouch flatten target). Bones are
                // still at the pure clip pose here (the solve is skipped until calibrated), so this is the
                // genuine flat-on-the-ground foot. Matrices were refreshed at the top of Update.
                leg.foot.getWorldQuaternion(leg.restQuat);
            }
            this._calibBodyYaw = bodyYaw;   // body facing at capture — the flatten re-aims by (bodyYaw - this)
            this._calibrated = true;
        }
        // Until calibrated, DON'T solve — only observe. The leg solve (Pass C) moves the feet, and next
        // frame Pass A would read those IK-moved positions instead of the clip's, so the calibration
        // would converge to the IK's own output (the default offset) rather than the clip's true rest.
        // Skipping the solve during the short calibration window keeps Pass A reading pure clip poses, so
        // the captured per-foot rest is correct and the flat-ground solve is a genuine no-op afterward.
        if(!this._calibrated){
            this._hipDrop *= Math.exp(-this.hipDropLerp * t);   // still calibrating: nothing to solve yet
            return;
        }

        // Knee-pole foot-alignment weight: FULL at crouch-IDLE (the knee points the way the foot points —
        // the requested crouch knee/foot alignment), faded to the stable body-forward pole as crouch-WALK
        // speed rises. A crouch-walk swing foot's ankle->toe heading swings through the stride, so following
        // it makes the per-leg pole oscillate and the two-bone solver flip the knee side (the reported
        // "knee pop"); the fixed body-forward pole has nothing to oscillate. Tight speed band so even a slow
        // crouch-walk rides the stable pole. Drives Pass C's knee pole AND the penetration guard's.
        const crouchAmt = THREE.MathUtils.clamp(crouch, 0, 1);
        const kneeAlign = crouchAmt * (1 - THREE.MathUtils.smoothstep(speed, 0.2, 1.2));
        // Knee-pole stabilization rides the SQRT of the crouch blend: at a steady crouch it is the
        // full crouchPoleStabilize (sqrt(1)=1, unchanged), but through a crouch<->stand TRANSITION it
        // decays much slower than the plant — a linear decay left the half-released knee chasing the
        // clip's noisy animated pole mid-stride, and the bend PLANE flipped for a frame (a ~40-50°
        // single-frame calf snap on an uncrouch-while-jogging). sqrt keeps the bend plane pinned
        // body-forward until the plant is nearly gone; standing (crouch 0) is unchanged.
        const poleStab = THREE.MathUtils.clamp(
            this.poleStabilize + Math.sqrt(crouchAmt) * this.crouchPoleStabilize, 0, 1);

        // Plant faded out (fast jog, OR airborne crest): the PENETRATION GUARD (anti-ground-clip) is the
        // only foot pass — run it and bail before the full plant (Pass B/C), so the foot-synced jog isn't
        // fought into a skate. (When the plant DOES run, the guard instead runs LAST — see end of Update.)
        if(this._weight < 1e-3){
            if(guard){ this._guardPenetration(t, bodyYaw, kneeAlign, poleStab, crouchAmt); }
            this._hipDrop *= Math.exp(-this.hipDropLerp * t);
            return;
        }

        // Deepest required DESCENT (target ground below the animated foot) across the feet, for the hip drop.
        let deepest = 0;
        for(const leg of this.legs){
            if(!leg.hit){ continue; }
            const moveI = (leg.ground + leg.ankleRest) - leg.fy;   // + = foot must rise, - = foot must descend
            if(moveI < deepest){ deepest = moveI; }
        }

        // --- PASS B: lower the avatar (modelRoot, world m) by the deepest required DESCENT so that foot
        // can reach without the leg over-extending. A foot that must RISE is handled by bending its leg,
        // not by raising the hips — so only the negative (descend) case drops the hips. Eased. On flat
        // ground (and under crouch, where both feet sit below their targets) this stays 0. ---
        const dropTarget = THREE.MathUtils.clamp(-deepest, 0, this.maxHipDrop) * this._weight;
        this._hipDrop += (dropTarget - this._hipDrop) * (1 - Math.exp(-this.hipDropLerp * t));
        if(this._hipDrop > 1e-4){
            this.modelRoot.position.y -= this._hipDrop;
            root.updateMatrixWorld(true);   // refresh from the root so the leg solve reads the lowered hips
        }

        // --- PASS C: two-bone solve each leg so the ankle plants on the ground, then tilt the foot to
        // the surface. The knee pole points the knee in a stable direction (so a degenerate/flipped
        // animated pole can't bend the knee backward); poleStabilize 0 otherwise preserves the clip's
        // bend. The ankle target eases from the animated position to the ground by the master weight. ---
        // Crouch ramps the pole-stabilize bias HARD toward the chosen pole so the deep-bent knee stops
        // chasing the clip's noisy animated pole (poleStab, computed above with kneeAlign — sqrt-of-
        // crouch so transitions stay pinned). The pole DIRECTION is the speed-tapered body-forward/foot
        // blend (kneeAlign): biasing toward the STABLE body-forward pole while crouch-walking is what
        // calms the knee. 0 standing.
        // Crouch foot-flatten taper. A crouch-IDLE foot should lie FLAT on the ground; but forcing a
        // mid-stride SWING foot flat during a crouch-WALK reads as locked/crooked feet (the reported
        // crouch-walk glitch). So fade the flatten OUT as the crouch-walk picks up speed — full at
        // crouch-idle, off by a brisk crouch-walk — letting the swing foot follow the clip. The PLANT
        // (feet on the ground, knees bent) is untouched, so the body never sinks; only the foot
        // ORIENTATION correction tapers. As the flatten fades the clip's own slope tilt fades back in.
        const crouchMoveFade = 1 - THREE.MathUtils.smoothstep(speed, 0.6, this.plantFadeHigh);
        const flatCrouch = crouchAmt * crouchMoveFade;
        const flattenAmt = flatCrouch * this.crouchFootFlatten;
        for(const leg of this.legs){
            if(leg.hit){
                leg.foot.getWorldPosition(this._footPos);
                const targetY = leg.ground + leg.ankleRest;
                this._target.set(
                    this._footPos.x,
                    THREE.MathUtils.lerp(this._footPos.y, targetY, this._weight),
                    this._footPos.z);
                // Per-leg knee pole: body-forward, blended toward the way THIS foot points (ankle->toe) by
                // kneeAlign — FULL at crouch-idle (knee/foot agree, the requested alignment), 0 when
                // crouch-walking (stable body-forward, no swing-foot oscillation). Into this._pole per leg.
                this._kneePole(leg, bodyYaw, kneeAlign, this._pole);
                this.ik.solveTwoBone(leg.thigh, leg.calf, leg.foot, this._target, this._pole, poleStab);
            }
            // Crouch flatten runs on EVERY foot — planted OR swinging — so a planted crouch-idle foot lies
            // flat; the speed taper (flatCrouch) lets a crouch-walk swing foot follow the clip instead.
            this._flattenFoot(leg, flatCrouch, bodyYaw);
            // Slope tilt only where we have a fresh ground normal, and fading out as the flatten takes over.
            if(leg.hit){ this._orientFoot(leg, 1 - Math.min(1, flattenAmt)); }
        }

        // --- FINAL PENETRATION GUARD (anti-ground-clip). Runs AFTER the plant + hip-drop so it catches a
        // foot the body-lower (Pass B) pushed below the surface that a partial plant (Pass C at a faded
        // weight) didn't fully re-seat — the residual mid-stride ground-clip at walk-start. One-sided +
        // attack-instant (standing); crouch eases the attack so footfalls don't snap the knee. ---
        if(guard){ this._guardPenetration(t, bodyYaw, kneeAlign, poleStab, crouchAmt); }

        // --- TOE-GROUND CONFORM (absolute last foot write). The foot bone is now planted + oriented; the
        // ball/toe leaf still carries the clip's (drooping) toe angle. Pitch it so the toe tip plants on the
        // ground. Faded by the master weight AND a tighter speed taper, so it flattens the toe on a planted
        // (idle / crouch-idle / slow) foot but releases for a moving foot's natural toe-off. ---
        const toeFade = (1 - THREE.MathUtils.smoothstep(speed, this.toeFadeLow, this.toeFadeHigh)) * this.toeFlatten;
        if(toeFade > 1e-3){
            for(const leg of this.legs){ if(leg.hit){ this._conformToe(leg, this._weight * toeFade); } }
        }
    }

    // Knee bend direction (pole) for one leg, written into `out`. STANDING: the fixed body-forward
    // reference (+ a little up) that keeps the knee bending cleanly forward. CROUCHED: blend the
    // horizontal bend direction toward the way THIS foot actually points — its ankle->toe heading
    // (ball - foot) — so the knee and the foot agree in direction instead of the knee facing
    // body-forward while a splayed foot points elsewhere (the reported "knees not aligned with the
    // feet" when crouched). The upward bias is preserved so the knee still lifts forward, not dead
    // level. Falls back to pure body-forward with no toe bone or a degenerate heading.
    _kneePole(leg, bodyYaw, crouch, out){
        out.set(Math.sin(bodyYaw), 0.4, Math.cos(bodyYaw)).normalize();
        if(crouch < 1e-3 || !leg.ball){ return out; }
        leg.foot.getWorldPosition(this._footPos);
        leg.ball.getWorldPosition(this._ball);
        this._heading.set(this._ball.x - this._footPos.x, 0, this._ball.z - this._footPos.z);
        if(this._heading.lengthSq() < 1e-8){ return out; }
        this._heading.normalize();
        // Blend only the HORIZONTAL components toward the foot heading by the crouch amount; keep the
        // vertical bias (out.y) from the body-forward pole so the bend still has its forward lift.
        out.set(THREE.MathUtils.lerp(out.x, this._heading.x, crouch), out.y,
                THREE.MathUtils.lerp(out.z, this._heading.z, crouch)).normalize();
        return out;
    }

    // One-sided vertical PENETRATION GUARD (anti-ground-clip). For each foot with a ground hit, if its
    // ankle has dropped below its planted rest height (ground + ankleRest) — i.e. the foot mesh is
    // clipping INTO the terrain — lift the ankle back to that height. It NEVER lowers a foot or pins one
    // that's above the surface, so a swing foot keeps its full lift (no skate). The lift is ATTACK-INSTANT
    // (correct the clip the very frame it appears — a fast stride onto a rise, or the body dropping into a
    // crouch, can't flash a foot through the ground) and RELEASE-EASED (no knee pop when the foot rises off
    // the surface). Full strength: it lifts exactly to the surface, so Pass C (which also targets that
    // height) just re-confirms it — they never fight. Reuses Pass A's raycast hit (no extra raycast).
    _guardPenetration(t, bodyYaw, kneeAlign = 0, poleStab = this.poleStabilize, crouchAmt = 0){
        const ease = 1 - Math.exp(-this.guardLerp * t);
        // Attack ease: INSTANT standing (terrain anti-clip must not lag a fast stride onto a rise), but
        // eased while crouched (footfalls of the slightly-low crouch-walk body must not snap the knee).
        // Blended by the crouch amount, so standing behaviour is byte-for-byte unchanged.
        const attack = THREE.MathUtils.lerp(1, 1 - Math.exp(-this.guardCrouchAttackLerp * t),
            THREE.MathUtils.clamp(crouchAmt, 0, 1));
        const align = THREE.MathUtils.clamp(kneeAlign, 0, 1);   // speed-tapered crouch knee/foot alignment
        for(const leg of this.legs){
            let target = 0;
            if(leg.hit){
                leg.foot.getWorldPosition(this._footPos);
                if(this._footPos.y < leg.ground + leg.ankleRest){ target = 1; }   // ankle below rest => clipping
            }
            // Attack (snap/ease UP), release eased (glide DOWN) — penetration never shows, exit never pops.
            leg.guard = target > leg.guard ? leg.guard + (target - leg.guard) * attack
                                           : leg.guard + (target - leg.guard) * ease;
            if(leg.guard < 1e-3 || !leg.hit){ continue; }
            const restY = leg.ground + leg.ankleRest;
            this._target.set(this._footPos.x,
                THREE.MathUtils.lerp(this._footPos.y, restY, leg.guard), this._footPos.z);
            // Same speed-tapered knee pole AND the same crouch-aware pole stabilization as Pass C —
            // the guard's attack-instant lift previously solved with the raw (0) stabilize, so its
            // one-frame correction was free to flip the knee's bend plane.
            this._kneePole(leg, bodyYaw, align, this._pole);
            this.ik.solveTwoBone(leg.thigh, leg.calf, leg.foot, this._target, this._pole, poleStab);
        }
    }

    // Crouch foot-flatten: drive the foot back to its FLAT standing orientation (snapshot at calibration) so
    // a crouch never leaves it crooked. The flat target is the rest orientation, RE-YAWED to the foot's
    // current heading (so it still points where the leg points) and TILTED to the live ground normal (slopes).
    // Slerped from the foot's current world orientation by crouch * master weight — correcting both the toe
    // pitch and the side roll the deep knee bend imparts. No-op standing (crouch 0) or before calibration.
    _flattenFoot(leg, crouch, bodyYaw){
        const w = this._weight * crouch * this.crouchFootFlatten;
        if(w < 1e-3 || !this._calibrated){ return; }

        // Re-aim the flat rest pose by how far the BODY has turned since capture, so the foot still points
        // forward under the player (planted, body-forward) instead of locked to the world facing it was
        // calibrated in. Body-yaw delta is stable (no per-foot toe-projection jitter).
        const dyaw = bodyYaw - this._calibBodyYaw;
        // target = yaw(dyaw) * restQuat  — the flat standing pose (sole flat on level ground), re-aimed to
        // the current facing. We deliberately flatten to WORLD-level, NOT to the raycast's ground normal:
        // the level colliders return noisy/edge normals that, applied here, were tilting the foot ~30deg
        // ("still crooked"). The user wants the crouched foot FLAT, so a clean world-up flatten is correct;
        // gentle real slopes are still handled by _orientFoot, which is full when standing and only fades
        // out as the crouch flatten takes over.
        this._yawQ.setFromAxisAngle(this._up, dyaw);
        this._flatTarget.copy(this._yawQ).multiply(leg.restQuat);

        // World delta from the foot's current orientation to the flat target, applied at weight w.
        leg.foot.getWorldQuaternion(this._flatCur);
        this._flatQ.copy(this._flatTarget).multiply(this._flatCur.invert());   // target * current⁻¹
        this._orientApplied.copy(this._idQ).slerp(this._flatQ, Math.min(1, w));
        this.ik.applyWorldQuat(leg.foot, this._orientApplied);
    }

    // Tilt the foot so its sole follows the ground normal: a world delta from world-up to the surface
    // normal, clamped to footOrientMax and weighted, applied about the ankle (so the planted position is
    // unchanged). Flat ground (normal≈up) => identity => no-op.
    _orientFoot(leg, scale = 1){
        if(scale <= 1e-3){ return; }
        const len = Math.hypot(leg.nx, leg.ny, leg.nz) || 1;
        this._normal.set(leg.nx / len, leg.ny / len, leg.nz / len);
        this._orientQ.setFromUnitVectors(this._up, this._normal);   // up -> ground normal (short arc; normal is upper-hemisphere)
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(this._orientQ.w, -1, 1));
        let s = this._weight * scale;
        if(angle > this.footOrientMax && angle > 1e-5){ s *= this.footOrientMax / angle; }
        this._orientApplied.copy(this._idQ).slerp(this._orientQ, s);
        this.ik.applyWorldQuat(leg.foot, this._orientApplied);
    }

    // Toe-ground conform: pitch the ball (toe) bone up so the pointed boot toe stops drooping through the
    // floor. The bone's own forward axis sits nearly flat already, but the boot MESH toe hangs below it and
    // tracks the steep metatarsal (ankle->ball); so we measure the metatarsal direction (two bone positions,
    // robust + mirror-safe) and rotate the ball so it sits at toeTargetPitch below horizontal — i.e. lift the
    // toe by (metatarsalPitch - toeTargetPitch). The rotation keeps the toe HEADING (pure pitch about the
    // side axis: source and target share their horizontal heading), is clamped to toeMaxAngle, weighted by
    // `w`, and applied about the ball's origin (the toe base doesn't move, only the toe lifts). No-op before
    // calibration. A metatarsal already flatter than the target yields a ~0 rotation (won't force the toe down).
    _conformToe(leg, w){
        if(w < 1e-3 || !this._calibrated || !leg.ball){ return; }
        leg.foot.getWorldPosition(this._footPos);
        leg.ball.getWorldPosition(this._ballPos);
        this._toeDir.copy(this._ballPos).sub(this._footPos);           // metatarsal (ankle->ball), world
        this._toeHeading.set(this._toeDir.x, 0, this._toeDir.z);
        if(this._toeDir.lengthSq() < 1e-8 || this._toeHeading.lengthSq() < 1e-8){ return; }
        this._toeDir.normalize(); this._toeHeading.normalize();
        // Desired direction: same heading, pitched toeTargetPitch below horizontal. The short-arc rotation
        // from the (steeper) metatarsal to this is a pure lift about the side axis.
        const cp = Math.cos(this.toeTargetPitch), sp = Math.sin(this.toeTargetPitch);
        this._toeTarget.set(this._toeHeading.x * cp, -sp, this._toeHeading.z * cp).normalize();
        this._toeRot.setFromUnitVectors(this._toeDir, this._toeTarget);
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(this._toeRot.w, -1, 1));
        let s = w;
        if(angle > this.toeMaxAngle && angle > 1e-5){ s *= this.toeMaxAngle / angle; }
        this._toeApplied.copy(this._idQ).slerp(this._toeRot, s);
        this.ik.applyWorldQuat(leg.ball, this._toeApplied);
    }
}

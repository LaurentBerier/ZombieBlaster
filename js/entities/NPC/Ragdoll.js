import * as THREE from 'three'
import { AmmoHelper, CollisionFilterGroups } from '../../AmmoLib.js'


// Death ragdoll for the skinned enemies. Inspired by the rapierjs-ragdoll demo
// (https://mavon.ie/demos/rapierjs-ragdoll): build a small physics skeleton from
// the character's bones, simulate it, then map the simulated joints back onto the
// real bones so the skinned mesh crumples and settles. This game runs on Ammo.js
// (Bullet) for the world, but a full multi-body Bullet constraint ragdoll is heavy
// to tune and easy to destabilise; for a one-shot death crumple a small, fully
// self-contained CPU **verlet** ragdoll is more robust (it can never explode the
// shared physics world) and works identically for BOTH enemy skeletons — the
// Mixanmo mutant and the UE Mannequin soldier — with zero per-rig bone names.
//
// How it stays generic:
//   * It walks the SkinnedMesh's own skeleton and keeps the "major" bones (dropping
//     fingers / toes / twist / IK helpers), re-parenting kept bones to their nearest
//     kept ancestor so the kept set is still a connected tree.
//   * A particle sits at each kept bone's world joint; a distance stick links it to
//     its kept parent (the limb), plus a longer "brace" stick to its grandparent
//     that gives the chain bending stiffness so the body folds at the joints instead
//     of collapsing into a noodle.
//   * Gravity + the death impulse drive it; the verlet particles collide with the
//     REAL level (walls, floor, slopes, props) via Ammo sphere-sweeps + down-rays,
//     bouncing and sliding, so the corpse tumbles over geometry instead of freezing.
//   * Each frame every kept bone is re-oriented (root → leaf) to point along its live
//     limb direction, exactly like the reference's bone-from-body mapping.
//
// AAA feel notes: the motion after death is PURE PHYSICS — there is no canned pose,
// no blend/lerp back to animation, and no "landing stabilization" (an earlier build
// stiffened the legs for the first half-second to hold a stance; that scripted assist
// is gone). Restitution + low contact friction keep the body rebounding, rolling and
// tumbling on impact instead of thudding to a dead-weight stop; gravity is exaggerated
// (~2.2x) and the impulse is applied at a RANDOM hit location so no two deaths repeat.
//
// Drop-in: construct it on death from the enemy's SkinnedMesh, then call update(dt)
// each frame in place of the animation mixer. Everything is guarded by the caller
// (try/catch) so a build failure simply falls back to the old death behaviour.

// Bones we DON'T simulate (extremities / helpers add cost and visual noise without
// changing the silhouette of a falling body). Kept bones re-parent across these.
const SKIP_BONE = /ik_|_twist|twist_|^root$|toe|ball|thumb|index|middle|ring|pinky|finger|weapon|prop|attach|_corrective|_offset/i;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _restDir = new THREE.Vector3();
const _liveDir = new THREE.Vector3();

// Module-level anti-repeat: remember the last randomly-chosen hit bone so two
// consecutive deaths never yank the SAME joint (a cheap guarantee that successive
// corpses crumple differently even before the per-death jitter is considered).
let _lastHitIndex = -1;

export default class Ragdoll{
    // skinnedMesh : the enemy's THREE.SkinnedMesh (its .skeleton supplies the bones)
    // options:
    //   groundY      : world Y the corpse rests on (the feet/ground height at death) — a
    //                  fallback floor used only where the world down-ray finds nothing.
    //   impulse      : THREE.Vector3 initial knock-back velocity (m/s) — away from the killer.
    //   gravity      : downward accel — exaggerated (~2.2x real) so the corpse reads as HEAVY and
    //                  drops/crumples FAST instead of settling in slow motion (default -22).
    //   twist        : initial angular velocity about vertical (rad/s) — spins the corpse as it
    //                  falls so deaths vary; pass a random per-death value (default 0 = no spin).
    //   physicsWorld : the Ammo dynamics world. When supplied the corpse collides with the real
    //                  level geometry (StaticFilter) — walls, floor, slopes, props — so it bounces,
    //                  rolls and tumbles over the environment. Without it, a flat groundY plane.
    constructor(skinnedMesh, { groundY = 0, impulse = null, gravity = -22.0, twist = 0, physicsWorld = null } = {}){
        this.mesh = skinnedMesh;
        this.groundY = groundY;
        this.gravity = gravity;
        this.physicsWorld = physicsWorld;
        this.particleRadius = 0.06;
        // Light air drag (close to 1.0). In verlet, damping caps the fall speed at
        // gravityStep/(1-damping): a low value throttles terminal velocity and the death looks
        // weightless/slow. At 0.985 the body accelerates to a heavy ~9 m/s and slams down.
        this.damping = 0.985;          // air drag per step (high value == little drag)
        this.iterations = 12;          // relaxation passes so limbs hold length + limits under high gravity
        this.substeps = 2;             // verlet sub-steps per frame (stability at the faster fall)
        this.boneStiffness = 1.0;      // limb (parent) sticks hold their length hard
        // Brace stiffness: grandparent braces keep the body from collapsing into a noodle. Kept
        // MODERATE — too strong and the corpse stands (a stiff stick-figure with feet planted is a
        // stable column that never falls). Bumped from 0.16 for more "muscle tone" / bend resistance
        // (the user wanted limbs stiffer so they don't whip into impossible poses) without locking it
        // upright. Constant (no time-varying scripted stiffening).
        this.braceStiffness = 0.20;    // grandparent braces resist bending

        // ---- Leg-specific stiffening (the "legs don't twist 180°" fix) ----
        // The legs fold/twist the worst on a verlet corpse — the long thigh→calf→foot chain has the most
        // leverage, so it can wring ~180° or fold the shin back through the thigh. We stiffen the LEG
        // chains specifically: stronger braces + a TIGHTER (less-folding) joint limit + a firmer T-pose
        // pull than the rest of the body, so the legs keep a believable bend instead of pretzeling. Matched
        // by bone name (rig-agnostic: any bone reading as a leg joint), so it works on both enemy rigs.
        this.legBoneRe = /thigh|calf|shin|knee|leg|foot|ankle/i;   // UE (thigh/calf/foot) + Mixamo (UpLeg/Leg/Foot)
        this.legBraceStiffness = 0.55;   // grandparent brace k for leg chains (vs braceStiffness elsewhere)
        this.legFoldFrac = 0.70;         // |A-C| min for leg joints — tighter than jointFoldFrac (no over-fold)
        this.legRestStiffness = 0.16;    // firmer T-pose pull on leg joints (more "muscle tone" in the legs)

        // ---- Joint angle limits (AAA "no impossible poses") ----
        // The distance + brace sticks alone let a verlet skeleton fold into anatomically impossible
        // poses (a forearm bent backward through the upper arm, a shin folding through the thigh). We
        // add a JOINT-DISTANCE LIMIT on each 3-bone chain A-B-C: the span |A-C| encodes the angle at B
        // (law of cosines), so clamping that span between a folded minimum and a near-straight maximum
        // limits the joint angle — the limb can't hyperextend past straight and can't over-fold through
        // itself. The bounds come from the two bone LENGTHS (geometry, not the death pose), so they're
        // anatomically meaningful regardless of the pose at death. Crucially this is a symmetric
        // distance projection just like the limb sticks — it never injects energy, so the corpse still
        // tumbles freely and then SETTLES to a clean rest (an earlier angular-cone version pumped energy
        // and made a limb flail forever). The existing soft braces still pull gently toward the
        // death-pose span, which reads as a bit of joint RESISTANCE / muscle tone (the GTA feel).
        // Tighter than before so joints can neither over-fold nor lock out straight: an elbow/knee
        // keeps a slight natural bend at the extreme instead of snapping to a rigid, hyperextended or
        // fully-folded stick. (The user wanted tighter joint limits so limbs don't end up impossible.)
        this.jointFoldFrac = 0.50;       // |A-C| min as a fraction of straight length (tightest fold)
        this.jointStraightFrac = 0.965;  // |A-C| max as a fraction of straight length (no hyperextension)
        this.limitStiffness = 0.97;      // how hard the joint-span limits pull (stiff — they're hard limits)
        // GENTLE pull of each joint toward its T-POSE (bind-pose) angle — a "muscle tone" resistance
        // that biases the body to settle near anatomically natural angles (and helps unfold a joint
        // that got driven the wrong way) WITHOUT being strong enough to hold a standing stance. The
        // rest span comes from the skeleton's bind pose (see _build), so it's the real neutral pose.
        this.jointRestStiffness = 0.05;  // soft spring toward the T-pose joint angle (0 = off)

        // ---- World collision (the AAA "reacts to the environment" bit) ----
        // The corpse particles collide with the REAL static level via Ammo sweeps/rays, so it
        // bounces off walls, rolls down slopes and piles against props instead of clipping through.
        this.worldCollideRadius = 0.11;  // body half-thickness used for the wall sphere-sweep (m)
        // Impact response: restitution gives visible REBOUNDS off the first ground hit; the high
        // tangential keep lets the body SLIDE/ROLL/tumble after landing rather than freezing dead
        // (the old build bled ~70% of horizontal speed on contact — that was the "dead-weight
        // freeze"). Pure physics: no post-landing animation assist of any kind. Pushed up for a
        // juicier, more visible rebound off the floor on the kill slam (the resting-contact gate
        // below still drops it to 0 at low speed so the body always settles to a clean rest).
        // Lower bounce + a touch more ground friction than the old juicy values: the big, heavy beast
        // was rebounding/rolling so much it visibly "shook" after slamming down. It still rebounds off
        // the first hit, but settles to rest faster instead of jittering. (The user's beast-shake fix.)
        this.restitution = 0.42;         // bounce: fraction of into-surface speed returned on impact
        this.tangentKeep = 0.82;         // fraction of along-surface speed kept on contact (slide/roll)
        // Resting-contact threshold (per-substep displacement; ≈1.2 m/s). Below this into-surface
        // speed, restitution is dropped to 0 so the body comes to REST instead of micro-bouncing on
        // gravity's per-frame nudge forever (a bouncy sphere never settles in a discrete sim). The
        // big, satisfying first impacts (corpse slams in at several m/s) are well above it and still
        // rebound fully; only the dying-out settle bounces are damped to rest — which also lets the
        // sleep gate actually engage.
        this.restThreshold = 0.02;
        this._mask = CollisionFilterGroups.StaticFilter;   // collide vs the static level only
        this._rayPt = new THREE.Vector3();
        this._sweepRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };
        this._n = new THREE.Vector3();
        this._vel = new THREE.Vector3();    // captured incoming velocity at a contact
        this._tmp = new THREE.Vector3();    // reflected velocity scratch

        // Settle/sleep: once the corpse has tumbled to a genuine REST (negligible net frame motion
        // for a short dwell) we stop the per-node sweep+ray work entirely — the bones are already in
        // their final pose. This is natural rest AFTER the tumble (like a physics engine's island
        // sleep), NOT a scripted freeze on first impact: it only triggers after sustained stillness,
        // so rebounds/rolls/secondary collisions all play out first.
        this._age = 0;                      // seconds since death
        this._stillTime = 0;                // seconds the body's centroid has been essentially motionless
        this._asleep = false;
        this._lastCentroid = new THREE.Vector3();
        this._haveCentroid = false;
        this.sleepDwell = 0.6;              // centroid must be still this long (s) before it counts as SETTLED
        // Post-settle LINGER: once the corpse has come to rest (still for sleepDwell), keep the verlet
        // sim RUNNING for a beat instead of freezing on the spot — so the body stays physically
        // reactive (and finishes any last micro-settle / weight-shift) for a couple seconds after it
        // lands, reading as a freshly-dropped body rather than one that snaps rigid the instant it
        // stops. After sleepDwell + postSettleLinger of continuous stillness it sleeps (bounding the
        // per-corpse cost). Any real motion in between (a late roll, a secondary collision) resets the
        // stillness timer, so a body that's still tumbling never sleeps early.
        this.postSettleLinger = 1.2;        // seconds to keep simulating AFTER settling, before sleeping
        // Sleep on CENTROID translation, not per-node motion: a verlet constraint network always has
        // sub-mm internal jitter even at rest (the soft braces never perfectly freeze), so summing
        // per-node motion never crosses a tight threshold. The centroid averages that jitter out and
        // is steady once the body stops translating. 1e-4 ≈ a ~0.6 m/s centroid speed at 60fps: well
        // ABOVE the resting verlet residual (so a settled corpse reliably sleeps wherever it lands —
        // even leaning on geometry) yet far BELOW a real tumble (flung at 2-9 m/s), so a genuinely
        // moving body never false-sleeps.
        this.sleepCentroidSq = 1e-4;

        // ---- Ground-impact freeze (the AAA "no endless jitter on landing" fix) ----
        // A verlet corpse on the floor never perfectly stops — the soft braces + limits leave a low-
        // amplitude residual that reads as the body "shaking" after it lands. Rather than rely on the
        // slow centroid-sleep above, we count distinct GROUND impacts and HARD-FREEZE the sim shortly
        // after: on the 1st floor hit we KICK the body back up for a visible rebound (see landingBounce)
        // and arm a fallback freeze; on the 2nd hit (it bounced and came back down) we freeze 0.5 s later.
        // Freezing leaves the bones exactly where they settled — no jitter. Applies to EVERY ragdoll.
        this._frozen = false;               // true => sim stopped, bones held at their last pose
        this._groundHits = 0;               // distinct ground impacts counted
        this._lastGroundHitAge = -1;        // _age of the last counted impact (debounce)
        this.groundHitDebounce = 0.12;      // s between impacts to count them as distinct (rejects micro-bounce)
        this.impactDisp = 0.012;            // min per-substep into-floor displacement to count as an impact (~1.4 m/s)
        this._hitGroundThisFrame = false;   // set by the floor collision, consumed in update()
        this._freezeTimer = -1;             // s until the sim freezes (-1 = unarmed)
        this.firstHitFreeze = 1.3;          // fallback: freeze this long after the 1st hit if no clean 2nd hit
        this.secondHitFreeze = 0.5;         // freeze this long after the 2nd hit (the requested quick kill)
        // 1st-hit upward velocity GAIN (>1). The floor contact already reflects each particle up by
        // `restitution`; on the first counted ground impact we further multiply that REBOUND (upward)
        // velocity so the corpse gives a small, believable settle-bounce before it comes down again and
        // rests. Only upward motion is scaled, so parts still falling aren't driven harder into the
        // ground. Kept MODEST (a realistic body doesn't trampoline off the floor) — paired with the
        // reduced death impulse, deaths read as a body crumpling, not getting launched.
        this.landingBounce = 2.5;

        skinnedMesh.skeleton.bones.forEach(b => b.updateWorldMatrix(true, false));

        this._build(impulse, twist);
    }

    _build(impulse, twist = 0){
        const bones = this.mesh.skeleton.bones;
        const keep = b => !SKIP_BONE.test(b.name);

        // Kept bones + a particle each, at the bone's current world position.
        this.nodes = [];                 // { bone, p, prev, frameStart, restWorldQuat, parent, grand, primaryChild }
        const nodeByBone = new Map();
        for(const bone of bones){
            if(!bone.isBone || !keep(bone)){ continue; }
            const p = bone.getWorldPosition(new THREE.Vector3());
            const node = {
                bone,
                p,
                prev: p.clone(),
                frameStart: p.clone(),       // particle position at the start of the current frame (for sweeps)
                restWorldQuat: bone.getWorldQuaternion(new THREE.Quaternion()),
                parent: null, grand: null, primaryChild: null,
            };
            nodeByBone.set(bone, node);
            this.nodes.push(node);
        }
        if(this.nodes.length < 2){ throw new Error('Ragdoll: too few bones'); }

        // Nearest KEPT ancestor (walk up across skipped helper bones).
        const keptAncestor = bone => {
            let p = bone.parent;
            while(p && p.isBone){
                if(nodeByBone.has(p)){ return nodeByBone.get(p); }
                p = p.parent;
            }
            return null;
        };
        for(const node of this.nodes){
            node.parent = keptAncestor(node.bone);
            node.grand = node.parent ? node.parent.parent : null;
        }

        // The graph root = the kept bone with no kept ancestor (pelvis / hips).
        this.root = this.nodes.find(n => !n.parent) || this.nodes[0];

        // Distance sticks: limb (parent) + brace (grandparent, for bending stiffness). Leg chains get a
        // STIFFER brace (legBraceStiffness) so the legs resist folding/twisting into impossible poses.
        const isLeg = node => node && node.bone && this.legBoneRe.test(node.bone.name);
        this.sticks = [];
        for(const node of this.nodes){
            if(node.parent){
                this.sticks.push({ a: node, b: node.parent, len: node.p.distanceTo(node.parent.p), k: this.boneStiffness });
            }
            if(node.grand){
                const leg = isLeg(node) || isLeg(node.grand);
                this.sticks.push({ a: node, b: node.grand, len: node.p.distanceTo(node.grand.p),
                    k: leg ? this.legBraceStiffness : this.braceStiffness });
            }
        }

        // Primary child for orientation = the kept child whose subtree is largest (so the
        // hips follow the spine, not a leg; an arm follows down to the hand). Build child
        // lists first, then pick by descendant count.
        const children = new Map(this.nodes.map(n => [n, []]));
        for(const node of this.nodes){ if(node.parent){ children.get(node.parent).push(node); } }
        const subtreeSize = node => {
            let n = 1;
            for(const c of children.get(node)){ n += subtreeSize(c); }
            return n;
        };
        for(const node of this.nodes){
            const kids = children.get(node);
            node.children = kids;
            if(kids.length){
                node.primaryChild = kids.reduce((best, c) => subtreeSize(c) > subtreeSize(best) ? c : best, kids[0]);
                // Rest direction (world) from this bone's joint toward that child's joint.
                node.restDir = node.primaryChild.p.clone().sub(node.p).normalize();
            }
        }

        // Joint-span limits. For each 3-bone chain grand(A) -> parent(B) -> node(C), the span |A-C|
        // is clamped to [foldFrac, straightFrac] * (|A-B| + |B-C|): it can never exceed the straight
        // length (no hyperextension) nor fold tighter than the minimum (no folding through itself).
        // The bounds come from the two bone lengths, so they hold whatever pose the body died in.
        // T-pose (bind-pose) joint reference for the gentle "muscle tone" pull. The bind-pose world
        // positions come from the skeleton's inverse-bind matrices; we only use the |A-C| SPAN, which
        // is frame-invariant, so mesh-local vs world doesn't matter. Guarded: if the data is missing
        // the rest pull is simply skipped per joint (rest stays null).
        const bindPos = new Map();
        const sk = this.mesh.skeleton;
        if(sk && sk.boneInverses){
            const m = new THREE.Matrix4();
            sk.bones.forEach((b, i) => {
                const inv = sk.boneInverses[i];
                if(inv){ bindPos.set(b, new THREE.Vector3().setFromMatrixPosition(m.copy(inv).invert())); }
            });
        }

        this.limitSticks = [];
        for(const node of this.nodes){
            const B = node.parent;
            if(!B){ continue; }
            const A = B.parent;
            if(!A){ continue; }                              // need a full 3-bone chain
            const ab = node.p.distanceTo(B.p);
            const bc = B.p.distanceTo(A.p);
            const straight = ab + bc;
            if(straight < 1e-5){ continue; }
            // Leg joints fold less + spring toward their T-pose angle harder, so a knee/hip can't wring
            // 180° or fold the shin back through the thigh.
            const leg = isLeg(node) || isLeg(B) || isLeg(A);
            const stick = {
                a: node, b: A,
                min: straight * (leg ? this.legFoldFrac : this.jointFoldFrac),
                max: straight * this.jointStraightFrac,
                k: this.limitStiffness,
                rest: null,                                  // T-pose target span (set below if available)
                restK: leg ? this.legRestStiffness : this.jointRestStiffness,
            };
            // T-pose span for this chain, clamped into the joint's own [min,max] so the soft rest pull
            // can never fight the hard limits.
            const pa = bindPos.get(node.bone), pc = bindPos.get(A.bone);
            if(pa && pc){ stick.rest = THREE.MathUtils.clamp(pa.distanceTo(pc), stick.min, stick.max); }
            this.limitSticks.push(stick);
        }

        // Precompute the root -> leaf (BFS) order so _applyToBones reuses it each frame and
        // every bone reads its parent's already-updated world transform.
        this.order = [];
        const queue = [this.root];
        while(queue.length){
            const n = queue.shift();
            this.order.push(n);
            for(const c of n.children){ queue.push(c); }
        }

        // Seed velocity so the corpse is knocked OFF BALANCE and topples (verlet velocity is
        // prev = p - v*dt0). The horizontal knockback grows with a joint's height above the
        // feet, so the upper body is shoved harder than the feet — that height-weighted push
        // is a tipping torque about the feet, which reliably tips the standing pose over
        // instead of sliding it flat (a uniform push would just translate the whole body).
        const dt0 = 1 / 60;
        if(impulse){
            let baseY = Infinity, topY = -Infinity;
            for(const node of this.nodes){ baseY = Math.min(baseY, node.p.y); topY = Math.max(topY, node.p.y); }
            const span = Math.max(0.2, topY - baseY);
            const horiz = _v2.set(impulse.x, 0, impulse.z);
            const up = impulse.y;
            for(const node of this.nodes){
                const h = (node.p.y - baseY) / span;          // 0 at the feet, 1 at the head
                const hScale = 0.3 + 1.7 * h;                 // upper body shoved harder => tips over
                node.prev.copy(node.p)
                    .addScaledVector(horiz, -dt0 * hScale)
                    .addScaledVector(_v.set(0, 1, 0), -dt0 * up);
            }

            // RANDOMIZED LOCAL HIT. On top of the body-wide tipping shove, yank ONE random joint
            // (and its immediate neighbours, at falloff) hard along a jittered direction — so the
            // kill reads as a shot landing at a specific, different spot every time. This is what
            // makes successive deaths spin/fold uniquely instead of all crumpling the same way.
            this._applyLocalHit(impulse, dt0);
        }

        // Twist seed: give the whole corpse an angular velocity about the vertical axis through its
        // centre, so it ROTATES as it falls (each death spins a different way/amount).
        if(twist){
            let cx = 0, cz = 0;
            for(const node of this.nodes){ cx += node.p.x; cz += node.p.z; }
            cx /= this.nodes.length; cz /= this.nodes.length;
            for(const node of this.nodes){
                const rx = node.p.x - cx, rz = node.p.z - cz;
                node.prev.x -= twist * rz * dt0;             // prev = p - V*dt0, V = twist*(r.z,0,-r.x)
                node.prev.z += twist * rx * dt0;
            }
        }
    }

    // Pick a random joint and drive it (plus its parent/children/grandparent, at falloff) with a
    // strong jittered impulse, so the death impulse originates from a DIFFERENT body location each
    // time. Direction is the knock-back blended with a random unit vector + a little lift; strength
    // is randomized. Anti-repeat (_lastHitIndex) guarantees the bone differs from the previous death.
    _applyLocalHit(impulse, dt0){
        const n = this.nodes.length;
        let idx = Math.floor(Math.random() * n);
        if(n > 1 && idx === _lastHitIndex){ idx = (idx + 1 + Math.floor(Math.random() * (n - 1))) % n; }
        _lastHitIndex = idx;
        const hit = this.nodes[idx];

        // Hit direction: mostly the knock-back direction, partly random, with a touch of lift, so the
        // local yank tumbles the body unpredictably about the impact point.
        const base = _v.copy(impulse).setY(0);
        if(base.lengthSq() < 1e-4){ base.set(0, 0, 1); }
        base.normalize();
        const rnd = _v2.set(Math.random() * 2 - 1, Math.random() * 0.6, Math.random() * 2 - 1);
        if(rnd.lengthSq() < 1e-4){ rnd.set(0, 1, 0); }
        rnd.normalize();
        const dir = base.multiplyScalar(0.6).addScaledVector(rnd, 0.55).add(_v2.set(0, 0.35, 0));
        if(dir.lengthSq() < 1e-6){ dir.set(0, 1, 0); }
        dir.normalize();

        const strength = 1.6 * (0.7 + Math.random() * 0.9);   // ~1.1 .. 2.6 m/s at the impact joint (restrained)

        const push = (node, scale) => {
            if(!node){ return; }
            node.prev.addScaledVector(dir, -dt0 * strength * scale);
        };
        push(hit, 1.0);
        push(hit.parent, 0.5);
        push(hit.grand, 0.25);
        if(hit.children){ for(const c of hit.children){ push(c, 0.5); } }
    }

    update(dt){
        if(!this.nodes || this._asleep || this._frozen){ return; }   // rested/frozen corpse: nothing to simulate
        this._age += dt;
        // Remember where each particle began this frame so the wall sweep can test the FULL frame
        // motion (catching fast-moving limbs that would otherwise tunnel through a thin wall), and so
        // settle detection can measure true frame displacement (not the within-substep gravity jitter).
        for(const node of this.nodes){ node.frameStart.copy(node.p); }

        const sub = Math.max(1e-3, Math.min(1 / 30, dt)) / this.substeps;
        for(let s = 0; s < this.substeps; s++){ this._step(sub); }

        // Resolve collisions against the real level once per frame (walls + floor, with bounce). The
        // floor collision flags a forceful impact; we count it into the ground-hit / freeze logic.
        this._hitGroundThisFrame = false;
        if(this.physicsWorld){ this._collideWorld(); }
        else { this._collideFlat(); }   // no world handle: fall back to the flat groundY plane
        if(this._hitGroundThisFrame){ this._registerGroundHit(); }

        // Count down the impact-freeze timer (armed by ground hits); freeze when it elapses so the body
        // stops jittering. Runs WHILE the sim continues, so the last ~0.5 s still settles before the freeze.
        if(this._freezeTimer >= 0){
            this._freezeTimer -= dt;
            if(this._freezeTimer <= 0){ this._frozen = true; this._freezeTimer = -1; }
        }

        this._applyToBones();

        // Settle detection on the body CENTROID. Once it stops translating for sleepDwell, the corpse
        // has come to rest — stop simulating to bound the per-corpse cost (a squad wipe can leave
        // several corpses on the floor, each otherwise paying ~24-32 Ammo queries/frame forever).
        let cx = 0, cy = 0, cz = 0;
        for(const node of this.nodes){ cx += node.p.x; cy += node.p.y; cz += node.p.z; }
        const inv = 1 / this.nodes.length;
        cx *= inv; cy *= inv; cz *= inv;
        if(this._haveCentroid){
            const dx = cx - this._lastCentroid.x, dy = cy - this._lastCentroid.y, dz = cz - this._lastCentroid.z;
            if(dx * dx + dy * dy + dz * dz < this.sleepCentroidSq){
                this._stillTime += dt;
                // Settle is reached at sleepDwell; keep simulating through the post-settle LINGER and
                // only sleep once the body has been continuously still for the whole window.
                if(this._stillTime >= this.sleepDwell + this.postSettleLinger){ this._asleep = true; }
            }else{
                this._stillTime = 0;
            }
        }
        this._lastCentroid.set(cx, cy, cz);
        this._haveCentroid = true;
    }

    _step(dt){
        const g = this.gravity * dt * dt;
        for(const node of this.nodes){
            // Verlet integration with drag.
            _v.copy(node.p).sub(node.prev).multiplyScalar(this.damping);
            node.prev.copy(node.p);
            node.p.add(_v);
            node.p.y += g;
        }
        // Relax constraints: limb sticks (hard length), braces (gentle bend stiffness), then the
        // joint-span LIMITS (only act at the fold/straight extremes). All are symmetric distance
        // projections (move both endpoints), so none injects energy — the corpse still settles + sleeps.
        for(let it = 0; it < this.iterations; it++){
            for(const st of this.sticks){
                _v.copy(st.b.p).sub(st.a.p);
                const d = _v.length();
                if(d < 1e-5){ continue; }
                const diff = ((d - st.len) / d) * 0.5 * st.k;
                _v.multiplyScalar(diff);
                st.a.p.add(_v);
                st.b.p.sub(_v);
            }
            // One-sided joint-span limits: pull together only when over-extended, push apart only when
            // over-folded. Inside the band they do nothing (the limb is free to flop), so this is a
            // pure JOINT LIMIT, not a pose spring — it stops impossible poses without holding a stance.
            for(const ls of this.limitSticks){
                _v.copy(ls.b.p).sub(ls.a.p);
                const d = _v.length();
                if(d < 1e-5){ continue; }
                let target = 0;
                if(d > ls.max){ target = ls.max; }
                else if(d < ls.min){ target = ls.min; }
                else{ continue; }
                const diff = ((d - target) / d) * 0.5 * ls.k;
                _v.multiplyScalar(diff);
                ls.a.p.add(_v);
                ls.b.p.sub(_v);
            }
        }

        // Gentle T-pose "muscle tone": ONCE per step (not per relaxation iteration, so it stays soft
        // regardless of the iteration count), nudge each joint span toward its bind-pose angle. This is
        // the "resistance" that biases the body toward natural angles and helps unfold a joint driven
        // the wrong way — but it's weak (jointRestStiffness) so gravity + the death impulse still topple
        // the corpse and it settles freely; it just prefers possible poses over impossible ones.
        // Symmetric projection, so (like every other constraint here) it injects no energy.
        if(this.jointRestStiffness > 0){
            for(const ls of this.limitSticks){
                if(ls.rest === null){ continue; }
                _v.copy(ls.b.p).sub(ls.a.p);
                const d = _v.length();
                if(d < 1e-5){ continue; }
                const diff = ((d - ls.rest) / d) * 0.5 * ls.restK;
                _v.multiplyScalar(diff);
                ls.a.p.add(_v);
                ls.b.p.sub(_v);
            }
        }
    }

    // Reflect a particle off a contact plane (unit normal n, pointing OUT of the surface) given the
    // INCOMING velocity vIn captured BEFORE the position was corrected: bounce the into-surface
    // component by restitution, keep tangentKeep of the along-surface component so it slides/rolls.
    // node.p must already be at the corrected (non-penetrating) position; this only rewrites prev so
    // the new verlet velocity (p - prev) is the reflected one. (Capturing vIn before the position
    // clamp is essential — clamping first would flip the normal velocity and suppress the bounce.)
    _reflect(node, n, vIn){
        const vn = vIn.dot(n);
        if(vn >= 0){
            // Not moving into the surface (e.g. resting / sliding along): keep the velocity, just
            // reseat prev relative to the corrected position.
            node.prev.copy(node.p).sub(vIn);
            return;
        }
        // Resting contact: at low into-surface speed drop restitution so the body settles to rest
        // rather than micro-bouncing forever; fast impacts keep the full bounce.
        const e = (-vn < this.restThreshold) ? 0 : this.restitution;
        // v' = (vIn - vn*n)*tangentKeep  +  (-vn*e)*n     (vn<0 => the added normal is +n)
        this._tmp.copy(vIn).addScaledVector(n, -vn).multiplyScalar(this.tangentKeep);  // tangential * keep
        this._tmp.addScaledVector(n, -vn * e);                                         // + bounced normal
        node.prev.copy(node.p).sub(this._tmp);
    }

    // Collide every particle with the real static level: a SPHERE-SWEEP for walls/props along the
    // frame's motion, and a DOWN-RAY for the floor (so the body rides slopes/steps and piles on
    // props). Bounces on contact. Runs once per frame (after the verlet substeps).
    _collideWorld(){
        const r = this.worldCollideRadius;
        for(const node of this.nodes){
            // --- Walls / props: sweep the body sphere from where the particle was this frame to
            // where it is now; on a hit, stop it at the contact and bounce off the surface normal.
            _v.copy(node.p).sub(node.frameStart);
            if(_v.lengthSq() > 1e-6 && AmmoHelper.SphereSweep(
                this.physicsWorld, r, node.frameStart, node.p, this._sweepRes, this._mask)
                && this._sweepRes.fraction < 1){
                this._n.copy(this._sweepRes.normal);
                // Bullet reports m_hitPointWorld as the contact ON the surface (not the sphere centre),
                // so the particle centre must sit a FULL radius + a small skin off it — otherwise the
                // sphere stays embedded ~r deep and next frame's sweep starts inside the wall (which
                // returns a degenerate result and can fling the corpse up). A degenerate/zero normal
                // (grazing edge / penetrating start) is skipped this frame rather than faked to up.
                if(this._n.lengthSq() > 1e-6){
                    this._n.normalize();
                    this._vel.copy(node.p).sub(node.prev);    // incoming velocity (before correcting p)
                    node.p.copy(this._sweepRes.point).addScaledVector(this._n, r + 0.02);
                    this._reflect(node, this._n, this._vel);
                }
            }

            // --- Floor: find the ground directly under the particle and keep it above it. A down-ray
            // handles slopes / steps / prop tops; falls back to the flat death-plane if it misses.
            _v.copy(node.p); _v.y += 0.5;                 // start the ray above the joint
            _v2.copy(node.p); _v2.y -= 4.0;               // ...and probe well below it
            let floorY = this.groundY;
            const hitInfo = { intersectionPoint: this._rayPt };
            if(AmmoHelper.CastRay(this.physicsWorld, _v, _v2, hitInfo, this._mask)){
                floorY = this._rayPt.y;
            }
            const minY = floorY + r;
            if(node.p.y < minY){
                this._vel.copy(node.p).sub(node.prev);    // capture the downward velocity FIRST
                if(-this._vel.y > this.impactDisp){ this._hitGroundThisFrame = true; }   // a real floor impact
                node.p.y = minY;                          // then rest the particle on the floor
                this._reflect(node, this._n.set(0, 1, 0), this._vel);
            }
        }
    }

    // Fallback floor when no physics world is available: a flat plane at groundY with a bounce.
    _collideFlat(){
        const floor = this.groundY + this.particleRadius;
        for(const node of this.nodes){
            if(node.p.y < floor){
                this._vel.copy(node.p).sub(node.prev);
                if(-this._vel.y > this.impactDisp){ this._hitGroundThisFrame = true; }
                node.p.y = floor;
                this._reflect(node, this._n.set(0, 1, 0), this._vel);
            }
        }
    }

    // Count a distinct ground impact (debounced) and arm the freeze. 1st hit: KICK the body back up —
    // amplify each particle's upward (rebound) velocity by landingBounce so the corpse springs off the
    // floor with a visible bounce — and arm a fallback freeze in case it never bounces for a clean 2nd
    // hit. 2nd hit: freeze the sim 0.5 s later, killing any residual jitter. Applies to every ragdoll.
    _registerGroundHit(){
        if(this._lastGroundHitAge >= 0 && (this._age - this._lastGroundHitAge) < this.groundHitDebounce){ return; }
        this._lastGroundHitAge = this._age;
        this._groundHits++;
        if(this._groundHits === 1){
            for(const node of this.nodes){
                _v.copy(node.p).sub(node.prev);                 // post-reflect velocity (contacts now point UP)
                if(_v.y > 0){ _v.y *= this.landingBounce; }      // amplify only the rebound => springs up
                node.prev.copy(node.p).sub(_v);
            }
            this._freezeTimer = this.firstHitFreeze;
        }else if(this._groundHits === 2){
            this._freezeTimer = this.secondHitFreeze;
        }
    }

    // Map the simulated joints back onto the real bones: the root bone takes its world
    // POSITION from its particle (so the body lies where it fell), and every bone takes
    // its world ORIENTATION by rotating its rest pose so its limb axis points along the
    // live direction to its primary child. Processed root → leaf so each bone reads its
    // parent's freshly-updated world transform (matches the reference's top-down walk).
    _applyToBones(){
        for(const node of this.order){
            const bone = node.bone;

            // Root position from physics (children keep their rest offsets, like the ref).
            if(node === this.root){
                _v.copy(node.p);
                if(bone.parent){ bone.parent.worldToLocal(_v); }
                bone.position.copy(_v);
            }

            // Orientation: only bones that have a primary child get re-aimed; leaves keep
            // their rest local rotation and simply ride their parent.
            if(node.primaryChild && node.restDir){
                _liveDir.copy(node.primaryChild.p).sub(node.p);
                if(_liveDir.lengthSq() > 1e-8){
                    _liveDir.normalize();
                    _restDir.copy(node.restDir);
                    _q.setFromUnitVectors(_restDir, _liveDir);     // rest-axis -> live-axis (world delta)
                    _q.multiply(node.restWorldQuat);               // target world orientation
                    if(bone.parent){
                        bone.parent.getWorldQuaternion(_q2).invert();
                        bone.quaternion.copy(_q2).multiply(_q);
                    }else{
                        bone.quaternion.copy(_q);
                    }
                }
            }

            bone.updateWorldMatrix(false, false);
        }
    }

    dispose(){
        this.nodes = null;
        this.sticks = null;
    }
}

import * as THREE from 'three'
import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'
import UeSoldierFSM from './UeSoldierFSM.js'
import { buildUeMannequin, collectUpperBoneNames, splitClipByBones } from '../Common/UeMannequin.js'
import { installProximityDitherOnObject } from '../Common/CameraDither.js'
import WeaponAimIK from '../Player/WeaponAimIK.js'
import FootIK from '../Player/FootIK.js'
import Ragdoll from './Ragdoll.js'
import DroppedWeapon from './DroppedWeapon.js'
import HurtFlinch from '../Common/HurtFlinch.js'
import { Faction, isHostile, isPriorityThreat, isHuman } from './Factions.js'


// A velocity-driven UE Mannequin enemy ("soldier"). It shares the player's rig,
// textures and AK, but is AI-driven. The defining contrast with the mutant's
// CharacterController is locomotion: the mutant is moved by *root motion* baked
// into its clips, whereas this soldier is moved by an explicit *velocity* each
// frame (path-follow at a target speed, clamped to the navmesh) and then chooses
// idle / walk / run purely from how fast it actually moved — the animation follows
// the velocity, not the other way around. Behaviour (idle/patrol/chase/attack/
// dead) lives in UeSoldierFSM; this class owns the body, movement and animation.
export default class UeSoldierController extends Component{
    constructor(model, clips, scene, physicsWorld, textures = null, weapon = null, preOriented = false, shotBuffer = null, audioListener = null, faction = Faction.ENEMY){
        super();
        this.name = 'UeSoldierController';
        this.model = model;
        this.clips = clips;
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.textures = textures;
        this.weapon = weapon;
        this.preOriented = preOriented;   // true => Y-up, metre-scaled GLB with baked PBR
        this.shotBuffer = shotBuffer;     // optional AK shot AudioBuffer for ranged fire
        this.audioListener = audioListener;

        // Movement intent set by the FSM, realised by Locomote each frame.
        this.walkSpeed = 2.2;      // patrol m/s
        this.runSpeed = 4.6;       // chase m/s
        this.desiredSpeed = 0.0;
        this.currentSpeed = 0.0;   // smoothed actual speed -> drives the anim choice
        this.canMove = true;

        // idle/shoot play at a fixed rate; the directional jogs (jogF/B/L/R) are FOOT-SYNCED to the
        // measured ground speed (see LocoTimeScale) so the feet match the floor instead of skating.
        // The jog bakes a foot speed of authoredJogSpeed m/s at timeScale 1.0 (same source clips as
        // the player). Below moveAnimThreshold (set above) the legs play idle.
        this.animTimeScale = { idle: 1.0, shoot: 1.4 };
        this.authoredJogSpeed = 5.884628;                     // m/s baked into the jog at timeScale 1.0
        this.invAuthoredJogSpeed = 1 / this.authoredJogSpeed; // per-(m/s) timeScale factor
        // This soldier patrols (2.2 m/s) and chases (4.6) BELOW the authored jog speed, so a pure
        // foot-sync (rate = measuredSpeed / authoredJogSpeed) plays the legs at 0.35..0.8x — and when
        // the measured speed COLLAPSES (navmesh clamping, grinding on a wall / another body, the accel
        // ramp from a stop) it floors out into a visible SLOW-MOTION crawl. That was the "some AI are
        // in slow motion sometimes" bug. Fix: a higher floor AND drive the cadence off the COMMANDED
        // speed (LocoTimeScale), so an impeded soldier still cycles its legs at a believable pace
        // instead of crawling. A little foot-skate at low ground speed reads far better than slow-mo.
        this.locoTimeScaleMin = 0.7;   // match the player's floor — never a slow-mo crawl
        this.locoTimeScaleMax = 2.2;

        // ---- Two-layer animation (so the soldier can RUN-AND-GUN: fire while strafing) ----
        // Like the player body, the rig is split into a LOWER half (pelvis + legs) and an UPPER half
        // (spine + arms + head) on one mixer. The legs play DIRECTIONAL locomotion (idle + jogF/B/L/R)
        // so the soldier can strafe sideways/back while FACING the target without moonwalking; the
        // torso mirrors that locomotion until it's firing, when a shoot OVERLAY takes the upper layer
        // alone — letting the gun fire on-target while the legs keep strafing.
        this.lowerActions = {};    // idle/jogF/jogB/jogL/jogR  (legs)
        this.upperActions = {};    // idle/jogF/jogB/jogL/jogR + shoot  (torso/arms)
        this.lowerState = null;    // current leg locomotion
        this.upperState = null;    // current torso locomotion (when not firing)
        this.firing = false;       // true => the shoot overlay owns the upper layer
        this.moveAnimThreshold = 0.4;   // below this measured speed the legs play idle (else a jog)
        this.moveLocalFwd = 0;     // last move direction in the body's local frame (+fwd / +right) ...
        this.moveLocalRight = 0;   // ... drives the directional jog choice (set in Locomote)

        // Combat movement: while engaging, the soldier FACES the target and STRAFES around it (a
        // flank/advance/retreat juke per its style) instead of planting — so it's a moving target.
        this.combatFacing = false;      // when true, Locomote aims facingYaw at the target, not the move dir
        this.faceVec = new THREE.Vector3();   // scratch: direction to the target for combat facing

        // ---- Combat aim (always point the gun at the target) ----
        // While engaged the soldier doesn't just animate a generic fire pose facing forward — it
        // VISIBLY aims its rifle at whoever it's shooting, exactly like the player does: a gross
        // additive SPINE lean toward the target's elevation, then a fine WeaponAimIK pass that rotates
        // the in-hand gun so the barrel points at the target and IKs the support hand back onto the
        // foregrip. Combined with combatFacing (turning the body) + the directional STRAFE jogs, the
        // soldier stays trained on the player while it strafes/advances. Eased in only while engaged.
        this.weaponAimIK = null;        // built in Initialize (needs the rig + in-hand weaponPivot)
        this.aimBones = [];             // [{bone, weight}] spine chain for the additive elevation lean
        this.aimVec = new THREE.Vector3();      // scratch: world aim point (target torso)
        this._aimChest = new THREE.Vector3();   // scratch: the gun-hand world position (lean reference)
        this.aimSpineLerp = 8;          // ease rate (1/s) blending the lean + IK in/out with engagement
        this.aimSpinePitchGain = 1.0;   // fraction of the target elevation fed to the spine lean
        this.aimSpinePitchSign = -1;    // rig sign: target ABOVE => gun up (flip if the lean inverts)
        this.aimSpinePitchMax = THREE.MathUtils.degToRad(45);   // clamp so a steep target can't fold the torso
        this._aimSpineWeight = 0;       // eased 0..1 engagement blend
        this._aimSpinePitch = 0;        // low-passed lean angle (rad)
        this._aimRight = new THREE.Vector3();   // scratch: character right axis (lean rotation axis)
        this._aimR = new THREE.Quaternion();
        this._aimPW = new THREE.Quaternion();
        this._aimPWInv = new THREE.Quaternion();
        this._aimDelta = new THREE.Quaternion();

        // Navigation.
        this.path = [];
        this.navGroup = null;
        this.navNode = null;
        this.waypointRadius = 0.6;

        // Stuck detection & recovery. While the soldier should be travelling (chase/patrol)
        // but stops making progress, it first re-evaluates its path; if it is STILL wedged a
        // couple seconds later it does a small, subtle teleport onto a nearby navmesh node and
        // reorients — so it can never sit jammed in one spot forever (see UpdateStuckRecovery).
        this.stuckSamplePos = new THREE.Vector3();
        this.lastGoodPos = new THREE.Vector3();  // last spot we were provably moving on the navmesh
        this.stuckSampleInterval = 0.5;          // how often progress is sampled (s)
        this._stuckSampleAccum = 0.0;
        this.stuckTimer = 0.0;                   // time accumulated with no real progress (s)
        this.stuckRepathTime = 2.5;              // no progress this long => force a repath
        this.stuckTeleportTime = 4.5;            // ...still stuck this long => subtle teleport
        this.minProgressSq = 0.18 * 0.18;        // min metres² moved per sample to count as progress
        this._didRepath = false;

        // Perception / combat. This soldier is a RANGED gunner: he holds an AK and
        // shoots the player from a distance (hitscan) rather than closing to melee.
        // Awareness has TWO ways to notice the player (both still require line of sight):
        //   1) a wide forward view CONE, and
        //   2) a close PROXIMITY sense that fires regardless of facing — so a visible player
        //      who walks up beside/behind the soldier is noticed instead of being ignored.
        // Sharper perception so the soldier engages almost the instant you're in view: a wide cone,
        // a generous all-round proximity sense, and a longer sight line. Acquisition is otherwise
        // immediate (the FSM checks every tick), so "reduce reaction delays" is mostly about the
        // short attack wind-up (see UeSoldierFSM) and these wider envelopes.
        this.viewAngle = Math.cos(Math.PI * 0.42);  // ~150° field of view (was 120°)
        this.proximitySenseRadius = 15.0;           // sense a visible target within this radius, any facing
        this.proximitySenseSq = this.proximitySenseRadius * this.proximitySenseRadius;
        this.maxViewDistance = 28.0 * 28.0;         // longer sight line so it can fight at range

        // ---- Alertness (heightened awareness after a stimulus) ----
        // The complaint was "I'm right next to them / I'm shooting them and they take ages to react."
        // Fix: any stimulus — taking a hit, HEARING the player's gunfire (even a miss), or an ally
        // calling out a contact — opens an ALERT WINDOW during which this soldier perceives much more
        // sharply (a wider, longer, all-round sense) and snaps toward the threat. So the moment you
        // make noise near a soldier it whips around and engages instead of obliviously patrolling.
        this.alertTimer = 0.0;                         // seconds of heightened awareness remaining
        this.alertDuration = 6.0;                      // how long a stimulus keeps the soldier on edge
        this.alertViewAngle = Math.cos(Math.PI * 0.6); // ~216° (near all-round) while alert
        this.alertProximityRadius = 22.0;              // bigger all-round sense while alert
        this.alertProximitySq = this.alertProximityRadius * this.alertProximityRadius;
        this.alertViewDistanceSq = 34.0 * 34.0;        // longer sight line while alert
        // Hearing: the player's gunfire is loud. A shot anywhere within hearingRadius rouses the
        // soldier (sets a contact at the player and goes alert); within the tighter engageHearingRadius
        // it engages immediately, otherwise it moves to investigate. This is what makes shooting AT a
        // soldier — hit OR miss — get an instant reaction.
        this.hearingRadius = 32.0;
        this.hearingRadiusSq = this.hearingRadius * this.hearingRadius;
        this.engageHearingRadius = 20.0;
        this.engageHearingRadiusSq = this.engageHearingRadius * this.engageHearingRadius;
        // Squad call-outs: when this soldier first gets a contact it shares the threat's position with
        // nearby allies (within this radius) so the whole squad turns and converges, instead of each
        // man noticing you one at a time. Edge-triggered by _hadContact so it fires once per fresh sighting.
        this.allyCalloutRadius = 24.0;
        this.allyCalloutRadiusSq = this.allyCalloutRadius * this.allyCalloutRadius;
        this._hadContact = false;
        // Long-range gunner: it engages from far off (shootRange) and HOLDS its distance
        // (preferredRange, see PickCombatPosition) instead of crowding the player. Raised from 18 m.
        this.shootRange = 22.0;        // start shooting once this close (with line of sight)
        this.shootRangeSq = this.shootRange * this.shootRange;
        // Tuned so a gunner reads as genuinely dangerous (≈9.4 DPS in clear LOS, ~10s solo TTK on a
        // 100 HP player, far less as a squad) without being a hitscan wall — still survivable with
        // cover + the dodge roll. The attack<->reposition duty cycle reduces effective DPS further.
        this.fireInterval = 0.7;       // seconds between shots
        this.shotDamage = 12;          // damage dealt to the target per landed shot
        this.hitChance = 0.55;         // chance a shot with clear LOS actually lands (while planted)
        this.movingHitFactor = 0.6;    // accuracy multiplier when firing on the move (run-and-gun)
        this.attackDuration = 1.0;     // legacy cadence field (unused by ranged FSM)

        // ---- Per-soldier combat STYLE (variety) ----
        // Randomized once per instance so no two soldiers fight the same way and the squad never
        // moves in lockstep. aggression biases pushing-in vs holding-back; the rest jitter the
        // repositioning cadence, preferred engagement range and flank direction. Read by the FSM's
        // combat states (reposition / attack) and PickCombatPosition.
        this.aggression = Math.random();                       // 0 = cautious (kites), 1 = aggressive (pushes)
        // LONG-range hold distance (was 6.5..13): the gunner keeps well back and never closes to
        // brawling range — aggressive ones sit a touch nearer (11 m), cautious ones farther (18 m).
        this.preferredRange = THREE.MathUtils.lerp(18.0, 11.0, this.aggression);  // closer when aggressive
        this.repositionInterval = 1.6 + Math.random() * 2.4;   // ~1.6 .. 4.0 s of firing before relocating
        this.combatMoveSpeed = THREE.MathUtils.lerp(3.4, 4.8, this.aggression);   // strafe/relocate speed
        this.flankSign = Math.random() < 0.5 ? -1 : 1;         // preferred lateral direction around the target
        this.holdGroundChance = 0.12;                          // chance a reposition just re-aims instead of moving (low: keep moving)
        // Lower than before so the player drops him in fewer bullets (player AK does
        // 2 dmg/shot => ~15 hits; previously 100 hp => ~50 hits).
        this.health = 30;

        // Facing: a smoothed yaw the body turns toward (movement dir or the target).
        this.facingYaw = 0.0;
        this.targetYaw = 0.0;
        // While engaging, turn to keep the gun on the target FAST (rad/s) so a circling/strafing
        // player stays covered — "always looking at the target when shooting and moving".
        this.combatFaceRate = 11.0;

        // ---- Non-combat lookout / scanning ----
        // Out of combat the soldier doesn't just stand or stare straight ahead — it actively SWEEPS its
        // view around to hunt for the player or the beast, so its forward view cone covers the area over
        // time and it reads as an alert sentry. The sweep centres on the last spot a threat was seen
        // (investigate that angle) or the current facing, picking a new look direction within scanArc,
        // turning to it deliberately, holding a beat, then choosing another. Driven by the FSM's idle
        // (and patrol-pause) states via UpdateScan; combat overrides facing entirely.
        this.scanTargetYaw = null;                  // current sweep look goal (rad), or null = pick one
        this.scanHoldTimer = 0.0;                   // time left holding the current look direction
        this.scanBaseYaw = 0.0;                     // heading the sweep is centred on
        this.scanArc = Math.PI * 0.6;               // sweep up to ±108° off the base heading
        this.scanTurnRate = 2.4;                    // rad/s turning between look directions (deliberate)

        // ---- Faction / relationships ----
        // Who this soldier is willing to attack is decided by faction hostility (see
        // Factions.js). `target` is the entity currently being hunted/shot — selected each
        // think-tick by AcquireTarget per the faction's priorities (an ENEMY always locks onto
        // the player on sight; a CHAOTIC takes the nearest of anyone).
        this.faction = faction;
        // How strongly the BEAST is prioritized over the player when both are visible: its distance is
        // scaled by this (treated as nearer than it really is). < 1 => the squad still rates the heavy
        // melee predator highly, but NOT absolutely — a clearly closer player wins (see AcquireTarget).
        this.beastThreatBias = 0.4;
        this.target = null;                       // current victim entity (player or another agent)
        this.provokedBy = null;                   // for NEUTRAL: retaliate against whoever hit it
        this.lastSeenPos = new THREE.Vector3();    // last spot the target was visible (chase memory)
        this.hasLastSeen = false;

        // Death.
        this.dead = false;
        this.ragdoll = null;        // verlet ragdoll built on death (drives the skeleton)
        this.droppedWeapon = null;  // the AK falls out of the hand on death (DroppedWeapon physics)
        // Corpse despawn: the ragdoll settles and lies for corpseLingerTime, then the whole entity is
        // DESTROYED (mesh, dropped rifle, hit volumes, sensors) — it simply disappears. No sink under
        // the floor (that read as the body melting through the ground); we just remove it once still.
        this.corpseLingerTime = 4.2;
        this._deathElapsed = 0.0;
        this._despawned = false;

        // Muzzle flash (built in Initialize): a brief warm point light + an additive
        // sprite-ish sphere parked at the gun barrel each shot, so the ranged fire
        // reads visually and lights up the surroundings.
        this.handBone = null;
        this.flashLight = null;
        this.flashMesh = null;
        this.flashTimer = 0.0;
        this.flashDuration = 0.06;
        this.shotSound = null;

        // Scratch (avoid per-frame allocation).
        this.forwardVec = new THREE.Vector3(0, 0, 1);
        this.upAxis = new THREE.Vector3(0, 1, 0);
        this.tempVec = new THREE.Vector3();
        this.tempVec2 = new THREE.Vector3();
        this.tempVec2b = new THREE.Vector3();
        this.desiredPos = new THREE.Vector3();
        this.clampTarget = new THREE.Vector3();
        this.facePos = new THREE.Vector3();
        this.muzzlePos = new THREE.Vector3();
        this.fireDir = new THREE.Vector3();
        this.senseVec = new THREE.Vector3();
        this.parentQuat = new THREE.Quaternion();
        this.combatA = new THREE.Vector3();   // scratch for combat-position LOS scoring
    }

    Initialize(){
        this.navmesh = this.FindEntity('Level').GetComponent('Navmesh');
        // Uneven terrain (optional): the soldier rides it — Y follows the terrain height under its (x,z)
        // each step (the navmesh only constrains x/z), so it walks the hills instead of floating on a plane.
        this.terrain = this.FindEntity('Level').GetComponent('Terrain') || null;
        this.hitbox = this.GetComponent('AttackTrigger');
        this.collision = this.GetComponent('UeSoldierCollision');
        this.player = this.FindEntity('Player');
        this.manager = this.parent.parent;   // EntityManager — used to enumerate other agents
        this.target = this.player;            // default target until AcquireTarget runs

        this.parent.RegisterEventHandler(this.TakeHit, 'hit');
        // Hearing: the player's weapon broadcasts a 'noise' to every entity each shot (WeaponManager).
        // We decide for ourselves whether it's within earshot — so a shot fired AT us, hit or miss,
        // rouses us instantly instead of only a LANDED hit doing so.
        this.parent.RegisterEventHandler(this.OnNoise, 'noise');
        this.blood = this.FindEntity('Level').GetComponent('BloodFx');   // shared blood-splatter burst
        this.bloodDecals = this.FindEntity('Level').GetComponent('BloodDecals');   // shared body blood decals

        // Build the shared UE avatar: import fix, textured material, AK in hand.
        const built = buildUeMannequin(this.model, { textures: this.textures, weapon: this.weapon, preOriented: this.preOriented });
        this.modelRoot = built.modelRoot;
        this.rootBone = built.rootBone;
        this.handBone = built.handBone;   // muzzle flash rides forward of the gun hand
        this.weaponPivot = built.weaponPivot;   // in-hand AK group; dropped + simulated on death
        this.skinnedmesh = built.meshes.find(m => m.isSkinnedMesh) || null;   // ragdoll skeleton source
        this.rootRef = this.rootBone ? {
            position: this.rootBone.position.clone(),
            quaternion: this.rootBone.quaternion.clone(),
            scale: this.rootBone.scale.clone(),
        } : null;

        // Feet sit on the navmesh at the spawn position. Snap onto the walkable navmesh AND relocate off
        // any spot buried in static collision (the level colliders are convex hulls, so a container is a
        // solid box the navmesh can still cover) so a soldier never starts inside a wall/prop/container.
        // A spawn that's already valid is left untouched.
        this.position = this.parent.Position.clone();
        this.navmesh.FindClearSpawn(this.position, this.physicsWorld, this.position);
        // Re-seat on the terrain at the (possibly relocated) clear spawn so the feet start on the ground.
        if(this.terrain){ this.position.y = this.terrain.HeightAt(this.position.x, this.position.z); }
        this.parent.SetPosition(this.position);   // keep entity targeting consistent with the snap
        this.modelRoot.position.copy(this.position);
        this.stuckSamplePos.copy(this.position);
        this.lastGoodPos.copy(this.position);

        this.mixer = new THREE.AnimationMixer(this.model);
        this.SetupAnimations();

        // Hurt feedback: additive upper-body flinch (torso recoil + head twitch) layered on the pose
        // when shot — reads even while the soldier is strafing and firing (the shoot overlay owns the
        // upper layer; this composes additively on top). Triggered (scaled by damage) in TakeHit.
        this.hurtFlinch = new HurtFlinch(this.model);

        // Cache the navmesh group/node we start on so movement can be clamped to it.
        this.navGroup = this.navmesh.GetGroup(this.position);
        if(this.navGroup !== null){
            this.navNode = this.navmesh.GetClosestNode(this.position, this.navGroup);
        }

        this.scene.add(this.modelRoot);

        // The TPS camera passes straight through enemies (it only collides with static
        // geometry), so dither-dissolve this soldier's body + gun when the lens clips into
        // it — far more elegant than seeing the inside of the mesh (the general close-mesh
        // rule). Materials are already per-instance clones (buildUeMannequin), so this only
        // affects this soldier.
        installProximityDitherOnObject(this.modelRoot, { near: 0.35, far: 1.0 });

        // Combat aim: spine chain (root->tip) for the additive elevation lean, plus the in-hand
        // weapon barrel + support-hand IK (same solver the player uses). Driven each frame by
        // UpdateCombatAim while the soldier is engaged, so the rifle visibly tracks the target.
        const spineWeights = { spine_01: 0.30, spine_02: 0.35, spine_03: 0.35 };
        this.model.traverse(o => { if(o.isBone && spineWeights[o.name]){ this.aimBones.push({ bone: o, weight: spineWeights[o.name] }); } });
        if(this.weaponPivot){ this.weaponAimIK = new WeaponAimIK(this.model, this.weaponPivot); }

        // Procedural foot/terrain IK (same reusable solver the player uses). Conforms the soldier's feet
        // to the ground it walks; fades out with speed so the foot-synced jog isn't fought. No crouch.
        this.footIK = new FootIK(this.model, this.modelRoot, this.physicsWorld);

        this.SetupMuzzleFlash();

        this.stateMachine = new UeSoldierFSM(this);
        // Pose an idle rifle stance BEFORE the first Update (like PlayerBody does) so frame 1 is posed
        // with both hands on the gun. The weapon-grip IK captures its support-hand foregrip socket from
        // that first frame; without a posed frame it would capture the bind/T-pose and the always-on grip
        // IK would then fling the support arm into the air (the NPC "arm not attached to the gun" bug).
        this.SetLowerState('idle');
        this.SetUpperState('idle');
        this.stateMachine.SetState('patrol');   // enemies roam by default; only stop to scan briefly
    }

    SetupMuzzleFlash(){
        // Warm point light: cheap (no shadow) and reads as the gun lighting the room.
        this.flashLight = new THREE.PointLight(0xffd08a, 0.0, 7.0, 2.0);
        this.flashLight.castShadow = false;
        this.flashLight.visible = false;
        this.scene.add(this.flashLight);

        // Small additive blob at the muzzle so the flash is visible from afar.
        const geo = new THREE.SphereGeometry(0.08, 8, 8);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffe1a8, transparent: true, opacity: 1.0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this.flashMesh = new THREE.Mesh(geo, mat);
        this.flashMesh.visible = false;
        this.scene.add(this.flashMesh);

        // Positional shot audio (optional — guarded if no buffer/listener supplied).
        if(this.shotBuffer && this.audioListener){
            this.shotSound = new THREE.PositionalAudio(this.audioListener);
            this.shotSound.setBuffer(this.shotBuffer);
            this.shotSound.setRefDistance(8.0);
            this.shotSound.setVolume(0.7);
            this.modelRoot.add(this.shotSound);
        }
    }

    SetupAnimations(){
        // Split each clip into a LOWER (legs) and UPPER (torso/arms) half on the one mixer, so the
        // torso can fire while the legs strafe. Directional jogs (jogF/B/L/R) let the soldier move in
        // any direction while facing the target; idle covers standing. 'shoot' is an UPPER-only overlay.
        const upperBones = collectUpperBoneNames(this.model, 'spine_01');
        ['idle', 'jogF', 'jogB', 'jogL', 'jogR'].forEach(name => {
            const clip = this.clips[name];
            if(!clip){ return; }
            const { upper, lower } = splitClipByBones(clip, upperBones);
            this.lowerActions[name] = this.mixer.clipAction(lower);
            this.upperActions[name] = this.mixer.clipAction(upper);
        });
        const shootClip = this.clips['shoot'];
        if(shootClip){
            const { upper } = splitClipByBones(shootClip, upperBones);
            const a = this.mixer.clipAction(upper);
            a.setLoop(THREE.LoopRepeat);
            this.upperActions['shoot'] = a;
        }
    }

    // ---- Interface consumed by UeSoldierFSM ----
    SetMoveIntent(speed){ this.desiredSpeed = speed; this.canMove = speed > 0.0; }

    ClearPath(){ if(this.path){ this.path.length = 0; } }

    NavigateToRandomPoint(){
        const node = this.navmesh.GetRandomNode(this.position, 50);
        if(!node){ this.path = []; return; }
        this.path = this.navmesh.FindPath(this.position, node) || [];
    }

    // Path toward the current target (or its last-seen spot if it just slipped out of view).
    NavigateToTarget(){
        let dest = null;
        if(this.target && this.IsAlive(this.target)){ dest = this.target.Position; }
        else if(this.hasLastSeen){ dest = this.lastSeenPos; }
        if(!dest){ this.path = []; return; }
        this.tempVec.copy(dest);
        this.tempVec.y = 0.5;
        this.path = this.navmesh.FindPath(this.position, this.tempVec) || [];
    }

    // Path to the spot the target was LAST SEEN (used by the search behaviour after losing sight). Unlike
    // NavigateToTarget it ignores the live target (we've lost it) and heads straight for the memory.
    NavigateToLastSeen(){
        if(!this.hasLastSeen){ this.path = []; return; }
        this.tempVec.copy(this.lastSeenPos);
        this.tempVec.y = 0.5;
        this.path = this.navmesh.FindPath(this.position, this.tempVec) || [];
        return this.path.length > 0;
    }

    // Pick a walkable point a few metres AROUND the last-seen spot and path to it — the next "leg" of a
    // search sweep, so the soldier pokes around the area the player vanished into instead of standing on
    // the exact last-seen tile. Falls back to a point near the soldier itself if the memory tile is off
    // the mesh. Returns true if a usable path was found.
    NavigateNearLastSeen(radius = 6.0){
        let node = this.hasLastSeen ? this.navmesh.GetRandomNode(this.lastSeenPos, radius) : null;
        if(!node){ node = this.navmesh.GetRandomNode(this.position, radius); }
        if(!node){ this.path = []; return false; }
        this.tempVec.copy(node); this.tempVec.y = 0.5;
        this.path = this.navmesh.FindPath(this.position, this.tempVec) || [];
        return this.path.length > 0;
    }

    // ---- Tactical combat movement (cover / flank / reposition / push / retreat) ----
    // Choose a tactical destination for a reposition: a reachable navmesh node near the soldier that
    // (1) ideally has a clear line of sight to the target, (2) sits near this soldier's preferred
    // engagement range, (3) FLANKS — offsets laterally around the target on the soldier's preferred
    // side — and (4) advances (push) or retreats (kite) per its aggression. Pure scoring over a
    // handful of samples; returns a navmesh node (Vector3) or null.
    PickCombatPosition(target){
        if(!target || !target.Position){ return null; }
        const tx = target.Position.x, tz = target.Position.z;
        const sx = this.position.x, sz = this.position.z;
        // Soldier -> target axis (forward) and its left-normal (lateral).
        let fx = tx - sx, fz = tz - sz;
        const flen = Math.hypot(fx, fz) || 1; fx /= flen; fz /= flen;
        const lx = -fz, lz = fx;                            // left perpendicular
        // Hold the preferred LONG range: advance when too far, KITE OUT when too close, so the gunner
        // never crowds the player (the request: "don't let them come too close — long-range attack").
        // advanceBias multiplies `advance` (+1 toward the target); a small aggression term still lets
        // pushers sit a touch nearer and kiters a touch farther.
        const rangeError = flen - this.preferredRange;      // + => too far (push in), - => too close (back off)
        const advanceBias = THREE.MathUtils.clamp(rangeError / 6.0, -1, 1) + (this.aggression - 0.5) * 0.5;
        const minRange = this.preferredRange * 0.6;         // never voluntarily relocate inside this radius

        let best = null, bestScore = -Infinity;
        for(const range of [3.0, 5.0, 7.0]){
            for(let i = 0; i < 4; i++){
                const node = this.navmesh.GetRandomNode(this.position, range);
                if(!node){ continue; }
                const ndx = node.x - sx, ndz = node.z - sz;
                const nlen = Math.hypot(ndx, ndz);
                if(nlen < 0.8){ continue; }                 // must actually relocate
                const advance = (ndx * fx + ndz * fz) / nlen;     // +1 toward target, -1 away
                const lateral = (ndx * lx + ndz * lz) / nlen;     // +1 to the left
                const distT = Math.hypot(node.x - tx, node.z - tz);
                const rangeScore = 1.0 - Math.min(1.0, Math.abs(distT - this.preferredRange) / 8.0);
                const flankScore = lateral * this.flankSign;      // reward stepping to the preferred side
                const advanceScore = advance * advanceBias;       // push in or kite out to hold the range
                const tooClose = distT < minRange ? (minRange - distT) : 0;   // penalty for crowding the player
                const losScore = this.HasLineOfSightFrom(this.combatA.set(node.x, node.y, node.z), target) ? 1.0 : 0.0;
                // LOS dominates: a spot you can actually SHOOT from must always beat a slightly
                // better-ranged/flanked spot with no shot (else the soldier relocates somewhere it
                // can't fire and immediately drops back to chase — a visible "run then re-chase" wobble).
                // Flank is weighted high (with rangeScore holding the distance roughly constant) so the
                // chosen spots sit LATERAL to the target at the preferred range — the soldier reads as
                // CIRCLE-STRAFING around the player rather than relocating to scattered cover.
                const score = losScore * 3.0 + rangeScore * 1.3 + flankScore * 1.6 + advanceScore * 0.9 - tooClose * 0.7;
                if(score > bestScore){ bestScore = score; best = node; }
            }
        }
        return best;
    }

    // Path to a freshly-picked tactical position; returns true if a usable path was built.
    NavigateToCombatPosition(target){
        const node = this.PickCombatPosition(target);
        if(!node){ this.path = []; return false; }
        this.tempVec.copy(node); this.tempVec.y = 0.5;
        this.path = this.navmesh.FindPath(this.position, this.tempVec) || [];
        return this.path.length > 0;
    }

    // Line of sight from an ARBITRARY world position to an entity (used to score candidate combat
    // positions before committing to move there). Same first-hit-belongs-to-target test as
    // HasLineOfSightTo, but cast from `fromPos` instead of the soldier's current spot.
    HasLineOfSightFrom(fromPos, entity){
        if(!entity){ return false; }
        const eye = this.tempVec2.copy(fromPos); eye.y += 1.5;
        const aim = this.tempVec2b.copy(entity.Position);
        if(entity !== this.player){ aim.y += 1.0; }
        this.tempVec.copy(aim).sub(eye);
        const len = this.tempVec.length();
        if(len > 1e-3){ eye.addScaledVector(this.tempVec, Math.min(0.6, len * 0.5) / len); }   // clear our own spheres (not past the midpoint)
        const rayInfo = {};
        const mask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;
        if(AmmoHelper.CastRay(this.physicsWorld, eye, aim, rayInfo, mask)){
            const co = rayInfo.collisionObject;
            const ghost = Ammo.castObject(co, Ammo.btPairCachingGhostObject);
            const rb = Ammo.castObject(co, Ammo.btRigidBody);
            if(entity === this.player){ return rb == this.player.GetComponent('PlayerPhysics').body; }
            const ent = (ghost && ghost.parentEntity) || (rb && rb.parentEntity);
            return ent === entity;
        }
        return false;
    }

    // ---- Stuck detection & recovery ----
    // Re-evaluate the path: hunt the current target if we have one, otherwise resume patrol.
    RepathForRecovery(){
        const aware = (this.stateMachine?.currentState?.Name === 'chase') || this.AcquireTarget();
        if(aware && (this.target || this.hasLastSeen)){ this.NavigateToTarget(); }
        else{ this.NavigateToRandomPoint(); }
    }

    // ---- Faction / target acquisition ----
    // The faction of any entity in the world (PLAYER for you, the soldier's own faction for a
    // soldier, ENEMY for the melee beast). Returns null for entities that aren't combatants.
    FactionOf(entity){
        if(!entity){ return null; }
        if(entity === this.player){ return Faction.PLAYER; }
        const soldier = entity.GetComponent && entity.GetComponent('UeSoldierController');
        if(soldier){ return soldier.faction; }
        const beast = entity.GetComponent && entity.GetComponent('CharacterController');
        if(beast){ return Faction.BEAST; }   // the mutant — the apex threat everyone prioritises
        return null;
    }

    IsAlive(entity){
        if(!entity){ return false; }
        if(entity === this.player){ return true; }
        const soldier = entity.GetComponent('UeSoldierController');
        if(soldier){ return !soldier.dead; }
        const beast = entity.GetComponent('CharacterController');
        if(beast){ return !beast.dead; }
        return true;
    }

    // Pick the biggest IMMEDIATE threat among everyone this soldier can currently see, by threat-
    // weighted distance:
    //   * Normally the nearest visible hostile (the player or the beast).
    //   * The BEAST counts as NEARER than it is (beastThreatBias) so the squad still rates the heavy
    //     melee predator highly — but NOT with the old absolute "beast first" override that let a
    //     soldier ignore a player standing right next to it while a beast roamed across the map. A
    //     point-blank player now always wins over a distant beast, and a close beast over a far player.
    //   * NEUTRAL — passive: only whoever provoked it (and only while still visible).
    // Sets this.target (+ remembers its last-seen position), fires a one-shot squad call-out on a fresh
    // sighting, and returns true if a target was found.
    AcquireTarget(){
        if(this.faction === Faction.NEUTRAL){
            const ok = this.provokedBy && this.IsAlive(this.provokedBy) && this.CanSee(this.provokedBy);
            this._setTarget(ok ? this.provokedBy : null);
            this._noteContact(!!ok);
            return !!ok;
        }

        let chosen = null, bestScore = Infinity;
        for(const entity of this.manager.entities){
            if(entity === this.parent){ continue; }
            const f = this.FactionOf(entity);
            if(!f || !isHostile(this.faction, f)){ continue; }
            if(!this.IsAlive(entity) || !this.CanSee(entity)){ continue; }

            const distSq = this.tempVec.copy(entity.Position).sub(this.position).lengthSq();
            const score = isPriorityThreat(f) ? distSq * this.beastThreatBias : distSq;
            if(score < bestScore){ bestScore = score; chosen = entity; }
        }

        this._setTarget(chosen);
        this._noteContact(!!chosen);
        return !!chosen;
    }

    _setTarget(entity){
        this.target = entity;
        if(entity){ this.lastSeenPos.copy(entity.Position); this.hasLastSeen = true; }
    }

    // Edge-triggered on a FRESH sighting (no contact last tick, contact now): keep ourselves on edge
    // (refresh the alert window) and call out the threat's position to nearby allies so the squad
    // converges instead of each man noticing you one at a time. Resets when contact is lost so the next
    // sighting calls out again.
    _noteContact(hasContact){
        if(hasContact && !this._hadContact){
            this.alertTimer = this.alertDuration;
            if(this.target && this.target.Position){ this.AlertAllies(this.target.Position); }
        }
        this._hadContact = hasContact;
    }

    // React to a stimulus that reveals a threat at `pos`: refresh the contact memory, open the ALERT
    // window (boosted perception in CanSee), snap the body toward the threat for an instant read, and
    // kick the FSM into pursuit. `hard` engages immediately (got shot / close gunfire); a soft alert
    // INVESTIGATES (distant noise / an ally's call-out — head over and sweep, engaging on sight).
    // `fromDamage` lets a passive NEUTRAL rouse ONLY when actually hit (it ignores mere noise/sightings).
    Alert(pos, hard, fromDamage = false){
        if(this.dead){ return; }
        if(this.faction === Faction.NEUTRAL && !fromDamage){ return; }

        this.alertTimer = this.alertDuration;
        if(pos){
            this.lastSeenPos.copy(pos);
            this.hasLastSeen = true;
            // Instant orient: snap a chunk of the facing toward the threat THIS frame so the reaction
            // reads immediately (the rest eases in via normal turning) — a sharp "what was that?" turn.
            this.faceVec.copy(pos).sub(this.position); this.faceVec.y = 0.0;
            if(this.faceVec.lengthSq() > 1e-6){
                this.targetYaw = Math.atan2(this.faceVec.x, this.faceVec.z);
                this.facingYaw = this.StepYaw(this.facingYaw, this.targetYaw, 0.9);   // up to ~50° snap
            }
        }

        const cur = this.stateMachine.currentState;
        const state = cur && cur.Name;
        if(state === 'dead'){ return; }
        if(state === 'idle' || state === 'patrol'){
            this.stateMachine.SetState(hard ? 'chase' : 'search');
        }else if(state === 'search' && hard){
            this.stateMachine.SetState('chase');
        }else if(state === 'chase' && cur.OnProvoked){
            cur.OnProvoked();
        }
    }

    // Share a contact with nearby allied humans (a squad call-out) so they turn and converge on the
    // threat. Soft alert: they move to investigate the position and engage on sight, rather than
    // teleport-locking onto a target they can't see yet.
    AlertAllies(pos){
        if(!pos){ return; }
        for(const entity of this.manager.entities){
            if(entity === this.parent){ continue; }
            const ally = entity.GetComponent && entity.GetComponent('UeSoldierController');
            if(!ally || ally.dead || !isHuman(ally.faction)){ continue; }
            const d2 = this.tempVec.copy(entity.Position).sub(this.position).lengthSq();
            if(d2 > this.allyCalloutRadiusSq){ continue; }
            ally.Alert(pos, false, false);
        }
    }

    // Heard the player's gunfire (WeaponManager broadcasts a 'noise' to every entity on each shot — see
    // its NotifyNoise). We decide whether it's in earshot and how urgently to react: a close shot
    // engages now, a farther one investigates. This is what makes shooting AT a soldier — hit OR miss —
    // get an immediate reaction instead of only a LANDED hit rousing it.
    OnNoise = (msg) => {
        if(this.dead || !msg || !msg.position){ return; }
        // Only the player's gunfire spooks a soldier here; allies coordinate via the call-out instead.
        if(msg.source && msg.source !== this.player){ return; }
        const d2 = this.tempVec.copy(msg.position).sub(this.position).lengthSq();
        if(d2 > this.hearingRadiusSq){ return; }
        this.Alert(msg.position, d2 <= this.engageHearingRadiusSq, false);
    }

    // Last-resort: a small, subtle hop onto a nearby walkable navmesh node (or the last spot
    // we were provably on the mesh) + a snap-face toward the player, when the soldier can't
    // free itself by repathing. Short-range so it reads as "shuffling loose", not a blink.
    SubtleTeleport(){
        let dest = null;
        for(const range of [1.5, 2.5, 4.0]){
            const node = this.navmesh.GetRandomNode(this.position, range);
            if(node){ dest = node; break; }
        }
        // If we're off the mesh entirely (GetRandomNode needs a valid group), fall back to the
        // last position we were provably moving along it.
        if(!dest && this.lastGoodPos.lengthSq() > 0){ dest = this.lastGoodPos; }
        if(!dest){ return; }

        this.position.set(dest.x, this.position.y, dest.z);
        this.modelRoot.position.copy(this.position);
        // Re-acquire the navmesh group/node at the new spot so movement clamps correctly.
        this.navGroup = this.navmesh.GetGroup(this.position);
        this.navNode = this.navGroup !== null ? this.navmesh.GetClosestNode(this.position, this.navGroup) : null;
        // Snap-face the current target and rebuild the path so it resumes its goal immediately.
        const at = (this.target && this.target.Position) ? this.target.Position : this.player.Position;
        this.tempVec.copy(at).sub(this.position);
        this.tempVec.y = 0.0;
        if(this.tempVec.lengthSq() > 1e-6){
            this.facingYaw = Math.atan2(this.tempVec.x, this.tempVec.z);
            this.targetYaw = this.facingYaw;
        }
        this.stuckSamplePos.copy(this.position);
        this.RepathForRecovery();
    }

    // Per-frame: while the soldier should be travelling but isn't making progress, escalate
    // repath -> subtle teleport so it never wedges in one spot (see the constructor note).
    UpdateStuckRecovery(t){
        // Only meaningful while actively trying to travel (chase/patrol set canMove true;
        // idle/attack/dead set it false, where standing still is intended).
        if(this.dead || !this.canMove){
            this.stuckTimer = 0.0; this._stuckSampleAccum = 0.0; this._didRepath = false;
            this.stuckSamplePos.copy(this.position);
            return;
        }

        this._stuckSampleAccum += t;
        if(this._stuckSampleAccum < this.stuckSampleInterval){ return; }
        this._stuckSampleAccum = 0.0;

        const movedSq = this.stuckSamplePos.distanceToSquared(this.position);
        this.stuckSamplePos.copy(this.position);
        if(movedSq >= this.minProgressSq){
            // Making progress: remember this good spot and clear the stuck state.
            this.lastGoodPos.copy(this.position);
            this.stuckTimer = 0.0; this._didRepath = false;
            return;
        }

        this.stuckTimer += this.stuckSampleInterval;
        // Stage 1 (~2.5s): force a fresh path (attack the player or resume patrol).
        if(this.stuckTimer >= this.stuckRepathTime && !this._didRepath){
            this._didRepath = true;
            this.RepathForRecovery();
            return;
        }
        // Stage 2 (~4.5s): still wedged — subtle teleport + reorient.
        if(this.stuckTimer >= this.stuckTeleportTime){
            this.SubtleTeleport();
            this.stuckTimer = 0.0; this._didRepath = false;
        }
    }

    // Can the soldier see `entity` right now? Inside the forward view CONE, OR close enough to
    // sense regardless of facing (peripheral awareness), AND with a clear line of sight.
    CanSee(entity){
        if(!entity){ return false; }
        const eyePos = this.tempVec2.copy(this.position);
        eyePos.y += 1.6;                              // roughly the soldier's head
        const toT = this.senseVec.copy(entity.Position).sub(eyePos);

        // Heightened awareness while alerted (recently shot / heard gunfire / an ally called out): a
        // wider, longer, near-all-round sense, so a roused soldier spots you far more readily than a
        // calm one. Decays back to the calm envelope when the alert window lapses (see Update).
        const alert = this.alertTimer > 0;
        const maxView = alert ? this.alertViewDistanceSq : this.maxViewDistance;
        const proxSq = alert ? this.alertProximitySq : this.proximitySenseSq;
        const viewAng = alert ? this.alertViewAngle : this.viewAngle;

        const distSq = toT.lengthSq();
        if(distSq > maxView){ return false; }

        toT.normalize();
        const facing = this.forwardVec.set(Math.sin(this.facingYaw), 0, Math.cos(this.facingYaw));
        const inCone = toT.dot(facing) >= viewAng;
        const inProximity = distSq <= proxSq;
        if(!inCone && !inProximity){ return false; }

        return this.HasLineOfSightTo(entity);
    }

    // Within firing range of the current target (line-of-sight checked separately).
    InRangeOf(entity){
        if(!entity){ return false; }
        return this.tempVec.copy(entity.Position).sub(this.position).lengthSq() <= this.shootRangeSq;
    }

    // Clear shot to `entity`: cast from the soldier's eye toward it and confirm the first thing
    // the ray reaches belongs to that entity (not a wall / another body in between). AI bodies
    // carry `parentEntity` on their hit colliders; the player is the capsule rigid body.
    HasLineOfSightTo(entity){
        if(!entity){ return false; }
        const eyePos = this.tempVec2.copy(this.position);
        eyePos.y += 1.5;
        this.tempVec.copy(entity.Position).sub(eyePos);
        const len = this.tempVec.length();
        // Nudge the ray start forward to clear our own hit spheres — but never past the HALFWAY point to
        // the target, so at point-blank range the ray doesn't start *beyond* the target and miss it (the
        // "I'm right next to them and they don't react" case).
        if(len > 1e-3){ eyePos.addScaledVector(this.tempVec, Math.min(0.6, len * 0.5) / len); }
        const aim = this.tempVec2b.copy(entity.Position);
        if(entity !== this.player){ aim.y += 1.0; }                          // aim at a torso, not feet
        const rayInfo = {};
        const mask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;
        if(AmmoHelper.CastRay(this.physicsWorld, eyePos, aim, rayInfo, mask)){
            const co = rayInfo.collisionObject;
            // The owning entity is stamped on the collider — on a ghost trigger for AI hit
            // spheres, on the rigid body for walls/props. Read both, same as Weapon.Raycast.
            const ghost = Ammo.castObject(co, Ammo.btPairCachingGhostObject);
            const rb = Ammo.castObject(co, Ammo.btRigidBody);
            // The player is its capsule rigid body (no parentEntity), so match it directly.
            if(entity === this.player){
                return rb == this.player.GetComponent('PlayerPhysics').body;
            }
            const ent = (ghost && ghost.parentEntity) || (rb && rb.parentEntity);
            return ent === entity;
        }
        return false;
    }

    // Fire one round at the current target: flash + sound, and (with clear LOS) a chance to land
    // a hit that damages it. The 'hit' is broadcast to the target ENTITY, so it works the same
    // whether the victim is the player, another soldier, or the beast.
    FireAtTarget(){
        // Bail if the target just died (the retarget cadence can lag a frame behind a kill): otherwise
        // the soldier plays a muzzle flash / shot SFX at a fresh corpse. Damage is already LOS+roll
        // gated, but the flash/light/sound below are unconditional, so guard the whole shot here.
        if(this.dead || !this.target || !this.IsAlive(this.target)){ return; }

        // Park the flash just forward of the gun hand along the facing direction.
        this.fireDir.set(Math.sin(this.facingYaw), 0, Math.cos(this.facingYaw));
        if(this.handBone){ this.handBone.getWorldPosition(this.muzzlePos); }
        else{ this.muzzlePos.copy(this.position); this.muzzlePos.y += 1.4; }
        this.muzzlePos.addScaledVector(this.fireDir, 0.55);

        this.flashMesh.position.copy(this.muzzlePos);
        this.flashLight.position.copy(this.muzzlePos);
        this.flashMesh.visible = true;
        this.flashLight.visible = true;
        this.flashLight.intensity = 6.0;
        this.flashTimer = this.flashDuration;

        if(this.shotSound){
            this.shotSound.isPlaying && this.shotSound.stop();
            this.shotSound.play();
        }

        // The shot lands if there's a clear line and the accuracy roll succeeds. Firing ON THE MOVE
        // (strafing in combat) is less accurate — this keeps run-and-gun fair (and offsets the now
        // near-continuous fire) while rewarding a player who also keeps moving.
        const chance = this.currentSpeed > this.moveAnimThreshold ? this.hitChance * this.movingHitFactor : this.hitChance;
        if(this.HasLineOfSightTo(this.target) && Math.random() < chance){
            this.target.Broadcast({topic: 'hit', amount: this.shotDamage, from: this.parent});
        }
    }

    UpdateMuzzleFlash(t){
        if(this.flashTimer <= 0.0){ return; }
        this.flashTimer = Math.max(0.0, this.flashTimer - t);
        const k = this.flashTimer / this.flashDuration;
        this.flashLight.intensity = 6.0 * k;
        this.flashMesh.material.opacity = k;
        if(this.flashTimer <= 0.0){
            this.flashLight.visible = false;
            this.flashMesh.visible = false;
        }
    }

    // Out-of-combat LOOKOUT: sweep the view around to hunt for the player / beast. Centres the sweep
    // on the last spot a threat was seen (keep watching that angle), else the current facing; picks a
    // new look direction within scanArc, turns to it deliberately, holds a beat, then chooses another.
    // Turning the facing sweeps the forward view CONE, so this genuinely improves detection (CanSee
    // uses facingYaw) AND reads as an alert sentry rather than a soldier staring at a wall. Called by
    // the FSM's idle/lookout state; combat owns the facing instead (combatFacing).
    UpdateScan(t){
        // Base the sweep on the last-seen threat direction (investigate it) or, first time, the facing.
        if(this.hasLastSeen){
            this.faceVec.copy(this.lastSeenPos).sub(this.position); this.faceVec.y = 0.0;
            if(this.faceVec.lengthSq() > 1e-4){ this.scanBaseYaw = Math.atan2(this.faceVec.x, this.faceVec.z); }
        }else if(this.scanTargetYaw === null){
            this.scanBaseYaw = this.facingYaw;
        }
        this.scanHoldTimer -= t;
        if(this.scanTargetYaw === null || this.scanHoldTimer <= 0.0){
            this.scanTargetYaw = this.scanBaseYaw + (Math.random() * 2 - 1) * this.scanArc;
            this.scanHoldTimer = 0.6 + Math.random() * 1.1;   // hold each look a beat before sweeping on
        }
        this.facingYaw = this.StepYaw(this.facingYaw, this.scanTargetYaw, this.scanTurnRate * t);
    }

    // Turn to face the current target (falls back to the player if somehow unset).
    FaceTarget(t, rate = 6.0){
        const at = (this.target && this.target.Position) ? this.target.Position : this.player.Position;
        this.tempVec.copy(at).sub(this.position);
        this.tempVec.y = 0.0;
        if(this.tempVec.lengthSq() < 1e-6){ return; }
        this.targetYaw = Math.atan2(this.tempVec.x, this.tempVec.z);
        this.facingYaw = this.StepYaw(this.facingYaw, this.targetYaw, rate * t);
    }

    // Start firing: the shoot OVERLAY takes the UPPER layer (torso + gun) while the legs keep their
    // locomotion — so the soldier fires while strafing. Idempotent (continuous fire re-enters combat).
    BeginFire(){
        if(this.firing){ return; }
        this.firing = true;
        const action = this.upperActions['shoot'];
        if(!action){ return; }
        action.reset();
        action.setLoop(THREE.LoopRepeat);
        action.setEffectiveTimeScale(this.animTimeScale.shoot);
        action.play();
        // Make the shoot overlay the sole full-weight upper action (fades out the torso locomotion),
        // so the upper layer is never empty for a frame (no bind/T-pose flash).
        this.SetUpperPrimary(action, 0.12);
        this.upperState = 'shoot';
    }

    // Stop firing: hand the torso back to whatever locomotion the legs are doing.
    EndFire(){
        if(!this.firing){ return; }
        this.firing = false;
        this.upperState = 'shoot';                 // so PlayUpperLocomotion fades out of it
        this.PlayUpperLocomotion(this.DesiredLocoState(), 0.15);
    }

    Die(){
        if(this.dead){ return; }
        this.dead = true;
        this.firing = false;
        this.canMove = false;
        // Death is PURELY a physics ragdoll — no sink, no fade, no death clip. Stop the mixer
        // so the bones are handed entirely to physics, and disable the hit capsules so the
        // corpse stops absorbing fire.
        this.mixer.stopAllAction();
        this.collision && this.collision.Disable();
        // Kill any in-flight muzzle flash so the corpse doesn't keep glowing.
        this.flashTimer = 0.0;
        if(this.flashLight){ this.flashLight.visible = false; }
        if(this.flashMesh){ this.flashMesh.visible = false; }

        try{
            if(!this.skinnedmesh){ throw new Error('no skinned mesh'); }
            // Knock the corpse away from whoever KILLED it (provokedBy = last attacker), with
            // per-death RANDOM variation (shove DIRECTION ±~29°, STRENGTH, LIFT, plus a random TWIST
            // so the body spins as it falls) so no two soldier deaths look identical. Falls back to
            // the current target / player. Gravity + ground friction do the rest.
            const killer = (this.provokedBy && this.provokedBy.Position) ? this.provokedBy
                         : (this.target && this.target.Position) ? this.target : this.player;
            const fromPos = killer.Position;
            const dir = this.tempVec.copy(this.position).sub(fromPos);
            dir.y = 0;
            if(dir.lengthSq() < 1e-4){ dir.set(0, 0, 1); }
            dir.normalize();
            const yaw = (Math.random() - 0.5) * 1.0;            // spread the shove ±~29°
            const cy = Math.cos(yaw), sy = Math.sin(yaw);
            const mag = 1.5 * (0.7 + Math.random() * 0.7);      // ~1.0 .. 2.0 m/s horizontal (gentle, realistic knockback)
            const impulse = new THREE.Vector3(
                (dir.x * cy - dir.z * sy) * mag,
                1.0 * (0.8 + Math.random() * 0.7),              // lift ~0.8 .. 1.5 m/s (a small kick, not a launch)
                (dir.x * sy + dir.z * cy) * mag);
            const twist = (Math.random() - 0.5) * 3.5;          // ±1.75 rad/s spin while falling (calmer)
            this.ragdoll = new Ragdoll(this.skinnedmesh, {
                groundY: this.position.y,
                impulse,
                twist,
                physicsWorld: this.physicsWorld,   // collide the corpse with walls / floor / slopes / props
            });
        }catch(e){
            console.error('Soldier ragdoll failed to build:', e);
            this.ragdoll = null;
        }

        // Drop the weapon: a dying soldier lets go of his rifle. Detach it from the (now ragdolling)
        // hand into the scene at its current world transform and hand it to its own rigid-body
        // simulator so it tumbles, bounces and settles on the floor independently of the corpse. Tossed
        // out of the hand along the knockback with a touch of lift + a random spin so it spins away.
        this.DropWeapon();
    }

    // Detach the in-hand AK and start its physics. The gun keeps its on-screen size/orientation
    // (THREE.attach preserves the world transform) and then falls under DroppedWeapon. Guarded so a
    // failure leaves the gun parented to the ragdolling hand (harmless) instead of throwing.
    DropWeapon(){
        if(!this.weaponPivot || this.droppedWeapon){ return; }
        try{
            const pivot = this.weaponPivot;
            pivot.updateWorldMatrix(true, false);
            this.scene.attach(pivot);   // reparent into the scene, preserving the world transform

            // Toss: mostly down/forward out of the grip, biased along the body's facing, plus a small
            // random spread + lift and a brisk tumble so the rifle spins as it falls.
            const fwd = this.fireDir.set(Math.sin(this.facingYaw), 0, Math.cos(this.facingYaw));
            const toss = new THREE.Vector3(
                fwd.x * 1.4 + (Math.random() - 0.5) * 1.2,
                1.2 + Math.random() * 0.8,
                fwd.z * 1.4 + (Math.random() - 0.5) * 1.2);
            const spin = new THREE.Vector3(
                (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
            this.droppedWeapon = new DroppedWeapon(pivot, {
                physicsWorld: this.physicsWorld,
                groundY: this.position.y,
                velocity: toss,
                angularVelocity: spin,
            });
        }catch(e){
            console.error('Soldier weapon drop failed:', e);
            this.droppedWeapon = null;
        }
    }

    UpdateDeath(t){
        this._deathElapsed += t;

        // LINGER: physics drives the skeleton + the dropped rifle as they settle. Guarded so a ragdoll
        // error can never propagate up and kill the render loop.
        if(this._deathElapsed < this.corpseLingerTime){
            if(this.ragdoll){
                try{ this.ragdoll.update(t); }
                catch(e){ console.error('Soldier ragdoll update failed:', e); this.ragdoll = null; }
            }
            if(this.droppedWeapon){
                try{ this.droppedWeapon.update(t); }
                catch(e){ console.error('Soldier dropped-weapon update failed:', e); this.droppedWeapon = null; }
            }
            return;
        }

        // REMOVE: once settled, destroy the corpse outright (mesh, rifle, hit volumes, sensor ghost) so
        // it simply DISAPPEARS — no sink through the floor.
        this.ragdoll = null;
        if(!this._despawned){
            this._despawned = true;
            this.parent.parent.Remove(this.parent);
        }
    }

    // Despawn cleanup (called by Entity.Dispose on removal): pull the corpse + dropped rifle + muzzle-
    // flash objects out of the scene and stop the sims. The hit volumes / attack sensor are freed by
    // their own components' Dispose.
    Dispose(){
        if(this.modelRoot && this.modelRoot.parent){ this.modelRoot.parent.remove(this.modelRoot); }
        if(this.flashLight && this.flashLight.parent){ this.flashLight.parent.remove(this.flashLight); }
        if(this.flashMesh && this.flashMesh.parent){ this.flashMesh.parent.remove(this.flashMesh); }
        if(this.shotSound){ try{ this.shotSound.isPlaying && this.shotSound.stop(); }catch(_){ /* ignore */ } }
        if(this.droppedWeapon){ try{ this.droppedWeapon.dispose(); }catch(_){ /* ignore */ } this.droppedWeapon = null; }
        this.ragdoll = null;
    }

    // ---- Movement & animation ----
    // Smallest-angle step from `a` toward `b`, capped at maxStep radians.
    StepYaw(a, b, maxStep){
        let diff = b - a;
        while(diff > Math.PI){ diff -= Math.PI * 2; }
        while(diff < -Math.PI){ diff += Math.PI * 2; }
        if(Math.abs(diff) <= maxStep){ return b; }
        return a + Math.sign(diff) * maxStep;
    }

    // True for the four directional jog states (not idle/shoot).
    IsJogState(name){
        return name === 'jogF' || name === 'jogB' || name === 'jogL' || name === 'jogR';
    }

    // Move toward the current waypoint at desiredSpeed, clamped to the navmesh; set facing (the
    // target in combat, else the move direction) and record the actual speed + the move direction in
    // the body's LOCAL frame (so the directional jog can be chosen).
    Locomote(t){
        let moved = 0.0;
        let dirX = 0, dirZ = 0, haveDir = false;
        let facedTarget = false;

        // Facing. In combat the soldier keeps facing the TARGET while it strafes (so it shoots you
        // even while moving sideways); otherwise (or if the target was just lost) it turns toward
        // where it's walking (handled in the move branch below).
        if(this.combatFacing && this.target && this.target.Position){
            this.faceVec.copy(this.target.Position).sub(this.position); this.faceVec.y = 0.0;
            if(this.faceVec.lengthSq() > 1e-6){
                this.targetYaw = Math.atan2(this.faceVec.x, this.faceVec.z);
                this.facingYaw = this.StepYaw(this.facingYaw, this.targetYaw, this.combatFaceRate * t);
                facedTarget = true;
            }
        }

        if(this.canMove && this.path && this.path.length){
            const wp = this.path[0];
            this.tempVec.set(wp.x - this.position.x, 0.0, wp.z - this.position.z);
            const dist = this.tempVec.length();

            if(dist <= this.waypointRadius){
                this.path.shift();
                if(this.path.length === 0){ this.Broadcast({topic: 'nav.end', agent: this}); }
            }else{
                this.tempVec.divideScalar(dist);                 // normalize move dir
                dirX = this.tempVec.x; dirZ = this.tempVec.z; haveDir = true;
                // Face the movement direction unless we're already facing a combat target this frame.
                if(!facedTarget){
                    this.targetYaw = Math.atan2(this.tempVec.x, this.tempVec.z);
                    this.facingYaw = this.StepYaw(this.facingYaw, this.targetYaw, 8.0 * t);
                }

                const step = Math.min(this.desiredSpeed * t, dist);
                this.desiredPos.copy(this.position).addScaledVector(this.tempVec, step);

                // A navmesh-bound agent must NEVER move unclamped — that's what lets it slide
                // straight THROUGH a wall and vanish. If we've lost the navmesh reference,
                // re-acquire it at our current spot first so the clamp below always runs.
                if(!this.navNode || this.navGroup === null){
                    this.navGroup = this.navmesh.GetGroup(this.position);
                    this.navNode = this.navGroup !== null
                        ? this.navmesh.GetClosestNode(this.position, this.navGroup) : null;
                }

                if(this.navNode && this.navGroup !== null){
                    this.navNode = this.navmesh.ClampStep(
                        this.position, this.desiredPos, this.navNode, this.navGroup, this.clampTarget
                    );
                    // Ride the terrain: take Y from the terrain height under the clamped (x,z) so the
                    // soldier walks up/down the hills (the navmesh constrains x/z only). Flat ground / no
                    // terrain => holds its current Y, exactly as before. Horizontal distance only, so the
                    // measured speed (idle/jog choice) isn't inflated by the vertical step.
                    this.clampTarget.y = this.terrain
                        ? this.terrain.HeightAt(this.clampTarget.x, this.clampTarget.z) : this.position.y;
                    moved = Math.hypot(this.clampTarget.x - this.position.x, this.clampTarget.z - this.position.z);
                    this.position.copy(this.clampTarget);
                }else{
                    // Still off the mesh after re-acquiring: hold at the last on-mesh spot rather
                    // than moving freely through geometry (recovery will re-route/teleport us).
                    if(this.lastGoodPos.lengthSq() > 0){ this.position.copy(this.lastGoodPos); }
                }
            }
        }

        // Project the move direction into the body's local frame (forward F=(sin,0,cos), right
        // R=(cos,0,-sin)) so the directional jog matches how the body is actually moving vs facing —
        // i.e. strafing left while facing the target plays jogL, not a moonwalking forward jog.
        if(haveDir){
            const sy = Math.sin(this.facingYaw), cy = Math.cos(this.facingYaw);
            this.moveLocalFwd   = dirX * sy + dirZ * cy;
            this.moveLocalRight = dirX * cy - dirZ * sy;
        }

        // Smooth the measured speed so the idle/jog choice doesn't flicker.
        const instSpeed = t > 0 ? moved / t : 0.0;
        this.currentSpeed += (instSpeed - this.currentSpeed) * Math.min(1.0, t * 10.0);
    }

    // The leg state from the measured speed + the move direction relative to facing: idle when slow,
    // else the directional jog (forward / back / strafe) matching the body-local move direction.
    DesiredLocoState(){
        if(this.currentSpeed <= this.moveAnimThreshold){ return 'idle'; }
        if(Math.abs(this.moveLocalFwd) >= Math.abs(this.moveLocalRight)){
            return this.moveLocalFwd >= 0 ? 'jogF' : 'jogB';
        }
        return this.moveLocalRight >= 0 ? 'jogR' : 'jogL';
    }

    // Drive the legs from the resolved locomotion; the torso mirrors it unless the shoot overlay
    // owns the upper layer (firing) — that's what lets the soldier fire while strafing.
    UpdateLocomotionAnim(){
        const desired = this.DesiredLocoState();
        this.SetLowerState(desired, 0.2);
        if(!this.firing){ this.SetUpperState(desired); }
    }

    // Per-frame foot-sync: match the active jog's timeScale to the measured ground speed on BOTH
    // layers (so the torso bob stays locked to the footfalls when not firing).
    UpdateLocoTimeScale(){
        if(!this.IsJogState(this.lowerState)){ return; }
        const ts = this.LocoTimeScale(this.lowerState);
        const lo = this.lowerActions[this.lowerState];
        if(lo){ lo.setEffectiveTimeScale(ts); }
        if(!this.firing && this.upperState === this.lowerState){
            const up = this.upperActions[this.upperState];
            if(up){ up.setEffectiveTimeScale(ts); }
        }
    }

    // Cadence (timeScale) for a locomotion action: jogs scale with ground speed so the feet roughly
    // match the floor; idle/shoot keep their fixed rate. The speed used is the MAX of the measured
    // speed and (when the soldier intends to move) most of its COMMANDED speed — so a soldier that's
    // being clamped/grinding (measured ~0) still cycles its legs at its commanded pace instead of
    // dropping into slow-motion. Floored (no crawl) and capped (no flutter); multiplies by a constant
    // (never divides) so it can't NaN.
    LocoTimeScale(name){
        if(!this.IsJogState(name)){ return this.animTimeScale[name] ?? 1.0; }
        const commanded = this.canMove ? this.desiredSpeed * 0.85 : 0;
        const sp = Math.max(this.currentSpeed, commanded);
        if(sp <= this.moveAnimThreshold){ return this.locoTimeScaleMin; }
        return THREE.MathUtils.clamp(
            sp * this.invAuthoredJogSpeed, this.locoTimeScaleMin, this.locoTimeScaleMax);
    }

    // Legs: crossfade between locomotion states, carrying the gait phase across a jog<->jog direction
    // change so the feet don't snap to a new cycle phase and skate during the blend.
    SetLowerState(name, fade = 0.2){
        if(this.lowerState === name || !this.lowerActions[name]){ return; }
        const next = this.lowerActions[name];
        const prev = this.lowerState ? this.lowerActions[this.lowerState] : null;
        next.reset();
        next.setLoop(THREE.LoopRepeat);
        next.setEffectiveWeight(1.0);
        next.setEffectiveTimeScale(this.LocoTimeScale(name));
        if(prev && this.IsJogState(name) && this.IsJogState(this.lowerState)){
            const pd = prev.getClip().duration || 1;
            next.time = (pd > 0 ? (prev.time % pd) / pd : 0) * (next.getClip().duration || 0);
        }
        next.play();
        if(prev){ next.crossFadeFrom(prev, fade, true); }
        this.lowerState = name;
    }

    // Torso: mirror a locomotion state — but never while the shoot overlay owns the upper layer.
    SetUpperState(name){
        if(this.firing || this.upperState === name || !this.upperActions[name]){ return; }
        this.PlayUpperLocomotion(name, 0.2);
    }

    // Start an upper-body locomotion action, phase-matched to the legs so the torso bob stays in
    // sync with the footfalls, made the sole full-weight upper action (no bind/T-pose flash).
    PlayUpperLocomotion(name, fade){
        const next = this.upperActions[name];
        if(!next){ return; }
        next.reset();
        next.setLoop(THREE.LoopRepeat);
        next.setEffectiveTimeScale(this.LocoTimeScale(name));
        next.play();
        if(this.lowerActions[name]){ next.time = this.lowerActions[name].time; }
        this.SetUpperPrimary(next, fade);
        this.upperState = name;
    }

    // Make `primary` the sole full-weight action on the UPPER layer (snap to weight 1, fade every
    // other live upper action out) so the spine/arms are never left with no driver for a frame.
    SetUpperPrimary(primary, fade){
        primary.enabled = true;
        primary.stopFading();
        primary.setEffectiveWeight(1.0);
        for(const key in this.upperActions){
            const a = this.upperActions[key];
            if(a !== primary && a.enabled && a.getEffectiveWeight() > 1e-3){ a.fadeOut(fade); }
        }
    }

    // Combat aim: make the soldier visibly point its rifle at whatever it's shooting. Runs AFTER the
    // body's facing yaw is applied (so the world matrices are current). Two layers, like the player:
    // a gross additive spine lean toward the target's elevation, then the WeaponAimIK fine pass that
    // rotates the gun so the barrel points at the target and re-plants the support hand. Eased in only
    // while ENGAGED (combatFacing on a live target) so patrol/idle/chase-without-LOS read as authored.
    UpdateCombatAim(t){
        if(!this.weaponAimIK){ return; }
        const engaged = !!(this.combatFacing && this.target && this.IsAlive(this.target) && this.target.Position);
        if(engaged){
            // Aim at the target's torso/centre (the player capsule pos is ~eye height; raise other
            // bodies to a torso).
            this.aimVec.copy(this.target.Position);
            if(this.target !== this.player){ this.aimVec.y += 1.0; }
        }
        // Refresh the body's world transform so the IK reads this frame's facing.
        this.modelRoot.updateMatrixWorld(true);
        // Gross: lean the spine toward the target altitude.
        this.UpdateAimSpine(t, engaged);
        // Fine: point the barrel exactly at the target (fireDir is the facing fallback for too-close).
        this.fireDir.set(Math.sin(this.facingYaw), 0, Math.cos(this.facingYaw));
        this.weaponAimIK.Update(t, {
            active: engaged,
            // Always-on grip while alive: the support hand stays glued to the rifle even while patrolling
            // (not just when engaged), so the soldier holds the weapon properly throughout — the same
            // two-alpha split the player uses. The barrel only swings toward the target while `engaged`.
            gripActive: !this.dead,
            aimTarget: this.aimVec,
            aimValid: engaged,
            cameraForward: this.fireDir,
        });
    }

    // Additive spine pitch lean toward the target's elevation (gross aim that the barrel IK then
    // refines). Eased in/out with engagement so it never pops; rotates each spine bone about the
    // character's right axis in its parent's world frame (rig-agnostic, matches PlayerBody's lean).
    UpdateAimSpine(t, engaged){
        if(!this.aimBones.length){ return; }
        this._aimSpineWeight += ((engaged ? 1 : 0) - this._aimSpineWeight) * (1 - Math.exp(-this.aimSpineLerp * t));
        let targetPitch = 0;
        if(engaged && this.handBone){
            this.handBone.getWorldPosition(this._aimChest);     // ~gun height
            const dy = this.aimVec.y - this._aimChest.y;
            const horiz = Math.hypot(this.aimVec.x - this._aimChest.x, this.aimVec.z - this._aimChest.z);
            const elev = Math.atan2(dy, Math.max(0.2, horiz));  // + = target above the gun
            targetPitch = THREE.MathUtils.clamp(this.aimSpinePitchSign * elev * this.aimSpinePitchGain,
                -this.aimSpinePitchMax, this.aimSpinePitchMax);
        }
        this._aimSpinePitch += (targetPitch - this._aimSpinePitch) * (1 - Math.exp(-this.aimSpineLerp * t));
        const pitch = this._aimSpinePitch * this._aimSpineWeight;
        if(Math.abs(pitch) < 1e-4){ return; }
        this._aimRight.set(Math.cos(this.facingYaw), 0, -Math.sin(this.facingYaw));
        for(const ab of this.aimBones){
            this._aimR.setFromAxisAngle(this._aimRight, pitch * ab.weight);
            ab.bone.parent.getWorldQuaternion(this._aimPW);
            this._aimPWInv.copy(this._aimPW).invert();
            this._aimDelta.copy(this._aimPWInv).multiply(this._aimR).multiply(this._aimPW);
            ab.bone.quaternion.premultiply(this._aimDelta);
        }
    }

    TakeHit = (msg) => {
        if(this.dead){ return; }

        // Blood splatter at the bullet's impact point (ranged hits carry a hitResult). Spray OUT of the
        // entry wound — back toward the shooter (the side facing the camera for the player's own shots)
        // — and lift the spawn a touch off the collision surface so the burst reads as coming off the
        // body, not erupting from inside the mesh (the hit capsule sits inside the visible silhouette,
        // so emitting AT the raw hit point + spraying the old way along the bullet buried the droplets).
        if(msg.hitResult && this.blood){
            const hp = msg.hitResult.intersectionPoint;
            let origin = hp, out = null;
            if(msg.from && msg.from.Position){
                out = msg.from.Position.clone().sub(hp);
                if(out.lengthSq() > 1e-6){ out.normalize(); origin = hp.clone().addScaledVector(out, 0.12); }
            }
            this.blood.Emit(origin, out, { scale: 0.6, count: 12, spread: 0.7 });
            // Stamp a blood decal on the body where the bullet landed (rides the animation + ragdoll).
            // SIZE matters here: the default footprint (0.12-0.24 m) is too small to read on the "Liz"
            // enemy. ~0.30 m is the measured sweet spot — big enough that the projection (see BloodDecals,
            // which now gathers the whole footprint's bones) fills the decal, but not so big the box
            // outruns the chest's forward-facing surface and re-starves it. 0.24-0.36 keeps it in that band.
            // BONE: the bullet landed on a specific hit-sphere (UeSoldierCollision tags each with its bone),
            // so hand the decal that EXACT bone to ride — robust where the hands/forearms cross the torso in
            // the aim pose and a nearest-bone guess would anchor the decal to an arm and fling it off the body.
            // Read the EXACT bone the bullet struck + that hit sphere's radius (UeSoldierCollision tags both).
            let hitBone = null, hitRadius = 0.16;
            const co = msg.hitResult.collisionObject;
            if(co){ const ghost = Ammo.castObject(co, Ammo.btPairCachingGhostObject); if(ghost){ hitBone = ghost.hitBone || null; if(ghost.hitRadius){ hitRadius = ghost.hitRadius; } } }
            // One blood CARD per hit, SIZED to the body part it hit (~2x the hit-sphere radius ≈ the part's
            // width): big on the chest, small on a limb — so it reads clearly at any range yet hugs the part
            // without floating off the silhouette (a true projected decal is invisible at combat range on this
            // dense curved mesh — see BloodDecals). Rides the exact hit bone; the tiny FIFO keeps only the last
            // few impacts so it stays cheap.
            if(this.bloodDecals && hitBone){
                const size = hitRadius * (1.7 + Math.random() * 0.5);
                this.bloodDecals.Splat(hp, msg.hitResult.intersectionNormal, this.skinnedmesh, { size, bone: hitBone, flat: true });
            }
        }

        this.health = Math.max(0, this.health - (msg.amount ?? 0));

        // Additive hit-react flinch (scaled by the damage, so a beast swipe rocks harder than an AK
        // round). Fire it for any non-fatal hit; on a fatal hit the ragdoll takes over instead. A
        // GUARANTEED visible base (0.7) plus a damage term: the player AK only does 2/shot, and the
        // old amount/8 mapping floored to a ~3° twitch that vanished under the firing overlay — so the
        // bullet impact "didn't read". This jolts the torso ~10° per round and stacks under sustained
        // fire (the spring compounds; see HurtFlinch.Trigger), clamped by HurtFlinch's max angles.
        if(this.health > 0 && this.hurtFlinch){
            // Recoil AWAY from the shooter: push direction = shooter -> this soldier.
            const push = (msg.from && msg.from.Position) ? this.position.clone().sub(msg.from.Position) : null;
            this.hurtFlinch.Trigger(0.7 + (msg.amount ?? 0) / 5, push, this.facingYaw);
        }

        // Remember who hit us — a NEUTRAL retaliates against this attacker; everyone else uses it as
        // chase MEMORY so a soldier shot from cover pushes toward the shooter (instead of bailing
        // straight back to patrol because the attacker isn't currently visible).
        this.provokedBy = msg.from || this.player;

        if(this.health === 0){
            this.stateMachine.SetState('dead');
        }else{
            // Getting shot ALWAYS provokes an immediate, hard engagement: snap toward the shooter,
            // refresh the chase memory and push toward them from ANY non-combat state — closing the
            // "shot from outside my view, didn't react" gap. Routed through Alert(hard, fromDamage) so
            // a passive NEUTRAL also rouses on a direct hit and the boosted alert perception kicks in.
            const at = (this.provokedBy && this.provokedBy.Position) ? this.provokedBy.Position : this.position;
            this.Alert(at, true, true);
        }
    }

    Update(t){
        this.mixer && this.mixer.update(t);
        this.UpdateMuzzleFlash(t);

        // Strip baked root motion so the clip plays in place; velocity moves us.
        if(this.rootBone && this.rootRef){
            this.rootBone.position.copy(this.rootRef.position);
            this.rootBone.quaternion.copy(this.rootRef.quaternion);
            this.rootBone.scale.copy(this.rootRef.scale);
        }

        this.stateMachine.Update(t);

        if(this.dead){
            // Death tween is driven by the FSM's DeadState via UpdateDeath.
            this.SyncParentTransform();
            return;
        }

        // Decay the alert window (heightened awareness from a recent shot / heard gunfire / call-out).
        if(this.alertTimer > 0){ this.alertTimer = Math.max(0, this.alertTimer - t); }

        this.Locomote(t);
        this.UpdateLocomotionAnim();
        this.UpdateLocoTimeScale();    // foot-sync the live walk/run playback rate to ground speed
        this.UpdateStuckRecovery(t);   // repath / subtle teleport if wedged (after the move)

        // Additive hurt flinch on top of the mixer pose (idle no-op when not recently hit), about the
        // soldier's facing yaw. After locomotion so it layers over the strafe/fire pose.
        this.hurtFlinch && this.hurtFlinch.Update(t, this.facingYaw);

        // Apply transforms: body follows position + smoothed facing yaw.
        this.modelRoot.position.copy(this.position);
        this.modelRoot.rotation.set(0, this.facingYaw, 0);
        // Combat aim: after the facing is applied, lean the spine + IK the rifle barrel onto the
        // target so the soldier visibly aims at whoever it's shooting (no-op when not engaged).
        this.UpdateCombatAim(t);
        // Foot/terrain IK: LAST pose write, after the facing + combat aim. Conforms the feet to the
        // ground; fades out with speed (anti-skate). Soldiers walk the navmesh, so they're "grounded".
        this.UpdateFootIK(t);
        this.SyncParentTransform();
    }

    // Drive the soldier's foot/terrain IK each frame (alive only — the dead branch returns earlier and
    // hands the body to the ragdoll). FootIK fades itself out with ground speed so a moving soldier's
    // foot-synced jog isn't fought into a skate; it conforms the planted feet when slow/standing.
    UpdateFootIK(t){
        if(!this.footIK){ return; }
        this.footIK.Update(t, { enabled: !this.dead, speed: this.currentSpeed, bodyYaw: this.facingYaw });
    }

    // Keep the entity transform in sync so AttackTrigger / hit capsules follow.
    SyncParentTransform(){
        this.parentQuat.setFromAxisAngle(this.upAxis, this.facingYaw);
        this.parent.SetPosition(this.position);
        this.parent.SetRotation(this.parentQuat);
    }
}

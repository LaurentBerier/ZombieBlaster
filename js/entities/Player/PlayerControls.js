import * as THREE from 'three'
import Component from '../../Component.js'
import Input from '../../Input.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'

import DebugShapes from '../../DebugShapes.js'


export default class PlayerControls extends Component{
    constructor(camera){
        super();
        this.name = 'PlayerControls';
        this.camera = camera;

        this.timeZeroToMax = 0.08;

        // Movement speeds (shared by TPS + FPS — same physics capsule). Toned DOWN for a more
        // grounded, deliberate pace: a slower base walk, a much milder sprint, and a notably slower
        // crouch-walk (see crouchSpeedMultiplier below). The foot-synced jog playback rate tracks
        // these automatically, so the legs stay matched to the floor at the new pace.
        this.walkSpeed = 5.5;            // base jog (was 7.0) — overall slowdown
        this.sprintMultiplier = 1.35;   // sprint top speed = walk*1.35 ≈ 7.4 (was 1.6 ⇒ 11.2): a calmer sprint
        this.maxSpeed = this.walkSpeed;
        this.speed = new THREE.Vector3();
        this.acceleration = this.walkSpeed / this.timeZeroToMax;
        this.decceleration = -7.0;
        this.isSprinting = false;

        // --- Crouch. Toggle with C (latched edge) OR hold Left Alt / Option. Effective crouch also
        // requires being grounded (jumping/airborne force-stands). Crouching shrinks the physics capsule
        // (PlayerPhysics — gameplay hitbox + fit under low cover), slows movement, lowers the TPS camera,
        // and the body lowers the pelvis + bends the knees PROCEDURALLY (PlayerBody + FootIK) — there is
        // no crouch CLIP. `crouching` is the single source of truth other components read.
        this.crouching = false;             // effective crouch state (read by PlayerBody)
        this._crouchToggle = false;         // C-key toggle state
        this._crouchLatch = false;          // C-key edge latch (so a held key fires once)
        // Crouch-walk now reads CLOSER to the regular walk — only a bit slower — instead of the old slow
        // creep that looked bad (the foot-synced jog crawled at ~2.2 m/s and the legs dragged). 0.6 ⇒
        // ~3.3 m/s, a more natural jog cadence (foot-sync ~0.56x, no skate) that still reads as a careful,
        // slightly-slower crouch move. Pairs with the shallower crouch-walk hip drop in PlayerBody.
        this.crouchSpeedMultiplier = 0.6;   // top-speed scale while crouched ≈ 3.3 m/s: a bit slower than the walk
        // Crouch LOWERS the TPS camera so the view follows the character down (the authored crouch-idle
        // clip drops the head ~0.7 m; a steady camera read as the camera "rising" away from the sinking
        // character). A FIXED eased drop — NOT head-bone tracking — on purpose: tracking the bone would
        // feed the crouch clip's breathing + foot-IK + faceted-terrain noise straight into the view (the
        // old crouch-camera-jitter complaint). 0.55 follows most of the head drop while keeping a touch
        // more framing over the character; eased by crouchCamLerp so entering/leaving crouch glides.
        this.crouchCamDrop = 0.55;          // TPS camera pivot drop while crouched (m), eased
        this._crouchCamEased = 0;           // eased 0..crouchCamDrop applied to the TPS camera pivot
        this.crouchCamLerp = 8;             // ease rate (1/s) for the camera drop

        this.mouseSpeed = 0.002;
        this.physicsComponent = null;
        this.isLocked = false;
        // When a dev tool (WeaponPlacementDebug) takes over the camera, we freeze the
        // player and stop placing the camera so the tool's free-fly cam can own it.
        this.cameraOverride = false;

        this.angles = new THREE.Euler();
        this.pitch = new THREE.Quaternion();
        this.yaw = new THREE.Quaternion();

        this.jumpVelocity = 5;
        // --- Jump forgiveness + air double-jump.
        // COYOTE TIME: a short grace window after leaving the ground where a jump still counts as a
        // ground jump, so walking off a ledge or a 1-frame canJump flicker (faceted terrain) never eats
        // the input — the "sometimes I can't jump as if stuck to the ground" complaint.
        // JUMP BUFFER: a pressed jump is remembered briefly so tapping just before landing still fires.
        this.coyoteTime = 0.12;          // s after leaving ground that a ground jump still fires
        this.jumpBufferTime = 0.12;      // s a jump press is buffered waiting to become valid
        this._coyoteTimer = 0;
        this._jumpBuffer = 0;
        this._spaceLatch = false;        // edge-detect Space for the air double-jump (not the held bunny-hop)
        // WALL DOUBLE-JUMP: while airborne, pressing jump again near a vertical surface grants ONE extra
        // jump (a wall-assisted double jump). Reset on landing. A short horizontal sphere-sweep in several
        // directions detects a nearby wall; the second jump is a clean vertical boost (movement input
        // still steers x/z), with a small outward kick off the wall so you don't just slide back down it.
        this.doubleJumpEnabled = true;
        this.wallJumpRange = 0.55;       // how close a wall must be for the air jump (m)
        this.wallJumpVelocity = 5.4;     // upward velocity of the wall-assisted double jump (m/s)
        this.wallJumpPush = 2.2;         // outward kick off the wall (m/s), folded into local speed
        this._airJumpUsed = false;       // consumed per air-time; reset when grounded
        this._wallNormal = new THREE.Vector3();
        this._wallFrom = new THREE.Vector3();
        this._wallTo = new THREE.Vector3();
        // Horizontal probe directions (8-way) for the nearby-wall sweep.
        this._wallProbeDirs = [
            new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
            new THREE.Vector3(0.7071, 0, 0.7071), new THREE.Vector3(-0.7071, 0, 0.7071),
            new THREE.Vector3(0.7071, 0, -0.7071), new THREE.Vector3(-0.7071, 0, -0.7071),
        ];
        this._wallRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };
        this.yOffset = 0.5;
        this.tempVec = new THREE.Vector3();
        this.moveDir = new THREE.Vector3();
        this.xAxis = new THREE.Vector3(1.0, 0.0, 0.0);
        this.yAxis = new THREE.Vector3(0.0, 1.0, 0.0);

        // Camera mode: 'TPS' (third-person orbit-follow, default — showcases the
        // UE Mannequin) or 'FPS' (first-person, the arms/weapon viewmodel).
        // The same yaw/pitch (this.angles) drives both; only the camera placement
        // differs. Press V to toggle. Combat aim is FP-authoritative in v1.
        this.cameraMode = 'TPS';
        this.tpsDistance = 2.6;   // boom length behind the player (metres)
        this.tpsMinDistance = 0.6;// HARD floor on the boom: collision never dollies closer than this (see UpdateCamera)
        this.tpsPivotHeight = 0.25; // pivot above eye height
        this.tpsShoulder = 0.85;  // lateral rig shift: bigger => character further frame-left, reticle further right (in front of the gun)
        this._vLatch = false;

        // Precise-aim mode (hold right click in TPS): the boom pulls in over the
        // shoulder, the FOV zooms, and the mouse slows for finer aim. Targets are
        // eased toward each frame so entering/leaving aim glides rather than snaps.
        this.aiming = false;
        // Physical right-button state, tracked so a committed move (which force-drops aim, see TryStartSlide)
        // can RESTORE aim when it ends if the button is still held — otherwise aiming stays stuck off
        // until you release and re-press, which read as "I'm holding aim but nothing's aiming".
        this._aimHeld = false;
        this.tpsAimDistance = 1.5;    // tighter boom while aiming
        this.tpsAimShoulder = 0.55;   // pull the shoulder offset in a little
        this.tpsAimFov = 35;          // zoom (base FOV is captured in Initialize)
        this.aimLerpSpeed = 12;
        this.aimSensitivity = 0.55;   // mouse multiplier while aiming
        this.aimMoveMultiplier = 0.4; // top-speed scale while aiming — a slow, deliberate ADS walk
        this.baseFov = 50;            // overwritten from the camera in Initialize
        // First-person FOV (managed separately from the TPS boom FOV). FPS wants a WIDER lens than
        // third-person so the view feels open and you see more of the weapon/hands; ADS eases to a
        // modestly tighter FOV for a subtle zoom. Both ease via _curFov in the FPS branch of UpdateCamera.
        this.fpsFov = 90;             // wide first-person hip FOV
        // ADS zoom: pulled in ~20-25% tighter than before (was 72°). A narrower aim FOV magnifies the
        // view ~1.25x (magnification ∝ 1/tan(fov/2)), so down-the-sights reads as a real zoom, not just
        // a small lens crop. Still eases via _curFov so entering/leaving ADS glides.
        this.fpsAimFov = 58;          // tighter ADS zoom (~25% more magnification than the old 72°)
        // Smoothed current values driven each frame in UpdateCamera.
        this._curDistance = this.tpsDistance;
        this._curShoulder = this.tpsShoulder;
        this._curFov = this.baseFov;
        // Scratch vectors for the TPS boom (avoid per-frame allocation).
        this._cap = new THREE.Vector3();
        this._pivot = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._fwdFlat = new THREE.Vector3();   // yaw-only (horizontal) forward — for the FPS look-down push
        this._right = new THREE.Vector3();
        this._fwdBase = new THREE.Vector3(0, 0, -1);
        this._rightBase = new THREE.Vector3(1, 0, 0);

        // --- Aim target (the single source of truth for "where the player is aiming"). Each frame
        // we cast the SAME camera-centre ray the weapon fires (screen-centre unproject; see
        // Weapon.Raycast) into the physics world and store the world point it hits. The weapon
        // alignment + two-hand IK (PlayerBody / WeaponAimIK) point the visible barrel AT this point,
        // so the gun lines up with the actual projectile trace — same ray, same target, no parallax
        // between the crosshair and the muzzle. Valid=true when the ray hit geometry; otherwise the
        // target is a far point straight down the crosshair (still a correct aim direction).
        this.aimTarget = new THREE.Vector3();      // world point under the crosshair
        this.aimOrigin = new THREE.Vector3();      // camera world position the ray starts from
        this.aimDir = new THREE.Vector3(0, 0, -1); // unit camera-forward (crosshair direction; carries shake/wobble)
        this.aimDirRaw = new THREE.Vector3(0, 0, -1); // FX-FREE look forward (pure yaw*pitch) — for cosmetic head-aim
        this.aimTargetValid = false;               // true => the ray hit something (else far fallback)
        this.aimDistance = 0;                      // metres from the camera to the (smoothed) aim target
        this.aimMaxDistance = 150;                 // far fallback distance when nothing is hit (m)
        // The aim DISTANCE is low-passed while the DIRECTION stays instant. Sweeping the crosshair
        // across an edge (near pillar -> far background) makes the raw hit point jump in DEPTH; because
        // the visible barrel points AT that point, a raw depth jump would swing the gun + support arm
        // hard for a few frames (parallax is depth-sensitive). Easing only the distance kills that jerk
        // while keeping lateral aim fully responsive (the direction is the live crosshair). The actual
        // shot still uses the exact instantaneous hit (Weapon.Raycast), so accuracy is unaffected and a
        // steady aim still converges the barrel exactly on the target.
        // Depth ease rate (1/s). The visible barrel points AT aimTarget, so a raw hit-depth JUMP as the
        // crosshair sweeps a near/far edge — which happens constantly WHILE TURNING — swings the muzzle
        // (it is offset from the camera, so the muzzle->point direction is depth/parallax sensitive) and
        // reads as the gun/arms "strobing" on a turn. Easing the depth lower-passes that swing; kept
        // responsive enough that a steady aim still converges the barrel on the target. The SHOT uses
        // the exact instantaneous hit (Weapon.Raycast), so accuracy is unaffected by this smoothing.
        this.aimDistLerp = 6;
        this._aimDistSmooth = 0;                   // low-passed aim distance
        this._aimDistSeeded = false;               // seed on first use so it doesn't ease in from 0
        this._aimNear = new THREE.Vector3();       // scratch: near-plane crosshair point
        this._aimFar = new THREE.Vector3();        // scratch: far-plane crosshair point
        this._aimHit = { intersectionPoint: new THREE.Vector3(), intersectionNormal: new THREE.Vector3() };

        // --- First-person camera: rides the body's head bone (same character), with
        // the head mesh hidden by the camera's near plane ("cull distance"). ---
        this.body = null;               // PlayerBody, queried for the head-bone position
        // FPS eye offset from the head bone. Now that FPS frames the TPS-held gun (both hands on it), the
        // eye is pulled BACK (negative forward) and a touch up so the gun + forearms sit centred in view,
        // like a tight over-the-head first-person. Tune these to reframe the gun.
        this.fpsEyeForward = -0.13;     // BACK from the head (negative = behind) so the chest-held gun is in frame
        this.fpsEyeUp = 0.12;           // up, to look down onto the gun + hands
        this.fpsEyeRight = 0.05;        // slightly right, to centre the right-held gun
        this.fpsNear = 0.18;            // near plane that culls the head at the eye
        // FPS look-DOWN forward push. The head is HIDDEN in first-person (PlayerBody collapses the head
        // bone to a point), so tilting the view down would stare straight into the missing-head gap above
        // the neck. Rather than pull the eye BACK off the body (which only reveals MORE of the headless
        // torso), we do the OPPOSITE: push the eye FORWARD over the chest as the look tilts down, so the
        // camera slides out past the neck stump and frames the gun/ground instead of the empty socket.
        // Pushed along the YAW-ONLY (horizontal) forward so a steep look-down moves the eye forward over
        // the body, never straight down into it. Eased; zero at level/up (where the framing is already good).
        this.fpsLookDownForward = 0.34; // metres the eye eases FORWARD at full look-down
        this.fpsLookDownLerp = 8;       // ease rate (1/s) for the push in/out
        this._fpsLookDownEased = 0;     // eased 0..1 look-down amount (driven in UpdateCamera)
        // FPS look-UP compensation. The held gun pitches UP with the look (UpdateFpsViewmodelPitch), so a
        // steep look-up swings the weapon + shoulder into the lens: the near plane clips THROUGH the
        // shoulder geo (see-through faces) and the raised gun covers the crosshair. The framing is good
        // at level, so we keep it: as the look tilts up, ease the eye UP (look OVER the rising gun so the
        // crosshair clears) and a touch BACK along the yaw-only forward (pull the lens out of the shoulder
        // so it stops clipping). HIP-ONLY: faded out while AIMING (the camera-locked ADS gun holds its
        // framing without an eye dodge). Mirrors the look-down forward push; zero at level/down already.
        this.fpsLookUpUp = 0.16;        // metres the eye eases UP at full look-up (clears the gun/crosshair)
        this.fpsLookUpBack = 0.10;      // ...and BACK (horizontal) so the lens leaves the shoulder geo
        this.fpsLookUpLerp = 8;         // ease rate (1/s) for the look-up compensation in/out
        this._fpsLookUpEased = 0;       // eased 0..1 look-up amount (driven in UpdateCamera)
        this._fpsAimEyeEase = 0;        // eased 0..1 ADS factor; fades the pitch-driven eye dodges out while aiming
        // FPS AIMING look-DOWN shift. While ADS the hip eye-dodges above are suppressed (the viewmodel is
        // CAMERA-LOCKED: PlayerBody.UpdateFpsViewmodelPitch pins the gun to a fixed eye), so looking down
        // orbits the locked gun + arms DOWN about that fixed eye and they punch THROUGH the chest/torso
        // (the reported bug — worst crouched). Fix: while aiming AND looking down, slide the eye FORWARD
        // (yaw-only, over the chest) and a touch UP. The ADS gun is pinned camera-local and the arms+hands
        // are carried onto it, so moving the eye moves the WHOLE viewmodel — camera, gun, arms, hands —
        // FORWARD together, off the body, while it stays framed on the reticle (the lock is eye-relative).
        // Zero at level/up; FPS + aiming only. Same stance standing or crouched.
        this.fpsAimLookDownForward = 0.30; // metres the eye+viewmodel ease FORWARD at full look-down while aiming
        this.fpsAimLookDownUp = 0.06;      // ...and a touch UP so the lens lifts off the shoulders
        this._fpsAimLookDownEased = 0;     // eased 0..1 aiming look-down amount (driven in UpdateCamera)
        // FPS reload: the camera stays PUT. The body now plays the full reload one-shot down the view (the
        // arms work the mag, the gun rides them) instead of being held framed off the eye — see
        // PlayerBody.OnReload + UpdateFpsViewmodelPitch — so the reload reads with no camera pullback at
        // all. The pullback constants are kept (zeroed) so the plumbing/tuning is one edit away if wanted.
        this._reloading = false;        // set true on weapon.reload, false on reload.done
        this._reloadEased = 0;          // eased 0..1 pullback amount
        this.fpsReloadPullback = 0;     // metres the eye eases BACK along look-forward while reloading (0 = camera fixed)
        this.fpsReloadUp = 0;           // ...and a touch UP so the gun lowers into view (0 = camera fixed)
        this.reloadPullLerp = 7;        // ease rate (1/s) for the pullback in/out
        // Placement-hold (dev): when the weapon-placement panel is open in FPS we DON'T hand the camera to
        // the free-fly cam — instead we freeze the player but keep the real first-person camera + aim pose
        // intact, so the gun is placed in its true ADS framing. The aim state is latched on open so it can't
        // drift while you nudge the grip. (TPS placement still uses the free-fly cam via cameraOverride.)
        this.placementHold = false;
        this._placementAim = false;     // latched aim state held while placementHold is on
        this.tpsNear = 0.01;            // crisp near for the third-person boom (set in Initialize)
        this._headPos = new THREE.Vector3();

        // --- FPS vertical view smoothing. The first-person eye rides the body's head bone, so while
        // walking the head's vertical bob — and, more so, the physics capsule riding the FACETED terrain
        // collider (the bulk of the measured FPS walk shake: modelRoot.y curvature ≈ the whole head bob)
        // — jolts the view. We low-pass ONLY the eye HEIGHT here: the horizon steadies while the (un-
        // smoothed) body gun keeps its full bob, so the weapon reads a subtle bob against a calm view —
        // the AAA first-person feel. Horizontal x/z is left exact so turning stays crisp, and the filter
        // is SNAPPED (not smoothed) while airborne/rolling so a jump/fall/land tracks the capsule 1:1.
        // Only the camera height is touched — the body, feet and gun are untouched (no swim, no foot drift).
        this.fpsEyeYLerp = 8;           // eye-height low-pass rate (1/s); higher = snappier, less steady
        this.fpsAimEyeYLerp = 30;       // MUCH tighter while ADS: the camera-locked gun must stay glued under the crosshair through a crouch (the slow lerp lagged the body drop and sank the gun)
        this._fpsEyeY = 0;              // smoothed eye height
        this._fpsEyeYSeeded = false;

        // --- TPS spring-arm "spline" collision (simple & glitch-free). The camera rides a
        // straight SPLINE from the centred pivot (above the head) out to the over-the-shoulder
        // REST point. Collision only ever slides the camera ALONG that line — closer to the
        // pivot or further out — NEVER sideways. Because every point on the line shares one
        // direction from the pivot, the character keeps the SAME on-screen framing at any boom
        // length (it just scales up as the camera nears), so a wall pulling the camera in can
        // never swing the character across the screen — there is nothing lateral to "centre".
        // A swept sphere (radius camRadius) finds how far out the camera can sit; the camera
        // pulls IN to it IMMEDIATELY (so it can never slide through a wall while moving) and
        // eases back OUT, so it tracks cover crisply yet still glides out when the wall clears.
        this.camRadius = 0.24;          // sphere radius for the spline collision sweep (metres)
        // Dolly response is ASYMMETRIC: pulling IN (a wall encroaching) is INSTANT so the camera
        // keeps up with walking/running toward cover and never lags into geometry — with the
        // spline this is a pure dolly, so it reads as a quick close-up, not a swing. Pulling OUT
        // (a wall clearing) eases at boomReturnRate so it glides back rather than popping.
        this.boomReturnRate = 10.0;     // pull-OUT ease toward the rest length (1/s); pull-IN is instant
        this._curT = 1;                 // smoothed 0..1 position ALONG the pivot->rest spline (1 = fully out)
        this._camDist = this.tpsDistance; // live camera->pivot distance (m); drives CameraProximity
        this._camTarget = new THREE.Vector3();  // (first-person eye target)
        this._camInit = false;
        this._free = new THREE.Vector3();       // scratch: over-the-shoulder rest point (far end of the spline)
        this._sweepRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };

        // --- Near-plane "close-mesh cull". As the camera dollies in toward the character the
        // near clip plane is pushed OUT, so meshes very close to the lens (the character it is
        // tucked behind, a wall it is pressed against) are clipped away instead of smearing
        // across the view. Crisp (tpsNear) at rest; grows to tpsNearMax once the camera is in
        // at tpsMinDistance, back to tpsNear past tpsNearGrowDist.
        this.tpsNearMax = 0.45;         // near plane (m) when the camera is dollied fully in
        this.tpsNearGrowDist = 1.5;     // camera-to-pivot distance (m) at/above which the near plane returns to tpsNear

        // --- Sprint pullback. Running pulls the boom back a little for a faster, more
        // cinematic sense of speed. Eased on its own gentle rate so it breathes in/out
        // rather than snapping when the player starts/stops sprinting.
        this.tpsSprintExtra = 0.7;      // extra boom length while sprinting (m)
        this.sprintLerpSpeed = 3.5;     // gentle ease for the sprint pullback (1/s)
        this._curSprint = 0.0;          // smoothed sprint extension

        // --- Walk-start follow lag + pull-back (TPS). When the player breaks into a jog the camera
        // should start MORE SMOOTHLY and sit a touch further back, for a weightier, more cinematic start
        // to motion (rather than being rigidly glued to the character). Two parts, both eased on gentle
        // rates so they breathe in/out and never snap:
        //   * a small extra boom length while jogging (the "pulled back" feel), and
        //   * a follow LAG on the pivot: near-rigid when standing, noticeably laggier once jogging, so
        //     the camera trails and catches up to the character as it accelerates.
        // Both are SUSPENDED while aiming (ADS must stay tight). Crouch-walk uses the SAME pull-back +
        // lag as the standing walk (the camera behaves identically crouched or standing — see the
        // `jogging` note in UpdateCamera). The sprint pullback above still stacks on top when running.
        this.tpsWalkExtra = 0.5;        // extra boom length while jogging (m) — the "a bit pulled back" feel
        this.walkLerpSpeed = 2.0;       // gentle ease for the walk pull-back (1/s)
        this._curWalk = 0.0;            // smoothed walk pull-back extension
        this.pivotFollowIdle = 20.0;    // near-rigid follow-point catch-up when standing still (1/s)
        this.pivotFollowMove = 4.5;     // laggier follow once jogging — the "bigger lag" at walk start (1/s)
        this.pivotFollowLerp = 2.5;     // how fast the follow RATE itself eases between idle/move (1/s)
        this._pivotFollowRate = this.pivotFollowIdle;   // eased current follow rate (1/s)
        this._pivotSmooth = new THREE.Vector3();        // lagged camera follow-point
        this._pivotInit = false;        // seed _pivotSmooth on first use / after a camera-mode switch

        // --- Collision FOV. The camera NEVER imposes any rotation to dodge geometry; the
        // only thing it may do is dolly along the look axis — pull away or push IN toward
        // the player (down to a first-person POV at the extreme, which we try to avoid but
        // allow). When collision PUSHES the boom in, we open the FOV a little so the closer
        // shot feels less claustrophobic and reveals more around the character. Suspended
        // while aiming, where the precise-aim zoom FOV must stay exact.
        this.collisionFovExtra = 12;    // extra degrees of FOV at a full collision push-in

        // --- High-angle pull-back. The further DOWN the camera looks, the further the boom
        // pulls back & up into a high overhead view, opening a gap so objects can travel
        // between the camera and the character. This only raises the DESIRED length —
        // collision still clamps it to the clearance, so it never trades away no-clip.
        //
        // The response is an EASE-OUT of the down angle (not the old ease-in square): pull-back
        // is PRIVILEGED — it engages strongly the instant the camera tilts even slightly down,
        // then ramps progressively to full, instead of staying flat until a steep angle and then
        // snapping back. Its own gentle ease (lookDownLerpSpeed, slower than the aim zoom) makes
        // the pull-back↔push-in transition glide rather than jump as you sweep the pitch.
        this.tpsLookDownExtra = 1.9;    // extra boom length at full look-down (m) — pull back
        this.lookDownLerpSpeed = 4.0;   // gentle ease for the look-down pull-back (1/s) — progressive
        this._curLookDown = 0;          // eased look-down boom extra (m)

        // --- Camera shake / recoil ("juice"): a subtle trauma-driven shake on taking
        // a hit and a tiny kick per shot. Kept ROTATION-ONLY (no positional shake) and
        // small, applied on top of the look orientation so the crosshair stays put. ---
        this._fxTime = 0.0;
        this.trauma = 0.0;              // 0..1; decays each frame
        this.traumaDecay = 2.0;        // trauma/sec (settles a touch quicker so hits don't linger as a shake)
        this.maxShakeRot = 0.009;      // radians at full trauma (small rotation only) — trimmed for less buzz
        this.recoilPitch = 0.0;        // transient view kick, recovers to 0
        this.recoilYaw = 0.0;
        this.recoilRecover = 11.0;     // 1/s settle rate (snappier recovery, less lingering wobble)
        // --- Accumulating recoil CLIMB (the spray pattern). The per-shot kick above settles instantly
        // (snappy juice); this is a SEPARATE, accumulating offset that walks the aim UP a touch on every
        // shot, so holding the trigger draws a rising vertical line of impacts (the shot is a camera-
        // centre ray, so the climb on the view IS the climb on the bullets). It HOLDS while you fire
        // (it only recovers once shots stop coming — see ApplyCameraShake) and is capped, so sustained
        // fire climbs to a ceiling then plateaus rather than running away. Applied in BOTH camera modes
        // (the shake/recoil path runs in FPS and TPS alike), so TPS gets the same recoil feel. Tuned
        // "moderate / controllable": a clear climb you can pull down against, not a wild flick.
        this.recoilClimb = 0.0;                                   // accumulated vertical climb (rad)
        this.recoilClimbPerShot = THREE.MathUtils.degToRad(0.5);  // per-shot climb step
        this.recoilClimbMax = THREE.MathUtils.degToRad(7.0);      // ceiling on the accumulated climb
        this.recoilClimbRecover = 7.0;                            // 1/s recovery toward 0 once firing STOPS
        this.recoilHoriz = 0.0;                                   // accumulated horizontal wander (rad)
        this.recoilHorizPerShot = THREE.MathUtils.degToRad(0.13); // per-shot horizontal random walk
        this.recoilHorizMax = THREE.MathUtils.degToRad(1.5);      // clamp so the column stays mostly vertical
        this.recoilFireHold = 0.18;                               // s without a shot before the climb starts recovering
        this._sinceShot = 999;                                    // s since the last shot (gates the climb recovery)
        this.aimRecoilClimbDamp = 0.5;                            // ADS scales the climb DOWN (more controllable aimed)
        // Precise aim must stay STEADY: while ADS the trauma shake + per-shot recoil kick are scaled
        // DOWN (not off — a hair of gun kick still reads) so the crosshair doesn't jitter while you
        // line up / hold a shot. The user's "camera shakes while aiming + shooting" complaint is this —
        // damped hard so sustained ADS fire stays calm (a clean, barely-there kick, not a buzz).
        this.aimShakeDamp = 0.16;
        this._shakeEuler = new THREE.Euler();
        this._shakeQuat = new THREE.Quaternion();

        // --- Aim-move wobble (TPS). While AIMING AND MOVING the body's hips are stabilized
        // (PlayerBody.StabilizeHips) for a steady aim, which reads unnaturally still in motion.
        // Add a gentle, footfall-paced sway to the VIEW so movement still registers. Rotation-only
        // (like the shake) so the reticle stays anchored. Scales mostly off an eased on/off weight
        // (so the deliberately-slow aim walk still conveys) plus a little speed.
        this._aimWobbleW = 0;                                  // eased 0..1 weight (aiming & moving)
        this.aimWobbleLerp = 6;                                // ease in/out rate (1/s)
        // Kept DELIBERATELY small: this exists only so the slow ADS walk doesn't read as a frozen
        // glide, but at the old 1.1° it presented as the "camera shakes when aiming" the user flagged.
        // Trimmed to a barely-there footfall breath — the aim stays steady enough to hold a shot.
        this.aimWobbleAmount = THREE.MathUtils.degToRad(0.4);  // peak roll sway (rad); pitch/yaw scale off this
        this.aimWobbleFreq = 5.0;                              // base stride frequency for the sway
        this._wobbleEuler = new THREE.Euler();
        this._wobbleQuat = new THREE.Quaternion();

        // --- Committed GROUND MOVE: shared by the directional dodge SLIDE (double-tap W/A/S/D) and the
        // hard-landing ROLL. A short, control-locked burst that drives the capsule along a fixed
        // direction (eased out near the end) with an optional i-frame window, then ALWAYS releases
        // control when the timer elapses — so it can never lock the player. The body plays the matching
        // clip and conforms it to the terrain (PlayerBody.StartGroundMove, via 'player.slide' /
        // 'player.landroll'). Works in TPS and FPS (the FP camera rides the head bone through the move).
        // (Off double-tap Ctrl — that collides with OS shortcuts a web page can't suppress.)
        this.rolling = false;
        this._moveKind = 'slide';        // 'slide' (double-tap dodge) | 'landroll' (hard landing)
        this.rollTimer = 0.0;
        this.rollDuration = 0.78;        // s of locked movement (recomputed from the active clip on start)
        this._committedSpeed = 10.0;     // start m/s of the active move (set per-kind on start)
        this._rollCooldownTimer = 0.0;
        this.rollDir = new THREE.Vector3();   // world-horizontal travel direction
        this._rollResidual = new THREE.Vector3();   // scratch: world move velocity
        this._yawInv = new THREE.Quaternion();      // scratch: inverse look-yaw (world->local)
        // PlayerHealth checks this.invulnerable; the committed move sets it across its i-frame window.
        this.invulnerable = false;
        // Per-kind tuning. speed: start m/s (the slide uses this; the land-roll overrides it with the
        // captured landing speed). endFactor: speed multiplier by the end (eases out). boost/decay: a
        // front-loaded launch surge — the slide kicks off with a pop; the land-roll just CONTINUES the
        // landing momentum, so no surge. iStart/iEnd: i-frame window (s into the move; the slide is a
        // dodge so it's nearly fully invulnerable, the land-roll only briefly). cooldown: s before
        // another move can start. (A one-shot impulse would be overwritten — UpdateRoll re-sets the
        // velocity each tick — so the surge is shaped per frame here.)
        this.moveCfg = {
            slide:    { speed: 8.5, endFactor: 0.45, boost: 0.6, decay: 9.0, iStart: 0.0, iEnd: 0.70, cooldown: 0.18 },
            landroll: { speed: 6.0, endFactor: 0.45, boost: 0.0, decay: 9.0, iStart: 0.0, iEnd: 0.35, cooldown: 0.15 },
        };
        // --- Hard-landing detection -> the land-roll. Track the PEAK descent speed across an airborne
        // stretch; on regrounding after falling faster than landRollFallSpeed, fire a forward roll that
        // carries the landing momentum (UpdateLandingDetect). Set just above a flat in-place jump's landing
        // (~5 m/s = jumpVelocity) so jumping on the spot doesn't roll, but any real drop/ledge does — tuned
        // low (5.5) so the roll shows up often on the uneven terrain. Spawn drop (~3.2 m/s) won't trigger it.
        this.landRollFallSpeed = 5.5;    // min peak descent speed (m/s) for a hard landing
        this.landRollMinSpeed = 5.0;     // floor on the roll-out speed (a straight drop still rolls forward)
        this.landRollMaxSpeed = 11.0;    // cap on the roll-out speed (a fast run-off-a-cliff won't over-shoot)
        this._maxFallSpeed = 0.0;        // peak descent speed seen this airborne stretch (m/s, +down)
        this._landWasGrounded = true;    // grounded state last frame, to edge-detect the touchdown
        // Double-tap detection for a MOVEMENT key (W/A/S/D). Input only reports held state, so we
        // edge-detect each key; a second tap of the SAME key inside doubleTapWindow fires a roll in
        // that key's (camera-relative) direction. Kept fairly tight so an ordinary quick re-tap while
        // moving rarely triggers an accidental dodge (the cooldown backs this up).
        this._moveKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];
        this._moveKeyPrev = { KeyW: 0, KeyS: 0, KeyA: 0, KeyD: 0 };
        this._lastTapKey = null;         // movement key whose first tap is awaiting a second
        this._lastTapTime = -10.0;       // _tapClock time of that first tap
        this.doubleTapWindow = 0.28;     // s between the two taps to count as a double-tap
        this._tapClock = 0.0;            // monotonic clock for tap timing (advanced each Update)
    }

    Initialize(){
        this.physicsComponent = this.GetComponent("PlayerPhysics");
        this.physicsBody = this.physicsComponent.body;
        this.physicsWorld = this.physicsComponent.world; // for the TPS boom raycast
        this.body = this.GetComponent('PlayerBody');     // head-bone eye in first-person
        this.transform = new Ammo.btTransform();
        this.zeroVec = new Ammo.btVector3(0.0, 0.0, 0.0);
        this.angles.setFromQuaternion(this.parent.Rotation);
        this.UpdateRotation();

        Input.AddMouseMoveListner(this.OnMouseMove);

        // Capture the resting FOV so precise-aim can zoom from / back to it.
        this.baseFov = this.camera.fov;
        this._curFov = this.camera.fov;

        // Remember the crisp third-person near plane, then apply the near for the
        // starting mode (FPS uses a larger near to cull the head mesh at the eye).
        this.tpsNear = this.camera.near;
        this.ApplyNearForMode();

        // Camera juice: shake on taking a hit, a kick per shot fired.
        this.parent.RegisterEventHandler(this.OnPlayerHit, 'hit');
        this.parent.RegisterEventHandler(this.OnWeaponShoot, 'weapon.shoot');
        // FPS reload pullback window: reload START -> pull the eye back; reload DONE -> ease it home. The
        // body broadcasts reload.done when its (visible) reload one-shot finishes (see PlayerBody).
        this.parent.RegisterEventHandler(this.OnReloadStart, 'weapon.reload');
        this.parent.RegisterEventHandler(this.OnReloadEnd, 'reload.done');

        // Right click holds precise-aim. (In FPS the arms viewmodel runs its own ADS
        // via Hands; this TPS aim only applies in the TPS camera branch below.)
        Input.AddMouseDownListner(e => { if(e.button === 2){ this.aiming = true; this._aimHeld = true; } });
        Input.AddMouseUpListner(e => { if(e.button === 2){ this.aiming = false; this._aimHeld = false; } });

        document.addEventListener('pointerlockchange', this.OnPointerlockChange)

        Input.AddClickListner( () => {
            // Only grab the pointer during live gameplay — never while a menu/overlay is up, or
            // clicking the title / pause / game-over / controls screens would lock the pointer and
            // hide the cursor (you couldn't press the buttons).
            if(!this.isLocked && !this.IsMenuOpen()){
                document.body.requestPointerLock();
            }
        });
    }

    // True while any full-screen menu/overlay is showing (display != none). Gates pointer lock.
    IsMenuOpen(){
        const ids = ['title-screen','loading-screen','gameover-screen','pause-screen','controls-overlay','settings-overlay'];
        for(const id of ids){
            const el = document.getElementById(id);
            if(el && getComputedStyle(el).display !== 'none'){ return true; }
        }
        return false;
    }

    OnPointerlockChange = () => {
        if (document.pointerLockElement) {
            this.isLocked = true;
            return;
        }

        this.isLocked = false;
    }

    OnMouseMove = (event) => {
        if (!this.isLocked || this.cameraOverride) {
          return;
        }

        const { movementX, movementY } = event

        // Finer aim while holding precise-aim in third-person.
        const sens = (this.cameraMode === 'TPS' && this.aiming)
            ? this.mouseSpeed * this.aimSensitivity
            : this.mouseSpeed;

        this.angles.y -= movementX * sens;
        this.angles.x -= movementY * sens;

        // Clamp the vertical look. FPS pulls the limit in ~10% (±90° -> ±81°) so you can't crane the view
        // all the way to straight up/down — the extremes are where the head-ridden FPS camera grazes the
        // body and the viewmodel pitch-lock works hardest. TPS keeps the full ±90°.
        const maxPitch = (this.cameraMode === 'FPS') ? (Math.PI / 2) * 0.9 : (Math.PI / 2);
        this.angles.x = Math.max(-maxPitch, Math.min(maxPitch, this.angles.x));

        this.UpdateRotation();
    }

    UpdateRotation(){
        this.pitch.setFromAxisAngle(this.xAxis, this.angles.x);
        this.yaw.setFromAxisAngle(this.yAxis, this.angles.y);

        // parent.Rotation is the single look orientation (yaw*pitch). The camera
        // is positioned/oriented from it each frame in Update, per camera mode, so
        // we no longer write camera.quaternion here.
        this.parent.Rotation.multiplyQuaternions(this.yaw, this.pitch).normalize();
    }

    ToggleCamera(){
        this.cameraMode = this.cameraMode === 'TPS' ? 'FPS' : 'TPS';
        // Drop aim on a mode switch; reseed the smoothed FOV from the live camera so
        // re-entering TPS doesn't jump (FPS ADS, owned by Hands, may have changed it).
        this.aiming = false;
        this._curFov = this.camera.fov;
        // The two modes place the camera in very different spots (head vs spline), so
        // snap to the new spot next frame rather than flying the camera through the
        // body, and swap the near plane (FPS culls the head).
        this._camInit = false;
        this._pivotInit = false;   // reseed the lagged follow-point so it snaps to the new mode's pivot
        this.ApplyNearForMode();
        // FPS uses a wider collision capsule (keeps the first-person body/arms off walls — fewer
        // wall-clip anim glitches); TPS uses the normal one. Same total height, so no vertical pop.
        if(this.physicsComponent){ this.physicsComponent.SetWide(this.cameraMode === 'FPS'); }
        this.Broadcast({topic: 'camera.mode', mode: this.cameraMode});
        const label = document.getElementById('camera_mode');
        if(label){ label.textContent = this.cameraMode; }
    }

    ApplyNearForMode(){
        this.camera.near = this.cameraMode === 'FPS' ? this.fpsNear : this.tpsNear;
        this.camera.updateProjectionMatrix();
    }

    // --- Camera juice hooks ---
    // Getting hit: a SMALL, quickly-settling shake — rotation ONLY (ApplyCameraShake never moves
    // the camera in space). Kept gentle: a bigger trauma read as a lurch/recoil "pull back". Tune.
    OnPlayerHit = () => { this.AddTrauma(0.25); }
    OnWeaponShoot = () => { this.AddRecoil(); }

    AddTrauma(amount){ this.trauma = Math.min(1.0, this.trauma + amount); }

    AddRecoil(){
        // Mostly a clean vertical kick; only a hair of horizontal jitter. Less trauma per shot so
        // sustained auto-fire doesn't pile into a buzzing view (it reads as a firm kick, not a shake).
        this.trauma = Math.min(1.0, this.trauma + 0.012);
        this.recoilPitch += 0.005;                          // small snappy kick up (per-shot feedback)
        this.recoilYaw += (Math.random() - 0.5) * 0.0014;   // very slight horizontal jitter
        // Accumulating climb (the spray pattern): walk the aim up a step and wander horizontally a hair,
        // both capped. Reset the since-shot timer so the climb HOLDS between rounds (only recovers once
        // the trigger is released — see ApplyCameraShake). Drives a rising vertical line of impacts.
        this.recoilClimb = Math.min(this.recoilClimbMax, this.recoilClimb + this.recoilClimbPerShot);
        this.recoilHoriz = THREE.MathUtils.clamp(
            this.recoilHoriz + (Math.random() - 0.5) * 2 * this.recoilHorizPerShot,
            -this.recoilHorizMax, this.recoilHorizMax);
        this._sinceShot = 0;
    }

    // Apply trauma-driven shake + the per-shot recoil kick on top of the look
    // orientation, then decay both. Keeps the crosshair fixed while the view shakes.
    ApplyCameraShake(t){
        this.trauma = Math.max(0.0, this.trauma - this.traumaDecay * t);
        const settle = Math.exp(-this.recoilRecover * t);
        this.recoilPitch *= settle;
        this.recoilYaw *= settle;

        // Accumulating climb: HOLD it while the trigger is being worked (shots keep resetting _sinceShot
        // to 0), and only let it recover once firing stops — that's what makes a held burst climb higher
        // and higher instead of settling to a steady plateau. Both the climb and the horizontal wander
        // recover together so the view eases back to centre after you release.
        this._sinceShot += t;
        if(this._sinceShot > this.recoilFireHold){
            const climbSettle = Math.exp(-this.recoilClimbRecover * t);
            this.recoilClimb *= climbSettle;
            this.recoilHoriz *= climbSettle;
        }

        // Steady the view while aiming: scale the whole shake + recoil contribution down so a precise
        // aim doesn't jitter (the crosshair, the gun barrel IK and the shot all read off this view).
        const steady = this.aiming ? this.aimShakeDamp : 1.0;
        // The CLIMB gets its own (gentler) ADS damp: aiming should still walk the shots up a controllable
        // amount, not flatten the pattern to nothing like the per-shot buzz does.
        const climbScale = this.aiming ? this.aimRecoilClimbDamp : 1.0;
        const shake = this.trauma * this.trauma * steady;   // ease-in so light trauma is subtle
        const f = this._fxTime;
        const recoilP = this.recoilPitch * steady + this.recoilClimb * climbScale;
        const recoilY = this.recoilYaw * steady + this.recoilHoriz * climbScale;

        // Rotation-only shake (no positional offset) so the camera never lurches in
        // space — just a small, quickly-settling jitter of the view angle, plus the
        // per-shot recoil kick AND the accumulating climb (recoilP/recoilY carry both).
        const rp = (shake > 0.0001 ? Math.sin(f * 59.0) * shake * this.maxShakeRot : 0) + recoilP;
        const ry = (shake > 0.0001 ? Math.sin(f * 43.0 + 0.5) * shake * this.maxShakeRot : 0) + recoilY;
        const rz = shake > 0.0001 ? Math.sin(f * 67.0 + 1.1) * shake * this.maxShakeRot * 0.6 : 0;
        if(rp || ry || rz){
            this._shakeEuler.set(rp, ry, rz);
            this._shakeQuat.setFromEuler(this._shakeEuler);
            this.camera.quaternion.multiply(this._shakeQuat);
        }
    }

    // While AIMING AND MOVING in TPS, add a gentle footfall-paced sway to the view. The aim pose
    // stabilizes the hips, so without this the moving aim reads too still; this puts a little
    // movement back into the camera. Rotation-only (composed on top of the look) so the crosshair
    // stays anchored. Eased in/out so entering/leaving aim or stopping glides rather than pops.
    ApplyAimMoveWobble(t){
        const moving = this.HorizontalSpeed > 0.5 && this.IsGrounded;
        const active = (this.cameraMode === 'TPS' && this.aiming && moving) ? 1 : 0;
        this._aimWobbleW += (active - this._aimWobbleW) * (1 - Math.exp(-this.aimWobbleLerp * t));
        if(this._aimWobbleW < 0.001){ return; }

        // Mostly the eased weight (the aim walk is intentionally slow) plus a touch more the faster
        // you go, so a sprint-aim conveys a bit harder than a creep.
        const speedRatio = THREE.MathUtils.clamp(this.HorizontalSpeed / this.walkSpeed, 0, 1.6);
        const amp = this.aimWobbleAmount * (0.6 + 0.4 * speedRatio) * this._aimWobbleW;
        const f = this._fxTime * this.aimWobbleFreq * (0.7 + 0.3 * speedRatio);

        // Footfall feel: vertical bob at 2x the stride; lateral roll + a little yaw at the stride.
        const rp = Math.sin(f * 2.0) * amp * 0.6;   // pitch bob (up/down per footfall)
        const rz = Math.sin(f) * amp;               // roll sway (side to side per stride)
        const ry = Math.cos(f) * amp * 0.4;         // slight yaw drift
        this._wobbleEuler.set(rp, ry, rz);
        this._wobbleQuat.setFromEuler(this._wobbleEuler);
        this.camera.quaternion.multiply(this._wobbleQuat);
    }

    // Place the first-person eye on the body's head bone (+ a small forward/up nudge onto the eye
    // line), flooring the height during a roll so the somersault dips hard but never clips the floor.
    //
    // STROBE FIX. Components update Controls-BEFORE-Body, so the eye placed during UpdateCamera reads
    // the head bone from LAST frame's pose while the gun/arms render at THIS frame's — a one-frame
    // desync that reads as the viewmodel strobing/juddering against the view when you turn. PlayerBody
    // re-calls this at the END of its Update (after it has posed the body), so the eye and the gun it
    // holds are locked to the same frame. Reading the head bone (animation), not the camera, so there
    // is no feedback loop. capPos is the capsule eye position (Player.Position).
    PlaceFpsEyePosition(capPos, t = 0, smooth = false){
        if(this.cameraMode !== 'FPS' || !this.camera){ return; }
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        // While AIMING, take the eye's back-offset (fpsEyeForward) along the YAW-ONLY (horizontal) forward
        // so the eye POSITION no longer rises/sinks with the look pitch. That pitch-driven vertical swing
        // would slide the camera-locked gun (PlayerBody.UpdateFpsViewmodelPitch) off the crosshair as you
        // tilt up/down — the eye is the lock's orbit pivot, so it must hold still in the body frame. At the
        // hip keep the full-look offset (it tucks the eye behind the low-held gun). Eased via _fpsAimEyeEase.
        if(this._fpsAimEyeEase > 1e-4){
            this._fwdFlat.copy(this._fwdBase).applyQuaternion(this.yaw);
            this._fwd.lerp(this._fwdFlat, this._fpsAimEyeEase).normalize();
        }
        if(this.body && this.body.GetHeadWorldPosition(this._headPos)){
            this._camTarget.copy(this._headPos)
                .addScaledVector(this._fwd, this.fpsEyeForward);
            this._camTarget.y += this.fpsEyeUp;
            // Cancel the FPS body lateral offset: PlayerBody slides the whole body (and so the head bone)
            // to the player's left to reveal the right arm; subtracting that same vector keeps the view
            // anchored to the head, not dragged by the body slide.
            if(this.body.fpsBodyOffset){ this._camTarget.sub(this.body.fpsBodyOffset); }
            // Shift the camera to the player's RIGHT (camera-right is horizontal under yaw*pitch).
            if(this.fpsEyeRight){
                this._right.copy(this._rightBase).applyQuaternion(this.parent.Rotation);
                this._camTarget.addScaledVector(this._right, this.fpsEyeRight);
            }
        }else{
            this._camTarget.copy(capPos);
        }
        // Reload pullback: ease the eye BACK along look-forward (and a touch up) while reloading, so the
        // weapon + hands drop into frame and the reload animation reads instead of happening off-screen.
        if(this._reloadEased > 1e-3){
            this._camTarget.addScaledVector(this._fwd, -this.fpsReloadPullback * this._reloadEased);
            this._camTarget.y += this.fpsReloadUp * this._reloadEased;
        }
        // Look-DOWN forward push: slide the eye FORWARD over the chest as the view tilts down, so the
        // hidden head's neck-stump gap stays behind the camera (see fpsLookDownForward). Horizontal
        // (yaw-only) forward, so a steep down-look pushes over the body rather than into the floor.
        if(this._fpsLookDownEased > 1e-4){
            this._fwdFlat.copy(this._fwdBase).applyQuaternion(this.yaw);
            this._camTarget.addScaledVector(this._fwdFlat, this.fpsLookDownForward * this._fpsLookDownEased);
        }
        // Look-UP compensation: lift the eye UP over the rising gun (so the crosshair clears) and a touch
        // BACK along the yaw-only forward (so the lens leaves the shoulder geo it was clipping through).
        // A HIP-only dodge — _fpsLookUpEased is already faded out while aiming (the camera-locked ADS gun
        // needs no dodge). Keeps the level framing intact (zero at level) while clearing the tilted-up gun.
        if(this._fpsLookUpEased > 1e-4){
            this._camTarget.y += this.fpsLookUpUp * this._fpsLookUpEased;
            this._fwdFlat.copy(this._fwdBase).applyQuaternion(this.yaw);
            this._camTarget.addScaledVector(this._fwdFlat, -this.fpsLookUpBack * this._fpsLookUpEased);
        }
        // Aiming look-DOWN shift: while ADS and tilting down, slide the eye FORWARD (yaw-only) over the
        // chest and a touch UP. The ADS viewmodel is camera-locked (gun pinned camera-local, arms+hands
        // carried onto it), so moving the eye carries the WHOLE viewmodel — camera, gun, arms, hands —
        // forward off the body instead of orbiting down THROUGH it. Standing + crouched alike; the gun
        // stays on the reticle because the lock is eye-relative. See fpsAimLookDownForward.
        if(this._fpsAimLookDownEased > 1e-4){
            this._fwdFlat.copy(this._fwdBase).applyQuaternion(this.yaw);
            this._camTarget.addScaledVector(this._fwdFlat, this.fpsAimLookDownForward * this._fpsAimLookDownEased);
            this._camTarget.y += this.fpsAimLookDownUp * this._fpsAimLookDownEased;
        }
        // (FootIK terrain-drop eye compensation removed.) The FPS gun is now the CAMERA-AUTHORITATIVE
        // viewmodel (PlayerBody.UpdateFpsViewmodel): it is recomputed as eye + camQuat·offset every frame
        // AFTER this eye is placed, so it rides the eye in lockstep and re-points the barrel at the crosshair
        // regardless of how the terrain bobs the head bone the eye sits on. The old code cancelled FootIK's
        // _hipDrop here to hold the world-locked gun steady against a bobbing eye — that mismatch no longer
        // exists, so the terrain bob is simply a subtle, intended weapon-and-view bob.
        if(this.rolling){
            this._camTarget.y = Math.max(this._camTarget.y, capPos.y - 0.45);
        }
        // Low-pass the eye HEIGHT only (see fpsEyeYLerp): steadies the walk/terrain vertical bob while
        // turning (x/z) stays exact and the body gun keeps its bob. Only the authoritative end-of-frame
        // re-call (PlayerBody, smooth=true with a real dt) advances the filter; the start-of-frame call
        // (Controls, smooth=false) places raw and is overwritten this same frame. Snap while airborne/
        // rolling so a jump/fall/landing tracks the capsule 1:1 (then the smoothing re-seeds on landing).
        if(smooth && t > 0){
            const grounded = this.IsGrounded && !this.rolling;
            // While AIMING, track the body's vertical TIGHTLY (fpsAimEyeYLerp >> fpsEyeYLerp). The ADS
            // viewmodel is camera-locked to the eye (PlayerBody.UpdateFpsViewmodelPitch); the slow walk/
            // terrain low-pass made the eye LAG the body's vertical drop on a crouch (and FootIK's hip-drop
            // bleeds off over seconds), so the camera-locked gun sank below the crosshair until it settled —
            // the reported crouch-ADS "gun too low". The strafe terrain BOB is instead cancelled directly by
            // the foot-plant compensation above (not by smoothing here), so this can stay tight for crouch.
            const eyeLerp = this.aiming ? this.fpsAimEyeYLerp : this.fpsEyeYLerp;
            if(!this._fpsEyeYSeeded || !grounded){ this._fpsEyeY = this._camTarget.y; this._fpsEyeYSeeded = true; }
            else { this._fpsEyeY += (this._camTarget.y - this._fpsEyeY) * (1 - Math.exp(-eyeLerp * t)); }
            this._camTarget.y = this._fpsEyeY;
        }
        this.camera.position.copy(this._camTarget);
    }

    // Place the camera for the current mode. capPos is the capsule-tracked
    // position (eye height); it is also Player.Position so NPC targeting/raycasts
    // are camera-mode-independent.
    UpdateCamera(capPos, t = 0.016){
        this._fxTime += t;
        // Crouch camera drop (applied to the TPS pivot below) — driven by the BODY's own eased crouch
        // blend (PlayerBody._crouchEased), an already-smoothed S-curve with ~zero start velocity, so the
        // camera and the crouching body move in LOCKSTEP: smooth in/out, synced to the actual crouch
        // descent (incl. the fast uncrouch-into-jump), with no separate velocity step. (An independent
        // exp-ease here front-loaded its velocity — the camera lurched down faster than the body crouched
        // at the start, which read as a non-smooth transition.) Falls back to a local exp-ease only if the
        // body isn't wired yet. Computed before the FPS early-out so it never jumps on a mode switch; FPS
        // lowers via the head bone (the body's pelvis drop), so it's not used there.
        if(this.body){
            this._crouchCamEased = this.crouchCamDrop * this.body._crouchEased;
        }else{
            this._crouchCamEased += ((this.crouching ? this.crouchCamDrop : 0) - this._crouchCamEased)
                * (1 - Math.exp(-this.crouchCamLerp * t));
        }

        if(this.cameraMode === 'FPS'){
            // Wide first-person FOV (eased), tightening a touch while aiming for a subtle ADS zoom.
            const targetFov = this.aiming ? this.fpsAimFov : this.fpsFov;
            this._curFov += (targetFov - this._curFov) * Math.min(1, t * this.aimLerpSpeed);
            this.camera.fov = this._curFov;
            this.camera.updateProjectionMatrix();
            // Ease the reload pullback (eye eases back so the reload anim is visible — see PlaceFpsEyePosition).
            const reloadTarget = this._reloading ? 1 : 0;
            this._reloadEased += (reloadTarget - this._reloadEased) * (1 - Math.exp(-this.reloadPullLerp * t));
            // ADS suppresses the pitch-driven eye dodges below. They exist to keep the HIP gun framed
            // (slide the eye forward/up past the gun as you tilt), but while AIMING the viewmodel is
            // CAMERA-LOCKED (PlayerBody.UpdateFpsViewmodelPitch keeps the gun glued under the crosshair),
            // and any eye translation relative to the body would slide the locked gun off the reticle. So
            // ease these to zero as ADS engages — the camera then truly holds its spot down the sights.
            this._fpsAimEyeEase += ((this.aiming ? 1 : 0) - this._fpsAimEyeEase) * (1 - Math.exp(-this.aimLerpSpeed * t));
            const eyeDodge = 1 - this._fpsAimEyeEase;
            // Ease the look-DOWN forward push (eye slides forward past the hidden-head neck gap as you look
            // down — see PlaceFpsEyePosition). angles.x < 0 is looking down; ramp 0 (level/up) -> 1 (straight down).
            const lookDownN = eyeDodge * Math.max(0, -this.angles.x / (Math.PI * 0.5));
            this._fpsLookDownEased += (lookDownN - this._fpsLookDownEased) * (1 - Math.exp(-this.fpsLookDownLerp * t));
            // Look-UP compensation amount (angles.x > 0 is looking up): ramp 0 (level/down) -> 1 (straight up).
            const lookUpN = eyeDodge * Math.max(0, this.angles.x / (Math.PI * 0.5));
            this._fpsLookUpEased += (lookUpN - this._fpsLookUpEased) * (1 - Math.exp(-this.fpsLookUpLerp * t));
            // Aiming look-DOWN shift amount: the INVERSE of eyeDodge — ON only while ADS — times the
            // look-down ramp (0 level/up -> 1 straight down). Drives the eye+viewmodel forward push in
            // PlaceFpsEyePosition so the camera-locked gun/arms clear the body instead of clipping through.
            const aimLookDownN = this._fpsAimEyeEase * Math.max(0, -this.angles.x / (Math.PI * 0.5));
            this._fpsAimLookDownEased += (aimLookDownN - this._fpsAimLookDownEased) * (1 - Math.exp(-this.fpsLookDownLerp * t));
            // Same character as third-person: the eye rides the mesh's head bone, so the walk/run
            // animation gives a subtle, real head bob. PlaceFpsEyePosition sets the eye position; it is
            // also re-called by PlayerBody AFTER it has posed the body this frame (see the note there)
            // so the eye stays locked to the SAME-frame head — without that re-call the eye reads last
            // frame's pose (Controls update before Body) and the gun/arms strobe against it on a turn.
            this.PlaceFpsEyePosition(capPos);
            this._camInit = true;
            this.camera.quaternion.copy(this.parent.Rotation);
            this.ApplyCameraShake(t);
            this._camDist = this.tpsDistance;   // FPS: report "far" so TPS-only proximity logic is inert
            return;
        }

        // Pitch as a normalised factor: -1 looking straight down, +1 straight up.
        // downN ramps 0 (level/up) -> 1 (straight down) and drives the high-angle behaviour.
        const pitchN = THREE.MathUtils.clamp(this.angles.x / (Math.PI * 0.5), -1, 1);
        const downN = Math.max(0, -pitchN);

        // Sprint pullback: ease an extra boom length in/out on its own gentle rate while
        // running (suspended while aiming so precise-aim stays tight). Folded into the
        // distance target below, so it rides the same smooth path as everything else.
        const sprintTarget = (this.isSprinting && !this.aiming) ? this.tpsSprintExtra : 0;
        this._curSprint += (sprintTarget - this._curSprint) * (1 - Math.exp(-this.sprintLerpSpeed * t));

        // Walk-start pull-back: a small extra boom length while jogging (any ground movement), so the
        // camera eases back a touch as the player starts walking. Suspended while aiming (tight ADS);
        // stacks under the sprint pullback. Folded into the distance target below alongside the sprint
        // term. Crouch is deliberately NOT excluded: the camera must behave IDENTICALLY crouched or
        // standing — excluding it dollied the boom 0.5 m on a mid-walk crouch AND flipped the pivot
        // follow to the rigid idle rate, which fed every faceted-terrain bump straight into the view
        // (the "camera jitters while crouched" complaint).
        const jogging = this.HorizontalSpeed > 0.5 && !this.aiming;
        const walkTarget = jogging ? this.tpsWalkExtra : 0;
        this._curWalk += (walkTarget - this._curWalk) * (1 - Math.exp(-this.walkLerpSpeed * t));

        // Looking DOWN pulls the boom back & up into a high-angle view, opening a gap so objects
        // can pass between the camera and the character rather than being shoved against the lens.
        // EASE-OUT of the down angle (downN*(2-downN)) so the pull-back is privileged — it kicks
        // in noticeably at a small down pitch and ramps progressively to full, instead of the old
        // ease-in square that stayed flat until a steep angle and then snapped. It rides its OWN
        // gentle ease (below) so sweeping the pitch glides between pulled-back and pushed-in.
        const lookDownExtra = downN * (2.0 - downN) * this.tpsLookDownExtra;
        this._curLookDown += (lookDownExtra - this._curLookDown) * (1 - Math.exp(-this.lookDownLerpSpeed * t));

        // Ease the boom length / shoulder offset / FOV toward their precise-aim or
        // hip targets so toggling right click glides in and out of the zoom.
        const k = Math.min(1, t * this.aimLerpSpeed);
        const targetDistance = (this.aiming ? this.tpsAimDistance : this.tpsDistance) + this._curSprint + this._curWalk;
        const targetShoulder = this.aiming ? this.tpsAimShoulder : this.tpsShoulder;
        const targetFov      = this.aiming ? this.tpsAimFov      : this.baseFov;
        this._curDistance += (targetDistance - this._curDistance) * k;
        this._curShoulder += (targetShoulder - this._curShoulder) * k;
        this._curFov      += (targetFov      - this._curFov)      * k;
        // Total rest boom = the (aim/sprint) length plus the smoothly-eased look-down pull-back.
        const boom = this._curDistance + this._curLookDown;
        // FOV is applied AFTER the boom length is resolved (below), so a collision
        // push-in can widen it.

        // TPS spring-arm spline. The camera rides a straight line from the CENTRED pivot
        // (above the head) out to the over-the-shoulder REST point; collision only ever dollies
        // it ALONG that line — closer or further — never sideways. Every point on the line
        // shares one direction from the pivot, so the character keeps its framing at any boom
        // length (it just scales as the camera nears): nothing lateral to "centre", nothing to
        // swing, no glitch.
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        this._right.copy(this._rightBase).applyQuaternion(this.parent.Rotation);
        this._pivot.copy(capPos);
        this._pivot.y += this.tpsPivotHeight - this._crouchCamEased;   // CENTRED pivot — start of the spline (steady while crouched)

        // Walk-start follow LAG: ease the actual follow-point toward the true pivot. The catch-up RATE is
        // near-rigid when standing (snappy framing) and noticeably laggier once jogging, so the camera
        // trails and smoothly catches up as the player breaks into a jog. Rigid (no lag) while aiming or
        // crouched so ADS and the crouch stay locked. Computed entirely on the pivot, so collision (which
        // sweeps from this pivot) is unaffected. The rate itself eases so jog-start/stop don't snap.
        const followTarget = jogging ? this.pivotFollowMove : this.pivotFollowIdle;
        this._pivotFollowRate += (followTarget - this._pivotFollowRate) * (1 - Math.exp(-this.pivotFollowLerp * t));
        if(!this._pivotInit){ this._pivotSmooth.copy(this._pivot); this._pivotInit = true; }
        else { this._pivotSmooth.lerp(this._pivot, 1 - Math.exp(-this._pivotFollowRate * t)); }
        this._pivot.copy(this._pivotSmooth);

        // Far end of the spline: behind by the (aim/sprint + look-down) distance + over the shoulder.
        this._free.copy(this._pivot)
            .addScaledVector(this._fwd, -boom)
            .addScaledVector(this._right, this._curShoulder);

        // Sweep a sphere from the pivot to the rest point; the hit fraction is how far out the
        // camera may sit along the line (0..1). No static hit => fully out (1).
        let safeT = 1;
        if(this.physicsWorld && AmmoHelper.SphereSweep(
            this.physicsWorld, this.camRadius, this._pivot, this._free, this._sweepRes, CollisionFilterGroups.StaticFilter)
            && this._sweepRes.fraction < 1){
            safeT = this._sweepRes.fraction;
        }
        // Floor the dolly so the camera never comes closer to the pivot than tpsMinDistance —
        // it HOLDS back rather than jamming into the head (the body dither + near cull cover the
        // close shot). Expressed as the matching fraction along this spline's length.
        const splineLen = Math.max(0.001, this._pivot.distanceTo(this._free));
        const minT = Math.min(1, this.tpsMinDistance / splineLen);
        const targetT = Math.max(safeT, minT);
        // Dolly toward the target. Pull IN (targetT below where we are — a wall encroaching) is
        // INSTANT so the camera keeps up with walking/running into cover and can never slide
        // through geometry; pull OUT (the wall clearing) eases so it glides back rather than
        // popping. With the spline the in-snap is a pure dolly — the framing never moves — so it
        // does not read as the old lateral "jump".
        if(!this._camInit || targetT < this._curT){
            this._curT = targetT;
            this._camInit = true;
        }else{
            this._curT += (targetT - this._curT) * (1 - Math.exp(-this.boomReturnRate * t));
        }

        // Position: slide the camera along the spline by the lagged dolly param.
        this.camera.position.copy(this._pivot).lerp(this._free, this._curT);
        // Orientation is ALWAYS exactly the player's look (yaw*pitch) — the camera never imposes
        // any pitch/yaw/roll of its own; collision only dollies it along the spline above. lookAt
        // is intentionally NOT used: with the shoulder offset it would tilt the view sideways.
        this.camera.quaternion.copy(this.parent.Rotation);

        // Collision push-in widens the FOV a touch (never while aiming): the further the dolly
        // is drawn in along the spline (1 - _curT), the more FOV eases in, softening the close
        // shot. Driven by the already-lagged dolly param, so it glides.
        let fov = this._curFov;
        if(!this.aiming){
            const pushIn = THREE.MathUtils.clamp(1 - this._curT, 0, 1);
            fov += pushIn * this.collisionFovExtra;
        }
        this.camera.fov = fov;

        // Close-mesh cull: push the near plane OUT as the camera nears the character, so meshes
        // very close to the lens are clipped rather than smeared across the view. Mapped from the
        // camera's distance to the pivot — tpsNearMax at tpsMinDistance, tpsNear by tpsNearGrowDist.
        const camDist = this._curT * splineLen;
        this._camDist = camDist;   // expose the live camera->pivot distance for CameraProximity
        this.camera.near = THREE.MathUtils.clamp(
            THREE.MathUtils.mapLinear(camDist, this.tpsMinDistance, this.tpsNearGrowDist, this.tpsNearMax, this.tpsNear),
            this.tpsNear, this.tpsNearMax);
        this.camera.updateProjectionMatrix();

        this.ApplyAimMoveWobble(t);
        this.ApplyCameraShake(t);
    }

    // Resolve the world point under the crosshair by casting the SAME camera-centre ray the weapon
    // fires (Weapon.Raycast: screen-centre near->far unproject). Stored on this.aimTarget for the
    // weapon-alignment + hand IK (PlayerBody/WeaponAimIK) so the visible barrel points exactly where
    // the bullet goes. Runs AFTER the camera is placed each frame, with the camera matrix refreshed
    // so the unproject is current (no one-frame lag). No self-filter: the ray is identical to the
    // shot, so the aim target is exactly the shot's hit point. Cheap: one physics raycast per frame
    // (the boom already sweeps a sphere every frame).
    UpdateAimTarget(t = 0.016){
        if(!this.physicsWorld || !this.camera){ return; }
        this.camera.updateMatrixWorld();
        this.camera.getWorldPosition(this.aimOrigin);
        // Crosshair ray: NDC centre at the near and far planes, unprojected to world space.
        this._aimNear.set(0, 0, -1).unproject(this.camera);
        this._aimFar.set(0, 0, 1).unproject(this.camera);
        this.aimDir.copy(this._aimFar).sub(this._aimNear);
        if(this.aimDir.lengthSq() < 1e-12){ this.aimDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion); }
        this.aimDir.normalize();
        // FX-free crosshair direction from the PURE look orientation (parent.Rotation = yaw*pitch). The
        // camera quaternion above carries the shake + ADS-walk wobble (applied in UpdateCamera); aimDir
        // therefore jitters with them. The cosmetic head-aim consumes aimDirRaw so the head doesn't
        // inherit that view jitter, while the gun/shot keep using the FX-affected aimDir/aimTarget.
        this.aimDirRaw.set(0, 0, -1).applyQuaternion(this.parent.Rotation).normalize();

        const mask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;
        let rawDist;
        if(AmmoHelper.CastRay(this.physicsWorld, this._aimNear, this._aimFar, this._aimHit, mask)){
            rawDist = this.aimOrigin.distanceTo(this._aimHit.intersectionPoint);
            this.aimTargetValid = true;
        }else{
            // Nothing hit: aim a far point straight down the crosshair (still a correct DIRECTION).
            rawDist = this.aimMaxDistance;
            this.aimTargetValid = false;
        }
        // Low-pass the DEPTH only; the direction (aimDir) stays the live crosshair. aimTarget rides the
        // crosshair laterally with no lag, but glides along the ray when the hit depth jumps at an edge.
        if(!this._aimDistSeeded){ this._aimDistSmooth = rawDist; this._aimDistSeeded = true; }
        else{ this._aimDistSmooth += (rawDist - this._aimDistSmooth) * (1 - Math.exp(-this.aimDistLerp * t)); }
        this.aimDistance = this._aimDistSmooth;
        this.aimTarget.copy(this.aimOrigin).addScaledVector(this.aimDir, this._aimDistSmooth);
    }

    Accelarate = (direction, t) => {
        const accel = this.tempVec.copy(direction).multiplyScalar(this.acceleration * t);
        this.speed.add(accel);
        this.speed.clampLength(0.0, this.maxSpeed);
    }

    Deccelerate = (t) => {
        const frameDeccel = this.tempVec.copy(this.speed).multiplyScalar(this.decceleration * t);
        this.speed.add(frameDeccel);
    }

    // Hand camera control to a dev tool (or take it back). While overridden the
    // player is frozen in place and the camera is left for the tool to drive.
    SetCameraOverride(on){
        this.cameraOverride = on;
    }

    // Dev placement-hold (FPS): freeze the player but KEEP the real first-person camera + aim pose, so the
    // weapon-placement tool can nudge the grip in its true ADS framing without the camera or aim drifting.
    // The aim state is latched (held) for the duration so HOLD/RELEASE of right click can't flip the grip
    // mode mid-edit. Unlike SetCameraOverride this does NOT yield the camera to a free-fly cam.
    SetPlacementHold(on, aim = false){
        this.placementHold = on;
        this._placementAim = !!aim;
        if(on){ this.aiming = !!aim; this._aimHeld = !!aim; }
    }

    OnReloadStart = () => { this._reloading = true; }
    OnReloadEnd = () => { this._reloading = false; }

    // Edge-detect the movement keys and start a directional SLIDE on a double-tap of the SAME key
    // inside doubleTapWindow. Input only reports HELD state, so we track each key's previous frame to
    // find press edges and time the gap.
    UpdateRollInput(){
        for(const code of this._moveKeys){
            const down = Input.GetKeyDown(code);
            if(down && !this._moveKeyPrev[code]){
                if(this._lastTapKey === code && (this._tapClock - this._lastTapTime) <= this.doubleTapWindow){
                    this._lastTapKey = null;                 // consume the pair so a third tap can't re-fire
                    this.TryStartSlide(code);
                }else{
                    this._lastTapKey = code;                 // first tap (or a different key): arm it
                    this._lastTapTime = this._tapClock;
                }
            }
            this._moveKeyPrev[code] = down;
        }
    }

    // Start a SLIDE only from the ground and outside the cooldown (no air-dodge / no chaining). The
    // slide travels in the double-tapped key's direction, in the camera's horizontal frame: W forward,
    // S back, D/A strafe; falls back to camera-forward.
    TryStartSlide(dirCode){
        if(this.rolling || this._rollCooldownTimer > 0 || !this.IsGrounded){ return; }
        // Slide direction from the tapped key, in the camera's horizontal frame (tempVec/moveDir are
        // free scratch here: a moving frame returns before the normal movement path uses them).
        const fwd = this.tempVec.set(0, 0, -1).applyQuaternion(this.yaw);
        const right = this.moveDir.set(1, 0, 0).applyQuaternion(this.yaw);
        if(dirCode === 'KeyS'){ this.rollDir.copy(fwd).negate(); }
        else if(dirCode === 'KeyD'){ this.rollDir.copy(right); }
        else if(dirCode === 'KeyA'){ this.rollDir.copy(right).negate(); }
        else{ this.rollDir.copy(fwd); }                      // KeyW / fallback
        this.rollDir.y = 0;
        if(this.rollDir.lengthSq() < 1e-6){ this.rollDir.copy(fwd); this.rollDir.y = 0; }
        this.rollDir.normalize();
        // Couple the control-lock length to the ACTUAL slide clip at its played-back rate (so retuning
        // slideTimeScale / swapping Slide.glb keeps movement, i-frames and animation in lockstep).
        const dur = (this.body && this.body._slideDuration > 0 && this.body.slideTimeScale > 0)
            ? this.body._slideDuration / this.body.slideTimeScale : 0.78;
        this._beginCommittedMove('slide', dur);
        this.Broadcast({topic: 'player.slide'});             // PlayerBody plays the slide animation
    }

    // Start the HARD-LANDING roll: a committed forward roll-out that carries the landing momentum. Fired
    // by UpdateLandingDetect on a fast touchdown (NOT player input), so it bypasses the cooldown/ground
    // guards the slide uses. Direction = the current horizontal travel (or facing if landing dead-stop).
    TryStartLandRoll(){
        if(this.rolling){ return; }
        // Direction: the live horizontal velocity if moving, else the camera-forward (a straight drop
        // still rolls forward rather than picking a random heading).
        const vel = this.physicsBody.getLinearVelocity();
        this.rollDir.set(vel.x(), 0, vel.z());
        const horiz = this.rollDir.length();
        if(horiz < 0.5){ this.rollDir.copy(this.tempVec.set(0, 0, -1).applyQuaternion(this.yaw)); this.rollDir.y = 0; }
        this.rollDir.normalize();
        // Roll-out speed carries the landing momentum, clamped so a straight drop still rolls and a
        // run-off-a-cliff doesn't shoot across the map.
        this._committedSpeed = THREE.MathUtils.clamp(
            Math.max(horiz, this.landRollMinSpeed), this.landRollMinSpeed, this.landRollMaxSpeed);
        const dur = (this.body && this.body._rollDuration > 0 && this.body.rollTimeScale > 0)
            ? this.body._rollDuration / this.body.rollTimeScale : 0.78;
        this._beginCommittedMove('landroll', dur);
        this.Broadcast({topic: 'player.landroll'});          // PlayerBody plays the roll animation
    }

    // Shared committed-move startup (slide + land-roll): lock control, force-stand, seed the timer +
    // per-kind speed. The body is force-stood because both clips assume a standing body and the crouch
    // input block is skipped while moving (best-effort — low cover keeps it crouched). AIM: the SLIDE
    // PRESERVES it (you can ADS/fire mid-slide — PlayerBody keeps the gun on the crosshair via the aim IK),
    // so it tracks the held button; the land-roll drops it (you can't aim through a tumble). Either way the
    // mouse listeners keep `aiming` live on press/release during the move, and UpdateRoll restores
    // _aimHeld on completion.
    _beginCommittedMove(kind, duration){
        this._moveKind = kind;
        this.rolling = true;
        this.rollTimer = 0.0;
        this.rollDuration = duration;
        this.aiming = (kind === 'slide') ? this._aimHeld : false;
        if(kind === 'slide'){ this._committedSpeed = this.moveCfg.slide.speed; }   // land-roll set its own speed
        this._crouchToggle = false;
        this.physicsComponent.SetCrouched(false);
    }

    // Hard-landing watch: accumulate the PEAK descent speed while airborne, and on the airborne->grounded
    // edge fire a land-roll if that peak exceeded landRollFallSpeed. Gated on !rolling so a slide that
    // sails off a ledge doesn't immediately re-trigger on touchdown. Cheap; runs once per frame.
    UpdateLandingDetect(){
        const grounded = this.IsGrounded;
        if(!grounded){
            const vy = this.physicsBody.getLinearVelocity().y();
            if(-vy > this._maxFallSpeed){ this._maxFallSpeed = -vy; }   // track fastest DESCENT (+down)
        }else{
            // Touchdown edge: if we fell hard and aren't already in a move, roll out of the landing.
            if(!this._landWasGrounded && !this.rolling && this._rollCooldownTimer <= 0
               && this._maxFallSpeed >= this.landRollFallSpeed){
                this.TryStartLandRoll();
            }
            this._maxFallSpeed = 0.0;                       // reset the peak once grounded
        }
        this._landWasGrounded = grounded;
    }

    // Drive the active committed move (slide / land-roll) each frame: a forward velocity burst (eased
    // out toward the end) with an i-frame window, then release control back to the normal movement path.
    // ALWAYS ends on the timer so the player can never get locked. Mirrors the normal capsule/camera
    // placement. Tuning comes from moveCfg[_moveKind]; _committedSpeed is the per-move start speed.
    UpdateRoll(t){
        const cfg = this.moveCfg[this._moveKind] || this.moveCfg.slide;
        this.rollTimer += t;
        const u = Math.min(1.0, this.rollTimer / this.rollDuration);
        this.invulnerable = (this.rollTimer >= cfg.iStart && this.rollTimer <= cfg.iEnd);

        // Momentum from _committedSpeed easing down to *endFactor across the move, with an optional
        // front-loaded surge (decays over the first ~0.1 s of u) so the slide launches with a pop. The
        // land-roll sets boost 0, so it just continues the captured landing momentum, eased out.
        const burst = 1 + cfg.boost * Math.exp(-cfg.decay * u);
        const speed = this._committedSpeed * (1 - (1 - cfg.endFactor) * u) * burst;
        const velocity = this.physicsBody.getLinearVelocity();
        velocity.setX(this.rollDir.x * speed);
        velocity.setZ(this.rollDir.z * speed);
        this.physicsBody.setLinearVelocity(velocity);
        this.physicsBody.setAngularVelocity(this.zeroVec);
        // Mirror the move velocity into the LOCAL (pre-yaw) speed so HorizontalSpeed reports the
        // motion AND the residual handed to the normal decel path continues along the ACTUAL world
        // travel direction (rollDir) — not a stale local vector reinterpreted against a camera the
        // player may have spun mid-move. speed_local = yaw⁻¹ · (rollDir * speed).
        this._rollResidual.copy(this.rollDir).multiplyScalar(speed);
        this._yawInv.copy(this.yaw).invert();
        this.speed.copy(this._rollResidual).applyQuaternion(this._yawInv);

        const ms = this.physicsBody.getMotionState();
        if(ms){
            ms.getWorldTransform(this.transform);
            const p = this.transform.getOrigin();
            this._cap.set(p.x(), p.y() + this.yOffset, p.z());
            this.parent.SetPosition(this._cap);
            this.UpdateCamera(this._cap, t);
            this.UpdateAimTarget(t);
        }

        if(this.rollTimer >= this.rollDuration){
            this.rolling = false;
            this.invulnerable = false;
            this._rollCooldownTimer = cfg.cooldown;
            // Move over: if right-click is still held, resume precise-aim (the move dropped it on start).
            // Without this the camera stays un-aimed even though the button is down.
            this.aiming = this._aimHeld;
        }
    }

    Update(t){
        // Dev free-cam owns the camera: hold the player still and skip camera placement.
        if(this.cameraOverride){
            const velocity = this.physicsBody.getLinearVelocity();
            velocity.setX(0); velocity.setZ(0);
            this.physicsBody.setLinearVelocity(velocity);
            this.physicsBody.setAngularVelocity(this.zeroVec);
            const ms = this.physicsBody.getMotionState();
            if(ms){
                ms.getWorldTransform(this.transform);
                const p = this.transform.getOrigin();
                this._cap.set(p.x(), p.y() + this.yOffset, p.z());
                this.parent.SetPosition(this._cap);   // keep Player.Position valid for NPCs
            }
            return;
        }

        // Toggle TPS/FPS on a V key edge (latched so a held key fires once).
        if(Input.GetKeyDown('KeyV')){
            if(!this._vLatch){ this._vLatch = true; this.ToggleCamera(); }
        } else {
            this._vLatch = false;
        }

        // Committed ground moves: the double-tap dodge SLIDE and the hard-landing ROLL. Either one OWNS
        // movement while it runs (forward burst + i-frames + camera), skipping the normal input path.
        this._tapClock += t;
        if(this._rollCooldownTimer > 0){ this._rollCooldownTimer = Math.max(0, this._rollCooldownTimer - t); }
        // Hard-landing watch (may start a land-roll THIS frame) before the double-tap slide; while any
        // committed move runs let it OWN movement (burst + i-frames + camera) and skip the normal path.
        this.UpdateLandingDetect();
        this.UpdateRollInput();
        if(this.rolling){
            this.UpdateRoll(t);
            return;
        }

        // Placement-hold (FPS weapon-placement panel open): freeze the player but keep the REAL camera
        // and aim pose so the gun is nudged in its true first-person framing. Hold the latched aim state,
        // zero movement, and still run camera + aim-target placement (so the FPS eye tracks the head and
        // the gun stays seated where the panel is editing it). The free-fly cam is NOT used here.
        if(this.placementHold){
            this.aiming = this._placementAim;
            const v = this.physicsBody.getLinearVelocity();
            v.setX(0); v.setZ(0);
            this.physicsBody.setLinearVelocity(v);
            this.physicsBody.setAngularVelocity(this.zeroVec);
            const ms = this.physicsBody.getMotionState();
            if(ms){
                ms.getWorldTransform(this.transform);
                const p = this.transform.getOrigin();
                this._cap.set(p.x(), p.y() + this.yOffset, p.z());
                this.parent.SetPosition(this._cap);
                this.UpdateCamera(this._cap, t);
                this.UpdateAimTarget(t);
            }
            return;
        }

        const forwardFactor = Input.GetKeyDown("KeyS") - Input.GetKeyDown("KeyW");
        const rightFactor = Input.GetKeyDown("KeyD") - Input.GetKeyDown("KeyA");
        const direction = this.moveDir.set(rightFactor, 0.0, forwardFactor).normalize();

        // Sprint (hold Shift) only kicks in while running forward on the ground.
        const sprintKey = Input.GetKeyDown("ShiftLeft") || Input.GetKeyDown("ShiftRight");
        this.isSprinting = !!(sprintKey && Input.GetKeyDown("KeyW") && this.physicsComponent.canJump);
        this.maxSpeed = this.isSprinting ? this.walkSpeed * this.sprintMultiplier : this.walkSpeed;
        // Aiming = slow, deliberate movement: scale the top speed WAY down while holding aim. This
        // also suspends the sprint bonus (no sprint-aim) so the slow aim walk is consistent whether
        // or not Shift is held. The legs still read as a jog, just a slow one.
        if(this.aiming){ this.maxSpeed = this.walkSpeed * this.aimMoveMultiplier; }

        // Crouch input: C toggles (latched edge), Left Alt / Option holds. Effective crouch also needs
        // to be grounded (a jump force-stands). Drive the capsule resize; SetCrouched gates standing on
        // head clearance, so if blocked we stay crouched — reflect the ACTUAL physics state back into
        // `crouching` so the body pose + speed match what the capsule did.
        if(Input.GetKeyDown('KeyC')){
            if(!this._crouchLatch){ this._crouchLatch = true; this._crouchToggle = !this._crouchToggle; }
        }else{ this._crouchLatch = false; }
        const crouchHeld = Input.GetKeyDown('AltLeft') || Input.GetKeyDown('AltRight');
        // Require grounded to ENTER a crouch, but STAY crouched through brief IsGrounded flickers (it's
        // computed from contact manifolds, which drop for a frame on faceted-terrain crests). Gating
        // purely on IsGrounded made crouch-walking over bumps stand up for a frame and re-crouch — a
        // capsule resize + pose pop every few steps (the crouch-walk "animation glitch"). `|| crouching`
        // latches the crouch so only releasing the toggle/key (or the explicit jump force-stand) lifts it.
        const wantCrouch = (this._crouchToggle || crouchHeld) && (this.IsGrounded || this.crouching);
        this.physicsComponent.SetCrouched(wantCrouch);
        this.crouching = this.physicsComponent.crouched;
        if(this.crouching){
            this.maxSpeed *= this.crouchSpeedMultiplier;   // slow crouch-walk (composes with aim)
            this.isSprinting = false;                      // no crouch-sprint
        }

        const velocity = this.physicsBody.getLinearVelocity();

        // --- Jump. Held Space (bunny-hop) OR a buffered press fires a ground jump while grounded or
        // within the coyote window; an EDGE press while airborne triggers the one-shot wall double-jump.
        const spaceDown = Input.GetKeyDown('Space');
        const spacePressed = spaceDown && !this._spaceLatch;   // rising edge
        this._spaceLatch = spaceDown;

        // Coyote + buffer timers. Grounded refreshes the coyote window and re-arms the air jump; a press
        // fills the buffer. Both tick down otherwise.
        if(this.physicsComponent.canJump){
            this._coyoteTimer = this.coyoteTime;
            this._airJumpUsed = false;
        }else{
            this._coyoteTimer = Math.max(0, this._coyoteTimer - t);
        }
        this._jumpBuffer = spacePressed ? this.jumpBufferTime : Math.max(0, this._jumpBuffer - t);

        const wantGroundJump = (spaceDown || this._jumpBuffer > 0)
            && (this.physicsComponent.canJump || this._coyoteTimer > 0);

        if(wantGroundJump){
            // Jumping out of a crouch behaves EXACTLY like a standing jump: press = jump, same frame.
            // We still STAND UP first (clear the C toggle + grow the capsule back so we launch/land on the
            // standing hitbox, and the body's crouch pose eases out fast while airborne — crouchJumpLerp),
            // but the jump is NOT gated on that stand succeeding: the impulse is applied unconditionally
            // below, so a marginal CanStandUp (faceted terrain, brushing cover) can never EAT the jump the
            // way it used to ("crouch jump acting wonky"). SetCrouched preserves vy; the jump sets it
            // explicitly right after, so the order here doesn't matter.
            if(this.crouching){
                this._crouchToggle = false;
                this.physicsComponent.SetCrouched(false);
                this.crouching = this.physicsComponent.crouched;
            }
            velocity.setY(this.jumpVelocity);
            this.physicsComponent.canJump = false;
            this._coyoteTimer = 0;
            this._jumpBuffer = 0;
            // Authoritative take-off signal for the body's jump animation. PlayerBody can't reliably
            // detect take-off from IsGrounded (canJump): we clear it THIS frame BEFORE PlayerBody
            // runs, and Input reports HELD keys, so holding Space bunny-hops on the first grounded
            // frame (inside the body's landing debounce) — without this event the body would keep
            // looping the fall pose and skip the jumpStart launch on the second hop.
            this.Broadcast({topic: 'player.jump'});
        }else if(spacePressed && this.doubleJumpEnabled && !this._airJumpUsed
                 && !this.physicsComponent.canJump && this._coyoteTimer <= 0 && this.ProbeWall()){
            // Airborne + a fresh press + a wall within range: the wall-assisted double jump. A clean
            // vertical boost plus a small outward kick off the wall (added into the LOCAL speed so the
            // movement path below doesn't overwrite it). Consumed until the next landing.
            velocity.setY(this.wallJumpVelocity);
            this._airJumpUsed = true;
            this._jumpBuffer = 0;
            // Outward push (world) folded into local pre-yaw speed so setX/Z below keeps it.
            this._yawInv.copy(this.yaw).invert();
            this.tempVec.copy(this._wallNormal).multiplyScalar(this.wallJumpPush).applyQuaternion(this._yawInv);
            this.speed.x += this.tempVec.x;
            this.speed.z += this.tempVec.z;
            this.Broadcast({topic: 'player.jump'});
        }

        this.Deccelerate(t);
        this.Accelarate(direction, t);

        const moveVector = this.tempVec.copy(this.speed);
        moveVector.applyQuaternion(this.yaw);
        
        velocity.setX(moveVector.x);
        velocity.setZ(moveVector.z);

        this.physicsBody.setLinearVelocity(velocity);
        this.physicsBody.setAngularVelocity(this.zeroVec);

        const ms = this.physicsBody.getMotionState();
        if(ms){
            ms.getWorldTransform(this.transform);
            const p = this.transform.getOrigin();
            // Capsule-tracked eye position. This is Player.Position in BOTH camera
            // modes (NPCs target it), independent of where the TPS boom sits.
            // Crouch shrinks the capsule and drops its origin by centerDrop to keep the FEET grounded;
            // add that back here so the tracked EYE stays stable across the resize (no jump). The
            // crouch LOOK comes from the body lowering the pelvis, and the TPS camera from crouchCamDrop.
            const crouchEye = this.physicsComponent.crouched ? this.physicsComponent.centerDrop : 0;
            this._cap.set(p.x(), p.y() + this.yOffset + crouchEye, p.z());
            this.parent.SetPosition(this._cap);
            this.UpdateCamera(this._cap, t);
            this.UpdateAimTarget(t);
        }

    }

    // Collision push-in: how far the spring-arm has been dollied IN from its rest length by
    // geometry (0 = fully out / no collision, →1 = jammed to the floor at tpsMinDistance). _curT
    // is the smoothed 0..1 position along the pivot→rest spline (1 = fully out), and it only drops
    // below 1 when the collision sweep pulls the camera in — so 1-_curT isolates the collision
    // dolly cleanly (aim/sprint/look-down change the boom LENGTH, not _curT). Drives the TPS body's
    // aim-yaw correction (PlayerBody) so the gun re-converges on the reticle when a wall crowds the
    // camera in close and the over-the-shoulder framing collapses.
    get CameraPushIn(){
        return THREE.MathUtils.clamp(1 - this._curT, 0, 1);
    }

    // Camera-to-character PROXIMITY, 0..1 (0 = at/over the resting boom or farther, 1 = jammed up
    // against the character at the collision floor). Reads the LIVE camera distance, so it rises
    // for aim pull-in, sprint/look-down (negative -> clamped 0), AND collision push-in alike. The
    // body uses this (with conditions) to stabilize the hips and to drive the close-range aim pose.
    get CameraProximity(){
        return THREE.MathUtils.clamp(
            (this.tpsDistance - this._camDist) / (this.tpsDistance - this.tpsMinDistance), 0, 1);
    }

    // Current horizontal move speed in m/s (used to drive the weapon bob).
    get HorizontalSpeed(){
        return this.speed.length();
    }

    get IsGrounded(){
        return this.physicsComponent ? this.physicsComponent.canJump : false;
    }

    // Is there a near VERTICAL surface (a wall) within wallJumpRange? Sweeps a sphere horizontally in
    // 8 directions from mid-torso against STATIC geometry and keeps the CLOSEST near-vertical hit (its
    // outward normal, flattened to horizontal, is stored in _wallNormal for the wall-jump kick). Used to
    // gate the air double-jump. Cheap: a handful of convex sweeps only on a fresh airborne jump press.
    ProbeWall(){
        if(!this.physicsWorld){ return false; }
        const c = this.parent.Position;
        this._wallFrom.set(c.x, c.y - 0.3, c.z);   // mid-torso, below the tracked eye
        let best = 1, found = false;
        for(const d of this._wallProbeDirs){
            this._wallTo.copy(this._wallFrom).addScaledVector(d, this.wallJumpRange);
            if(AmmoHelper.SphereSweep(this.physicsWorld, this.camRadius, this._wallFrom, this._wallTo,
                this._wallRes, CollisionFilterGroups.StaticFilter)
                && this._wallRes.fraction < best
                && Math.abs(this._wallRes.normal.y) < 0.6){   // near-vertical surface only (not floor/ceiling)
                best = this._wallRes.fraction;
                this._wallNormal.copy(this._wallRes.normal);
                found = true;
            }
        }
        if(found){
            this._wallNormal.y = 0;                 // horizontal push only
            if(this._wallNormal.lengthSq() < 1e-6){ return false; }
            this._wallNormal.normalize();
        }
        return found;
    }
}
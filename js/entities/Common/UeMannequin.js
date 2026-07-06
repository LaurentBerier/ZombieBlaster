import * as THREE from 'three'


// Shared construction for the Unreal Engine Mannequin avatar. Both the player's
// third-person body (PlayerBody) and the velocity-driven enemy soldier
// (UeSoldierController) drive the SAME rig + the SAME four UE rifle clips
// (idle / walk / reload / shoot), so the mesh setup, the UE->three import fix, the
// body/chest-logo textures and the in-hand weapon socket all live here once.
//
// Two avatar GLB conventions are supported (selected by the `preOriented` flag):
//
//   * Legacy UE-native bake (Z-up, centimetres): the raw GLB scene is wrapped in a
//     gameplay `modelRoot` group and the inner model carries a fixed -90deg X tilt
//     + 0.01 scale so it lands upright in three's Y-up metres, and its neutral PBR
//     material is rebuilt with the supplied UE body/logo textures.
//   * Pre-oriented bake (`preOriented: true`): a Y-up, metre-scaled GLB exported
//     from Blender (our FBX->GLB converter) with PBR materials + OpenGL normal maps
//     already baked in. It needs NO tilt, NO scale and NO material rebuild — it
//     lands upright (~1.9 m tall, feet at local Y=0, facing +Z) as-is.
//
// Either way the model faces +Z and feet sit at local Y=0; callers move/rotate the
// outer `modelRoot` and never touch the inner model.
//
// The four UE rifle clips ship only in the legacy bake. To drive the pre-oriented
// rig with them, adapt each clip with adaptClipToPreOriented (below) once at load.

// Render layer the avatar's meshes are moved to when their owning camera must NOT
// see them (the player's own first-person body). The shadow-casting light is told
// to also see this layer so the avatar still throws a shadow while hidden.
export const UE_BODY_LAYER = 1;

// In-hand weapon socket. The UE rifle clips pose hand_r to grip a rifle; these
// hand-tuned offsets seat the weapon in that grip. The socket lives in the bone's
// local space, which is native UE centimetres (the model root scales the whole rig
// by 0.01 for the world), so translation reads in centimetres.
//
// The SK_AK47 FBX is a SkeletalMesh whose geometry is NOT centred on its object
// origin (the barrel runs off to one side, bbox centre ≈ 15 units off-origin) and
// whose moving parts hang off offset bones. So parenting the raw object to the hand
// leaves the gun floating away from the palm (it ends up by the head). To make the
// placement robust regardless of how the FBX authored its pivot, the weapon is
// dropped into a pivot group and shifted so its bounding-box CENTRE sits at the
// group origin; the group is then auto-scaled (longest side -> WEAPON_LENGTH_CM)
// and seated in the hand. WEAPON_GRIP therefore offsets the gun's centre from the
// hand bone. Nudge position/rotation if the grip looks off; bump WEAPON_LENGTH_CM
// to resize.
const WEAPON_LENGTH_CM = 72;
const WEAPON_GRIP = {
    // Hand-tuned in TPS with the in-game placement tool (WeaponPlacementDebug, the `
    // panel). Position is hand-local centimetres; rotation seats the gun in the palm with
    // the barrel running forward. Tuned for the Franken-Gun (Neon Biohazard Blaster) GLB —
    // the current in-hand weapon. Re-tune with the panel and paste here. (M2 moves per-weapon
    // grips into the weapon registry so each gun seats correctly on swap.)
    position: new THREE.Vector3(-22.2, -4.4, 0.7),
    rotationEuler: new THREE.Euler(
        THREE.MathUtils.degToRad(90),
        THREE.MathUtils.degToRad(-20),
        THREE.MathUtils.degToRad(362),
    ),
};

// SEPARATE first-person grip transform. The in-hand AK is the SAME mesh in both camera modes (the
// FP camera rides the body's head bone, so first-person shows this body's gun, not a viewmodel), but
// the FRAMING differs: over-the-shoulder in TPS vs down-the-sights at the eye in FPS, so the gun
// wants a different seat for each. PlayerBody swaps the pivot to whichever applies for the current
// camera mode (see PlayerBody.ApplyWeaponGrip), and the placement tool (WeaponPlacementDebug, the `
// panel) edits whichever mode you're in. Because FPS now renders the SAME body with the SAME hand
// pose as TPS (the camera rides the head bone), this is SEEDED to the TPS grip so the right hand grips
// the gun identically — re-tune with the panel and paste the FPS snippet here. Hand-local cm / degrees.
const WEAPON_GRIP_FPS = {
    // FPS reload / base seat (hand-local). The first-person IDLE/ADS framing is NO LONGER driven by this —
    // it's the camera-local viewmodel constants in PlayerBody (fpsVmHipPos / fpsVmAdsPos). This seat now only
    // positions the gun during a reload one-shot (where the camera-authoritative viewmodel steps aside so the
    // reload-mag clip reads), so it keeps the original reload-tuned value.
    position: new THREE.Vector3(-21.2, -4.4, 0.7),
    rotationEuler: new THREE.Euler(
        THREE.MathUtils.degToRad(0),
        THREE.MathUtils.degToRad(-5),
        THREE.MathUtils.degToRad(272),
    ),
};

// SEPARATE first-person AIM (down-the-sights) grip. When ADS in FPS the gun wants to come UP and
// CENTRE so you actually see the weapon down the view, which is a different seat from the FPS hip
// grip above — so PlayerBody swaps to this one while aiming in first-person (see ApplyWeaponGrip /
// ActiveGripMode). Tune it by eye with the placement tool (WeaponPlacementDebug): in FPS, HOLD right
// click to edit this AIM grip (the panel header reads FPS_AIM), nudge until the weapon sits where you
// want it down the sights, then paste the snippet back here. SEEDED to the TPS grip (same as the FPS
// hip seat) so the right hand grips the gun until you tune the ADS pose. Hand-local cm / degrees.
// ⚠️ FPS-ONLY SEAT — do NOT change while tuning third-person. This grip is consumed ONLY in
// first-person ADS; nudging it for a TPS framing tweak silently regresses how the gun points down the
// sights. Tune it in-game in FPS (hold right click; panel header reads FPS_AIM) and paste back here.
// NOTE: this seat aligns the gun with the centre crosshair at LEVEL pitch; the up/down crosshair
// tracking is handled by PlayerBody.UpdateFpsViewmodelPitch (the ADS camera-lock orbits this level-aligned
// seat about the eye, so it stays aligned at every altitude), not by this position.
const WEAPON_GRIP_FPS_AIM = {
    position: new THREE.Vector3(-7.2, -4.4, 19.7),
    rotationEuler: new THREE.Euler(
        THREE.MathUtils.degToRad(5),
        THREE.MathUtils.degToRad(-4),
        THREE.MathUtils.degToRad(270),
    ),
};

// Seat a weapon mesh into `pivot`: clear any previous gun, recentre the new gun so its
// bbox centre sits on the pivot origin, auto-scale so its longest side ~= WEAPON_LENGTH_CM,
// then place the pivot at the given hand-local `grip`. Measured in ISOLATION (a temp identity
// holder) so it's correct whether the pivot is free (build time) or already socketed to the
// hand (runtime weapon swap). Used by buildUeMannequin AND PlayerBody.SetVisibleWeapon.
export function seatWeaponMesh(pivot, weapon, grip, meshes = null){
    for(let i = pivot.children.length - 1; i >= 0; i--){ pivot.remove(pivot.children[i]); }

    // Measure the gun's bbox with an identity parent (independent of where the pivot lives).
    weapon.position.set(0, 0, 0);
    weapon.quaternion.identity();
    const holder = new THREE.Group();
    holder.add(weapon);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(weapon);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;
    weapon.position.sub(center);         // gun centre -> pivot origin
    holder.remove(weapon);

    pivot.add(weapon);
    pivot.scale.setScalar(WEAPON_LENGTH_CM / longest);
    pivot.position.copy(grip.position);
    pivot.quaternion.setFromEuler(grip.rotationEuler);
    pivot.traverse(child => {
        if(child.isMesh){
            child.castShadow = true;
            child.receiveShadow = true;
            child.frustumCulled = false;   // skinned/animated bounds go stale
            // Per-instance material so one avatar's weapon tint/fade doesn't bleed to clones.
            child.material = Array.isArray(child.material)
                ? child.material.map(m => m.clone())
                : child.material.clone();
            if(meshes){ meshes.push(child); }
        }
    });
}

// Build the runtime-ready avatar from a freshly-cloned GLB scene.
//   model    : SkeletonUtils.clone() of the loaded SK_Mannequin.glb scene
//   textures : optional { bodyColor, bodyNormal, logoColor, logoNormal } THREE.Textures
//   weapon   : optional Object3D (a cloned SK_AK47 mesh) to socket into hand_r
// Returns { modelRoot, model, rootBone, handBone, headBone, meshes } — `modelRoot`
// is what the caller adds to the scene and transforms; `rootBone` is locked each
// frame to strip the clips' baked root motion; `headBone` is the first-person eye
// anchor the player camera rides; `meshes` is the skinned-mesh list.
export function buildUeMannequin(model, { textures = null, weapon = null, preOriented = false } = {}){
    if(!preOriented){
        // Legacy UE-native GLB: tilt Z-up -> Y-up and scale cm -> metres.
        model.rotation.x = -Math.PI / 2;
        model.scale.setScalar(0.01);
    }
    // Pre-oriented GLB is already Y-up, metre-scaled and feet at local Y=0; leave it.
    const modelRoot = new THREE.Group();
    modelRoot.add(model);

    const meshes = [];
    let rootBone = null;
    let handBone = null;
    let headBone = null;
    let weaponPivot = null;

    model.traverse(child => {
        if(child.isMesh || child.isSkinnedMesh){
            child.frustumCulled = false;   // skinned bounds go stale once posed
            child.castShadow = true;
            child.receiveShadow = true;
            meshes.push(child);
        }
        if(child.isBone){
            if(child.name === 'root'){ rootBone = child; }
            if(child.name === 'hand_r'){ handBone = child; }
            if(child.name === 'head'){ headBone = child; }   // first-person eye anchor
        }
    });

    // Pre-oriented GLBs already carry correct, skinning-enabled PBR materials with
    // baked body colour + OpenGL normal map (the Blender converter re-encodes them),
    // so we keep those untouched — but clone each one per instance. SkeletonUtils.clone
    // shares material instances across clones, and the soldier's death fade mutates
    // material.transparent/opacity; without a per-instance copy a dying soldier would
    // fade the player (and other soldiers) too. Cloning keeps the (shared) textures.
    if(preOriented){
        meshes.forEach(mesh => {
            const material = mesh.material.clone();
            // UE's glTF omits metallicFactor, so GLTFLoader applies the spec default
            // of 1.0 — a fully-metallic body. A metal's colour comes entirely from the
            // reflected environment, and this scene has no environment map, so the body
            // reflects a black void and renders near-black with speckled normal-map
            // highlights ("too dark and buggy"). The mannequin is matte skin/cloth, so
            // force it non-metallic (matching the legacy bake's 0.1) and let the scene
            // lights do the shading.
            material.metalness = 0.1;
            mesh.material = material;
        });
    }

    // The legacy UE bake instead ships a neutral PBR material that renders
    // black/invisible under r127, so we rebuild a skinning-enabled material we
    // control. The mesh exports two primitives in UE material-slot order: 0 = body,
    // 1 = chest logo. Map the matching UE .tga set onto each when supplied; otherwise
    // fall back to flat grey.
    if(!preOriented) meshes.forEach((mesh, i) => {
        const isLogo = i === 1;
        const map = textures ? (isLogo ? textures.logoColor : textures.bodyColor) : null;
        const normalMap = textures ? (isLogo ? textures.logoNormal : textures.bodyNormal) : null;
        const material = new THREE.MeshStandardMaterial({
            color: map ? 0xffffff : 0x8c95a1,
            map: map || null,
            normalMap: normalMap || null,
            metalness: 0.1,
            roughness: 0.8,
            skinning: true,
        });
        // UE exports DirectX-convention normal maps (green/Y channel pointing down);
        // three's lighting expects OpenGL (+Y up). Without this the bumps invert and
        // the body reads as muddy/blotchy rather than crisply panelled. Flipping the
        // Y of normalScale reinterprets the green channel at sample time (no texture
        // rewrite needed). No effect when there's no normal map.
        if(normalMap){ material.normalScale.y *= -1; }
        mesh.material = material;
    });

    if(weapon && handBone){
        // Socket the gun into a pivot at the default grip (recenter + auto-scale in the
        // shared helper, so the runtime weapon swap seats new guns identically).
        const pivot = new THREE.Group();
        seatWeaponMesh(pivot, weapon, WEAPON_GRIP, meshes);
        handBone.add(pivot);
        weaponPivot = pivot;
    }

    return { modelRoot, model, rootBone, handBone, headBone, weaponPivot, meshes };
}

// The default in-hand grip transform, exposed so the placement-debug tool can show
// the current values and so a found-by-debug transform can be pasted straight back
// into WEAPON_GRIP above. WEAPON_GRIP_FPS_DEFAULT is the matching first-person seat
// (see WEAPON_GRIP_FPS) — PlayerBody applies one or the other per camera mode.
export const WEAPON_GRIP_DEFAULT = WEAPON_GRIP;
export const WEAPON_GRIP_FPS_DEFAULT = WEAPON_GRIP_FPS;
export const WEAPON_GRIP_FPS_AIM_DEFAULT = WEAPON_GRIP_FPS_AIM;

// Collect the names of every bone in the "upper body": the split bone (default
// 'spine_01', the first spine joint above the pelvis on the UE skeleton) and all of
// its descendants — the whole torso, arms, hands, neck and head. Everything NOT in
// this set (pelvis + leg chains + the root-level IK helpers) is the "lower body".
//
// Used to layer a one-shot upper-body action (reload / shoot / aim) over a separate
// lower-body locomotion clip so the legs keep walking while the torso acts. See
// splitClipByBones and PlayerBody's two-layer animation setup.
export function collectUpperBoneNames(model, splitBoneName = 'spine_01'){
    let splitBone = null;
    model.traverse(o => { if(o.isBone && o.name === splitBoneName){ splitBone = o; } });
    const names = new Set();
    if(splitBone){ splitBone.traverse(o => { if(o.isBone){ names.add(o.name); } }); }
    return names;
}

// Split a full-body clip into a disjoint { upper, lower } pair of clips by bone
// membership: a track goes to the upper clip when its target bone is in
// upperBoneNames, otherwise to the lower clip. The two clips together still cover
// every original track, so playing both (each at weight 1) on one mixer reproduces
// the full-body animation — but because they drive disjoint bone sets they can also
// be driven independently (lower = walk, upper = reload) with no blend conflict.
// Tracks are cloned so the returned clips are fully self-contained.
export function splitClipByBones(clip, upperBoneNames){
    const upperTracks = [];
    const lowerTracks = [];
    for(const track of clip.tracks){
        const boneName = track.name.split('.')[0];
        (upperBoneNames.has(boneName) ? upperTracks : lowerTracks).push(track.clone());
    }
    return {
        upper: new THREE.AnimationClip(`${clip.name}_upper`, clip.duration, upperTracks, clip.blendMode),
        lower: new THREE.AnimationClip(`${clip.name}_lower`, clip.duration, lowerTracks, clip.blendMode),
    };
}

// Re-target a legacy-bake UE rifle clip onto the pre-oriented (Blender) rig.
//
// The two rigs come from the same UE FBX, and a per-bone comparison shows every bone
// BELOW the pelvis is byte-identical (same rest rotation AND translation). Blender
// absorbed the entire Z-up -> Y-up conversion into just two places: the pelvis rest
// transform (exactly a -90deg rotation about X — verified: rotX(-90) * R_old_pelvis
// == R_new_pelvis, and rotX(-90) maps the pelvis offset [0,1.1,96.8] -> [0,96.8,-1.1])
// and a 0.01 metre scale on the non-bone armature node named 'root'.
//
// So a clip plays correctly on the pre-oriented rig after exactly two edits:
//   * drop the 'root' track — in this rig 'root' is the armature carrying the 0.01
//     scale (its scale channel would clobber that and explode the rig 100x); its
//     baked root motion is stripped in-game anyway (locomotion plays in place).
//   * rotate ONLY the pelvis quaternion (left-multiply) + position tracks by rotX(-90).
// Every other bone track applies unchanged. Returns a new clip; the input is untouched.
const PELVIS_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
export function adaptClipToPreOriented(clip){
    const out = clip.clone();
    // Drop the 'root.' armature track (above) AND every '.scale' track. The UE clips bake
    // constant-1.0 scale channels which, applied to a retargeted rig, OVERWRITE its per-bone
    // REST scales. Harmless on the mannequin (rest scale 1.0 everywhere), but the Tripo rigs
    // (Liz, Frog) fit their bodies to the shared skeleton with COMPENSATING per-bone rest
    // scales — e.g. the Frog's big head is head=1.25 offset by neck_01=0.8585 * spine_03=0.9318
    // (product ~1.0). Resetting the compensating PARENTS to 1.0 while the leaf head keeps 1.25
    // blew the head up ~25% in-game. These clips never actually animate scale, so dropping the
    // channels (each rig keeps its own rest scales) is the correct retarget for all of them.
    out.tracks = out.tracks.filter(t => !t.name.startsWith('root.') && !t.name.endsWith('.scale'));
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    for(const track of out.tracks){
        if(track.name === 'pelvis.quaternion'){
            const v = track.values;
            for(let i = 0; i < v.length; i += 4){
                q.set(v[i], v[i+1], v[i+2], v[i+3]).premultiply(PELVIS_FIX);
                v[i] = q.x; v[i+1] = q.y; v[i+2] = q.z; v[i+3] = q.w;
            }
        }else if(track.name === 'pelvis.position'){
            const v = track.values;
            for(let i = 0; i < v.length; i += 3){
                p.set(v[i], v[i+1], v[i+2]).applyQuaternion(PELVIS_FIX);
                v[i] = p.x; v[i+1] = p.y; v[i+2] = p.z;
            }
        }
    }
    return out;
}

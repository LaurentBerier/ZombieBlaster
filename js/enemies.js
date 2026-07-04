// ============================================
// Enemy System: Zombies, Bosses, Wave Management
// Squash-and-stretch animation, AI, spawning
// ============================================

import { scene, COLORS, NEON_PALETTE, createToonMaterial, addOutline } from './scene.js';
import { PLAYER, getPlayerPosition } from './player.js';
import { ARENA, ROOM_DEFS } from './arena.js';
import { cloneAsset, getAssetAnimations } from './assetLoader.js';
import { prepareEnemyDecalMaterials, disposeEnemyDecalMaterials } from './decals.js';
import { playGrowl } from './audio.js';

// Target world-space height for the zombie GLB (in Three.js units).
// Auto-fit scales the raw model bbox to this height so we don't hard-code
// magic numbers that break if the art team re-exports the asset.
const ZOMBIE_TARGET_HEIGHT = 2.0;

// The Zombie_1 GLB's authored bbox dwarfs the arena — the mesh was exported
// at a scale that auto-fit alone can't tame. Extra 1/100 knockdown brings
// it in line with the player/weapon sizes.
const ZOMBIE_EXTRA_SCALE = 0.01;

// Lift the Armature this far above the floor. The Blender Armature origin sits
// at the heel; without a small bias the toes/sole geometry clip into the floor
// surface and shadow popping is visible.
const ZOMBIE_GROUND_OFFSET = 0.08;

// Reused during applyGLBToEnemy bbox computation.
const _bbox = new THREE.Box3();
const _bboxSize = new THREE.Vector3();

// Element -> tint color for impact flash (layered on top of squash).
const ELEMENT_TINT = {
    fire:   0xff6a00,
    shock:  0xffee44,
    acid:   0x88ff22,
    freeze: 0x66e6ff,
};

// Speed multiplier while a status effect is active.
const STATUS_SPEED_MULT = {
    shock: 0.3,
    freeze: 0.5,
    burn: 1.0,
    corrode: 1.0,
};

// Knockback decay per second (applied as ^dt each frame for frame-rate independence).
const KNOCKBACK_DECAY = 0.0025; // ~0.82 per frame @60fps

// Ambient growl scheduler — periodically a random living zombie growls so the
// horde feels alive. Throttled globally (one growl per tick, randomized cadence)
// to avoid a wall of noise when many enemies are active.
let ambientGrowlTimer = 2.0;

// Vertical extent of a zombie standing on the floor — used to skip walls
// whose footprint is entirely above the enemy's head (eg ceiling beams).
const ENEMY_TOP_Y = 2.0;

// Resolve any overlap between this enemy's footprint circle and an axis-aligned
// wall box, pushing the enemy out along the shortest exit. Mirrors the player's
// circle-vs-rect slide so zombies bunch against walls/custom props the same way
// the player does. Mutates enemy.root.position.
function resolveEnemyWallCollision(enemy) {
    const radius = enemy.hitRadius * 0.7;
    const radiusSq = radius * radius;
    const pos = enemy.root.position;

    for (let i = 0; i < ARENA.walls.length; i++) {
        const wall = ARENA.walls[i];
        if (wall.isPlatform) continue;
        // Wall sitting entirely above the zombie's head — walk straight under.
        if (wall.minY >= ENEMY_TOP_Y) continue;

        // Round props (tanks/barrels): circle-vs-circle eject around the footprint.
        if (wall.shape === 'cylinder') {
            const dx = pos.x - wall.cx;
            const dz = pos.z - wall.cz;
            const distSq = dx * dx + dz * dz;
            const reach = radius + wall.radius;
            if (distSq < reach * reach && distSq > 0.0001) {
                const dist = Math.sqrt(distSq);
                pos.x = wall.cx + (dx / dist) * reach;
                pos.z = wall.cz + (dz / dist) * reach;
            }
            continue;
        }

        const px = pos.x;
        const pz = pos.z;
        const insideX = px > wall.minX && px < wall.maxX;
        const insideZ = pz > wall.minZ && pz < wall.maxZ;

        if (insideX && insideZ) {
            // Enemy walked straight into the box — eject along the axis with
            // the smallest penetration so the path of least correction wins.
            const left = px - wall.minX;
            const right = wall.maxX - px;
            const near = pz - wall.minZ;
            const far = wall.maxZ - pz;
            const minPen = Math.min(left, right, near, far);
            if (minPen === left) pos.x = wall.minX - radius;
            else if (minPen === right) pos.x = wall.maxX + radius;
            else if (minPen === near) pos.z = wall.minZ - radius;
            else pos.z = wall.maxZ + radius;
            continue;
        }

        const closestX = insideX ? px : (px < wall.minX ? wall.minX : wall.maxX);
        const closestZ = insideZ ? pz : (pz < wall.minZ ? wall.minZ : wall.maxZ);
        const dx = px - closestX;
        const dz = pz - closestZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < radiusSq && distSq > 0.0001) {
            const dist = Math.sqrt(distSq);
            pos.x = closestX + (dx / dist) * radius;
            pos.z = closestZ + (dz / dist) * radius;
        }
    }
}

// Walk the bodyGroup tree and record every material with emissive support.
// We clone shared materials on first touch so flash tinting on one enemy
// doesn't bleed into every other GLB clone.
function collectTintMaterials(enemy) {
    const list = [];
    const seen = new WeakSet();
    enemy.bodyGroup.traverse(child => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat, idx) => {
            if (!mat || !mat.emissive) return;
            if (seen.has(mat)) {
                // Shared across enemies — clone so per-enemy tinting is safe.
                const cloned = mat.clone();
                if (Array.isArray(child.material)) child.material[idx] = cloned;
                else child.material = cloned;
                list.push({
                    material: cloned,
                    originalEmissive: cloned.emissive.clone(),
                    originalIntensity: cloned.emissiveIntensity ?? 0,
                });
                seen.add(cloned);
                return;
            }
            seen.add(mat);
            list.push({
                material: mat,
                originalEmissive: mat.emissive.clone(),
                originalIntensity: mat.emissiveIntensity ?? 0,
            });
        });
    });
    enemy.tintMaterials = list;
}

// Lerp every tint material between its original emissive and a flash color.
// intensity 0 = fully original, 1 = fully flash.
const _flashLerpColor = new THREE.Color();
function applyTint(enemy, flashColorHex, intensity) {
    if (!enemy.tintMaterials) return;
    _flashLerpColor.setHex(flashColorHex);
    enemy.tintMaterials.forEach(entry => {
        entry.material.emissive.copy(entry.originalEmissive).lerp(_flashLerpColor, intensity);
        entry.material.emissiveIntensity = entry.originalIntensity + intensity * 1.2;
    });
}

function resetTint(enemy) {
    if (!enemy.tintMaterials) return;
    enemy.tintMaterials.forEach(entry => {
        entry.material.emissive.copy(entry.originalEmissive);
        entry.material.emissiveIntensity = entry.originalIntensity;
    });
}

// Enemy pool
const MAX_ENEMIES = 60;
const enemies = [];
const ENEMY_TYPES = {
    ZOMBIE: 'zombie',
    ZOMBIE_2: 'zombie_2',
    FAST_ZOMBIE: 'fast_zombie',
    TANK_ZOMBIE: 'tank_zombie',
    BOSS: 'boss',
    // Zombie_4 wave-boss — closes out every wave from wave 2 on.
    ZOMBIE_4: 'zombie_4',
    // Zombie_5 debut boss — closes out wave 1 (the first boss).
    ZOMBIE_5: 'zombie_5',
};

// Per-type GLB asset ids. Variants without attack/death entries fall back to
// looping the walk clip during attack and to the procedural death squash.
const ENEMY_ASSETS = {
    [ENEMY_TYPES.ZOMBIE]:      { walk: 'enemy_zombie', attack: 'enemy_zombie_attack', death: 'enemy_zombie_death' },
    // ZOMBIE_2 wears the Zombie_3 art, animated by Zombie_3's own walk/attack/death clips.
    [ENEMY_TYPES.ZOMBIE_2]:    { walk: 'enemy_zombie_3', attack: 'enemy_zombie_3_attack', death: 'enemy_zombie_3_death' },
    [ENEMY_TYPES.FAST_ZOMBIE]: { walk: 'enemy_zombie', attack: 'enemy_zombie_attack', death: 'enemy_zombie_death' },
    [ENEMY_TYPES.TANK_ZOMBIE]: { walk: 'enemy_zombie', attack: 'enemy_zombie_attack', death: 'enemy_zombie_death' },
    // ZOMBIE_4 wave-boss: its own Zombie_4 walk/attack/death clips.
    [ENEMY_TYPES.ZOMBIE_4]:    { walk: 'enemy_zombie_4', attack: 'enemy_zombie_4_attack', death: 'enemy_zombie_4_death' },
    // ZOMBIE_5 debut boss (wave 1): its own Zombie_5 walk/attack/death clips.
    [ENEMY_TYPES.ZOMBIE_5]:    { walk: 'enemy_zombie_5', attack: 'enemy_zombie_5_attack', death: 'enemy_zombie_5_death' },
};

// Wave management
const waveState = {
    currentWave: 1,
    enemiesRemaining: 0,
    enemiesSpawned: 0,
    enemiesToSpawn: 0,
    // enemiesToSpawn split into the regular horde plus the wave-boss(es) that
    // spawn once the horde is out (see startWave / spawnWaveEnemy). bossType is
    // which boss closes the wave — Zombie_5 on wave 1, Zombie_4 from wave 2 on.
    regularToSpawn: 0,
    bossToSpawn: 0,
    bossType: null,
    spawnTimer: 0,
    spawnInterval: 1.5,
    waveActive: false,
    waveDelay: 3.0,
    waveDelayTimer: 0,
    bossWave: false,
    bossSpawned: false,
    totalKills: 0,
};

// Replace placeholder geometry in a zombie's bodyGroup with the preloaded GLB.
// The model is parented inside bodyGroup so squash-and-stretch animations
// (which operate on bodyGroup.scale) continue to work unchanged.
// Returns true if the GLB was applied, false if the asset wasn't available
// (placeholder geometry stays in that case). Boss enemies always use placeholder
// geometry — they have no GLB asset.
function applyGLBToEnemy(enemy) {
    const assetIds = ENEMY_ASSETS[enemy.type];
    if (!assetIds) return false;
    // The walk GLB doubles as the mesh source — it ships the skinned mesh,
    // skeleton and walk clip together.
    const model = cloneAsset(assetIds.walk);
    if (!model) return false;

    // Dispose the previous life's per-enemy patched material clones before the
    // old GLB is detached — clear() alone leaks their renderer program refs.
    disposeEnemyDecalMaterials(enemy.bodyGroup);
    enemy.bodyGroup.clear();
    // Drop any prior mixer so we don't tick a detached skeleton.
    enemy.mixer = null;
    enemy.animAction = null;
    enemy.walkAction = null;
    enemy.attackAction = null;
    enemy.deathAction = null;
    enemy.deathClipDuration = 0;
    enemy.activeAnim = null;
    enemy.headBone = null;
    enemy.impactBones = [];

    // Fit the raw model bbox to our target height so re-exported assets
    // with different source scales continue to render at the right size.
    _bbox.setFromObject(model);
    _bbox.getSize(_bboxSize);
    const rawHeight = _bboxSize.y || 1;
    const scale = (ZOMBIE_TARGET_HEIGHT / rawHeight) * ZOMBIE_EXTRA_SCALE;
    model.scale.setScalar(scale);

    // Anchor on the "Armature" node (skeleton root). The Blender export places
    // the Armature at the character's feet, which is a stable ground reference —
    // unlike the bbox bottom, which moves around as the skinned mesh deforms
    // during animation (causing float/sink). Pinning Armature to bodyGroup
    // local y=0 also survives squash/stretch on bodyGroup.scale: 0 × sy = 0.
    const armature = model.getObjectByName('Armature');
    if (armature) {
        model.updateMatrixWorld(true);
        const armatureWorld = new THREE.Vector3();
        armature.getWorldPosition(armatureWorld);
        model.position.y = -armatureWorld.y + ZOMBIE_GROUND_OFFSET;
    } else {
        // Asset missing the conventional Armature name — fall back to bbox.
        model.position.y = -_bbox.min.y * scale + ZOMBIE_GROUND_OFFSET;
    }

    // GLB forward axis already aligns with root.rotation from atan2(toPlayer.x, toPlayer.z) — no Y flip.
    model.rotation.y = 0;

    enemy.bodyGroup.add(model);
    // Reset scale — the GLB is already the correct size; squash/stretch acts on top of this.
    enemy.bodyGroup.scale.set(1, 1, 1);
    enemy.squashScale.set(1, 1, 1);
    enemy.useGLB = true;

    // Three.js computes each Mesh's bounding sphere once from the bind pose.
    // For skinned meshes the animated extent can poke outside that sphere, and
    // when the camera is close enough that the static sphere falls behind the
    // near plane / outside the frustum, the mesh gets wrongly culled and the
    // zombie pops out of view. Disable per-mesh culling on the whole tree —
    // the cost is negligible (zombies are already on-screen by definition once
    // they're chasing the player) and it kills the disappearing bug.
    model.traverse(child => {
        child.frustumCulled = false;
        if (child.isBone && child.name !== 'Armature') {
            enemy.impactBones.push(child);
        }
    });

    // Cache the "Head" bone (every zombie skeleton uses this bone name)
    // so popups can anchor to the live world-space head position.
    enemy.headBone = model.getObjectByName('Head') || null;

    // Set up animation mixer if the asset brought skeletal clips along with it.
    // Each enemy needs its own mixer bound to its own cloned skeleton, which
    // cloneAsset handled via SkeletonUtils. Walk, attack and death clips live in
    // separate GLBs but share the same per-character skeleton — three.js binds
    // clip tracks to bones by name, so all three play on this mixer. Each enemy
    // type uses clips authored for its own rig, so bind poses always match.
    const walkClips = getAssetAnimations(assetIds.walk);
    const attackClips = assetIds.attack ? getAssetAnimations(assetIds.attack) : [];
    if (walkClips.length > 0) {
        enemy.mixer = new THREE.AnimationMixer(model);

        const walkClip = walkClips[0];
        const walkAction = enemy.mixer.clipAction(walkClip);
        walkAction.setLoop(THREE.LoopRepeat, Infinity);
        // Per-enemy walk playback speed — 1.3 (default) is 30% faster than authored
        // for the unsteady shamble; the boss uses a slower value for a heavy lumber
        // while its locomotion velocity (enemy.speed) stays unchanged.
        walkAction.timeScale = enemy.walkAnimScale;
        // Random phase offset so a crowd of zombies doesn't march in lockstep.
        walkAction.time = Math.random() * walkClip.duration;
        walkAction.play();
        enemy.walkAction = walkAction;
        enemy.animAction = walkAction;
        enemy.activeAnim = 'walk';

        if (attackClips.length > 0) {
            const attackClip = attackClips[0];
            const attackAction = enemy.mixer.clipAction(attackClip);
            attackAction.setLoop(THREE.LoopRepeat, Infinity);
            attackAction.timeScale = 1.0;
            // Leave base weight at the default 1 and DON'T call play() yet —
            // the cross-fade in updateEnemies will reset/play/fadeIn when the
            // enemy first enters attack range. Pre-zeroing the weight here
            // would break fadeIn permanently: three.js multiplies base weight
            // by the fade interpolant, so weight=0 × (0..1) = 0 ⇒ T-pose.
            enemy.attackAction = attackAction;
        }

        // Death clip plays once and clamps on the final frame — combined with
        // the 2 s static hold in updateEnemies, the zombie collapses, sits in
        // the dead pose, then despawns. clampWhenFinished is critical: without
        // it the action returns to bind pose (T-pose) at clip end.
        const deathClips = assetIds.death ? getAssetAnimations(assetIds.death) : [];
        if (deathClips.length > 0) {
            const deathClip = deathClips[0];
            enemy.deathClipDuration = deathClip.duration;
            const deathAction = enemy.mixer.clipAction(deathClip);
            deathAction.setLoop(THREE.LoopOnce, 1);
            deathAction.clampWhenFinished = true;
            enemy.deathAction = deathAction;
        }
    }

    // Clone + patch the GLB materials for shader-projected impact decals.
    // Must run BEFORE collectTintMaterials so the tint list points at the
    // per-enemy clones that actually render (cloneAsset shares materials
    // across every instance of a type).
    prepareEnemyDecalMaterials(enemy);

    // Rebuild tint-material list now that bodyGroup was re-populated from the GLB.
    collectTintMaterials(enemy);
    return true;
}

function initEnemies() {
    // Pre-create enemy pool
    for (let i = 0; i < MAX_ENEMIES; i++) {
        const enemy = createEnemyObject();
        enemy.root.visible = false;
        scene.add(enemy.root);
        enemies.push(enemy);
    }

}

function createEnemyObject() {
    const root = new THREE.Group();
    root.name = 'enemy';

    // Body parts for squash-and-stretch (placeholder: zombie minion)
    // Will be replaced with enemy_zombie_minion.glb
    const bodyGroup = new THREE.Group();
    bodyGroup.name = 'body_group';

    // Torso
    const torsoGeo = new THREE.BoxGeometry(0.6, 0.8, 0.4);
    const torsoMat = createToonMaterial(0x00cc99); // cyan-green skin
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = 1.0;
    bodyGroup.add(torso);
    addOutline(torso, torsoGeo, 1.06);

    // Head (oversized for cartoon proportions)
    const headGeo = new THREE.SphereGeometry(0.35, 8, 8);
    const headMat = createToonMaterial(0x00cc99);
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.65;
    bodyGroup.add(head);
    addOutline(head, headGeo, 1.08);

    // Eyes (glowing cyan)
    const eyeGeo = new THREE.SphereGeometry(0.08, 6, 6);
    const eyeMat = createToonMaterial(COLORS.cyan, COLORS.cyan, 1.0);
    [-0.12, 0.12].forEach(x => {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(x, 1.72, 0.28);
        bodyGroup.add(eye);
    });

    // Lab coat (magenta, tattered)
    const coatGeo = new THREE.BoxGeometry(0.7, 0.5, 0.45);
    const coatMat = createToonMaterial(COLORS.magenta);
    const coat = new THREE.Mesh(coatGeo, coatMat);
    coat.position.y = 0.85;
    bodyGroup.add(coat);

    // Arms (elongated for zombie feel)
    const armGeo = new THREE.BoxGeometry(0.15, 0.7, 0.15);
    const armMat = createToonMaterial(0x00cc99);
    [-0.45, 0.45].forEach(x => {
        const arm = new THREE.Mesh(armGeo, armMat);
        arm.position.set(x, 0.8, 0);
        bodyGroup.add(arm);
    });

    // Legs
    const legGeo = new THREE.BoxGeometry(0.18, 0.5, 0.18);
    const legMat = createToonMaterial(0x555555);
    [-0.15, 0.15].forEach(x => {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(x, 0.25, 0);
        bodyGroup.add(leg);
    });

    // Decay splotches (purple patches)
    const splotchGeo = new THREE.SphereGeometry(0.12, 5, 5);
    const splotchMat = createToonMaterial(0x7700aa);
    [{ x: 0.2, y: 1.1, z: 0.2 }, { x: -0.15, y: 0.7, z: 0.15 }, { x: 0.1, y: 1.5, z: 0.2 }].forEach(pos => {
        const splotch = new THREE.Mesh(splotchGeo, splotchMat);
        splotch.position.set(pos.x, pos.y, pos.z);
        splotch.scale.set(1, 0.6, 0.8);
        bodyGroup.add(splotch);
    });

    root.add(bodyGroup);

    const enemy = {
        root,
        bodyGroup,
        type: ENEMY_TYPES.ZOMBIE,
        alive: false,
        // Incremented on every (re)spawn of this pooled slot — attachments
        // from a previous life (impact decals) compare it to detect recycling.
        spawnGeneration: 0,
        health: 30,
        maxHealth: 30,
        speed: 2.5,
        damage: 10,
        attackRange: 1.8,
        attackCooldown: 1.0,
        attackTimer: 0,
        // Telegraphed strike: when > 0 the killing blow lands `attackWindup`s after
        // the swing begins (the boss), not instantly. windupTimer counts it down;
        // -1 means "not mid-swing".
        attackWindup: 0,
        windupTimer: -1,
        hitRadius: 0.7,
        // Hit-volume centre height; recomputed from body scale on every spawn so
        // tall enemies (bosses) are hittable head-to-toe. ×2 = body top (FX clamp).
        hitCenterY: 1.0,
        scoreValue: 100,

        // Squash-and-stretch animation state
        animState: 'idle',
        animTimer: 0,
        walkCycle: 0,
        // Walk-clip playback speed (timeScale). Default matches the shambling
        // horde; the boss overrides it to a slower, heavier lumber.
        walkAnimScale: 1.3,
        hitFlashTimer: 0,
        // Multiplier on the on-hit squash — the boss uses a small value so it
        // barely flinches and never breaks stride.
        hitReactMult: 1,
        deathTimer: 0,
        squashScale: new THREE.Vector3(1, 1, 1),
        // Target scale for bodyGroup restore after squash (overridden when GLB is used)
        targetBodyScale: new THREE.Vector3(1, 1, 1),
        useGLB: false,
        // Cached "Head" bone from the GLB skeleton — used as anchor for HUD popups
        // (score, damage numbers) so they appear just above the zombie's head and
        // track its world position as the animation plays. Null until applyGLBToEnemy
        // assigns it; bosses (no GLB) keep null and fall through to a procedural offset.
        headBone: null,
        impactBones: [],
        // Skeletal animation state (set in applyGLBToEnemy when the GLB has clips).
        mixer: null,
        animAction: null,

        // Element impact reaction state.
        statusEffect: { type: null, duration: 0, dpsTimer: 0, dps: 0, weaponIndex: 0 },
        knockbackVel: new THREE.Vector3(),
        // Incoming-knockback multiplier (0 = immune, so the boss shrugs off shots
        // and keeps advancing instead of being staggered/juggled).
        knockbackScale: 1,
        impactFlashColor: null,
        tintMaterials: [],
    };

    collectTintMaterials(enemy);
    return enemy;
}

function spawnEnemy(type, position) {
    const enemy = enemies.find(e => !e.alive);
    if (!enemy) return null;

    enemy.alive = true;
    enemy.spawnGeneration = (enemy.spawnGeneration || 0) + 1;
    enemy.root.visible = true;
    enemy.animState = 'walk';
    enemy.animTimer = 0;
    enemy.walkCycle = Math.random() * Math.PI * 2;
    enemy.hitFlashTimer = 0;
    enemy.deathTimer = 0;
    enemy.squashScale.set(1, 1, 1);
    enemy.attackTimer = 0;
    // Reset per-type combat tunables to their defaults each spawn — the ZOMBIE_4
    // boss overrides these, and pooled slots must not leak them to the next enemy.
    enemy.attackRange = 1.8;
    enemy.attackWindup = 0;
    enemy.windupTimer = -1;
    enemy.hitReactMult = 1;
    enemy.knockbackScale = 1;
    enemy.walkAnimScale = 1.3;
    enemy.useGLB = false;
    enemy.impactBones = [];
    enemy.statusEffect.type = null;
    enemy.statusEffect.duration = 0;
    enemy.statusEffect.dpsTimer = 0;
    enemy.statusEffect.dps = 0;
    enemy.knockbackVel.set(0, 0, 0);
    enemy.impactFlashColor = null;
    resetTint(enemy);

    // Per-enemy uniform scale jitter, kept uniform across X/Y/Z so squash/stretch
    // can't stretch them into balloons. Range is -10%..+15% around the type's base
    // size, but cubing the random biases the distribution hard toward the small
    // end — so the big (near +15%) zombies are really rare while most stay normal.
    // Bosses skip the jitter (they're meant to read as singular).
    const sizeJitter = 0.9 + Math.pow(Math.random(), 3) * 0.25;

    // Configure by type
    switch (type) {
        case ENEMY_TYPES.ZOMBIE: {
            enemy.type = type;
            enemy.health = 30 + waveState.currentWave * 3;
            enemy.maxHealth = enemy.health;
            enemy.speed = 2.0 + Math.random() * 1.0;
            enemy.damage = 8 + waveState.currentWave;
            enemy.hitRadius = 0.7;
            enemy.scoreValue = 100;
            const s = 1.0 * sizeJitter;
            enemy.bodyGroup.scale.setScalar(s);
            enemy.targetBodyScale.setScalar(s);
            setEnemyColors(enemy, 0x00cc99, COLORS.magenta);
            break;
        }

        case ENEMY_TYPES.ZOMBIE_2: {
            enemy.type = type;
            enemy.health = 30 + waveState.currentWave * 3;
            enemy.maxHealth = enemy.health;
            enemy.speed = 2.0 + Math.random() * 1.0;
            enemy.damage = 8 + waveState.currentWave;
            enemy.hitRadius = 0.7;
            enemy.scoreValue = 120;
            const s = 1.0 * sizeJitter;
            enemy.bodyGroup.scale.setScalar(s);
            enemy.targetBodyScale.setScalar(s);
            break;
        }

        case ENEMY_TYPES.FAST_ZOMBIE: {
            enemy.type = type;
            enemy.health = 20 + waveState.currentWave * 2;
            enemy.maxHealth = enemy.health;
            enemy.speed = 4.5 + Math.random() * 1.5;
            enemy.damage = 6 + waveState.currentWave;
            enemy.hitRadius = 0.5;
            enemy.scoreValue = 150;
            const s = 0.8 * sizeJitter;
            enemy.bodyGroup.scale.setScalar(s);
            enemy.targetBodyScale.setScalar(s);
            setEnemyColors(enemy, 0x00ff88, COLORS.lime);
            break;
        }

        case ENEMY_TYPES.TANK_ZOMBIE: {
            enemy.type = type;
            enemy.health = 100 + waveState.currentWave * 10;
            enemy.maxHealth = enemy.health;
            enemy.speed = 1.2 + Math.random() * 0.5;
            enemy.damage = 20 + waveState.currentWave * 2;
            enemy.hitRadius = 1.0;
            enemy.scoreValue = 300;
            const s = 1.4 * sizeJitter;
            enemy.bodyGroup.scale.setScalar(s);
            enemy.targetBodyScale.setScalar(s);
            setEnemyColors(enemy, 0x990066, COLORS.violet);
            break;
        }

        case ENEMY_TYPES.BOSS:
            enemy.type = type;
            enemy.health = 500 + waveState.currentWave * 50;
            enemy.maxHealth = enemy.health;
            enemy.speed = 1.5;
            enemy.damage = 30;
            enemy.hitRadius = 2.0;
            enemy.scoreValue = 2000;
            // Bosses use a fixed uniform scale (no jitter — they're singular).
            enemy.bodyGroup.scale.setScalar(2.5);
            enemy.targetBodyScale.setScalar(2.5);
            setEnemyColors(enemy, COLORS.hotPink, COLORS.magenta);
            break;

        case ENEMY_TYPES.ZOMBIE_4:
        case ENEMY_TYPES.ZOMBIE_5: {
            // Wave-boss: big, tanky and slow, with a telegraphed one-shot melee.
            // ZOMBIE_5 is the wave-1 debut boss; ZOMBIE_4 takes over from wave 2.
            // Both share these stats; HP scales with the wave. Tune to taste.
            enemy.type = type;
            enemy.health = 400 + waveState.currentWave * 50;
            enemy.maxHealth = enemy.health;
            enemy.speed = 1.5;
            enemy.damage = 9999;               // a connecting hit kills the player
            enemy.attackRange = 2.2;           // longer reach to match its bulk
            enemy.hitRadius = 1.2;
            enemy.scoreValue = 1000;
            // The strike lands 1.2s after the attack anim starts — and only if the
            // player is still in range, so a well-timed dash out escapes it.
            enemy.attackWindup = 1.2;
            enemy.hitReactMult = 0.25;         // barely flinches when shot
            enemy.knockbackScale = 0;          // immune to knockback — keeps advancing
            enemy.walkAnimScale = 0.6;         // slow, heavy lumber — velocity unchanged
            // Fixed oversized scale (no jitter) so it reads as a boss.
            const s = 1.8;
            enemy.bodyGroup.scale.setScalar(s);
            enemy.targetBodyScale.setScalar(s);
            break;
        }
    }

    // Hit-volume centre tracks the enemy's height (≈ TARGET_HEIGHT × body scale),
    // so shots register across the whole body — vital for the big bosses whose heads
    // sit far above the old fixed y=1 centre. ×2 gives the body top used to clamp
    // impact FX/decals, so head shots stamp the head instead of the torso.
    enemy.hitCenterY = ZOMBIE_TARGET_HEIGHT * enemy.targetBodyScale.y / 2;

    // Apply real GLB model if loaded (replaces placeholder geometry).
    // Bosses have no GLB asset, so they keep the placeholder geometry.
    const usedGLB = type !== ENEMY_TYPES.BOSS && applyGLBToEnemy(enemy);

    // Refresh tint material list: setEnemyColors() may have swapped the coat material
    // out from under the stale reference, and the placeholder-kept branch (no GLB)
    // otherwise still points at the original per-instance materials from createEnemyObject.
    // applyGLBToEnemy already rebuilt the list for the GLB path, so we skip that case.
    if (!usedGLB) {
        collectTintMaterials(enemy);
    }

    // Position
    enemy.root.position.set(position.x, 0, position.z);
    enemy.root.rotation.y = Math.random() * Math.PI * 2;

    return enemy;
}

function setEnemyColors(enemy, skinColor, coatColor) {
    // Update material colors on body parts
    const children = enemy.bodyGroup.children;
    children.forEach(child => {
        if (child.isMesh && child.material) {
            if (child.geometry.type === 'BoxGeometry' && child.position.y > 0.7 && child.position.y < 1.1) {
                // Coat
                if (child.material.color.getHex() === COLORS.magenta || coatColor) {
                    child.material = createToonMaterial(coatColor);
                }
            }
        }
    });
}

function updateEnemies(dt, onAttackPlayer, onStatusKill) {
    const playerPos = getPlayerPosition();

    enemies.forEach(enemy => {
        if (!enemy.alive) return;

        // Advance skeletal animation. Status effects slow the playback so
        // shocked/frozen zombies visibly stagger. Dying enemies tick at
        // normal speed so the death clip isn't slowed by lingering status.
        if (enemy.mixer) {
            const isDying = enemy.animState === 'dying';
            const mixerSpeedMult = isDying ? 1.0 : (STATUS_SPEED_MULT[enemy.statusEffect.type] ?? 1.0);
            enemy.mixer.update(dt * mixerSpeedMult);
        }

        // Death — GLB clip handles the visual collapse; we just wait out the
        // total (clip duration + 2 s static hold on the last frame) and
        // despawn. clampWhenFinished on the death action keeps the bones
        // pinned to the final pose during the hold.
        // Fallback (no death clip, eg boss with placeholder geometry): the
        // legacy procedural squash + sink keeps a visible death feedback.
        if (enemy.animState === 'dying') {
            enemy.deathTimer += dt;
            const total = enemy.deathTotalDuration ?? 0.5;

            if (!enemy.deathAction) {
                const t = Math.min(enemy.deathTimer / total, 1);
                enemy.bodyGroup.scale.y = enemy.squashScale.y * (1 - t * 0.8);
                enemy.bodyGroup.scale.x = enemy.squashScale.x * (1 + t * 0.3);
                enemy.bodyGroup.scale.z = enemy.squashScale.z * (1 + t * 0.3);
                enemy.root.position.y = -t * 0.5;
            }

            if (enemy.deathTimer >= total) {
                enemy.alive = false;
                enemy.root.visible = false;
                enemy.root.position.y = 0;
                waveState.enemiesRemaining--;
                waveState.totalKills++;
                resetTint(enemy);
            }
            return;
        }

        // Hit flash — squash from targetBodyScale (stable) so repeated hits don't drift.
        // hitReactMult scales the squash per enemy — the boss barely twitches.
        if (enemy.hitFlashTimer > 0) {
            enemy.hitFlashTimer -= dt;
            const react = (enemy.hitFlashTimer / 0.15) * enemy.hitReactMult;
            enemy.bodyGroup.scale.x = enemy.targetBodyScale.x * (1 + react * 0.15);
            enemy.bodyGroup.scale.y = enemy.targetBodyScale.y * (1 - react * 0.1);
            enemy.bodyGroup.scale.z = enemy.targetBodyScale.z * (1 + react * 0.15);
        } else {
            // Restore scale toward target (GLB enemies use 1,1,1; placeholders use type-based)
            enemy.bodyGroup.scale.lerp(enemy.targetBodyScale, dt * 8);
        }

        // Element flash / status pulse tint.
        // Strong flash on fresh hit, soft pulse while a DoT/stun status is active.
        const status = enemy.statusEffect;
        const flashIntensity = enemy.hitFlashTimer > 0
            ? Math.max(0, enemy.hitFlashTimer / 0.15)
            : 0;
        const statusPulse = status.type && status.duration > 0
            ? 0.25 + 0.15 * Math.sin(performance.now() * 0.015)
            : 0;
        const tintIntensity = Math.max(flashIntensity, statusPulse);
        if (tintIntensity > 0 && enemy.impactFlashColor !== null) {
            applyTint(enemy, enemy.impactFlashColor, tintIntensity);
        } else if (flashIntensity === 0 && statusPulse === 0 && enemy.impactFlashColor !== null) {
            resetTint(enemy);
            enemy.impactFlashColor = null;
        }

        // Status effect tick (DoT + duration).
        if (status.type && status.duration > 0) {
            status.duration -= dt;
            if (status.dps > 0) {
                status.dpsTimer += dt;
                if (status.dpsTimer >= 0.25) {
                    status.dpsTimer = 0;
                    const tickDamage = status.dps * 0.25;
                    const wasKilled = damageEnemy(enemy, tickDamage, { fromDoT: true });
                    if (wasKilled && onStatusKill) {
                        onStatusKill(enemy, enemy.root.position.clone().setY(1), status.weaponIndex);
                    }
                }
            }
            if (status.duration <= 0) {
                status.type = null;
                status.dps = 0;
                status.duration = 0;
            }
        }

        // Knockback: move root, then exponentially decay velocity.
        // Decay exponent gives frame-rate independent ~0.82/frame @60fps.
        if (enemy.knockbackVel.lengthSq() > 0.0001) {
            enemy.root.position.addScaledVector(enemy.knockbackVel, dt);
            const decay = Math.pow(KNOCKBACK_DECAY, dt);
            enemy.knockbackVel.multiplyScalar(decay);
        }
        const stunned = enemy.knockbackVel.lengthSq() > 0.5;

        // AI: Move towards player (skipped while staggered by strong knockback).
        const toPlayer = new THREE.Vector3(
            playerPos.x - enemy.root.position.x,
            0,
            playerPos.z - enemy.root.position.z
        );
        const dist = toPlayer.length();

        // A telegraphed attacker (the boss) abandons its swing the moment the
        // target leaves reach — that gap is the player's escape window. (It's
        // knockback-immune, so a stagger never interrupts it.)
        if (enemy.attackWindup > 0 && dist > enemy.attackRange) {
            enemy.windupTimer = -1;
        }

        // Status-based speed modifier.
        const speedMult = STATUS_SPEED_MULT[status.type] ?? 1.0;
        const effectiveSpeed = enemy.speed * speedMult;

        // Cross-fade between walk and attack clips based on engagement range.
        // Stunned enemies stay on walk (the stagger sells the knockback).
        // Attack always restarts from frame 0 (reset() before fadeIn); walk
        // resumes from its previous phase so the gait stays continuous.
        //
        // The .enabled = true line on each side is load-bearing: when a
        // fadeOut completes, three.js sets action.enabled = false on the
        // faded-out action. play() activates the action in the mixer's list
        // but does NOT re-enable it — so a subsequent fadeIn evaluates to 0
        // and the bones snap to bind pose (T-pose). reset() handles this for
        // attack (it sets enabled = true internally); walk needs it manually
        // because we deliberately skip reset() to preserve gait phase.
        if (enemy.walkAction && enemy.attackAction) {
            const desiredAnim = (dist <= enemy.attackRange && !stunned) ? 'attack' : 'walk';
            if (enemy.activeAnim !== desiredAnim) {
                if (desiredAnim === 'attack') {
                    enemy.walkAction.fadeOut(0.2);
                    enemy.attackAction.enabled = true;
                    enemy.attackAction.reset().play().fadeIn(0.2);
                } else {
                    enemy.attackAction.fadeOut(0.2);
                    enemy.walkAction.enabled = true;
                    enemy.walkAction.play().fadeIn(0.2);
                }
                enemy.activeAnim = desiredAnim;
            }
        }

        // Chasing = closing on the player (not in melee range, not staggered).
        const chasing = dist > enemy.attackRange && !stunned;
        // Snapshot position so we can face the *actual* travel direction after the
        // collision passes below slide us around, rather than straight at the player.
        const preMoveX = enemy.root.position.x;
        const preMoveZ = enemy.root.position.z;

        if (chasing) {
            // Move towards player
            toPlayer.normalize();
            enemy.root.position.x += toPlayer.x * effectiveSpeed * dt;
            enemy.root.position.z += toPlayer.z * effectiveSpeed * dt;

            // Face player (baseline; refined to actual travel direction below).
            enemy.root.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

            // Walk animation — skeletal clip drives GLB enemies; placeholders still
            // need the hand-authored squash-bob and box-arm swing.
            if (!enemy.useGLB) {
                enemy.walkCycle += dt * enemy.speed * 3;
                const bob = Math.sin(enemy.walkCycle) * 0.05;
                enemy.bodyGroup.position.y = Math.abs(bob);

                const arms = enemy.bodyGroup.children.filter(c =>
                    c.isMesh && c.geometry.type === 'BoxGeometry' &&
                    Math.abs(c.position.x) > 0.3 && c.position.y < 1.0 && c.position.y > 0.5
                );
                arms.forEach((arm, i) => {
                    arm.rotation.x = Math.sin(enemy.walkCycle + i * Math.PI) * 0.4;
                });
            }
        } else if (!stunned) {
            if (enemy.attackWindup > 0) {
                // Telegraphed strike (boss): the attack clip is already cross-fading
                // in (above). Keep facing the player and wind up; the killing blow
                // only lands if they're still in range when the timer runs out — so
                // the attack animation reads as a warning the player can dash out of.
                enemy.root.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
                if (enemy.windupTimer < 0) {
                    // Swing just started — begin the wind-up and snarl once.
                    enemy.windupTimer = enemy.attackWindup;
                    playGrowl({ aggressive: true, volume: Math.max(0.4, 1 - dist / 30) });
                } else {
                    enemy.windupTimer -= dt;
                    if (enemy.windupTimer <= 0 && PLAYER.isAlive) {
                        onAttackPlayer(enemy.damage);
                        enemy.windupTimer = enemy.attackWindup; // (player is down now)
                    }
                }
            } else {
                // Instant melee — regular zombies chip away on their cooldown.
                enemy.attackTimer -= dt;
                if (enemy.attackTimer <= 0 && PLAYER.isAlive) {
                    onAttackPlayer(enemy.damage);
                    enemy.attackTimer = enemy.attackCooldown;

                    // Attack animation - lunge forward
                    enemy.bodyGroup.scale.z = enemy.squashScale.z * 1.2;
                    enemy.bodyGroup.scale.x = enemy.squashScale.x * 0.85;

                    // Aggressive snarl on the lunge (occasional, so a packed melee
                    // ring doesn't drown the mix). Attacks happen point-blank, so
                    // these are loud — dist falloff barely trims them.
                    if (Math.random() < 0.5) {
                        playGrowl({ aggressive: true, volume: Math.max(0.3, 1 - dist / 30) });
                    }
                }
            }
        }

        // Simple collision avoidance between enemies
        enemies.forEach(other => {
            if (other === enemy || !other.alive || other.animState === 'dying') return;
            const sep = enemy.root.position.clone().sub(other.root.position);
            sep.y = 0;
            const sepDist = sep.length();
            const minDist = enemy.hitRadius + other.hitRadius;
            if (sepDist < minDist && sepDist > 0.01) {
                sep.normalize().multiplyScalar((minDist - sepDist) * 0.5);
                enemy.root.position.add(sep);
            }
        });

        // Push out of any wall AABB. Done last so AI move, knockback, and
        // inter-enemy separation can all freely shove the enemy first; the
        // wall resolve has the final say.
        resolveEnemyWallCollision(enemy);

        // Face the direction actually travelled this frame — chase intent minus
        // whatever the wall slide / crowd separation deflected — so a zombie
        // sliding along a wall points along it instead of moonwalking sideways
        // while still aimed at the player. A fully-blocked zombie barely moves and
        // keeps the straight-at-player heading set during the move step.
        if (chasing) {
            const dx = enemy.root.position.x - preMoveX;
            const dz = enemy.root.position.z - preMoveZ;
            if (dx * dx + dz * dz > 1e-5) {
                enemy.root.rotation.y = Math.atan2(dx, dz);
            }
        }
    });

    // Ambient horde growls — on a randomized cadence, one random living zombie
    // growls. Closer zombies are louder. Denser hordes growl a touch more often
    // (clamped) so the soundscape scales with the threat without ever spamming.
    ambientGrowlTimer -= dt;
    if (ambientGrowlTimer <= 0) {
        const growlers = enemies.filter(e => e.alive && e.animState !== 'dying');
        if (growlers.length > 0) {
            const who = growlers[Math.floor(Math.random() * growlers.length)];
            const dx = playerPos.x - who.root.position.x;
            const dz = playerPos.z - who.root.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            playGrowl({ volume: Math.max(0.15, 1 - dist / 35) });
        }
        const cadence = growlers.length > 0
            ? Math.max(0.8, 2.8 / Math.sqrt(growlers.length))
            : 2.5;
        ambientGrowlTimer = cadence * (0.7 + Math.random() * 0.6);
    }
}

function damageEnemy(enemy, damage, opts = {}) {
    if (!enemy.alive || enemy.animState === 'dying') return false;

    enemy.health -= damage;
    enemy.hitFlashTimer = 0.15;
    // NOTE: squashScale is captured at death (below) only. We do NOT copy the live
    // bodyGroup.scale on every hit — under continuous fire (cryo stream) the live
    // scale is already mid-squash, so re-capturing would compound the deform and
    // drift enemies into weird proportions over time.

    // Element-specific flash color (lerps over existing emissive during flash).
    if (opts.element && ELEMENT_TINT[opts.element] !== undefined) {
        enemy.impactFlashColor = ELEMENT_TINT[opts.element];
    }

    // Knockback (skip for DoT ticks so burn doesn't keep pushing enemies back).
    // knockbackScale 0 (the boss) shrugs it off entirely so it never staggers.
    if (!opts.fromDoT && opts.knockbackDir && opts.knockbackStrength > 0 && enemy.knockbackScale > 0) {
        enemy.knockbackVel.copy(opts.knockbackDir).setY(0).normalize()
            .multiplyScalar(opts.knockbackStrength * enemy.knockbackScale);
    }

    // Status effect application — on same type, take max remaining duration.
    if (!opts.fromDoT && opts.statusEffect && opts.statusEffect.type) {
        const incoming = opts.statusEffect;
        const current = enemy.statusEffect;
        if (current.type !== incoming.type || incoming.duration > current.duration) {
            current.type = incoming.type;
            current.duration = incoming.duration;
            current.dps = incoming.dps || 0;
            current.dpsTimer = 0;
            current.weaponIndex = incoming.weaponIndex ?? 0;
        }
    }

    if (enemy.health <= 0) {
        enemy.animState = 'dying';
        enemy.deathTimer = 0;
        // Snapshot current scale so the procedural fallback squashes from the
        // live pose; harmless when the GLB death clip is driving instead.
        enemy.squashScale.copy(enemy.bodyGroup.scale);

        if (enemy.deathAction) {
            // Cross-fade walk/attack out and play the death clip once. The
            // clip ends with clampWhenFinished pinning the dead pose; we hold
            // there for 2 s before despawning. .enabled = true is required
            // (same reason as walk/attack: play() doesn't re-enable a
            // previously faded-out action — though for death this only matters
            // on pool recycling, where the prior life's death action got
            // disabled at clip end).
            enemy.walkAction?.fadeOut(0.2);
            enemy.attackAction?.fadeOut(0.2);
            enemy.deathAction.enabled = true;
            enemy.deathAction.reset();
            enemy.deathAction.play();
            enemy.deathTotalDuration = enemy.deathClipDuration + 2.0;
            enemy.activeAnim = 'death';
        } else {
            // Procedural fallback (bosses & GLB load failures): old 0.5 s squash.
            enemy.deathTotalDuration = 0.5;
        }

        return true; // Enemy killed
    }
    return false; // Enemy still alive
}

// Wave management
function updateWaves(dt, onWaveStart, onBossWave) {
    if (!waveState.waveActive) {
        waveState.waveDelayTimer -= dt;
        if (waveState.waveDelayTimer <= 0) {
            startWave(onWaveStart, onBossWave);
        }
        return;
    }

    // Spawn enemies
    if (waveState.enemiesSpawned < waveState.enemiesToSpawn) {
        waveState.spawnTimer -= dt;
        if (waveState.spawnTimer <= 0) {
            spawnWaveEnemy();
            waveState.spawnTimer = waveState.spawnInterval;
        }
    }

    // Check wave complete
    if (waveState.enemiesRemaining <= 0 && waveState.enemiesSpawned >= waveState.enemiesToSpawn) {
        waveState.waveActive = false;
        waveState.currentWave++;
        waveState.waveDelayTimer = waveState.waveDelay;
    }
}

function startWave(onWaveStart, onBossWave) {
    const wave = waveState.currentWave;
    waveState.waveActive = true;
    waveState.enemiesSpawned = 0;
    waveState.spawnTimer = 0.5;

    // Escalating difficulty: the regular horde, then the wave's boss(es) close it
    // out. Wave 1 debuts the single Zombie_5 boss; from wave 2 the Zombie_4 bosses
    // take over and scale — 1 on wave 2, then +1 each wave after.
    waveState.regularToSpawn = Math.min(5 + wave * 3, 40);
    if (wave === 1) {
        waveState.bossToSpawn = 1;
        waveState.bossType = ENEMY_TYPES.ZOMBIE_5;
    } else {
        waveState.bossToSpawn = wave - 1;
        waveState.bossType = ENEMY_TYPES.ZOMBIE_4;
    }
    waveState.enemiesToSpawn = waveState.regularToSpawn + waveState.bossToSpawn;
    waveState.spawnInterval = Math.max(0.3, 1.5 - wave * 0.08);
    waveState.enemiesRemaining = waveState.enemiesToSpawn;

    // Boss every 5 waves
    waveState.bossWave = (wave % 5 === 0);
    waveState.bossSpawned = false;

    if (onWaveStart) onWaveStart(wave);
    if (waveState.bossWave && onBossWave) onBossWave(wave);
}

function spawnWaveEnemy() {
    const points = ARENA.spawnPoints;
    const isBoss = waveState.enemiesSpawned >= waveState.regularToSpawn;

    // Bosses are big, so they always spawn at the arena spawner (the last placed
    // enemy spawn — out in the open arena) instead of round-robining onto the tight
    // corridor spawner. Regular enemies round-robin through every spawner.
    const bestSpawn = isBoss
        ? points[points.length - 1]
        : points[waveState.enemiesSpawned % points.length];

    // Add some randomness to spawn position
    const spawnPos = {
        x: bestSpawn.x + (Math.random() - 0.5) * 4,
        z: bestSpawn.z + (Math.random() - 0.5) * 4,
    };

    // Determine enemy type
    let type = ENEMY_TYPES.ZOMBIE;
    const wave = waveState.currentWave;

    if (isBoss) {
        // Horde is fully out — the wave's boss(es) arrive to end the wave
        // (Zombie_5 on wave 1, Zombie_4 from wave 2 on).
        type = waveState.bossType;
    } else {
        const rand = Math.random();
        if (waveState.bossWave && !waveState.bossSpawned) {
            type = ENEMY_TYPES.BOSS;
            waveState.bossSpawned = true;
        } else if (wave >= 3 && rand < 0.15) {
            type = ENEMY_TYPES.TANK_ZOMBIE;
        } else if (wave >= 2 && rand < 0.35) {
            type = ENEMY_TYPES.FAST_ZOMBIE;
        } else if (rand < 0.7) {
            type = ENEMY_TYPES.ZOMBIE_2;
        }
    }

    const enemy = spawnEnemy(type, spawnPos);
    if (enemy) {
        waveState.enemiesSpawned++;
    }
}

function getAliveEnemies() {
    return enemies.filter(e => e.alive);
}

function resetEnemies() {
    enemies.forEach(e => {
        e.alive = false;
        e.root.visible = false;
        e.root.position.y = 0;
        e.animState = 'idle';
        e.useGLB = false;
        e.targetBodyScale.set(1, 1, 1);
        e.statusEffect.type = null;
        e.statusEffect.duration = 0;
        e.statusEffect.dpsTimer = 0;
        e.statusEffect.dps = 0;
        e.knockbackVel.set(0, 0, 0);
        e.impactFlashColor = null;
        resetTint(e);
    });

    waveState.currentWave = 1;
    waveState.enemiesRemaining = 0;
    waveState.enemiesSpawned = 0;
    waveState.enemiesToSpawn = 0;
    waveState.regularToSpawn = 0;
    waveState.bossToSpawn = 0;
    waveState.bossType = null;
    waveState.waveActive = false;
    waveState.waveDelayTimer = 2.0;
    waveState.bossWave = false;
    waveState.bossSpawned = false;
    waveState.totalKills = 0;

    ambientGrowlTimer = 2.0;
}

// World-space position of the enemy's head — anchor for HUD popups so the
// score / damage text sits just above the head and follows the skeletal
// animation. Uses the cached "Head" bone when present (all zombie GLBs share
// it); falls back to a procedural offset for bosses (no GLB).
function getEnemyHeadWorldPos(enemy, target) {
    if (enemy.headBone) {
        enemy.headBone.getWorldPosition(target);
    } else {
        target.copy(enemy.root.position);
        target.y += 1.65 * (enemy.bodyGroup.scale.y || 1);
    }
    return target;
}

export {
    enemies, waveState, ENEMY_TYPES,
    initEnemies, updateEnemies, updateWaves,
    damageEnemy, getAliveEnemies, resetEnemies,
    getEnemyHeadWorldPos,
    spawnEnemy,
};

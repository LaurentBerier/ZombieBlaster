// ============================================
// Enemy System: Zombies, Bosses, Wave Management
// Squash-and-stretch animation, AI, spawning
// ============================================

import { scene, COLORS, NEON_PALETTE, createToonMaterial, addOutline } from './scene.js';
import { PLAYER, getPlayerPosition } from './player.js';
import { ARENA, ROOM_DEFS } from './arena.js';
import { cloneAsset, getAssetAnimations } from './assetLoader.js';

// Target world-space height for the zombie GLB (in Three.js units).
// Auto-fit scales the raw model bbox to this height so we don't hard-code
// magic numbers that break if the art team re-exports the asset.
const ZOMBIE_TARGET_HEIGHT = 2.0;

// The Zombie_1 GLB's authored bbox dwarfs the arena — the mesh was exported
// at a scale that auto-fit alone can't tame. Extra 1/100 knockdown brings
// it in line with the player/weapon sizes.
const ZOMBIE_EXTRA_SCALE = 0.01;

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
    FAST_ZOMBIE: 'fast_zombie',
    TANK_ZOMBIE: 'tank_zombie',
    BOSS: 'boss',
};

// Wave management
const waveState = {
    currentWave: 1,
    enemiesRemaining: 0,
    enemiesSpawned: 0,
    enemiesToSpawn: 0,
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
    const model = cloneAsset('enemy_zombie');
    if (!model) return false;

    enemy.bodyGroup.clear();
    // Drop any prior mixer so we don't tick a detached skeleton.
    enemy.mixer = null;
    enemy.animAction = null;

    // Fit the raw model bbox to our target height so re-exported assets
    // with different source scales continue to render at the right size.
    _bbox.setFromObject(model);
    _bbox.getSize(_bboxSize);
    const rawHeight = _bboxSize.y || 1;
    const scale = (ZOMBIE_TARGET_HEIGHT / rawHeight) * ZOMBIE_EXTRA_SCALE;
    model.scale.setScalar(scale);
    // Lift so the scaled bbox minY sits at bodyGroup y=0 (feet on the floor).
    model.position.y = -_bbox.min.y * scale;

    // GLB forward axis already aligns with root.rotation from atan2(toPlayer.x, toPlayer.z) — no Y flip.
    model.rotation.y = 0;

    enemy.bodyGroup.add(model);
    // Reset scale — the GLB is already the correct size; squash/stretch acts on top of this.
    enemy.bodyGroup.scale.set(1, 1, 1);
    enemy.squashScale.set(1, 1, 1);
    enemy.useGLB = true;

    // Set up animation mixer if the asset brought skeletal clips along with it.
    // Play the first clip (walk) looping — each enemy needs its own mixer bound
    // to its own cloned skeleton, which cloneAsset handled via SkeletonUtils.
    const clips = getAssetAnimations('enemy_zombie');
    if (clips.length > 0) {
        enemy.mixer = new THREE.AnimationMixer(model);
        const clip = clips[0];
        const action = enemy.mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        // 1.3 → 30% faster than authored so the unsteady walk has a touch more urgency.
        action.timeScale = 1.3;
        // Random phase offset so a crowd of zombies doesn't march in lockstep.
        action.time = Math.random() * clip.duration;
        action.play();
        enemy.animAction = action;
    }

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
        health: 30,
        maxHealth: 30,
        speed: 2.5,
        damage: 10,
        attackRange: 1.8,
        attackCooldown: 1.0,
        attackTimer: 0,
        hitRadius: 0.7,
        scoreValue: 100,

        // Squash-and-stretch animation state
        animState: 'idle',
        animTimer: 0,
        walkCycle: 0,
        hitFlashTimer: 0,
        deathTimer: 0,
        squashScale: new THREE.Vector3(1, 1, 1),
        // Target scale for bodyGroup restore after squash (overridden when GLB is used)
        targetBodyScale: new THREE.Vector3(1, 1, 1),
        useGLB: false,
        // Skeletal animation state (set in applyGLBToEnemy when the GLB has clips).
        mixer: null,
        animAction: null,

        // Element impact reaction state.
        statusEffect: { type: null, duration: 0, dpsTimer: 0, dps: 0, weaponIndex: 0 },
        knockbackVel: new THREE.Vector3(),
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
    enemy.root.visible = true;
    enemy.animState = 'walk';
    enemy.animTimer = 0;
    enemy.walkCycle = Math.random() * Math.PI * 2;
    enemy.hitFlashTimer = 0;
    enemy.deathTimer = 0;
    enemy.squashScale.set(1, 1, 1);
    enemy.attackTimer = 0;
    enemy.useGLB = false;
    enemy.statusEffect.type = null;
    enemy.statusEffect.duration = 0;
    enemy.statusEffect.dpsTimer = 0;
    enemy.statusEffect.dps = 0;
    enemy.knockbackVel.set(0, 0, 0);
    enemy.impactFlashColor = null;
    resetTint(enemy);

    // Configure by type
    switch (type) {
        case ENEMY_TYPES.ZOMBIE:
            enemy.type = type;
            enemy.health = 30 + waveState.currentWave * 3;
            enemy.maxHealth = enemy.health;
            enemy.speed = 2.0 + Math.random() * 1.0;
            enemy.damage = 8 + waveState.currentWave;
            enemy.hitRadius = 0.7;
            enemy.scoreValue = 100;
            enemy.bodyGroup.scale.set(1, 1, 1);
            enemy.targetBodyScale.set(1, 1, 1);
            setEnemyColors(enemy, 0x00cc99, COLORS.magenta);
            break;

        case ENEMY_TYPES.FAST_ZOMBIE:
            enemy.type = type;
            enemy.health = 20 + waveState.currentWave * 2;
            enemy.maxHealth = enemy.health;
            enemy.speed = 4.5 + Math.random() * 1.5;
            enemy.damage = 6 + waveState.currentWave;
            enemy.hitRadius = 0.5;
            enemy.scoreValue = 150;
            enemy.bodyGroup.scale.set(0.7, 0.9, 0.7);
            enemy.targetBodyScale.set(0.7, 0.9, 0.7);
            setEnemyColors(enemy, 0x00ff88, COLORS.lime);
            break;

        case ENEMY_TYPES.TANK_ZOMBIE:
            enemy.type = type;
            enemy.health = 100 + waveState.currentWave * 10;
            enemy.maxHealth = enemy.health;
            enemy.speed = 1.2 + Math.random() * 0.5;
            enemy.damage = 20 + waveState.currentWave * 2;
            enemy.hitRadius = 1.0;
            enemy.scoreValue = 300;
            enemy.bodyGroup.scale.set(1.4, 1.3, 1.4);
            enemy.targetBodyScale.set(1.4, 1.3, 1.4);
            setEnemyColors(enemy, 0x990066, COLORS.violet);
            break;

        case ENEMY_TYPES.BOSS:
            enemy.type = type;
            enemy.health = 500 + waveState.currentWave * 50;
            enemy.maxHealth = enemy.health;
            enemy.speed = 1.5;
            enemy.damage = 30;
            enemy.hitRadius = 2.0;
            enemy.scoreValue = 2000;
            enemy.bodyGroup.scale.set(2.5, 2.5, 2.5);
            enemy.targetBodyScale.set(2.5, 2.5, 2.5);
            setEnemyColors(enemy, COLORS.hotPink, COLORS.magenta);
            break;
    }

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

        // Advance skeletal animation (walk loop). Status effects slow the playback
        // so shocked/frozen zombies visibly stagger. Dying enemies freeze mid-pose.
        if (enemy.mixer && enemy.animState !== 'dying') {
            const mixerSpeedMult = STATUS_SPEED_MULT[enemy.statusEffect.type] ?? 1.0;
            enemy.mixer.update(dt * mixerSpeedMult);
        }

        // Death animation
        if (enemy.animState === 'dying') {
            enemy.deathTimer += dt;
            const t = enemy.deathTimer / 0.5; // 0.5s death animation

            // Squash and shrink
            enemy.bodyGroup.scale.y = enemy.squashScale.y * (1 - t * 0.8);
            enemy.bodyGroup.scale.x = enemy.squashScale.x * (1 + t * 0.3);
            enemy.bodyGroup.scale.z = enemy.squashScale.z * (1 + t * 0.3);

            // Fade
            enemy.root.position.y = -t * 0.5;

            if (enemy.deathTimer >= 0.5) {
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
        if (enemy.hitFlashTimer > 0) {
            enemy.hitFlashTimer -= dt;
            const hitT = enemy.hitFlashTimer / 0.15;
            enemy.bodyGroup.scale.x = enemy.targetBodyScale.x * (1 + hitT * 0.15);
            enemy.bodyGroup.scale.y = enemy.targetBodyScale.y * (1 - hitT * 0.1);
            enemy.bodyGroup.scale.z = enemy.targetBodyScale.z * (1 + hitT * 0.15);
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

        // Status-based speed modifier.
        const speedMult = STATUS_SPEED_MULT[status.type] ?? 1.0;
        const effectiveSpeed = enemy.speed * speedMult;

        if (dist > enemy.attackRange && !stunned) {
            // Move towards player
            toPlayer.normalize();
            enemy.root.position.x += toPlayer.x * effectiveSpeed * dt;
            enemy.root.position.z += toPlayer.z * effectiveSpeed * dt;

            // Face player
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
            // Attack player
            enemy.attackTimer -= dt;
            if (enemy.attackTimer <= 0 && PLAYER.isAlive) {
                onAttackPlayer(enemy.damage);
                enemy.attackTimer = enemy.attackCooldown;

                // Attack animation - lunge forward
                enemy.bodyGroup.scale.z = enemy.squashScale.z * 1.2;
                enemy.bodyGroup.scale.x = enemy.squashScale.x * 0.85;
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
    });
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
    if (!opts.fromDoT && opts.knockbackDir && opts.knockbackStrength > 0) {
        enemy.knockbackVel.copy(opts.knockbackDir).setY(0).normalize()
            .multiplyScalar(opts.knockbackStrength);
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
        // Snapshot current scale so the death animation squashes from the live pose,
        // not a stale value from enemy creation time.
        enemy.squashScale.copy(enemy.bodyGroup.scale);
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

    // Escalating difficulty
    waveState.enemiesToSpawn = Math.min(5 + wave * 3, 40);
    waveState.spawnInterval = Math.max(0.3, 1.5 - wave * 0.08);
    waveState.enemiesRemaining = waveState.enemiesToSpawn;

    // Boss every 5 waves
    waveState.bossWave = (wave % 5 === 0);
    waveState.bossSpawned = false;

    if (onWaveStart) onWaveStart(wave);
    if (waveState.bossWave && onBossWave) onBossWave(wave);
}

function spawnWaveEnemy() {
    // Pick spawn point far from player
    const playerPos = getPlayerPosition();
    let bestSpawn = ARENA.spawnPoints[0];
    let bestDist = 0;

    ARENA.spawnPoints.forEach(sp => {
        const dist = Math.sqrt((sp.x - playerPos.x) ** 2 + (sp.z - playerPos.z) ** 2);
        if (dist > bestDist) {
            bestDist = dist;
            bestSpawn = sp;
        }
    });

    // Add some randomness to spawn position
    const spawnPos = {
        x: bestSpawn.x + (Math.random() - 0.5) * 4,
        z: bestSpawn.z + (Math.random() - 0.5) * 4,
    };

    // Determine enemy type
    let type = ENEMY_TYPES.ZOMBIE;
    const rand = Math.random();
    const wave = waveState.currentWave;

    if (waveState.bossWave && !waveState.bossSpawned) {
        type = ENEMY_TYPES.BOSS;
        waveState.bossSpawned = true;
    } else if (wave >= 3 && rand < 0.15) {
        type = ENEMY_TYPES.TANK_ZOMBIE;
    } else if (wave >= 2 && rand < 0.35) {
        type = ENEMY_TYPES.FAST_ZOMBIE;
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
    waveState.waveActive = false;
    waveState.waveDelayTimer = 2.0;
    waveState.bossWave = false;
    waveState.bossSpawned = false;
    waveState.totalKills = 0;
}

export {
    enemies, waveState, ENEMY_TYPES,
    initEnemies, updateEnemies, updateWaves,
    damageEnemy, getAliveEnemies, resetEnemies,
    spawnEnemy,
};

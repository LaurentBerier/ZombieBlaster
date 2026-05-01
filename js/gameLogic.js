// ============================================
// Core Game Logic
// Combo system, scoring, traps, game flow
// ============================================

import { scene, COLORS, createToonMaterial } from './scene.js';
import { PLAYER, getPlayerPosition } from './player.js';
import { ARENA } from './arena.js';
import { updateEvolution } from './weapons.js';

// Score and combo state
const scoreState = {
    score: 0,
    highScore: 0,
    comboMultiplier: 1,
    maxComboMultiplier: 1,
    comboTimer: 0,
    comboWindow: 3.0,       // Seconds to maintain combo
    killStreak: 0,
    maxKillStreak: 0,
    totalKills: 0,
};

// Environmental traps
const traps = [];
const MAX_TRAPS = 10;

// Trap types
const TRAP_TYPES = {
    CRUSHER: 'crusher',
    ACID_VAT: 'acid_vat',
    PIPE_BURST: 'pipe_burst',
};

function initGameLogic(trapData) {
    // Load high score
    try {
        scoreState.highScore = parseInt(localStorage.getItem('zombieBlasterHighScore') || '0', 10);
    } catch (e) {
        scoreState.highScore = 0;
    }

    // Create environmental traps (from JSON data or hardcoded fallbacks)
    createTraps(trapData);
}

// ---- COMBO & SCORING ----

function addKill(scoreValue) {
    scoreState.killStreak++;
    scoreState.totalKills++;

    // Reset combo timer
    scoreState.comboTimer = scoreState.comboWindow;

    // Increase multiplier based on streak
    if (scoreState.killStreak >= 20) {
        scoreState.comboMultiplier = 8;
    } else if (scoreState.killStreak >= 15) {
        scoreState.comboMultiplier = 5;
    } else if (scoreState.killStreak >= 10) {
        scoreState.comboMultiplier = 4;
    } else if (scoreState.killStreak >= 5) {
        scoreState.comboMultiplier = 3;
    } else if (scoreState.killStreak >= 3) {
        scoreState.comboMultiplier = 2;
    } else {
        scoreState.comboMultiplier = 1;
    }

    scoreState.maxComboMultiplier = Math.max(scoreState.maxComboMultiplier, scoreState.comboMultiplier);
    scoreState.maxKillStreak = Math.max(scoreState.maxKillStreak, scoreState.killStreak);

    // Add score with multiplier
    const points = scoreValue * scoreState.comboMultiplier;
    scoreState.score += points;

    // Update weapon evolution based on new score
    updateEvolution(scoreState.score);

    return points;
}

function updateCombo(dt) {
    if (scoreState.comboTimer > 0) {
        scoreState.comboTimer -= dt;
        if (scoreState.comboTimer <= 0) {
            // Combo broken
            scoreState.killStreak = 0;
            scoreState.comboMultiplier = 1;
        }
    }
}

function onPlayerDamaged() {
    // Taking damage breaks combo
    scoreState.killStreak = Math.max(0, scoreState.killStreak - 2);
    if (scoreState.killStreak < 3) {
        scoreState.comboMultiplier = 1;
    }
}

function saveHighScore() {
    if (scoreState.score > scoreState.highScore) {
        scoreState.highScore = scoreState.score;
        try {
            localStorage.setItem('zombieBlasterHighScore', String(scoreState.highScore));
        } catch (e) {
            // localStorage not available
        }
        return true; // New high score
    }
    return false;
}

// ---- ENVIRONMENTAL TRAPS ----

function createTraps(trapData) {
    if (trapData) {
        // Load from JSON level data
        (trapData.crushers || []).forEach(c =>
            createCrusher(c.x, c.y, c.z, c.width, c.depth, c.thickness, c.period, c.damage));
        (trapData.acidPools || []).forEach(a =>
            createAcidPool(a.x, a.z, a.radius, a.damageRate));
        (trapData.pipeBursts || []).forEach(p =>
            createPipeBurst(p.x, p.y, p.z, p.direction, p.period, p.burstDuration, p.damage, p.damageRadius));
    } else {
        // Hardcoded fallbacks
        createCrusher(-15, 4, 0, 4, 4, 0.8);
        createCrusher(15, 4, 0, 4, 4, 0.8);
        createAcidPool(-30, -6, 3);
        createAcidPool(30, 6, 3);
        createAcidPool(0, -28, 2.5);
        createPipeBurst(-14, 2, -12, 'x');
        createPipeBurst(14, 2, 12, 'x');
        createPipeBurst(0, 2, -20, 'z');
    }
}

function createCrusher(x, y, z, width, depth, thickness, period = 4, damage = 40) {
    const root = new THREE.Group();
    root.name = 'trap_crusher';

    const crushGeo = new THREE.BoxGeometry(width, thickness, depth);
    const crushMat = createToonMaterial(0x555555, COLORS.red, 0.1);
    const crushMesh = new THREE.Mesh(crushGeo, crushMat);
    root.add(crushMesh);

    // Warning stripes
    const stripeGeo = new THREE.BoxGeometry(width + 0.1, 0.05, depth + 0.1);
    const stripeMat = createToonMaterial(COLORS.yellow);
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    stripe.position.y = -thickness / 2 - 0.025;
    root.add(stripe);

    root.position.set(x, y, z);
    scene.add(root);

    traps.push({
        type: TRAP_TYPES.CRUSHER,
        root,
        x, z,
        width, depth,
        startY: y,
        endY: 0.5,
        speed: 4,
        timer: Math.random() * period,
        period,
        phase: 'up', // up or down
        damageAmount: damage,
        damageCooldown: 0,
    });
}

function createAcidPool(x, z, radius, damageRate = 15) {
    const root = new THREE.Group();
    root.name = 'trap_acid';

    // Glowing green pool on floor
    const poolGeo = new THREE.CircleGeometry(radius, 16);
    const poolMat = createToonMaterial(COLORS.lime, COLORS.lime, 0.8);
    poolMat.transparent = true;
    poolMat.opacity = 0.7;
    const pool = new THREE.Mesh(poolGeo, poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.02;
    root.add(pool);

    // Bubble particles (simple spheres)
    for (let i = 0; i < 5; i++) {
        const bubbleGeo = new THREE.SphereGeometry(0.08 + Math.random() * 0.06, 6, 6);
        const bubbleMat = createToonMaterial(COLORS.lime, COLORS.lime, 1.5);
        bubbleMat.transparent = true;
        bubbleMat.opacity = 0.6;
        const bubble = new THREE.Mesh(bubbleGeo, bubbleMat);
        bubble.position.set(
            (Math.random() - 0.5) * radius * 1.5,
            0.1 + Math.random() * 0.3,
            (Math.random() - 0.5) * radius * 1.5
        );
        bubble.userData.baseY = bubble.position.y;
        bubble.userData.speed = 1 + Math.random() * 2;
        bubble.userData.phase = Math.random() * Math.PI * 2;
        root.add(bubble);
    }

    // Point light
    const light = new THREE.PointLight(COLORS.lime, 0.8, radius * 2);
    light.position.y = 0.5;
    root.add(light);

    root.position.set(x, 0, z);
    scene.add(root);

    traps.push({
        type: TRAP_TYPES.ACID_VAT,
        root,
        x, z, radius,
        damageRate,
        damageCooldown: 0,
    });
}

function createPipeBurst(x, y, z, direction, period = 6, burstDuration = 1.5, damage = 20, damageRadius = 2) {
    const root = new THREE.Group();
    root.name = 'trap_pipe_burst';

    // Pipe
    const pipeGeo = new THREE.CylinderGeometry(0.12, 0.12, 1.5, 6);
    const pipeMat = createToonMaterial(0x444455, COLORS.orange, 0.1);
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);

    // Burst effect (hidden by default)
    const burstGeo = new THREE.ConeGeometry(0.5, 2, 8);
    const burstMat = createToonMaterial(COLORS.orange, COLORS.orange, 1.5);
    burstMat.transparent = true;
    burstMat.opacity = 0.7;
    const burst = new THREE.Mesh(burstGeo, burstMat);
    burst.visible = false;

    if (direction === 'x') {
        pipe.rotation.z = Math.PI / 2;
        burst.rotation.z = Math.PI / 2;
        burst.position.x = 1.2;
    } else {
        pipe.rotation.x = Math.PI / 2;
        burst.rotation.x = -Math.PI / 2;
        burst.position.z = 1.2;
    }

    root.add(pipe);
    root.add(burst);
    root.position.set(x, y, z);
    scene.add(root);

    traps.push({
        type: TRAP_TYPES.PIPE_BURST,
        root,
        burst,
        x, y, z,
        direction,
        timer: Math.random() * period,
        period,
        burstDuration,
        isBursting: false,
        burstTimer: 0,
        damageAmount: damage,
        damageRadius: damageRadius,
        damageCooldown: 0,
    });
}

function updateTraps(dt, enemies) {
    const playerPos = getPlayerPosition();
    let totalPlayerDamage = 0;

    traps.forEach(trap => {
        if (trap.damageCooldown > 0) trap.damageCooldown -= dt;

        let result = null;
        switch (trap.type) {
            case TRAP_TYPES.CRUSHER:
                result = updateCrusher(trap, dt, playerPos, enemies);
                break;
            case TRAP_TYPES.ACID_VAT:
                result = updateAcidPool(trap, dt, playerPos, enemies);
                break;
            case TRAP_TYPES.PIPE_BURST:
                result = updatePipeBurst(trap, dt, playerPos, enemies);
                break;
        }
        if (result && result.damagePlayer) {
            totalPlayerDamage += result.damagePlayer;
        }
    });

    return totalPlayerDamage;
}

function updateCrusher(trap, dt, playerPos, enemies) {
    trap.timer += dt;
    const cycle = (trap.timer % trap.period) / trap.period;

    // Smooth up/down motion
    let t;
    if (cycle < 0.4) {
        t = 0; // Waiting up
    } else if (cycle < 0.5) {
        t = (cycle - 0.4) / 0.1; // Coming down fast
    } else if (cycle < 0.6) {
        t = 1; // Holding down
    } else {
        t = 1 - (cycle - 0.6) / 0.4; // Going back up slowly
    }

    const y = trap.startY - (trap.startY - trap.endY) * t;
    trap.root.position.y = y;

    // Damage when near bottom
    if (t > 0.8) {
        const halfW = trap.width / 2;
        const halfD = trap.depth / 2;

        // Damage player
        if (trap.damageCooldown <= 0 &&
            playerPos.x > trap.x - halfW && playerPos.x < trap.x + halfW &&
            playerPos.z > trap.z - halfD && playerPos.z < trap.z + halfD) {
            return { damagePlayer: trap.damageAmount };
        }

        // Damage enemies
        enemies.forEach(enemy => {
            if (!enemy.alive || enemy.animState === 'dying') return;
            const ex = enemy.root.position.x;
            const ez = enemy.root.position.z;
            if (ex > trap.x - halfW && ex < trap.x + halfW &&
                ez > trap.z - halfD && ez < trap.z + halfD) {
                enemy.health -= trap.damageAmount * dt;
                if (enemy.health <= 0) {
                    enemy.animState = 'dying';
                    enemy.deathTimer = 0;
                }
            }
        });
    }
    return null;
}

function updateAcidPool(trap, dt, playerPos, enemies) {
    // Animate bubbles
    trap.root.children.forEach(child => {
        if (child.userData.baseY !== undefined) {
            child.userData.phase += dt * child.userData.speed;
            child.position.y = child.userData.baseY + Math.sin(child.userData.phase) * 0.15;
        }
    });

    // Player damage
    const dx = playerPos.x - trap.x;
    const dz = playerPos.z - trap.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < trap.radius && trap.damageCooldown <= 0) {
        trap.damageCooldown = 0.5;
        return { damagePlayer: Math.round(trap.damageRate * 0.5) };
    }

    // Enemy damage
    enemies.forEach(enemy => {
        if (!enemy.alive || enemy.animState === 'dying') return;
        const ex = enemy.root.position.x - trap.x;
        const ez = enemy.root.position.z - trap.z;
        if (Math.sqrt(ex * ex + ez * ez) < trap.radius) {
            enemy.health -= trap.damageRate * dt;
            if (enemy.health <= 0) {
                enemy.animState = 'dying';
                enemy.deathTimer = 0;
            }
        }
    });

    return null;
}

function updatePipeBurst(trap, dt, playerPos, enemies) {
    trap.timer += dt;

    if (!trap.isBursting) {
        if (trap.timer >= trap.period) {
            trap.isBursting = true;
            trap.burstTimer = trap.burstDuration;
            trap.timer = 0;
            trap.burst.visible = true;
        }
    } else {
        trap.burstTimer -= dt;

        // Pulse effect
        const scale = 1 + Math.sin(trap.burstTimer * 15) * 0.2;
        trap.burst.scale.set(scale, 1, scale);

        // Damage entities in range
        const checkDamage = (pos) => {
            const dx = pos.x - trap.x;
            const dz = pos.z - trap.z;
            return Math.sqrt(dx * dx + dz * dz) < trap.damageRadius;
        };

        if (checkDamage(playerPos) && trap.damageCooldown <= 0) {
            trap.damageCooldown = 0.5;
            trap.isBursting = trap.burstTimer > 0;
            if (trap.burstTimer <= 0) trap.burst.visible = false;
            return { damagePlayer: trap.damageAmount };
        }

        enemies.forEach(enemy => {
            if (!enemy.alive || enemy.animState === 'dying') return;
            if (checkDamage(enemy.root.position)) {
                enemy.health -= trap.damageAmount * dt;
                if (enemy.health <= 0) {
                    enemy.animState = 'dying';
                    enemy.deathTimer = 0;
                }
            }
        });

        if (trap.burstTimer <= 0) {
            trap.isBursting = false;
            trap.burst.visible = false;
        }
    }
    return null;
}

function resetGameLogic() {
    scoreState.score = 0;
    scoreState.comboMultiplier = 1;
    scoreState.maxComboMultiplier = 1;
    scoreState.comboTimer = 0;
    scoreState.killStreak = 0;
    scoreState.maxKillStreak = 0;
    scoreState.totalKills = 0;

    traps.forEach(trap => {
        trap.timer = Math.random() * trap.period;
        if (trap.isBursting !== undefined) {
            trap.isBursting = false;
            if (trap.burst) trap.burst.visible = false;
        }
        trap.damageCooldown = 0;
    });
}

export {
    scoreState,
    initGameLogic,
    addKill, updateCombo, onPlayerDamaged,
    saveHighScore,
    updateTraps, resetGameLogic,
    traps,
};

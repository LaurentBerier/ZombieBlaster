// ============================================
// First-Person Player Controller
// WASD movement, mouse-look, jump, dash
// ============================================

import { camera, scene, COLORS, createToonMaterial, addOutline } from './scene.js';
import { ARENA } from './arena.js';

const PLAYER = {
    // Position & physics
    position: new THREE.Vector3(0, 1.7, 5),
    velocity: new THREE.Vector3(0, 0, 0),
    onGround: true,

    // Stats
    health: 100,
    maxHealth: 100,
    walkSpeed: 6,
    fwdSpeedMultiplier: 1.3,
    runSpeedMultiplier: 1.8,
    jumpForce: 7,
    gravity: -18,

    // Dash
    dashSpeed: 25,
    dashDuration: 0.15,
    dashCooldown: 1.5,
    dashTimer: 0,
    dashCooldownTimer: 0,
    isDashing: false,
    dashDirection: new THREE.Vector3(),

    // Mouse look
    yaw: 0,
    pitch: 0,
    rotSpeed: 1.0,
    mouseSensitivity: 0.002,
    minPitch: -1.0,
    maxPitch: 1.0,

    // State
    isAlive: true,
    invulnTimer: 0,

    // Weapon bob
    bobTime: 0,
    bobIntensity: 0,
};

// Input state
const keys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    dash: false,
    fire: false,
    aim: false,
    reload: false,
};

let pointerLocked = false;
let weaponGroup = null; // Reference to weapon visual in first-person
const WEAPON_VIEW_OFFSET = {
    x: 0.28,
    y: -0.35,
    z: -0.42,
};
const WEAPON_VIEW_ROTATION = {
    x: 0.2,
    y: 0.14,
    z: -0.0,
};
const ADS_VIEW_OFFSET = {
    x: 0.0,
    y: -0.3,
    z: -0.34,
};
const ADS_VIEW_ROTATION = {
    x: -0.02,
    y: 0.0,
    z: 0.0,
};
const DEFAULT_FOV = 75;
const ADS_FOV = 62;

function initPlayer() {
    camera.position.copy(PLAYER.position);

    // Create first-person weapon holder
    weaponGroup = new THREE.Group();
    weaponGroup.name = 'fps_weapon_holder';
    weaponGroup.position.set(
        WEAPON_VIEW_OFFSET.x,
        WEAPON_VIEW_OFFSET.y,
        WEAPON_VIEW_OFFSET.z
    );
    weaponGroup.rotation.set(
        WEAPON_VIEW_ROTATION.x,
        WEAPON_VIEW_ROTATION.y,
        WEAPON_VIEW_ROTATION.z
    );
    camera.add(weaponGroup);
    scene.add(camera);

    // Input listeners
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', onContextMenu);

    document.addEventListener('pointerlockchange', () => {
        pointerLocked = document.pointerLockElement === document.querySelector('canvas');
    });

    return PLAYER;
}

function requestPointerLock() {
    const canvas = document.querySelector('canvas');
    if (canvas) {
        try { canvas.requestPointerLock(); } catch (e) { /* Requires user gesture */ }
    }
}

function exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
}

function onKeyDown(e) {
    switch (e.code) {
        case 'KeyW': keys.forward = true; break;
        case 'KeyS': keys.backward = true; break;
        case 'KeyA': keys.left = true; break;
        case 'KeyD': keys.right = true; break;
        case 'Space': keys.jump = true; break;
        case 'ShiftLeft': case 'ShiftRight': keys.sprint = true; break;
        case 'KeyQ': keys.dash = true; break;
        case 'KeyR': keys.reload = true; break;
    }
}

function onKeyUp(e) {
    switch (e.code) {
        case 'KeyW': keys.forward = false; break;
        case 'KeyS': keys.backward = false; break;
        case 'KeyA': keys.left = false; break;
        case 'KeyD': keys.right = false; break;
        case 'Space': keys.jump = false; break;
        case 'ShiftLeft': case 'ShiftRight': keys.sprint = false; break;
        case 'KeyQ': keys.dash = false; break;
        case 'KeyR': keys.reload = false; break;
    }
}

function onMouseMove(e) {
    if (!pointerLocked) return;
    PLAYER.yaw -= e.movementX * PLAYER.mouseSensitivity * PLAYER.rotSpeed;
    PLAYER.pitch -= e.movementY * PLAYER.mouseSensitivity * PLAYER.rotSpeed;
    PLAYER.pitch = Math.max(PLAYER.minPitch, Math.min(PLAYER.maxPitch, PLAYER.pitch));
}

function onMouseDown(e) {
    if (e.button === 0) keys.fire = true;
    if (e.button === 2) keys.aim = true;
}

function onMouseUp(e) {
    if (e.button === 0) keys.fire = false;
    if (e.button === 2) keys.aim = false;
}

function onContextMenu(e) {
    e.preventDefault();
}

function updatePlayer(dt, aliveEnemies) {
    if (!PLAYER.isAlive) return;

    // Clamp dt to prevent physics explosions
    dt = Math.min(dt, 0.05);

    // Camera rotation
    const euler = new THREE.Euler(PLAYER.pitch, PLAYER.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    // ADS zoom transition for precision shooting feel.
    const targetFov = keys.aim ? ADS_FOV : DEFAULT_FOV;
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
    camera.updateProjectionMatrix();

    // Movement direction relative to camera
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, PLAYER.yaw, 0))
    );
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, PLAYER.yaw, 0))
    );

    // Handle dash
    if (PLAYER.isDashing) {
        PLAYER.dashTimer -= dt;
        if (PLAYER.dashTimer <= 0) {
            PLAYER.isDashing = false;
        } else {
            // During dash, move in dash direction at high speed
            PLAYER.velocity.x = PLAYER.dashDirection.x * PLAYER.dashSpeed;
            PLAYER.velocity.z = PLAYER.dashDirection.z * PLAYER.dashSpeed;
        }
    } else {
        // Normal movement
        const moveDir = new THREE.Vector3(0, 0, 0);
        if (keys.forward) moveDir.add(forward);
        if (keys.backward) moveDir.sub(forward);
        if (keys.right) moveDir.add(right);
        if (keys.left) moveDir.sub(right);

        if (moveDir.lengthSq() > 0) {
            let actualSpeed = PLAYER.walkSpeed;
            const onlyForward = keys.forward && !keys.backward && !keys.left && !keys.right;
            if (!keys.reload && onlyForward) {
                actualSpeed *= keys.sprint ? PLAYER.runSpeedMultiplier : PLAYER.fwdSpeedMultiplier;
            }
            moveDir.normalize();
            PLAYER.velocity.x = moveDir.x * actualSpeed;
            PLAYER.velocity.z = moveDir.z * actualSpeed;
            PLAYER.bobIntensity = 1;
        } else {
            PLAYER.velocity.x *= 0.85; // Deceleration
            PLAYER.velocity.z *= 0.85;
            PLAYER.bobIntensity *= 0.9;
        }

        // Initiate dash
        if (keys.dash && PLAYER.dashCooldownTimer <= 0) {
            PLAYER.isDashing = true;
            PLAYER.dashTimer = PLAYER.dashDuration;
            PLAYER.dashCooldownTimer = PLAYER.dashCooldown;

            // Dash in movement direction or forward if standing still
            if (moveDir.lengthSq() > 0) {
                PLAYER.dashDirection.copy(moveDir.normalize());
            } else {
                PLAYER.dashDirection.copy(forward);
            }
        }
    }

    // Dash cooldown
    if (PLAYER.dashCooldownTimer > 0) {
        PLAYER.dashCooldownTimer -= dt;
    }

    // Jump
    if (keys.jump && PLAYER.onGround) {
        PLAYER.velocity.y = PLAYER.jumpForce;
        PLAYER.onGround = false;
    }

    // Gravity
    if (!PLAYER.onGround) {
        PLAYER.velocity.y += PLAYER.gravity * dt;
    }

    // Invulnerability timer
    if (PLAYER.invulnTimer > 0) {
        PLAYER.invulnTimer -= dt;
    }

    // Apply velocity with collision
    const newPos = PLAYER.position.clone();
    newPos.x += PLAYER.velocity.x * dt;
    newPos.z += PLAYER.velocity.z * dt;
    newPos.y += PLAYER.velocity.y * dt;

    // Collision with walls (horizontal)
    const playerRadius = 0.4;
    const playerHeight = 1.7;

    ARENA.walls.forEach(wall => {
        if (wall.isPlatform) return; // Handle platforms separately

        // Check horizontal collision
        const closestX = Math.max(wall.minX, Math.min(newPos.x, wall.maxX));
        const closestZ = Math.max(wall.minZ, Math.min(newPos.z, wall.maxZ));
        const dx = newPos.x - closestX;
        const dz = newPos.z - closestZ;
        const distSq = dx * dx + dz * dz;

        // Vertical overlap: player camera at newPos.y, feet at newPos.y - playerHeight.
        // Skip walls entirely above the player's head (eg ceiling beams) and walls
        // entirely below the player's feet (sub-floor colliders, if any).
        if (
            distSq < playerRadius * playerRadius &&
            newPos.y > wall.minY &&
            newPos.y - playerHeight < wall.maxY
        ) {
            const dist = Math.sqrt(distSq);
            if (dist > 0.001) {
                const pushX = dx / dist;
                const pushZ = dz / dist;
                newPos.x = closestX + pushX * playerRadius;
                newPos.z = closestZ + pushZ * playerRadius;
            }
        }
    });

    // Enemy collision — push the player out of each living zombie's footprint
    // circle so you can't phase through them on the chase. Mass model: the
    // player slides, the zombie stays put. (Enemies already stop at attackRange
    // ≈ 1.8, so this only kicks in when the player runs into them.) Dying
    // enemies are ignored so corpses don't block the room.
    if (Array.isArray(aliveEnemies)) {
        for (let i = 0; i < aliveEnemies.length; i++) {
            const enemy = aliveEnemies[i];
            if (!enemy || !enemy.alive || enemy.animState === 'dying') continue;
            const ex = enemy.root.position.x;
            const ez = enemy.root.position.z;
            const dx = newPos.x - ex;
            const dz = newPos.z - ez;
            const distSq = dx * dx + dz * dz;
            const combined = playerRadius + (enemy.hitRadius ?? 0.7);
            if (distSq < combined * combined && distSq > 0.0001) {
                const dist = Math.sqrt(distSq);
                const overlap = combined - dist;
                newPos.x += (dx / dist) * overlap;
                newPos.z += (dz / dist) * overlap;
            }
        }
    }

    // Platform collision (vertical)
    let onPlatform = false;
    ARENA.walls.forEach(wall => {
        if (!wall.isPlatform) return;
        if (newPos.x > wall.minX && newPos.x < wall.maxX &&
            newPos.z > wall.minZ && newPos.z < wall.maxZ) {
            // Check if falling onto platform
            if (PLAYER.velocity.y <= 0 && newPos.y <= wall.topY + playerHeight && newPos.y > wall.topY) {
                newPos.y = wall.topY + playerHeight;
                PLAYER.velocity.y = 0;
                PLAYER.onGround = true;
                onPlatform = true;
            }
            // Check if below platform top and moving up through it
            else if (PLAYER.position.y - playerHeight > wall.topY) {
                // Above platform - allow landing
            }
        }
    });

    // Ground collision
    if (newPos.y <= playerHeight && !onPlatform) {
        newPos.y = playerHeight;
        PLAYER.velocity.y = 0;
        PLAYER.onGround = true;
    } else if (!onPlatform && newPos.y > playerHeight) {
        PLAYER.onGround = false;
    }

    PLAYER.position.copy(newPos);
    camera.position.copy(PLAYER.position);

    // Weapon bob animation
    const activeOffset = keys.aim ? ADS_VIEW_OFFSET : WEAPON_VIEW_OFFSET;
    const activeRotation = keys.aim ? ADS_VIEW_ROTATION : WEAPON_VIEW_ROTATION;
    const bobScale = keys.aim ? 0.35 : 1.0;
    if (PLAYER.bobIntensity > 0.01) {
        PLAYER.bobTime += dt * 10;
        const bobX = Math.sin(PLAYER.bobTime) * 0.03 * PLAYER.bobIntensity * bobScale;
        const bobY = Math.abs(Math.cos(PLAYER.bobTime)) * 0.04 * PLAYER.bobIntensity * bobScale;
        if (weaponGroup) {
            weaponGroup.position.x = activeOffset.x + bobX;
            weaponGroup.position.y = activeOffset.y + bobY;
            weaponGroup.position.z = activeOffset.z;
            weaponGroup.rotation.set(
                activeRotation.x,
                activeRotation.y,
                activeRotation.z
            );
        }
    } else if (weaponGroup) {
        weaponGroup.position.set(
            activeOffset.x,
            activeOffset.y,
            activeOffset.z
        );
        weaponGroup.rotation.set(
            activeRotation.x,
            activeRotation.y,
            activeRotation.z
        );
    }

    return keys; // Return input state for weapon system
}

function damagePlayer(amount) {
    if (PLAYER.invulnTimer > 0 || !PLAYER.isAlive) return;

    PLAYER.health -= amount;
    PLAYER.invulnTimer = 0.3; // Brief invulnerability

    // Visual feedback
    const overlay = document.getElementById('damage-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('hidden'), 300);
    }

    if (PLAYER.health <= 0) {
        PLAYER.health = 0;
        PLAYER.isAlive = false;
    }
}

function resetPlayer() {
    PLAYER.position.set(0, 1.7, 5);
    PLAYER.velocity.set(0, 0, 0);
    PLAYER.health = PLAYER.maxHealth;
    PLAYER.isAlive = true;
    PLAYER.onGround = true;
    PLAYER.yaw = 0;
    PLAYER.pitch = 0;
    PLAYER.dashCooldownTimer = 0;
    PLAYER.isDashing = false;
    keys.sprint = false;
    keys.dash = false;
    keys.aim = false;
    PLAYER.invulnTimer = 0;
    camera.fov = DEFAULT_FOV;
    camera.updateProjectionMatrix();
    camera.position.copy(PLAYER.position);
}

function getPlayerForward() {
    const dir = new THREE.Vector3(0, 0, -1);
    dir.applyQuaternion(camera.quaternion);
    return dir;
}

function getPlayerPosition() {
    return PLAYER.position.clone();
}

export {
    PLAYER, keys,
    initPlayer, updatePlayer, damagePlayer, resetPlayer,
    requestPointerLock, exitPointerLock,
    getPlayerForward, getPlayerPosition,
    weaponGroup,
};

// ============================================
// Franken-Gun Arsenal System
// 4 weapons with rapid swapping, evolution
// ============================================

import { scene, camera, COLORS, createToonMaterial, addOutline } from './scene.js';
import { ARENA } from './arena.js';
import { PLAYER, keys, getPlayerForward, getPlayerPosition } from './player.js';
import { weaponGroup } from './player.js';
import { cloneAsset } from './assetLoader.js';
import { spawnPlasmaTrail, spawnSmokeTrail, spawnChainLightning, spawnExplosion, spawnDropletTrail } from './effects.js';

const INFINITE_AMMO = true;

// Weapon definitions - the Franken-Gun arsenal.
// fx block: per-weapon impact reaction used by onWeaponHit in main.js.
//   element        — drives enemy tint color ('fire'|'shock'|'acid'|'freeze')
//   knockback      — impulse magnitude applied along firing direction
//   status         — DoT/stun status inflicted on direct hits
//   hitParticles   — count of generic burst particles spawned at hit point
//   shake          — { amp, duration } for triggerScreenShake (0 = no shake)
//   splash         — post-hit effect: 'explosion' | 'liquid' | null
const WEAPON_DEFS = [
    {
        name: 'FRANKEN-GUN',
        description: 'Cobbled-together plasma rifle',
        fireRate: 0.15,
        damage: 15,
        ammo: 30,
        maxAmmo: 120,
        reloadTime: 1.5,
        type: 'projectile',
        projectileType: 'plasma',
        projectileSpeed: 45,
        projectileRadius: 0.18,
        spread: 0.02,
        color: COLORS.magenta,
        projectileColor: COLORS.magenta,
        fx: {
            element: 'shock',
            knockback: 3.0,
            status: { type: 'shock', duration: 0.4, dps: 0 },
            hitParticles: 8,
            shake: { amp: 0.08, duration: 0.08 },
            killShake: { amp: 0.12, duration: 0.12 },
            splash: null,
            trail: 'plasma',
        },
        evolutionLevels: [
            { scoreThreshold: 0, name: 'FRANKEN-GUN Mk.I', damage: 15, fireRate: 0.15, color: COLORS.magenta },
            { scoreThreshold: 2000, name: 'FRANKEN-GUN Mk.II', damage: 22, fireRate: 0.12, color: COLORS.hotPink },
            { scoreThreshold: 5000, name: 'FRANKEN-GUN Mk.III', damage: 30, fireRate: 0.10, color: COLORS.yellow },
        ],
    },
    {
        name: 'BOWLING LAUNCHER',
        description: 'Heavy rocket launcher',
        fireRate: 0.8,
        damage: 60,
        ammo: 8,
        maxAmmo: 32,
        reloadTime: 2.0,
        type: 'projectile',
        projectileType: 'rocket',
        spread: 0.0,
        projectileSpeed: 22,
        projectileRadius: 0.3,
        color: COLORS.orange,
        projectileColor: COLORS.orange,
        aoe: true,
        aoeRadius: 3.5,
        fx: {
            element: 'fire',
            knockback: 6.0,
            status: { type: 'burn', duration: 2.5, dps: 8 },
            hitParticles: 4,
            shake: { amp: 0.35, duration: 0.25 },
            killShake: { amp: 0.5, duration: 0.35 },
            splash: 'explosion',
            trail: 'smoke',
            explosionRadius: 3.5,
        },
        evolutionLevels: [
            { scoreThreshold: 0, name: 'BOWLING LAUNCHER Mk.I', damage: 60, fireRate: 0.8, color: COLORS.orange },
            { scoreThreshold: 2000, name: 'BOWLING LAUNCHER Mk.II', damage: 85, fireRate: 0.65, color: COLORS.yellow },
            { scoreThreshold: 5000, name: 'BOWLING LAUNCHER Mk.III', damage: 120, fireRate: 0.5, color: COLORS.red },
        ],
    },
    {
        name: 'SODA LASER',
        description: 'Corrosive acid sprayer',
        fireRate: 0.05,
        damage: 5,
        ammo: 100,
        maxAmmo: 400,
        reloadTime: 2.5,
        type: 'projectile',
        projectileType: 'liquid',
        projectileSpeed: 35,
        projectileRadius: 0.12,
        spread: 0.025,
        color: COLORS.cyan,
        projectileColor: COLORS.cyan,
        fx: {
            element: 'acid',
            knockback: 0.8,
            status: { type: 'corrode', duration: 1.5, dps: 3 },
            hitParticles: 3,
            shake: { amp: 0.02, duration: 0.04 },
            killShake: { amp: 0.05, duration: 0.08 },
            splash: 'liquid',
            acidPoolChance: 0.3,
            acidPoolRadius: 1.2,
            acidPoolDuration: 2.0,
            acidPoolDps: 5,
        },
        evolutionLevels: [
            { scoreThreshold: 0, name: 'SODA LASER Mk.I', damage: 5, fireRate: 0.05, color: COLORS.cyan },
            { scoreThreshold: 2000, name: 'SODA LASER Mk.II', damage: 8, fireRate: 0.04, color: COLORS.lime },
            { scoreThreshold: 5000, name: 'SODA LASER Mk.III', damage: 12, fireRate: 0.03, color: COLORS.green },
        ],
    },
    {
        name: 'CRYO BLASTER',
        description: 'Continuous freezing-goo stream',
        fireRate: 0.06,
        damage: 7,
        ammo: 80,
        maxAmmo: 320,
        reloadTime: 2.2,
        type: 'projectile',
        projectileType: 'blob',
        projectileSpeed: 32,
        projectileRadius: 0.18,
        spread: 0.02,
        color: COLORS.cyan,
        projectileColor: COLORS.cyan,
        fx: {
            element: 'freeze',
            // Tiny per-hit knockback — many small shoves stack into steady backwards drift
            // without any single hit yeeting the enemy off-screen.
            knockback: 0.6,
            // Short duration: every ~0.06s hit refreshes the 0.5s freeze so enemies stay
            // slowed while the stream is on target, and thaw quickly once it sweeps off.
            status: { type: 'freeze', duration: 0.5, dps: 0 },
            hitParticles: 2,
            shake: { amp: 0.015, duration: 0.03 },
            killShake: { amp: 0.08, duration: 0.1 },
            splash: 'liquid',
            splashCount: 6,
            trail: 'droplet',
        },
        evolutionLevels: [
            { scoreThreshold: 0, name: 'CRYO BLASTER Mk.I', damage: 7, fireRate: 0.06, color: COLORS.cyan },
            { scoreThreshold: 2000, name: 'CRYO BLASTER Mk.II', damage: 10, fireRate: 0.05, color: 0x66e6ff },
            { scoreThreshold: 5000, name: 'CRYO BLASTER Mk.III', damage: 14, fireRate: 0.04, color: COLORS.white },
        ],
    },
];

// Active weapon state
const weaponState = {
    currentIndex: 0,
    fireTimer: 0,
    isReloading: false,
    reloadTimer: 0,
    currentAmmo: [],
    reserveAmmo: [],
    meshes: [],           // Weapon visual meshes (first person)
    activeEvolutionLevel: [0, 0, 0, 0],
};

// Projectile pool — sized for Soda stream (~16 concurrent) + rockets (~5) + plasma (~8) plus headroom.
const projectiles = [];
const MAX_PROJECTILES = 80;

// Beam visual
let beamLine = null;
let beamTimer = 0;

// Muzzle flash
let muzzleFlash = null;
let muzzleFlashTimer = 0;

// Tracer pool for hitscan visual feedback
const tracers = [];
const MAX_TRACERS = 10;

function initWeapons() {
    // Initialize ammo for each weapon
    WEAPON_DEFS.forEach((def, i) => {
        weaponState.currentAmmo[i] = def.ammo;
        weaponState.reserveAmmo[i] = def.maxAmmo;
    });

    // Create first-person weapon meshes
    createWeaponMeshes();

    // Create beam line
    const beamGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -50),
    ]);
    const beamMat = new THREE.LineBasicMaterial({ color: COLORS.cyan, linewidth: 2 });
    beamLine = new THREE.Line(beamGeo, beamMat);
    beamLine.visible = false;
    beamLine.frustumCulled = false;
    scene.add(beamLine);

    // Create muzzle flash
    const flashGeo = new THREE.SphereGeometry(0.08, 6, 6);
    const flashMat = createToonMaterial(COLORS.yellow, COLORS.yellow, 2.0);
    muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
    muzzleFlash.visible = false;

    // Create tracer pool for hitscan bullet trails
    for (let i = 0; i < MAX_TRACERS; i++) {
        const tracerGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, -1),
        ]);
        const tracerMat = new THREE.LineBasicMaterial({
            color: COLORS.magenta,
            linewidth: 2,
            transparent: true,
            opacity: 1.0,
        });
        const tracerLine = new THREE.Line(tracerGeo, tracerMat);
        tracerLine.visible = false;
        tracerLine.frustumCulled = false;
        scene.add(tracerLine);
        tracers.push({ line: tracerLine, timer: 0, maxTime: 0.12 });
    }

    // Projectile pool initialization
    for (let i = 0; i < MAX_PROJECTILES; i++) {
        const projRoot = new THREE.Group();
        const projGeo = new THREE.SphereGeometry(0.15, 8, 8);
        const projMat = createToonMaterial(COLORS.orange, COLORS.orange, 1.5);
        const projMesh = new THREE.Mesh(projGeo, projMat);
        projRoot.add(projMesh);

        // Glow
        const glowGeo = new THREE.SphereGeometry(0.25, 6, 6);
        const glowMat = new THREE.MeshBasicMaterial({ color: COLORS.orange, transparent: true, opacity: 0.3 });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        projRoot.add(glow);

        projRoot.visible = false;
        projRoot.userData = {
            active: false,
            velocity: new THREE.Vector3(),
            damage: 0,
            lifetime: 0,
            aoe: false,
            aoeRadius: 0,
            weaponIndex: 0,
            projectileType: 'rocket',
            gravity: 0,
            trail: null,
            trailTimer: 0,
            color: COLORS.orange,
        };
        scene.add(projRoot);
        projectiles.push(projRoot);
    }
}

function applyNeonAccentGlow(root) {
    root.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((mat) => {
            if (!mat.color || !mat.emissive) return;
            const hsl = { h: 0, s: 0, l: 0 };
            mat.color.getHSL(hsl);
            const isNeonAccent =
                ((hsl.h > 0.20 && hsl.h < 0.48) ||
                (hsl.h > 0.48 && hsl.h < 0.62) ||
                (hsl.h > 0.12 && hsl.h <= 0.20)) &&
                hsl.s > 0.12;
            if (isNeonAccent) {
                mat.emissive.copy(mat.color).multiplyScalar(0.7);
                mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 0, 0.95);
            }
        });
    });
}

function attachFirstPersonGlbMesh(mesh, glbRoot, opts = {}) {
    const scale = opts.scaleScalar ?? 0.45;
    const px = opts.positionX ?? 0.02;
    const py = opts.positionY ?? -0.1;
    const pz = opts.positionZ ?? -0.35;
    const ryOffset = opts.rotationYOffset ?? 0;
    glbRoot.scale.setScalar(scale);
    glbRoot.rotation.set(-0.08, Math.PI * 1.5 + ryOffset, 0);
    glbRoot.position.set(px, py, pz);
    applyNeonAccentGlow(glbRoot);
    mesh.add(glbRoot);
}

// Same FP pose as weapon 2 (coil rifle) for weapon 3 mesh.
const FP_WEAPON_2_3_MESH_OPTS = {
    scaleScalar: 0.9,
    positionY: -0.03,
};

// Shotgun GLB ships rotated 90° from the other guns and authored smaller, so
// add a +90° yaw and a 1.5x scale bump on top of the shared base.
const FP_WEAPON_3_MESH_OPTS = {
    ...FP_WEAPON_2_3_MESH_OPTS,
    rotationYOffset: Math.PI / 2,
    scaleScalar: FP_WEAPON_2_3_MESH_OPTS.scaleScalar * 1.5,
};

// Build first-person weapon meshes.
// Weapon slot 0 (Franken-Gun) uses the preloaded GLB from assetLoader;
// Slots 0–3: GLB meshes (or placeholders on load failure).
function createWeaponMeshes() {
    if (!weaponGroup) return;

    WEAPON_DEFS.forEach((def, i) => {
        const mesh = new THREE.Group();
        mesh.name = `weapon_${i}`;

        if (i === 0) {
            const biohazardGun = cloneAsset('weapon_biohazard');
            if (biohazardGun) {
                attachFirstPersonGlbMesh(mesh, biohazardGun);
            } else {
                const rogueCharacter = cloneAsset('weapon_rogue_prefab');
                const rogueWeapon = rogueCharacter?.getObjectByName('weapon_rifle');
                if (rogueWeapon) {
                    rogueWeapon.scale.setScalar(0.76);
                    rogueWeapon.rotation.set(-0.08, Math.PI, 0);
                    rogueWeapon.position.set(0.02, -0.1, -0.35);
                    mesh.add(rogueWeapon);
                } else {
                    addWeaponPlaceholder(mesh, def, i);
                }
            }
        } else if (i === 1) {
            const coilGun = cloneAsset('weapon_plasma_coil');
            if (coilGun) {
                attachFirstPersonGlbMesh(mesh, coilGun, FP_WEAPON_2_3_MESH_OPTS);
            } else {
                addWeaponPlaceholder(mesh, def, i);
            }
        } else if (i === 2) {
            const emberGun = cloneAsset('weapon_ember_blaster');
            if (emberGun) {
                attachFirstPersonGlbMesh(mesh, emberGun, FP_WEAPON_3_MESH_OPTS);
            } else {
                addWeaponPlaceholder(mesh, def, i);
            }
        } else if (i === 3) {
            const plasmaGun = cloneAsset('weapon_neon_plasma_blaster');
            if (plasmaGun) {
                attachFirstPersonGlbMesh(mesh, plasmaGun, FP_WEAPON_2_3_MESH_OPTS);
            } else {
                addWeaponPlaceholder(mesh, def, i);
            }
        } else {
            addWeaponPlaceholder(mesh, def, i);
        }

        mesh.visible = (i === 0);
        weaponGroup.add(mesh);
        weaponState.meshes.push(mesh);
    });

    // Muzzle flash sits in weaponGroup (not inside a weapon mesh)
    if (muzzleFlash) {
        muzzleFlash.position.set(0, 0.02, -0.55);
        weaponGroup.add(muzzleFlash);
    }
}

// Primitive placeholder geometry for weapons that don't yet have a GLB,
// or as fallback when the GLB failed to load.
function addWeaponPlaceholder(mesh, def, i) {
    const bodyGeo = new THREE.BoxGeometry(0.15, 0.12, 0.5);
    const body = new THREE.Mesh(bodyGeo, createToonMaterial(0x333340));
    mesh.add(body);
    addOutline(body, bodyGeo, 1.08);

    const barrelGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.35, 6);
    const barrel = new THREE.Mesh(barrelGeo, createToonMaterial(def.color, def.color, 0.3));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.35);
    mesh.add(barrel);

    if (i === 1) {
        const wideGeo = new THREE.CylinderGeometry(0.08, 0.06, 0.25, 8);
        const wide = new THREE.Mesh(wideGeo, createToonMaterial(def.color, def.color, 0.2));
        wide.rotation.x = Math.PI / 2;
        wide.position.set(0, 0, -0.45);
        mesh.add(wide);
    } else if (i === 2) {
        const can = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.04, 0.12, 8),
            createToonMaterial(COLORS.red)
        );
        can.position.set(0, 0.1, -0.15);
        mesh.add(can);
        const lens = new THREE.Mesh(
            new THREE.SphereGeometry(0.035, 6, 6),
            createToonMaterial(COLORS.cyan, COLORS.cyan, 1.0)
        );
        lens.position.set(0, 0.02, -0.52);
        mesh.add(lens);
    } else if (i === 3) {
        const teslaGeo = new THREE.ConeGeometry(0.04, 0.12, 6);
        const teslaMat = createToonMaterial(COLORS.lime, COLORS.lime, 0.5);
        [-0.06, 0.06].forEach(x => {
            const t = new THREE.Mesh(teslaGeo, teslaMat);
            t.position.set(x, 0.1, -0.25);
            mesh.add(t);
        });
    } else {
        // Slot 0 fallback: energy coils + pressure tank
        const coilGeo = new THREE.TorusGeometry(0.05, 0.015, 4, 8);
        const coilMat = createToonMaterial(COLORS.lime, COLORS.lime, 0.8);
        for (let c = 0; c < 3; c++) {
            const coil = new THREE.Mesh(coilGeo, coilMat);
            coil.position.set(0, 0.07, -0.1 - c * 0.1);
            coil.rotation.y = Math.PI / 2;
            mesh.add(coil);
        }
        const tank = new THREE.Mesh(
            new THREE.SphereGeometry(0.06, 6, 6),
            createToonMaterial(COLORS.cyan)
        );
        tank.position.set(0.1, 0, -0.1);
        mesh.add(tank);
    }

    const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.12, 0.08),
        createToonMaterial(0x444455)
    );
    handle.position.set(0, -0.1, -0.05);
    handle.rotation.x = 0.3;
    mesh.add(handle);
}

function getCurrentWeapon() {
    return WEAPON_DEFS[weaponState.currentIndex];
}

function getCurrentEvolution() {
    const weapon = getCurrentWeapon();
    const level = weaponState.activeEvolutionLevel[weaponState.currentIndex];
    return weapon.evolutionLevels[level] || weapon.evolutionLevels[0];
}

function switchWeapon(index) {
    if (index < 0 || index >= WEAPON_DEFS.length) return;
    if (index === weaponState.currentIndex) return;
    if (weaponState.isReloading) return;

    // Hide current, show new
    weaponState.meshes[weaponState.currentIndex].visible = false;
    weaponState.currentIndex = index;
    weaponState.meshes[index].visible = true;
    weaponState.fireTimer = 0;

    // Quick swap animation (bounce)
    const mesh = weaponState.meshes[index];
    mesh.position.y = -0.15;
    mesh.rotation.x = 0.2;
}

function updateWeapons(dt, enemies, onHitCallback) {
    const weapon = getCurrentWeapon();
    const evolution = getCurrentEvolution();

    // Weapon switch animation recovery
    const mesh = weaponState.meshes[weaponState.currentIndex];
    mesh.position.y *= 0.85;
    mesh.rotation.x *= 0.85;

    // Fire timer
    if (weaponState.fireTimer > 0) {
        weaponState.fireTimer -= dt;
    }

    // Reload timer
    if (weaponState.isReloading) {
        weaponState.reloadTimer -= dt;
        // Reload visual wobble
        mesh.rotation.z = Math.sin(weaponState.reloadTimer * 12) * 0.05;

        if (weaponState.reloadTimer <= 0) {
            weaponState.isReloading = false;
            mesh.rotation.z = 0;
            const idx = weaponState.currentIndex;
            const needed = WEAPON_DEFS[idx].ammo - weaponState.currentAmmo[idx];
            const available = Math.min(needed, weaponState.reserveAmmo[idx]);
            weaponState.currentAmmo[idx] += available;
            weaponState.reserveAmmo[idx] -= available;
        }
        return;
    }

    // Reload input
    if (keys.reload && weaponState.currentAmmo[weaponState.currentIndex] < weapon.ammo) {
        startReload();
        return;
    }

    // Fire
    if (keys.fire && weaponState.fireTimer <= 0 && weaponState.currentAmmo[weaponState.currentIndex] > 0) {
        fireWeapon(weapon, evolution, enemies, onHitCallback);
        weaponState.fireTimer = evolution.fireRate;
        if (!INFINITE_AMMO) {
            weaponState.currentAmmo[weaponState.currentIndex]--;

            // Auto-reload when empty
            if (weaponState.currentAmmo[weaponState.currentIndex] <= 0 && weaponState.reserveAmmo[weaponState.currentIndex] > 0) {
                startReload();
            }
        }
    }

    // Muzzle flash timer
    if (muzzleFlashTimer > 0) {
        muzzleFlashTimer -= dt;
        if (muzzleFlashTimer <= 0 && muzzleFlash) {
            muzzleFlash.visible = false;
        }
    }

    // Beam timer
    if (beamTimer > 0) {
        beamTimer -= dt;
        if (beamTimer <= 0) {
            beamLine.visible = false;
        }
    }

    // Update projectiles
    updateProjectiles(dt, enemies, onHitCallback);

    // Update tracer fade-out
    updateTracers(dt);
}

function startReload() {
    weaponState.isReloading = true;
    weaponState.reloadTimer = WEAPON_DEFS[weaponState.currentIndex].reloadTime;
}

function fireWeapon(weapon, evolution, enemies, onHitCallback) {
    const origin = getPlayerPosition();
    const dir = getPlayerForward();
    const spreadMultiplier = keys.aim ? 0.25 : 1.0;
    const activeSpread = weapon.spread * spreadMultiplier;

    // Apply spread
    dir.x += (Math.random() - 0.5) * activeSpread;
    dir.y += (Math.random() - 0.5) * activeSpread;
    dir.z += (Math.random() - 0.5) * activeSpread;
    dir.normalize();

    // Muzzle flash
    if (muzzleFlash) {
        muzzleFlash.visible = true;
        muzzleFlash.material.color.setHex(evolution.color);
        muzzleFlash.material.emissive.setHex(evolution.color);
        muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.5);
        muzzleFlashTimer = 0.05;
    }

    // Recoil (weapon kick)
    const mesh = weaponState.meshes[weaponState.currentIndex];
    mesh.position.z = 0.05;
    mesh.rotation.x = -0.08;

    if (weapon.type === 'hitscan') {
        performHitscan(origin, dir, evolution, weapon, enemies, onHitCallback);
    } else if (weapon.type === 'projectile') {
        spawnProjectile(origin, dir, evolution, weapon);
    }
}

function spawnTracer(origin, endPoint, color) {
    const tracer = tracers.find(t => t.timer <= 0);
    if (!tracer) return;

    const positions = tracer.line.geometry.attributes.position;
    positions.setXYZ(0, origin.x, origin.y, origin.z);
    positions.setXYZ(1, endPoint.x, endPoint.y, endPoint.z);
    positions.needsUpdate = true;

    tracer.line.material.color.setHex(color);
    tracer.line.material.opacity = 1.0;
    tracer.line.visible = true;
    tracer.timer = tracer.maxTime;
}

function updateTracers(dt) {
    tracers.forEach(tracer => {
        if (tracer.timer > 0) {
            tracer.timer -= dt;
            tracer.line.material.opacity = Math.max(0, tracer.timer / tracer.maxTime);
            if (tracer.timer <= 0) {
                tracer.line.visible = false;
            }
        }
    });
}

function performHitscan(origin, dir, evolution, weapon, enemies, onHitCallback) {
    const raycaster = new THREE.Raycaster(origin, dir, 0.1, 100);

    // Check against enemy meshes
    let hitEnemy = null;
    let hitPoint = null;
    let closestDist = Infinity;

    enemies.forEach(enemy => {
        if (!enemy.alive || !enemy.root.visible || enemy.animState === 'dying') return;

        // Use bounding sphere check against enemy body center (not root at y=0)
        const enemyPos = enemy.root.position.clone();
        enemyPos.y = 1.0; // Body center height for hit detection
        const toEnemy = enemyPos.clone().sub(origin);
        const projLength = toEnemy.dot(dir);

        if (projLength < 0 || projLength > 100) return;

        const closestPoint = origin.clone().add(dir.clone().multiplyScalar(projLength));
        const dist = closestPoint.distanceTo(enemyPos);

        // Use generous vertical hit zone: check horizontal dist + clamped vertical
        const hitHeight = enemy.type === 'boss' ? 3.0 : 1.8;
        const verticalDist = Math.abs(closestPoint.y - enemyPos.y);
        const horizontalDist = Math.sqrt(
            (closestPoint.x - enemyPos.x) ** 2 + (closestPoint.z - enemyPos.z) ** 2
        );

        if (horizontalDist < enemy.hitRadius && verticalDist < hitHeight && projLength < closestDist) {
            closestDist = projLength;
            hitEnemy = enemy;
            hitPoint = closestPoint;
        }
    });

    // Chain lightning visualization path (Tesla Blaster).
    // Collect the full polyline through all struck enemies, then render one jagged LineSegments.
    if (weapon.projectileType === 'chain') {
        const chainPoints = [origin.clone()];

        if (hitEnemy && hitPoint) {
            onHitCallback(hitEnemy, hitPoint, evolution.damage, weaponState.currentIndex);
            chainPoints.push(hitPoint.clone());

            if (weapon.chainTargets && weapon.chainTargets > 0) {
                let lastPos = hitPoint;
                let chainCount = 0;
                const hitSet = new Set([hitEnemy]);

                enemies.forEach(enemy => {
                    if (!enemy.alive || enemy.animState === 'dying' || hitSet.has(enemy) || chainCount >= weapon.chainTargets) return;
                    const enemyCenter = enemy.root.position.clone();
                    enemyCenter.y = 1.0;
                    const dist = enemyCenter.distanceTo(lastPos);
                    if (dist < weapon.chainRadius) {
                        onHitCallback(enemy, enemyCenter, evolution.damage * 0.6, weaponState.currentIndex);
                        chainPoints.push(enemyCenter.clone());
                        lastPos = enemyCenter;
                        hitSet.add(enemy);
                        chainCount++;
                    }
                });
            }
        } else {
            // Missed — draw bolt to max range so player sees feedback.
            chainPoints.push(origin.clone().add(dir.clone().multiplyScalar(25)));
        }

        spawnChainLightning(chainPoints, evolution.color);
        return;
    }

    // Fallback hitscan path (non-chain weapons, if any are ever re-introduced).
    if (hitEnemy && hitPoint) {
        onHitCallback(hitEnemy, hitPoint, evolution.damage, weaponState.currentIndex);
    }
    const tracerEnd = hitPoint || origin.clone().add(dir.clone().multiplyScalar(60));
    spawnTracer(origin, tracerEnd, evolution.color);
}

// Per-projectile-type physics + lifetime tuning. Pool geometry is shared;
// we only change runtime scale, color, speed, gravity, lifetime, and trail.
// Rocket: no gravity (flies flat) + long lifetime so it crosses the arena.
// Blob: continuous-flow cryo stream — short lifetime (mid-range) + steep gravity
// (arcing drip) + rare trail drips so the droplet pool doesn't blow up when
// ~16 blobs are in flight simultaneously.
const PROJECTILE_TYPE_CONFIG = {
    plasma: { lifetime: 1.2,  gravity: 0,   trail: 'plasma',  trailInterval: 0.035 },
    rocket: { lifetime: 30.0, gravity: 0,   trail: 'smoke',   trailInterval: 0.035 },
    liquid: { lifetime: 0.8,  gravity: 4.0, trail: null,      trailInterval: 0.035 },
    blob:   { lifetime: 0.9,  gravity: 5.0, trail: 'droplet', trailInterval: 0.18  },
    default:{ lifetime: 3.0,  gravity: 0,   trail: null,      trailInterval: 0.035 },
};

function spawnProjectile(origin, dir, evolution, weapon) {
    // Find inactive projectile from pool
    const proj = projectiles.find(p => !p.userData.active);
    if (!proj) return;

    const typeCfg = PROJECTILE_TYPE_CONFIG[weapon.projectileType] || PROJECTILE_TYPE_CONFIG.default;

    proj.userData.active = true;
    proj.userData.velocity.copy(dir).multiplyScalar(weapon.projectileSpeed);
    proj.userData.damage = evolution.damage;
    proj.userData.lifetime = typeCfg.lifetime;
    proj.userData.aoe = weapon.aoe || false;
    proj.userData.aoeRadius = weapon.aoeRadius || 0;
    proj.userData.weaponIndex = weaponState.currentIndex;
    proj.userData.projectileType = weapon.projectileType || 'default';
    proj.userData.gravity = typeCfg.gravity;
    proj.userData.trail = typeCfg.trail;
    proj.userData.trailInterval = typeCfg.trailInterval ?? 0.035;
    proj.userData.trailTimer = 0;
    proj.userData.color = evolution.color;

    proj.position.copy(origin).add(dir.clone().multiplyScalar(1));
    proj.visible = true;

    // Color the projectile
    proj.children[0].material.color.setHex(evolution.color);
    proj.children[0].material.emissive.setHex(evolution.color);
    proj.children[1].material.color.setHex(evolution.color);

    // Scale based on weapon
    const radius = weapon.projectileRadius || 0.15;
    const baseScale = radius / 0.15;
    proj.children[0].scale.setScalar(baseScale);
    proj.children[1].scale.setScalar(baseScale);
    // Remember baseScale so blob core-pulse can modulate around it.
    proj.children[0].userData.baseScale = baseScale;
    proj.children[1].userData.baseScale = baseScale;
}

function updateProjectiles(dt, enemies, onHitCallback) {
    projectiles.forEach(proj => {
        if (!proj.userData.active) return;

        proj.userData.lifetime -= dt;
        if (proj.userData.lifetime <= 0) {
            // Rockets detonate on timeout too — "infinite" in practice, but the safety
            // lifetime prevents runaway projectiles from consuming pool slots forever.
            if (proj.userData.projectileType === 'rocket') {
                detonateProjectile(proj, enemies, onHitCallback);
            }
            deactivateProjectile(proj);
            return;
        }

        // Apply gravity per-type (liquid arcs, rockets mildly dip, plasma is flat).
        if (proj.userData.gravity) {
            proj.userData.velocity.y -= proj.userData.gravity * dt;
        }

        // Move
        proj.position.add(proj.userData.velocity.clone().multiplyScalar(dt));

        // Per-type visual flourish during flight.
        const pType = proj.userData.projectileType;
        if (pType === 'liquid' || pType === 'blob') {
            // Wobble: non-uniform scale pulse on the outer glow makes it read as a blob.
            const wobble = 0.9 + Math.sin(proj.userData.lifetime * 30) * 0.15;
            proj.children[1].scale.set(wobble, 1 / wobble, wobble);
            // Big blob also pulses the inner core slightly so it looks alive.
            if (pType === 'blob') {
                const core = 1.0 + Math.sin(proj.userData.lifetime * 22) * 0.08;
                proj.children[0].scale.setScalar((proj.children[0].userData.baseScale || 2.0) * core);
            }
        } else if (pType === 'rocket') {
            // Subtle roll only — ball keeps cartoon feel.
            proj.rotation.z += dt * 2;
        } else {
            // Plasma / default: fast spin for energy feel.
            proj.rotation.x += dt * 8;
            proj.rotation.z += dt * 6;
        }

        // Trail emission (per-type interval so high-density streams don't flood pools).
        if (proj.userData.trail) {
            proj.userData.trailTimer += dt;
            if (proj.userData.trailTimer >= proj.userData.trailInterval) {
                proj.userData.trailTimer = 0;
                if (proj.userData.trail === 'plasma') {
                    spawnPlasmaTrail(proj.position, proj.userData.color);
                } else if (proj.userData.trail === 'smoke') {
                    spawnSmokeTrail(proj.position);
                } else if (proj.userData.trail === 'droplet') {
                    spawnDropletTrail(proj.position, proj.userData.color);
                }
            }
        }

        // Check collision with enemies (use body center y=1.0, not root y=0)
        const projRadius = 0.3;
        let hit = false;

        enemies.forEach(enemy => {
            if (!enemy.alive || !enemy.root.visible || enemy.animState === 'dying' || hit) return;
            const enemyCenter = enemy.root.position.clone();
            enemyCenter.y = 1.0; // Body center height
            const dist = proj.position.distanceTo(enemyCenter);
            if (dist < enemy.hitRadius + projRadius + 0.5) {
                onHitCallback(enemy, proj.position.clone(), proj.userData.damage, proj.userData.weaponIndex);
                hit = true;

                // AoE damage — secondary targets marked as splash to suppress redundant
                // popups/screen-shake and use radial knockback instead of forward.
                if (proj.userData.aoe) {
                    const splashCenter = proj.position.clone();
                    enemies.forEach(other => {
                        if (!other.alive || other === enemy) return;
                        const otherCenter = other.root.position.clone();
                        otherCenter.y = 1.0;
                        const aoeDist = proj.position.distanceTo(otherCenter);
                        if (aoeDist < proj.userData.aoeRadius) {
                            const falloff = 1 - (aoeDist / proj.userData.aoeRadius);
                            onHitCallback(
                                other,
                                other.root.position,
                                proj.userData.damage * falloff * 0.5,
                                proj.userData.weaponIndex,
                                { fromSplash: true, splashCenter }
                            );
                        }
                    });
                }
            }
        });

        // Check collision with walls — rockets detonate on wall impact (explosion + AoE).
        let wallHit = false;
        if (!hit) {
            ARENA.walls.forEach(wall => {
                if (wallHit) return;
                if (proj.position.x > wall.minX && proj.position.x < wall.maxX &&
                    proj.position.z > wall.minZ && proj.position.z < wall.maxZ &&
                    proj.position.y < wall.maxY) {
                    wallHit = true;
                }
            });
        }

        if (wallHit && proj.userData.projectileType === 'rocket') {
            detonateProjectile(proj, enemies, onHitCallback);
        }

        if (hit || wallHit) {
            deactivateProjectile(proj);
        }
    });
}

function deactivateProjectile(proj) {
    proj.userData.active = false;
    proj.visible = false;
}

// Trigger an explosion at the projectile's current position and apply AoE damage
// to nearby enemies. Used when a rocket hits a wall or runs out of lifetime without
// directly striking an enemy — the enemy-hit path already fires the splash effect
// via onWeaponHit/fx.splash, so this helper fills in the "no enemy hit" cases.
function detonateProjectile(proj, enemies, onHitCallback) {
    const weapon = WEAPON_DEFS[proj.userData.weaponIndex];
    const fx = weapon?.fx;
    if (fx?.splash !== 'explosion') return;

    const radius = fx.explosionRadius || proj.userData.aoeRadius || weapon.aoeRadius || 3.0;
    const color = proj.userData.color;
    spawnExplosion(proj.position.clone(), radius, color);

    // Apply AoE damage to every enemy inside the blast. Route through onWeaponHit as
    // a splash hit so knockback radiates outward and fx (burn DoT etc.) still applies.
    const splashCenter = proj.position.clone();
    const radiusSq = radius * radius;
    enemies.forEach(enemy => {
        if (!enemy.alive || !enemy.root.visible) return;
        const ec = enemy.root.position;
        const dx = ec.x - splashCenter.x;
        const dz = ec.z - splashCenter.z;
        const dy = (ec.y + 1.0) - splashCenter.y;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > radiusSq) return;
        const dist = Math.sqrt(distSq);
        const falloff = 1 - (dist / radius);
        onHitCallback(
            enemy,
            enemy.root.position.clone().setY(1),
            proj.userData.damage * falloff * 0.5,
            proj.userData.weaponIndex,
            { fromSplash: true, splashCenter }
        );
    });
}

// Update weapon evolution based on score
function updateEvolution(score) {
    WEAPON_DEFS.forEach((def, i) => {
        for (let lvl = def.evolutionLevels.length - 1; lvl >= 0; lvl--) {
            if (score >= def.evolutionLevels[lvl].scoreThreshold) {
                weaponState.activeEvolutionLevel[i] = lvl;
                break;
            }
        }
    });
}

function resetWeapons() {
    weaponState.currentIndex = 0;
    weaponState.fireTimer = 0;
    weaponState.isReloading = false;
    weaponState.activeEvolutionLevel = [0, 0, 0, 0];

    WEAPON_DEFS.forEach((def, i) => {
        weaponState.currentAmmo[i] = def.ammo;
        weaponState.reserveAmmo[i] = def.maxAmmo;
    });

    weaponState.meshes.forEach((m, i) => {
        m.visible = (i === 0);
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
    });

    // Deactivate all projectiles
    projectiles.forEach(deactivateProjectile);
}

export {
    WEAPON_DEFS, weaponState,
    initWeapons, updateWeapons, switchWeapon,
    getCurrentWeapon, getCurrentEvolution,
    updateEvolution, resetWeapons,
    projectiles,
};

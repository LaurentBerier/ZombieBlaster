// ============================================
// Visual Effects System
// Comic-book popups, particles, muzzle flash
// ============================================

import { scene, camera, COLORS, createToonMaterial } from './scene.js';

// Comic-book popup pool (POW, ZAP, SPLAT, BOOM)
const POPUP_TEXTS = ['POW!', 'ZAP!', 'SPLAT!', 'BOOM!', 'WHAM!', 'CRACK!'];
const POPUP_COLORS = [COLORS.yellow, COLORS.cyan, COLORS.hotPink, COLORS.magenta, COLORS.orange, COLORS.lime];
const popups = [];
const MAX_POPUPS = 20;

// Particle pool
const particles = [];
const MAX_PARTICLES = 100;

// Death splat pool
const deathSplats = [];
const MAX_SPLATS = 15;

// Damage number pool (canvas sprites floating upward from hit point)
const damageNumbers = [];
const MAX_DAMAGE_NUMBERS = 30;

// Screen-shake state (read by main render loop each frame)
const screenShake = {
    amplitude: 0,
    duration: 0,
    elapsed: 0,
    offset: new THREE.Vector3(),
};

// Explosion pool (expanding sphere flash + ember particles)
const explosions = [];
const MAX_EXPLOSIONS = 8;

// Smoke trail pool (rocket exhaust)
const smokePuffs = [];
const MAX_SMOKE = 60;

// Plasma trail pool (glow sprites along plasma bolt path)
const plasmaTrails = [];
const MAX_PLASMA_TRAILS = 40;

// Liquid splash pool (droplet particles that fall) — sized for blob-trail drip + soda stream + impact splashes concurrently.
const liquidSplashes = [];
const MAX_LIQUID_SPLASHES = 140;

// Acid pool on ground (decals that tick damage to enemies inside)
const acidPools = [];
const MAX_ACID_POOLS = 10;

// Chain lightning line segments pool
const chainLightnings = [];
const MAX_CHAIN_LIGHTNINGS = 6;

function initEffects() {
    // Create popup sprites using canvas textures
    for (let i = 0; i < MAX_POPUPS; i++) {
        const popup = createPopupSprite();
        popup.visible = false;
        scene.add(popup);
        popups.push({
            sprite: popup,
            active: false,
            lifetime: 0,
            velocity: new THREE.Vector3(),
        });
    }

    // Create particle pool
    for (let i = 0; i < MAX_PARTICLES; i++) {
        const particleGeo = new THREE.SphereGeometry(0.05, 4, 4);
        const particleMat = new THREE.MeshBasicMaterial({ color: COLORS.yellow });
        const particle = new THREE.Mesh(particleGeo, particleMat);
        particle.visible = false;
        scene.add(particle);
        particles.push({
            mesh: particle,
            active: false,
            lifetime: 0,
            velocity: new THREE.Vector3(),
            drag: 0.95,
        });
    }

    // Create death splat pool
    for (let i = 0; i < MAX_SPLATS; i++) {
        const splatGeo = new THREE.CircleGeometry(0.5, 8);
        const splatMat = createToonMaterial(COLORS.hotPink, COLORS.hotPink, 0.5);
        splatMat.transparent = true;
        splatMat.opacity = 0.8;
        const splat = new THREE.Mesh(splatGeo, splatMat);
        splat.rotation.x = -Math.PI / 2;
        splat.visible = false;
        scene.add(splat);
        deathSplats.push({
            mesh: splat,
            active: false,
            lifetime: 0,
        });
    }

    // --- Damage number pool ---
    for (let i = 0; i < MAX_DAMAGE_NUMBERS; i++) {
        const sprite = createDamageNumberSprite();
        sprite.visible = false;
        scene.add(sprite);
        damageNumbers.push({
            sprite,
            active: false,
            lifetime: 0,
            maxLifetime: 0.8,
            velocity: new THREE.Vector3(),
            isCritical: false,
        });
    }

    // --- Explosion pool ---
    for (let i = 0; i < MAX_EXPLOSIONS; i++) {
        const group = new THREE.Group();
        const flashGeo = new THREE.SphereGeometry(1, 12, 12);
        const flashMat = new THREE.MeshBasicMaterial({
            color: COLORS.orange, transparent: true, opacity: 1.0, depthWrite: false,
        });
        const flash = new THREE.Mesh(flashGeo, flashMat);
        group.add(flash);
        const ringGeo = new THREE.RingGeometry(0.9, 1.0, 24);
        const ringMat = new THREE.MeshBasicMaterial({
            color: COLORS.yellow, transparent: true, opacity: 1.0, side: THREE.DoubleSide, depthWrite: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        group.add(ring);
        group.visible = false;
        scene.add(group);
        explosions.push({
            group, flash, ring,
            active: false,
            lifetime: 0,
            maxLifetime: 0.45,
            targetRadius: 1.0,
        });
    }

    // --- Smoke puff pool ---
    for (let i = 0; i < MAX_SMOKE; i++) {
        const smokeGeo = new THREE.SphereGeometry(0.18, 6, 6);
        const smokeMat = new THREE.MeshBasicMaterial({
            color: 0x666666, transparent: true, opacity: 0.7, depthWrite: false,
        });
        const smoke = new THREE.Mesh(smokeGeo, smokeMat);
        smoke.visible = false;
        scene.add(smoke);
        smokePuffs.push({
            mesh: smoke,
            active: false,
            lifetime: 0,
            maxLifetime: 0.8,
            velocity: new THREE.Vector3(),
        });
    }

    // --- Plasma trail pool ---
    for (let i = 0; i < MAX_PLASMA_TRAILS; i++) {
        const trailGeo = new THREE.SphereGeometry(0.22, 6, 6);
        const trailMat = new THREE.MeshBasicMaterial({
            color: COLORS.magenta, transparent: true, opacity: 0.6, depthWrite: false,
        });
        const trail = new THREE.Mesh(trailGeo, trailMat);
        trail.visible = false;
        scene.add(trail);
        plasmaTrails.push({
            mesh: trail,
            active: false,
            lifetime: 0,
            maxLifetime: 0.25,
        });
    }

    // --- Liquid splash pool ---
    for (let i = 0; i < MAX_LIQUID_SPLASHES; i++) {
        const dropGeo = new THREE.SphereGeometry(0.1, 5, 5);
        const dropMat = new THREE.MeshBasicMaterial({
            color: COLORS.lime, transparent: true, opacity: 0.9, depthWrite: false,
        });
        const drop = new THREE.Mesh(dropGeo, dropMat);
        drop.visible = false;
        scene.add(drop);
        liquidSplashes.push({
            mesh: drop,
            active: false,
            lifetime: 0,
            maxLifetime: 0.5,
            velocity: new THREE.Vector3(),
        });
    }

    // --- Acid pool (ground decal + pulsing glow) ---
    for (let i = 0; i < MAX_ACID_POOLS; i++) {
        const poolGeo = new THREE.CircleGeometry(1, 16);
        const poolMat = new THREE.MeshBasicMaterial({
            color: COLORS.lime, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
        });
        const poolMesh = new THREE.Mesh(poolGeo, poolMat);
        poolMesh.rotation.x = -Math.PI / 2;
        poolMesh.visible = false;
        scene.add(poolMesh);
        acidPools.push({
            mesh: poolMesh,
            active: false,
            lifetime: 0,
            maxLifetime: 2.0,
            radius: 1.0,
            dps: 5,
            tickTimer: 0,
            position: new THREE.Vector3(),
        });
    }

    // --- Chain lightning pool (jagged LineSegments) ---
    for (let i = 0; i < MAX_CHAIN_LIGHTNINGS; i++) {
        // Pre-allocate vertex buffer large enough for a 6-node chain with branches.
        // Each segment = 2 verts * 3 floats. Budget ~64 segments = 128 verts = 384 floats.
        const positions = new Float32Array(384);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setDrawRange(0, 0);
        const mat = new THREE.LineBasicMaterial({
            color: COLORS.cyan, transparent: true, opacity: 1.0, linewidth: 2,
        });
        const lines = new THREE.LineSegments(geo, mat);
        lines.visible = false;
        lines.frustumCulled = false;
        scene.add(lines);
        chainLightnings.push({
            lines, positions,
            active: false,
            lifetime: 0,
            maxLifetime: 0.14,
        });
    }
}

function createDamageNumberSprite() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
        map: texture, transparent: true, depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.2, 0.6, 1);
    sprite.userData = { canvas, ctx, texture };
    return sprite;
}

function drawDamageNumber(sprite, damage, isCritical) {
    const { canvas, ctx, texture } = sprite.userData;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const text = Math.round(damage).toString();
    const fontSize = isCritical ? 42 : 30;
    ctx.font = `900 ${fontSize}px "Bangers", "Arial Black", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#000';
    ctx.strokeText(text, 64, 32);
    ctx.fillStyle = isCritical ? '#FFEE44' : '#FFFFFF';
    ctx.fillText(text, 64, 32);
    texture.needsUpdate = true;
}

function createPopupSprite() {
    // Create a canvas-based sprite for comic text
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    // We'll update the text dynamically
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(2, 1, 1);
    sprite.userData = { canvas, ctx, texture };

    return sprite;
}

function updatePopupTexture(sprite, text, color) {
    const { canvas, ctx, texture } = sprite.userData;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Comic-book starburst background
    ctx.save();
    ctx.translate(128, 64);

    // Starburst
    const points = 12;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const angle = (i * Math.PI) / points;
        const radius = i % 2 === 0 ? 60 : 40;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius * 0.7;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Color string from hex
    const colorStr = '#' + color.toString(16).padStart(6, '0');

    ctx.fillStyle = colorStr;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Text
    ctx.font = 'bold 36px "Bangers", "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = '#FFF';
    ctx.fillText(text, 0, 0);

    ctx.restore();

    texture.needsUpdate = true;
}

// Spawn a comic popup at world position
function spawnPopup(position, isCritical = false) {
    const popup = popups.find(p => !p.active);
    if (!popup) return;

    popup.active = true;
    popup.lifetime = 0.8;

    const textIdx = isCritical ? 0 : Math.floor(Math.random() * POPUP_TEXTS.length);
    const colorIdx = textIdx % POPUP_COLORS.length;

    updatePopupTexture(popup.sprite, POPUP_TEXTS[textIdx], POPUP_COLORS[colorIdx]);

    popup.sprite.position.copy(position);
    popup.sprite.position.y += 1 + Math.random() * 0.5;
    popup.sprite.visible = true;
    popup.sprite.scale.set(0.1, 0.05, 1);

    popup.velocity.set(
        (Math.random() - 0.5) * 2,
        3 + Math.random() * 2,
        (Math.random() - 0.5) * 2
    );
}

// Spawn impact particles
function spawnHitParticles(position, color, count = 8) {
    for (let i = 0; i < count; i++) {
        const p = particles.find(p => !p.active);
        if (!p) break;

        p.active = true;
        p.lifetime = 0.3 + Math.random() * 0.3;
        p.mesh.material.color.setHex(color);
        p.mesh.position.copy(position);
        p.mesh.visible = true;
        p.mesh.scale.setScalar(0.5 + Math.random() * 1.0);

        p.velocity.set(
            (Math.random() - 0.5) * 8,
            Math.random() * 5,
            (Math.random() - 0.5) * 8
        );
    }
}

// Spawn death splat on floor
function spawnDeathSplat(position) {
    const splat = deathSplats.find(s => !s.active);
    if (!splat) {
        // Recycle oldest
        const oldest = deathSplats.reduce((a, b) => a.lifetime < b.lifetime ? a : b);
        oldest.active = false;
    }

    const target = deathSplats.find(s => !s.active);
    if (!target) return;

    target.active = true;
    target.lifetime = 5.0; // Stays on ground for a while
    target.mesh.position.set(position.x, 0.03, position.z);
    target.mesh.visible = true;
    target.mesh.material.opacity = 0.8;

    const scale = 0.5 + Math.random() * 1.0;
    target.mesh.scale.set(scale, scale, scale);
    target.mesh.rotation.z = Math.random() * Math.PI * 2;

    // Random splat color (pink/magenta)
    const colors = [COLORS.hotPink, COLORS.magenta, 0xff3366];
    target.mesh.material.color.setHex(colors[Math.floor(Math.random() * colors.length)]);
}

// --- Damage number ---
function spawnDamageNumber(position, damage, isCritical = false) {
    const entry = damageNumbers.find(d => !d.active);
    if (!entry) return;
    entry.active = true;
    entry.lifetime = 0.8;
    entry.maxLifetime = 0.8;
    entry.isCritical = isCritical;
    drawDamageNumber(entry.sprite, damage, isCritical);
    entry.sprite.position.copy(position);
    entry.sprite.position.y += 1.5 + Math.random() * 0.4;
    entry.sprite.position.x += (Math.random() - 0.5) * 0.4;
    entry.sprite.scale.set(isCritical ? 1.6 : 1.1, isCritical ? 0.8 : 0.55, 1);
    entry.sprite.material.opacity = 1.0;
    entry.sprite.visible = true;
    entry.velocity.set((Math.random() - 0.5) * 0.8, 2.2 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8);
}

// --- Screen shake ---
function triggerScreenShake(amplitude, duration) {
    // Only upgrade if incoming effect is stronger than what's currently active.
    if (amplitude > screenShake.amplitude || duration > screenShake.duration) {
        screenShake.amplitude = Math.max(screenShake.amplitude, amplitude);
        screenShake.duration = Math.max(screenShake.duration, duration);
        screenShake.elapsed = 0;
    }
}

function updateScreenShake(dt) {
    if (screenShake.duration <= 0) {
        screenShake.offset.set(0, 0, 0);
        return;
    }
    screenShake.elapsed += dt;
    screenShake.duration -= dt;
    const remaining = Math.max(0, screenShake.duration);
    const falloff = remaining / (remaining + screenShake.elapsed + 0.0001);
    const amp = screenShake.amplitude * falloff;
    screenShake.offset.set(
        (Math.random() - 0.5) * amp,
        (Math.random() - 0.5) * amp * 0.6,
        (Math.random() - 0.5) * amp
    );
    if (screenShake.duration <= 0) {
        screenShake.amplitude = 0;
        screenShake.elapsed = 0;
        screenShake.offset.set(0, 0, 0);
    }
}

function getScreenShakeOffset() {
    return screenShake.offset;
}

// --- Explosion ---
function spawnExplosion(position, radius, color = COLORS.orange) {
    const entry = explosions.find(e => !e.active);
    if (!entry) return;
    entry.active = true;
    entry.lifetime = entry.maxLifetime;
    entry.targetRadius = radius;
    entry.group.position.copy(position);
    entry.group.visible = true;
    entry.flash.material.color.setHex(color);
    entry.flash.material.opacity = 1.0;
    entry.flash.scale.setScalar(0.1);
    entry.ring.material.opacity = 1.0;
    entry.ring.scale.setScalar(0.1);
    // Ember burst via existing particle pool.
    for (let i = 0; i < 18; i++) {
        const p = particles.find(p => !p.active);
        if (!p) break;
        p.active = true;
        p.lifetime = 0.4 + Math.random() * 0.4;
        p.mesh.material.color.setHex(i % 3 === 0 ? COLORS.yellow : color);
        p.mesh.position.copy(position);
        p.mesh.visible = true;
        p.mesh.scale.setScalar(0.8 + Math.random() * 1.2);
        const speed = 6 + Math.random() * 6;
        const angle = Math.random() * Math.PI * 2;
        const vertical = 2 + Math.random() * 3;
        p.velocity.set(Math.cos(angle) * speed, vertical, Math.sin(angle) * speed);
    }
}

// --- Smoke trail (single puff; call each frame while emitting) ---
function spawnSmokeTrail(position) {
    const entry = smokePuffs.find(s => !s.active);
    if (!entry) return;
    entry.active = true;
    entry.lifetime = entry.maxLifetime;
    entry.mesh.position.copy(position);
    entry.mesh.position.x += (Math.random() - 0.5) * 0.1;
    entry.mesh.position.z += (Math.random() - 0.5) * 0.1;
    entry.mesh.material.opacity = 0.7;
    entry.mesh.scale.setScalar(0.5 + Math.random() * 0.3);
    entry.mesh.visible = true;
    entry.velocity.set(
        (Math.random() - 0.5) * 0.5,
        0.6 + Math.random() * 0.4,
        (Math.random() - 0.5) * 0.5
    );
}

// --- Plasma trail (single glow orb along projectile path) ---
function spawnPlasmaTrail(position, color) {
    const entry = plasmaTrails.find(t => !t.active);
    if (!entry) return;
    entry.active = true;
    entry.lifetime = entry.maxLifetime;
    entry.mesh.position.copy(position);
    entry.mesh.material.color.setHex(color);
    entry.mesh.material.opacity = 0.6;
    entry.mesh.scale.setScalar(0.9);
    entry.mesh.visible = true;
}

// --- Liquid splash (droplets fly outward + fall) ---
function spawnLiquidSplash(position, color, count = 8) {
    for (let i = 0; i < count; i++) {
        const entry = liquidSplashes.find(s => !s.active);
        if (!entry) break;
        entry.active = true;
        entry.lifetime = 0.35 + Math.random() * 0.25;
        entry.maxLifetime = entry.lifetime;
        entry.mesh.position.copy(position);
        entry.mesh.material.color.setHex(color);
        entry.mesh.material.opacity = 0.95;
        entry.mesh.scale.setScalar(0.6 + Math.random() * 0.6);
        entry.mesh.visible = true;
        const angle = Math.random() * Math.PI * 2;
        const speed = 2.5 + Math.random() * 2.5;
        entry.velocity.set(
            Math.cos(angle) * speed,
            1.5 + Math.random() * 1.5,
            Math.sin(angle) * speed
        );
    }
}

// --- Droplet trail (1-2 small droplets per frame, dripping from a blob projectile) ---
function spawnDropletTrail(position, color) {
    const count = 1 + (Math.random() < 0.35 ? 1 : 0);
    for (let i = 0; i < count; i++) {
        const entry = liquidSplashes.find(s => !s.active);
        if (!entry) return;
        entry.active = true;
        entry.lifetime = 0.45 + Math.random() * 0.2;
        entry.maxLifetime = entry.lifetime;
        entry.mesh.position.copy(position);
        entry.mesh.position.x += (Math.random() - 0.5) * 0.15;
        entry.mesh.position.y += (Math.random() - 0.5) * 0.1;
        entry.mesh.position.z += (Math.random() - 0.5) * 0.15;
        entry.mesh.material.color.setHex(color);
        entry.mesh.material.opacity = 0.9;
        entry.mesh.scale.setScalar(0.35 + Math.random() * 0.3);
        entry.mesh.visible = true;
        // Slow drift + gentle gravity — these feel like drips, not a burst.
        entry.velocity.set(
            (Math.random() - 0.5) * 0.8,
            -0.2 - Math.random() * 0.3,
            (Math.random() - 0.5) * 0.8
        );
    }
}

// --- Acid pool (ground decal that ticks damage to enemies inside it) ---
function spawnAcidPool(position, radius = 1.2, duration = 2.0, color = COLORS.lime, dps = 5) {
    const entry = acidPools.find(p => !p.active)
        ?? acidPools.reduce((a, b) => a.lifetime < b.lifetime ? a : b);
    entry.active = true;
    entry.lifetime = duration;
    entry.maxLifetime = duration;
    entry.radius = radius;
    entry.dps = dps;
    entry.tickTimer = 0;
    entry.position.set(position.x, 0.04, position.z);
    entry.mesh.position.copy(entry.position);
    entry.mesh.material.color.setHex(color);
    entry.mesh.material.opacity = 0.55;
    entry.mesh.scale.setScalar(radius);
    entry.mesh.visible = true;
    return entry;
}

function getActiveAcidPools() {
    return acidPools.filter(p => p.active);
}

// --- Chain lightning (jagged LineSegments through a sequence of points) ---
function spawnChainLightning(points, color = COLORS.cyan) {
    if (!points || points.length < 2) return;
    const entry = chainLightnings.find(c => !c.active);
    if (!entry) return;

    const positions = entry.positions;
    let idx = 0;

    // Build jagged segments between each consecutive pair.
    const segmentsPerLink = 6;
    const jitter = 0.35;
    const tmp = new THREE.Vector3();
    const perp1 = new THREE.Vector3();
    const perp2 = new THREE.Vector3();

    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        tmp.copy(b).sub(a);
        const len = tmp.length();
        if (len < 0.01) continue;
        tmp.normalize();
        // Two perpendicular axes for lateral jitter.
        if (Math.abs(tmp.y) < 0.9) perp1.set(-tmp.z, 0, tmp.x).normalize();
        else perp1.set(1, 0, 0);
        perp2.crossVectors(tmp, perp1).normalize();

        let prev = a;
        for (let s = 1; s <= segmentsPerLink; s++) {
            const t = s / segmentsPerLink;
            const midX = a.x + (b.x - a.x) * t;
            const midY = a.y + (b.y - a.y) * t;
            const midZ = a.z + (b.z - a.z) * t;
            const off1 = (Math.random() - 0.5) * jitter;
            const off2 = (Math.random() - 0.5) * jitter;
            const nx = midX + perp1.x * off1 + perp2.x * off2;
            const ny = midY + perp1.y * off1 + perp2.y * off2;
            const nz = midZ + perp1.z * off1 + perp2.z * off2;
            const next = s === segmentsPerLink ? b : { x: nx, y: ny, z: nz };
            if (idx + 6 <= positions.length) {
                positions[idx++] = prev.x; positions[idx++] = prev.y; positions[idx++] = prev.z;
                positions[idx++] = next.x; positions[idx++] = next.y; positions[idx++] = next.z;
            }
            prev = next;

            // Occasional dead-end branch fork.
            if (s < segmentsPerLink && Math.random() < 0.25 && idx + 6 <= positions.length) {
                const forkLen = 0.6 + Math.random() * 0.4;
                const fx = prev.x + perp1.x * forkLen * (Math.random() - 0.5) * 2;
                const fy = prev.y + perp2.y * forkLen * (Math.random() - 0.5) * 2;
                const fz = prev.z + perp1.z * forkLen * (Math.random() - 0.5) * 2;
                positions[idx++] = prev.x; positions[idx++] = prev.y; positions[idx++] = prev.z;
                positions[idx++] = fx; positions[idx++] = fy; positions[idx++] = fz;
            }
        }
    }

    entry.active = true;
    entry.lifetime = entry.maxLifetime;
    entry.lines.geometry.attributes.position.needsUpdate = true;
    entry.lines.geometry.setDrawRange(0, idx / 3);
    entry.lines.material.color.setHex(color);
    entry.lines.material.opacity = 1.0;
    entry.lines.visible = true;
}

function updateEffects(dt) {
    // Update popups
    popups.forEach(popup => {
        if (!popup.active) return;

        popup.lifetime -= dt;
        if (popup.lifetime <= 0) {
            popup.active = false;
            popup.sprite.visible = false;
            return;
        }

        // Scale in then out
        const lifeRatio = popup.lifetime / 0.8;
        if (lifeRatio > 0.7) {
            // Scale in
            const t = (1 - lifeRatio) / 0.3;
            popup.sprite.scale.set(2 * t, 1 * t, 1);
        } else {
            // Fade out
            popup.sprite.material.opacity = lifeRatio / 0.7;
        }

        // Float up
        popup.sprite.position.add(popup.velocity.clone().multiplyScalar(dt));
        popup.velocity.y -= 5 * dt; // Gravity on popup
        popup.velocity.multiplyScalar(0.95);
    });

    // Update particles
    particles.forEach(p => {
        if (!p.active) return;

        p.lifetime -= dt;
        if (p.lifetime <= 0) {
            p.active = false;
            p.mesh.visible = false;
            return;
        }

        p.mesh.position.add(p.velocity.clone().multiplyScalar(dt));
        p.velocity.y -= 10 * dt;
        p.velocity.multiplyScalar(p.drag);

        // Shrink
        const scale = (p.lifetime / 0.6) * p.mesh.scale.x;
        p.mesh.scale.setScalar(Math.max(0.1, scale));
    });

    // Update death splats (fade over time)
    deathSplats.forEach(splat => {
        if (!splat.active) return;

        splat.lifetime -= dt;
        if (splat.lifetime <= 0) {
            splat.active = false;
            splat.mesh.visible = false;
            return;
        }

        // Start fading in last 2 seconds
        if (splat.lifetime < 2) {
            splat.mesh.material.opacity = (splat.lifetime / 2) * 0.8;
        }
    });

    // Damage numbers (float up with gravity; fade)
    damageNumbers.forEach(dn => {
        if (!dn.active) return;
        dn.lifetime -= dt;
        if (dn.lifetime <= 0) {
            dn.active = false;
            dn.sprite.visible = false;
            return;
        }
        dn.sprite.position.add(dn.velocity.clone().multiplyScalar(dt));
        dn.velocity.y -= 4 * dt;
        dn.velocity.multiplyScalar(0.92);
        const lifeRatio = dn.lifetime / dn.maxLifetime;
        dn.sprite.material.opacity = Math.min(1.0, lifeRatio * 2);
    });

    // Explosions (expand + fade)
    explosions.forEach(ex => {
        if (!ex.active) return;
        ex.lifetime -= dt;
        if (ex.lifetime <= 0) {
            ex.active = false;
            ex.group.visible = false;
            return;
        }
        const t = 1 - ex.lifetime / ex.maxLifetime;
        const scale = ex.targetRadius * (0.1 + t * 1.1);
        ex.flash.scale.setScalar(scale);
        ex.flash.material.opacity = (1 - t) * 0.9;
        ex.ring.scale.setScalar(scale * 1.3);
        ex.ring.material.opacity = (1 - t) * 0.8;
    });

    // Smoke puffs (rise + fade)
    smokePuffs.forEach(s => {
        if (!s.active) return;
        s.lifetime -= dt;
        if (s.lifetime <= 0) {
            s.active = false;
            s.mesh.visible = false;
            return;
        }
        s.mesh.position.add(s.velocity.clone().multiplyScalar(dt));
        s.velocity.multiplyScalar(0.96);
        const t = s.lifetime / s.maxLifetime;
        s.mesh.material.opacity = t * 0.7;
        s.mesh.scale.setScalar((1.5 - t) * 0.6);
    });

    // Plasma trails (fade + shrink)
    plasmaTrails.forEach(p => {
        if (!p.active) return;
        p.lifetime -= dt;
        if (p.lifetime <= 0) {
            p.active = false;
            p.mesh.visible = false;
            return;
        }
        const t = p.lifetime / p.maxLifetime;
        p.mesh.material.opacity = t * 0.6;
        p.mesh.scale.setScalar(0.3 + t * 0.7);
    });

    // Liquid splash droplets (arc, gravity, fade on ground)
    liquidSplashes.forEach(d => {
        if (!d.active) return;
        d.lifetime -= dt;
        if (d.lifetime <= 0 || d.mesh.position.y < 0.05) {
            d.active = false;
            d.mesh.visible = false;
            return;
        }
        d.mesh.position.add(d.velocity.clone().multiplyScalar(dt));
        d.velocity.y -= 14 * dt;
        const t = d.lifetime / d.maxLifetime;
        d.mesh.material.opacity = Math.min(0.95, t * 1.5);
    });

    // Acid pools (pulse + fade; tick damage handled elsewhere by querying getActiveAcidPools)
    acidPools.forEach(pool => {
        if (!pool.active) return;
        pool.lifetime -= dt;
        if (pool.lifetime <= 0) {
            pool.active = false;
            pool.mesh.visible = false;
            return;
        }
        const t = pool.lifetime / pool.maxLifetime;
        const pulse = 0.45 + 0.15 * Math.sin(performance.now() * 0.01);
        pool.mesh.material.opacity = Math.min(pulse, t * pulse * 1.5);
        pool.tickTimer += dt;
    });

    // Chain lightning (short-lived line segments)
    chainLightnings.forEach(c => {
        if (!c.active) return;
        c.lifetime -= dt;
        if (c.lifetime <= 0) {
            c.active = false;
            c.lines.visible = false;
            return;
        }
        const t = c.lifetime / c.maxLifetime;
        c.lines.material.opacity = t;
    });
}

// Show hit marker in HUD
function showHitMarker() {
    const marker = document.getElementById('hit-marker');
    if (marker) {
        marker.classList.remove('hidden');
        clearTimeout(marker._timeout);
        marker._timeout = setTimeout(() => marker.classList.add('hidden'), 200);
    }
}

function resetEffects() {
    popups.forEach(p => { p.active = false; p.sprite.visible = false; });
    particles.forEach(p => { p.active = false; p.mesh.visible = false; });
    deathSplats.forEach(s => { s.active = false; s.mesh.visible = false; });
    damageNumbers.forEach(d => { d.active = false; d.sprite.visible = false; });
    explosions.forEach(e => { e.active = false; e.group.visible = false; });
    smokePuffs.forEach(s => { s.active = false; s.mesh.visible = false; });
    plasmaTrails.forEach(p => { p.active = false; p.mesh.visible = false; });
    liquidSplashes.forEach(d => { d.active = false; d.mesh.visible = false; });
    acidPools.forEach(p => { p.active = false; p.mesh.visible = false; });
    chainLightnings.forEach(c => { c.active = false; c.lines.visible = false; });
    screenShake.amplitude = 0;
    screenShake.duration = 0;
    screenShake.elapsed = 0;
    screenShake.offset.set(0, 0, 0);
}

export {
    initEffects, updateEffects,
    spawnPopup, spawnHitParticles, spawnDeathSplat,
    spawnDamageNumber, spawnExplosion, spawnSmokeTrail,
    spawnPlasmaTrail, spawnLiquidSplash, spawnDropletTrail,
    spawnAcidPool, getActiveAcidPools,
    spawnChainLightning,
    triggerScreenShake, updateScreenShake, getScreenShakeOffset,
    showHitMarker, resetEffects,
};

// ============================================
// Multi-Room Underground Arena Geometry
// The Silo of Silly Science
// ============================================

import { scene, COLORS, NEON_PALETTE, createToonMaterial, addOutline } from './scene.js';
import { cloneAsset } from './assetLoader.js';

// Prefix applied to every custom-prop GLB so its cache key matches the URL
// used at asset-preload time (see collectCustomPropAssets below).
const CUSTOM_PROP_URL_PREFIX = 'assets/CorridorKit/';

let customPropDefs = [];
let customEnemySpawns = [];

// Arena layout: interconnected chambers
// Main hall (center), Lab West, Lab East, Corridor North, Vault South
const ARENA = {
    rooms: [],
    walls: [],    // Collision walls (AABB)
    floors: [],   // Floor planes
    spawnPoints: [],
    navPoints: [], // Points enemies can navigate between
};

// Level data — populated from data/levelData.json, with hardcoded fallbacks
let ROOM_DEFS = [
    { name: 'main_hall', cx: 0, cz: 0, w: 30, h: 8, d: 30 },
    { name: 'lab_west', cx: -30, cz: 0, w: 20, h: 7, d: 20 },
    { name: 'lab_east', cx: 30, cz: 0, w: 20, h: 7, d: 20 },
    { name: 'corridor_north', cx: 0, cz: -25, w: 12, h: 6, d: 20 },
    { name: 'vault_south', cx: 0, cz: 28, w: 24, h: 9, d: 16 },
];

let CORRIDORS = [
    { from: 'main_hall', to: 'lab_west', axis: 'x', pos: -15, w: 6, h: 6, d: 10 },
    { from: 'main_hall', to: 'lab_east', axis: 'x', pos: 15, w: 6, h: 6, d: 10 },
    { from: 'main_hall', to: 'corridor_north', axis: 'z', pos: -15, w: 8, h: 6, d: 10 },
    { from: 'main_hall', to: 'vault_south', axis: 'z', pos: 13, w: 10, h: 7, d: 10 },
];

let vatPositions = [
    { x: -8, z: -8 }, { x: 8, z: -8 }, { x: -8, z: 8 }, { x: 8, z: 8 },
    { x: -28, z: -5 }, { x: -28, z: 5 }, { x: 28, z: -5 }, { x: 28, z: 5 },
    { x: -5, z: 30 }, { x: 5, z: 30 },
];

let pumpPositions = [
    { x: -12, z: 0, ry: 0 }, { x: 12, z: 0, ry: Math.PI },
    { x: -35, z: -8, ry: Math.PI / 2 }, { x: 35, z: 8, ry: -Math.PI / 2 },
    { x: 0, z: -30, ry: 0 }, { x: -8, z: 34, ry: Math.PI },
];

let platDefs = [
    { x: -10, y: 2.5, z: -10, w: 5, d: 5 },
    { x: 10, y: 2.5, z: -10, w: 5, d: 5 },
    { x: -10, y: 2.5, z: 10, w: 5, d: 5 },
    { x: 10, y: 2.5, z: 10, w: 5, d: 5 },
    { x: 0, y: 3.5, z: 0, w: 4, d: 4 },
];

let lightDefs = [
    { x: -12, y: 4, z: -12, color: COLORS.magenta, intensity: 1.5, dist: 18 },
    { x: 12, y: 4, z: -12, color: COLORS.cyan, intensity: 1.5, dist: 18 },
    { x: -12, y: 4, z: 12, color: COLORS.lime, intensity: 1.5, dist: 18 },
    { x: 12, y: 4, z: 12, color: COLORS.orange, intensity: 1.5, dist: 18 },
    { x: 0, y: 6, z: 0, color: COLORS.violet, intensity: 2.0, dist: 25 },
    { x: -30, y: 4, z: 0, color: COLORS.cyan, intensity: 1.5, dist: 15 },
    { x: 30, y: 4, z: 0, color: COLORS.hotPink, intensity: 1.5, dist: 15 },
    { x: 0, y: 3, z: -25, color: COLORS.violet, intensity: 1.2, dist: 12 },
    { x: 0, y: 5, z: 28, color: COLORS.magenta, intensity: 2.0, dist: 16 },
];

// Load level data from external JSON; returns full data (including traps) or null on failure.
// Applies the data to the arena module's internal defs (rooms, corridors, lights...).
// Exported so main.js can fetch it before preloading assets, letting the asset loader
// include designer-imported custom-prop GLBs in its up-front preload pass.
async function loadLevelData() {
    try {
        const response = await fetch('data/levelData.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        ROOM_DEFS = data.rooms.map(r => ({ name: r.id, cx: r.cx, cz: r.cz, w: r.w, h: r.h, d: r.d }));
        CORRIDORS = data.corridors.map(c => ({ from: c.from, to: c.to, axis: c.axis, pos: c.pos, w: c.w, h: c.h, d: c.d }));
        vatPositions = data.props.vats.map(v => ({ x: v.x, z: v.z, rx: v.rx, ry: v.ry, rz: v.rz, scale: v.scale }));
        pumpPositions = data.props.pumps.map(p => ({ x: p.x, z: p.z, rx: p.rx, ry: p.ry, rz: p.rz, scale: p.scale }));
        customPropDefs = Array.isArray(data.customProps) ? data.customProps.slice() : [];
        customEnemySpawns = Array.isArray(data.enemySpawns) ? data.enemySpawns.slice() : [];
        platDefs = data.platforms.map(p => ({ x: p.x, y: p.y, z: p.z, w: p.w, d: p.d }));
        lightDefs = data.lights.map(l => ({
            x: l.x, y: l.y, z: l.z,
            color: Number(l.color),
            intensity: l.intensity,
            dist: l.distance,
        }));

        console.log('Level data loaded from data/levelData.json');
        return data;
    } catch (e) {
        console.warn('Could not load levelData.json, using hardcoded fallback:', e);
        return null;
    }
}

// Build the extras-descriptor list the asset loader needs to preload every
// designer-imported custom-prop GLB referenced by the level data. De-dupes by
// URL (level files frequently reuse the same floor/wall GLB many times).
function collectCustomPropAssets(levelData) {
    const props = Array.isArray(levelData?.customProps) ? levelData.customProps : [];
    const seen = new Set();
    const extras = [];
    for (const def of props) {
        if (!def || !def.asset) continue;
        const url = CUSTOM_PROP_URL_PREFIX + def.asset;
        if (seen.has(url)) continue;
        seen.add(url);
        extras.push({ id: url, url, type: 'gltf' });
    }
    return extras;
}

async function buildArena(preloadedLevelData) {
    // Level data is normally fetched by main.js so the asset loader can
    // include the level's custom-prop URLs in its preload. Fall back to
    // re-fetching here only when called standalone (no arg at all) —
    // an explicit null means main.js tried and failed, and the hardcoded
    // defaults should be used directly without re-fetching.
    const levelData = preloadedLevelData !== undefined
        ? preloadedLevelData
        : await loadLevelData();
    const arenaGroup = new THREE.Group();
    arenaGroup.name = 'arena';

    // Build each room
    ROOM_DEFS.forEach(room => {
        buildRoom(arenaGroup, room);
    });

    // Build corridors
    CORRIDORS.forEach(corr => {
        buildCorridor(arenaGroup, corr);
    });

    // Add environmental props (vats, machinery, pipes)
    addEnvironmentalProps(arenaGroup);

    // Add neon lighting throughout
    addNeonLighting(arenaGroup);

    // Add platforms in main hall
    addPlatforms(arenaGroup);

    // If the level defines explicit enemy spawn points, replace the auto-generated
    // perimeter spawns so wave spawner uses the designer's placements.
    if (customEnemySpawns.length > 0) {
        ARENA.spawnPoints = customEnemySpawns.map(s => ({ x: s.x, z: s.z, type: s.type || 'zombie', id: s.id }));
    }

    scene.add(arenaGroup);
    return levelData;
}

function buildRoom(parent, def) {
    const { cx, cz, w, h, d, name } = def;
    const room = new THREE.Group();
    room.name = name;

    // Floor
    const floorGeo = new THREE.PlaneGeometry(w, d);
    const floorMat = createToonMaterial(0x1a1a2e);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    floor.receiveShadow = true;
    room.add(floor);

    // Floor grid lines for comic style
    const gridHelper = new THREE.GridHelper(Math.max(w, d), Math.floor(Math.max(w, d) / 2), 0x2a2a4e, 0x1a1a3e);
    gridHelper.position.set(cx, 0.01, cz);
    room.add(gridHelper);

    // Ceiling
    const ceilGeo = new THREE.PlaneGeometry(w, d);
    const ceilMat = createToonMaterial(0x0d0d1a);
    const ceil = new THREE.Mesh(ceilGeo, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, h, cz);
    room.add(ceil);

    // Walls - build 4 walls with openings for corridors
    const wallThickness = 0.5;
    const wallColor = 0x1e1e3a;
    const accentColor = NEON_PALETTE[Math.floor(Math.random() * NEON_PALETTE.length)];

    // Wall segments (N, S, E, W)
    const wallDefs = [
        { px: cx, pz: cz - d / 2, sx: w, sy: h, roty: 0, normal: 'z', dir: -1 },     // North wall
        { px: cx, pz: cz + d / 2, sx: w, sy: h, roty: Math.PI, normal: 'z', dir: 1 }, // South wall
        { px: cx + w / 2, pz: cz, sx: d, sy: h, roty: -Math.PI / 2, normal: 'x', dir: 1 },  // East wall
        { px: cx - w / 2, pz: cz, sx: d, sy: h, roty: Math.PI / 2, normal: 'x', dir: -1 },  // West wall
    ];

    wallDefs.forEach(wd => {
        const wallGeo = new THREE.BoxGeometry(wd.sx, wd.sy, wallThickness);
        const wallMat = createToonMaterial(wallColor);
        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.set(wd.px, wd.sy / 2, wd.pz);
        wall.rotation.y = wd.roty;
        wall.receiveShadow = true;
        room.add(wall);
        addOutline(wall, wallGeo, 1.01);

        // Add accent stripe on wall
        const stripeGeo = new THREE.BoxGeometry(wd.sx, 0.15, wallThickness + 0.05);
        const stripeMat = createToonMaterial(accentColor, accentColor, 0.3);
        const stripe = new THREE.Mesh(stripeGeo, stripeMat);
        stripe.position.set(wd.px, h * 0.75, wd.pz);
        stripe.rotation.y = wd.roty;
        room.add(stripe);

        // Bottom accent stripe
        const stripe2 = stripe.clone();
        stripe2.position.y = 0.3;
        room.add(stripe2);

        // Collision wall AABB
        let minX, maxX, minZ, maxZ;
        if (wd.roty === 0 || Math.abs(wd.roty) === Math.PI) {
            minX = wd.px - wd.sx / 2;
            maxX = wd.px + wd.sx / 2;
            minZ = wd.pz - wallThickness / 2;
            maxZ = wd.pz + wallThickness / 2;
        } else {
            minX = wd.px - wallThickness / 2;
            maxX = wd.px + wallThickness / 2;
            minZ = wd.pz - wd.sx / 2;
            maxZ = wd.pz + wd.sx / 2;
        }
        ARENA.walls.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: wd.sy });
    });

    // Add spawn points around room perimeter
    const spawnMargin = 3;
    ARENA.spawnPoints.push(
        { x: cx - w / 2 + spawnMargin, z: cz - d / 2 + spawnMargin, room: name },
        { x: cx + w / 2 - spawnMargin, z: cz - d / 2 + spawnMargin, room: name },
        { x: cx - w / 2 + spawnMargin, z: cz + d / 2 - spawnMargin, room: name },
        { x: cx + w / 2 - spawnMargin, z: cz + d / 2 - spawnMargin, room: name },
    );

    // Nav points for enemy pathfinding
    ARENA.navPoints.push(
        { x: cx, z: cz, room: name },
        { x: cx - w / 4, z: cz - d / 4, room: name },
        { x: cx + w / 4, z: cz + d / 4, room: name },
    );

    ARENA.rooms.push({ name, cx, cz, w, h, d });
    parent.add(room);
}

function buildCorridor(parent, def) {
    const corr = new THREE.Group();
    corr.name = `corridor_${def.from}_${def.to}`;

    let cx, cz;
    if (def.axis === 'x') {
        cx = def.pos;
        cz = 0;
    } else {
        cx = 0;
        cz = def.pos;
    }

    // Floor
    const floorGeo = new THREE.PlaneGeometry(def.w, def.d);
    const floorMat = createToonMaterial(0x151530);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.01, cz);
    if (def.axis === 'x') floor.rotation.z = Math.PI / 2;
    corr.add(floor);

    // Ceiling
    const ceilGeo = new THREE.PlaneGeometry(def.w, def.d);
    const ceilMat = createToonMaterial(0x0a0a18);
    const ceil = new THREE.Mesh(ceilGeo, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, def.h, cz);
    if (def.axis === 'x') ceil.rotation.z = Math.PI / 2;
    corr.add(ceil);

    // Corridor walls (2 side walls)
    const wallThickness = 0.5;
    const wallColor = 0x1e1e3a;
    const accentColor = COLORS.violet;

    if (def.axis === 'x') {
        // Corridor runs along X axis - walls on Z sides
        [-1, 1].forEach(side => {
            const wallGeo = new THREE.BoxGeometry(def.d, def.h, wallThickness);
            const wallMat = createToonMaterial(wallColor);
            const wall = new THREE.Mesh(wallGeo, wallMat);
            wall.position.set(cx, def.h / 2, cz + side * def.w / 2);
            corr.add(wall);

            // Neon stripe
            const stripeGeo = new THREE.BoxGeometry(def.d, 0.12, wallThickness + 0.05);
            const stripeMat = createToonMaterial(accentColor, accentColor, 0.5);
            const stripe = new THREE.Mesh(stripeGeo, stripeMat);
            stripe.position.set(cx, def.h * 0.5, cz + side * def.w / 2);
            corr.add(stripe);

            ARENA.walls.push({
                minX: cx - def.d / 2, maxX: cx + def.d / 2,
                minZ: cz + side * def.w / 2 - wallThickness / 2,
                maxZ: cz + side * def.w / 2 + wallThickness / 2,
                minY: 0, maxY: def.h,
            });
        });
    } else {
        // Corridor runs along Z axis - walls on X sides
        [-1, 1].forEach(side => {
            const wallGeo = new THREE.BoxGeometry(wallThickness, def.h, def.d);
            const wallMat = createToonMaterial(wallColor);
            const wall = new THREE.Mesh(wallGeo, wallMat);
            wall.position.set(cx + side * def.w / 2, def.h / 2, cz);
            corr.add(wall);

            const stripeGeo = new THREE.BoxGeometry(wallThickness + 0.05, 0.12, def.d);
            const stripeMat = createToonMaterial(accentColor, accentColor, 0.5);
            const stripe = new THREE.Mesh(stripeGeo, stripeMat);
            stripe.position.set(cx + side * def.w / 2, def.h * 0.5, cz);
            corr.add(stripe);

            ARENA.walls.push({
                minX: cx + side * def.w / 2 - wallThickness / 2,
                maxX: cx + side * def.w / 2 + wallThickness / 2,
                minZ: cz - def.d / 2, maxZ: cz + def.d / 2,
                minY: 0, maxY: def.h,
            });
        });
    }

    // Nav point in corridor center
    ARENA.navPoints.push({ x: cx, z: cz, room: corr.name });

    parent.add(corr);
}

function addEnvironmentalProps(parent) {
    const propsGroup = new THREE.Group();
    propsGroup.name = 'props';

    // Hazard Vats - placed around the arena
    vatPositions.forEach((pos, i) => {
        const vat = createHazardVat(i);
        vat.position.set(pos.x, 0, pos.z);
        vat.rotation.set(pos.rx ?? 0, pos.ry ?? 0, pos.rz ?? 0);
        if (pos.scale !== undefined) vat.scale.setScalar(pos.scale);
        propsGroup.add(vat);

        // Collision for vat
        ARENA.walls.push({
            minX: pos.x - 0.9, maxX: pos.x + 0.9,
            minZ: pos.z - 0.9, maxZ: pos.z + 0.9,
            minY: 0, maxY: 2.5,
        });
    });

    // Machinery Pump Units
    pumpPositions.forEach((pos, i) => {
        const pump = createPumpUnit(i);
        pump.position.set(pos.x, 0, pos.z);
        pump.rotation.set(pos.rx ?? 0, pos.ry ?? 0, pos.rz ?? 0);
        if (pos.scale !== undefined) pump.scale.setScalar(pos.scale);
        propsGroup.add(pump);

        ARENA.walls.push({
            minX: pos.x - 1.0, maxX: pos.x + 1.0,
            minZ: pos.z - 0.7, maxZ: pos.z + 0.7,
            minY: 0, maxY: 2.0,
        });
    });

    // Hazardous pipes along walls and ceilings
    addPipes(propsGroup);

    // Designer-imported custom GLB props (authored in Rogue Editor)
    addCustomProps(propsGroup);

    parent.add(propsGroup);
}

function addCustomProps(parent) {
    for (const def of customPropDefs) {
        if (!def || !def.asset) continue;
        const url = CUSTOM_PROP_URL_PREFIX + def.asset;
        const root = new THREE.Group();
        root.name = def.id || 'custom';
        root.position.set(def.x ?? 0, def.y ?? 0, def.z ?? 0);
        root.rotation.set(def.rx ?? 0, def.ry ?? 0, def.rz ?? 0);
        root.scale.setScalar(def.scale ?? 1);

        // Clone from the preloaded asset cache. If the GLB failed to load
        // the prop is simply omitted — no placeholder flicker, no late pop-in.
        const mesh = cloneAsset(url);
        if (mesh) {
            root.add(mesh);
            parent.add(root);
        } else {
            console.warn('[customProp] missing GLB, skipping visual:', url);
        }
    }
}

// Hazard Vat — uses preloaded prop_hazard_vat_glowing.glb from assetLoader cache.
// Asset: 1.691 × 2.012 × 1.707, MinY: -1.01
// Target height 2.0 → scale = 2.0 / 2.012 ≈ 0.994; posY = 1.01 * scale ≈ 1.004
function createHazardVat(index) {
    const root = new THREE.Group();
    root.name = 'prop_hazard_vat';

    const glowColor = index % 2 === 0 ? COLORS.cyan : COLORS.lime;

    const vatModel = cloneAsset('prop_vat');
    if (vatModel) {
        // Scale so tallest dimension (2.012) fills the same 2-unit space as the placeholder cylinder
        const scale = 2.0 / 2.012;
        vatModel.scale.setScalar(scale);
        // MinY = -1.01 → lift so base sits at y=0
        vatModel.position.y = 1.01 * scale;
        root.add(vatModel);
    } else {
        // Fallback placeholder (used when the GLB failed to load)
        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(0.8, 0.8, 2.0, 12),
            createToonMaterial(0x333340)
        );
        body.position.y = 1.0;
        root.add(body);
        addOutline(body, body.geometry, 1.04);

        const stripeMat = createToonMaterial(COLORS.yellow);
        const stripe1 = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.15, 12), stripeMat);
        stripe1.position.y = 1.7;
        root.add(stripe1);
        const stripe2 = stripe1.clone();
        stripe2.position.y = 0.3;
        root.add(stripe2);

        const liquid = new THREE.Mesh(
            new THREE.CylinderGeometry(0.6, 0.6, 1.6, 12),
            createToonMaterial(glowColor, glowColor, 1.0)
        );
        liquid.position.y = 1.0;
        root.add(liquid);

        const porthole = new THREE.Mesh(
            new THREE.SphereGeometry(0.2, 8, 8),
            createToonMaterial(glowColor, glowColor, 0.8)
        );
        porthole.position.set(0.75, 1.0, 0);
        root.add(porthole);
    }

    // Point light always present regardless of mesh source
    const light = new THREE.PointLight(glowColor, 0.6, 6);
    light.position.y = 1.0;
    root.add(light);

    root.userData.isVat = true;
    root.userData.glowColor = glowColor;

    return root;
}

// Pump Unit — uses preloaded prop_machinery_pump_unit.glb from assetLoader cache.
// Asset: 1.835 × 2.009 × 1.255, MinY: -1.007
// Target height 2.0 → scale = 2.0 / 2.009 ≈ 0.996; posY = 1.007 * scale ≈ 1.003
function createPumpUnit(index) {
    const root = new THREE.Group();
    root.name = 'prop_machinery_pump';

    const pumpModel = cloneAsset('prop_pump');
    if (pumpModel) {
        // Scale so tallest dimension (2.009) matches the ~2-unit placeholder height
        const scale = 2.0 / 2.009;
        pumpModel.scale.setScalar(scale);
        // MinY = -1.007 → lift so base sits at y=0
        pumpModel.position.y = 1.007 * scale;
        root.add(pumpModel);
    } else {
        // Fallback placeholder
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(1.8, 1.6, 1.2),
            createToonMaterial(COLORS.magenta)
        );
        body.position.y = 0.8;
        root.add(body);
        addOutline(body, body.geometry, 1.03);

        const piston = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.35, 0.8, 8),
            createToonMaterial(0x444455)
        );
        piston.position.set(0, 1.8, 0);
        root.add(piston);

        const pipeMat = createToonMaterial(COLORS.cyan, COLORS.cyan, 0.2);
        [-0.5, 0.5].forEach(x => {
            const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), pipeMat);
            pipe.position.set(x, 1.0, 0.65);
            pipe.rotation.x = Math.PI / 4;
            root.add(pipe);
        });

        const ledGeo = new THREE.SphereGeometry(0.06, 6, 6);
        const led1 = new THREE.Mesh(ledGeo, createToonMaterial(COLORS.magenta, COLORS.magenta, 1.0));
        const led2 = new THREE.Mesh(ledGeo, createToonMaterial(COLORS.cyan, COLORS.cyan, 1.0));
        led1.position.set(-0.2, 2.25, 0);
        led2.position.set(0.2, 2.25, 0);
        root.add(led1, led2);
    }

    return root;
}

function addPipes(parent) {
    const pipeMat = createToonMaterial(0x2a2a40, COLORS.lime, 0.15);
    const pipeGeo = new THREE.CylinderGeometry(0.1, 0.1, 1, 6);

    // Ceiling pipes in main hall
    for (let x = -12; x <= 12; x += 6) {
        const pipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.1, 28, 6),
            createToonMaterial(0x2a2a40, NEON_PALETTE[Math.abs(x) % NEON_PALETTE.length], 0.2)
        );
        pipe.rotation.x = Math.PI / 2;
        pipe.position.set(x, 7.5, 0);
        parent.add(pipe);
    }

    // Cross pipes
    for (let z = -12; z <= 12; z += 8) {
        const pipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.08, 28, 6),
            createToonMaterial(0x2a2a40, COLORS.violet, 0.15)
        );
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(0, 7.2, z);
        parent.add(pipe);
    }
}

function addPlatforms(parent) {
    // Elevated platforms in main hall for vertical gameplay
    platDefs.forEach(p => {
        const platGeo = new THREE.BoxGeometry(p.w, 0.4, p.d);
        const platMat = createToonMaterial(0x2a2a50, COLORS.cyan, 0.1);
        const plat = new THREE.Mesh(platGeo, platMat);
        plat.position.set(p.x, p.y, p.z);
        plat.receiveShadow = true;
        parent.add(plat);
        addOutline(plat, platGeo, 1.02);

        // Neon edge highlight
        const edgeGeo = new THREE.BoxGeometry(p.w + 0.1, 0.05, p.d + 0.1);
        const edgeMat = createToonMaterial(COLORS.cyan, COLORS.cyan, 0.5);
        const edge = new THREE.Mesh(edgeGeo, edgeMat);
        edge.position.set(p.x, p.y + 0.21, p.z);
        parent.add(edge);

        // Platform collision - players can stand on top
        ARENA.walls.push({
            minX: p.x - p.w / 2, maxX: p.x + p.w / 2,
            minZ: p.z - p.d / 2, maxZ: p.z + p.d / 2,
            minY: 0, maxY: p.y + 0.2,
            isPlatform: true,
            topY: p.y + 0.2,
        });
    });
}

function addNeonLighting(parent) {
    // Colored point lights throughout the arena for the neon underground feel
    lightDefs.forEach(ld => {
        const light = new THREE.PointLight(ld.color, ld.intensity, ld.dist);
        light.position.set(ld.x, ld.y, ld.z);
        parent.add(light);
    });
}

export { buildArena, loadLevelData, collectCustomPropAssets, ARENA, ROOM_DEFS };

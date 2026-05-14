// ============================================
// Zombie Blaster ⇄ Three.js editor bridge
// Loaded dynamically by editor/js/Menubar.File.js when the user clicks
// "Import Zombie Blaster Level" or "Save Zombie Blaster Level".
// Runs in the editor's page context, so the editor's importmap is in scope:
//   three            -> ../build/three.module.js
//   three/addons/    -> ../examples/jsm/
// ============================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const LEVEL_URL = '/data/levelData.json';
const ASSET_PREFIX = '/assets/CorridorKit/';
const SAVE_URL = '/api/save-level';

const ROOM_COLOR = 0x00ff88;
const ENEMY_SPAWN_COLOR = 0xff0044;
const PLAYER_SPAWN_COLOR = 0x00ffff;
const LIGHT_HELPER_OPACITY = 0.6;

// Match the rounding used elsewhere in the project so save → load → save is byte-stable.
const round = n => Math.round(n * 10000) / 10000;

function cloneAsset(source) {
    let isSkinned = false;
    source.traverse(c => { if (c.isSkinnedMesh) isSkinned = true; });
    return isSkinned ? cloneSkinned(source) : source.clone(true);
}

// Belt-and-braces autosave neutralisation.
//
// The Three.js editor's autosave runs editor.toJSON() and writes the result to
// IndexedDB on every signal-driven scene change. With our ~310 MB GLB scene,
// both steps block the main thread for ~1s every time the user nudges a
// gizmo, which is the freeze the user sees. The editor's own bail check is at
// the *top* of saveState() in editor/index.html, so toggling the autosave
// config flag isn't enough on its own — any save already queued in its
// 1s/100ms debounce will still fire (the inner callbacks don't re-check the
// flag). So we hit it from three angles:
//   1) flip the autosave config flag, which prevents *new* saveState() calls
//      from scheduling anything;
//   2) stub editor.toJSON() so any race / queued save reads a tiny payload;
//   3) stub editor.storage.set() so the IndexedDB structured-clone is skipped.
// All three are idempotent and stash the originals on editor._zbOriginal* so
// you can restore them via the dev console if you ever need the editor's
// native Save Project flow back.
function neutraliseAutosave(editor) {
    if (editor.config?.setKey) {
        editor.config.setKey('autosave', false);
    }
    if (typeof editor.toJSON === 'function' && !editor._zbOriginalToJSON) {
        editor._zbOriginalToJSON = editor.toJSON.bind(editor);
        editor.toJSON = function () {
            return {
                metadata: { type: 'App', version: 4, generator: 'three.js editor (zombie-blaster stub)' },
                project: {}, camera: {}, scene: { type: 'Scene' },
                scripts: {}, history: { undos: [], redos: [] },
            };
        };
    }
    if (editor.storage?.set && !editor.storage._zbOriginalSet) {
        editor.storage._zbOriginalSet = editor.storage.set.bind(editor.storage);
        editor.storage.set = function () { /* no-op */ };
    }
}

export async function importLevel(editor) {
    // Neutralise autosave BEFORE editor.clear() and addObject() fire any signals.
    neutraliseAutosave(editor);

    // 1. Pull the level JSON.
    let level;
    try {
        const resp = await fetch(LEVEL_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        level = await resp.json();
    } catch (e) {
        alert(`Failed to load levelData.json: ${e.message}`);
        return;
    }

    // 2. Load every unique GLB referenced by customProps (in parallel).
    const uniqueAssets = [...new Set((level.customProps ?? []).map(p => p.asset))];
    const loader = new GLTFLoader();
    const cache = new Map();

    const origTitle = document.title;
    let done = 0;
    document.title = `Importing 0/${uniqueAssets.length}…`;

    await Promise.all(uniqueAssets.map(async asset => {
        try {
            const gltf = await loader.loadAsync(`${ASSET_PREFIX}${asset}`);
            cache.set(asset, gltf.scene);
        } catch (e) {
            console.warn(`[zombie-blaster-level] failed to load ${asset}:`, e);
        } finally {
            done++;
            document.title = `Importing ${done}/${uniqueAssets.length}…`;
        }
    }));

    document.title = origTitle;

    // 3. Wipe whatever the editor currently has, then drop our entities in.
    editor.clear();
    const scene = editor.scene;

    // Round-trip the parts of levelData that don't have a visual editor representation
    // (corridors, traps, vats, pumps, platforms — currently all empty arrays in the file).
    scene.userData.zombieBlasterUnmapped = {
        version: level.version ?? 1,
        corridors: level.corridors ?? [],
        props: level.props ?? { vats: [], pumps: [] },
        platforms: level.platforms ?? [],
        traps: level.traps ?? { crushers: [], acidPools: [], pipeBursts: [] },
    };

    // Rooms — wireframe boxes
    for (const r of level.rooms ?? []) {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(r.w, r.h, r.d),
            new THREE.MeshBasicMaterial({ color: ROOM_COLOR, wireframe: true })
        );
        mesh.position.set(r.cx, r.h / 2, r.cz);
        mesh.name = `Room: ${r.id}`;
        mesh.userData = { kind: 'room', id: r.id };
        editor.addObject(mesh);
    }

    // Custom props — real GLBs cloned out of the cache
    for (const p of level.customProps ?? []) {
        const source = cache.get(p.asset);
        if (!source) {
            console.warn(`[zombie-blaster-level] no GLB cached for ${p.asset}; skipping ${p.id}`);
            continue;
        }
        const node = cloneAsset(source);
        node.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
        node.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
        // Scale: per-axis (sx/sy/sz) wins over uniform (scale) so non-uniform
        // edits round-trip without collapsing to scale.x.
        if (typeof p.sx === 'number' || typeof p.sy === 'number' || typeof p.sz === 'number') {
            node.scale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1);
        } else {
            node.scale.setScalar(p.scale ?? 1);
        }
        node.name = `Prop: ${p.id} [${p.asset}]`;
        node.userData = { kind: 'customProp', id: p.id, asset: p.asset };
        editor.addObject(node);
    }

    // Enemy spawns — red icosahedrons. y is editor-only (schema has only x/z).
    for (const s of level.enemySpawns ?? []) {
        const mesh = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.6),
            new THREE.MeshLambertMaterial({ color: ENEMY_SPAWN_COLOR })
        );
        mesh.position.set(s.x, 0.6, s.z);
        mesh.name = `Enemy Spawn: ${s.id}`;
        mesh.userData = { kind: 'enemySpawn', id: s.id };
        editor.addObject(mesh);
    }

    // Player spawn — cyan octahedron
    if (level.playerSpawn) {
        const mesh = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.6),
            new THREE.MeshLambertMaterial({ color: PLAYER_SPAWN_COLOR })
        );
        mesh.position.set(level.playerSpawn.x, level.playerSpawn.y, level.playerSpawn.z);
        mesh.name = 'Player Spawn';
        mesh.userData = { kind: 'playerSpawn' };
        editor.addObject(mesh);
    }

    // Lights — PointLights with a wireframe-sphere child marker so they're easy
    // to click in the viewport. Tag the marker so it isn't mistaken for an
    // editable entity by saveLevel's traversal.
    for (const l of level.lights ?? []) {
        const colorInt = typeof l.color === 'string'
            ? parseInt(l.color.replace(/^0x/i, ''), 16)
            : l.color;
        const light = new THREE.PointLight(colorInt, l.intensity ?? 1, l.distance ?? 0);
        light.position.set(l.x ?? 0, l.y ?? 0, l.z ?? 0);
        light.name = `Light: ${l.id}`;
        light.userData = { kind: 'light', id: l.id };

        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(0.35, 12, 12),
            new THREE.MeshBasicMaterial({
                color: colorInt, wireframe: true,
                transparent: true, opacity: LIGHT_HELPER_OPACITY,
            })
        );
        marker.name = 'light-helper';
        light.add(marker);

        editor.addObject(light);
    }

    console.log(
        `[zombie-blaster-level] imported ` +
        `${level.rooms?.length ?? 0} room(s), ` +
        `${level.customProps?.length ?? 0} prop(s), ` +
        `${level.enemySpawns?.length ?? 0} spawn(s), ` +
        `${level.lights?.length ?? 0} light(s) ` +
        `· autosave neutralised (use File → Save Zombie Blaster Level to persist)`
    );
}

// Top-level scene children imported via the editor's File → Import (Loader.js
// sets scene.name = filename and adds without any userData.kind tag) are
// invisible to the customProp traversal below. Promote any matching node to a
// customProp here so the user's GLB drops actually persist into levelData.json.
//
// Match rule: direct child of editor.scene, no userData.kind already, has a
// .name that ends with .glb or .gltf. Filename becomes the `asset` (the game
// resolves it under /assets/CorridorKit/). IDs collide-check against every
// existing userData.id in the scene so we don't overwrite a custom_N already
// in use elsewhere in the level.
function autoTagUntaggedProps(editor) {
    const existingIds = new Set();
    editor.scene.traverse(node => {
        const id = node.userData?.id;
        if (id) existingIds.add(id);
    });

    let counter = 0;
    const nextId = () => {
        let id;
        do { id = `custom_${counter++}`; } while (existingIds.has(id));
        existingIds.add(id);
        return id;
    };

    let tagged = 0;
    for (const child of editor.scene.children) {
        if (child.userData?.kind) continue;
        if (child.isLight || child.isCamera) continue;
        const m = (child.name || '').match(/([^/\\]+\.(?:glb|gltf))$/i);
        if (!m) continue;
        const asset = m[1];
        child.userData = {
            ...(child.userData || {}),
            kind: 'customProp',
            id: nextId(),
            asset,
        };
        tagged++;
    }
    if (tagged > 0) {
        console.log(`[zombie-blaster-level] auto-tagged ${tagged} imported GLB prop(s) for save`);
    }
}

export async function saveLevel(editor) {
    autoTagUntaggedProps(editor);

    const unmapped = editor.scene.userData?.zombieBlasterUnmapped ?? {};
    const out = {
        version: unmapped.version ?? 1,
        rooms: [],
        corridors: unmapped.corridors ?? [],
        props: unmapped.props ?? { vats: [], pumps: [] },
        customProps: [],
        enemySpawns: [],
        platforms: unmapped.platforms ?? [],
        lights: [],
        traps: unmapped.traps ?? { crushers: [], acidPools: [], pipeBursts: [] },
        playerSpawn: { x: 0, y: 1.7, z: 0 },
    };

    editor.scene.traverse(node => {
        const k = node.userData?.kind;
        if (!k) return;

        if (k === 'room') {
            // BoxGeometry stores its authored size on .parameters; resizing in the
            // editor lands in .scale, so multiply.
            const params = node.geometry?.parameters ?? { width: 1, height: 1, depth: 1 };
            out.rooms.push({
                id: node.userData.id,
                cx: round(node.position.x),
                cz: round(node.position.z),
                w: round(params.width * node.scale.x),
                h: round(params.height * node.scale.y),
                d: round(params.depth * node.scale.z),
            });
        } else if (k === 'customProp') {
            const prop = {
                id: node.userData.id,
                asset: node.userData.asset,
                x: round(node.position.x),
                y: round(node.position.y),
                z: round(node.position.z),
            };
            // Match the runtime schema: only emit non-zero rotation axes.
            if (node.rotation.x) prop.rx = round(node.rotation.x);
            if (node.rotation.y) prop.ry = round(node.rotation.y);
            if (node.rotation.z) prop.rz = round(node.rotation.z);
            // Non-uniform scale gets per-axis fields so editor edits actually
            // round-trip; uniform scale stays as a single `scale` for back-compat.
            const sx = round(node.scale.x);
            const sy = round(node.scale.y);
            const sz = round(node.scale.z);
            if (sx === sy && sx === sz) {
                prop.scale = sx;
            } else {
                prop.sx = sx;
                prop.sy = sy;
                prop.sz = sz;
            }
            out.customProps.push(prop);
        } else if (k === 'enemySpawn') {
            out.enemySpawns.push({
                id: node.userData.id,
                x: round(node.position.x),
                z: round(node.position.z),
            });
        } else if (k === 'playerSpawn') {
            out.playerSpawn = {
                x: round(node.position.x),
                y: round(node.position.y),
                z: round(node.position.z),
            };
        } else if (k === 'light') {
            out.lights.push({
                id: node.userData.id,
                x: round(node.position.x),
                y: round(node.position.y),
                z: round(node.position.z),
                color: '0x' + node.color.getHexString().toUpperCase(),
                intensity: node.intensity,
                distance: node.distance,
            });
        }
    });

    try {
        const resp = await fetch(SAVE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(out, null, 2),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        alert(
            `Saved Zombie Blaster level: ` +
            `${out.rooms.length} room(s), ${out.customProps.length} prop(s), ` +
            `${out.enemySpawns.length} spawn(s), ${out.lights.length} light(s).`
        );
    } catch (e) {
        alert(`Save failed: ${e.message}`);
        console.error(e);
    }
}

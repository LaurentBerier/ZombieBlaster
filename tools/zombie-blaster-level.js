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
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// Optional URL prefix for all server paths used by this adapter. Defaults to
// '' for the standalone setup (editor + game on same origin). The Sandscape
// embed sets this to e.g. '/_game/8090' so a Vite dev-server proxy routes
// relative fetches and three.js loaders to the external game dev server
// without CORS or cross-origin module concerns.
let _BASE = '';

export function setBaseUrl(url) {
    _BASE = ( url || '' ).replace( /\/+$/, '' );
    // DRACO's decoder path is baked at construction, so force a re-init on
    // the next loader request after base changes.
    _dracoLoader = null;
}

let _dracoLoader = null;
function getDracoLoader() {
    if ( _dracoLoader ) return _dracoLoader;
    _dracoLoader = new DRACOLoader();
    _dracoLoader.setDecoderPath( `${_BASE}/js/lib/draco/gltf/` );
    _dracoLoader.setDecoderConfig( { type: 'js' } );
    _dracoLoader.preload();
    return _dracoLoader;
}

function createGLTFLoader() {
    const loader = new GLTFLoader();
    loader.setDRACOLoader( getDracoLoader() );
    return loader;
}

// Filename offered when the editor downloads the saved level JSON.
// The user manually drops the file into data/ to replace the live level.
const SAVE_FILENAME = 'levelData.json';

// Custom-prop GLBs live under one of several kit folders (CorridorKit,
// arenaKit, …). /api/asset-kits returns { filename: kit_folder } so we
// can build the right URL from the bare filename stored in levelData.json.
// CorridorKit is the fallback for legacy entries / fetch failures.
const DEFAULT_KIT_FOLDER = 'CorridorKit';

async function fetchAssetKitMap() {
    try {
        const resp = await fetch(`${_BASE}/api/asset-kits`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) {
        console.warn('[zombie-blaster-level] /api/asset-kits failed, falling back to CorridorKit-only:', e);
        return {};
    }
}

function assetUrl(kitMap, filename) {
    const kit = kitMap[filename] ?? DEFAULT_KIT_FOLDER;
    return `${_BASE}/assets/${kit}/${filename}`;
}

const ROOM_COLOR = 0x00ff88;
const ENEMY_SPAWN_COLOR = 0xff0044;
const PLAYER_SPAWN_COLOR = 0x00ffff;
const COLLIDER_COLOR = 0xff8800; // Orange — visually distinct from rooms.
const LIGHT_HELPER_OPACITY = 0.6;

// Match the rounding used elsewhere in the project so save → load → save is byte-stable.
const round = n => Math.round(n * 10000) / 10000;

// Decompose a node's WORLD matrix into (position, Euler XYZ, scale) tuples.
// Saving world-space — not local — means a prop dragged into a Group in the
// editor's outliner still serialises at the position the user sees: the game
// has no equivalent grouping, so a local-space save would land the prop at
// `local` and visually jump by `parent.matrixWorld`. Decomposing through a
// fresh Euler with the default 'XYZ' order also pins the rotation
// interpretation, in case the node's own rotation.order drifted.
const _wPos = new THREE.Vector3();
const _wQuat = new THREE.Quaternion();
const _wScale = new THREE.Vector3();
const _wEuler = new THREE.Euler();
function worldTransformOf(node) {
    node.updateMatrixWorld(true);
    node.matrixWorld.decompose(_wPos, _wQuat, _wScale);
    _wEuler.setFromQuaternion(_wQuat, 'XYZ');
    return {
        x: _wPos.x, y: _wPos.y, z: _wPos.z,
        rx: _wEuler.x, ry: _wEuler.y, rz: _wEuler.z,
        sx: _wScale.x, sy: _wScale.y, sz: _wScale.z,
    };
}

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
        const resp = await fetch(`${_BASE}/data/levelData.json`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        level = await resp.json();
    } catch (e) {
        alert(`Failed to load levelData.json: ${e.message}`);
        return;
    }

    // 2. Load every unique GLB referenced by customProps (in parallel).
    // First grab the asset-kit manifest so each filename resolves to the
    // correct kit folder under /assets/.
    const kitMap = await fetchAssetKitMap();
    const uniqueAssets = [...new Set((level.customProps ?? []).map(p => p.asset))];
    const loader = createGLTFLoader();
    const cache = new Map();

    const origTitle = document.title;
    let done = 0;
    document.title = `Importing 0/${uniqueAssets.length}…`;

    await Promise.all(uniqueAssets.map(async asset => {
        try {
            const gltf = await loader.loadAsync(assetUrl(kitMap, asset));
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

    // Colliders — plain orange wireframe boxes. Center-based (cx/cy/cz + w/h/d)
    // so the scene-graph position lines up with the AABB centre in-game.
    // No auto-bootstrap: the designer manages this list explicitly via
    // File → Add Collider / File → Generate Collider from selected mesh.
    for (const c of level.colliders ?? []) {
        addColliderMesh(editor, c.id, c.cx ?? 0, c.cy ?? 0, c.cz ?? 0, c.w ?? 1, c.h ?? 1, c.d ?? 1);
    }

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

    // Visibility for customProp meshes and collider wireframes is owned by
    // the editor's View menu (Menubar.View.js) — its objectAdded handler
    // applies the current toggle state to each addObject() above. Defaults:
    // meshes visible, colliders hidden. Toggle via View → Meshes / Colliders.

    console.log(
        `[zombie-blaster-level] imported ` +
        `${level.rooms?.length ?? 0} room(s), ` +
        `${level.customProps?.length ?? 0} prop(s), ` +
        `${level.enemySpawns?.length ?? 0} spawn(s), ` +
        `${level.lights?.length ?? 0} light(s), ` +
        `${level.colliders?.length ?? 0} collider(s). ` +
        `Autosave neutralised — use Save Level to persist.`
    );
}

// Shared mesh builder so the import path, the auto-bootstrap, the manual
// "Generate" command, and the "Add Collider" command all produce identical
// objects. Wireframe only — adding a second tinted-fill mesh per collider
// pushed the editor's GL state over on big scenes (WebGL context loss).
function addColliderMesh(editor, id, cx, cy, cz, w, h, d) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({ color: COLLIDER_COLOR, wireframe: true })
    );
    mesh.position.set(cx, cy, cz);
    mesh.name = `Collider: ${id}`;
    mesh.userData = { kind: 'collider', id };
    editor.addObject(mesh);
    return mesh;
}

// Three.js editor only has single-select (editor.selected), so "1 or more"
// here means the selection may be a single mesh OR a parent containing many
// — we walk it and emit one collider per descendant mesh.
const _COLLIDER_MIN_EXTENT = 0.05;

// Menubar.File → "Generate Collider from selected mesh". Wraps each mesh in
// the current selection with its own world-space AABB collider box. Designer
// drives this manually one selection at a time — no auto-bootstrap, no
// floor/ceiling filtering: if they selected it, they want a collider for it.
export async function generateColliderFromSelectedMesh(editor) {
    neutraliseAutosave(editor);

    const selected = editor.selected;
    if (!selected) {
        alert('No mesh selected. Click an object in the viewport or scene outliner first.');
        return;
    }

    // Skip collider wireframes themselves so re-running on a parent that
    // already contains generated colliders doesn't recurse into them.
    const meshes = [];
    selected.traverse(n => {
        if (!n.isMesh) return;
        if (n.userData?.kind === 'collider') return;
        meshes.push(n);
    });

    if (meshes.length === 0) {
        alert('Selection contains no meshes.');
        return;
    }

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    let added = 0, skippedTiny = 0;
    const stamp = Date.now();

    for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        mesh.updateMatrixWorld(true);
        const aabb = new THREE.Box3().setFromObject(mesh);
        if (aabb.isEmpty() || !isFinite(aabb.min.x)) continue;

        aabb.getSize(size);
        aabb.getCenter(center);
        if (size.x < _COLLIDER_MIN_EXTENT || size.y < _COLLIDER_MIN_EXTENT || size.z < _COLLIDER_MIN_EXTENT) {
            skippedTiny++;
            continue;
        }

        const id = `from_sel_${stamp}_${i}`;
        addColliderMesh(editor, id, center.x, center.y, center.z, size.x, size.y, size.z);
        added++;
    }

    console.log(
        `[zombie-blaster-level] generated ${added} collider(s) from selection ` +
        `(${meshes.length} mesh(es), ${skippedTiny} tiny skipped).`
    );
    alert(`Generated ${added} new collider(s). Save Level to persist.`);
}

// Generic "hide / show every node with kind === <kind>" helper. State is
// cached on editor.scene.userData under the supplied key so the next toggle
// flips cleanly. Returns { hidden, count } so callers can log + render UI.
function toggleKindVisibility(editor, kind, stateKey) {
    const wasHidden = editor.scene.userData[stateKey] === true;
    const shouldHide = !wasHidden;
    let count = 0;
    editor.scene.traverse(n => {
        if (n.userData?.kind === kind) {
            n.visible = !shouldHide;
            count++;
        }
    });
    editor.scene.userData[stateKey] = shouldHide;
    if (editor.signals?.sceneGraphChanged) {
        editor.signals.sceneGraphChanged.dispatch();
    }
    return { hidden: shouldHide, count };
}

// Hide / show all customProp nodes. Bound to Menubar.File → Toggle Meshes.
// Editing a collider with 45 GLB props visible re-renders ~370k verts on
// every gizmo frame — hiding them drops the cost to just the colliders +
// rooms and makes drag-resize feel instant.
export async function toggleMeshesVisibility(editor) {
    const { hidden, count } = toggleKindVisibility(editor, 'customProp', 'zbPropsHidden');
    console.log(`[zombie-blaster-level] ${hidden ? 'hid' : 'shown'} ${count} mesh(es).`);
}

// Backwards-compat alias: earlier menu entry called this name.
export const togglePropsVisibility = toggleMeshesVisibility;

// Hide / show all collider nodes. Bound to Menubar.File → Toggle Colliders.
// Useful when the designer wants to see the props/rooms without the orange
// boxes obscuring the view (or vice-versa).
export async function toggleCollidersVisibility(editor) {
    const { hidden, count } = toggleKindVisibility(editor, 'collider', 'zbCollidersHidden');
    console.log(`[zombie-blaster-level] ${hidden ? 'hid' : 'shown'} ${count} collider(s).`);
}

// Place a fresh collider box in the scene, tagged for save.
// Exported so Menubar.File's "Add Collider" can trigger it via the adapter.
export async function addCollider(editor) {
    neutraliseAutosave(editor);

    const existingIds = new Set();
    editor.scene.traverse(n => { if (n.userData?.id) existingIds.add(n.userData.id); });
    let n = 0;
    let id;
    do { id = `col_${n++}`; } while (existingIds.has(id));

    const size = 2;
    // Drop it in front of the editor camera if we have one; otherwise spawn at
    // a sensible spot near the world origin. Guard each step so a missing/odd
    // camera can't silently abort the whole add.
    let px = 0, py = size / 2, pz = 0;
    const cam = editor.camera;
    if (cam && typeof cam.getWorldDirection === 'function') {
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        if (isFinite(dir.x) && dir.lengthSq() > 0.0001) {
            const tmp = new THREE.Vector3().copy(cam.position).addScaledVector(dir, 4);
            px = tmp.x; py = Math.max(tmp.y, size / 2); pz = tmp.z;
        }
    }
    const mesh = addColliderMesh(editor, id, px, py, pz, size, size, size);
    if (typeof editor.select === 'function') editor.select(mesh);

    console.log(`[zombie-blaster-level] added collider ${id} at (${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)})`);
}

// Top-level scene children imported via the editor's File → Import (Loader.js
// sets scene.name = filename and adds without any userData.kind tag) are
// invisible to the customProp traversal below. Promote any matching node to a
// customProp here so the user's GLB drops actually persist into levelData.json.
//
// Match rule: direct child of editor.scene, no userData.kind already, has a
// .name that ends with .glb or .gltf. Filename becomes the `asset` — both the
// editor importer and the game runtime resolve it to its actual kit folder
// (CorridorKit, arenaKit, …) via /api/asset-kits at load time. IDs collide-
// check against every existing userData.id in the scene so we don't overwrite
// a custom_N already in use elsewhere in the level.
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

// Walk the scene and assemble the on-disk levelData.json shape. Shared by
// both save paths so the server-write and the local-download stay byte-stable.
function buildLevelJson(editor) {
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
        colliders: [],
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
            // Read world transform — see worldTransformOf for why.
            if (node.parent && node.parent !== editor.scene) {
                console.warn(
                    `[zombie-blaster-level] prop "${node.userData.id}" (${node.userData.asset}) is nested under "${node.parent.name || node.parent.type}"; ` +
                    `saving its world-space transform so the game matches the editor view.`
                );
            }
            const w = worldTransformOf(node);
            const prop = {
                id: node.userData.id,
                asset: node.userData.asset,
                x: round(w.x),
                y: round(w.y),
                z: round(w.z),
            };
            // Match the runtime schema: only emit non-zero rotation axes.
            if (w.rx) prop.rx = round(w.rx);
            if (w.ry) prop.ry = round(w.ry);
            if (w.rz) prop.rz = round(w.rz);
            // Non-uniform scale gets per-axis fields so editor edits actually
            // round-trip; uniform scale stays as a single `scale` for back-compat.
            const sx = round(w.sx);
            const sy = round(w.sy);
            const sz = round(w.sz);
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
        } else if (k === 'collider') {
            // The game's collision is pure AABB, so rotation in the editor is
            // an authoring convenience: at save time we fit a world-space AABB
            // around the rotated/scaled box. Box3.setFromObject already walks
            // the geometry's bounding box through the world matrix, which is
            // exactly the "rotate then take the axis-aligned envelope" math.
            // Re-importing will show the box back as axis-aligned, since the
            // rotation isn't preserved on disk.
            node.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(node);
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);
            out.colliders.push({
                id: node.userData.id,
                cx: round(center.x),
                cy: round(center.y),
                cz: round(center.z),
                w: round(size.x),
                h: round(size.y),
                d: round(size.z),
            });
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

    return out;
}

// Menubar.File → "Save Level". POSTs the level JSON to /api/save-level so the
// dev server writes data/levelData.json in place — reload the game tab to see
// the change. Use the editor's File → Save for a downloads-folder snapshot.
export async function saveLevel(editor) {
    let out;
    try {
        out = buildLevelJson(editor);
    } catch (e) {
        alert(`Save failed: ${e.message}`);
        console.error(e);
        return;
    }

    try {
        const resp = await fetch(`${_BASE}/api/save-level`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(out, null, 2),
        });
        let body = null;
        try { body = await resp.json(); } catch (_) { /* ignore body parse */ }
        if (!resp.ok || (body && body.ok === false)) {
            const detail = body?.detail || body?.error || `HTTP ${resp.status}`;
            throw new Error(detail);
        }
        alert(
            `Saved to game (data/${SAVE_FILENAME}): ` +
            `${out.rooms.length} room(s), ${out.customProps.length} prop(s), ` +
            `${out.enemySpawns.length} spawn(s), ${out.lights.length} light(s), ` +
            `${out.colliders.length} collider(s).\n\n` +
            `Reload the game tab to play the updated level.`
        );
    } catch (e) {
        alert(`Save to game failed: ${e.message}`);
        console.error(e);
    }
}

// Editor's built-in File → Save funnels through here. Downloads the level
// JSON into the browser's default downloads folder so the user can keep /
// share a snapshot without overwriting the live level on disk.
export async function saveLevelToDownloads(editor) {
    let out;
    try {
        out = buildLevelJson(editor);
    } catch (e) {
        alert(`Download failed: ${e.message}`);
        console.error(e);
        return;
    }

    try {
        downloadLevelJson(editor, out);
        alert(
            `Downloaded ${SAVE_FILENAME}: ` +
            `${out.rooms.length} room(s), ${out.customProps.length} prop(s), ` +
            `${out.enemySpawns.length} spawn(s), ${out.lights.length} light(s), ` +
            `${out.colliders.length} collider(s).\n\n` +
            `Drop the file into data/ to replace the live level, or use File → Save Level to write it directly.`
        );
    } catch (e) {
        alert(`Download failed: ${e.message}`);
        console.error(e);
    }
}

// Trigger a browser download of the level JSON. Uses the editor's own
// utils.save when available so the download goes through whatever blob /
// save-file plumbing the host editor already has wired up; falls back to a
// hidden-anchor click otherwise.
function downloadLevelJson(editor, out) {
    const text = JSON.stringify(out, null, 2);
    const blob = new Blob([text], { type: 'application/json' });

    if (typeof editor?.utils?.save === 'function') {
        editor.utils.save(blob, SAVE_FILENAME);
        return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = SAVE_FILENAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revocation so the browser's download pipeline has a chance to
    // resolve the blob before we tear it down (some browsers are strict).
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

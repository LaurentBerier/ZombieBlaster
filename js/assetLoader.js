// ============================================
// Centralized Asset Loader
// Preloads all GLB models before gameplay starts.
// Consumers call cloneAsset(id) to get independent
// scene-graph copies ready for Three.js insertion.
// ============================================

import { GLTFLoader } from './lib/GLTFLoader.js';
import { DRACOLoader } from './lib/DRACOLoader.js';
import { cloneSkinned } from './lib/SkeletonUtils.js';

// Shared Draco decoder for KHR_draco_mesh_compression GLBs.
// JS decoder (no .wasm) — matches js/lib/draco/gltf/ from Three.js r129.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('js/lib/draco/gltf/');
dracoLoader.setDecoderConfig({ type: 'js' });
dracoLoader.preload();

function createGLTFLoader() {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    return loader;
}

// Asset registry: id -> source descriptor (served from game root)
const ASSET_MANIFEST = {
    weapon_biohazard: { type: 'gltf', url: 'assets/Weapons/1_Neon_Biohazard_Blaste_0415181024_texture.glb' },
    weapon_plasma_coil: { type: 'gltf', url: 'assets/Weapons/2_Meshy_AI_Neon_Coil_Plasma_Rifl_0416160536_texture.glb' },
    weapon_ember_blaster: { type: 'gltf', url: 'assets/Weapons/New_Gun/3_Shotgun_futuristic.glb' },
    weapon_neon_plasma_blaster: { type: 'gltf', url: 'assets/Weapons/4_Meshy_AI_Neon_Plasma_Blaster_0416221538_texture.glb' },
    enemy_zombie:        { type: 'gltf', url: 'assets/Characters/Zombie_1/Zombie_1_Unsteady_Walk_withSkin.glb' },
    enemy_zombie_attack: { type: 'gltf', url: 'assets/Characters/Zombie_1/Zombie_1__Charged_1.glb' },
    enemy_zombie_death:  { type: 'gltf', url: 'assets/Characters/Zombie_1/Zombie_1__Dead.glb' },
    enemy_zombie_2:        { type: 'gltf', url: 'assets/Characters/Zombie_2/Zombie_2_Unsteady_Walk_withSkin.glb' },
    enemy_zombie_2_attack: { type: 'gltf', url: 'assets/Characters/Zombie_2/Zombie_2__Charged_1.glb' },
    enemy_zombie_2_death:  { type: 'gltf', url: 'assets/Characters/Zombie_2/Zombie_2__Dead.glb' },
    fx_franken_bullet:     { type: 'texture', url: 'assets/FX/LiquidSpriteSheet2.png' },
    fx_franken_decal_1:    { type: 'texture', url: 'assets/FX/Blood_decal_1.png' },
    fx_franken_decal_2:    { type: 'texture', url: 'assets/FX/Blood_Decal_2.png' },
    fx_green_blood_impact: { type: 'texture', url: 'assets/FX/Green_Spill_juice_SpriteSheet3.png' },
};

// Loaded and standardized entries, keyed by asset id.
// Each entry: { scene, animations: THREE.AnimationClip[], skinned: boolean }
const assetCache = new Map();
const textureCache = new Map();

// Apply shadow casting/receiving to every mesh in the scene graph.
// Called once per loaded asset before it enters the cache.
// Returns true if any SkinnedMesh was found (caller needs to pick the right
// clone path — plain Object3D.clone() doesn't rebind skeletons).
function standardize(rootObject) {
    let skinned = false;
    rootObject.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            child.frustumCulled = true;
        }
        if (child.isSkinnedMesh) skinned = true;
    });
    return skinned;
}

function friendlyName(url) {
    const parts = url.split('/');
    return parts[parts.length - 1];
}

/**
 * Preload GLB/assets (plus any 'object'-type extras). Returns a Promise that
 * resolves when every load has either succeeded or failed (never rejects —
 * missing assets fall back to placeholder geometry in their respective modules).
 *
 * @param {object} [options]
 * @param {Array<{id?: string, url: string, type?: 'gltf'|'object'|'texture'}>} [options.extras]
 *   Additional asset descriptors to load alongside the manifest. Used for
 *   designer-imported custom props discovered in level data at boot time.
 *   If `id` is omitted, the URL is used as the cache key.
 * @param {(info: {
 *   done: number,
 *   total: number,
 *   fraction: number,
 *   currentName: string,
 *   currentUrl: string,
 *   bytesLoaded: number,
 *   bytesTotal: number,
 * }) => void} [options.onProgress]
 *   Called on each byte-progress event and each load completion.
 */
export function preloadAssets({ extras = [], onProgress } = {}) {
    const all = [
        ...Object.entries(ASSET_MANIFEST).map(([id, d]) => ({ id, type: d.type, url: d.url })),
        ...extras.map(e => ({ id: e.id ?? e.url, type: e.type ?? 'gltf', url: e.url })),
    ];

    // De-duplicate by id so level files that reuse the same custom prop don't
    // trigger redundant fetches.
    const seen = new Set();
    const entries = [];
    for (const e of all) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push({ ...e, displayName: friendlyName(e.url) });
    }

    const total = entries.length;
    if (total === 0) {
        onProgress?.({
            done: 0, total: 0, fraction: 1,
            currentName: '', currentUrl: '',
            bytesLoaded: 0, bytesTotal: 0,
        });
        return Promise.resolve();
    }

    const loader = createGLTFLoader();
    const objectLoader = new THREE.ObjectLoader();
    const textureLoader = new THREE.TextureLoader();

    // Per-entry state for aggregated byte-progress display.
    const states = entries.map(e => ({
        id: e.id, url: e.url, type: e.type,
        displayName: e.displayName,
        loadedBytes: 0, totalBytes: 0,
        done: false,
    }));
    let doneCount = 0;

    const emit = (idx) => {
        const s = states[idx];
        let bytesLoaded = 0;
        let bytesTotal = 0;
        for (const x of states) {
            bytesLoaded += x.loadedBytes;
            bytesTotal += x.totalBytes;
        }
        onProgress?.({
            done: doneCount,
            total,
            fraction: doneCount / total,
            currentName: s.displayName,
            currentUrl: s.url,
            bytesLoaded,
            bytesTotal,
        });
    };

    const promises = states.map((s, idx) => new Promise(resolve => {
        const handleProgress = (ev) => {
            if (!ev) return;
            if (ev.lengthComputable) {
                s.loadedBytes = ev.loaded;
                s.totalBytes = ev.total;
            } else if (typeof ev.loaded === 'number') {
                s.loadedBytes = ev.loaded;
            }
            emit(idx);
        };
        const finish = () => {
            if (s.done) return;
            s.done = true;
            if (s.totalBytes > 0) s.loadedBytes = s.totalBytes;
            doneCount++;
            emit(idx);
            resolve();
        };

        if (s.type === 'gltf') {
            loader.load(
                s.url,
                gltf => {
                    const skinned = standardize(gltf.scene);
                    assetCache.set(s.id, {
                        scene: gltf.scene,
                        animations: gltf.animations || [],
                        skinned,
                    });
                    finish();
                },
                handleProgress,
                err => {
                    console.warn(`[AssetLoader] Failed to load "${s.id}" (${s.url}):`, err?.message ?? err);
                    finish();
                }
            );
            return;
        }

        if (s.type === 'texture') {
            textureLoader.load(
                s.url,
                texture => {
                    textureCache.set(s.id, { texture, url: s.url });
                    textureCache.set(s.url, { texture, url: s.url });
                    finish();
                },
                handleProgress,
                err => {
                    console.warn(`[AssetLoader] Failed to load "${s.id}" (${s.url}):`, err?.message ?? err);
                    finish();
                }
            );
            return;
        }

        fetch(s.url)
            .then(resp => {
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return resp.json();
            })
            .then(data => {
                const parsed = objectLoader.parse(data);
                const skinned = standardize(parsed);
                assetCache.set(s.id, { scene: parsed, animations: [], skinned });
                finish();
            })
            .catch(err => {
                console.warn(`[AssetLoader] Failed to load "${s.id}" (${s.url}):`, err?.message ?? err);
                finish();
            });
    }));

    return Promise.all(promises);
}

/**
 * Clone a preloaded asset for independent use in the scene.
 * Returns null if the asset failed to load (caller should use
 * placeholder geometry instead).
 *
 * Skinned assets go through SkeletonUtils.clone so each instance has
 * its own bone hierarchy — required for per-enemy AnimationMixers.
 *
 * @param {string} id  Key from ASSET_MANIFEST or a custom-prop URL
 * @returns {THREE.Object3D | null}
 */
export function cloneAsset(id) {
    const entry = assetCache.get(id);
    if (!entry) return null;

    const clone = entry.skinned ? cloneSkinned(entry.scene) : entry.scene.clone();
    // Re-apply shadow properties — clone() copies geometry/material
    // references but userData flags must be re-set on new nodes.
    clone.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });
    return clone;
}

/**
 * Get the animation clips associated with a preloaded asset.
 * Animations are shared (AnimationMixer binds clips to targets at play time)
 * so it's safe to pass the same clip to multiple per-instance mixers.
 *
 * @param {string} id
 * @returns {THREE.AnimationClip[]}  Empty array if asset missing or has no clips
 */
export function getAssetAnimations(id) {
    const entry = assetCache.get(id);
    return entry ? entry.animations : [];
}

export function getPreloadedTexture(idOrUrl) {
    return textureCache.get(idOrUrl)?.texture ?? null;
}

/**
 * True once the asset has been loaded (including failures — callers
 * should still check cloneAsset for a non-null result).
 */
export function isAssetLoaded(id) {
    return assetCache.has(id);
}

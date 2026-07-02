// ============================================
// DecalManager — Runtime Projected Impact Decals
// Bullet impacts stamp blood / slime / dirt / burn / acid splats onto the
// enemy surface at the hit location. Decals carry their own projection UVs
// (projector space, or the shell quad's own 0..1 UVs), so the system never
// depends on the enemy's authored UV layout — Meshy character exports often
// have unusable UVs.
//
// Projection paths, picked automatically per target:
//  - SkinnedMesh enemies (zombie GLBs): SHADER-PROJECTED decals. The enemy
//    material is patched (onBeforeCompile) with up to 8 projector slots per
//    enemy; each projector is an oriented box anchored to the skeleton bone
//    the shot passed closest to, refreshed from the bone's live transform
//    every frame. The splat is stamped in the fragment shader on the actual
//    skinned surface, so it deforms with the geometry by construction —
//    and no CPU code ever samples skinned vertices (which is unreliable for
//    clones in three.js r129).
//  - Static targets (boss placeholder geometry, non-skinned GLBs): the real
//    surface is raycast and a DecalGeometry patch is clipped against its
//    triangles, re-parented to the enemy so it follows movement.
//  - Fallback (shader patch unavailable): a gently curved shell mesh rigidly
//    anchored to the nearest bone.
//
// TODO(decals): possible upgrades —
//  1. more than 8 concurrent splats per enemy (second uniform bank or a
//     skin-space accumulation buffer);
//  2. DecalGeometry on the animated pose once a three.js upgrade brings
//     SkinnedMesh.applyBoneTransform-aware raycasting (r151+).
//
// Debug: set `window.__DECAL_DEBUG = true` in the console to draw hit-normal
// arrows and projection boxes and to log the active decal count.
// ============================================

import { scene, camera } from './scene.js';
import { getPreloadedTexture } from './assetLoader.js';
import { DecalGeometry } from './lib/DecalGeometry.js';

// Hard limits keep draw calls and fill rate bounded during sustained fire
// (the Soda Laser lands ~20 hits/sec on a single target).
const MAX_TOTAL_DECALS = 80;
// Also the projector-slot count baked into the patched enemy shader.
const MAX_DECALS_PER_ENEMY = 8;
const PER_ENEMY_SPAWN_INTERVAL = 0.09; // min seconds between decals on one enemy
const DECAL_LIFETIME = 7.0;
const DECAL_FADE_TIME = 1.6;
const QUICK_FADE_TIME = 0.3;  // fade used when a cap evicts the oldest decal
// A bone sits inside the body, so the fallback shell is pushed this far along
// the hit normal to sit on the skin.
const BONE_SURFACE_OFFSET = 0.2;
// Shader path: the projector box centre is pushed this far out from the bone
// toward the skin so the surface sits near box centre (full opacity) while the
// box stays shallow — deep enough to cover the body-part thickness, not deep
// enough to reach a second part (e.g. a forearm held in front of the chest).
const SHADER_BOX_SURFACE_OFFSET = 0.18;
// Shell curvature: unit-width patch wrapping a radius-1.4 cylinder (~40° arc).
const SHELL_WRAP_RADIUS = 1.4;

// Decal type registry. `assetIds` are checked against the preloaded texture
// cache in order — drop final Sandscape splat art into assetLoader's
// ASSET_MANIFEST under these ids to replace the placeholders. When no asset
// resolves, a procedural canvas splat (`procedural` spec, RGB strings) is
// generated instead.
//
// Every type stamps as OPAQUE paint that REPLACES the character texture — the
// mesh stays solid, you never see through it (not additive blending). To keep
// splats "super obvious" even in dark corridors (where a pure diffuse paint
// would be lit down to near-black), each type adds a `glow` emissive floor so
// the splat is partly self-lit — bright, but still an opaque colored mark, not
// a translucent glow. `additive: true` remains supported for a future luminous
// goo weapon but is unused.
const DECAL_TYPE_DEFS = {
    blood: {
        // Green zombie-gore procedural splat (the original look). Drop real
        // green art in as `decal_blood_splat` to override the procedural.
        assetIds: ['decal_blood_splat'],
        procedural: { core: '96,208,40', edge: '30,92,14', variants: 2 },
        opacity: 1.0,
        // These characters are largely self-lit (emissive=albedo), and the
        // base emissive is zeroed under the splat — this floor keeps the paint
        // at a comparable luminance so it reads as flat paint, not a dark hole.
        glow: 0.3,
    },
    slime: {
        assetIds: ['decal_slime_splat'],
        procedural: { core: '40,205,245', edge: '6,80,120', variants: 2 },
        opacity: 1.0,
        glow: 0.22,
    },
    toxic: {
        assetIds: ['decal_toxic_splat'],
        procedural: { core: '150,255,50', edge: '30,120,10', variants: 2 },
        opacity: 1.0,
        glow: 0.22,
    },
    dirt: {
        assetIds: ['decal_dirt_splat'],
        procedural: { core: '135,105,72', edge: '60,44,28', variants: 2 },
        opacity: 1.0,
        glow: 0.1,
    },
    burn: {
        assetIds: ['decal_burn_mark'],
        procedural: { core: '34,28,24', edge: '10,8,8', ember: '255,120,25', variants: 2 },
        opacity: 1.0,
        glow: 0.12,
    },
    generic: {
        assetIds: ['decal_generic_splat'],
        procedural: { core: '120,120,132', edge: '40,40,48', variants: 1 },
        opacity: 1.0,
        glow: 0.15,
    },
};
DECAL_TYPE_DEFS.acid = DECAL_TYPE_DEFS.toxic;

let initialized = false;
let shellGeometry = null;
// One atlas holds every splat variant so patched enemy materials need a
// single extra sampler. Each type def gets `rects` (Vector4 uv offset/scale
// per variant) assigned at build time.
let atlasTexture = null;
let atlasUniform = null;
// def object -> [{ material, aspect }] for the mesh/shell paths — keyed by
// def so the 'acid' alias shares the 'toxic' prototypes.
const typePrototypes = new Map();
// enemy -> per-enemy shader state (uniform banks + slot bookkeeping).
// WeakMap: enemies are pooled, states survive respawns of the same slot.
const decalStates = new WeakMap();
const activeDecals = [];
// enemy -> managerTime of its last decal (WeakMap: pooled enemies, no leaks)
const lastSpawnTimes = new WeakMap();
let managerTime = 0;
const debugHelpers = [];
let debugFrameCounter = 0;

const _FORWARD = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _burstPoint = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _bonePos = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _ray = new THREE.Ray();
const _raycaster = new THREE.Raycaster();
const _rayHits = [];
const _surfacePoint = new THREE.Vector3();
const _surfaceNormal = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();
const _projQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _projEuler = new THREE.Euler();
const _decalSize = new THREE.Vector3();
const _projWorld = new THREE.Matrix4();
const _worldQuat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _parentScale = new THREE.Vector3();
const _tintColor = new THREE.Color();
const _rootsUpdated = new Set();

function isDebug() {
    return typeof window !== 'undefined' && !!window.__DECAL_DEBUG;
}

function initDecals() {
    if (initialized) return;
    initialized = true;

    shellGeometry = createShellGeometry();
    buildDecalAtlas();
    Object.values(DECAL_TYPE_DEFS).forEach(def => {
        if (typePrototypes.has(def)) return; // alias already built
        typePrototypes.set(def, buildTypePrototypes(def));
    });
}

// ---- Shader-projected decals (skinned enemies) ----
//
// GLSL injected into the enemy materials. The vertex stage exports the
// deformed (post-skinning) world position/normal; the fragment stage tests
// each projector box and stamps the atlas splat where the surface lies
// inside it. Loop uses a uniform-bounded break — fine on WebGL2 (this game's
// effective baseline; r129 auto-uses a WebGL2 context when available).

const DECAL_VERTEX_PARS = `
varying vec3 vDecalWorldPos;
varying vec3 vDecalWorldNormal;
`;

// After <skinning_vertex>: `transformed`/`objectNormal` hold the skinned
// result, and modelMatrix * transformed is the true deformed world position
// (three keeps bindMatrixInverse in sync so this holds for SkinnedMesh too).
const DECAL_VERTEX_MAIN = `
vDecalWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
// Inverse-transpose so the facing normal stays correct under the non-uniform
// squash/stretch scale applied to bodyGroup during hit-flash and death — plain
// mat3(modelMatrix) skews it and flickers the splat rim on those frames.
vDecalWorldNormal = normalize( transpose( inverse( mat3( modelMatrix ) ) ) * objectNormal );
`;

const DECAL_FRAGMENT_PARS = `
uniform sampler2D uDecalAtlas;
uniform int uDecalCount;
uniform mat4 uDecalMatrix[${MAX_DECALS_PER_ENEMY}];
uniform vec4 uDecalUvRect[${MAX_DECALS_PER_ENEMY}];
uniform vec4 uDecalColor[${MAX_DECALS_PER_ENEMY}];
uniform vec4 uDecalParams[${MAX_DECALS_PER_ENEMY}];
varying vec3 vDecalWorldPos;
varying vec3 vDecalWorldNormal;
`;

// uDecalMatrix maps world space into the projector's unit box (±0.5).
// uDecalColor = rgb tint + alpha opacity (0 = free slot, skipped).
// uDecalParams.x = additive/glow flag, .y = emissive pop strength.
// Depth and facing are feathered so the stamp fades out at the projector
// ends and on grazing surfaces instead of hard-clipping.
//
// Bold readout on busy character textures + dark corridors. Three levers:
//  1. near-binary core — any inked texel fully REPLACES the base texture;
//  2. a THICK pure-black comic rim around the splat (matches the game's
//     black-outline art) so it separates from any background regardless of
//     lighting;
//  3. a strong emissive floor (uDecalParams.y) so the opaque fill is partly
//     self-lit and stays vivid in shadow — bright, but not translucent.
function decalFragmentMain(hasEmissive) {
    const emitLine = hasEmissive
        ? 'decalEmissive += decalGlow;'
        : 'diffuseColor.rgb += decalGlow;';
    return `
vec3 decalEmissive = vec3( 0.0 );
// Coverage mask (max paint opacity at this fragment) — used after the
// roughness/metalness chunks to matte the painted area. The enemy GLBs are
// fully metallic, so without this the replaced albedo would only tint
// specular reflections (reflective, faint) instead of showing as solid paint.
float gDecalMask = 0.0;
{
    vec3 decalWorldNormal = normalize( vDecalWorldNormal );
    for ( int i = 0; i < ${MAX_DECALS_PER_ENEMY}; i ++ ) {
        if ( i >= uDecalCount ) break;
        if ( uDecalColor[ i ].a <= 0.001 ) continue;
        vec4 decalPos = uDecalMatrix[ i ] * vec4( vDecalWorldPos, 1.0 );
        vec3 decalAbs = abs( decalPos.xyz );
        if ( decalAbs.x > 0.5 || decalAbs.y > 0.5 || decalAbs.z > 0.5 ) continue;
        vec3 decalNormal = normalize( mat3( uDecalMatrix[ i ] ) * decalWorldNormal );
        if ( decalNormal.z < 0.1 ) continue;
        vec2 decalUv = uDecalUvRect[ i ].xy + ( decalPos.xy + 0.5 ) * uDecalUvRect[ i ].zw;
        vec4 decalTexel = sRGBToLinear( texture2D( uDecalAtlas, decalUv ) );
        // Only a THIN feather right at the projector-box faces plus a grazing
        // cutoff — the interior stays at full opacity so the paint solidly
        // covers the character texture instead of thinning across the splat.
        float decalFade = uDecalColor[ i ].a
            * smoothstep( 0.5, 0.47, decalAbs.z )
            * smoothstep( 0.1, 0.16, decalNormal.z );
        // Shape comes straight from the splat texture's alpha so the authored
        // lobes, flung droplets and speckles all read. The mid-range threshold
        // matters: a near-zero threshold DILATES the filtered alpha, fattening
        // and fusing the droplets into one featureless blob (the earlier
        // radial "guaranteed disc" made that worse and is gone — opacity is
        // now handled properly by the metalness/emissive masks instead).
        // Ink is solid inside shapes, so the paint stays fully opaque.
        float decalCore = smoothstep( 0.32, 0.6, decalTexel.a );
        // Thin dark ink edge hugging each shape, replacing the old heavy ring.
        float decalRim = smoothstep( 0.14, 0.3, decalTexel.a )
            * ( 1.0 - smoothstep( 0.32, 0.58, decalTexel.a ) );
        // Vivid fill (small lift so dark splats still read bright without
        // blooming under the scene's tone mapping).
        vec3 decalRgb = decalTexel.rgb * uDecalColor[ i ].rgb * 1.1;
        float coreA = decalCore * decalFade;
        float rimA = clamp( decalRim * decalFade * 0.85, 0.0, 1.0 );
        if ( uDecalParams[ i ].x > 0.5 ) {
            vec3 decalGlow = decalRgb * coreA;
            ${emitLine}
        } else {
            // Ink edge first, then the opaque colored shape on top.
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.0 ), rimA );
            diffuseColor.rgb = mix( diffuseColor.rgb, decalRgb, coreA );
            // Self-lit floor so the opaque paint stays bright in the dark.
            vec3 decalGlow = decalRgb * coreA * uDecalParams[ i ].y;
            ${emitLine}
            // Matte the painted area (fill + edge) so it isn't reflective.
            gDecalMask = max( gDecalMask, max( coreA, rimA ) );
        }
    }
}
`;
}

// Bump when the injected GLSL changes — it IS the program cache key, so all
// patched enemy materials with equal base parameters share one compile.
const DECAL_SHADER_CACHE_KEY = 'sandscape_impact_decals_v13';

function createDecalState() {
    const bank = Ctor => ({
        value: Array.from({ length: MAX_DECALS_PER_ENEMY }, () => new Ctor()),
    });
    return {
        patched: false,
        slots: new Array(MAX_DECALS_PER_ENEMY).fill(null),
        uCount: { value: 0 },
        uMatrices: bank(THREE.Matrix4),
        uRects: bank(THREE.Vector4),
        uColors: bank(THREE.Vector4), // rgb tint, a opacity (0 = slot off)
        uParams: bank(THREE.Vector4), // x = additive flag
    };
}

function isSupportedDecalMaterial(material) {
    return !!material && (
        material.isMeshStandardMaterial || material.isMeshPhysicalMaterial
        || material.isMeshPhongMaterial || material.isMeshLambertMaterial
        || material.isMeshBasicMaterial
    );
}

function patchDecalMaterial(material, state) {
    material.userData.decalState = state;
    material.customProgramCacheKey = () => DECAL_SHADER_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uDecalAtlas = atlasUniform;
        shader.uniforms.uDecalCount = state.uCount;
        shader.uniforms.uDecalMatrix = state.uMatrices;
        shader.uniforms.uDecalUvRect = state.uRects;
        shader.uniforms.uDecalColor = state.uColors;
        shader.uniforms.uDecalParams = state.uParams;

        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\n' + DECAL_VERTEX_PARS)
            .replace('#include <skinning_vertex>', '#include <skinning_vertex>\n' + DECAL_VERTEX_MAIN);

        // Unlit materials have no emissive accumulator — fold glow types into
        // the diffuse blend there instead.
        const hasEmissive = shader.fragmentShader.includes('#include <emissivemap_fragment>');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\n' + DECAL_FRAGMENT_PARS)
            .replace('#include <map_fragment>', '#include <map_fragment>\n' + decalFragmentMain(hasEmissive))
            // Matte the painted area. The enemy GLBs are fully metallic
            // (metalness 1), so a replaced albedo shows ONLY in specular
            // reflections — reflective and faint. Forcing the decal region to
            // non-metal + high roughness makes the paint render as solid matte
            // colour. No-ops on materials without these chunks (phong/basic).
            .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, 0.92, gDecalMask );')
            .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = mix( metalnessFactor, 0.0, gDecalMask );');
        if (hasEmissive) {
            // The Meshy character GLBs re-add their albedo as EMISSIVE
            // (emissive=white + emissiveMap=map), so the base texture would
            // paint itself back OVER the decal wherever it's bright (white
            // jersey, face) — the "splat only shows on dark clothes" bug.
            // Mask the material's own emissive under the splat, then add the
            // decal's controlled glow.
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <emissivemap_fragment>',
                '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= ( 1.0 - gDecalMask );\n\ttotalEmissiveRadiance += decalEmissive;'
            );
        }
    };
    material.needsUpdate = true;
}

/**
 * Prepare a freshly (re)spawned enemy's GLB materials for shader decals.
 * Called by enemies.js at the end of applyGLBToEnemy, BEFORE
 * collectTintMaterials, so the tint list picks up the clones that render.
 *
 * cloneAsset() shares materials across every GLB instance of a type, so the
 * materials are cloned per enemy here — required for per-enemy decal
 * uniforms (and it isolates hit-flash tinting per enemy as a side effect).
 */
function prepareEnemyDecalMaterials(enemy) {
    if (!initialized || !enemy || !enemy.bodyGroup) return;

    let state = decalStates.get(enemy);
    if (!state) {
        state = createDecalState();
        decalStates.set(enemy, state);
    }
    // Fresh life for this pooled slot: clear projector slots (stale entries
    // in activeDecals die via the spawnGeneration guard in updateDecals).
    for (let i = 0; i < MAX_DECALS_PER_ENEMY; i++) {
        state.slots[i] = null;
        state.uColors.value[i].w = 0;
    }
    state.uCount.value = 0;
    state.patched = false;

    enemy.bodyGroup.traverse(child => {
        if (!child.isSkinnedMesh || !child.material) return;
        if (Array.isArray(child.material)) {
            child.material = child.material.map(mat => {
                if (!isSupportedDecalMaterial(mat)) return mat;
                const clone = mat.clone();
                patchDecalMaterial(clone, state);
                state.patched = true;
                return clone;
            });
        } else if (isSupportedDecalMaterial(child.material)) {
            const clone = child.material.clone();
            patchDecalMaterial(clone, state);
            child.material = clone;
            state.patched = true;
        }
    });
}

/**
 * Dispose the per-enemy patched material clones on an old GLB before it is
 * discarded on respawn. Without this, each recycled pool slot abandons its
 * cloned MeshStandardMaterials and their renderer program refcounts are never
 * released (a slow leak over a long session). Only clones tagged with
 * `decalState` are disposed — shared GLB materials (untagged) and shared
 * geometry are left untouched so other live enemies of the same type are safe.
 * Call from enemies.js right before enemy.bodyGroup.clear().
 */
function disposeEnemyDecalMaterials(bodyGroup) {
    if (!bodyGroup) return;
    bodyGroup.traverse(child => {
        const mat = child.material;
        if (!mat) return;
        const mats = Array.isArray(mat) ? mat : [mat];
        mats.forEach(m => {
            if (m && m.userData && m.userData.decalState) m.dispose();
        });
    });
}

// ---- Geometry / texture setup ----

// Unit-size (1×1) plane bent around a vertical axis so its centre pokes
// forward (+Z is the outward normal) — fallback shell for skinned enemies
// when the shader path is unavailable. UVs stay the plane's own 0..1 grid.
function createShellGeometry() {
    const geo = new THREE.PlaneGeometry(1, 1, 6, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const theta = pos.getX(i) / SHELL_WRAP_RADIUS;
        pos.setX(i, Math.sin(theta) * SHELL_WRAP_RADIUS);
        pos.setZ(i, (Math.cos(theta) - 1) * SHELL_WRAP_RADIUS);
    }
    geo.computeVertexNormals();
    return geo;
}

function configureDecalTexture(texture) {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    if ('colorSpace' in texture && THREE.SRGBColorSpace) {
        texture.colorSpace = THREE.SRGBColorSpace;
    } else if ('encoding' in texture && THREE.sRGBEncoding) {
        texture.encoding = THREE.sRGBEncoding;
    }
}

// Placeholder splat: FLAT solid-color comic paint — an irregular blobby core
// with splash lobes and flung droplets, all hard-edged and fully opaque so
// the stamp reads as paint replacing the surface, never as an airbrushed
// glow. Draws into a `cell`-sized square at (ox, oy); art stays ≥4px inside
// the cell so linear filtering in the atlas never bleeds a neighbouring
// splat.
function drawProceduralSplat(ctx, ox, oy, cell, spec = {}) {
    const s = cell / 128;
    const cx = ox + cell / 2;
    const cy = oy + cell / 2;
    const core = spec.core ?? '200,200,200';
    const edge = spec.edge ?? '120,120,120';

    // Solid irregular core: one big blob + overlapping lobes around it,
    // with jagged mini-lobes on the perimeter for a ragged splat silhouette.
    ctx.fillStyle = `rgb(${core})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 24 * s, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2 + Math.random() * 0.6;
        const dist = (10 + Math.random() * 14) * s;
        const r = (7 + Math.random() * 12) * s;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2);
        ctx.fill();
    }
    for (let i = 0; i < 10; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = (22 + Math.random() * 8) * s;
        const r = (2.5 + Math.random() * 5) * s;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // Darker solid speckles inside the core for comic texture.
    ctx.fillStyle = `rgb(${edge})`;
    for (let i = 0; i < 9; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = Math.random() * 18 * s;
        const r = (1.5 + Math.random() * 4.5) * s;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // Flung droplets — solid round drips plus a few elongated outward streaks.
    ctx.fillStyle = `rgb(${core})`;
    for (let i = 0; i < 14; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = (30 + Math.random() * 22) * s;
        const r = (1.8 + Math.random() * 4) * s;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r, 0, Math.PI * 2);
        ctx.fill();
    }
    for (let i = 0; i < 5; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = (30 + Math.random() * 16) * s;
        const len = (5 + Math.random() * 8) * s;
        const w = (1.5 + Math.random() * 2) * s;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, len, w, ang, 0, Math.PI * 2);
        ctx.fill();
    }

    if (spec.ember) {
        ctx.strokeStyle = `rgb(${spec.ember})`;
        ctx.lineWidth = 2.5 * s;
        ctx.beginPath();
        ctx.arc(cx, cy, (28 + Math.random() * 5) * s, 0, Math.PI * 2);
        ctx.stroke();
    }
}

// Compose every splat variant into one atlas (128px cells, 4 columns) and
// record each type's uv rects. PNG art is aspect-fit into its cell with
// padding; the rest is drawn procedurally.
function buildDecalAtlas() {
    const defs = [];
    const seenDefs = new Set();
    Object.values(DECAL_TYPE_DEFS).forEach(def => {
        if (seenDefs.has(def)) return;
        seenDefs.add(def);
        defs.push(def);
    });

    const cells = [];
    defs.forEach(def => {
        def.rects = [];
        const images = [];
        (def.assetIds || []).forEach(id => {
            const img = getPreloadedTexture(id)?.image;
            if (img && (img.naturalWidth || img.width)) images.push(img);
        });
        const variants = images.length > 0 ? images.length : (def.procedural?.variants ?? 1);
        for (let v = 0; v < variants; v++) cells.push({ def, image: images[v] || null });
    });

    // 256px cells: enough texel density that the droplets/speckles stay crisp
    // at the on-body splat size instead of dissolving into filtered mush.
    const CELL = 256;
    const COLS = 4;
    const rows = Math.max(1, Math.ceil(cells.length / COLS));
    const canvas = document.createElement('canvas');
    canvas.width = COLS * CELL;
    canvas.height = rows * CELL;
    const ctx = canvas.getContext('2d');

    cells.forEach((cell, i) => {
        const ox = (i % COLS) * CELL;
        const oy = Math.floor(i / COLS) * CELL;
        if (cell.image) {
            const pad = 6;
            const avail = CELL - pad * 2;
            const iw = cell.image.naturalWidth || cell.image.width;
            const ih = cell.image.naturalHeight || cell.image.height;
            const fit = Math.min(avail / iw, avail / ih);
            const w = iw * fit;
            const h = ih * fit;
            ctx.drawImage(cell.image, ox + (CELL - w) / 2, oy + (CELL - h) / 2, w, h);
        } else {
            drawProceduralSplat(ctx, ox, oy, CELL, cell.def.procedural || {});
        }
        cell.def.rects.push(new THREE.Vector4(
            ox / canvas.width, oy / canvas.height,
            CELL / canvas.width, CELL / canvas.height
        ));
    });

    atlasTexture = new THREE.CanvasTexture(canvas);
    // Raw linear upload + flipY off: the shader samples explicit uv rects and
    // decodes sRGB itself (sRGBToLinear), so no built-in decode must apply.
    atlasTexture.flipY = false;
    atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
    atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
    atlasTexture.minFilter = THREE.LinearFilter;
    atlasTexture.magFilter = THREE.LinearFilter;
    atlasTexture.generateMipmaps = false;
    atlasUniform = { value: atlasTexture };
}

function createProceduralSplatTexture(spec = {}) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    drawProceduralSplat(canvas.getContext('2d'), 0, 0, size, spec);
    const texture = new THREE.CanvasTexture(canvas);
    configureDecalTexture(texture);
    return texture;
}

function buildTypePrototypes(def) {
    const entries = [];

    (def.assetIds || []).forEach(id => {
        const texture = getPreloadedTexture(id);
        if (!texture) return;
        configureDecalTexture(texture);
        const image = texture.image;
        const w = image?.naturalWidth || image?.width || 1;
        const h = image?.naturalHeight || image?.height || 1;
        entries.push({ texture, aspect: w / h });
    });

    if (entries.length === 0) {
        const variants = def.procedural?.variants ?? 1;
        for (let i = 0; i < variants; i++) {
            entries.push({ texture: createProceduralSplatTexture(def.procedural), aspect: 1 });
        }
    }

    return entries.map(entry => ({
        material: createDecalMaterial(def, entry.texture),
        aspect: entry.aspect,
    }));
}

function createDecalMaterial(def, texture) {
    return new THREE.MeshBasicMaterial({
        map: texture,
        color: def.tint ?? 0xffffff,
        transparent: true,
        opacity: def.opacity ?? 0.85,
        // Depth test ON: nearer bodies must occlude the splat. Depth write
        // OFF: the splat never occludes anything itself. polygonOffset wins
        // the coplanar depth fight for DecalGeometry patches sitting directly
        // on the surface (shells float slightly off it and don't need it).
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -6,
        // Same alphaTest for every type → all decals share one shader program.
        alphaTest: 0.02,
        blending: def.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        toneMapped: !def.additive,
    });
}

// ---- Spawning ----

/**
 * Stamp an impact decal on an enemy at the bullet hit location.
 *
 * @param {object} enemy        Enemy pool entry (enemies.js shape)
 * @param {THREE.Vector3} hitPoint   Approximate world-space impact point
 * @param {THREE.Vector3} impactDir  Normalized bullet travel direction
 * @param {string} type         Key of DECAL_TYPE_DEFS ('blood', 'slime', ...)
 * @param {object} [opts]       Options:
 *   scale          absolute base size override (else derived from hitRadius)
 *   scaleMult      multiplier on the derived base size (per-weapon sizing)
 *   count          number of splats to stamp in a spread burst (kills)
 *   ignoreThrottle bypass the per-enemy spawn throttle (kill bursts)
 *   lifetime, tint
 */
function spawnImpactDecal(enemy, hitPoint, impactDir, type = 'blood', opts = {}) {
    if (!initialized || !enemy || !enemy.alive || !hitPoint) return;

    // Per-enemy spawn throttle so stream weapons don't churn decals. Kill
    // bursts pass ignoreThrottle so all of their splats land.
    if (!opts.ignoreThrottle) {
        const last = lastSpawnTimes.get(enemy);
        if (last !== undefined && managerTime - last < PER_ENEMY_SPAWN_INTERVAL) return;
        lastSpawnTimes.set(enemy, managerTime);
    }

    const def = DECAL_TYPE_DEFS[type] || DECAL_TYPE_DEFS.generic;

    if (impactDir && impactDir.lengthSq() > 0.0001) {
        _dir.copy(impactDir);
    } else {
        _dir.copy(hitPoint).sub(camera.position);
    }
    if (_dir.lengthSq() < 0.0001) _dir.set(0, 0, -1);
    _dir.normalize();
    _normal.copy(_dir).multiplyScalar(-1);

    const count = Math.max(1, Math.floor(opts.count ?? 1));
    const scaleMult = opts.scaleMult ?? 1;
    // Small, tight, punchy splats — sized so a belly shot shows the whole
    // splat within the torso instead of wrapping past its silhouette.
    const baseScale = (opts.scale
        ?? Math.min(0.55, Math.max(0.26, (enemy.hitRadius || 0.7) * 0.42))) * scaleMult;
    const spread = (enemy.hitRadius || 0.7) * 0.6;

    for (let n = 0; n < count; n++) {
        // First splat lands on the impact point; extras jitter around it so a
        // kill burst reads as a spray across nearby body parts. Jittering the
        // point also re-picks the nearest bone, spreading the burst over the
        // skeleton rather than stacking on one bone.
        if (n === 0) {
            _burstPoint.copy(hitPoint);
        } else {
            _burstPoint.set(
                hitPoint.x + (Math.random() - 0.5) * spread,
                hitPoint.y + (Math.random() - 0.5) * spread,
                hitPoint.z + (Math.random() - 0.5) * spread
            );
        }
        // Per-splat scale/rotation variation so repeated impacts differ.
        const size = baseScale * (0.9 + Math.random() * 0.4);
        const roll = Math.random() * Math.PI * 2;

        let entry = null;
        if (enemy.impactBones && enemy.impactBones.length > 0) {
            entry = spawnShaderDecal(enemy, _burstPoint, _dir, _normal, size, roll, def, opts);
        }
        if (!entry) {
            entry = spawnMeshDecal(enemy, _burstPoint, _dir, _normal, size, roll, def, opts);
        }
        if (!entry) continue;

        activeDecals.push(entry);
        if (isDebug()) debugSpawnMarker(_burstPoint, _normal, size);
    }

    enforceCaps(enemy);
}

// The bone the shot line passed closest to (tie-break toward the impact
// point so grazing/limb shots pick the right body part).
function pickImpactBone(enemy, hitPoint, dir) {
    const bones = enemy.impactBones;
    if (!bones || bones.length === 0) return null;
    enemy.root.updateWorldMatrix(true, true);
    _rayOrigin.copy(hitPoint).addScaledVector(dir, -4.0);
    _ray.set(_rayOrigin, dir);

    let bestBone = null;
    let bestScore = Infinity;
    for (let i = 0; i < bones.length; i++) {
        bones[i].getWorldPosition(_bonePos);
        const score = _ray.distanceSqToPoint(_bonePos)
            + _bonePos.distanceToSquared(hitPoint) * 0.15;
        if (score < bestScore) {
            bestScore = score;
            bestBone = bones[i];
        }
    }
    return bestBone;
}

// Skinned path: claim a projector slot in the enemy's patched shader. The
// projector box is centred on the anchor bone (depth spans from inside the
// body out past the skin) and stored bone-relative, so updateDecals can
// rebuild the world→projector matrix from the bone's live pose each frame —
// the stamp deforms with the skinned surface.
function spawnShaderDecal(enemy, hitPoint, dir, normal, size, roll, def, opts) {
    const state = decalStates.get(enemy);
    if (!state || !state.patched || !def.rects || def.rects.length === 0) return null;
    const bone = pickImpactBone(enemy, hitPoint, dir);
    if (!bone) return null;

    bone.getWorldPosition(_anchor);
    // Push the box centre out toward the skin so the surface sits near box
    // centre (full opacity) with only a SHALLOW depth. The bone is buried
    // inside the body; a deep box centred on it reached far enough forward to
    // also paint a second body part (a forearm in front of the chest). A
    // shallow box centred on the skin covers the local part thickness without
    // reaching past it.
    _anchor.addScaledVector(normal, SHADER_BOX_SURFACE_OFFSET);
    _projQuat.setFromUnitVectors(_FORWARD, normal);
    _rollQuat.setFromAxisAngle(_FORWARD, roll);
    _projQuat.multiply(_rollQuat);
    _decalSize.set(size, size, Math.min(0.72, Math.max(size, 0.5)));
    _projWorld.compose(_anchor, _projQuat, _decalSize);

    // Free slot, else evict the oldest splat on this enemy.
    let slot = state.slots.indexOf(null);
    if (slot === -1) {
        let oldest = state.slots[0];
        for (let i = 1; i < MAX_DECALS_PER_ENEMY; i++) {
            if (state.slots[i].spawnTime < oldest.spawnTime) oldest = state.slots[i];
        }
        slot = oldest.slot;
        destroyDecal(oldest);
    }

    const localMatrix = new THREE.Matrix4()
        .copy(bone.matrixWorld).invert().multiply(_projWorld);

    const rect = def.rects[Math.floor(Math.random() * def.rects.length)];
    const baseOpacity = def.opacity ?? 0.85;
    _tintColor.setHex(opts.tint ?? def.tint ?? 0xffffff);
    state.uRects.value[slot].copy(rect);
    state.uColors.value[slot].set(_tintColor.r, _tintColor.g, _tintColor.b, baseOpacity);
    state.uParams.value[slot].set(def.additive ? 1 : 0, def.glow ?? 0, 0, 0);
    state.uMatrices.value[slot].copy(_projWorld).invert();
    if (state.uCount.value < slot + 1) state.uCount.value = slot + 1;

    const entry = {
        kind: 'shader',
        owner: enemy,
        ownerGeneration: enemy.spawnGeneration ?? 0,
        state, slot, bone, localMatrix,
        lifetime: opts.lifetime ?? DECAL_LIFETIME,
        fadeTime: DECAL_FADE_TIME,
        baseOpacity,
        spawnTime: managerTime,
    };
    state.slots[slot] = entry;

    if (isDebug()) debugProjectionBox(_anchor, _projQuat, _decalSize);
    return entry;
}

// Mesh path: DecalGeometry against a raycast surface (static targets), with
// shell fallbacks for raycast misses and for skinned enemies whose materials
// couldn't be shader-patched.
function spawnMeshDecal(enemy, hitPoint, dir, normal, size, roll, def, opts) {
    const prototypes = typePrototypes.get(def);
    if (!prototypes || prototypes.length === 0) return null;
    const proto = prototypes[Math.floor(Math.random() * prototypes.length)];
    const material = proto.material.clone();
    if (opts.tint !== undefined) material.color.setHex(opts.tint);

    let mesh = null;
    if (enemy.impactBones && enemy.impactBones.length > 0) {
        mesh = spawnBoneShellDecal(enemy, hitPoint, dir, normal, size, proto.aspect, roll, material);
    } else {
        mesh = spawnProjectedMeshDecal(enemy, hitPoint, dir, size, proto.aspect, roll, material)
            || spawnShellDecalAt(hitPoint, normal, size, proto.aspect, roll, material, enemy.root);
    }
    if (!mesh) {
        material.dispose();
        return null;
    }

    mesh.name = 'impact_decal';
    mesh.renderOrder = 6;
    // Bone parents carry extreme scales that confuse sphere culling; with a
    // global cap of 80 decals, skipping the culling test is cheaper than a bug.
    mesh.frustumCulled = false;

    return {
        kind: 'mesh',
        mesh,
        owner: enemy,
        ownerGeneration: enemy.spawnGeneration ?? 0,
        lifetime: opts.lifetime ?? DECAL_LIFETIME,
        fadeTime: DECAL_FADE_TIME,
        baseOpacity: material.opacity,
        spawnTime: managerTime,
    };
}

// Fallback for skinned enemies without a patched shader: curved shell rigidly
// anchored to the nearest bone, pushed out to the skin along the hit normal.
function spawnBoneShellDecal(enemy, hitPoint, dir, normal, size, aspect, roll, material) {
    const bone = pickImpactBone(enemy, hitPoint, dir);
    if (!bone) return null;
    bone.getWorldPosition(_anchor);
    _anchor.addScaledVector(normal, BONE_SURFACE_OFFSET);
    return spawnShellDecalAt(_anchor, normal, size, aspect, roll, material, bone);
}

// Place a shell decal at a world position/orientation, then re-parent it to
// `parent` (bone or enemy root) preserving the world transform so it follows
// the enemy. Bones inherit the GLB's huge unit-correction scale, so the
// (near-uniform) parent world scale is averaged and countered.
function spawnShellDecalAt(worldPos, normal, size, aspect, roll, material, parent) {
    const mesh = new THREE.Mesh(shellGeometry, material);
    mesh.position.copy(worldPos);
    mesh.quaternion.setFromUnitVectors(_FORWARD, normal);
    mesh.rotateZ(roll);
    mesh.scale.set(size * aspect, size, size);

    parent.updateWorldMatrix(true, false);
    _worldQuat.copy(mesh.quaternion);
    parent.worldToLocal(mesh.position);
    parent.getWorldQuaternion(_parentQuat).invert();
    parent.getWorldScale(_parentScale);
    const inherited = Math.max(0.0001,
        (Math.abs(_parentScale.x) + Math.abs(_parentScale.y) + Math.abs(_parentScale.z)) / 3);
    mesh.quaternion.copy(_worldQuat).premultiply(_parentQuat);
    mesh.scale.multiplyScalar(1 / inherited);
    parent.add(mesh);
    return mesh;
}

// Static path: raycast the enemy's real surface and clip a DecalGeometry
// patch against its triangles, so the splat wraps the mesh. Returns null when
// the ray finds no solid surface (caller falls back to a shell decal).
function spawnProjectedMeshDecal(enemy, hitPoint, dir, size, aspect, roll, material) {
    enemy.root.updateWorldMatrix(true, true);
    _rayOrigin.copy(hitPoint).addScaledVector(dir, -3.0);
    _raycaster.set(_rayOrigin, dir);
    _raycaster.near = 0;
    _raycaster.far = 8.0;
    _rayHits.length = 0;
    _raycaster.intersectObject(enemy.bodyGroup, true, _rayHits);

    let surface = null;
    for (let i = 0; i < _rayHits.length; i++) {
        const obj = _rayHits[i].object;
        // Solid front-facing surfaces only: skip skinned meshes (bind-pose
        // raycast garbage), outlines (BackSide), glow/transparent parts, and
        // decals already stamped on the body.
        if (!obj.isMesh || obj.isSkinnedMesh || obj.name === 'impact_decal') continue;
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (!mat || mat.transparent || mat.side === THREE.BackSide) continue;
        surface = _rayHits[i];
        break;
    }
    if (!surface) return null;

    _surfacePoint.copy(surface.point);
    if (surface.face) {
        _normalMatrix.getNormalMatrix(surface.object.matrixWorld);
        _surfaceNormal.copy(surface.face.normal).applyMatrix3(_normalMatrix).normalize();
        if (_surfaceNormal.dot(dir) > 0) _surfaceNormal.multiplyScalar(-1);
    } else {
        _surfaceNormal.copy(dir).multiplyScalar(-1);
    }

    _projQuat.setFromUnitVectors(_FORWARD, _surfaceNormal);
    _rollQuat.setFromAxisAngle(_FORWARD, roll);
    _projQuat.multiply(_rollQuat);
    _projEuler.setFromQuaternion(_projQuat);
    // Projection depth punches through thin parts so the patch isn't clipped
    // to a sliver on shallow surfaces.
    _decalSize.set(size * aspect, size, Math.max(size, 0.4));

    const geometry = new DecalGeometry(surface.object, _surfacePoint, _projEuler, _decalSize);
    if (!geometry.attributes.position || geometry.attributes.position.count === 0) {
        geometry.dispose();
        return null;
    }

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    // Ride the enemy (bodyGroup so squash-and-stretch deforms the splat too),
    // keeping the world placement the projection was built in.
    enemy.bodyGroup.attach(mesh);

    if (isDebug()) debugProjectionBox(_surfacePoint, _projQuat, _decalSize);
    return mesh;
}

// ---- Lifetime / caps / cleanup ----

function enforceCaps(enemy) {
    // Per-enemy cap for mesh-kind decals: quick-fade the oldest live one
    // (shader decals self-cap through their fixed slot bank).
    let count = 0;
    let oldest = null;
    for (let i = 0; i < activeDecals.length; i++) {
        const entry = activeDecals[i];
        if (entry.kind !== 'mesh' || entry.owner !== enemy) continue;
        if (entry.fadeTime === QUICK_FADE_TIME) continue;
        count++;
        if (!oldest) oldest = entry;
    }
    if (count > MAX_DECALS_PER_ENEMY && oldest) {
        oldest.lifetime = Math.min(oldest.lifetime, QUICK_FADE_TIME);
        oldest.fadeTime = QUICK_FADE_TIME;
    }

    // Global hard cap: drop the oldest decals outright.
    while (activeDecals.length > MAX_TOTAL_DECALS) {
        destroyDecal(activeDecals[0]);
    }
}

function updateDecals(dt) {
    managerTime += dt;
    _rootsUpdated.clear();

    for (let i = activeDecals.length - 1; i >= 0; i--) {
        const entry = activeDecals[i];
        const owner = entry.owner;
        // Owner despawned, or its pooled slot was recycled into a new enemy
        // (spawnGeneration changed): drop instantly so no splat lingers where
        // a corpse was or teleports onto the respawned zombie.
        if (owner && (!owner.alive || (owner.spawnGeneration ?? 0) !== entry.ownerGeneration)) {
            destroyDecal(entry);
            continue;
        }
        entry.lifetime -= dt;
        if (entry.lifetime <= 0) {
            destroyDecal(entry);
            continue;
        }
        const fade = entry.lifetime < entry.fadeTime ? entry.lifetime / entry.fadeTime : 1;

        if (entry.kind === 'shader') {
            // Refresh this enemy's matrices once per frame (mixer already
            // posed the bones in updateEnemies), then rebuild the projector
            // from the bone's live transform so the stamp rides the skin.
            if (owner && !_rootsUpdated.has(owner)) {
                owner.root.updateWorldMatrix(true, true);
                _rootsUpdated.add(owner);
            }
            _projWorld.multiplyMatrices(entry.bone.matrixWorld, entry.localMatrix);
            entry.state.uMatrices.value[entry.slot].copy(_projWorld).invert();
            entry.state.uColors.value[entry.slot].w = entry.baseOpacity * fade;
        } else if (fade < 1) {
            entry.mesh.material.opacity = entry.baseOpacity * fade;
        }
    }

    updateDebugHelpers(dt);
}

function refreshSlotCount(state) {
    let count = 0;
    for (let i = 0; i < MAX_DECALS_PER_ENEMY; i++) {
        if (state.slots[i]) count = i + 1;
    }
    state.uCount.value = count;
}

function destroyDecal(entry) {
    const idx = activeDecals.indexOf(entry);
    if (idx !== -1) activeDecals.splice(idx, 1);

    if (entry.kind === 'shader') {
        const state = entry.state;
        if (state.slots[entry.slot] === entry) {
            state.slots[entry.slot] = null;
            state.uColors.value[entry.slot].w = 0;
            refreshSlotCount(state);
        }
        return;
    }

    const mesh = entry.mesh;
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    // Shell geometry is shared and never disposed; DecalGeometry is per-decal.
    if (mesh.geometry && mesh.geometry !== shellGeometry) mesh.geometry.dispose();
    // Materials are per-decal clones (for independent fade); maps are shared.
    mesh.material.dispose();
}

function resetDecals() {
    while (activeDecals.length > 0) {
        destroyDecal(activeDecals[0]);
    }
    while (debugHelpers.length > 0) {
        removeDebugHelper(debugHelpers[0]);
    }
    // lastSpawnTimes / decalStates are keyed by pooled enemies and managerTime
    // only increases, so stale stamps are harmless across resets.
}

// Compile the mesh-path decal programs before combat so the first splat
// doesn't hitch. Two off-screen quads cover both programs (toneMapped differs
// between normal and additive types); they expire on the next update tick.
// The shader-projected enemy program compiles once at the first zombie spawn
// (the same moment the zombie GLB's own program compiles today).
function prewarmDecals() {
    if (!initialized) return;
    [DECAL_TYPE_DEFS.blood, DECAL_TYPE_DEFS.slime].forEach(def => {
        const prototypes = typePrototypes.get(def);
        if (!prototypes || prototypes.length === 0) return;
        const mesh = new THREE.Mesh(shellGeometry, prototypes[0].material.clone());
        mesh.position.set(0, -500, 0);
        mesh.frustumCulled = false;
        scene.add(mesh);
        activeDecals.push({
            kind: 'mesh', mesh, owner: null, ownerGeneration: 0,
            lifetime: 0.02, fadeTime: 0.02, baseOpacity: 1, spawnTime: managerTime,
        });
    });
}

function getActiveDecalCount() {
    return activeDecals.length;
}

// ---- Debug helpers (window.__DECAL_DEBUG) ----

function debugSpawnMarker(point, normal, size) {
    const arrow = new THREE.ArrowHelper(normal, point, Math.max(0.4, size), 0xff00ff);
    scene.add(arrow);
    debugHelpers.push({ object: arrow, ttl: 1.0 });
}

function debugProjectionBox(point, quat, sizeVec) {
    const box = new THREE.Mesh(
        new THREE.BoxGeometry(sizeVec.x, sizeVec.y, sizeVec.z),
        new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true })
    );
    box.position.copy(point);
    box.quaternion.copy(quat);
    scene.add(box);
    debugHelpers.push({ object: box, ttl: 1.0 });
}

function removeDebugHelper(helper) {
    const idx = debugHelpers.indexOf(helper);
    if (idx !== -1) debugHelpers.splice(idx, 1);
    if (helper.object.parent) helper.object.parent.remove(helper.object);
    helper.object.traverse(child => {
        child.geometry?.dispose();
        child.material?.dispose();
    });
}

function updateDebugHelpers(dt) {
    for (let i = debugHelpers.length - 1; i >= 0; i--) {
        debugHelpers[i].ttl -= dt;
        if (debugHelpers[i].ttl <= 0) removeDebugHelper(debugHelpers[i]);
    }
    if (isDebug()) {
        debugFrameCounter++;
        if (debugFrameCounter % 60 === 0) {
            console.log(`[decals] active: ${activeDecals.length}`);
        }
    }
}

export {
    initDecals, updateDecals, resetDecals,
    spawnImpactDecal, prewarmDecals,
    prepareEnemyDecalMaterials, disposeEnemyDecalMaterials,
    getActiveDecalCount,
};

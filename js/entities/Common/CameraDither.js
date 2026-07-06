import * as THREE from 'three'


// Camera-proximity dither-dissolve. Patches a (lit) material so fragments CLOSE to the
// camera stipple away via interleaved-gradient-noise ordered dithering instead of
// occluding the view. We let the camera pass straight through enemies and props (the
// TPS boom only collides with static geometry), so this is what keeps that from looking
// broken: as the lens clips into a body, the near fragments dissolve rather than showing
// the inside of the mesh.
//
// Distance to the camera is read straight from `vViewPosition` (camera-space position,
// a varying every lit material already computes for lighting), so there is NOTHING to
// update per frame — the effect is driven entirely on the GPU. `near` is the distance
// (m) at/under which a fragment is fully gone; `far` is where it's fully solid again.
//
// Safe to call once per material; a second call is a no-op. Only use on lit materials
// (Standard/Phong/Lambert) — they declare vViewPosition; MeshBasicMaterial does not.
export function installProximityDither(material, { near = 0.35, far = 1.0 } = {}){
    if(!material || material._proxDitherInstalled){ return; }
    material._proxDitherInstalled = true;
    // Uniform holders live on the material so they can be retuned at runtime if needed.
    material.userData.proxNear = { value: near };
    material.userData.proxFar  = { value: far };
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        if(prev){ prev(shader, renderer); }
        shader.uniforms.uProxNear = material.userData.proxNear;
        shader.uniforms.uProxFar  = material.userData.proxFar;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>',
                '#include <common>\n' +
                'uniform float uProxNear;\n' +
                'uniform float uProxFar;\n' +
                'float ignPD(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }')
            .replace('#include <clipping_planes_fragment>',
                '#include <clipping_planes_fragment>\n' +
                'float distPD = length(vViewPosition);\n' +
                'float cutPD = 1.0 - smoothstep(uProxNear, uProxFar, distPD);\n' +
                'if(cutPD > 0.0 && ignPD(gl_FragCoord.xy) < cutPD){ discard; }');
    };
    material.needsUpdate = true;
}

// GENERAL RULE: apply the proximity dither to EVERY lit-material mesh under an object. This is
// the one helper to reach for on any DYNAMIC thing the TPS camera can pass straight through —
// characters, props, pickups — so the lens dissolves it when it gets really close instead of
// showing the inside of the mesh. (The camera only collides with STATIC level geometry, so it
// never clips walls; those are handled by the boom collision + the near-plane cull, and
// discarding their fragments would wrongly reveal the void behind them — so don't dither them.)
//
// MeshBasicMaterial is skipped: it doesn't declare the vViewPosition varying the dither reads,
// so patching it would fail to compile. Calls are idempotent per material (installProximityDither
// guards against a second install), so shared/cloned materials are safe.
export function installProximityDitherOnObject(root, opts = {}){
    if(!root){ return; }
    root.traverse(o => {
        if(!o.isMesh && !o.isSkinnedMesh){ return; }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for(const m of mats){
            if(!m || m.isMeshBasicMaterial){ continue; }
            installProximityDither(m, opts);
        }
    });
}

// ============================================
// Scene, Camera, Renderer, and Visual Pipeline
// Toon shading with outline effect
// ============================================

const COLORS = {
    magenta: 0xFF00FF,
    cyan: 0x00FFFF,
    lime: 0x7FFF00,
    orange: 0xFF7F00,
    violet: 0xBF00FF,
    yellow: 0xFFFF00,
    hotPink: 0xFF1493,
    darkBg: 0x111111,
    grey: 0x555555,
    lightGrey: 0xCCCCCC,
    red: 0xFF3B30,
    green: 0x4CD964,
    white: 0xFFFFFF,
    black: 0x000000,
};

// Neon color palette for environment variety
const NEON_PALETTE = [COLORS.magenta, COLORS.cyan, COLORS.lime, COLORS.orange, COLORS.violet, COLORS.hotPink, COLORS.yellow];

let scene, camera, renderer, clock;
let outlineMeshes = []; // Track meshes that need outlines

function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0d20);
    scene.fog = new THREE.FogExp2(0x0d0d20, 0.008);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 1.7, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Cap device-pixel-ratio at 1.5: on a retina display DPR 2 renders 4x the
    // pixels (huge fillrate cost with this many neon lights). 1.5 stays crisp for
    // a fast FPS while cutting ~44% of the shaded pixels vs 2.0.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // Shadow mapping is enabled by nothing here — no light sets castShadow, so it
    // only added shader complexity. Leave it off.
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.6;
    document.body.prepend(renderer.domElement);

    clock = new THREE.Clock();

    // Ambient light - bright enough for underground visibility
    const ambient = new THREE.AmbientLight(0x3a2a6e, 1.0);
    scene.add(ambient);

    // Main directional light
    const dirLight = new THREE.DirectionalLight(0x9977dd, 0.8);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    // Hemisphere fill light for visible floor/ceiling contrast
    const hemiLight = new THREE.HemisphereLight(0x5533bb, 0x221144, 0.6);
    scene.add(hemiLight);

    window.addEventListener('resize', onResize);

    return { scene, camera, renderer, clock };
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Create a toon-shaded material matching the style guide
function createToonMaterial(color, emissiveColor = 0x000000, emissiveIntensity = 0) {
    // Use MeshStandardMaterial with low metalness and high roughness for a matte toon-like look
    const mat = new THREE.MeshStandardMaterial({
        color: color,
        roughness: 0.8,
        metalness: 0.0,
        emissive: emissiveColor,
        emissiveIntensity: emissiveIntensity,
        flatShading: true, // Gives the comic-book hard-edge feel
    });
    return mat;
}

// Create an outline mesh for the comic-book 2px outline effect (BackSide technique)
function createOutlineMesh(geometry, scale = 1.04) {
    const outlineMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        side: THREE.BackSide,
    });
    const outline = new THREE.Mesh(geometry, outlineMat);
    outline.scale.multiplyScalar(scale);
    outline.renderOrder = -1;
    return outline;
}

// Add outline to a mesh and track it
function addOutline(parent, geometry, scale = 1.05) {
    const outline = createOutlineMesh(geometry, scale);
    parent.add(outline);
    outlineMeshes.push(outline);
    return outline;
}

// Build a copy of a texture with its RGB channels rotated (R,G,B) -> (B,R,G),
// so a green-dominant sprite (eg the liquid-bullet sheet, avg ~93,176,25) reads
// as azure blue while its alpha, layout and UV animation are untouched. Lets us
// recolour shared FX art blue without shipping a second asset. Same-origin
// canvas read (no CORS taint); returns the source unchanged if its image isn't
// decoded yet.
function makeChannelRotatedTexture(srcTexture) {
    const img = srcTexture && srcTexture.image;
    if (!img || !img.width) return srcTexture;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        d[i] = b; d[i + 1] = r; d[i + 2] = g; // green liquid -> blue liquid
    }
    ctx.putImageData(data, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = srcTexture.wrapS;
    tex.wrapT = srcTexture.wrapT;
    tex.repeat.copy(srcTexture.repeat);
    tex.offset.copy(srcTexture.offset);
    tex.minFilter = srcTexture.minFilter;
    tex.magFilter = srcTexture.magFilter;
    tex.generateMipmaps = srcTexture.generateMipmaps;
    if ('colorSpace' in srcTexture) tex.colorSpace = srcTexture.colorSpace;
    else if ('encoding' in srcTexture) tex.encoding = srcTexture.encoding;
    tex.needsUpdate = true;
    return tex;
}

export {
    scene, camera, renderer, clock,
    COLORS, NEON_PALETTE,
    initScene,
    createToonMaterial,
    createOutlineMesh,
    addOutline,
    makeChannelRotatedTexture,
};

import * as THREE from 'three';
import Component from '../../Component.js'


// Drifting volumetric-look cloud deck, ported from the SkibidiTower storm sky
// (scene.js buildClouds) and re-graded for this game's BRIGHT DAY instead of an
// overcast storm. It's a transparent BackSide dome drawn over the existing sky:
// a slowly-scudding FBM noise field paints soft white cumulus with grey undersides
// on the blue sky, thinning to clear gaps so it reads as a fair-weather sky rather
// than a solid ceiling. Terrain/buildings occlude it normally (depthTest on,
// depthWrite off), and it drifts continuously via the uTime uniform (see Update).
//
// Differences from the stormy original: lighter, higher-contrast cumulus colours
// (white tops, soft grey bases) instead of bruised greys; lower coverage with real
// blue-sky gaps; a warm sun-side brightening; and a daytime sun direction.
export default class Clouds extends Component{
    constructor(scene){
        super();
        this.name = 'Clouds';
        this.scene = scene;
        // High mid-morning sun (matches a bright, top-lit day). Used to brighten the
        // cloud edges on the sun-facing side.
        this.sunDir = new THREE.Vector3(0.35, 0.82, 0.45).normalize();
        this.time = 0;
        this.mat = null;
        this.dome = null;
    }

    Initialize(){
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            transparent: true,
            depthWrite: false,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
                uSunDir: { value: this.sunDir.clone() },
            },
            vertexShader: `
                varying vec3 vDir;
                void main() {
                    vDir = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float uTime;
                uniform vec3 uSunDir;
                varying vec3 vDir;

                float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                float noise(vec2 p){
                    vec2 i = floor(p), f = fract(p);
                    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
                    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
                }
                float fbm(vec2 p){
                    float v = 0.0, a = 0.5;
                    for (int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.0; a *= 0.5; }
                    return v;
                }

                void main() {
                    vec3 dir = normalize(vDir);
                    // Fade clouds out toward/below the horizon so the sky's blue band shows
                    // beneath the deck (and there's no hard dome rim).
                    float horizonFade = smoothstep(0.0, 0.38, dir.y);
                    if (horizonFade <= 0.0) discard;

                    // "Cloud ceiling" projection: looking up samples a plane.
                    vec2 uv = dir.xz / (dir.y * 0.8 + 0.32);
                    uv *= 1.15;
                    // Gentle fair-weather drift (slower than the storm version).
                    float t = uTime * 0.045;
                    float n  = fbm(uv + vec2(t, t * 0.5));
                    float n2 = fbm(uv * 2.3 + vec2(-t * 1.1, t * 0.6) + 9.0);

                    // Broken cumulus: higher threshold leaves real blue-sky gaps between
                    // puffy clouds (vs the storm's near-total overcast).
                    float cov = smoothstep(0.46, 0.78, n * 0.72 + n2 * 0.28);
                    float density = cov * horizonFade;

                    // Bright white tops with soft grey undersides (n2 drives the billow shading).
                    vec3 baseGrey = vec3(0.62, 0.66, 0.74);
                    vec3 litWhite = vec3(1.0, 0.99, 0.97);
                    vec3 col = mix(baseGrey, litWhite, smoothstep(0.25, 0.85, n2));
                    // Warm brightening on the sun-facing side.
                    float sd = max(dot(dir, uSunDir), 0.0);
                    col += vec3(1.0, 0.92, 0.78) * pow(sd, 8.0) * 0.35;

                    gl_FragColor = vec4(col, density * 0.92);
                }
            `,
        });

        const dome = new THREE.Mesh(new THREE.SphereGeometry(800, 48, 32), mat);
        dome.frustumCulled = false;
        dome.renderOrder = 1;            // over the sky dome, under (occluded by) the scene
        dome.userData.noExport = true;   // skybox dressing — skip in the UE level export
        this.mat = mat;
        this.dome = dome;
        this.scene.add(dome);
    }

    Update(t){
        this.time += t;
        if(this.mat){ this.mat.uniforms.uTime.value = this.time; }
    }
}

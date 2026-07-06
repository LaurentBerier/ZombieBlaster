import Component from '../../Component.js'
import * as THREE from 'three'
import { Ammo } from '../../AmmoLib.js'


// Procedural heightfield terrain that REPLACES the level's flat ground (the "Cube") with gentle "little
// hills and slopes" derived from a grayscale heightmap image. It builds three things in its constructor
// (so they exist immediately, before the rest of the level + spawns are snapped onto it):
//
//   * a rendered mesh — a grid whose vertices are computed directly in WORLD space (no transform), so the
//     same vertex buffer feeds the collider 1:1;
//   * a STATIC btBvhTriangleMeshShape collider in the Ammo world (mass 0 => StaticFilter group, exactly
//     like the level colliders), so every existing down-cast adapts for free: the foot/terrain IK, the
//     TPS camera boom sweep, the ragdoll floor ray, the aim ray, and the player capsule all rest on the
//     terrain instead of the old flat plane;
//   * HeightAt(x,z) — a bilinear sample of the height grid — used to SNAP the shipping containers, ammo
//     boxes, the player and the NPC spawns onto the new ground (vertical only, so the flat navmesh x/z
//     footprint stays valid) and to let the NPC controllers ride the terrain each frame.
//
// The heightmap is LOW-PASSED (downsampled with smoothing + a couple of box-blur passes) and applied at a
// modest amplitude, so the surface undulates GENTLY around y = 0 — enough to read as uneven terrain while
// keeping the flat navmesh + the foot-IK terrain adaptation well within range.
export default class Terrain extends Component {
    // scene        : THREE.Scene to add the terrain mesh to
    // physicsWorld : the Ammo dynamics world to add the static collider to
    // image        : the decoded heightmap HTMLImageElement (loaded via TextureLoader; texture.image)
    constructor(scene, physicsWorld, image, opts = {}){
        super();
        this.name = 'Terrain';
        this.scene = scene;
        this.physicsWorld = physicsWorld;

        // Footprint: centred on the old flat ground (Cube at 18.58,17.56, half-extent 25), a touch larger
        // so the terrain fully covers the playable area with no bare edge.
        this.centerX = opts.centerX ?? 18.58;
        this.centerZ = opts.centerZ ?? 17.56;
        this.sizeX = opts.sizeX ?? 56;
        this.sizeZ = opts.sizeZ ?? 56;
        this.segX = opts.segX ?? 144;        // render + collider grid resolution (segments per side)
        this.segZ = opts.segZ ?? 144;
        this.amplitude = opts.amplitude ?? 1.1;   // peak height deviation from the y=0 mean (m) — pronounced hills/slopes (raised from 0.5 to stress-test the foot IK; kept just under a level that would bounce the player off crests at jog speed)
        this.gridN = opts.gridN ?? 72;       // height-sample grid resolution (low-passed => smooth slopes)

        this.minX = this.centerX - this.sizeX / 2;
        this.minZ = this.centerZ - this.sizeZ / 2;

        this._heights = this._sampleImage(image, this.gridN);   // Float32 gridN*gridN, mean-centred in [-amp,+amp]
        this._buildMesh();
        this._buildCollider();
    }

    // Sample the grayscale heightmap into an NxN grid, mean-centred and scaled to [-amplitude, +amplitude].
    // The (large, detailed) source image is drawn DOWN to NxN with smoothing — a cheap low-pass that turns
    // the heightmap's fine dendritic channels into broad, gentle rises and dips. A couple of box-blur passes
    // soften it further. Falls back to a procedural ripple if there's no canvas/image.
    _sampleImage(image, N){
        const heights = new Float32Array(N * N);
        let ok = false;
        try{
            if(image && typeof document !== 'undefined'){
                const canvas = document.createElement('canvas');
                canvas.width = N; canvas.height = N;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(image, 0, 0, N, N);
                const data = ctx.getImageData(0, 0, N, N).data;
                for(let i = 0; i < N * N; i++){ heights[i] = data[i * 4] / 255; }   // red channel (it's grayscale)
                ok = true;
            }
        }catch(e){ ok = false; }
        if(!ok){
            // No canvas/image (e.g. a non-DOM context): a gentle procedural ripple so terrain still exists.
            for(let j = 0; j < N; j++){ for(let i = 0; i < N; i++){
                heights[j * N + i] = 0.5 + 0.22 * (Math.sin(i * 0.45) + Math.cos(j * 0.38));
            } }
        }

        this._blur(heights, N, 2);   // soften the sharp river channels into gentle slopes

        // Mean-centre, then scale so the largest deviation == amplitude => terrain undulates around y = 0.
        let mean = 0;
        for(let i = 0; i < heights.length; i++){ mean += heights[i]; }
        mean /= heights.length;
        let maxAbs = 1e-4;
        for(let i = 0; i < heights.length; i++){ heights[i] -= mean; maxAbs = Math.max(maxAbs, Math.abs(heights[i])); }
        const k = this.amplitude / maxAbs;
        for(let i = 0; i < heights.length; i++){ heights[i] *= k; }
        return heights;
    }

    // In-place box blur (3x3, edge-clamped) over `passes` iterations.
    _blur(h, N, passes){
        const tmp = new Float32Array(N * N);
        for(let p = 0; p < passes; p++){
            for(let j = 0; j < N; j++){ for(let i = 0; i < N; i++){
                let s = 0, c = 0;
                for(let dj = -1; dj <= 1; dj++){ for(let di = -1; di <= 1; di++){
                    const ii = i + di, jj = j + dj;
                    if(ii < 0 || ii >= N || jj < 0 || jj >= N){ continue; }
                    s += h[jj * N + ii]; c++;
                } }
                tmp[j * N + i] = s / c;
            } }
            h.set(tmp);
        }
    }

    // Bilinear terrain height (world Y) at world (x, z). Outside the footprint clamps to the edge value.
    HeightAt(x, z){
        const N = this.gridN;
        let u = (x - this.minX) / this.sizeX * (N - 1);
        let v = (z - this.minZ) / this.sizeZ * (N - 1);
        u = THREE.MathUtils.clamp(u, 0, N - 1);
        v = THREE.MathUtils.clamp(v, 0, N - 1);
        const i0 = Math.floor(u), j0 = Math.floor(v);
        const i1 = Math.min(i0 + 1, N - 1), j1 = Math.min(j0 + 1, N - 1);
        const fu = u - i0, fv = v - j0;
        const h = this._heights;
        const a = h[j0 * N + i0], b = h[j0 * N + i1], c = h[j1 * N + i0], d = h[j1 * N + i1];
        return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, fu), THREE.MathUtils.lerp(c, d, fu), fv);
    }

    _buildMesh(){
        const { segX, segZ, sizeX, sizeZ, minX, minZ } = this;
        const positions = [];
        const indices = [];
        for(let j = 0; j <= segZ; j++){
            for(let i = 0; i <= segX; i++){
                const x = minX + (i / segX) * sizeX;
                const z = minZ + (j / segZ) * sizeZ;
                positions.push(x, this.HeightAt(x, z), z);
            }
        }
        const stride = segX + 1;
        for(let j = 0; j < segZ; j++){
            for(let i = 0; i < segX; i++){
                const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
                indices.push(a, c, b, b, c, d);   // CCW from above (so normals point up)
            }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geom.setIndex(indices);
        geom.computeVertexNormals();
        // Muted sandy concrete tone to blend with the depot floor; matte so the lights do the shading.
        const mat = new THREE.MeshStandardMaterial({ color: 0x9a8f7d, roughness: 0.97, metalness: 0.0 });
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.name = 'Terrain';
        this.mesh.receiveShadow = true;
        this.mesh.castShadow = false;    // a ground plane doesn't need to cast
        this.scene.add(this.mesh);
        this._positions = positions;     // retained for the collider build
        this._indices = indices;
    }

    _buildCollider(){
        // Static triangle-mesh collider from the SAME vertex/index buffers (so collision == what's drawn).
        // mass 0 => Bullet's 1-arg addRigidBody puts it in the StaticFilter group with the AllFilter&~Static
        // mask, exactly like the level's convex-hull colliders, so the player capsule + every StaticFilter
        // ray/sweep (foot IK, camera boom, ragdoll, aim) collide with it.
        const triMesh = new Ammo.btTriangleMesh();
        const p = this._positions, idx = this._indices;
        const v0 = new Ammo.btVector3(), v1 = new Ammo.btVector3(), v2 = new Ammo.btVector3();
        for(let t = 0; t < idx.length; t += 3){
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            v0.setValue(p[a], p[a + 1], p[a + 2]);
            v1.setValue(p[b], p[b + 1], p[b + 2]);
            v2.setValue(p[c], p[c + 1], p[c + 2]);
            triMesh.addTriangle(v0, v1, v2, false);
        }
        Ammo.destroy(v0); Ammo.destroy(v1); Ammo.destroy(v2);
        this._triMesh = triMesh;   // Bullet holds the mesh by pointer — keep a ref so it isn't freed

        const shape = new Ammo.btBvhTriangleMeshShape(triMesh, true, true);
        const transform = new Ammo.btTransform();
        transform.setIdentity();
        const motionState = new Ammo.btDefaultMotionState(transform);
        const localInertia = new Ammo.btVector3(0, 0, 0);
        const info = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, localInertia);
        const body = new Ammo.btRigidBody(info);
        body.setFriction(1);
        this.physicsWorld.addRigidBody(body);
        this.body = body;
        this.shape = shape;
    }

    Dispose(){
        if(this.mesh){ this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
        if(this.body && this.physicsWorld){ this.physicsWorld.removeRigidBody(this.body); }
    }
}

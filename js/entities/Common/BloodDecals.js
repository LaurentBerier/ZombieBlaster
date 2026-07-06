import * as THREE from 'three'
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js'
import Component from '../../Component.js'


// Pooled BLOOD DECALS truly PROJECTED onto enemy GEOMETRY where a bullet lands. A single instance lives
// on the Level entity; the enemy controllers fetch it on hit (FindEntity('Level').GetComponent(
// 'BloodDecals')) and call Splat() with the impact point + surface normal + the target's skinned mesh.
//
// Unlike a flat card stuck to a bone, each splat is a real DecalGeometry wrapped around the character's
// CURRENTLY-DEFORMED surface (so it conforms to the curvature and clips to the silhouette), then parented
// to the nearest bone so it rides the animation + ragdoll. THREE.DecalGeometry only projects against a
// static mesh in its current matrixWorld (it ignores skinning), so per hit we bake a small LOCAL PATCH of
// the deformed mesh — only the triangles near the impact, their vertices skinned to world via the rig's
// own boneTransform — and project onto that. Region-limiting is essential: projecting against the full
// ~41k-tri body costs ~90 ms; the local patch costs a few ms.
//
// Pools: a FIFO cap recycles the oldest decal (detached + geometry disposed) once `max` are live. Two
// shared materials (the two authored blood shapes, unlit + alpha-blended). Per-decal geometry is the only
// per-hit allocation that survives the call; the deform/patch scratch is reused.
//
// The source patch is hard-capped at MAX_PATCH_TRIS so the DecalGeometry cost (and its output vert count,
// and its garbage) stay bounded and consistent regardless of how dense the hit region is.
// The dense-mesh enemies no longer use this projection (they take the cheap flat-card path — see Splat
// opts.flat), so it serves the sparser beast; 700 keeps its DecalGeometry cost + garbage bounded.
const MAX_PATCH_TRIS = 700;

// Bones a blood decal must NOT anchor to: the finger/thumb chains gripping the weapon, the hand bones,
// the toe balls, and the twist/IK helper bones. They are tiny extremities (or non-deforming helpers) that
// can sit closest to a torso hit in the rifle pose, so anchoring there flings the decal off the body when
// the hand moves. The decal anchors to the nearest bone NOT matching this — the stable major skeleton.
const MINOR_BONE = /thumb|index|middle|ring|pinky|twist|^ik_|^hand_|^ball_/;

export default class BloodDecals extends Component{
    constructor(scene, tex1, tex2, { max = 6 } = {}){   // keep only the last ~6 impacts' decals — projecting onto the dense enemy mesh isn't free, so a small FIFO keeps the game playable (older blood recycles)
        super();
        this.name = 'BloodDecals';
        this.scene = scene;
        this.max = max;

        const mk = (tex) => new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4,
            toneMapped: false,
            side: THREE.DoubleSide,   // blood cards must read whichever way the body turns the hit-normal-facing quad
        });
        this.materials = [];
        if(tex1){ this.materials.push(mk(tex1)); }
        if(tex2){ this.materials.push(mk(tex2)); }

        this.pool = [];        // FIFO of live decal meshes (oldest first)

        // Shared unit quad for blood CARDS (the visible path on the dense enemy mesh — see Splat opts.flat).
        // One geometry for every card (they differ only by transform), so a card is ~free to build/recycle.
        this._cardGeo = new THREE.PlaneGeometry(1, 1);
        this._unitZ = new THREE.Vector3(0, 0, 1);

        // Reused projection scratch (no per-hit allocation beyond the kept decal geometry).
        this._pt = new THREE.Vector3();   // surface-inset projection centre (see _project)
        this._v1 = new THREE.Vector3();
        this._v2 = new THREE.Vector3();
        this._bp = new THREE.Vector3();
        this._zero = new THREE.Vector3(0, 0, 0);
        this._up = new THREE.Vector3(0, 1, 0);
        this._upAlt = new THREE.Vector3(1, 0, 0);
        this._n = new THREE.Vector3();
        this._m = new THREE.Matrix4();
        this._q = new THREE.Quaternion();
        this._qRoll = new THREE.Quaternion();
        this._euler = new THREE.Euler();
        this._size = new THREE.Vector3();
        this._near = new Set();
        this._cand = [];                                  // flat list of kept-triangle vertex indices
        this._parr = null;                                // reused patch position backing buffer (alloc on first use)
        this._narr = null;                                // reused patch normal placeholder buffer
        this._patchMesh = new THREE.Mesh();               // reused source for DecalGeometry (kept at identity)
        this._patchMesh.matrixAutoUpdate = false;         // matrixWorld stays identity: patch verts are already world
    }

    // Per-vertex DOMINANT bone index (the highest-weighted bone), computed once per geometry and cached.
    // Used to cheaply gather only the triangles belonging to body parts near the hit.
    _getDomBones(geo){
        if(geo.userData.__domBones){ return geo.userData.__domBones; }
        const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, N = si.count;
        const sia = si.array, swa = sw.array;             // raw typed arrays (itemSize 4) — far faster than getX/Y/Z/W
        const dom = new Uint16Array(N);
        for(let i = 0; i < N; i++){
            const o = i * 4;
            const w0 = swa[o], w1 = swa[o+1], w2 = swa[o+2], w3 = swa[o+3];
            let d = 0, best = w0;
            if(w1 > best){ d = 1; best = w1; }
            if(w2 > best){ d = 2; best = w2; }
            if(w3 > best){ d = 3; }
            dom[i] = sia[o + d];
        }
        geo.userData.__domBones = dom;
        return dom;
    }

    // Reused per-geometry deformed-vertex cache: a world-position buffer + a stamp array so each projection
    // lazily deforms only the vertices it touches (no full clear between hits).
    _defBuf(geo, N){
        let d = geo.userData.__defBuf;
        if(!d || d.buf.length < N * 3){
            d = { buf: new Float32Array(N * 3), stamp: new Int32Array(N), val: 0 };
            geo.userData.__defBuf = d;
        }
        return d;
    }

    // Per-bone triangle buckets (triangle index lists keyed by the triangle's majority dominant bone),
    // computed once per geometry. Lets a hit visit ONLY the triangles of the few bones near the impact
    // instead of scanning the whole (41k-tri) mesh every time — the key to keeping projection cheap.
    // Handles both indexed (the UE bodies) and non-indexed (the FBX beast) geometry.
    _getBoneTris(geo, dom){
        if(geo.userData.__boneTris){ return geo.userData.__boneTris; }
        const index = geo.index, arr = index ? index.array : null;
        const triCount = ((index ? index.count : geo.attributes.position.count) / 3) | 0;
        const triBone = new Int32Array(triCount);
        const counts = new Map();
        for(let t = 0; t < triCount; t++){
            const a = arr ? arr[t*3] : t*3, b = arr ? arr[t*3+1] : t*3+1, c = arr ? arr[t*3+2] : t*3+2;
            const da = dom[a], db = dom[b], dc = dom[c];
            const bone = (db === dc) ? db : da;            // majority of the 3 verts, else the first
            triBone[t] = bone;
            counts.set(bone, (counts.get(bone) || 0) + 1);
        }
        const lists = new Map(), fill = new Map();
        for(const [bone, n] of counts){ lists.set(bone, new Int32Array(n)); fill.set(bone, 0); }
        for(let t = 0; t < triCount; t++){
            const bone = triBone[t]; const f = fill.get(bone);
            lists.get(bone)[f] = t; fill.set(bone, f + 1);
        }
        geo.userData.__boneTris = lists;
        return lists;
    }

    // Build a DecalGeometry projected onto the deformed surface near `point`, or null if the hit isn't on
    // the mesh. Only triangles whose dominant bone sits near the hit AND whose centroid is within the decal
    // footprint are deformed + projected, keeping the cost to a small local patch.
    _project(M, point, normal, baseSize, anchorBone = null){
        const geo = M.geometry;
        const index = geo.index;                            // may be null (non-indexed FBX beast) — handled below
        const posN = geo.attributes.position.count;
        const dom = this._getDomBones(geo);

        // Refresh bone matrices only (the game loop already updated the model this frame). Do NOT call
        // M.updateMatrixWorld(true): the projected decals are parented to bones (descendants of the rig), so
        // a forced subtree traversal would re-walk every live decal — making each new projection slower than
        // the last (an O(decals) creep). skeleton.update() reads the bones' already-current world matrices.
        if(M.skeleton){ M.skeleton.update(); }

        // Find the nearest bone, then project against its ANATOMICAL neighbourhood (2 hops out through
        // parents + children). That bounds the work to one body region — not a world-radius sphere (which on
        // a dense torso pulls in half the skeleton) — while staying robust on rigs where the nearest bone
        // JOINT isn't the hit's skinning bone (e.g. the 2x beast, whose surface is far from its bones): the
        // skinning bone is reliably within a couple of anatomical hops. The footprint test does the tight cull.
        const bones = M.skeleton.bones;
        const boneTris = this._getBoneTris(geo, dom);
        this._near.clear();
        let nearest = -1, nearestSq = Infinity;
        for(let bi = 0; bi < bones.length; bi++){
            bones[bi].getWorldPosition(this._bp);
            const dq = this._bp.distanceToSquared(point);
            if(dq < nearestSq){ nearestSq = dq; nearest = bi; }
        }
        if(nearest < 0){ return null; }
        const addBone = (b) => { if(b && b.isBone){ const i = bones.indexOf(b); if(i >= 0){ this._near.add(i); } } };
        const addRing = (b, depth) => {
            if(!b || !b.isBone){ return; }
            addBone(b);
            if(depth <= 0){ return; }
            addRing(b.parent, depth - 1);
            for(const ch of b.children){ addRing(ch, depth - 1); }
        };

        // Projector normal (the bullet's surface normal), normalized — used both to orient the decal and to
        // FRONT-FACE cull the patch (so blood never lands on the far side of a thin limb).
        this._n.copy(normal);
        if(this._n.lengthSq() < 1e-6){ this._n.copy(this._up); }
        this._n.normalize();
        const nx = this._n.x, ny = this._n.y, nz = this._n.z;

        // Project from the body SURFACE, not the hit-SPHERE surface (the bullet point sits a few cm proud of
        // the skin), so the decal lands ON the mesh instead of in front of it. Only when the hit bone is known
        // (the soldier) — the beast's projection is unchanged.
        if(anchorBone && anchorBone.isBone){ point = this._pt.copy(point).addScaledVector(this._n, -0.06); }

        // Lazily deform candidate vertices to world; gather triangles (from the near bones' buckets ONLY)
        // that sit within the footprint AND face the bullet.
        const def = this._defBuf(geo, posN);
        const stamp = ++def.val, buf = def.buf, st = def.stamp;
        const v = this._v2, mw = M.matrixWorld;
        const deform = (i) => {
            if(st[i] !== stamp){
                M.boneTransform(i, v); v.applyMatrix4(mw);
                buf[i*3] = v.x; buf[i*3+1] = v.y; buf[i*3+2] = v.z; st[i] = stamp;
            }
        };
        const idx = index ? index.array : null;            // null => non-indexed (vertex index == t*3 + corner)
        const cand = this._cand; cand.length = 0;
        const footSq = (baseSize * 1.05) * (baseSize * 1.05);   // tight: ~the decal box, so the patch stays lean
        const maxCand = MAX_PATCH_TRIS * 3;                     // hard cap so DecalGeometry stays cheap + consistent
        const px = point.x, py = point.y, pz = point.z;
        // Gather the patch from the hit bone's anatomical RING (or the nearest joint's, with no anchor). 1 hop
        // is cheap; 2 hops is the fallback for rigs whose nearest bone JOINT isn't the hit's skinning bone (the
        // 2x beast). Anchoring on the supplied hit bone is the key to a cheap projection on the DENSE enemy mesh:
        // each bone's triangle bucket is small (a few hundred tris), so the deform stays bounded — whereas a
        // spatial "every bone under the footprint" scan deformed ~15k tris/hit (~20 ms). PASS 0 keeps only
        // FRONT-facing tris (no blood on the far side of a thin limb); PASS 1 drops that test so a legitimate
        // hit whose capsule normal disagrees with the local faces still gets a decal. Stop at the first hit.
        // The front-face test is SOFTENED for the anchored (enemy) case: a STRICT >90° cull keeps only the
        // sliver of chest pointing straight at the bullet (the curved torso falls away fast), so the decal was
        // a tiny faint speck. Keeping faces within ~114° lets the decal WRAP the chest's curve (front + sides)
        // — much more visible — while the shallow box depth still clips the far back. Beast stays strict.
        const cullDot = (anchorBone && anchorBone.isBone) ? -0.42 : 0;
        ring:
        for(let ring = 1; ring <= 2; ring++){
            this._near.clear();
            addRing(anchorBone && anchorBone.isBone ? anchorBone : bones[nearest], ring);
            for(let pass = 0; pass < 2; pass++){
                cand.length = 0;
                const frontOnly = pass === 0;
                for(const bi of this._near){
                    const list = boneTris.get(bi);
                    if(!list){ continue; }
                    for(let li = 0; li < list.length; li++){
                        const t = list[li];
                        const a = idx ? idx[t*3] : t*3, b = idx ? idx[t*3+1] : t*3+1, c = idx ? idx[t*3+2] : t*3+2;
                        deform(a); deform(b); deform(c);
                        const ax = buf[a*3], ay = buf[a*3+1], az = buf[a*3+2];
                        const bx = buf[b*3], by = buf[b*3+1], bz = buf[b*3+2];
                        const cx2 = buf[c*3], cy2 = buf[c*3+1], cz2 = buf[c*3+2];
                        const mx = (ax + bx + cx2) / 3, my = (ay + by + cy2) / 3, mz = (az + bz + cz2) / 3;
                        const dsq = (mx-px)*(mx-px) + (my-py)*(my-py) + (mz-pz)*(mz-pz);
                        if(dsq > footSq){ continue; }
                        if(frontOnly){
                            const e1x = bx-ax, e1y = by-ay, e1z = bz-az, e2x = cx2-ax, e2y = cy2-ay, e2z = cz2-az;
                            const fnx = e1y*e2z - e1z*e2y, fny = e1z*e2x - e1x*e2z, fnz = e1x*e2y - e1y*e2x;
                            const fd = fnx*nx + fny*ny + fnz*nz;
                            // cos(angle) = fd / |fn|; reject faces turned more than the cull threshold from the bullet.
                            if(fd <= cullDot * Math.sqrt(fnx*fnx + fny*fny + fnz*fnz)){ continue; }
                        }
                        cand.push(a, b, c);
                        if(cand.length >= maxCand){ break; }
                    }
                    if(cand.length >= maxCand){ break; }
                }
                if(cand.length > 0){ break ring; }
            }
        }
        if(cand.length === 0){ return null; }

        // Patch geometry (non-indexed, deformed WORLD positions) into REUSED backing buffers (the per-hit
        // Float32Arrays were a big GC source). DecalGeometry requires a `normal` attribute on its source —
        // but it only COPIES them onto the decal verts (unused by the unlit decal material), so a constant
        // placeholder normal is fine and saves a computeVertexNormals pass.
        if(!this._parr){
            this._parr = new Float32Array(maxCand * 3);
            this._narr = new Float32Array(maxCand * 3);
            for(let i = 2; i < this._narr.length; i += 3){ this._narr[i] = 1; }   // (0,0,1) placeholder
        }
        const parr = this._parr;
        for(let k = 0; k < cand.length; k++){
            const vi = cand[k];
            parr[k*3] = buf[vi*3]; parr[k*3+1] = buf[vi*3+1]; parr[k*3+2] = buf[vi*3+2];
        }
        const n3 = cand.length * 3;
        const patch = new THREE.BufferGeometry();
        patch.setAttribute('position', new THREE.BufferAttribute(parr.subarray(0, n3), 3));
        patch.setAttribute('normal', new THREE.BufferAttribute(this._narr.subarray(0, n3), 3));
        this._patchMesh.geometry = patch;

        // Orientation: project along the surface normal (+ a random roll about it) — matches BulletDecals.
        // (this._n was normalized above for the front-face cull.)
        const upRef = Math.abs(this._n.dot(this._up)) > 0.97 ? this._upAlt : this._up;
        this._m.lookAt(this._zero, this._n, upRef);
        this._q.setFromRotationMatrix(this._m);
        this._qRoll.setFromAxisAngle(this._n, Math.random() * Math.PI * 2);
        this._q.premultiply(this._qRoll);
        this._euler.setFromQuaternion(this._q);

        const aspect = 0.8 + Math.random() * 0.5;
        // w, h, and a SHALLOW projection depth: deep enough to wrap the local curvature but not punch through
        // to the far side of a limb (the front-face cull above already drops back-facing tris).
        this._size.set(baseSize * aspect, baseSize, baseSize * 0.8);
        let decalGeo = null;
        try{ decalGeo = new DecalGeometry(this._patchMesh, point, this._euler, this._size); }
        catch(e){ decalGeo = null; }
        patch.dispose();
        this._patchMesh.geometry = null;
        if(!decalGeo || !decalGeo.attributes.position || decalGeo.attributes.position.count === 0){
            if(decalGeo){ decalGeo.dispose(); }
            return null;
        }
        // FALLBACK attach bone (used when the caller doesn't supply the exact hit bone — e.g. the beast):
        // the nearest MAJOR bone to an INSET reference point, NOT the nearest joint to the raw hit. Two things
        // break a naive nearest-joint pick on the rifle-holding enemy: (1) the closest joints to a torso hit
        // are the FINGERS/THUMB/hands gripping the gun (+ IK/twist helpers), and (2) the bullet lands on the
        // hit SPHERE's surface, ~its radius (up to 0.20 m) IN FRONT of the body — where the support FOREARM
        // crosses the chest. Either way the decal would ride an arm/hand and be flung off the body when it
        // moved. So: skip the finger/hand/twist/IK helpers (MINOR_BONE) and push the reference INWARD along
        // the normal past the arms to the bone that owns the surface. (The soldier path supplies the exact
        // hit-sphere bone via Splat's opts.bone, which is preferred over this — see UeSoldierController.)
        this._v1.copy(point).addScaledVector(this._n, -0.18);   // _n = unit surface normal (points outward);
        // 0.18 m ≈ the deepest hit-sphere radius, so a torso hit's reference lands back on the spine (behind
        // the support forearm that crosses the chest in the aim pose) rather than on that forearm.
        let attachBone = null, attachSq = Infinity;
        for(let bi = 0; bi < bones.length; bi++){
            if(MINOR_BONE.test(bones[bi].name)){ continue; }
            bones[bi].getWorldPosition(this._bp);
            const dq = this._bp.distanceToSquared(this._v1);
            if(dq < attachSq){ attachSq = dq; attachBone = bones[bi]; }
        }
        if(!attachBone){ attachBone = bones[nearest] || null; }
        return { geo: decalGeo, bone: attachBone };
    }

    // Stamp a blood decal at world `point`, facing `normal`, on the body that owns `skinnedMesh`.
    //   opts.size  : footprint (m).
    //   opts.bone  : the EXACT bone the bullet struck. The decal rides it (the soldier passes its hit-sphere's
    //                bone; see UeSoldierController) so the blood stays planted as the body animates.
    //   opts.flat  : stamp a flat CARD (a textured quad) instead of a projected decal. On the dense, curved
    //                enemy mesh a true projection only captures the narrow head-on strip (~3% fill) so it's a
    //                faint speck — invisible at combat range. A card is full-coverage so it reads at any range;
    //                the caller sizes it to the hit body part (UeSoldierController scales by the hit-sphere
    //                radius) so it hugs the part without overhanging the silhouette. Requires opts.bone.
    // No-op if the mesh is missing or (projection path) the hit doesn't land on the geometry.
    Splat(point, normal, skinnedMesh, opts = {}){
        if(!skinnedMesh || !skinnedMesh.skeleton || !this.materials.length){ return; }
        const baseSize = opts.size ?? (0.12 + Math.random() * 0.12);
        const mat = this.materials[(Math.random() * this.materials.length) | 0];
        let mesh, attachBone;

        if(opts.flat && opts.bone){
            this._n.copy(normal); if(this._n.lengthSq() < 1e-6){ this._n.copy(this._up); } this._n.normalize();
            mesh = new THREE.Mesh(this._cardGeo, mat);
            mesh.userData.sharedGeo = true;                              // never dispose the shared quad on recycle
            mesh.position.copy(point).addScaledVector(this._n, -0.04);   // nestle onto the skin (hit sits proud on the sphere)
            mesh.quaternion.setFromUnitVectors(this._unitZ, this._n);    // quad faces outward along the bullet normal
            this._qRoll.setFromAxisAngle(this._n, Math.random() * Math.PI * 2);
            mesh.quaternion.premultiply(this._qRoll);                    // random roll for variety
            const aspect = 0.85 + Math.random() * 0.4;
            mesh.scale.set(baseSize * aspect, baseSize, 1);
            attachBone = opts.bone;
        }else{
            const projected = this._project(skinnedMesh, point, normal, baseSize, opts.bone || null);
            if(!projected){ return; }
            mesh = new THREE.Mesh(projected.geo, mat);   // decal verts are in WORLD space, wrapped on the body
            attachBone = opts.bone || projected.bone;
        }

        mesh.renderOrder = 999;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        // Ride the body part, preserving the world transform so the blood stays planted as the body animates.
        if(attachBone){ mesh.updateMatrix(); attachBone.attach(mesh); }

        this.pool.push(mesh);
        while(this.pool.length > this.max){
            const old = this.pool.shift();
            if(old.parent){ old.parent.remove(old); }
            if(old.geometry && !old.userData.sharedGeo){ old.geometry.dispose(); }
        }
    }

    // Run a few throwaway projections at load (behind the loading screen) so the cold V8 JIT cost of the
    // projection path + DecalGeometry — ~1.5 s spread over the first few calls — is paid HERE instead of as
    // a hitch on the first enemy shot in combat. Pass any one enemy skinned mesh (its geometry warms the
    // shared code paths; other rigs only pay their tiny one-time per-geometry bucket precompute on first hit).
    Prewarm(skinnedMesh){
        const geo = skinnedMesh && skinnedMesh.geometry;
        if(!skinnedMesh || !skinnedMesh.skeleton || !geo || !geo.attributes.position || !geo.attributes.normal){ return; }
        try{
            skinnedMesh.updateMatrixWorld(true);
            skinnedMesh.skeleton.update();
            const N = geo.attributes.position.count, normAttr = geo.attributes.normal;
            const v = this._v1, n = this._n;
            // Walk sample vertices, projecting at each with its OWN (deformed) surface normal so the patch +
            // DecalGeometry path actually runs (an outward GUESS can front-face-cull to nothing). Stop once a
            // few real projections have compiled the path.
            let warmed = 0;
            for(let k = 0; k < 16 && warmed < 4; k++){
                const i = Math.min(N - 1, Math.floor(N * (0.05 + 0.06 * k)));
                skinnedMesh.boneTransform(i, v); v.applyMatrix4(skinnedMesh.matrixWorld);   // surface point (world)
                n.fromBufferAttribute(normAttr, i).transformDirection(skinnedMesh.matrixWorld);
                if(n.lengthSq() < 1e-6){ n.set(0, 0, 1); }
                const r = this._project(skinnedMesh, v, n, 0.16);
                if(r && r.geo){ r.geo.dispose(); warmed++; }
            }
        }catch(e){ /* warmup is best-effort */ }
    }

    Dispose(){
        for(const m of this.pool){
            if(m.parent){ m.parent.remove(m); }
            if(m.geometry){ m.geometry.dispose(); }
        }
        this.pool.length = 0;
        for(const mat of this.materials){ mat.dispose(); }
    }
}

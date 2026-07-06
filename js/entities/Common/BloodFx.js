import * as THREE from 'three'
import Component from '../../Component.js'


// Pooled blood-splatter burst, shared by every combatant. A single instance lives on the Level entity;
// the enemy controllers and PlayerHealth fetch it (FindEntity('Level').GetComponent('BloodFx')) and call
// Emit() at the bullet's hit point when something takes a ranged hit.
//
// AAA layered impact: the HERO element is an authored 8-frame blood-splash SPRITESHEET (Blood_SpriteSheet
// .png) — a camera-facing card that plays the splash forming + dissipating over its short life — backed by
// a secondary fine droplet MIST (the old procedural specks, slimmed) for spray detail. Together they read
// far richer than the old generic dot burst, which this replaces.
//
// Memory note: the source sheet is huge (~13k px wide). It is downscaled ONCE into a single shared texture
// (one GPU upload), and each splash card is a cheap Mesh that selects its current frame via its OWN geometry
// UVs (not a per-card texture clone — that would re-upload the sheet N times) with its OWN material (so each
// card fades independently). Pools are fixed ring buffers: a burst that outruns a pool recycles its oldest
// entry — no unbounded growth, and nothing to dispose beyond the meshes/sprites.
const FRAMES = 8;                       // horizontal frames in the spritesheet
const SHEET_W = 4096;                   // downscaled sheet width (8 frames => 512 px each — ample at runtime sizes)

export default class BloodFx extends Component{
    constructor(scene, camera, splashTexture, { splashPool = 20, dropletPool = 80 } = {}){
        super();
        this.name = 'BloodFx';
        this.scene = scene;
        this.camera = camera;
        this.gravity = -11.0;                 // droplets arc and fall

        // ---- Hero: spritesheet splash cards ----
        this.splashTex = this._prepareSheet(splashTexture);   // shared, downscaled (one GPU upload)
        this.splashAspect = 1 / (FRAMES * (this.splashTex.image.height / this.splashTex.image.width)); // frame w/h
        this.splashes = [];
        this.splashCursor = 0;
        for(let i = 0; i < splashPool; i++){
            const geom = new THREE.PlaneGeometry(1, 1);   // UVs are rewritten per frame (see _setFrameUVs)
            const mat = new THREE.MeshBasicMaterial({
                map: this.splashTex,
                transparent: true,
                depthWrite: false,
                depthTest: true,
                opacity: 0,
                toneMapped: false,         // keep the arterial red punchy under the Reinhard tonemap
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.visible = false;
            mesh.frustumCulled = false;    // billboarded — its bounds rotate every frame
            mesh.renderOrder = 997;
            this.scene.add(mesh);
            this.splashes.push({ mesh, mat, geom, life: 0, maxLife: 1, size: 0.5, roll: 0, spin: 0, frame: -1, vel: new THREE.Vector3() });
        }

        // ---- Secondary: fine droplet mist ----
        this.texture = this._makeTexture();
        this.pool = [];
        this.cursor = 0;
        for(let i = 0; i < dropletPool; i++){
            const mat = new THREE.SpriteMaterial({
                map: this.texture,
                color: 0x8a0008,             // dark arterial red
                transparent: true,
                depthWrite: false,
                toneMapped: false,
                opacity: 0,
            });
            const sprite = new THREE.Sprite(mat);
            sprite.visible = false;
            sprite.scale.setScalar(0.1);
            sprite.renderOrder = 998;
            this.scene.add(sprite);
            this.pool.push({ sprite, life: 0, maxLife: 1, size: 0.1, grow: 0, vel: new THREE.Vector3() });
        }

        this._dir = new THREE.Vector3();
        this._rnd = new THREE.Vector3();
        this._qRoll = new THREE.Quaternion();
        this._zAxis = new THREE.Vector3(0, 0, 1);
    }

    // Downscale the (very large) source sheet onto a single shared CanvasTexture — one GPU upload that
    // every splash card samples. Clamp wrap so a frame's UV window never bleeds its neighbour. Falls back
    // to a 1x1 transparent texture if the source didn't load (the splash then silently no-ops).
    _prepareSheet(tex){
        const img = tex && tex.image;
        const canvas = document.createElement('canvas');
        if(img && img.width){
            canvas.width = SHEET_W;
            canvas.height = Math.max(1, Math.round(SHEET_W * img.height / img.width));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }else{
            canvas.width = canvas.height = 1;
        }
        const t = new THREE.CanvasTexture(canvas);
        t.encoding = THREE.sRGBEncoding;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.needsUpdate = true;
        return t;
    }

    // Point a 4-vertex plane's UVs at frame `f` of the horizontal strip. Vertex order for
    // PlaneGeometry(1,1): v0=TL(0,1) v1=TR(1,1) v2=BL(0,0) v3=BR(1,0).
    _setFrameUVs(geom, f){
        const u0 = f / FRAMES, u1 = (f + 1) / FRAMES;
        const uv = geom.attributes.uv;
        uv.setXY(0, u0, 1); uv.setXY(1, u1, 1); uv.setXY(2, u0, 0); uv.setXY(3, u1, 0);
        uv.needsUpdate = true;
    }

    // Crisp round droplet for the secondary mist: a near-SOLID white core (the sprite material tints it
    // red) with only a thin soft edge, so it reads as a sharp blood speck rather than a blurry blob.
    _makeTexture(){
        const s = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = s;
        const ctx = canvas.getContext('2d');
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0.0, 'rgba(255,255,255,1)');
        g.addColorStop(0.72, 'rgba(255,255,255,1)');
        g.addColorStop(0.9, 'rgba(255,255,255,0.65)');
        g.addColorStop(1.0, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
        ctx.fill();
        const tex = new THREE.CanvasTexture(canvas);
        return tex;
    }

    // Spray a burst from world-space `point`, biased along `dir` (the bullet's travel direction). Spawns
    // the hero spritesheet splash card(s) AND a fine droplet mist. `opts.scale` sizes it for big targets.
    Emit(point, dir = null, opts = {}){
        const scale = opts.scale ?? 1.0;

        // ---- hero splash card(s) ----
        const splashCount = opts.splashCount ?? 1;
        for(let i = 0; i < splashCount; i++){
            const p = this.splashes[this.splashCursor];
            this.splashCursor = (this.splashCursor + 1) % this.splashes.length;
            p.life = (opts.splashLife ?? 0.46) * (0.85 + Math.random() * 0.3);
            p.maxLife = p.life;
            p.size = (opts.splashSize ?? 0.62) * scale * (0.8 + Math.random() * 0.45);   // metres (frame height)
            p.roll = Math.random() * Math.PI * 2;
            p.spin = (Math.random() * 2 - 1) * 1.1;       // gentle in-plane rotational drift
            p.frame = -1;
            // gentle outward drift along the bullet dir + a small up pop, so the splash isn't dead-static.
            p.vel.set(0, 0, 0);
            if(dir && dir.lengthSq() > 1e-6){ p.vel.copy(dir).normalize().multiplyScalar(0.7 * scale); }
            p.vel.y += 0.35;
            p.mesh.position.copy(point);
            this._setFrameUVs(p.geom, 0);
            p.mat.opacity = 1;
            p.mesh.visible = true;
        }

        // ---- secondary droplet mist: a FINE, short-lived spray (the spritesheet splash is the star now,
        // so this is just spray detail, not the old round-dot burst the user asked us to replace) ----
        const count = Math.round((opts.count ?? 14) * 0.4);
        const speed = opts.speed ?? 3.4;
        const spread = opts.spread ?? 0.85;
        const life = opts.life ?? 0.42;

        const base = this._dir;
        if(dir && dir.lengthSq() > 1e-6){ base.copy(dir).normalize(); }
        else{ base.set(0, 0, 0); }

        for(let i = 0; i < count; i++){
            const p = this.pool[this.cursor];
            this.cursor = (this.cursor + 1) % this.pool.length;

            this._rnd.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
            if(this._rnd.lengthSq() < 1e-6){ this._rnd.set(0, 1, 0); }
            this._rnd.normalize().multiplyScalar(spread).add(base);
            if(this._rnd.lengthSq() < 1e-6){ this._rnd.set(0, 1, 0); }
            this._rnd.normalize();

            p.vel.copy(this._rnd).multiplyScalar(speed * (0.45 + Math.random() * 0.85));
            p.vel.y += 1.4 + Math.random() * 0.8;

            p.life = life * (0.5 + Math.random() * 0.5);
            p.maxLife = p.life;
            p.size = (0.01 + Math.random() * 0.02) * scale;     // finer specks
            p.grow = (0.015 + Math.random() * 0.03) * scale;    // barely grow (no fat round blobs)

            const sp = p.sprite;
            sp.position.copy(point);
            sp.scale.setScalar(p.size);
            sp.material.opacity = 0.95;
            sp.visible = true;
        }
    }

    Update(t){
        if(t > 0.1){ t = 0.1; }           // clamp a hitch so particles don't teleport

        // --- hero splash cards: advance the spritesheet frame, billboard, fade ---
        for(const p of this.splashes){
            if(!p.mesh.visible){ continue; }
            p.life -= t;
            if(p.life <= 0){ p.mesh.visible = false; p.mat.opacity = 0; continue; }
            const prog = 1 - p.life / p.maxLife;                     // 0 -> 1 over life
            const frame = Math.min(FRAMES - 1, Math.floor(prog * FRAMES));
            if(frame !== p.frame){ p.frame = frame; this._setFrameUVs(p.geom, frame); }
            p.vel.y += this.gravity * 0.25 * t;                     // a touch of gravity
            p.mesh.position.addScaledVector(p.vel, t);
            p.roll += p.spin * t;
            this._qRoll.setFromAxisAngle(this._zAxis, p.roll);
            p.mesh.quaternion.copy(this.camera.quaternion).multiply(this._qRoll);   // camera-facing billboard + roll
            const s = p.size * (1 + prog * 0.22);                   // bloom slightly as it sprays
            p.mesh.scale.set(s * this.splashAspect, s, 1);
            p.mat.opacity = prog < 0.72 ? 1 : Math.max(0, 1 - (prog - 0.72) / 0.28);
        }

        // --- secondary droplet mist ---
        for(const p of this.pool){
            const sp = p.sprite;
            if(!sp.visible){ continue; }
            p.life -= t;
            if(p.life <= 0){ sp.visible = false; sp.material.opacity = 0; continue; }
            p.vel.y += this.gravity * t;
            sp.position.addScaledVector(p.vel, t);
            const k = p.life / p.maxLife;
            sp.material.opacity = Math.min(1, k * 1.5);
            sp.scale.setScalar(p.size + (1 - k) * p.grow);
        }
    }

    Dispose(){
        for(const p of this.splashes){
            this.scene.remove(p.mesh);
            p.mesh.material.dispose();
            p.mesh.geometry.dispose();
        }
        for(const p of this.pool){
            this.scene.remove(p.sprite);
            p.sprite.material.dispose();
        }
        this.splashTex.dispose();
        this.texture.dispose();
        this.splashes.length = 0;
        this.pool.length = 0;
    }
}

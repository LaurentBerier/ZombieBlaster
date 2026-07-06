import * as THREE from 'three'
import { AmmoHelper, CollisionFilterGroups } from '../../AmmoLib.js'


// A dropped weapon's physics. When an armed enemy dies its gun is no longer glued to the hand — it
// falls out of the grip, tumbles, bounces off the floor and settles. The body itself is a verlet
// ragdoll (Ragdoll.js); the gun is one rigid object, so it gets its OWN tiny rigid-body integrator
// here rather than being forced into the particle network.
//
// It's a compact single-body solver: linear velocity + gravity for the fall, a quaternion angular
// velocity for the tumble, and CONTACT POINTS sampled along the gun's long axis so it lands on its
// ends and rotates toward lying flat (a single centre sphere would just hover and never settle in a
// believable pose). Each contact applies a sequential impulse (bounce + friction) at its lever arm,
// which couples linear and angular motion exactly like a real dropped object. Walls/props are a
// cheaper centre sphere-sweep. It collides with the SAME static level the ragdoll does (Ammo
// sweeps/rays), so the gun never clips through the world, and sleeps once it comes to rest.
//
// Drop-in: build it from the (already world-placed) weapon Object3D on death and call update(dt)
// each frame. Guarded by the caller so a build/sim failure simply leaves the gun where it fell.
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _r = new THREE.Vector3();        // contact lever arm (point - COM)
const _pt = new THREE.Vector3();       // world contact-sample point
const _pv = new THREE.Vector3();       // velocity at the contact point
const _n = new THREE.Vector3();        // contact normal
const _jn = new THREE.Vector3();       // impulse vector
const _spin = new THREE.Quaternion();  // per-step angular-velocity quaternion
const _down = new THREE.Vector3();     // floor down-ray end

export default class DroppedWeapon{
    // object       : the weapon Object3D, ALREADY reparented into the scene at its world transform
    //                (THREE.Object3D.attach), so its local transform is its world transform.
    // options:
    //   physicsWorld : Ammo dynamics world for level collision (null => a flat groundY plane).
    //   groundY      : fallback floor height where the down-ray finds nothing.
    //   velocity     : initial linear velocity (m/s) — the toss out of the hand.
    //   angularVelocity : initial angular velocity (rad/s) — the tumble.
    //   gravity      : downward accel (default matches the ragdoll's exaggerated -22).
    constructor(object, { physicsWorld = null, groundY = 0, velocity = null, angularVelocity = null, gravity = -22.0 } = {}){
        this.object = object;
        this.physicsWorld = physicsWorld;
        this.groundY = groundY;
        this.gravity = gravity;
        this.vel = velocity ? velocity.clone() : new THREE.Vector3();
        this.angVel = angularVelocity ? angularVelocity.clone() : new THREE.Vector3();

        this.restitution = 0.42;       // bounce off the floor
        // Below this into-floor speed the bounce is dropped to 0, so a gun coming to rest stops
        // micro-bouncing on gravity's per-frame nudge and actually settles (and sleeps). Fast impacts
        // are well above it and still bounce. Mirrors the ragdoll's resting-contact handling.
        this.restThreshold = 0.35;
        this.friction = 0.55;          // tangential speed bled per contact (slide/scrape)
        this.linearDamping = 0.995;    // light air drag
        this.angularDamping = 0.97;    // tumble bleeds off over time so it settles
        this.substeps = 3;             // contact stability at the fast fall

        // Dimensions in WORLD space, so they're real metres regardless of the gun's scale chain (the
        // in-hand pivot carries a large normalising scale — measuring in its LOCAL frame gave a
        // metres-wide collision radius that launched the gun skyward). The long-axis DIRECTION is taken
        // from a LOCAL bbox (direction is scale-invariant); the LENGTH/THICKNESS from a WORLD bbox.
        object.updateWorldMatrix(true, false);
        const worldBox = new THREE.Box3().setFromObject(object);
        const wsize = worldBox.getSize(_v);
        this.worldHalf = (Math.max(wsize.x, wsize.y, wsize.z) * 0.5) || 0.35;   // half the gun's length (m)
        this.radius = Math.max(0.03, Math.min(wsize.x, wsize.y, wsize.z) * 0.5 + 0.015);  // half-thickness (m)

        const toLocal = new THREE.Matrix4().copy(object.matrixWorld).invert();
        const lbox = new THREE.Box3();
        const corner = new THREE.Vector3();
        let any = false;
        object.traverse(o => {
            if(!o.isMesh || !o.geometry){ return; }
            o.geometry.computeBoundingBox();
            const bb = o.geometry.boundingBox;
            for(let i = 0; i < 8; i++){
                corner.set((i & 1) ? bb.max.x : bb.min.x, (i & 2) ? bb.max.y : bb.min.y, (i & 4) ? bb.max.z : bb.min.z);
                corner.applyMatrix4(o.matrixWorld).applyMatrix4(toLocal);
                lbox.expandByPoint(corner);
                any = true;
            }
        });
        const lsize = any ? lbox.getSize(_v2) : _v2.set(1, 0.1, 0.1);
        const axisName = (lsize.x >= lsize.y && lsize.x >= lsize.z) ? 'x' : (lsize.y >= lsize.z ? 'y' : 'z');
        this.localAxis = new THREE.Vector3(axisName === 'x' ? 1 : 0, axisName === 'y' ? 1 : 0, axisName === 'z' ? 1 : 0);
        // Contact samples = signed distances along the WORLD long axis through the COM (pivot origin ≈
        // the gun's bbox centre): the two ends + the centre, so the gun lands on an end and rolls flat.
        this.samples = [this.worldHalf, -this.worldHalf, 0];

        // Isotropic inverse inertia (thin-rod-ish, world units). Scalar keeps the impulse solve simple
        // and stable; a small gun's tumble doesn't need a full inertia tensor.
        const inertia = Math.max(1e-3, this.worldHalf * this.worldHalf * 0.5);
        this.invInertia = 1 / inertia;

        this._mask = CollisionFilterGroups.StaticFilter;
        this._sweep = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };
        this._ray = new THREE.Vector3();
        this._prevPos = object.position.clone();   // for the wall sweep's start

        // Settle / sleep.
        this._still = 0;
        this.sleepDwell = 0.5;
        this.sleepLinSq = 0.02 * 0.02;     // m/s² threshold
        this.sleepAngSq = 0.4 * 0.4;       // rad/s² threshold
        this._asleep = false;
    }

    update(dt){
        if(this._asleep || !this.object){ return; }
        const obj = this.object;
        this._prevPos.copy(obj.position);
        const h = Math.max(1e-3, Math.min(1 / 30, dt)) / this.substeps;
        for(let s = 0; s < this.substeps; s++){ this._step(h); }

        // Walls / props: a single centre sphere-sweep across the frame's motion, bouncing off the
        // surface normal (the floor is handled per-contact-point in _step for a flat landing).
        if(this.physicsWorld){
            _v.copy(obj.position).sub(this._prevPos);
            if(_v.lengthSq() > 1e-7 && AmmoHelper.SphereSweep(
                this.physicsWorld, this.radius, this._prevPos, obj.position, this._sweep, this._mask)
                && this._sweep.fraction < 1 && this._sweep.normal.lengthSq() > 1e-6){
                _n.copy(this._sweep.normal).normalize();
                obj.position.copy(this._sweep.point).addScaledVector(_n, this.radius + 0.01);
                const vn = this.vel.dot(_n);
                if(vn < 0){ this.vel.addScaledVector(_n, -(1 + this.restitution) * vn); }
            }
        }

        // Sleep once both motions die out for a short dwell (stops the per-frame Ammo queries).
        if(this.vel.lengthSq() < this.sleepLinSq && this.angVel.lengthSq() < this.sleepAngSq){
            this._still += dt;
            if(this._still >= this.sleepDwell){ this._asleep = true; this.angVel.set(0, 0, 0); }
        }else{
            this._still = 0;
        }
    }

    _step(dt){
        const obj = this.object;
        // Integrate linear motion (gravity + drag).
        this.vel.y += this.gravity * dt;
        this.vel.multiplyScalar(this.linearDamping);
        obj.position.addScaledVector(this.vel, dt);

        // Integrate orientation from the angular velocity: q += 0.5 * (0,w) * q * dt.
        this.angVel.multiplyScalar(this.angularDamping);
        _spin.set(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, 0).multiply(obj.quaternion);
        obj.quaternion.x += 0.5 * _spin.x;
        obj.quaternion.y += 0.5 * _spin.y;
        obj.quaternion.z += 0.5 * _spin.z;
        obj.quaternion.w += 0.5 * _spin.w;
        obj.quaternion.normalize();

        // Floor contacts at each sample point: keep it above the ground and resolve a bounce+friction
        // impulse at the point's lever arm, which rotates the gun toward lying flat as an end digs in.
        for(const s of this.samples){
            // World sample point = COM + (worldAxisDir * signed distance along the gun).
            _pt.copy(this.localAxis).applyQuaternion(obj.quaternion).multiplyScalar(s).add(obj.position);
            let floorY = this.groundY;
            if(this.physicsWorld){
                _v.copy(_pt); _v.y += 0.4;
                _down.copy(_pt); _down.y -= 3.0;
                const info = { intersectionPoint: this._ray };
                if(AmmoHelper.CastRay(this.physicsWorld, _v, _down, info, this._mask)){ floorY = this._ray.y; }
            }
            const minY = floorY + this.radius;
            if(_pt.y >= minY){ continue; }

            // Positional correction: lift the whole gun so this point rests on the floor.
            obj.position.y += (minY - _pt.y);

            // Velocity of the contact point = linear + angular×r.
            _r.copy(_pt).setY(minY).sub(obj.position);
            _pv.copy(this.angVel).cross(_r).add(this.vel);
            const vn = _pv.y;                         // floor normal is +Y
            if(vn >= 0){ continue; }                  // moving away — no impulse

            // Normal impulse (bounce). denom = invMass + invInertia*|r×n|², n=+Y => |r×n|² = rx²+rz².
            // Drop restitution at low into-floor speed so a resting gun settles instead of micro-bouncing.
            _n.set(0, 1, 0);
            const e = (-vn < this.restThreshold) ? 0 : this.restitution;
            const rCrossN = _r.x * _r.x + _r.z * _r.z;
            const denom = 1 + this.invInertia * rCrossN;
            const jn = -(1 + e) * vn / denom;
            _jn.set(0, jn, 0);
            this.vel.addScaledVector(_jn, 1);
            _v.copy(_r).cross(_jn).multiplyScalar(this.invInertia);   // r × J
            this.angVel.add(_v);

            // Tangential friction impulse opposing the along-floor slide at the point.
            _pv.copy(this.angVel).cross(_r).add(this.vel);
            _v.set(_pv.x, 0, _pv.z);                  // tangential point velocity
            const vt = _v.length();
            if(vt > 1e-4){
                _v.multiplyScalar(1 / vt);
                const jtMax = Math.abs(jn) * this.friction;
                const jt = Math.min(vt / denom, jtMax);
                _jn.copy(_v).multiplyScalar(-jt);
                this.vel.addScaledVector(_jn, 1);
                _v2.copy(_r).cross(_jn).multiplyScalar(this.invInertia);
                this.angVel.add(_v2);
            }
        }
    }

    dispose(){
        if(this.object && this.object.parent){ this.object.parent.remove(this.object); }
        this.object = null;
    }
}

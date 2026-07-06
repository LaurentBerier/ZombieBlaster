import * as THREE from 'three'
import {ConvexHull} from 'three/examples/jsm/math/ConvexHull.js'

let Ammo = null;
let rayOrigin = null;
let rayDest = null;
let closestRayResultCallback = null;

// Reused objects for SphereSweep (a convex sweep of a sphere — a "thick raycast").
let sweepShape = null;
let sweepRadius = 0;
let sweepFromT = null;
let sweepToT = null;
let sweepFromV = null;
let sweepToV = null;
let convexResultCallback = null;

const CollisionFlags = { CF_NO_CONTACT_RESPONSE: 4 }
const CollisionFilterGroups = { 
  DefaultFilter: 1,
  StaticFilter: 2,
  KinematicFilter: 4,
  DebrisFilter: 8,
  SensorTrigger: 16,
  CharacterFilter: 32,
  AllFilter: -1 //all bits sets: DefaultFilter | StaticFilter | KinematicFilter | DebrisFilter | SensorTrigger
};

function createConvexHullShape(object) {
    const geometry = createConvexGeom(object);
    let coords = geometry.attributes.position.array;
    let tempVec = new Ammo.btVector3(0, 0, 0);
    let shape = new Ammo.btConvexHullShape();
    for (let i = 0, il = coords.length; i < il; i+= 3) {
      tempVec.setValue(coords[i], coords[i + 1], coords[i + 2]);
      let lastOne = (i >= (il - 3));
      shape.addPoint(tempVec, lastOne);
    }
    return shape;
}
  
function createConvexGeom (object) {
  // Compute the 3D convex hull.
  let hull = new ConvexHull().setFromObject(object);
  let faces = hull.faces;
  let vertices = [];
  let normals = [];

  for ( var i = 0; i < faces.length; i ++ ) {
    var face = faces[ i ];
    var edge = face.edge;
    do {
      var point = edge.head().point;
      vertices.push( point.x, point.y, point.z);
      normals.push( face.normal.x, face.normal.y, face.normal.z );
      edge = edge.next;
    } while ( edge !== face.edge );
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
  geom.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );

  return geom;
}

class AmmoHelper{

  static Init(callback = ()=>{}){
    // Buildless: ammo.wasm.js is loaded via a plain <script> in index.html and
    // exposes the global factory window.Ammo. locateFile points the loader at
    // the vendored .wasm sidecar so it resolves relative to the document root.
    window.Ammo({ locateFile: (f) => 'assets/vendor/ammo/' + f }).then((ammo)=>{
        Ammo = ammo;
        callback();
    });
  }

  static CreateTrigger(shape, position, rotation){
    const transform = new Ammo.btTransform();
    transform.setIdentity();
    position && transform.setOrigin(new Ammo.btVector3(position.x, position.y, position.z));
    rotation && transform.setRotation(new Ammo.btQuaternion(rotation.x, rotation.y, rotation.z, rotation.w));
  
    const ghostObj = new Ammo.btPairCachingGhostObject();
    ghostObj.setCollisionShape(shape);
    ghostObj.setCollisionFlags(CollisionFlags.CF_NO_CONTACT_RESPONSE);
    ghostObj.setWorldTransform(transform);
  
    return ghostObj;
  }

  static IsTriggerOverlapping(ghostObj, rigidBody){
    for(let i = 0; i < ghostObj.getNumOverlappingObjects(); i++)
    {
        const body = Ammo.castObject( ghostObj.getOverlappingObject(i), Ammo.btRigidBody );
        if(body == rigidBody){
            return true;
        }
    }
  
    return false;
  }

  static CastRay(world, origin, dest, result={}, collisionFilterMask=CollisionFilterGroups.AllFilter){
    if(!rayOrigin){
        rayOrigin = new Ammo.btVector3();
        rayDest = new Ammo.btVector3();
        closestRayResultCallback = new Ammo.ClosestRayResultCallback( rayOrigin, rayDest );
    }

    // Reset closestRayResultCallback to reuse it
    const rayCallBack = Ammo.castObject( closestRayResultCallback, Ammo.RayResultCallback );
    rayCallBack.set_m_closestHitFraction( 1 );
    rayCallBack.set_m_collisionObject( null );

    rayCallBack.m_collisionFilterMask = collisionFilterMask;
  
    // Set closestRayResultCallback origin and dest
    rayOrigin.setValue( origin.x, origin.y, origin.z );
    rayDest.setValue( dest.x, dest.y, dest.z );
    closestRayResultCallback.get_m_rayFromWorld().setValue( origin.x, origin.y, origin.z );
    closestRayResultCallback.get_m_rayToWorld().setValue( dest.x, dest.y, dest.z );

    // Perform ray test
    world.rayTest( rayOrigin, rayDest, closestRayResultCallback );
  
    if ( closestRayResultCallback.hasHit() ) {

        if(result.intersectionPoint){
            const point = closestRayResultCallback.get_m_hitPointWorld();
            result.intersectionPoint.set( point.x(), point.y(), point.z() );
        }

        if (result.intersectionNormal) {
            const normal = closestRayResultCallback.get_m_hitNormalWorld();
            result.intersectionNormal.set( normal.x(), normal.y(), normal.z() );
        }

        result.collisionObject = rayCallBack.get_m_collisionObject();
        return true;
    }
    else {
        return false;
    }
  }

  // Sweep a sphere of `radius` from `origin` to `dest` and report the first contact.
  // This is a "thick raycast": unlike CastRay (a zero-width line that can slip past
  // edges / let the camera's near plane poke through a wall), the sphere keeps a
  // clearance of `radius` from all geometry. On a hit, fills result.point (Bullet's
  // m_hitPointWorld — the contact point ON the hit surface, NOT the swept sphere's
  // centre; to get the centre at contact add radius*normal), result.normal (surface
  // normal, pointing out of the hit surface) and result.fraction (0..1
  // along the sweep) and returns true; otherwise sets result.fraction = 1 and returns
  // false. Objects are reused; the sphere radius is fixed on the first call and any
  // later change rebuilds the shape.
  static SphereSweep(world, radius, origin, dest, result = {}, collisionFilterMask = CollisionFilterGroups.AllFilter){
    if(!sweepShape || sweepRadius !== radius){
        if(sweepShape){ Ammo.destroy(sweepShape); }
        sweepShape = new Ammo.btSphereShape(radius);
        sweepRadius = radius;
    }
    if(!sweepFromT){
        sweepFromT = new Ammo.btTransform();
        sweepToT = new Ammo.btTransform();
        sweepFromV = new Ammo.btVector3();
        sweepToV = new Ammo.btVector3();
        convexResultCallback = new Ammo.ClosestConvexResultCallback(sweepFromV, sweepToV);
    }

    sweepFromT.setIdentity();
    sweepFromT.getOrigin().setValue(origin.x, origin.y, origin.z);
    sweepToT.setIdentity();
    sweepToT.getOrigin().setValue(dest.x, dest.y, dest.z);

    sweepFromV.setValue(origin.x, origin.y, origin.z);
    sweepToV.setValue(dest.x, dest.y, dest.z);
    convexResultCallback.set_m_convexFromWorld(sweepFromV);
    convexResultCallback.set_m_convexToWorld(sweepToV);
    // Reset the closest-hit fraction so a previous call's hit doesn't shadow this one;
    // a real hit this call drives it below 1 (we test the fraction, not hasHit(), so a
    // stale hit-object reference from a previous sweep can't be mistaken for a hit).
    convexResultCallback.set_m_closestHitFraction(1);
    convexResultCallback.m_collisionFilterMask = collisionFilterMask;

    world.convexSweepTest(sweepShape, sweepFromT, sweepToT, convexResultCallback, 0);

    const fraction = convexResultCallback.get_m_closestHitFraction();
    if(fraction < 1.0){
        if(result.point){
            const p = convexResultCallback.get_m_hitPointWorld();
            result.point.set(p.x(), p.y(), p.z());
        }
        if(result.normal){
            const n = convexResultCallback.get_m_hitNormalWorld();
            result.normal.set(n.x(), n.y(), n.z());
        }
        result.fraction = fraction;
        return true;
    }
    result.fraction = 1.0;
    return false;
  }

  // Heuristic "is this point buried in / walled-in by STATIC collision" test, for spawn validation.
  // Sweeps a small sphere from `far` metres out, in `dirs` horizontal directions, back toward the
  // point at torso height: if EVERY approach is blocked before arriving, the point is enclosed (inside
  // a solid convex-hull box like a shipping container, or boxed in by walls). Sweeping from OUTSIDE in
  // sidesteps the unreliable penetrating-origin case (a sweep that STARTS inside a convex shape doesn't
  // report cleanly). Returns true if enclosed (no clear straight approach from any sampled direction).
  static IsEnclosedByStatic(world, point, { dirs = 8, far = 3.0, radius = 0.35, height = 1.0 } = {}){
    if(!world){ return false; }
    const mask = CollisionFilterGroups.StaticFilter;
    const cx = point.x, cy = point.y + height, cz = point.z;
    const center = new THREE.Vector3(cx, cy, cz);
    const from = new THREE.Vector3();
    const res = { fraction: 1 };
    for(let i = 0; i < dirs; i++){
      const a = (i / dirs) * Math.PI * 2;
      from.set(cx + Math.cos(a) * far, cy, cz + Math.sin(a) * far);
      // SphereSweep returns true on a hit (blocked). A clear approach (no hit) from ANY side => the
      // point is reachable / not buried, so it's not enclosed.
      if(!AmmoHelper.SphereSweep(world, radius, from, center, res, mask)){ return false; }
    }
    return true;
  }

}

export {AmmoHelper, Ammo, createConvexHullShape, CollisionFlags, CollisionFilterGroups}
import Component from '../../Component.js'
import * as THREE from 'three'
import {Ammo, createConvexHullShape} from '../../AmmoLib.js'

export default class LevelSetup extends Component{
    constructor(mesh, scene, physicsWorld, terrain = null){
        super();
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.name = 'LevelSetup';
        this.mesh = mesh;
        // Optional uneven terrain (Terrain component). When present the old flat ground (the 'Cube' node)
        // is HIDDEN + given no collider — the terrain replaces it — and every shipping container is snapped
        // vertically onto the terrain at its (x,z), so the depot sits on the hills instead of a flat plane.
        this.terrain = terrain;
    }

    LoadScene(){
        // First pass: snap the level onto the terrain + retire the old flat ground, BEFORE colliders are
        // built (so the static hulls land at the snapped positions). Vertical-only snap => the navmesh's
        // x/z footprint stays valid. The container nodes are top-level children of the GLB root, so their
        // local position is their world position.
        if(this.terrain){
            this.mesh.traverse((node) => {
                if(node === this.mesh){ return; }
                if(node.name === 'Cube'){ node.visible = false; return; }   // flat ground -> hidden (replaced)
                if(node.parent === this.mesh && /Container/i.test(node.name)){
                    node.position.y += this.terrain.HeightAt(node.position.x, node.position.z);
                }
            });
            this.mesh.updateMatrixWorld(true);   // so the convex-hull colliders below read the snapped world transforms
        }

        this.mesh.traverse( ( node ) => {
            // The old flat ground is gone (terrain replaces it): no shadow/collider for it.
            if(this.terrain && node.name === 'Cube'){ return; }
            if ( node.isMesh || node.isLight ) { node.castShadow = true; }
            if(node.isMesh){
                node.receiveShadow = true;
                //node.material.wireframe = true;
                this.SetStaticCollider(node);
            }

            if(node.isLight){
                node.intensity = 3;
                const shadow = node.shadow;
                const lightCam = shadow.camera;

                // 2048² soft shadows: the 3072² map was a large per-frame depth pass for a single light
                // and a visually near-identical result over this 35 m camera box. 2048 keeps crisp edges
                // while cutting the shadow pass cost noticeably (bump back to 1024*3 if edges look soft).
                shadow.mapSize.width = 2048;
                shadow.mapSize.height = 2048;
                shadow.bias = -0.00007;

                const dH = 35, dV = 35;
                lightCam.left = -dH;
                lightCam.right = dH;
                lightCam.top = dV;
                lightCam.bottom = -dV;

                //const cameraHelper = new THREE.CameraHelper(lightCam);
                //this.scene.add(cameraHelper);
            }
        });

        this.scene.add( this.mesh );
    }


    SetStaticCollider(mesh){
        const shape = createConvexHullShape(mesh);
        const mass = 0;
        const transform = new Ammo.btTransform();
        transform.setIdentity();
        const motionState = new Ammo.btDefaultMotionState(transform);

        const localInertia = new Ammo.btVector3(0,0,0);
        const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
        const object = new Ammo.btRigidBody(rbInfo);
        object.parentEntity = this.parent;
        object.mesh = mesh;
  
        this.physicsWorld.addRigidBody(object);
    }

    Initialize(){
        this.LoadScene();
    }
}
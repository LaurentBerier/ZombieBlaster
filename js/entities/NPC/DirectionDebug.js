import * as THREE from 'three'
import Component from '../../Component.js'


export default class DirectionDebug extends Component{
    constructor(scene){
        super();
        this.name = 'DirectionDebug';
        this.scene = scene;
 
        this.dir = new THREE.Vector3();
        this.forwardVec = new THREE.Vector3(0,0,1);
    }
    
    Initialize(){
        this.arrowHelper = new THREE.ArrowHelper();
        this.scene.add( this.arrowHelper );
    }

    Update(t){
        if(!this.arrowHelper){ return; }
        this.dir.copy(this.forwardVec);
        this.dir.applyQuaternion(this.parent.rotation);
        this.arrowHelper.position.copy(this.parent.position);
        this.arrowHelper.position.y += 1;
        this.arrowHelper.setDirection(this.dir);
        this.arrowHelper.setLength(1);
        this.arrowHelper.setColor(0xffff00);
    }

    // Free the debug arrow when the entity is despawned (else it's orphaned in the scene at the
    // dead character's last spot).
    Dispose(){
        if(this.arrowHelper){
            if(this.arrowHelper.parent){ this.arrowHelper.parent.remove(this.arrowHelper); }
            this.arrowHelper.dispose && this.arrowHelper.dispose();
            this.arrowHelper = null;
        }
    }
}
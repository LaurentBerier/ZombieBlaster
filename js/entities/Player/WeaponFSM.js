import {FiniteStateMachine, State} from '../../FiniteStateMachine.js'
import * as THREE from 'three'

export default class WeaponFSM extends FiniteStateMachine{
    constructor(proxy){
        super();
        this.proxy = proxy;
        this.Init();
    }

    Init(){
        this.AddState('idle', new IdleState(this));
        this.AddState('shoot', new ShootState(this));
        this.AddState('reload', new ReloadState(this));
    }
}

class IdleState extends State{
    constructor(parent){
        super(parent);
    }

    get Name(){return 'idle'}
    get Animation(){return this.parent.proxy.animations['idle']; }

    Enter(prevState){
        const action = this.Animation.action;

        if(prevState){
            action.time = 0.0;
            action.enabled = true;
            action.loop = THREE.LoopRepeat;
            action.setEffectiveTimeScale(1.0);
            // Slightly longer blend back to idle so the gun settles out of the fire pose smoothly.
            // Warp OFF (false): a plain weight crossfade — warping retimes idle to the recoil clip's
            // length for the blend, which reads as a brief speed-up/hitch as the gun settles.
            action.crossFadeFrom(prevState.Animation.action, 0.16, false);
        }

        action.play();
    }

    Update(t){
        if(this.parent.proxy.shoot && this.parent.proxy.magAmmo > 0){
            this.parent.SetState('shoot');
        }
    }
}

class ShootState extends State{
    constructor(parent){
        super(parent);
    }

    get Name(){return 'shoot'}
    get Animation(){return this.parent.proxy.animations['shoot']; }

    Enter(prevState){
        const action = this.Animation.action;

        // Recoil cadence set BEFORE the crossfade. LoopRepeat (the recoil free-loops while the trigger
        // is held). Was 3.0 — that snapped the fire pose in/out. 2.0 keeps the gun reactive but reads
        // less frantic.
        action.enabled = true;
        action.loop = THREE.LoopRepeat;
        action.clampWhenFinished = false;
        action.setEffectiveWeight(1.0);
        action.timeScale = 2.0;

        if(prevState){
            action.time = 0.0;
            // NOTE: warp must stay OFF here. crossFadeFrom(..., true) time-WARPS the recoil clip to
            // match the idle clip's duration during the blend and leaves it running at that warped
            // cadence — overriding the 2.0 above — so the fire loop ran at the wrong speed and visibly
            // hitched at every loop wrap. A plain weight crossfade keeps the recoil at its own 2x
            // cadence and loops cleanly.
            action.crossFadeFrom(prevState.Animation.action, 0.14, false);
        }

        action.play();
    }

    Update(t){
        if(!this.parent.proxy.shoot || this.parent.proxy.magAmmo == 0){
            this.parent.SetState('idle');
        }
    }
}

class ReloadState extends State{
    constructor(parent){
        super(parent);

        this.parent.proxy.mixer.addEventListener( 'finished', this.AnimationFinished);
    }

    get Name(){ return 'reload'; }
    get Animation(){ return this.parent.proxy.animations['reload']; }

    AnimationFinished = e => {
        if(e.action != this.Animation.action){
            return;
        }

        this.parent.proxy.ReloadDone();
        this.parent.SetState('idle');
    }

    Enter(prevState){
        const action = this.Animation.action;
        action.loop = THREE.LoopOnce;

        if(prevState){
            action.time = 0.0;
            action.enabled = true;
            action.setEffectiveTimeScale(1.0);
            action.crossFadeFrom(prevState.Animation.action, 0.1, true);
        }

        action.play();
    }
}

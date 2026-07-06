import {FiniteStateMachine, State} from '../../FiniteStateMachine.js'
import * as THREE from 'three'

export default class CharacterFSM extends FiniteStateMachine{
    constructor(proxy){
        super();
        this.proxy = proxy;
        this.Init();
    }

    Init(){
        this.AddState('idle', new IdleState(this));
        this.AddState('patrol', new PatrolState(this));
        this.AddState('chase', new ChaseState(this));
        this.AddState('attack', new AttackState(this));
        this.AddState('dead', new DeadState(this));
    }
}

class IdleState extends State{
    constructor(parent){
        super(parent);
        this.maxWaitTime = 5.0;
        this.minWaitTime = 1.0;
        this.waitTime = 0.0;
    }

    get Name(){return 'idle'}
    get Animation(){return this.parent.proxy.animations['idle']; }

    Enter(prevState){
        this.parent.proxy.canMove = false;
        this.parent.proxy.scanTargetYaw = null;   // start the lookout sweep from the current facing
        const action = this.Animation.action;

        if(prevState){
            action.time = 0.0;
            action.enabled = true;
            action.crossFadeFrom(prevState.Animation.action, 0.5, true);
        }

        action.play();

        this.waitTime = Math.random() * (this.maxWaitTime - this.minWaitTime) + this.minWaitTime;
    }

    Update(t){
        // Stay on the lookout while paused: slowly sweep the facing so the view cone scans for the player.
        this.parent.proxy.UpdateScan(t);

        if(this.waitTime <= 0.0){
            this.parent.SetState('patrol');
            return;
        }

        this.waitTime -= t;

        if(this.parent.proxy.CanSeeThePlayer()){
            this.parent.SetState('chase');
        }
    }
}

class PatrolState extends State{
    constructor(parent){
        super(parent);
    }

    get Name(){return 'patrol'}
    get Animation(){return this.parent.proxy.animations['walk']; }

    PatrolEnd = ()=>{
        this.parent.SetState('idle');
    }

    Enter(prevState){
        this.parent.proxy.canMove = true;
        const action = this.Animation.action;

        if(prevState){
            action.time = 0.0;
            action.enabled = true;
            action.crossFadeFrom(prevState.Animation.action, 0.5, true);
        }

        action.play();

        this.parent.proxy.NavigateToRandomPoint();
    }

    Update(t){
        if(this.parent.proxy.CanSeeThePlayer()){
            this.parent.SetState('chase');
        }else if(this.parent.proxy.path && this.parent.proxy.path.length == 0){
            // Reached the roam point: mostly pick another and keep patrolling; only occasionally pause
            // to idle/scan, so the beast prowls continuously when not engaged.
            if(Math.random() < 0.2){
                this.parent.SetState('idle');
            }else{
                this.parent.proxy.NavigateToRandomPoint();
            }
        }
    }
}

class ChaseState extends State{
    constructor(parent){
        super(parent);
        // Re-acquire the player's position often so the beast tracks you tightly and stays
        // dangerous instead of running to where you *were* half a second ago. Tightened (was 0.2)
        // so the chase path follows the moving player closely and the beast stops over-running
        // stale routes into corners.
        this.updateFrequency = 0.12;
        this.updateTimer = 0.0;
        this.attackDistance = 2.0;
        this.shouldRotate = false;
        this.switchDelay = 0.2;
    }

    get Name(){return 'chase'}
    get Animation(){return this.parent.proxy.animations['run']; }

    RunToPlayer(prevState){
        this.parent.proxy.canMove = true;
        const action = this.Animation.action;
        this.updateTimer = 0.0;
        
        if(prevState){
            action.time = 0.0;
            action.enabled = true;
            action.setEffectiveTimeScale(1.0);
            action.setEffectiveWeight(1.0);
            action.crossFadeFrom(prevState.Animation.action, 0.2, true);
        }

        action.timeScale = 1.5;
        action.play();
    }

    Enter(prevState){
        this.RunToPlayer(prevState);
    }

    Update(t){
        // Repath to the player on a cadence — UNLESS the controller is committed to a stuck-recovery
        // detour (detourTimer), in which case we let that alternate waypoint play out instead of
        // immediately re-routing back into the corner that wedged us.
        if(this.parent.proxy.detourTimer <= 0.0 && this.updateTimer <= 0.0){
            this.parent.proxy.NavigateToPlayer();
            this.updateTimer = this.updateFrequency;
        }

        if(this.parent.proxy.IsCloseToPlayer){
            if(this.switchDelay <= 0.0){
                this.parent.SetState('attack');
            }

            this.parent.proxy.ClearPath();
            this.switchDelay -= t;
        }else{
            this.switchDelay = 0.1;
        }

        this.updateTimer -= t;
    }
}

class AttackState extends State{
    constructor(parent){
        super(parent);
        this.attackTime = 0.0;
        this.canHit = true;
    }

    get Name(){return 'attack'}
    get Animation(){return this.parent.proxy.animations['attack']; }

    Enter(prevState){
        this.parent.proxy.canMove = false;
        const action = this.Animation.action;
        this.attackTime = this.Animation.clip.duration;
        this.attackEvent = this.attackTime * 0.85;

        if(prevState){
            action.time = 0.0;
            action.enabled = true;
            action.crossFadeFrom(prevState.Animation.action, 0.1, true);
        }

        action.play();
    }

    Update(t){
        this.parent.proxy.FacePlayer(t);

        if(!this.parent.proxy.IsCloseToPlayer && this.attackTime <= 0.0){
            this.parent.SetState('chase');
            return;
        }

        if(this.canHit && this.attackTime <= this.attackEvent && this.parent.proxy.IsPlayerInHitbox){
            this.parent.proxy.HitPlayer();
            this.canHit = false;
        }

        if(this.attackTime <= 0.0){
            this.attackTime = this.Animation.clip.duration;
            this.canHit = true;
        }

        this.attackTime -= t;
    }
}

class DeadState extends State{
    constructor(parent){
        super(parent);
    }

    get Name(){return 'dead'}

    Enter(prevState){
        // Death is purely a physics ragdoll — no die clip, no crossfade. The controller
        // builds the ragdoll and stops the mixer; from here physics owns the body.
        this.parent.proxy.Die();
    }

    Update(t){}
}
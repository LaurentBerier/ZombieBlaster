import Component from "../../Component.js";

export default class PlayerHealth extends Component{
    constructor(){
        super();

        this.health = 100;
    }

    TakeHit = e =>{
        // Dodge-roll i-frames: ignore all damage while the roll's invulnerability window is active.
        if(this.controls && this.controls.invulnerable){ return; }
        // Ranged shots pass an explicit `amount`; the mutant's melee hit passes none,
        // so fall back to the original flat 10.
        const amount = (e && e.amount) ? e.amount : 10;
        this.health = Math.max(0, this.health - amount);
        this.uimanager.SetHealth(this.health);

        // Blood feedback on taking a hit: a world-space burst at the player's torso (visible in TPS)
        // plus a quick red screen vignette (covers FPS, where that burst sits behind the near plane).
        // Melee/ranged both reach here. Spray OUT of the entry side — toward whoever hit us — lifted off
        // the torso surface so the burst comes off the body instead of from inside the player mesh.
        const pos = this.parent.Position;
        const chest = pos.clone();
        chest.y -= 0.35;
        let origin = chest, out = null;
        if(e && e.from && e.from.Position){
            out = e.from.Position.clone().sub(chest);
            if(out.lengthSq() > 1e-6){ out.normalize(); origin = chest.clone().addScaledVector(out, 0.18); }
        }
        this.blood && this.blood.Emit(origin, out, { scale: 0.7, count: 12, spread: 0.7 });
        this.uimanager.FlashDamage && this.uimanager.FlashDamage();
    }

    Initialize(){
        this.uimanager = this.FindEntity("UIManager").GetComponent("UIManager");
        this.controls = this.GetComponent("PlayerControls");   // i-frames during the dodge roll
        // Shared blood-splatter burst. Optional — guarded at every use site — so tolerate a
        // level without a BloodFx (e.g. before the arena/FX are wired in the engine port).
        this.blood = this.FindEntity("Level")?.GetComponent("BloodFx");
        this.parent.RegisterEventHandler(this.TakeHit, "hit");
        this.uimanager.SetHealth(this.health);
    }
}
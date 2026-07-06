import Component from '../../Component.js'

export default class UIManager extends Component{
    constructor(){
        super();
        this.name = 'UIManager';
    }

    SetAmmo(mag, rest){
        document.getElementById("current_ammo").innerText = mag;
        document.getElementById("max_ammo").innerText = (rest === Infinity) ? '∞' : rest;
    }

    SetHealth(health){
        document.getElementById("health_progress").style.width = `${health}%`;
    }

    SetWeaponName(name){
        document.getElementById("weapon_name").innerText = name;
    }

    // Quick red screen vignette when the player is hit. Snap to a strong tint with the transition
    // disabled, then re-enable it and fade back to clear next frame so it pulses cleanly even on
    // rapid consecutive hits (each call restarts the pulse).
    FlashDamage(){
        const el = document.getElementById("blood_overlay");
        if(!el){ return; }
        el.style.transition = 'none';
        el.style.opacity = '0.8';
        requestAnimationFrame(() => {
            el.style.transition = 'opacity 0.6s ease';
            el.style.opacity = '0';
        });
    }

    // Set the on-screen reticle SPREAD (centre-to-tick gap, in vw). Driven by WeaponManager so the
    // reticle opens up for hipfire and tightens when aiming / blooms a touch while firing. Only the gap
    // changes — the tick thickness/length are fixed in CSS, so the outline weight is constant.
    SetReticleSize(vw){
        const el = document.getElementById("crosshair");
        if(el){ el.style.setProperty('--reticle-gap', `${vw}vw`); }
    }

    Initialize(){
        document.getElementById("game_hud").style.visibility = 'visible';
    }
}
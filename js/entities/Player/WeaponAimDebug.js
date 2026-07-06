import * as THREE from 'three'
import Component from '../../Component.js'
import Input from '../../Input.js'


// Toggleable debug visualization for the weapon aim-alignment + two-hand IK (WeaponAimIK).
// Press K to show/hide. Costs nothing until enabled (helpers are added to the scene only while on).
//
// Draws, in world space, every quantity the aim system reasons about so a designer can SEE whether
// the barrel matches the shot:
//   * AIM TARGET point (cyan sphere) — the world point under the crosshair (= where the bullet hits).
//   * CAMERA TRACE (white line) — camera -> aim target (the crosshair ray).
//   * MUZZLE FORWARD (red line) — where the barrel ACTUALLY points right now.
//   * CORRECTED AIM (green line) — muzzle -> aim target (where it SHOULD point). When aiming, the red
//     line rotates onto the green one: barrel == shot.
//   * IK SOCKETS — right grip (orange), left/foregrip target (magenta) the support hand IKs onto.
//   * A HUD readout of the current blend alpha, active state, aim validity, distance and camera mode.
//
// Lines/points are drawn on top (depthTest off) so they're visible through the character.
export default class WeaponAimDebug extends Component{
    constructor(){
        super();
        this.name = 'WeaponAimDebug';
        this.active = false;
        this.group = null;
        this.el = null;
        this.markLen = 6.0;   // length (m) the barrel/corrected direction rays are drawn

        // Scratch (no per-frame allocation).
        this._muzzleW = new THREE.Vector3();
        this._fwdW = new THREE.Vector3();
        this._gripR = new THREE.Vector3();
        this._gripL = new THREE.Vector3();
        this._end = new THREE.Vector3();
        this._wq = new THREE.Quaternion();
    }

    Initialize(){
        this.body = this.GetComponent('PlayerBody');
        this.controls = this.GetComponent('PlayerControls');
        this.scene = this.body ? this.body.scene : null;
        this.BuildPanel();
        Input.AddKeyDownListner(this.OnKeyDown);
    }

    OnKeyDown = (e) => {
        if(e.code === 'KeyK'){ e.preventDefault(); this.Toggle(); }
    }

    Toggle(){
        this.active = !this.active;
        if(this.active){ this.Build(); }
        else if(this.group && this.scene){ this.scene.remove(this.group); this.group = null; }
        if(this.el){ this.el.style.display = this.active ? 'block' : 'none'; }
    }

    // A cheap line helper (2-point BufferGeometry) drawn on top of everything.
    _line(color){
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
        const line = new THREE.Line(geo, mat);
        line.frustumCulled = false;
        line.renderOrder = 1000;
        this.group.add(line);
        return line;
    }

    // A small marker sphere drawn on top.
    _dot(color, radius){
        const geo = new THREE.SphereGeometry(radius, 10, 10);
        const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        m.renderOrder = 1000;
        this.group.add(m);
        return m;
    }

    Build(){
        if(!this.scene){ return; }
        this.group = new THREE.Group();
        this.group.frustumCulled = false;
        this.cameraTrace  = this._line(0xffffff);   // crosshair ray
        this.barrelLine   = this._line(0xff3030);   // where the barrel points
        this.correctedLine= this._line(0x30ff60);   // muzzle -> target (desired)
        this.aimDot   = this._dot(0x30c0ff, 0.10);  // aim target
        this.gripRDot = this._dot(0xffa030, 0.045); // right grip
        this.gripLDot = this._dot(0xff40ff, 0.05);  // left/foregrip IK target
        this.muzzleDot= this._dot(0xff3030, 0.04);  // muzzle
        this.scene.add(this.group);
    }

    _setLine(line, a, b){
        const p = line.geometry.attributes.position;
        p.setXYZ(0, a.x, a.y, a.z);
        p.setXYZ(1, b.x, b.y, b.z);
        p.needsUpdate = true;
    }

    Update(){
        if(!this.active || !this.group || !this.body || !this.controls){ return; }
        const ik = this.body.weaponAimIK;
        const pc = this.controls;
        const pivot = this.body.weaponPivot;

        // Aim target + crosshair ray are valid every frame (PlayerControls resolves them always).
        this.aimDot.position.copy(pc.aimTarget);
        this._setLine(this.cameraTrace, pc.aimOrigin, pc.aimTarget);

        // Barrel / sockets need the IK's resolved locals (available after its first Update) and the
        // weapon's current world matrix. Compute live so the gun's true barrel shows even at rest.
        if(ik && pivot && ik._barrelResolved){
            pivot.updateWorldMatrix(true, false);
            this._muzzleW.copy(ik.muzzleLocal).applyMatrix4(pivot.matrixWorld);
            pivot.getWorldQuaternion(this._wq);
            this._fwdW.copy(ik.forwardLocal).applyQuaternion(this._wq).normalize();
            this.muzzleDot.position.copy(this._muzzleW);
            this._end.copy(this._muzzleW).addScaledVector(this._fwdW, this.markLen);
            this._setLine(this.barrelLine, this._muzzleW, this._end);
            this._setLine(this.correctedLine, this._muzzleW, pc.aimTarget);

            this._gripR.copy(ik.rightGripLocal).add(ik.RightHandOffset).applyMatrix4(pivot.matrixWorld);
            this._gripL.copy(ik.leftGripLocal).add(ik.LeftHandOffset).applyMatrix4(pivot.matrixWorld);
            this.gripRDot.position.copy(this._gripR);
            this.gripLDot.position.copy(this._gripL);
            this.gripLDot.visible = ik.twoHanded;
        }

        // HUD readout.
        if(this.el){
            const a = ik ? ik._aimAlpha : 0;
            const g = ik ? ik._gripAlpha : 0;
            const dbg = ik ? ik._debug : null;
            // Convergence: angle between where the barrel ACTUALLY points (red) and the line to the reticle
            // (green). This is the acceptance metric for the FPS rework — it must stay ~0° in every state
            // (idle/walk/strafe/crouch/jump/land/ADS), spiking only briefly on a transition or recoil kick.
            let conv = '—';
            if(dbg && dbg.barrelFwd && dbg.correctedDir && dbg.correctedDir.lengthSq() > 1e-8){
                conv = THREE.MathUtils.radToDeg(
                    Math.acos(THREE.MathUtils.clamp(dbg.barrelFwd.dot(dbg.correctedDir), -1, 1))).toFixed(2) + '°';
            }
            this.el.textContent =
`WEAPON AIM IK  (K to close)
──────────────────────────
mode        ${pc.cameraMode}
active      ${this.body._weaponAimActive ? 'YES' : 'no'}
blend α     aim ${a.toFixed(3)}  grip ${g.toFixed(3)}
aim valid   ${pc.aimTargetValid ? 'hit' : 'far'}
aim dist    ${pc.aimDistance.toFixed(2)} m
converge    ${conv}   (barrel vs reticle)
maxAngle    ${THREE.MathUtils.radToDeg(ik ? ik.MaxAimCorrectionAngle : 0).toFixed(0)}°
two-handed  ${ik && ik.twoHanded ? 'yes' : 'no'}
──────────────────────────
white=crosshair ray
red=barrel  green=desired
cyan=target orange/magenta=grips`;
        }
    }

    BuildPanel(){
        const el = document.createElement('div');
        el.id = 'weapon-aim-debug';
        el.style.cssText = [
            'position:fixed', 'top:12px', 'left:12px', 'z-index:9999',
            'display:none', 'font:12px/1.5 monospace', 'color:#dfe',
            'background:rgba(10,14,20,0.85)', 'border:1px solid #2a4a3a',
            'border-radius:6px', 'padding:10px 12px', 'white-space:pre',
            'pointer-events:none', 'min-width:230px',
        ].join(';');
        document.body.appendChild(el);
        this.el = el;
    }
}

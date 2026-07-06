import * as THREE from 'three'


// Shared analytic IK helpers, extracted verbatim from WeaponAimIK so BOTH the arm solver
// (WeaponAimIK, support hand onto the foregrip) and the leg solver (FootIK, foot onto the ground)
// run the SAME hardened two-bone math. The maths are unchanged from the original arm solver — only
// the home moved — so the weapon-aim behaviour is identical after the refactor (gated by aim_test).
//
// Each consumer owns ONE IKChainSolver instance so its scratch pool is private: the player solves
// three independent chains per frame (one support arm + two legs) and a shared scratch set would let
// the leg solve clobber the arm solve's intermediates mid-frame. The solver is allocation-free (all
// scratch is preallocated on the instance), matching the original's per-frame-zero-GC design.
export class IKChainSolver{
    constructor(){
        // Two-bone IK scratch (mirrors the members WeaponAimIK declared for _solveTwoBone).
        this._R = new THREE.Vector3(); this._M = new THREE.Vector3(); this._E = new THREE.Vector3();
        this._n = new THREE.Vector3(); this._u = new THREE.Vector3();
        this._Mp = new THREE.Vector3(); this._Ep = new THREE.Vector3();
        this._re = new THREE.Vector3(); this._rt = new THREE.Vector3(); this._rt2 = new THREE.Vector3();
        this._pW = new THREE.Quaternion(); this._pWInv = new THREE.Quaternion();
        this._qDelta = new THREE.Quaternion(); this._qWorld = new THREE.Quaternion();
        this._perp = new THREE.Vector3();            // straight-arm bend-plane fallback
        this._poleRef  = new THREE.Vector3();        // reference pole, projected into the bend plane
        this._poleDown = new THREE.Vector3(0, -1, 0);// default anatomical pole (limb hangs DOWN)
    }

    // Analytic two-bone IK (direction-matching, sign-safe). Orient (root, mid) so `end` reaches
    // targetWorld while keeping the chain's existing bend side (the bend can never flip). Solve the
    // triangle (R, M', E') for the exact mid + end positions, then rotate the upper bone so its
    // segment points at M' and the lower bone so its segment points at E' — matching DIRECTIONS, so
    // there is no angle-sign ambiguity and the end lands exactly on the target. Reads live world
    // positions and applies world-space delta rotations (converted to each bone's local frame), so it
    // composes on top of the animated pose with no drift.
    //
    // poleHint biases the elbow/knee toward a stable anatomical reference (e.g. world-down for an arm,
    // body-forward for a leg); poleStabilize (0..1) blends the animated pole toward it to kill swivel,
    // with a flip-guard that fully corrects a wrong-side pole. The CALLER must have refreshed the
    // model's world matrices before the first solve of the frame (the solver re-reads world positions
    // between the two bone rotations via getWorldPosition, which recomputes from the local change).
    solveTwoBone(root, mid, end, targetWorld, poleHint = null, poleStabilize = 0){
        root.getWorldPosition(this._R);
        mid.getWorldPosition(this._M);
        end.getWorldPosition(this._E);
        const a = this._R.distanceTo(this._M);   // upper segment length
        const b = this._M.distanceTo(this._E);   // lower segment length
        if(a < 1e-5 || b < 1e-5){ return; }

        // n = unit root->target; d = reach, clamped so the triangle is always solvable.
        this._rt.copy(targetWorld).sub(this._R);
        const rawLen = this._rt.length();
        if(rawLen < 1e-5){ return; }
        this._n.copy(this._rt).multiplyScalar(1 / rawLen);
        const d = THREE.MathUtils.clamp(rawLen, Math.abs(a - b) + 1e-3, a + b - 1e-3);

        // u = unit perpendicular to n, pointing to the bend (elbow/knee) side. Start from the CURRENT
        // animated bend so a good pose is preserved as-is. On extreme targets the animated pole can go
        // degenerate (colinear with n) or sit on the WRONG side, flipping the lower bone into an
        // impossible reverse bend. So build a stable reference from poleHint (projected into the bend
        // plane) and (a) use it when the animated pole is degenerate, (b) blend toward it by
        // poleStabilize to kill swivel, (c) flip fully when the animated pole points the wrong way.
        this._u.copy(this._M).sub(this._R);
        this._u.addScaledVector(this._n, -this._u.dot(this._n));   // animated pole, perpendicular to n
        const uLenSq = this._u.lengthSq();

        this._poleRef.copy((poleHint && poleHint.lengthSq() > 1e-8) ? poleHint : this._poleDown);
        this._poleRef.addScaledVector(this._n, -this._poleRef.dot(this._n));   // reference, into bend plane
        const refValid = this._poleRef.lengthSq() > 1e-6;
        if(refValid){ this._poleRef.normalize(); }

        if(uLenSq < 1e-6){
            // Degenerate animated pole (bend colinear with root->target): use the reference, else any
            // perpendicular as a last resort.
            if(refValid){ this._u.copy(this._poleRef); }
            else{
                this._u.copy(this._n).cross(this._perp.set(0, 1, 0));
                if(this._u.lengthSq() < 1e-8){ this._u.copy(this._n).cross(this._perp.set(1, 0, 0)); }
                this._u.normalize();
            }
        }else{
            this._u.multiplyScalar(1 / Math.sqrt(uLenSq));
            if(refValid){
                // Stabilize: bias the animated pole toward the fixed reference so the joint doesn't
                // swivel/gimbal as the animated chain (and any aim) move — it stays in a consistent plane.
                if(poleStabilize > 0){ this._u.lerp(this._poleRef, poleStabilize).normalize(); }
                // Flip-guard: if it still points to the wrong side, correct fully.
                const align = this._u.dot(this._poleRef);             // <0 => bend on the wrong side
                if(align < 0){ this._u.lerp(this._poleRef, Math.min(1, -align)).normalize(); }
            }
        }

        // Desired mid M' (a from R, at the law-of-cosines angle off n) and end E' (on n at distance d).
        const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        this._Mp.copy(this._R).addScaledVector(this._n, a * cosA).addScaledVector(this._u, a * sinA);
        this._Ep.copy(this._R).addScaledVector(this._n, d);

        // 1) Upper bone: rotate (M-R) onto (M'-R).
        this._re.copy(this._M).sub(this._R).normalize();
        this._rt2.copy(this._Mp).sub(this._R).normalize();
        this._qWorld.setFromUnitVectors(this._re, this._rt2);
        this.applyWorldQuat(root, this._qWorld);
        mid.getWorldPosition(this._M);   // refresh after the upper rotation
        end.getWorldPosition(this._E);

        // 2) Lower bone: rotate (E-M) onto (E'-M).
        this._re.copy(this._E).sub(this._M).normalize();
        this._rt2.copy(this._Ep).sub(this._M).normalize();
        this._qWorld.setFromUnitVectors(this._re, this._rt2);
        this.applyWorldQuat(mid, this._qWorld);
    }

    // Apply a world-space rotation qW to a bone about its origin: newLocal = parentW^-1 * qW * parentW * oldLocal.
    applyWorldQuat(bone, qW){
        bone.parent.getWorldQuaternion(this._pW);
        this._pWInv.copy(this._pW).invert();
        this._qDelta.copy(this._pWInv).multiply(qW).multiply(this._pW);
        bone.quaternion.premultiply(this._qDelta);
    }
}

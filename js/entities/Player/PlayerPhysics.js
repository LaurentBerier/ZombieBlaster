import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'

//Bullet enums
const CF_KINEMATIC_OBJECT = 2;
const DISABLE_DEACTIVATION = 4;

export default class PlayerPhysics extends Component{
    constructor(world){
        super();
        this.world = world;
        this.body = null;
        this.name = "PlayerPhysics";
        this.canJump = false;
        this.up = new Ammo.btVector3(0,1,0);
        this.tempVec = new Ammo.btVector3();

        // Capsule dimensions (cylinder height between the hemisphere centres; total = height + 2*radius).
        // Crouch swaps to the SHORTER shape so the player fits under low cover and presents a smaller
        // target. The two shapes share the radius; the crouched one drops the body origin by centerDrop
        // so the FEET stay on the floor (the top comes down, the bottom doesn't). PlayerControls keeps the
        // tracked eye stable across the swap (it adds centerDrop back while crouched), so the resize is a
        // pure collision-volume change — the visible crouch (lowered pelvis + bent knees) is the body's job.
        this.radius = 0.3;
        this.standHeight = 1.3;                 // standing cylinder height (total 1.9 m)
        this.crouchHeight = 0.7;                // crouched cylinder height (total 1.3 m)
        this.centerDrop = (this.standHeight - this.crouchHeight) * 0.5;   // 0.30 m the centre drops when crouched
        this.crouched = false;
        this._standShape = null;
        this._crouchShape = null;
        // FPS uses a WIDER collision capsule so the first-person body/arms don't clip/glitch when the player
        // presses against a wall (the player centre is held further off the wall). The wide variants keep the
        // SAME TOTAL height (cylinder height reduced by 2*(fpsRadius-radius)), so grounding, eye height and
        // the crouch centerDrop are all unchanged — only the lateral footprint grows. Swapped on camera mode.
        this.fpsRadius = 0.42;
        this.wide = false;                      // true while in FPS (wider capsule active)
        this._standShapeWide = null;
        this._crouchShapeWide = null;
        this._sweepRes = { fraction: 1 };       // reused CanStandUp sweep result
    }

    Initialize(){
        const mass = 5;

        const transform = new Ammo.btTransform();
        transform.setIdentity();
        const pos = this.parent.Position;
        transform.setOrigin(new Ammo.btVector3(pos.x,pos.y,pos.z));
        const motionState = new Ammo.btDefaultMotionState(transform);

        this._standShape  = new Ammo.btCapsuleShape(this.radius, this.standHeight);
        this._crouchShape = new Ammo.btCapsuleShape(this.radius, this.crouchHeight);
        // Wider FPS variants: cylinder height reduced by 2*(fpsRadius-radius) so the TOTAL height (bottom/top,
        // grounding, centerDrop) matches the normal shapes — only the radius (lateral clearance) grows.
        const dwide = 2 * (this.fpsRadius - this.radius);
        this._standShapeWide  = new Ammo.btCapsuleShape(this.fpsRadius, Math.max(0.05, this.standHeight  - dwide));
        this._crouchShapeWide = new Ammo.btCapsuleShape(this.fpsRadius, Math.max(0.05, this.crouchHeight - dwide));
        const localInertia = new Ammo.btVector3(0,0,0);
        const bodyInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, this._standShape, localInertia);
        this.body = new Ammo.btRigidBody(bodyInfo);
        this.body.setFriction(0);

        //this.body.setCollisionFlags(this.body.getCollisionFlags() | CF_KINEMATIC_OBJECT);
        this.body.setActivationState(DISABLE_DEACTIVATION);

        this.world.addRigidBody(this.body);
    }

    // Swap the collision capsule for the crouch state. Shifts the body origin by centerDrop in the
    // direction that keeps the FEET on the floor (down on crouch, up on stand) and swaps the shape on
    // the same step, so the bottom never moves (no fall, no penetration) and grounded detection holds.
    // Standing up is BLOCKED when there's no head clearance (CanStandUp) — the caller stays crouched.
    // Returns true if the state changed (or already matched), false if a requested stand was blocked.
    SetCrouched(want){
        // Normalize: callers pass mixed truthiness (PlayerControls' wantCrouch is built from
        // Input.GetKeyDown, which returns NUMBERS 0/1). The strict compare below saw 0 !== false,
        // treated "stay standing" as a state CHANGE, and ran the stand-up branch on an already-
        // standing body — teleporting the origin +centerDrop and ZEROING the vertical velocity.
        // That fired one frame after every crouch-jump (the jump block passes boolean false), which
        // ate the fresh jump impulse: the "crouch jump does nothing / stutters" bug.
        want = !!want;
        if(want === this.crouched){ return true; }
        if(!want && !this.CanStandUp()){ return false; }   // no headroom: stay crouched

        const tr = this.body.getWorldTransform();
        const o = tr.getOrigin();
        const dy = want ? -this.centerDrop : this.centerDrop;
        o.setValue(o.x(), o.y() + dy, o.z());               // shift the body so the bottom stays put
        const ms = this.body.getMotionState();
        if(ms){ ms.setWorldTransform(tr); }                 // keep the interpolated transform in sync
        this.crouched = want;
        this.body.setCollisionShape(this._currentShape());  // crouch shape (wide in FPS, normal in TPS)
        if(this.world.updateSingleAabb){ this.world.updateSingleAabb(this.body); }

        // Vertical velocity is PRESERVED through the swap. It used to be zeroed ("so the swap can't
        // bounce") — but the swap keeps the capsule bottom in place by construction, so there is no
        // bounce to guard, while the zero actively BROKE slope walking: toggling crouch while moving
        // on a slope wiped the slope-following vy, the capsule decoupled (plowed into / floated off
        // the incline), went briefly ballistic, and the body flashed the fall pose while the camera
        // jolted — the intermittent "crouch animation glitch + camera jitter". A jump that needs a
        // specific vy (PlayerControls) sets it explicitly AFTER calling this.
        this.body.activate(true);
        return true;
    }

    // The collision shape for the current (crouched, wide) state.
    _currentShape(){
        if(this.crouched){ return this.wide ? this._crouchShapeWide : this._crouchShape; }
        return this.wide ? this._standShapeWide : this._standShape;
    }

    // Swap to the wider FPS capsule (or back to the normal one). Same TOTAL height, so there's no vertical
    // shift — just re-seat the collision shape for the current crouch state and refresh the broadphase AABB.
    // Called by PlayerControls on a TPS<->FPS camera switch.
    SetWide(on){
        on = !!on;
        if(on === this.wide || !this.body){ return; }
        this.wide = on;
        this.body.setCollisionShape(this._currentShape());
        if(this.world.updateSingleAabb){ this.world.updateSingleAabb(this.body); }
        this.body.activate(true);
    }

    // Is there room to stand back up? Thick upward sphere-sweep (so it can't slip past a thin ledge)
    // from the crouched centre through the height the head reclaims, against STATIC geometry only.
    CanStandUp(){
        const o = this.body.getWorldTransform().getOrigin();
        // Slightly under-sized sphere so brushing a wall we're crouched against doesn't trap us.
        const sweepR = this.radius * 0.9;
        const from = { x: o.x(), y: o.y(), z: o.z() };
        // Sweep far enough that the sphere's TOP reaches the FULL standing-capsule top: the stand
        // raises the centre by centerDrop and the top sits standHeight/2 + radius above that. The old
        // end (centerDrop + radius) only cleared ~1.5 m above the feet — ceilings between that and the
        // 1.9 m standing top were missed, so standing under low cover penetrated the ceiling and Bullet
        // shoved the capsule out violently (the crouch-jump-under-cover chaos).
        const reach = this.centerDrop + this.standHeight * 0.5 + this.radius - sweepR;
        const to   = { x: o.x(), y: o.y() + reach, z: o.z() };
        const blocked = AmmoHelper.SphereSweep(
            this.world, sweepR, from, to, this._sweepRes, CollisionFilterGroups.StaticFilter);
        return !blocked;
    }

    QueryJump(){
        // NOTE: canJump is intentionally NOT reset to false here. The faceted terrain collider drops the
        // player's contact manifolds for a frame or two while DESCENDING a slope (the body outruns the
        // next facet), so a strict per-tick recompute flickered canJump false on slopes — which switched
        // off the FootIK + kicked in the air/fall pose, reading as the character "falling" and thrashing
        // the upper body (worst while crouched). Letting canJump LATCH its previous value across those
        // brief no-contact gaps masks them; take-off clears it explicitly (PlayerControls) and coyote-time
        // there still covers the genuine grounded->air transition for forgiving jumps.
        // RISING is never grounded — even if a contact manifold lingers for a substep after take-off
        // (Bullet keeps the point until separation exceeds the breaking threshold). Without this, the
        // frame AFTER a jump still read IsGrounded=true, so a held crouch key re-entered the crouch
        // mid-ascent: SetCrouched ZEROED the fresh jump velocity (eating the jump) and swapped the
        // capsule twice in one frame — the crouch-jump "thrash". Slope-climbing never exceeds ~2 m/s
        // vertical at our walk speeds, so this only trips on real jump ascents (jumpVelocity = 5).
        if(this.body.getLinearVelocity().y() > 2.5){
            this.canJump = false;
            return;
        }
        const dispatcher = this.world.getDispatcher();
        const numManifolds = dispatcher.getNumManifolds();

        for ( let i = 0; i < numManifolds; i++ ) {
            const contactManifold = dispatcher.getManifoldByIndexInternal( i );
            const rb0 = Ammo.castObject( contactManifold.getBody0(), Ammo.btRigidBody );
            const rb1 = Ammo.castObject( contactManifold.getBody1(), Ammo.btRigidBody );

            if(rb0 != this.body && rb1 != this.body){
                continue;
            }

            const numContacts = contactManifold.getNumContacts();

            for ( let j = 0; j < numContacts; j++ ) {
                const contactPoint = contactManifold.getContactPoint( j );

                const normal = contactPoint.get_m_normalWorldOnB();
                this.tempVec.setValue(normal.x(),normal.y(),normal.z());

                if(rb1 == this.body){
                    this.tempVec.setValue(-this.tempVec.x(),-this.tempVec.y(),-this.tempVec.z());
                }

                const angle = this.tempVec.dot(this.up);
                this.canJump = angle > 0.5;

                if(this.canJump){
                    return;
                }
            }
        }
    }

    PhysicsUpdate(){
        this.QueryJump();
    }
}
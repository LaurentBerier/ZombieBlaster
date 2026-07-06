import * as THREE from 'three'
import Component from '../Component.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'


// Unreal-Engine export layer. Press P in-game to download two files:
//
//   * level_ue.glb   — the static level + props geometry, pre-converted into UE
//                      space: Y-up -> Z-up (+90deg about X) and metres -> centimetres
//                      (x100). Import into UE with NO further axis/scale conversion.
//   * mechanics.json — a structured description of the entities and their tunable
//                      mechanics (player movement, weapon stats, NPC AI, spawns).
//                      This is the "blueprint data" a developer maps onto UE
//                      Blueprints/DataAssets. Schema: data/mechanics.schema.json.
//
// Skinned characters are intentionally excluded from level_ue.glb: the player/soldier
// use the UE Mannequin (SK_Mannequin_new.glb) and the enemy is the mutant FBX, so they
// round-trip best from their source assets (see docs/UE_IMPORT_GUIDE.md).
export default class UeExporter extends Component{
    constructor(scene, entityManager){
        super();
        this.name = 'UeExporter';
        this.scene = scene;
        this.entityManager = entityManager;
        this.busy = false;
    }

    Initialize(){
        window.addEventListener('keydown', this.OnKey);
        // Also expose for automated QA / manual calls.
        window.__ueExport = () => this.ExportAll();
    }

    OnKey = (e) => {
        if(e.code === 'KeyP' && !e.repeat){
            this.ExportAll();
        }
    }

    async ExportAll(){
        if(this.busy){ return; }
        this.busy = true;
        try{
            const mechanics = this.BuildMechanics();
            this.Download(
                new Blob([JSON.stringify(mechanics, null, 2)], {type: 'application/json'}),
                'mechanics.json'
            );
            const glb = await this.ExportLevelGLB();
            this.Download(new Blob([glb], {type: 'model/gltf-binary'}), 'level_ue.glb');
            console.log('[UeExporter] exported level_ue.glb + mechanics.json');
        } finally {
            this.busy = false;
        }
    }

    // Clone the static meshes with their world transforms baked in, parent them
    // under a converter group (Y-up -> Z-up, m -> cm), and export that group.
    // Cloning keeps the live scene untouched (no flicker, no skeleton issues).
    ExportLevelGLB(){
        const root = new THREE.Group();
        root.rotation.x = Math.PI / 2;     // Y-up -> Z-up
        root.scale.setScalar(100);         // metres -> centimetres (UE units)

        this.scene.updateMatrixWorld(true);
        this.scene.traverse(o => {
            if(!o.isMesh || o.isSkinnedMesh){ return; }   // static geometry only
            if(o.userData && o.userData.noExport){ return; }
            const clone = new THREE.Mesh(o.geometry, o.material);
            clone.name = o.name || 'mesh';
            // Bake the source world transform; root adds the UE conversion on top.
            clone.matrix.copy(o.matrixWorld);
            clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
            root.add(clone);
        });

        // r127 GLTFExporter signature: parse(input, onDone, options) — the binary
        // option must be the THIRD arg (newer three added a separate onError arg).
        return new Promise((resolve) => {
            new GLTFExporter().parse(
                root,
                (result) => resolve(result),
                { binary: true }
            );
        });
    }

    // Serialize entities + their tunable mechanics into the "blueprint data" doc.
    BuildMechanics(){
        const round = (v) => Math.round(v * 1000) / 1000;
        const vec = (p) => p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : null;

        const out = {
            schema: 'sandscape.mechanics/1.0',
            // UE space hint: this game runs Y-up in metres; assets/coords export to
            // UE Z-up centimetres. level_ue.glb is pre-converted; coordinates below
            // are in the game's native Y-up metres (convert with the same rule).
            space: { up: 'Y', units: 'metres', ueConversion: { rotateXdeg: 90, scale: 100 } },
            entities: [],
        };

        const entities = this.entityManager ? this.entityManager.entities : [];
        for(const ent of entities){
            const rec = { name: ent.Name, position: vec(ent.Position), components: [] };
            for(const key in ent.components){
                const c = ent.components[key];
                rec.components.push(this.DescribeComponent(c));
            }
            out.entities.push(rec);
        }
        return out;
    }

    // Pull a curated set of tunable fields per known component type. Unknown
    // components still appear by name so the document stays a faithful inventory.
    DescribeComponent(c){
        const d = { type: c.name };
        switch(c.name){
            case 'PlayerControls':
                d.walkSpeed = c.walkSpeed;
                d.sprintMultiplier = c.sprintMultiplier;
                d.jumpVelocity = c.jumpVelocity;
                d.cameraMode = c.cameraMode;
                d.tpsDistance = c.tpsDistance;
                break;
            case 'PlayerHealth':
                d.health = c.health;
                break;
            case 'WeaponManager':
                d.weapons = (c.weapons || []).map(w => ({
                    name: w.name, fireRate: w.fireRate, damage: w.damage,
                    magSize: w.ammoPerMag, ammo: w.ammo,
                }));
                break;
            case 'CharacterController':
                d.health = c.health;
                d.attackDistance = c.attackDistance;
                d.maxViewDistance = Math.sqrt(c.maxViewDistance || 0);
                break;
            default:
                break;
        }
        return d;
    }

    Download(blob, filename){
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke on next tick so the download has started.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

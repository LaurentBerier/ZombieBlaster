export default class EntityManager{
    constructor(){
        this.ids = 0;
        this.entities = [];
        // Entities scheduled for removal (e.g. a despawned corpse). Removal is DEFERRED to the end of
        // the Update tick so an entity can request its own removal from inside its Update without
        // mutating the array mid-iteration; the flush disposes each (freeing physics bodies / meshes).
        this._pendingRemoval = [];
    }

    Get(name){
        return this.entities.find(el=>el.Name===name);
    }

    Add(entity){
        if(!entity.Name){
            entity.SetName(this.ids);
        }
        entity.id = this.ids;
        this.ids++;
        entity.SetParent(this);
        this.entities.push(entity);
    }

    EndSetup(){
        for(const ent of this.entities){
            for(const key in ent.components){
                ent.components[key].Initialize();
            }
        }
    }

    PhysicsUpdate(world, timeStep){
        for (const entity of this.entities) {
            entity.PhysicsUpdate(world, timeStep);
        }
    }

    Update(timeElapsed){
        for (const entity of this.entities) {
            entity.Update(timeElapsed);
        }
        this.FlushRemovals();
    }

    // Request an entity be removed after the current tick (deferred — safe to call mid-Update).
    Remove(entity){
        if(entity && this._pendingRemoval.indexOf(entity) === -1){
            this._pendingRemoval.push(entity);
        }
    }

    // Splice out + dispose each pending entity (runs after the Update loop, after the physics step,
    // so removing its physics bodies / meshes is safe). Dispose frees the entity's components.
    FlushRemovals(){
        if(this._pendingRemoval.length === 0){ return; }
        for(const entity of this._pendingRemoval){
            const i = this.entities.indexOf(entity);
            if(i !== -1){ this.entities.splice(i, 1); }
            try{ entity.Dispose && entity.Dispose(); }
            catch(e){ console.error('Entity dispose failed:', e); }
        }
        this._pendingRemoval.length = 0;
    }
}
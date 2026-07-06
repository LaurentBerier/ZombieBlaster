export default class Component{
    constructor(){
        this.parent = null;
    }

    Initialize(){}

    SetParent(parent){
        this.parent = parent;
    }

    GetComponent(name) {
        return this.parent.GetComponent(name);
    }

    FindEntity(name) {
        return this.parent.FindEntity(name);
    }

    Broadcast(msg){
        this.parent.Broadcast(msg);
    }

    Update(_) {}

    PhysicsUpdate(_){}

    // Release any owned resources (physics bodies, scene objects, audio). Called by Entity.Dispose
    // when the entity is removed from the manager. No-op by default; components that allocate
    // world/scene resources override it.
    Dispose(){}
}
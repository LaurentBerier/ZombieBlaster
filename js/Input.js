

// Game keys we consume — preventDefault stops the browser's own handling (Space scrolling the page,
// Ctrl/Alt combos opening menus or save dialogs, '/' quick-find, etc.) so they don't fire under the
// game. Function keys (F5/F12) and anything not listed pass through untouched. NOTE: this is a page
// handler and CANNOT suppress OS-level global hotkeys (e.g. PowerToys double-Ctrl) — that's why the
// dodge was rebound off Ctrl rather than relying on preventDefault.
const GAME_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft',
    'KeyR', 'KeyV', 'KeyP', 'KeyK', 'Digit1', 'Digit2', 'Backquote',
]);

class Input{
    constructor(){
        this._keyMap = {};
        this.events = [];

        this.AddKeyDownListner(this._onKeyDown);
        this.AddKeyUpListner(this._onKeyUp);
    }

    _addEventListner(element, type, callback){
        element.addEventListener(type, callback);
        this.events.push({element, type, callback});
    }

    AddKeyDownListner(callback){
        this._addEventListner(document, 'keydown', callback);
    }

    AddKeyUpListner(callback){
        this._addEventListner(document, 'keyup', callback);
    }

    AddMouseMoveListner(callback){
        this._addEventListner(document, 'mousemove', callback);
    }

    AddClickListner(callback){
        this._addEventListner(document.body, 'click', callback);
    }

    AddMouseDownListner(callback){
        this._addEventListner(document.body, 'mousedown', callback);
    }

    AddMouseUpListner(callback){
        this._addEventListner(document.body, 'mouseup', callback);
    }

    AddMouseWheelListner(callback){
        this._addEventListner(document, 'wheel', callback);
    }

    _onKeyDown = (event) => {
        this._keyMap[event.code] = 1;
        // Swallow the browser's default for keys the game owns (page scroll, Ctrl/Alt menu/save, etc.).
        if(GAME_KEYS.has(event.code)){ event.preventDefault(); }
    }

    _onKeyUp = (event) => {
        this._keyMap[event.code] = 0;
    }

    GetKeyDown(code){
        return this._keyMap[code] === undefined ? 0 : this._keyMap[code];
    }

    ClearEventListners(){
        this.events.forEach(e=>{
            e.element.removeEventListener(e.type, e.callback);
        });

        this.events = [];
        this.AddKeyDownListner(this._onKeyDown);
        this.AddKeyUpListner(this._onKeyUp);
    }
}

const inputInstance = new Input();
export default inputInstance;
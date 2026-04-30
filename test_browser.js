const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const PORT = 8771;
const CDP_PORT = 9229;
const ROOT = '/workspace/generated_assets';
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.glb': 'model/gltf-binary',
};

const server = http.createServer((req, res) => {
  let fp = path.join(ROOT, req.url === '/' ? '/index.html' : req.url);
  try {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(fs.readFileSync(fp));
  } catch { res.writeHead(404); res.end('Not found'); }
});

class SimpleWS {
  constructor(url) { this.url = new URL(url); this.callbacks = []; this.buffer = Buffer.alloc(0); }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.url.hostname, port: parseInt(this.url.port) }, () => {
        const key = Buffer.from(Math.random().toString()).toString('base64');
        this.socket.write(`GET ${this.url.pathname} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let headerDone = false;
      this.socket.on('data', (data) => {
        if (!headerDone) {
          const idx = data.indexOf(Buffer.from('\r\n\r\n'));
          if (idx >= 0) { headerDone = true; if (idx + 4 < data.length) { this.buffer = data.slice(idx + 4); this._process(); } resolve(); }
        } else { this.buffer = Buffer.concat([this.buffer, data]); this._process(); }
      });
      this.socket.on('error', reject);
    });
  }
  _process() {
    while (this.buffer.length >= 2) {
      const b1 = this.buffer[0], b2 = this.buffer[1]; const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7F, off = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;
      if (this.buffer.length < off + len) return;
      let payload = this.buffer.slice(off, off + len);
      if (masked) { const m = this.buffer.slice(off - 4, off); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i%4]; }
      this.buffer = this.buffer.slice(off + len);
      if ((b1 & 0x0F) === 1) this.callbacks.forEach(cb => cb(payload.toString('utf8')));
    }
  }
  send(data) {
    const p = Buffer.from(data, 'utf8');
    const mask = Buffer.from([Math.random()*256|0, Math.random()*256|0, Math.random()*256|0, Math.random()*256|0]);
    let h;
    if (p.length < 126) { h = Buffer.alloc(2); h[0] = 0x81; h[1] = 0x80 | p.length; }
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    const masked = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i%4];
    this.socket.write(Buffer.concat([h, mask, masked]));
  }
  onMessage(cb) { this.callbacks.push(cb); }
  close() { try { this.socket.end(); } catch {} }
}

async function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 100000);
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      try { const msg = JSON.parse(data); if (msg.id === id) { ws.callbacks = ws.callbacks.filter(c => c !== handler); resolve(msg.result || msg); } } catch {}
    };
    ws.onMessage(handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.callbacks = ws.callbacks.filter(c => c !== handler); reject(new Error('CDP timeout: ' + method)); }, 15000);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

server.listen(PORT, async () => {
  console.log('Server on port', PORT);

  const chrome = spawn('/opt/google/chrome/chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-extensions', '--enable-webgl', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${CDP_PORT}`, '--window-size=1280,720',
    `http://localhost:${PORT}`
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  await sleep(8000);

  try {
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const tabs = await resp.json();
    const tab = tabs.find(t => t.url.includes('localhost:' + PORT)) || tabs[0];
    const ws = new SimpleWS(tab.webSocketDebuggerUrl);
    await ws.connect();
    console.log('Connected');

    const errors = [];
    await cdpSend(ws, 'Runtime.enable');
    await cdpSend(ws, 'Log.enable');
    await cdpSend(ws, 'Page.enable');

    ws.onMessage((data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.exceptionThrown') {
          const text = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '';
          if (!text.includes('Pointer Lock')) errors.push(text);
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          const text = msg.params.args?.map(a => a.value || a.description || '').join(' ') || '';
          if (!text.includes('Pointer Lock')) errors.push(text);
        }
      } catch {}
    });

    await sleep(8000);

    // Start game
    await cdpSend(ws, 'Runtime.evaluate', { expression: `document.getElementById('btn-start')?.click()` });
    console.log('Game started');
    await sleep(4000);

    // Spawn an enemy right in front of the player and simulate firing at it
    const testResult = await cdpSend(ws, 'Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        const mod = await import('./js/enemies.js');
        const weapMod = await import('./js/weapons.js');
        const playerMod = await import('./js/player.js');
        const logicMod = await import('./js/gameLogic.js');

        // Spawn a zombie right in front of the player
        const playerPos = playerMod.getPlayerPosition();
        const fwd = playerMod.getPlayerForward();
        const spawnPos = { x: playerPos.x + fwd.x * 5, z: playerPos.z + fwd.z * 5 };
        const enemy = mod.spawnEnemy('zombie', spawnPos);

        if (!enemy) return JSON.stringify({ error: 'Could not spawn enemy' });

        const enemyHealthBefore = enemy.health;
        const enemyAlive = enemy.alive;
        const enemyPos = enemy.root.position.clone();

        // Now simulate a hitscan shot toward the enemy
        // We'll manually call the performHitscan logic via fireWeapon
        // First set fire key
        playerMod.keys.fire = true;

        // Wait a frame for updateWeapons to fire
        await new Promise(r => setTimeout(r, 200));
        playerMod.keys.fire = false;

        await new Promise(r => setTimeout(r, 100));

        return JSON.stringify({
          enemySpawned: true,
          enemyHealthBefore,
          enemyHealthAfter: enemy.health,
          enemyAlive: enemy.alive,
          wasDamaged: enemy.health < enemyHealthBefore,
          enemyPos: { x: enemyPos.x.toFixed(1), y: enemyPos.y.toFixed(1), z: enemyPos.z.toFixed(1) },
          playerPos: { x: playerPos.x.toFixed(1), y: playerPos.y.toFixed(1), z: playerPos.z.toFixed(1) },
          playerFwd: { x: fwd.x.toFixed(2), y: fwd.y.toFixed(2), z: fwd.z.toFixed(2) },
          score: logicMod.scoreState.score,
          ammo: weapMod.weaponState.currentAmmo[0],
        });
      })()`
    });
    console.log('Combat test result:', testResult.result?.value);

    // Take screenshot
    const ss = await cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'screenshot_combat_test.png'), Buffer.from(ss.data, 'base64'));
    console.log('Saved screenshot_combat_test.png');

    // If the first test didn't fire (no pointer lock), manually test hit detection
    const directTest = await cdpSend(ws, 'Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        const mod = await import('./js/enemies.js');
        const weapMod = await import('./js/weapons.js');
        const playerMod = await import('./js/player.js');
        const sceneMod = await import('./js/scene.js');

        // Get alive enemies
        const alive = mod.getAliveEnemies();
        if (alive.length === 0) return JSON.stringify({ error: 'No alive enemies to test' });

        const enemy = alive[0];
        const enemyHealthBefore = enemy.health;

        // Directly call damageEnemy to verify the callback chain works
        const killed = mod.damageEnemy(enemy, 15);

        return JSON.stringify({
          directDamageTest: true,
          enemyHealthBefore,
          enemyHealthAfter: enemy.health,
          wasDamaged: enemy.health < enemyHealthBefore,
          killed,
        });
      })()`
    });
    console.log('Direct damage test:', directTest.result?.value);

    // Now test actual hitscan geometry by creating enemy at known position and testing ray
    const geometryTest = await cdpSend(ws, 'Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        const mod = await import('./js/enemies.js');
        const playerMod = await import('./js/player.js');

        // Spawn enemy directly in front at known position
        const enemy = mod.spawnEnemy('zombie', { x: 0, z: 0 });
        if (!enemy) return JSON.stringify({ error: 'No pool slot' });

        // Player is at (0, 1.7, 5) looking at (0,0,-1) by default
        const origin = playerMod.getPlayerPosition();
        const dir = playerMod.getPlayerForward();

        // Check: enemy at (0, 0, 0), player at (0, 1.7, 5), looking forward (0, 0, -1)
        const enemyPos = enemy.root.position.clone();
        enemyPos.y = 1.0; // body center
        const toEnemy = enemyPos.clone().sub(origin);
        const projLength = toEnemy.dot(dir);
        const closestPoint = origin.clone().add(dir.clone().multiplyScalar(projLength));
        const horizontalDist = Math.sqrt(
          (closestPoint.x - enemyPos.x) ** 2 + (closestPoint.z - enemyPos.z) ** 2
        );
        const verticalDist = Math.abs(closestPoint.y - enemyPos.y);

        return JSON.stringify({
          origin: { x: origin.x.toFixed(2), y: origin.y.toFixed(2), z: origin.z.toFixed(2) },
          dir: { x: dir.x.toFixed(3), y: dir.y.toFixed(3), z: dir.z.toFixed(3) },
          enemyRootPos: { x: enemy.root.position.x.toFixed(2), y: enemy.root.position.y.toFixed(2), z: enemy.root.position.z.toFixed(2) },
          enemyCenterPos: { x: enemyPos.x.toFixed(2), y: enemyPos.y.toFixed(2), z: enemyPos.z.toFixed(2) },
          projLength: projLength.toFixed(2),
          closestPoint: { x: closestPoint.x.toFixed(2), y: closestPoint.y.toFixed(2), z: closestPoint.z.toFixed(2) },
          horizontalDist: horizontalDist.toFixed(3),
          verticalDist: verticalDist.toFixed(3),
          hitRadius: enemy.hitRadius,
          wouldHit: horizontalDist < enemy.hitRadius && verticalDist < 1.8,
        });
      })()`
    });
    console.log('Geometry test:', geometryTest.result?.value);

    console.log('\n=== ERRORS ===');
    if (errors.length === 0) console.log('No errors!');
    else errors.forEach(e => console.log('ERROR:', e));

    ws.close(); chrome.kill(); server.close(); process.exit(0);
  } catch (e) {
    console.error('Test failed:', e.message);
    chrome.kill(); server.close(); process.exit(1);
  }
});

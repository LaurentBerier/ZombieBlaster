// POC zombie/ragdoll probe: boot, force-spawn zombies (bypassing the slow-fps timer in
// headless), verify they build (skinned mesh + mixer + animations), then force-kill some
// and verify the ragdoll takes over. Screenshots before/after the kill.
//   PORT=8090 SHOT=/path/prefix node tools/poc_zombie_probe.mjs
const PORT = process.env.PORT || '8090';
const SHOT = process.env.SHOT || null;
const exe = process.env.CHROME_BIN ||
  'C:\\Users\\lbernier\\.cache\\puppeteer\\chrome\\win64-147.0.7727.56\\chrome-win64\\chrome.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message + '\n    ' + (e.stack || '').split('\n').slice(1, 5).join('\n    ')));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE.ERR: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.evaluate(() => document.getElementById('start_game')?.click());
  await page.waitForFunction(() => window._APP?.entityManager?.entities.length >= 2, { timeout: 45000 });
  await sleep(1500);

  // Force-spawn zombies then reposition them in a row in front of the player (-Z),
  // so they're on-camera for the screenshots (the timer/AI would take too long at
  // headless fps to march them into view).
  const spawn = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const sp = em.Get('ZombieSpawner').GetComponent('ZombieSpawner');
    for (let i = 0; i < 5; i++) sp.spawnOne();
    const zs = em.entities.filter(e => e.GetComponent('ZombieController')).map(e => e.GetComponent('ZombieController'));
    zs.forEach((z, i) => {
      z.root.position.set(-4 + i * 2, 0, -11 - (i % 2) * 1.5)
      z.root.rotation.y = Math.PI // face the player
    });
    const z0 = zs[0];
    return {
      count: zs.length,
      z0: z0 ? {
        hasSkinnedMesh: !!z0.skinnedMesh,
        hasMixer: !!z0.mixer,
        hasWalk: !!z0.walkAction, hasAttack: !!z0.attackAction, hasDeath: !!z0.deathAction,
        pos: z0.root.position.toArray().map(n => +n.toFixed(2)),
        boneCount: z0.skinnedMesh ? z0.skinnedMesh.skeleton.bones.length : 0,
      } : null,
    };
  });
  log('=== SPAWN ==='); log(JSON.stringify(spawn, null, 2));

  // Let them animate/step a moment.
  await sleep(1500);
  if (SHOT) { await page.screenshot({ path: SHOT + '_alive.png' }); log('shot -> ' + SHOT + '_alive.png'); }

  // Force-kill up to 3 zombies and confirm the ragdoll takes over (no exception, dying=true).
  const kill = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const zEnts = em.entities.filter(e => e.GetComponent('ZombieController'));
    let killed = 0, ragdolls = 0;
    for (const e of zEnts.slice(0, 3)) {
      const z = e.GetComponent('ZombieController');
      e.Broadcast({ topic: 'hit', amount: 9999, from: player });
      if (z.dying) killed++;
      if (z.ragdoll) ragdolls++;
    }
    return { killed, ragdolls, total: zEnts.length };
  });
  log('=== KILL ==='); log(JSON.stringify(kill, null, 2));

  // Let the ragdoll simulate + settle a little (bounded by slow headless fps, but enough
  // to catch an exception thrown inside ragdoll.update()).
  await sleep(2500);
  if (SHOT) { await page.screenshot({ path: SHOT + '_ragdoll.png' }); log('shot -> ' + SHOT + '_ragdoll.png'); }

  const after = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const zEnts = em.entities.filter(e => e.GetComponent('ZombieController'));
    const dying = zEnts.filter(e => e.GetComponent('ZombieController').dying).length;
    return { remaining: zEnts.length, dying };
  });
  log('=== AFTER ==='); log(JSON.stringify(after, null, 2));

  log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => log('  ' + e));
  const pass = errors.length === 0 && spawn.count >= 5 && spawn.z0?.hasSkinnedMesh && kill.killed >= 1;
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); }

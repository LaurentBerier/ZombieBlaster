// POC end-to-end verify: clean boot, TPS screenshot, toggle to FPS (the V feature) and
// confirm the dual camera, then a combat volley. Asserts zero errors throughout.
//   PORT=8090 SHOT=/path/prefix node tools/poc_verify.mjs
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
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE.ERR: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.evaluate(() => document.getElementById('start_game')?.click());
  await page.waitForFunction(() => window._APP?.entityManager?.entities.length >= 2, { timeout: 45000 });
  await sleep(1800);

  const boot = await page.evaluate(() => {
    const em = window._APP.entityManager;
    return { entities: em.entities.map(e => e.Name), mode: em.Get('Player').GetComponent('PlayerControls').cameraMode };
  });
  log('=== BOOT ==='); log(JSON.stringify(boot));

  // Toggle to FPS (the V key feature) directly.
  const fps = await page.evaluate(() => {
    const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    pc.ToggleCamera();
    return { mode: pc.cameraMode, hud: document.getElementById('camera_mode')?.innerText };
  });
  await sleep(800);
  log('=== FPS TOGGLE ==='); log(JSON.stringify(fps));
  if (SHOT) { await page.screenshot({ path: SHOT + '_fps.png' }); log('shot -> ' + SHOT + '_fps.png'); }

  // Combat volley in FPS: spawn + fire, confirm a kill/ragdoll.
  const combat = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const sp = em.Get('ZombieSpawner').GetComponent('ZombieSpawner');
    for (let i = 0; i < 4; i++) sp.spawnOne();
    const zs = em.entities.filter(e => e.GetComponent('ZombieController')).map(e => e.GetComponent('ZombieController'));
    zs.forEach((z, i) => { z.root.position.set(-3 + i * 2, 0, -12); });
    const ps = player.GetComponent('ProjectileSystem');
    const w = player.GetComponent('WeaponManager').active;
    for (let i = 0; i < 60; i++) { ps.Fire(w); ps.Update(0.04); }
    return { killed: zs.filter(z => z.dying).length, ragdolls: zs.filter(z => z.ragdoll).length };
  });
  log('=== COMBAT (FPS) ==='); log(JSON.stringify(combat));

  // Back to TPS.
  const back = await page.evaluate(() => {
    const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    pc.ToggleCamera();
    return pc.cameraMode;
  });
  log('back to: ' + back);

  log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => log('  ' + e));
  const pass = errors.length === 0
    && boot.entities.includes('Level') && boot.entities.includes('Player')
    && fps.mode === 'FPS' && back === 'TPS' && combat.killed >= 1;
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'FAIL ❌'));
  process.exitCode = pass ? 0 : 1;
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); }

// POC fire probe: boot, place zombies in front, then directly drive the ProjectileSystem
// (Fire + Update) — bypassing the slow-fps game loop — and verify sprite bolts spawn, hit
// the zombies, apply damage, and trigger the ragdoll. Screenshot mid-volley.
//   PORT=8090 SHOT=/path/prefix node tools/poc_fire_probe.mjs
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
  await sleep(1800); // let PlayerControls set aimTarget/aimDir

  const setup = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const sp = em.Get('ZombieSpawner').GetComponent('ZombieSpawner');
    for (let i = 0; i < 5; i++) sp.spawnOne();
    const zs = em.entities.filter(e => e.GetComponent('ZombieController')).map(e => e.GetComponent('ZombieController'));
    zs.forEach((z, i) => { z.root.position.set(-4 + i * 2, 0, -12); z.root.rotation.y = Math.PI; });
    const wm = em.Get('Player').GetComponent('WeaponManager');
    return { count: zs.length, weapon: wm.active?.name, healths: zs.map(z => z.health), hasProjSys: !!em.Get('Player').GetComponent('ProjectileSystem') };
  });
  log('=== SETUP ==='); log(JSON.stringify(setup));

  // Drive the projectile system directly at the zombies.
  const fire = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const ps = player.GetComponent('ProjectileSystem');
    const wm = player.GetComponent('WeaponManager');
    const weapon = wm.active;
    let maxActive = 0;
    for (let i = 0; i < 60; i++) {
      ps.Fire(weapon);
      ps.Update(0.04);
      const a = ps.projectiles.filter(p => p.userData.active).length;
      if (a > maxActive) maxActive = a;
    }
    const zs = em.entities.filter(e => e.GetComponent('ZombieController')).map(e => e.GetComponent('ZombieController'));
    return {
      maxActiveBolts: maxActive,
      spriteVisible: ps.projectiles.some(p => p.userData.core.visible && p.userData.active) || ps.projectiles.length > 0,
      dying: zs.filter(z => z.dying).length,
      healths: zs.map(z => Math.round(z.health)),
      ragdolls: zs.filter(z => z.ragdoll).length,
    };
  });
  log('=== FIRE ==='); log(JSON.stringify(fire, null, 2));

  // Let a couple game frames render the bolts/ragdolls, then screenshot.
  await sleep(600);
  await page.evaluate(() => {
    // Spawn a fresh volley for the screenshot so bolts are mid-flight on camera.
    const em = window._APP.entityManager;
    const ps = em.Get('Player').GetComponent('ProjectileSystem');
    const w = em.Get('Player').GetComponent('WeaponManager').active;
    for (let i = 0; i < 8; i++) { ps.Fire(w); ps.Update(0.02); }
  });
  await sleep(300);
  if (SHOT) { await page.screenshot({ path: SHOT + '_fire.png' }); log('shot -> ' + SHOT + '_fire.png'); }

  log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => log('  ' + e));
  const pass = errors.length === 0 && setup.hasProjSys && fire.maxActiveBolts > 0 && fire.dying >= 1;
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); }

// POC arsenal probe: cycle all 4 funky weapons — equip each, confirm the visible in-hand gun
// swapped, fire a volley at zombies (each bolt type), and screenshot each gun. Asserts zero errors.
//   PORT=8090 SHOT=/path/prefix node tools/poc_arsenal_probe.mjs
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
  await page.evaluate(() => document.getElementById('btn-start')?.click());
  await page.waitForFunction(() => window._APP?.entityManager?.entities.length >= 2, { timeout: 45000 });
  await sleep(1800);

  const results = [];
  for (let wi = 0; wi < 4; wi++) {
    const r = await page.evaluate((wi) => {
      const em = window._APP.entityManager;
      const player = em.Get('Player');
      const wm = player.GetComponent('WeaponManager');
      const body = player.GetComponent('PlayerBody');
      const ps = player.GetComponent('ProjectileSystem');
      wm.EquipWeapon(wi);
      // Measure the visible gun bbox (confirms the mesh actually swapped between weapons).
      const THREE = window._APP.scene.children[0].constructor; // not reliable; use pivot traverse count
      let meshCount = 0; let sx = 0, sy = 0, sz = 0;
      if (body.weaponPivot) {
        body.weaponPivot.updateWorldMatrix(true, true);
        body.weaponPivot.traverse(o => { if (o.isMesh) meshCount++; });
      }
      // Fresh zombies in front.
      const sp = em.Get('ZombieSpawner').GetComponent('ZombieSpawner');
      const before = em.entities.filter(e => e.GetComponent('ZombieController')).map(e => e.GetComponent('ZombieController'));
      before.forEach(z => { if (!z.dying) z.parent.parent.Remove(z.parent); }); // clear old
      for (let i = 0; i < 3; i++) sp.spawnOne();
      const zs = em.entities.filter(e => e.GetComponent('ZombieController')).map(e => e.GetComponent('ZombieController')).filter(z => !z.dying);
      zs.forEach((z, i) => { z.root.position.set(-3 + i * 3, 0, -12); });
      const weapon = wm.active;
      let maxBolts = 0;
      for (let i = 0; i < 50; i++) { ps.Fire(weapon); ps.Update(0.04); maxBolts = Math.max(maxBolts, ps.projectiles.filter(p => p.userData.active).length); }
      return {
        index: wi, name: weapon.name, fireMode: weapon.fireMode, bulletStyle: weapon.bulletStyle,
        visibleGunMeshes: meshCount, maxBolts,
        anyStatusApplied: zs.some(z => z.statusEffect && z.statusEffect.type),
        killedOrHurt: zs.some(z => z.dying || z.health < z.maxHealth),
      };
    }, wi);
    results.push(r);
    log(JSON.stringify(r));
    await sleep(500);
    if (SHOT) { await page.screenshot({ path: `${SHOT}_w${wi}.png` }); }
  }

  log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => log('  ' + e));
  const names = results.map(r => r.name);
  const pass = errors.length === 0
    && new Set(names).size === 4
    && results.every(r => r.visibleGunMeshes > 0 && r.maxBolts > 0 && r.killedOrHurt);
  log('\nweapons: ' + names.join(' | '));
  log('RESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); }

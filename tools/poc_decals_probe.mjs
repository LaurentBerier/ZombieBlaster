// POC decals probe: boot, then verify BOTH new decal paths end-to-end.
//   Part 1 (body splats): fire the Franken-Gun at zombies and confirm the shader-projected
//     impact decals get stamped (Decals.activeDecals grows, at least one 'shader' kind, and
//     the zombie's material was actually patched).
//   Part 2 (environment splats): fire the gravity-arcing Soda Laser at the floor with the
//     zombies moved out of the way, and confirm Fx.envSplats grows (wall/floor splat + the
//     new segment-vs-ARENA.walls / ground collision that makes bolts land instead of pass
//     through).
//   PORT=8090 SHOT=/path/prefix node tools/poc_decals_probe.mjs
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
  await page.evaluate(() => document.getElementById('btn-start')?.click());
  await page.waitForFunction(() => window._APP?.entityManager?.entities.length >= 2, { timeout: 45000 });
  await sleep(1800);

  // --- Part 1: body decals (Franken-Gun at a zombie placed ON the aim ray so the bolt
  // reaches it with line of sight — mirrors real play, where the crosshair is on a zombie
  // and the per-frame zombie hit-test resolves before the wall-test). ---
  const body = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const sp = em.Get('ZombieSpawner').GetComponent('ZombieSpawner');
    sp.spawnOne();
    const player = em.Get('Player');
    const ps = player.GetComponent('ProjectileSystem');
    const decals = em.Get('Level').GetComponent('Decals');
    const wm = player.GetComponent('WeaponManager');
    const controls = player.GetComponent('PlayerControls');
    if (wm.active?.name !== 'FRANKEN-GUN' && wm.EquipWeapon) wm.EquipWeapon(0);
    const weapon = wm.active;
    const z = em.entities.map(e => e.GetComponent('ZombieController')).find(Boolean);
    // Origin like Fire(): the weapon pivot (fallback camera). Place the zombie 5 m down aimDir.
    const V = z.root.position.constructor;
    const origin = new V();
    const body3 = player.GetComponent('PlayerBody');
    if (body3 && body3.weaponPivot) body3.weaponPivot.getWorldPosition(origin);
    else controls.camera.getWorldPosition(origin);
    const dir = (controls.aimDir ? controls.aimDir.clone() : new V(0, 0, -1));
    dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1); dir.normalize();
    const zp = origin.clone().addScaledVector(dir, 5); z.root.position.set(zp.x, 0, zp.z);
    const startHealth = z.health;
    for (let i = 0; i < 60; i++) {
      // Keep the crosshair pinned to the zombie so aim doesn't wander off it.
      if (controls.aimTarget) { controls.aimTarget.set(z.root.position.x, 1.1, z.root.position.z); controls.aimTargetValid = true; }
      ps.Fire(weapon); ps.Update(0.04); decals.Update(0.02);
    }
    const kinds = decals.activeDecals.reduce((m, d) => (m[d.kind] = (m[d.kind] || 0) + 1, m), {});
    const st = decals.decalStates.get(z);
    return {
      hasDecals: !!decals,
      impactBonesSample: z?.impactBones?.length || 0,
      zombieDamaged: startHealth - z.health,
      activeDecals: decals.activeDecals.length,
      kinds,
      firstZombiePatched: !!(st && st.patched),
      weapon: weapon?.name,
    };
  });
  log('=== PART 1: BODY DECALS ==='); log(JSON.stringify(body, null, 2));

  // --- Part 2: environment splats (Soda Laser arcs into the floor; zombies moved away) ---
  const env = await page.evaluate(() => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const ps = player.GetComponent('ProjectileSystem');
    const fx = em.Get('Level').GetComponent('Fx');
    const wm = player.GetComponent('WeaponManager');
    // Move every zombie far up/away so bolts reach the floor/walls unobstructed.
    em.entities.filter(e => e.GetComponent('ZombieController'))
      .forEach(e => e.GetComponent('ZombieController').root.position.set(0, 200, 0));
    // Switch to the Soda Laser (blue, gravity bolts) — index 2.
    if (wm.EquipWeapon) wm.EquipWeapon(2);
    const weapon = wm.active;
    const before = fx.envSplats.length;
    for (let i = 0; i < 80; i++) { ps.Fire(weapon); ps.Update(0.04); }
    return { weapon: weapon?.name, envSplatsBefore: before, envSplatsAfter: fx.envSplats.length };
  });
  log('=== PART 2: ENVIRONMENT SPLATS ==='); log(JSON.stringify(env, null, 2));

  // Fresh on-camera volley for the screenshot.
  await page.evaluate(() => {
    const em = window._APP.entityManager;
    const player = em.Get('Player');
    const ps = player.GetComponent('ProjectileSystem');
    const wm = player.GetComponent('WeaponManager');
    if (wm.EquipWeapon) wm.EquipWeapon(0);
    // Bring a couple zombies back in front for the shot.
    const zs = em.entities.filter(e => e.GetComponent('ZombieController')).map(e => e.GetComponent('ZombieController'));
    zs.slice(0, 3).forEach((z, i) => z.root.position.set(-2 + i * 2, 0, -8));
    for (let i = 0; i < 10; i++) { ps.Fire(wm.active); ps.Update(0.03); }
  });
  await sleep(400);
  if (SHOT) { await page.screenshot({ path: SHOT + '_decals.png' }); log('shot -> ' + SHOT + '_decals.png'); }

  log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => log('  ' + e));
  const pass = errors.length === 0
    && body.hasDecals && body.impactBonesSample > 0 && body.firstZombiePatched
    && body.zombieDamaged > 0 && body.activeDecals > 0 && !!body.kinds.shader
    && env.envSplatsAfter > 0;
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); }

// POC boot check: open index.html headlessly against the running dev server, click NEW GAME,
// wait for the entity graph to build, and report console errors / failed requests / exceptions.
//   PORT=8090 node tools/poc_boot_check.mjs
// Uses the puppeteer-core install in this repo + the cached Chrome-for-Testing binary.
const PORT = process.env.PORT || '8090';
const exe = process.env.CHROME_BIN ||
  'C:\\Users\\lbernier\\.cache\\puppeteer\\chrome\\win64-147.0.7727.56\\chrome-win64\\chrome.exe';
const { default: puppeteer } = await import('puppeteer-core');

const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const log = (...a) => console.log(...a);
let ok = false;
try {
  const page = await browser.newPage();
  const failed = [];
  const errors = [];
  page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText || '??'}  ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}  ${r.url()}`); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message + '\n    ' + (e.stack || '').split('\n').slice(1, 6).join('\n    ')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE.ERR: ' + m.text()); });

  log('loading http://127.0.0.1:' + PORT + '/index.html ...');
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.evaluate(() => document.getElementById('start_game')?.click());
  try {
    await page.waitForFunction(
      () => window._APP && window._APP.entityManager && window._APP.entityManager.entities.length >= 2,
      { timeout: 45000 });
    ok = true;
  } catch (e) { errors.push('BUILD TIMEOUT: ' + e.message); }

  // Let it run a couple seconds so first-frame physics/anim exceptions surface.
  await new Promise(r => setTimeout(r, 2500));

  const state = await page.evaluate(() => {
    const em = window._APP?.entityManager;
    const player = em?.Get('Player');
    const pc = player?.GetComponent('PlayerControls');
    const p = player?.Position, c = window._APP?.camera?.position;
    const r3 = v => v ? { x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) } : null;
    return {
      entities: em?.entities.map(e => e.Name),
      hasPlayer: !!player,
      hasBody: !!player?.GetComponent('PlayerBody'),
      hasWeaponMgr: !!player?.GetComponent('WeaponManager'),
      cameraMode: pc?.cameraMode,
      camModeHud: document.getElementById('camera_mode')?.innerText,
      ammoHud: document.getElementById('current_ammo')?.innerText,
      playerPos: r3(p),      // should settle on the ground (y ~1.x, not falling negative)
      cameraPos: r3(c),
    };
  });

  if (process.env.SHOT) {
    await page.setViewport({ width: 1280, height: 720 });
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: process.env.SHOT });
    log('screenshot -> ' + process.env.SHOT);
  }

  log('\n=== STATE ===');
  log(JSON.stringify(state, null, 2));
  log('\n=== FAILED / 4xx REQUESTS (' + failed.length + ') ===');
  failed.forEach(f => log('  ' + f));
  log('\n=== ERRORS (' + errors.length + ') ===');
  errors.forEach(e => log('  ' + e));

  const clean = failed.length === 0 && errors.length === 0;
  log('\nRESULT: ' + (ok && clean ? 'PASS ✅' : (ok ? 'BOOTED WITH ISSUES ⚠️' : 'FAIL ❌')));
  process.exitCode = (ok && clean) ? 0 : 1;
} catch (e) { log('HARNESS ERROR:', e.stack || e.message); process.exitCode = 2; }
finally { await browser.close(); }

// POC HUD probe: verify the M3 identity/onboarding flow end to end —
//   title screen visible at boot → click START → HUD shows + reflects director state
//   (score/combo/wave) → force player death → game-over screen populates.
//   Screenshots the title screen and the in-game HUD.
//   PORT=8090 SHOT=/path/prefix node tools/poc_hud_probe.mjs
const PORT = process.env.PORT || '8090';
const SHOT = process.env.SHOT || null;
const exe = process.env.CHROME_BIN ||
  'C:\\Users\\lbernier\\.cache\\puppeteer\\chrome\\win64-147.0.7727.56\\chrome-win64\\chrome.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--no-first-run','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const log = (...a)=>console.log(...a); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const vis = async (page, id) => page.evaluate(i => { const el=document.getElementById(i); if(!el) return 'missing'; return el.classList.contains('hidden') ? 'hidden' : 'shown'; }, id);
try {
  const page = await browser.newPage(); await page.setViewport({width:1280,height:720});
  const errors=[]; page.on('pageerror',e=>errors.push('PE:'+e.message)); page.on('console',m=>{if(m.type()==='error')errors.push('CE:'+m.text());});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'networkidle2',timeout:120000});

  // Wait for assets → title screen ready (btn-start present + app.assetsReady).
  await page.waitForFunction(()=>window._APP?.assetsReady===true,{timeout:60000});
  const titleShown = await vis(page,'title-screen');
  const hudHiddenAtTitle = await vis(page,'hud');
  const titleHS = await page.evaluate(()=>document.getElementById('title-high-score')?.innerText);
  if (SHOT) { await page.screenshot({ path: SHOT + '_title.png' }); log('shot -> ' + SHOT + '_title.png'); }

  // Start the game via a REAL pointer click (hit-tests overlays like a user mouse — catches
  // a full-screen curtain swallowing clicks, which a JS element.click() would miss).
  await page.click('#btn-start');
  await page.waitForFunction(()=>window._APP?.entityManager?.entities.length>=2,{timeout:45000});
  await sleep(2000);
  const hudShown = await vis(page,'hud');

  // Drive some kills through the director and let the HUD Update() pull them.
  const mid = await page.evaluate(async ()=>{
    const em=window._APP.entityManager;
    const dir=em.Get('GameDirector').GetComponent('GameDirector');
    for(let k=0;k<6;k++) dir.ReportKill(100, null);
    // let a few rAF frames run so UIManager.Update paints the DOM
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {
      score: dir.state.score, mult: dir.state.comboMultiplier, wave: Math.max(1,dir.state.currentWave),
      hudScore: document.getElementById('hud-score')?.innerText,
      hudCombo: document.getElementById('combo-multiplier')?.innerText,
      hudWave: document.getElementById('hud-wave')?.innerText,
      hudAmmo: document.getElementById('ammo-count')?.innerText,
      hudWeapon: document.getElementById('weapon-name')?.innerText,
    };
  });
  if (SHOT) { await page.screenshot({ path: SHOT + '_hud.png' }); log('shot -> ' + SHOT + '_hud.png'); }

  // Kill the player → game-over screen.
  const deathDiag = await page.evaluate(()=>{
    const em=window._APP.entityManager;
    const dir=em.Get('GameDirector').GetComponent('GameDirector');
    const ph=em.Get('Player').GetComponent('PlayerHealth');
    ph.health = 0;
    return { sameRef: dir.playerHealth===ph, dirHasPh: !!dir.playerHealth, hasCb: !!dir.onGameOver, goBefore: dir.state.gameOver };
  });
  await sleep(600);
  const goState = await page.evaluate(()=>({ gameOver: window._APP.entityManager.Get('GameDirector').GetComponent('GameDirector').state.gameOver }));
  log('deathDiag', JSON.stringify(deathDiag), 'goState', JSON.stringify(goState));
  const goShown = await vis(page,'gameover-screen');
  const goStats = await page.evaluate(()=>({
    finalScore: document.getElementById('final-score')?.innerText,
    finalWaves: document.getElementById('final-waves')?.innerText,
    finalKills: document.getElementById('final-kills')?.innerText,
  }));

  const res = { titleShown, hudHiddenAtTitle, titleHS, hudShown, mid, goShown, goStats };
  log(JSON.stringify(res,null,2));
  log('ERRORS('+errors.length+')', errors.slice(0,8));

  const pass = errors.length===0
    && titleShown==='shown' && hudHiddenAtTitle==='hidden'
    && hudShown==='shown'
    && mid.hudScore===mid.score.toLocaleString() && mid.hudCombo==='x'+mid.mult && mid.hudWave===String(mid.wave)
    && goShown==='shown' && goStats.finalKills==='6';
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch(e){ log('HARNESS ERROR', e.stack||e.message); process.exitCode=2; }
finally { await browser.close(); }

// POC pause/cursor probe: verify pointer lock is gated to gameplay-only (so the cursor stays
// on the menus) and the pause flow freezes/resumes correctly.
//   PORT=8090 node tools/poc_pause_probe.mjs
const PORT = process.env.PORT || '8090';
const exe = process.env.CHROME_BIN ||
  'C:\\Users\\lbernier\\.cache\\puppeteer\\chrome\\win64-147.0.7727.56\\chrome-win64\\chrome.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--no-first-run','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const log = (...a)=>console.log(...a); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const vis = (page,id)=>page.evaluate(i=>{const e=document.getElementById(i);return e?(getComputedStyle(e).display!=='none'?'shown':'hidden'):'missing';},id);
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720 });
  const errors=[]; page.on('pageerror',e=>errors.push('PE:'+e.message)); page.on('console',m=>{if(m.type()==='error')errors.push('CE:'+m.text());});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'networkidle2',timeout:120000});
  await page.waitForFunction(()=>window._APP?.assetsReady===true,{timeout:60000});

  // At the title screen: playing must be false (so a click can't grab the pointer / hide cursor).
  const atTitle = await page.evaluate(()=>({ playing: !!window._APP.playing, paused: !!window._APP.paused }));

  await page.click('#btn-start');
  await page.waitForFunction(()=>window._APP?.entityManager?.entities.length>=2,{timeout:45000});
  await page.waitForFunction(()=>window._APP.playing===true,{timeout:15000});
  await sleep(500);

  // In gameplay: no menu open -> IsMenuOpen() false.
  const inGame = await page.evaluate(()=>{
    const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    return { playing: window._APP.playing, paused: window._APP.paused, menuOpen: pc.IsMenuOpen() };
  });

  // Pause -> screen shows, paused true, IsMenuOpen true, and the world FREEZES.
  const beforePause = await page.evaluate(()=>{
    const d = window._APP.entityManager.Get('GameDirector').GetComponent('GameDirector').state;
    return { waveDelayTimer:+d.waveDelayTimer.toFixed(3), spawnTimer:+d.spawnTimer.toFixed(3), spawned:d.enemiesSpawned };
  });
  await page.evaluate(()=>window._APP.PauseGame());
  const pausedState = await page.evaluate(()=>{
    const pc = window._APP.entityManager.Get('Player').GetComponent('PlayerControls');
    return { paused: window._APP.paused, menuOpen: pc.IsMenuOpen() };
  });
  const pauseShown = await vis(page,'pause-screen');
  await sleep(1500);   // real frames run; while paused the director must not advance
  const afterFreeze = await page.evaluate(()=>{
    const d = window._APP.entityManager.Get('GameDirector').GetComponent('GameDirector').state;
    return { waveDelayTimer:+d.waveDelayTimer.toFixed(3), spawnTimer:+d.spawnTimer.toFixed(3), spawned:d.enemiesSpawned };
  });
  const frozen = JSON.stringify(beforePause)===JSON.stringify(afterFreeze);

  // Resume -> screen hides, paused false, world advances again.
  await page.evaluate(()=>window._APP.ResumeGame());
  const resumeShown = await vis(page,'pause-screen');
  const resumedPaused = await page.evaluate(()=>window._APP.paused);
  await sleep(1500);
  const afterResume = await page.evaluate(()=>window._APP.entityManager.Get('GameDirector').GetComponent('GameDirector').state.waveDelayTimer);
  const advanced = afterResume !== afterFreeze.waveDelayTimer;

  // Game over must NOT be treated as a pause.
  await page.evaluate(()=>{ window._APP.entityManager.Get('Player').GetComponent('PlayerHealth').health=0; });
  await sleep(700);
  const go = await page.evaluate(()=>({ playing: window._APP.playing, paused: window._APP.paused }));
  const goShown = await vis(page,'gameover-screen');
  const pauseHiddenAtGO = await vis(page,'pause-screen');

  const res = { atTitle, inGame, pausedState, pauseShown, frozen, resumeShown, resumedPaused, advanced, go, goShown, pauseHiddenAtGO };
  log(JSON.stringify(res,null,2));
  log('ERRORS('+errors.length+')', errors.slice(0,8));

  const pass = errors.length===0
    && atTitle.playing===false
    && inGame.playing===true && inGame.paused===false && inGame.menuOpen===false
    && pausedState.paused===true && pausedState.menuOpen===true && pauseShown==='shown' && frozen
    && resumeShown==='hidden' && resumedPaused===false && advanced
    && go.playing===false && go.paused===false && goShown==='shown' && pauseHiddenAtGO==='hidden';
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch(e){ log('HARNESS ERROR', e.stack||e.message); process.exitCode=2; }
finally { await browser.close(); }

// POC GameDirector probe: boot, then verify the M3 gameplay backbone —
//   (a) boot is clean and the director wired (spawner + player refs);
//   (b) director drives waves: currentWave advances to 1 and the spawner produces zombies;
//   (c) score/combo math matches gameLogic.js (streak-stepped multiplier, score += value*mult);
//   (d) combo decays to a hard reset after the 3s window;
//   (e) a wave clears + advances once its horde is all dead;
//   (f) player death → GameOver saves the high score.
//   PORT=8090 node tools/poc_gamedir_probe.mjs
const PORT = process.env.PORT || '8090';
const exe = process.env.CHROME_BIN ||
  'C:\\Users\\lbernier\\.cache\\puppeteer\\chrome\\win64-147.0.7727.56\\chrome-win64\\chrome.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--no-first-run','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const log = (...a)=>console.log(...a); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const page = await browser.newPage(); await page.setViewport({width:1280,height:720});
  const errors=[]; page.on('pageerror',e=>errors.push('PE:'+e.message)); page.on('console',m=>{if(m.type()==='error')errors.push('CE:'+m.text());});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'networkidle2',timeout:120000});
  await page.evaluate(()=>document.getElementById('btn-start')?.click());
  await page.waitForFunction(()=>window._APP?.entityManager?.entities.length>=2,{timeout:45000});
  await sleep(1500);

  const out = await page.evaluate(()=>{
    const em=window._APP.entityManager;
    const dir=em.Get('GameDirector')?.GetComponent('GameDirector');
    if(!dir) return { fatal:'no director' };
    dir.Reset();

    // (c) score/combo math — 20 kills of value 100, record the multiplier progression.
    const mults=[]; let scoreAt=[];
    for(let k=1;k<=20;k++){ dir.ReportKill(100, null); mults.push(dir.state.comboMultiplier); }
    const scoreAfter20 = dir.state.score;
    const maxMult = dir.state.maxComboMultiplier;

    // (d) combo decay — no kill for >3s resets streak+multiplier.
    dir.state.comboTimer = 3.0;
    dir.updateCombo(3.1);
    const decayReset = dir.state.killStreak===0 && dir.state.comboMultiplier===1;

    // (b) wave drive — run the director for ~5s of sim time; wave 1 starts + zombies spawn.
    dir.Reset();
    const zc = () => em.entities.filter(e=>e.GetComponent('ZombieController')).length;
    let spawnedDuringWave1 = 0;
    for(let i=0;i<60;i++){ dir.Update(0.1); spawnedDuringWave1 = Math.max(spawnedDuringWave1, zc()); }
    const waveAfterDrive = dir.state.currentWave;
    const toSpawnW1 = dir.state.enemiesToSpawn;

    // (e) wave advance — simulate clearing the current wave's horde.
    dir.state.enemiesSpawned = dir.state.enemiesToSpawn;
    dir.state.enemiesRemaining = 0;
    const waveBefore = dir.state.currentWave;
    dir.updateWaves(0.016);            // detects clear → waveActive false, sets delay
    dir.state.waveDelayTimer = 0.001;
    dir.updateWaves(0.01);             // delay elapses → next wave starts
    const waveAfterClear = dir.state.currentWave;

    // (f) game over — score set, player killed, saves high score.
    dir.Reset();
    dir.ReportKill(5000, null);        // push a score worth saving
    const scoreForGO = dir.state.score;
    const ph = em.Get('Player').GetComponent('PlayerHealth');
    ph.health = 0;
    dir.Update(0.016);
    const savedHS = (()=>{ try { return parseInt(localStorage.getItem('zombieBlasterHighScore')||'0',10);} catch(e){return -1;} })();

    return {
      hasDir:true, spawnerWired: !!dir.spawner, playerWired: !!dir.playerHealth,
      mults, scoreAfter20, maxMult,
      decayReset,
      waveAfterDrive, toSpawnW1, spawnedDuringWave1,
      waveBefore, waveAfterClear,
      scoreForGO, gameOver: dir.state.gameOver, savedHS,
    };
  });
  log(JSON.stringify(out,null,2));
  log('ERRORS('+errors.length+')', errors.slice(0,8));

  // Expected multiplier progression for streaks 1..20 (steps at 3/5/10/15/20).
  const expMults = Array.from({length:20},(_,i)=>{const s=i+1; return s>=20?8:s>=15?5:s>=10?4:s>=5?3:s>=3?2:1;});
  const multsOk = JSON.stringify(out.mults)===JSON.stringify(expMults);
  const pass = errors.length===0 && out.hasDir && out.spawnerWired && out.playerWired
    && multsOk && out.maxMult===8 && out.scoreAfter20>0
    && out.decayReset
    && out.waveAfterDrive>=1 && out.toSpawnW1===9 && out.spawnedDuringWave1>0   // 8 grunts + 1 wave-boss
    && out.waveAfterClear===out.waveBefore+1
    && out.gameOver && out.savedHS===out.scoreForGO;
  log('multsOk='+multsOk, 'expMults='+JSON.stringify(expMults));
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch(e){ log('HARNESS ERROR', e.stack||e.message); process.exitCode=2; }
finally { await browser.close(); }

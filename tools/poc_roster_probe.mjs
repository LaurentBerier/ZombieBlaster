// POC roster probe: verify ALL enemy character models load + spawn as their types with the
// right stats, and that the director fields a wave mix (grunts/fast/tank + a boss).
//   PORT=8090 SHOT=/path/prefix node tools/poc_roster_probe.mjs
const PORT = process.env.PORT || '8090';
const SHOT = process.env.SHOT || null;
const exe = process.env.CHROME_BIN ||
  'C:\\Users\\lbernier\\.cache\\puppeteer\\chrome\\win64-147.0.7727.56\\chrome-win64\\chrome.exe';
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--no-first-run','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const log = (...a)=>console.log(...a); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ALL = ['zombie','zombie_2','zombie_3','fast_zombie','tank_zombie','zombie_4','zombie_5'];
const SCALE = { zombie:1.0, zombie_2:1.0, zombie_3:1.0, fast_zombie:0.8, tank_zombie:1.4, zombie_4:1.8, zombie_5:1.8 };
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720 });
  const errors=[]; page.on('pageerror',e=>errors.push('PE:'+e.message)); page.on('console',m=>{if(m.type()==='error')errors.push('CE:'+m.text());});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'networkidle2',timeout:120000});
  await page.click('#btn-start');
  await page.waitForFunction(()=>window._APP?.entityManager?.entities.length>=2,{timeout:45000});
  await sleep(1500);

  // Drive the director through several waves; snapshot each zombie's type/model/skin/stats as
  // it appears, then confirm every model shows, all skin + have decal bones, and scales match.
  const waveMix = await page.evaluate(async () => {
    const em = window._APP.entityManager;
    const dir = em.Get('GameDirector').GetComponent('GameDirector');
    const sp = em.Get('ZombieSpawner').GetComponent('ZombieSpawner');
    dir.Reset();
    const seenTypes = new Set(), skinnedOK = {}, bonesOK = {}, scaleByType = {}, scoreByType = {};
    for (let i=0;i<1200;i++){
      dir.Update(0.08);
      for (const e of em.entities) {
        const c = e.GetComponent && e.GetComponent('ZombieController');
        if (!c || !c.stats || !c.stats.type) continue;
        const t = c.stats.type;
        seenTypes.add(t);
        skinnedOK[t] = skinnedOK[t] || !!c.skinnedMesh;
        bonesOK[t] = bonesOK[t] || (c.impactBones && c.impactBones.length > 0);
        scaleByType[t] = +c.bodyScale.toFixed(2);
        scoreByType[t] = c.scoreValue;
      }
      if (i % 35 === 34) em.entities.forEach(e=>{ const c=e.GetComponent&&e.GetComponent('ZombieController'); if(c&&c.alive){ c.health=0; c.Die({}); } });
    }
    return { models: Object.keys(sp.assetsByType), seenTypes:[...seenTypes].sort(), skinnedOK, bonesOK, scaleByType, scoreByType, wave: dir.state.currentWave };
  });
  log('WAVE MIX:', JSON.stringify(waveMix, null, 2));
  log('ERRORS('+errors.length+')', errors.slice(0,10));

  if (SHOT) {
    await page.evaluate((types, scale) => {
      const em = window._APP.entityManager;
      const sp = em.Get('ZombieSpawner').GetComponent('ZombieSpawner');
      em.entities.filter(e=>e.GetComponent('ZombieController')).forEach(e=>{ const c=e.GetComponent('ZombieController'); c.alive=false; c.dying=false; if(c.root.parent)c.root.parent.remove(c.root); });
      const player = em.Get('Player'); const px=player.Position.x, pz=player.Position.z;
      types.forEach((t,i)=>{ const c=sp.spawnType(t, { scale: scale[t], type: t }); if(c){ c.root.position.set(px-4.5+i*1.6, 0.167, pz-7); c.root.rotation.y = Math.PI; } });
    }, ALL, SCALE);
    await sleep(800);
    await page.screenshot({ path: SHOT + '_roster.png' }); log('shot -> ' + SHOT + '_roster.png');
  }

  const everySeen = ALL.every(t => waveMix.seenTypes.includes(t));
  const everySkinned = ALL.every(t => waveMix.skinnedOK[t]);
  const everyBones = ALL.every(t => waveMix.bonesOK[t]);
  const scalesOK = waveMix.scaleByType.fast_zombie===0.8 && waveMix.scaleByType.tank_zombie===1.4 && waveMix.scaleByType.zombie_4===1.8;
  const pass = errors.length===0 && waveMix.models.length===5 && everySeen && everySkinned && everyBones && scalesOK;
  log(`everySeen=${everySeen} everySkinned=${everySkinned} everyBones=${everyBones} scalesOK=${scalesOK}`);
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch(e){ log('HARNESS ERROR', e.stack||e.message); process.exitCode=2; }
finally { await browser.close(); }

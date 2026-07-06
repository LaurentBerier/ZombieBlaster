// POC evolution probe: verify score-gated weapon tiers + the fire-sound passthrough.
//   PORT=8090 node tools/poc_evolution_probe.mjs
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
    const wm=em.Get('Player').GetComponent('WeaponManager');
    wm.EquipWeapon(0);                       // Franken
    const snap = (score)=>{ wm.ApplyEvolution(score); const w=wm.active; return { name:w.name, damage:w.damage, fireRate:w.fireRate, color:'0x'+(w.projectileColor>>>0).toString(16) }; };
    return {
      sounds: wm.weapons.map(w=>w.sound),
      allHaveEvo: wm.weapons.every(w=>Array.isArray(w.evolutionLevels) && w.evolutionLevels.length===3),
      t0: snap(0), t2k: snap(2500), t5k: snap(6000),
      hudName: (()=>{ wm.ApplyEvolution(6000); return document.getElementById('weapon-name')?.innerText; })(),
    };
  });
  log(JSON.stringify(out,null,2));
  log('ERRORS('+errors.length+')', errors.slice(0,8));

  const pass = errors.length===0
    && JSON.stringify(out.sounds)===JSON.stringify(['weapon_tesla','weapon_fire_heavy','weapon_laser','weapon_laser'])
    && out.allHaveEvo
    && out.t0.name==='FRANKEN-GUN Mk.I' && out.t0.damage===15 && out.t0.fireRate===0.15
    && out.t2k.name==='FRANKEN-GUN Mk.II' && out.t2k.damage===22 && out.t2k.fireRate===0.12
    && out.t5k.name==='FRANKEN-GUN Mk.III' && out.t5k.damage===30 && out.t5k.fireRate===0.10
    && out.hudName==='FRANKEN-GUN Mk.III';
  log('\nRESULT: ' + (pass ? 'PASS ✅' : 'ISSUES ⚠️'));
  process.exitCode = pass ? 0 : 1;
} catch(e){ log('HARNESS ERROR', e.stack||e.message); process.exitCode=2; }
finally { await browser.close(); }

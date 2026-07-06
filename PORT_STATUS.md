# Zombie Blaster — TPS/FPS engine port: status & handoff

Rebuilding Zombie Blaster on the **ThreeJS_UE_TPS_FPS** engine (`D:\_Proj_src\Sandscape\Games\ThreeJS_UE_TPS_FPS`)
— its Entity/Component framework, Ammo.js physics, dual TPS/FPS spring-arm camera,
weapon aim-IK, and physics ragdoll — while keeping Zombie Blaster's content (funky
weapons, sprite FX, the zombies, the neon Silo).

- **Branch:** `feat/tps-fps-engine-port` (off `main`). ~10 commits.
- **Run:** `python serve.py` → http://127.0.0.1:8090/ → NEW GAME.
  (Controls: WASD, mouse look, Shift sprint, Space jump, **V** toggle TPS/FPS, LMB fire,
  **1–4 / wheel** switch weapon, R reload, `` ` `` weapon-placement tool.)
- **Headless verify:** `PORT=8090 node tools/poc_*.mjs` (boot / zombie / fire / arsenal /
  level / verify). Needs `serve.py` running. Uses `puppeteer-core` + cached Chrome.
  Note: headless runs ~4 FPS (software GL), so physics/anim settle slowly — a **test
  artifact only** (e.g. the player's `entity.Position.y` lags the real capsule body,
  which rests correctly on the floor at y≈0.95). Real framerate is fine.

## Architecture

Template engine is the **base**; the old flat zombie modules (`js/arena.js`,
`weapons.js`, `enemies.js`, `effects.js`, `decals.js`, `player.js`, `scene.js`,
`gameLogic.js`, `ui.js`, `main.js`, `assetLoader.js`) are kept as **reference** for the
remaining port and are NOT loaded. Original entry kept as `js/entry.reference.js`;
original zombie `index.html` kept as `index.zombie.html`.

Everything standardizes on the template's ES-module `three@0.127` (importmap in
`index.html`) + Ammo.js. Components conform to `Component` (`Initialize/Update/
PhysicsUpdate/Dispose`, `GetComponent/FindEntity/Broadcast`). Damage is decoupled:
`entity.Broadcast({topic:'hit', amount, from, knockbackDir, knockbackStrength, status})`
→ the target's `TakeHit`.

New/ported code (all under `js/entities/`):
- `Level/ArenaSetup.js` — builds the REAL level from `data/levelData.json` + kit prop GLBs; Ammo colliders; `ARENA` export (walls/spawnPoints/playerSpawn).
- `NPC/ZombieController.js` — a zombie as a component (walk/attack/death anims, direct-chase AI, status effects, **ragdoll on death** via template `NPC/Ragdoll.js`). `NPC/ZombieSpawner.js` maintains a live population.
- `Weapons/weaponDefs.js` — the 4-weapon registry. `Weapons/ProjectileSystem.js` — pooled sprite/mesh bolts, colored lights, AoE, sphere hit-test → `hit` broadcast.
- `Fx/Fx.js` — green-blood sprite-sheet impact burst.
- `Common/NeonMaterials.js` — shared toon/neon material helpers. `Common/UeMannequin.js` — `seatWeaponMesh` helper for the runtime gun swap.
- `js/entry.js` — bootstrap (physics, asset load incl. level props, entity wiring).

## DONE

- **Engine transplant** — template boots inside the repo (mannequin player, AK→funky guns, physics, TPS/FPS toggle, aim-IK).
- **Real level** — the actual `levelData.json` Silo: room shell + 73 kit-prop GLBs (CorridorKit/arenaKit) + designer colliders + fitted prop colliders + lights; player spawns at `playerSpawn`.
- **Zombies + ragdoll** — Zombie_1 chases (walk/attack/death crossfades) and **physics-ragdolls on death**; status effects (shock/freeze slow, burn/corrode DoT).
- **Full arsenal (M2)** — Franken-Gun / Bowling Launcher / Soda Laser / Cryo Blaster, switchable (1–4/wheel), each a distinct visible GLB on the hand at its own grip, own projectile type/colour/mag/knockback/status, rocket AoE. Franken grip tuned.
- **Hit FX** — green-blood sprite-sheet impact burst on hits.
- **Decal system** — DONE (both parts; see below). Verify with `tools/poc_decals_probe.mjs`.
- **M3 gameplay + identity** — DONE (see below). Verify with `tools/poc_gamedir_probe.mjs`,
  `poc_hud_probe.mjs`, `poc_evolution_probe.mjs`.

## WHAT'S LEFT

### ✅ Decal system (was "requested next") — DONE
Both parts ported and verified headless (0 shader-compile errors on r127; body splat rides
the ragdoll; bolts land on walls/floor instead of tunnelling):

1. **Enemy body decals** — `js/entities/Fx/Decals.js`, a `Component` on the `Level` entity.
   Ports the shader-projected SKINNED splats from the old `js/decals.js`: zombie materials
   patched via `onBeforeCompile` with 8 projector slots each, the projector rebuilt from the
   nearest bone's `matrixWorld` every frame (rides walk/attack + the death ragdoll). Fully
   PROCEDURAL comic-paint atlas (no art assets). Public API: `PrepareEnemy(zombie)`,
   `SpawnImpact(zombie, point, dir, type, opts)`, `DisposeEnemy(bodyGroup)`, `Update(dt)`.
   The unused static-target `DecalGeometry` path from the source was dropped (zombies are
   always skinned with `impactBones` → shader path); a curved bone-shell fallback is kept.
   Chose this over the template's `Common/BloodDecals.js` (generic red DecalGeometry blood)
   because the game's art wants per-weapon COLOURED opaque paint (green/burn/blue/cyan).
   Wiring: `ZombieController.buildModel` now populates `impactBones` (the handoff wrongly
   said it already did) + caches the `Decals` ref and calls `PrepareEnemy`/`DisposeEnemy`;
   `weaponDefs.js` now carries `fx.decalType` + `fx.decalScale` per gun (also was NOT there
   before — added: Franken→blood/1.0, Bowling→burn/1.7, Soda→plasma/0.9, Cryo→slime/1.0);
   `ProjectileSystem` hit block calls `SpawnImpact`.

2. **Wall / floor splats (environment)** — `Fx.SpawnEnvironmentSplat(pos, {normal, scale, blue})`
   ports `spawnFrankenImpactDecal` (pooled oriented plane, `Blood_decal_1/2.png`, RGB-rotated
   to blue for Soda; textures preloaded in `entry.js` as `decal1`/`decal2`). `ProjectileSystem.Update`
   now runs segment-vs-AABB / segment-vs-cylinder + ground-plane collision against `ARENA.walls`
   each frame (ported `segmentAABBEntryT` / `segmentCylinderEntryT` / `getWallImpactSurface` /
   `getCylinderImpactSurface`), so a bolt lands + splats where it hits and rockets detonate (AoE)
   on wall impact. Only the sprite-bullet guns (green Franken / blue Soda) leave env splats.

### ✅ M3 — gameplay + identity — DONE
Verified headless (0 errors) across `poc_gamedir_probe` / `poc_hud_probe` / `poc_evolution_probe`.
- **GameDirector** (`js/entities/Game/GameDirector.js`, on the `GameDirector` entity) — ports
  gameLogic.js score/combo + the enemies.js wave director. Score is `value*multiplier`; the
  killStreak-stepped multiplier (≥3→x2 … ≥20→x8) hard-resets after a 3s no-kill window; high
  score persists to `localStorage['zombieBlasterHighScore']`. Waves: `min(5+wave*3, 40)` zombies
  at `max(0.3, 1.5-wave*0.08)` cadence, 3s between waves, ENDLESS (death is the only game-over).
  `ZombieController.Die()` calls `ReportKill()`; `PlayerHealth.TakeHit()` calls `OnPlayerDamaged()`.
- **Wave-driven spawner** — `ZombieSpawner` now yields control to the director (its old timer is
  the director-less POC fallback); `spawnOne(stats)` takes per-wave scaled stats. NOTE: only
  Zombie_1 is loaded, so waves spawn the regular zombie scaled by wave; boss/fast/tank types land
  in M4.
- **HUD / menu identity** — `index.html` restored to the zombie markup (title/HUD/game-over/controls/
  loading/fade) on `css/style.css`; `UIManager` rewritten to drive score/combo/wave/health/ammo +
  the wave-announce banner + the game-over screen. `entry.js` onboarding rewired to the zombie
  screens (`title-screen`/`loading-screen`/`screen-fade`/`hud`/`gameover-screen`) with a working
  START → play → death → PLAY AGAIN / MAIN MENU flow. (Kept `#camera_mode`, written by PlayerControls.
  Also fixed: `PlayerHealth` never set `this.name`, so it was unfindable via `GetComponent`.)
- **Audio** (`js/entities/Audio/AudioManager.js`, on the `Audio` entity) — ports audio.js: procedural
  Web-Audio SFX (no sound files) + the 2-track music playlist via an `<audio>` element; mixer settings
  persist to `zb_audio_settings`. Wired: fire (per-weapon `sound`), hit_zombie, enemy_death+combo_ding,
  wave_start, player_hurt, weapon_switch, game_over (+ music start/stop). `Growl()` ported but not yet
  called (a polish hook).
- **Evolution tiers** — `weaponDefs.js` gains `evolutionLevels` (0/2000/5000 thresholds) + a `sound`
  key per gun; `WeaponManager.ApplyEvolution(score)` (polled from the director each frame) raises
  damage/fireRate, recolours the bolt, and renames the gun Mk.I/II/III. (Also fixed: `BuildLoadout`
  wasn't passing `sound` through to the `Weapon`.)

### M3 follow-ups (deferred, beyond the M3 spec)
- Pause screen + settings/audio-mixer overlay (markup + button wiring) — not in the current `index.html`.
- Ambient/attack zombie growls (call `AudioManager.Growl()` from `ZombieController`).
- Damage-number / kill popups / death-splat VFX; combo-pulse HUD animation; boss/wave-boss announces.

### ✅ Enemy roster (all zombie characters) — DONE
Verified via `tools/poc_roster_probe.mjs` (0 errors; all 5 models skin + spawn + carry decal
bones). All 5 zombie GLB sets (Zombie_1–5) load in entry.js as `zombieAssetsByType`; a new
`js/entities/NPC/enemyTypes.js` defines 7 types → models + per-wave stats + the wave mix:
- grunts **zombie / zombie_2 / zombie_3** (Zombie_1/2/3), **fast** (Zombie_1 @0.8), **tank**
  (Zombie_2 @1.4), and the wave-bosses **zombie_5** (wave 1 debut) + **zombie_4** (waves 2+),
  both @1.8. `ZombieController` gained per-type `bodyScale` (applied to bodyGroup, hit-flash
  relative to it) + scaled `hitCenterY`. `ZombieSpawner.spawnType(type, stats)` maps type→GLB set;
  `GameDirector` spawns the grunt horde (`pickRegularType`, tanks from w3 / fast from w2) then the
  wave-boss. Score/scale/skin all verified per type.
- Simplified vs original: the procedural 2.5× mega-BOSS (every 5th wave, no art) is skipped;
  the Zombie_4/5 bosses use strong-but-survivable melee (dmg 40) instead of the telegraphed
  9999 one-shot — porting the windup/dash-escape telegraph is a follow-up.

### Milestones after the roster
- **M4b — template enemies:** the template's beast (`CharacterController`) + UE soldier
  (`UeSoldierController`) as extra types. Needs an **arena navmesh** for the corridor
  (their AI is navmesh-driven) + factions + drop-weapon. Also give zombies an **Ammo hit
  capsule** (`CharacterFilter`, tagged `parentEntity`) so soldier hitscan can hit them
  (today only the projectile sphere-test finds zombies).
- **M5 — polish & cut:** remove the old flat `js/` + `entry.reference.js` + `index.zombie.html`;
  per-gun grip tuning for the 3 new guns (reuse the ` panel, paste into `weaponDefs.js`);
  explosion/acid-pool/liquid-splash visual FX; ADS reconcile; tune lighting/feel. (The other
  zombie types are now loaded — see the roster section above.)
- **M3 follow-ups:** pause + settings/audio-mixer overlay; zombie growls (`AudioManager.Growl()`
  from `ZombieController`); damage-number / kill popups / death-splat VFX; boss-incoming announce.

## Known artifacts / gotchas
- Headless ~4 FPS ⇒ slow settle; drive `stepSimulation` directly or wait longer in probes.
- Windows FS is case-insensitive: assets live under `assets/Characters/` (capital C) — keep
  code paths matching for case-sensitive hosting.
- `serve.py` runs on **8090** and auto-rolls if busy.

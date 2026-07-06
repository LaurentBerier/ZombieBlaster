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

## WHAT'S LEFT

### ⭐ Decal system (requested next) — NOT yet ported
Two parts, both currently missing:

1. **Enemy body decals (the crown jewel)** — the shader-projected SKINNED splats from
   the original `js/decals.js`: enemy materials patched via `onBeforeCompile` with up to
   8 projector slots each, rebuilt from the nearest bone's `matrixWorld` every frame, so
   the splat **rides the animation AND the ragdoll**. Port `decals.js` as a `Fx/Decals.js`
   component (or extend `Fx`): `prepareEnemyDecalMaterials(zombie)` on build
   (`ZombieController.buildModel` → call it), `spawnImpactDecal(zombie, point, dir, type)`
   on hit (`ProjectileSystem` hit block), `updateDecals(dt)` each frame, and
   `disposeEnemyDecalMaterials` on despawn. r127 chunk names (`<skinning_vertex>`,
   `<map_fragment>`, metalness) match r129, so the GLSL injection should port ~verbatim;
   a shell/DecalGeometry fallback exists in the source. The `ZombieController` already
   caches `impactBones` + `skinnedMesh` (the contract decals.js needs). Per-weapon
   `fx.decalType` (blood/burn/plasma/slime) is already in `weaponDefs.js`.

2. **Wall / floor splats (environment)** — bolts that hit a wall or the floor should stamp
   a coloured splat (green Franken / blue Soda), from the original `spawnFrankenImpactDecal`
   (`effects.js`, uses `assets/FX/Blood_decal_1.png` / `Blood_Decal_2.png`). Requires:
   - Port `spawnFrankenImpactDecal` into `Fx/Fx.js` (a pooled billboarded/oriented plane).
   - **Add wall/ground collision to the projectile flight** in `ProjectileSystem.Update`:
     bolts currently only die on `y<=0.03` / lifetime and **pass through walls**. Port the
     original segment-vs-AABB / segment-vs-cylinder tests against `ARENA.walls` (see
     `weapons.js` `segmentAABBEntryT` / `segmentCylinderEntryT`) so a bolt stamps a splat
     where it actually lands on a wall/prop/floor, then deactivates.

### Milestones after decals
- **M3 — gameplay + identity:** wave/combo/score/high-score (port `gameLogic.js` + the
  `enemies.js` wave/boss spawner into a `Game/GameDirector`); the Zombie Blaster HUD +
  title/menu screens + audio (SFX + the 2 music tracks) replacing the template's; game-over/
  retry. Unlocks weapon **evolution tiers** (they key off score).
- **M4 — new enemies:** the template's beast (`CharacterController`) + UE soldier
  (`UeSoldierController`) as extra types. Needs an **arena navmesh** for the corridor
  (their AI is navmesh-driven) + factions + drop-weapon. Also give zombies an **Ammo hit
  capsule** (`CharacterFilter`, tagged `parentEntity`) so soldier hitscan can hit them
  (today only the projectile sphere-test finds zombies).
- **M5 — polish & cut:** remove the old flat `js/` + `entry.reference.js` + `index.zombie.html`;
  load the other 4 zombie types (Z3/Z4/Z5 + fast/tank variants); per-gun grip tuning for the
  3 new guns (reuse the ` panel, paste into `weaponDefs.js`); explosion/acid-pool/liquid-splash
  visual FX; ADS reconcile; tune lighting/feel.

## Known artifacts / gotchas
- Headless ~4 FPS ⇒ slow settle; drive `stepSimulation` directly or wait longer in probes.
- Windows FS is case-insensitive: assets live under `assets/Characters/` (capital C) — keep
  code paths matching for case-sensitive hosting.
- `serve.py` runs on **8090** and auto-rolls if busy.

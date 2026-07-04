// ============================================
// ZOMBIE BLASTER: UNDERGROUND MONSTERS
// Main Game Module - Menu Boot, Lazy Loading & Game Loop
// ============================================

import {
    initUI, setGameRefs, updateHUD, bumpCombo, announceWave, announceBoss,
    showWeaponSwitch, showScreen, showSettingsOverlay, hideSettingsOverlay,
    showNewHighScore, updateLoadingBar, fadeIn, fadeOut, transitionToScreen,
} from './ui.js';

// Game states
const GAME_STATES = {
    TITLE: 'title',
    LOADING: 'loading',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'gameover',
};

let gameState = GAME_STATES.TITLE;
let frameCount = 0;
let transitionBusy = false;

let gameReady = false;
let gameLoadPromise = null;
let gameLoopStarted = false;
let threeLoadPromise = null;
let audioModulePromise = null;
let audioApi = null;

// Gameplay module references, filled only after the user starts a game.
let scene, camera, renderer, clock;
let buildArena, loadLevelData, collectCustomPropAssets;
let PLAYER, initPlayer, updatePlayer, damagePlayer, resetPlayer;
let requestPointerLock, exitPointerLock, getPlayerForward;
let WEAPON_DEFS, weaponState, initWeapons, updateWeapons, switchWeapon, resetWeapons;
let enemies, waveState, initEnemies, updateEnemies, updateWaves;
let damageEnemy, getAliveEnemies, resetEnemies, getEnemyHeadWorldPos;
let scoreState, initGameLogic, addKill, updateCombo, onPlayerDamaged;
let saveHighScore, updateTraps, resetGameLogic;
let initEffects, updateEffects, spawnPopup, spawnHitParticles;
let spawnDeathSplat, spawnGreenBloodImpact, spawnFrankenImpactDecal;
let spawnDamageNumber, spawnExplosion, spawnLiquidSplash;
let spawnAcidPool, getActiveAcidPools, triggerScreenShake, updateScreenShake;
let getScreenShakeOffset, showHitMarker, resetEffects;
let initDecals, updateDecals, resetDecals, spawnImpactDecal, prewarmDecals;
let preloadAssets;
let _scratchDir, _scratchHeadPos, _scratchImpactNormal;
let _scratchImpactDir, _scratchVisualHitPoint, _scratchFaceNormal;
let _projectedImpact;

let weaponSwitchInputBound = false;
let canvasPointerLockBound = false;

// ---- INITIALIZATION ----

function init() {
    initUI();
    setupMenuHandlers();
    showScreen('title');
    fadeIn(560);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setButtonsDisabled(disabled) {
    document.querySelectorAll('button').forEach(button => {
        button.disabled = disabled;
    });
}

async function runExclusive(work) {
    if (transitionBusy) return;
    transitionBusy = true;
    setButtonsDisabled(true);
    try {
        await work();
    } finally {
        setButtonsDisabled(false);
        transitionBusy = false;
    }
}

// ---- LIGHTWEIGHT MENU HANDLERS ----

function setupMenuHandlers() {
    document.getElementById('btn-start').addEventListener('click', () => {
        runExclusive(beginStartGame);
    });
    document.getElementById('btn-controls').addEventListener('click', () => {
        runExclusive(() => transitionToScreen('controls'));
    });
    document.getElementById('btn-close-controls').addEventListener('click', () => {
        runExclusive(() => transitionToScreen('title'));
    });

    document.getElementById('btn-resume').addEventListener('click', () => {
        runExclusive(resumeGame);
    });
    document.getElementById('btn-quit').addEventListener('click', () => {
        runExclusive(quitToMenu);
    });

    document.getElementById('btn-retry').addEventListener('click', () => {
        runExclusive(beginStartGame);
    });
    document.getElementById('btn-menu').addEventListener('click', () => {
        runExclusive(quitToMenu);
    });

    setupSettingsHandlers();

    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Escape') return;
        if (gameState === GAME_STATES.PLAYING) {
            if (!document.pointerLockElement) pauseGame();
        } else if (gameState === GAME_STATES.PAUSED) {
            runExclusive(resumeGame);
        }
    });

    document.addEventListener('pointerlockchange', () => {
        if (!document.pointerLockElement && gameState === GAME_STATES.PLAYING) {
            pauseGame();
        }
    });
}

function setupSettingsHandlers() {
    const muteEl = document.getElementById('set-mute');
    const musicEl = document.getElementById('set-music');
    const sfxEl = document.getElementById('set-sfx');
    const musicVal = document.getElementById('set-music-val');
    const sfxVal = document.getElementById('set-sfx-val');

    async function syncControls() {
        const audio = await loadAudioModule();
        audio.initAudio();
        audio.resumeAudio();
        const settings = audio.getAudioSettings();
        muteEl.checked = settings.muted;
        musicEl.value = Math.round(settings.musicVolume * 100);
        sfxEl.value = Math.round(settings.sfxVolume * 100);
        musicVal.textContent = musicEl.value + '%';
        sfxVal.textContent = sfxEl.value + '%';
    }

    async function openSettings() {
        await fadeOut(260);
        await syncControls();
        showSettingsOverlay();
        await fadeIn(360);
    }

    async function closeSettings() {
        await fadeOut(260);
        hideSettingsOverlay();
        await fadeIn(360);
    }

    musicEl.addEventListener('input', async () => {
        const audio = await loadAudioModule();
        audio.setMusicVolume(musicEl.value / 100);
        musicVal.textContent = musicEl.value + '%';
    });
    sfxEl.addEventListener('input', async () => {
        const audio = await loadAudioModule();
        audio.initAudio();
        audio.resumeAudio();
        audio.setSfxVolume(sfxEl.value / 100);
        sfxVal.textContent = sfxEl.value + '%';
        audio.playSFX('weapon_switch');
    });
    muteEl.addEventListener('change', async () => {
        const audio = await loadAudioModule();
        audio.setMuted(muteEl.checked);
    });

    document.getElementById('btn-settings').addEventListener('click', () => {
        runExclusive(openSettings);
    });
    document.getElementById('btn-settings-pause').addEventListener('click', () => {
        runExclusive(openSettings);
    });
    document.getElementById('btn-close-settings').addEventListener('click', () => {
        runExclusive(closeSettings);
    });
}

async function loadAudioModule() {
    if (!audioModulePromise) {
        audioModulePromise = import('./audio.js');
    }
    audioApi = await audioModulePromise;
    return audioApi;
}

function playSFXSafe(soundName) {
    if (audioApi) audioApi.playSFX(soundName);
}

// ---- LAZY GAME LOAD ----

async function beginStartGame() {
    const needsLoading = !gameReady;

    await fadeOut(320);
    if (needsLoading) {
        gameState = GAME_STATES.LOADING;
        updateLoadingBar(0, 'STARTING THE SILO...');
        showScreen('loading');
        await fadeIn(420);

        try {
            await ensureGameReady();
        } catch (err) {
            console.error('Game initialization failed:', err);
            updateLoadingBar(0, 'ERROR: ' + err.message);
            const loadingText = document.getElementById('loading-text');
            if (loadingText) loadingText.style.color = '#FF3B30';
            await fadeIn(240);
            return;
        }

        await fadeOut(320);
    }

    startGame();
    await fadeIn(520);
}

function ensureGameReady() {
    if (gameReady) return Promise.resolve();
    if (!gameLoadPromise) {
        gameLoadPromise = loadGameRuntime();
    }
    return gameLoadPromise;
}

async function loadGameRuntime() {
    updateLoadingBar(1, 'LOADING ENGINE...');
    await loadThreeScript();

    updateLoadingBar(3, 'LOADING GAME CODE...');
    const [
        sceneModule,
        arenaModule,
        playerModule,
        weaponsModule,
        enemiesModule,
        gameLogicModule,
        effectsModule,
        decalsModule,
        assetLoaderModule,
        audioModule,
    ] = await Promise.all([
        import('./scene.js'),
        import('./arena.js'),
        import('./player.js'),
        import('./weapons.js'),
        import('./enemies.js'),
        import('./gameLogic.js'),
        import('./effects.js'),
        import('./decals.js'),
        import('./assetLoader.js'),
        loadAudioModule(),
    ]);

    wireGameModules({
        sceneModule,
        arenaModule,
        playerModule,
        weaponsModule,
        enemiesModule,
        gameLogicModule,
        effectsModule,
        decalsModule,
        assetLoaderModule,
        audioModule,
    });

    updateLoadingBar(5, 'INITIALIZING RENDERER...');
    try {
        sceneModule.initScene();
        ({ scene, camera, renderer, clock } = sceneModule);
        setupCanvasPointerLock();
    } catch (sceneErr) {
        updateLoadingBar(0, 'ERROR: ' + sceneErr.message);
        throw sceneErr;
    }

    updateLoadingBar(7, 'READING LEVEL DATA...');
    const levelData = await loadLevelData();
    const customPropAssets = collectCustomPropAssets(levelData);
    updateLoadingBar(9, 'GATHERING ASSETS...');

    const ASSET_BAR_START = 9;
    const ASSET_BAR_SPAN = 76;
    await preloadAssets({
        extras: customPropAssets,
        onProgress: ({ done, total, currentName, bytesLoaded, bytesTotal }) => {
            const bytesFraction = bytesTotal > 0 ? (bytesLoaded / bytesTotal) : 0;
            const fileFraction = total > 0 ? (done / total) : 1;
            const blended = total === 0
                ? 1
                : Math.min(1, fileFraction * 0.7 + bytesFraction * 0.3);
            const pct = ASSET_BAR_START + blended * ASSET_BAR_SPAN;
            updateLoadingBar(pct, formatAssetProgress(currentName, done, total, bytesLoaded, bytesTotal));
        },
    });
    updateLoadingBar(85, 'BUILDING THE SILO...');

    await buildArena(levelData);
    updateLoadingBar(89, 'WAKING THE DEAD...');

    initPlayer();
    updateLoadingBar(92, 'LOADING ARSENAL...');

    initWeapons();
    updateLoadingBar(94, 'SPAWNING MONSTERS...');

    initEnemies();
    updateLoadingBar(96, 'PREPARING TRAPS...');

    initGameLogic(levelData?.traps);
    updateLoadingBar(97, 'ADDING EXPLOSIONS...');

    initEffects();
    initDecals();
    prewarmRenderer();
    updateLoadingBar(99, 'TUNING AUDIO...');

    audioApi.initAudio();
    updateLoadingBar(100, 'READY!');

    setupWeaponSwitchInput();
    gameReady = true;
    startGameLoop();
    await delay(240);
}

// Compile every shader the game will use before gameplay starts, so the first
// bullet/impact/explosion doesn't hitch while its GLSL program links mid-frame.
// The projectile + effect pools (and the bullet lights) are already in the scene;
// we also spawn one throwaway decal far off-screen so its dynamically-built
// material is compiled too. renderer.compile() links all scene material programs
// for the current (now stable) light set; the warm render uploads GPU buffers.
function prewarmRenderer() {
    try {
        spawnFrankenImpactDecal(new THREE.Vector3(0, -500, 0), {
            normal: new THREE.Vector3(0, 1, 0), scale: 0.5, lifetime: 0.001,
        });
        prewarmDecals();
        renderer.compile(scene, camera);
        renderer.render(scene, camera);
    } catch (e) {
        console.warn('[prewarm] shader precompile skipped:', e);
    }
}

function loadThreeScript() {
    if (window.THREE) return Promise.resolve();
    if (threeLoadPromise) return threeLoadPromise;

    threeLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'js/lib/three.min.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Could not load Three.js'));
        document.head.appendChild(script);
    });

    return threeLoadPromise;
}

function wireGameModules(modules) {
    const {
        sceneModule, arenaModule, playerModule, weaponsModule, enemiesModule,
        gameLogicModule, effectsModule, decalsModule, assetLoaderModule,
    } = modules;

    ({ scene, camera, renderer, clock } = sceneModule);
    ({ buildArena, loadLevelData, collectCustomPropAssets } = arenaModule);
    ({
        PLAYER, initPlayer, updatePlayer, damagePlayer, resetPlayer,
        requestPointerLock, exitPointerLock, getPlayerForward,
    } = playerModule);
    ({
        WEAPON_DEFS, weaponState, initWeapons, updateWeapons,
        switchWeapon, resetWeapons,
    } = weaponsModule);
    ({
        enemies, waveState, initEnemies, updateEnemies, updateWaves,
        damageEnemy, getAliveEnemies, resetEnemies, getEnemyHeadWorldPos,
    } = enemiesModule);
    ({
        scoreState, initGameLogic, addKill, updateCombo, onPlayerDamaged,
        saveHighScore, updateTraps, resetGameLogic,
    } = gameLogicModule);
    ({
        initEffects, updateEffects, spawnPopup, spawnHitParticles,
        spawnDeathSplat, spawnGreenBloodImpact, spawnFrankenImpactDecal,
        spawnDamageNumber, spawnExplosion, spawnLiquidSplash,
        spawnAcidPool, getActiveAcidPools, triggerScreenShake, updateScreenShake,
        getScreenShakeOffset, showHitMarker, resetEffects,
    } = effectsModule);
    ({
        initDecals, updateDecals, resetDecals, spawnImpactDecal, prewarmDecals,
    } = decalsModule);
    ({ preloadAssets } = assetLoaderModule);

    _scratchDir = new THREE.Vector3();
    _scratchHeadPos = new THREE.Vector3();
    _scratchImpactNormal = new THREE.Vector3();
    _scratchImpactDir = new THREE.Vector3();
    _scratchVisualHitPoint = new THREE.Vector3();
    _scratchFaceNormal = new THREE.Vector3();
    _projectedImpact = {
        position: new THREE.Vector3(),
        normal: new THREE.Vector3(),
    };

    setGameRefs({
        PLAYER,
        weaponState,
        WEAPON_DEFS,
        getCurrentEvolution: weaponsModule.getCurrentEvolution,
        scoreState,
        waveState,
    });
}

function setupCanvasPointerLock() {
    if (canvasPointerLockBound) return;
    const canvas = document.querySelector('canvas');
    if (!canvas) return;

    canvasPointerLockBound = true;
    canvas.addEventListener('click', () => {
        if (gameState === GAME_STATES.PLAYING) {
            requestPointerLock();
            audioApi?.resumeAudio();
        }
    });
}

function setupWeaponSwitchInput() {
    if (weaponSwitchInputBound) return;
    weaponSwitchInputBound = true;

    document.addEventListener('keydown', (e) => {
        if (gameState !== GAME_STATES.PLAYING) return;

        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 4) {
            switchWeapon(num - 1);
            showWeaponSwitch(num - 1);
            playSFXSafe('weapon_switch');
        }
    });

    document.addEventListener('wheel', (e) => {
        if (gameState !== GAME_STATES.PLAYING) return;

        const dir = e.deltaY > 0 ? 1 : -1;
        const newIdx = (weaponState.currentIndex + dir + WEAPON_DEFS.length) % WEAPON_DEFS.length;
        switchWeapon(newIdx);
        showWeaponSwitch(newIdx);
        playSFXSafe('weapon_switch');
    });
}

// Human-readable progress line for the loading screen.
function formatAssetProgress(name, done, total, bytesLoaded, bytesTotal) {
    const count = total > 0 ? `  (${Math.min(done + 1, total)}/${total})` : '';
    const bytes = bytesTotal > 0
        ? `  ${formatBytes(bytesLoaded)} / ${formatBytes(bytesTotal)}`
        : '';
    return `LOADING ${name}${count}${bytes}`;
}

function formatBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
}

// ---- GAME STATE TRANSITIONS ----

function startGame() {
    resetPlayer();
    resetWeapons();
    resetEnemies();
    resetGameLogic();
    resetEffects();
    resetDecals();

    if (clock) clock.getDelta();
    gameState = GAME_STATES.PLAYING;
    showScreen('gameplay');
    requestPointerLock();

    audioApi.initAudio();
    audioApi.resumeAudio();
    audioApi.nextMusicTrack();

    setTimeout(() => announceWave(1), 1000);
}

async function pauseGame() {
    if (gameState !== GAME_STATES.PLAYING) return;
    gameState = GAME_STATES.PAUSED;
    exitPointerLock();
    await transitionToScreen('pause', { outDuration: 260, inDuration: 360 });
}

async function resumeGame() {
    if (!gameReady) return;
    gameState = GAME_STATES.PLAYING;
    requestPointerLock();
    audioApi?.startMusic();
    await transitionToScreen('gameplay', { outDuration: 260, inDuration: 360 });
}

async function gameOver() {
    if (gameState === GAME_STATES.GAME_OVER) return;
    gameState = GAME_STATES.GAME_OVER;
    exitPointerLock();
    audioApi?.stopMusic();
    playSFXSafe('game_over');

    const isNewHighScore = saveHighScore();
    await fadeOut(480);
    showScreen('gameover');
    showNewHighScore(isNewHighScore);
    await fadeIn(560);
}

async function quitToMenu() {
    if (gameReady) exitPointerLock();
    gameState = GAME_STATES.TITLE;
    await fadeOut(320);
    showScreen('title');
    audioApi?.startMusic();
    await fadeIn(420);
}

// ---- GAME LOOP ----

function startGameLoop() {
    if (gameLoopStarted) return;
    gameLoopStarted = true;
    requestAnimationFrame(gameLoop);
}

function gameLoop() {
    requestAnimationFrame(gameLoop);
    if (!gameReady) return;

    const dt = Math.min(clock.getDelta(), 0.05);
    frameCount++;

    switch (gameState) {
        case GAME_STATES.PLAYING:
            updateGameplay(dt);
            break;
        case GAME_STATES.PAUSED:
            break;
        case GAME_STATES.TITLE:
        case GAME_STATES.GAME_OVER:
            camera.position.set(
                Math.sin(frameCount * 0.002) * 15,
                8,
                Math.cos(frameCount * 0.002) * 15
            );
            camera.lookAt(0, 2, 0);
            break;
    }

    const shakeOffset = getScreenShakeOffset();
    camera.position.add(shakeOffset);
    renderer.render(scene, camera);
    camera.position.sub(shakeOffset);
}

function updateGameplay(dt) {
    const aliveEnemies = getAliveEnemies();

    updatePlayer(dt, aliveEnemies);
    updateWeapons(dt, aliveEnemies, onWeaponHit);
    updateEnemies(dt, onEnemyAttackPlayer, onStatusKill);
    applyAcidPoolTicks(dt, aliveEnemies);

    updateWaves(dt, onWaveStart, onBossWave);

    const trapDamage = updateTraps(dt, aliveEnemies);
    if (trapDamage > 0) {
        damagePlayer(trapDamage);
        onPlayerDamaged();
        playSFXSafe('player_hurt');
    }

    updateCombo(dt);
    updateEffects(dt);
    updateDecals(dt);
    updateScreenShake(dt);
    updateHUD();

    if (!PLAYER.isAlive) {
        gameOver();
    }
}

// ---- CALLBACKS ----

function resolveImpactDirection(hitContext) {
    if (hitContext.impactDir && hitContext.impactDir.lengthSq() > 0.0001) {
        _scratchImpactDir.copy(hitContext.impactDir);
    } else {
        _scratchImpactDir.copy(getPlayerForward());
    }
    if (_scratchImpactDir.lengthSq() < 0.0001) _scratchImpactDir.set(0, 0, -1);
    return _scratchImpactDir.normalize();
}

// Approximate world-space impact surface on the enemy's bounding cylinder:
// the shooter-facing point at the hit height. Used to position burst FX
// (particles, green blood flash, splashes). The DecalManager does its own,
// finer projection (nearest bone / mesh raycast) for the stamped decal.
function projectEnemyImpact(enemy, fallbackPoint, impactDir) {
    // Clamp to the enemy's body (feet..head-top ≈ 2× the hit-volume centre) so head
    // shots on the big bosses stamp the head instead of being pulled down to the torso.
    const bodyTop = (enemy.hitCenterY ?? 1.0) * 2;
    const bodyY = Math.max(0.45, Math.min(fallbackPoint.y, bodyTop));
    _scratchFaceNormal.copy(impactDir).setY(0);
    if (_scratchFaceNormal.lengthSq() < 0.0001) {
        _scratchFaceNormal.copy(impactDir);
    }
    _scratchFaceNormal.normalize();
    _scratchVisualHitPoint.copy(enemy.root.position);
    _scratchVisualHitPoint.y = bodyY;
    _scratchVisualHitPoint.addScaledVector(_scratchFaceNormal, -(enemy.hitRadius || 0.7));

    _projectedImpact.position.copy(_scratchVisualHitPoint);
    _projectedImpact.normal.copy(impactDir).multiplyScalar(-1).normalize();
    return _projectedImpact;
}

function onWeaponHit(enemy, hitPoint, damage, weaponIndex, hitContext = {}) {
    const weapon = WEAPON_DEFS[weaponIndex];
    const fx = weapon.fx || {};
    const hitColor = weapon.projectileColor || weapon.color;

    _scratchDir.copy(getPlayerForward()).setY(0);
    if (hitContext.fromSplash && hitContext.splashCenter) {
        _scratchDir.copy(enemy.root.position).sub(hitContext.splashCenter).setY(0);
    }
    if (_scratchDir.lengthSq() < 0.0001) _scratchDir.set(0, 0, 1);
    _scratchDir.normalize();

    const impactDir = resolveImpactDirection(hitContext);
    const projectedImpact = projectEnemyImpact(enemy, hitPoint, impactDir);

    const knockbackStrength = hitContext.fromSplash
        ? (fx.knockback || 0) * 0.6
        : (fx.knockback || 0);

    const killed = damageEnemy(enemy, damage, {
        element: fx.element,
        knockbackDir: _scratchDir,
        knockbackStrength,
        statusEffect: fx.status ? { ...fx.status, weaponIndex } : null,
    });

    showHitMarker();
    playSFXSafe('hit_zombie');

    const particleCount = fx.hitParticles ?? 6;
    if (particleCount > 0) {
        spawnHitParticles(projectedImpact.position, hitColor, killed ? particleCount + 6 : particleCount);
    }

    _scratchImpactNormal.copy(projectedImpact.normal);
    spawnGreenBloodImpact(projectedImpact.position, { normal: _scratchImpactNormal, scale: killed ? 1.05 : 0.78 });
    if (!hitContext.fromSplash) {
        // Projected impact decal on the enemy body, typed and sized per weapon
        // (blood / burn / acid / slime). The DecalManager projects onto the
        // surface, caps counts, fades, and cleans up on despawn. A killing
        // blow stamps a bigger multi-splat burst for a satisfying gib.
        const decalScale = fx.decalScale ?? 1;
        spawnImpactDecal(enemy, projectedImpact.position, impactDir, fx.decalType || 'blood', killed
            ? { scaleMult: decalScale * 1.35, count: 3, ignoreThrottle: true }
            : { scaleMult: decalScale });
    }

    if (!hitContext.fromSplash || killed) {
        const isCritDmg = damage >= enemy.maxHealth * 0.5;
        const headPos = getEnemyHeadWorldPos(enemy, _scratchHeadPos);
        spawnDamageNumber(headPos, damage, isCritDmg || (killed && scoreState.comboMultiplier >= 3));
    }

    const shake = killed ? (fx.killShake || fx.shake) : fx.shake;
    if (shake && !hitContext.fromSplash) {
        triggerScreenShake(shake.amp, shake.duration);
    }

    if (killed) {
        addKill(enemy.scoreValue);
        bumpCombo();
        playSFXSafe('enemy_death');
        playSFXSafe('combo_ding');
        spawnDeathSplat(projectedImpact.position);
        const isCritical = scoreState.comboMultiplier >= 3;
        spawnPopup(getEnemyHeadWorldPos(enemy, _scratchHeadPos), isCritical);
    }

    if (!hitContext.fromSplash) {
        if (fx.splash === 'explosion') {
            spawnExplosion(projectedImpact.position, fx.explosionRadius || weapon.aoeRadius || 3.0, hitColor);
        } else if (fx.splash === 'liquid') {
            spawnLiquidSplash(projectedImpact.position, hitColor, fx.splashCount || 8);
            if (fx.acidPoolChance && Math.random() < fx.acidPoolChance) {
                spawnAcidPool(
                    projectedImpact.position,
                    fx.acidPoolRadius || 1.2,
                    fx.acidPoolDuration || 2.0,
                    hitColor,
                    fx.acidPoolDps || 5
                );
            }
        }
    }
}

function onStatusKill(enemy, hitPoint, weaponIndex) {
    addKill(enemy.scoreValue);
    bumpCombo();
    playSFXSafe('enemy_death');
    playSFXSafe('combo_ding');
    spawnDeathSplat(hitPoint);
    spawnPopup(getEnemyHeadWorldPos(enemy, _scratchHeadPos), scoreState.comboMultiplier >= 3);
}

const ACID_TICK_INTERVAL = 0.25;
function applyAcidPoolTicks(dt, aliveEnemies) {
    const pools = getActiveAcidPools();
    if (pools.length === 0) return;
    pools.forEach(pool => {
        if (pool.tickTimer < ACID_TICK_INTERVAL) return;
        pool.tickTimer = 0;
        const r2 = pool.radius * pool.radius;
        aliveEnemies.forEach(enemy => {
            const dx = enemy.root.position.x - pool.position.x;
            const dz = enemy.root.position.z - pool.position.z;
            if (dx * dx + dz * dz > r2) return;
            const killed = damageEnemy(enemy, pool.dps * ACID_TICK_INTERVAL, {
                element: 'acid',
                statusEffect: { type: 'corrode', duration: 0.6, dps: 0, weaponIndex: 2 },
            });
            if (killed) onStatusKill(enemy, enemy.root.position.clone().setY(1), 2);
        });
    });
}

function onEnemyAttackPlayer(damage) {
    damagePlayer(damage);
    onPlayerDamaged();
    playSFXSafe('player_hurt');
}

function onWaveStart(waveNumber) {
    announceWave(waveNumber);
    playSFXSafe('wave_start');
}

function onBossWave(waveNumber) {
    setTimeout(() => {
        announceBoss();
        playSFXSafe('boss_appear');
    }, 1500);
}

// ---- BOOT ----

init();

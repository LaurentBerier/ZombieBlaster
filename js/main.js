// ============================================
// ZOMBIE BLASTER: UNDERGROUND MONSTERS
// Main Game Module - Initialization & Game Loop
// ============================================

import { scene, camera, renderer, clock, initScene } from './scene.js';
import { buildArena, loadLevelData, collectCustomPropAssets, ARENA } from './arena.js';
import {
    PLAYER, keys, initPlayer, updatePlayer, damagePlayer, resetPlayer,
    requestPointerLock, exitPointerLock, getPlayerForward,
} from './player.js';
import {
    WEAPON_DEFS, weaponState, initWeapons, updateWeapons,
    switchWeapon, resetWeapons,
} from './weapons.js';
import {
    enemies, waveState, initEnemies, updateEnemies, updateWaves,
    damageEnemy, getAliveEnemies, resetEnemies, getEnemyHeadWorldPos,
} from './enemies.js';
import {
    scoreState, initGameLogic, addKill, updateCombo, onPlayerDamaged,
    saveHighScore, updateTraps, resetGameLogic,
} from './gameLogic.js';
import {
    initEffects, updateEffects, spawnPopup, spawnHitParticles,
    spawnDeathSplat, spawnDamageNumber, spawnExplosion,
    spawnLiquidSplash, spawnAcidPool, getActiveAcidPools,
    triggerScreenShake, updateScreenShake, getScreenShakeOffset,
    showHitMarker, resetEffects,
} from './effects.js';
import {
    initAudio, resumeAudio, playSFX, startMusic, stopMusic, nextMusicTrack,
    setMusicVolume, setSfxVolume, setMuted, getAudioSettings,
} from './audio.js';
import {
    initUI, updateHUD, bumpCombo, announceWave, announceBoss,
    showWeaponSwitch, showScreen, showNewHighScore, updateLoadingBar,
} from './ui.js';
import { preloadAssets } from './assetLoader.js';

// Scratch vector reused each frame — avoid per-call allocations in hot path.
const _scratchDir = new THREE.Vector3();
const _scratchHeadPos = new THREE.Vector3();

// Game states
const GAME_STATES = {
    LOADING: 'loading',
    TITLE: 'title',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'gameover',
};

let gameState = GAME_STATES.LOADING;
let frameCount = 0;

// ---- INITIALIZATION ----

async function init() {
    // Init UI first so screen management works
    initUI();
    showScreen('loading');
    updateLoadingBar(0, 'INITIALIZING...');

    // Arm music autostart immediately so the entire loading screen is covered:
    // the first click/keypress at any point — during loading or on the menu —
    // starts the soundtrack the moment the browser's autoplay gate opens.
    armMusicAutostart();
    // Also attempt playback right now, during loading. On visits where the
    // browser already permits autoplay (its per-site engagement heuristic) this
    // starts the music with no click; on a fresh visit it's blocked and the
    // armed listener above starts it on the first interaction instead.
    ensureMusicStarted();

    // Small delay so the first paint reaches the screen before we start work
    await delay(50);

    // ---- Phase 1: renderer + scene graph (3%) ----
    try {
        initScene();
    } catch (sceneErr) {
        updateLoadingBar(0, 'ERROR: ' + sceneErr.message);
        throw sceneErr;
    }
    updateLoadingBar(3, 'READING LEVEL DATA...');

    // ---- Phase 2: level data (3% -> 7%) ----
    // Fetched up front so the asset loader can include the level's
    // designer-imported custom-prop GLBs in its preload pass.
    const levelData = await loadLevelData();
    const customPropAssets = collectCustomPropAssets(levelData);
    updateLoadingBar(7, 'GATHERING ASSETS...');

    // ---- Phase 3: preload every GLB (7% -> 85%) ----
    // The bar within this phase is driven by per-file load events, and the
    // text line shows the current file, the N-of-M count, and byte progress
    // when the server reports Content-Length.
    const ASSET_BAR_START = 7;
    const ASSET_BAR_SPAN = 78;
    await preloadAssets({
        extras: customPropAssets,
        onProgress: ({ done, total, currentName, bytesLoaded, bytesTotal }) => {
            // Weight done-files plus in-flight byte progress, so the bar
            // advances smoothly even while large GLBs stream in.
            const bytesFraction = bytesTotal > 0 ? (bytesLoaded / bytesTotal) : 0;
            const fileFraction = total > 0 ? (done / total) : 1;
            // 70% of the phase tracks completed files, 30% tracks bytes in flight.
            const blended = total === 0
                ? 1
                : Math.min(1, fileFraction * 0.7 + bytesFraction * 0.3);
            const pct = ASSET_BAR_START + blended * ASSET_BAR_SPAN;
            updateLoadingBar(pct, formatAssetProgress(currentName, done, total, bytesLoaded, bytesTotal));
        },
    });
    updateLoadingBar(ASSET_BAR_START + ASSET_BAR_SPAN, 'BUILDING THE SILO...');

    // ---- Phase 4: build arena from cached assets (fully synchronous now) ----
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
    updateLoadingBar(99, 'TUNING AUDIO...');

    initAudio();
    updateLoadingBar(100, 'READY!');

    // Setup input handlers for menus
    setupMenuHandlers();

    // Setup weapon switch keys
    setupWeaponSwitchInput();

    // Short delay so the user sees the "READY!" state, then show title
    await delay(500);
    gameState = GAME_STATES.TITLE;
    showScreen('title');

    // Try to start the soundtrack as the menu appears. This succeeds with no
    // click on revisits where the browser has granted engagement-based autoplay;
    // on a fresh visit it's blocked, and the listener armed at init() start will
    // kick it off on the user's first interaction instead.
    ensureMusicStarted();

    // Start game loop
    requestAnimationFrame(gameLoop);
}

// Kick off the soundtrack as early as the browser allows.
function ensureMusicStarted() {
    resumeAudio();
    startMusic();
}

let musicAutostartArmed = false;
function armMusicAutostart() {
    if (musicAutostartArmed) return;
    musicAutostartArmed = true;
    const kick = () => {
        ensureMusicStarted();
        window.removeEventListener('pointerdown', kick);
        window.removeEventListener('keydown', kick);
    };
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
}

// Human-readable progress line for the loading screen.
// Examples:
//   "LOADING Zombie_1_Unsteady_Walk_withSkin.glb  (7/28)  0.8 / 2.4 MB"
//   "LOADING Floor_Metal_1.glb  (12/28)"
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

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- MENU HANDLERS ----

function setupMenuHandlers() {
    // Title screen
    document.getElementById('btn-start').addEventListener('click', startGame);
    document.getElementById('btn-controls').addEventListener('click', () => showScreen('controls'));
    document.getElementById('btn-close-controls').addEventListener('click', () => showScreen('title'));

    // Pause screen
    document.getElementById('btn-resume').addEventListener('click', resumeGame);
    document.getElementById('btn-quit').addEventListener('click', quitToMenu);

    // Game over screen
    document.getElementById('btn-retry').addEventListener('click', startGame);
    document.getElementById('btn-menu').addEventListener('click', quitToMenu);

    // Audio settings (reachable from title and pause)
    setupSettingsHandlers();

    // ESC for pause
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Escape') {
            if (gameState === GAME_STATES.PLAYING) {
                pauseGame();
            } else if (gameState === GAME_STATES.PAUSED) {
                resumeGame();
            }
        }
    });

    // Click canvas to re-lock pointer during gameplay
    const canvas = document.querySelector('canvas');
    if (canvas) {
        canvas.addEventListener('click', () => {
            if (gameState === GAME_STATES.PLAYING) {
                requestPointerLock();
                resumeAudio();
            }
        });
    }
}

// Audio settings overlay — mute toggle + music/SFX volume sliders. Opened from
// the title and pause menus; closing just hides the overlay so the screen
// underneath (title or pause) stays put.
function setupSettingsHandlers() {
    const overlay = document.getElementById('settings-overlay');
    const muteEl = document.getElementById('set-mute');
    const musicEl = document.getElementById('set-music');
    const sfxEl = document.getElementById('set-sfx');
    const musicVal = document.getElementById('set-music-val');
    const sfxVal = document.getElementById('set-sfx-val');
    if (!overlay) return;

    // Mirror the live audio settings onto the controls (called on open so the
    // sliders reflect persisted/localStorage values).
    function syncControls() {
        const s = getAudioSettings();
        muteEl.checked = s.muted;
        musicEl.value = Math.round(s.musicVolume * 100);
        sfxEl.value = Math.round(s.sfxVolume * 100);
        musicVal.textContent = musicEl.value + '%';
        sfxVal.textContent = sfxEl.value + '%';
    }

    function openSettings() {
        // initAudio is a no-op after first call; ensures the graph exists so
        // changes apply even when opened from the title before play. resumeAudio
        // un-suspends the context (it starts suspended until a user gesture) so
        // the SFX preview is audible from the title screen too.
        initAudio();
        resumeAudio();
        syncControls();
        overlay.classList.remove('hidden');
    }
    function closeSettings() {
        overlay.classList.add('hidden');
    }

    musicEl.addEventListener('input', () => {
        setMusicVolume(musicEl.value / 100);
        musicVal.textContent = musicEl.value + '%';
    });
    sfxEl.addEventListener('input', () => {
        setSfxVolume(sfxEl.value / 100);
        sfxVal.textContent = sfxEl.value + '%';
        playSFX('weapon_switch'); // audible preview of the SFX level
    });
    muteEl.addEventListener('change', () => setMuted(muteEl.checked));

    document.getElementById('btn-settings').addEventListener('click', openSettings);
    document.getElementById('btn-settings-pause').addEventListener('click', openSettings);
    document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
}

function setupWeaponSwitchInput() {
    document.addEventListener('keydown', (e) => {
        if (gameState !== GAME_STATES.PLAYING) return;

        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 4) {
            switchWeapon(num - 1);
            showWeaponSwitch(num - 1);
            playSFX('weapon_switch');
        }
    });

    document.addEventListener('wheel', (e) => {
        if (gameState !== GAME_STATES.PLAYING) return;

        const dir = e.deltaY > 0 ? 1 : -1;
        let newIdx = (weaponState.currentIndex + dir + WEAPON_DEFS.length) % WEAPON_DEFS.length;
        switchWeapon(newIdx);
        showWeaponSwitch(newIdx);
        playSFX('weapon_switch');
    });
}

// ---- GAME STATE TRANSITIONS ----

function startGame() {
    // Reset all systems
    resetPlayer();
    resetWeapons();
    resetEnemies();
    resetGameLogic();
    resetEffects();

    gameState = GAME_STATES.PLAYING;
    showScreen('gameplay');
    requestPointerLock();
    resumeAudio();
    // Switch to the other track for gameplay (the menu plays the first track).
    nextMusicTrack();

    // Announce first wave after brief delay
    setTimeout(() => announceWave(1), 1000);
}

function pauseGame() {
    gameState = GAME_STATES.PAUSED;
    showScreen('pause');
    exitPointerLock();
    // Keep the soundtrack playing while paused so the volume can be judged
    // when the settings panel is opened from here.
}

function resumeGame() {
    gameState = GAME_STATES.PLAYING;
    showScreen('gameplay');
    requestPointerLock();
    startMusic();
}

function gameOver() {
    gameState = GAME_STATES.GAME_OVER;
    exitPointerLock();
    stopMusic();
    playSFX('game_over');

    const isNewHighScore = saveHighScore();
    showScreen('gameover');
    showNewHighScore(isNewHighScore);
}

function quitToMenu() {
    gameState = GAME_STATES.TITLE;
    exitPointerLock();
    showScreen('title');
    // Soundtrack plays on the menu too (restarts if game over had stopped it).
    startMusic();
}

// ---- GAME LOOP ----

function gameLoop() {
    requestAnimationFrame(gameLoop);

    const dt = Math.min(clock.getDelta(), 0.05); // Clamp delta time
    frameCount++;

    switch (gameState) {
        case GAME_STATES.PLAYING:
            updateGameplay(dt);
            break;
        case GAME_STATES.PAUSED:
            // Still render but don't update
            break;
        case GAME_STATES.TITLE:
        case GAME_STATES.GAME_OVER:
            // Slow camera rotation for title/gameover
            camera.position.set(
                Math.sin(frameCount * 0.002) * 15,
                8,
                Math.cos(frameCount * 0.002) * 15
            );
            camera.lookAt(0, 2, 0);
            break;
    }

    // Apply screen shake offset around render — restored immediately after so
    // subsequent frame updates operate on the true camera position.
    const shakeOffset = getScreenShakeOffset();
    camera.position.add(shakeOffset);
    renderer.render(scene, camera);
    camera.position.sub(shakeOffset);
}

function updateGameplay(dt) {
    // Snapshot alive enemies first so player movement can collide against them.
    const aliveEnemies = getAliveEnemies();

    // 1. Input & Player Movement (collides with walls + alive zombies)
    const inputState = updatePlayer(dt, aliveEnemies);

    // 2. Weapons
    updateWeapons(dt, aliveEnemies, onWeaponHit);

    // 3. Enemies (DoT kills route through onStatusKill to keep score consistent)
    updateEnemies(dt, onEnemyAttackPlayer, onStatusKill);

    // 3b. Acid pool ticks — dps applied to enemies inside any active pool.
    applyAcidPoolTicks(dt, aliveEnemies);

    // 4. Wave management
    updateWaves(dt, onWaveStart, onBossWave);

    // 5. Environmental traps
    const trapDamage = updateTraps(dt, aliveEnemies);
    if (trapDamage > 0) {
        damagePlayer(trapDamage);
        onPlayerDamaged();
        playSFX('player_hurt');
    }

    // 6. Combo system
    updateCombo(dt);

    // 7. Visual effects
    updateEffects(dt);
    updateScreenShake(dt);

    // 8. HUD
    updateHUD();

    // 9. Check player death
    if (!PLAYER.isAlive) {
        gameOver();
    }
}

// ---- CALLBACKS ----

function onWeaponHit(enemy, hitPoint, damage, weaponIndex, hitContext = {}) {
    const weapon = WEAPON_DEFS[weaponIndex];
    const fx = weapon.fx || {};
    const hitColor = weapon.projectileColor || weapon.color;

    // Knockback direction: away from player. For splash/AoE hits (hitContext.fromSplash),
    // use a direction radiating out of the explosion center instead.
    _scratchDir.copy(getPlayerForward()).setY(0);
    if (hitContext.fromSplash && hitContext.splashCenter) {
        _scratchDir.copy(enemy.root.position).sub(hitContext.splashCenter).setY(0);
    }
    if (_scratchDir.lengthSq() < 0.0001) _scratchDir.set(0, 0, 1);
    _scratchDir.normalize();

    const knockbackStrength = hitContext.fromSplash
        ? (fx.knockback || 0) * 0.6
        : (fx.knockback || 0);

    const killed = damageEnemy(enemy, damage, {
        element: fx.element,
        knockbackDir: _scratchDir,
        knockbackStrength,
        statusEffect: fx.status ? { ...fx.status, weaponIndex } : null,
    });

    // Hit feedback
    showHitMarker();
    playSFX('hit_zombie');

    // Generic hit burst (per-element color).
    const particleCount = fx.hitParticles ?? 6;
    if (particleCount > 0) {
        spawnHitParticles(hitPoint, hitColor, killed ? particleCount + 6 : particleCount);
    }

    // Damage number — skip splash victims unless it's a kill to avoid visual clutter.
    // Anchor on the enemy's head bone so the text sits just above the head instead
    // of floating wherever the bullet happened to intersect (torso, legs, etc).
    if (!hitContext.fromSplash || killed) {
        const isCritDmg = damage >= enemy.maxHealth * 0.5;
        const headPos = getEnemyHeadWorldPos(enemy, _scratchHeadPos);
        spawnDamageNumber(headPos, damage, isCritDmg || (killed && scoreState.comboMultiplier >= 3));
    }

    // Screen shake — kill upgrades to killShake if present.
    const shake = killed ? (fx.killShake || fx.shake) : fx.shake;
    if (shake && !hitContext.fromSplash) {
        triggerScreenShake(shake.amp, shake.duration);
    }

    if (killed) {
        addKill(enemy.scoreValue);
        bumpCombo();
        playSFX('enemy_death');
        playSFX('combo_ding');
        spawnDeathSplat(hitPoint);
        const isCritical = scoreState.comboMultiplier >= 3;
        spawnPopup(getEnemyHeadWorldPos(enemy, _scratchHeadPos), isCritical);
    }

    // Primary-impact-only splash effects. Splash victims already took damage via AoE,
    // so we skip this block for them to avoid double explosions / stacked pools.
    if (!hitContext.fromSplash) {
        if (fx.splash === 'explosion') {
            spawnExplosion(hitPoint, fx.explosionRadius || weapon.aoeRadius || 3.0, hitColor);
        } else if (fx.splash === 'liquid') {
            spawnLiquidSplash(hitPoint, hitColor, fx.splashCount || 8);
            if (fx.acidPoolChance && Math.random() < fx.acidPoolChance) {
                spawnAcidPool(
                    hitPoint,
                    fx.acidPoolRadius || 1.2,
                    fx.acidPoolDuration || 2.0,
                    hitColor,
                    fx.acidPoolDps || 5
                );
            }
        }
    }
}

// DoT kill path (burn/corrode ticked the enemy to zero). Reuse score/kill pipeline.
function onStatusKill(enemy, hitPoint, weaponIndex) {
    addKill(enemy.scoreValue);
    bumpCombo();
    playSFX('enemy_death');
    playSFX('combo_ding');
    spawnDeathSplat(hitPoint);
    spawnPopup(getEnemyHeadWorldPos(enemy, _scratchHeadPos), scoreState.comboMultiplier >= 3);
}

// Per-frame acid-pool damage tick: any enemy standing inside an active pool
// takes dps * tickInterval (0.25s) damage with corrode status refreshed.
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
    playSFX('player_hurt');
}

function onWaveStart(waveNumber) {
    announceWave(waveNumber);
    playSFX('wave_start');
}

function onBossWave(waveNumber) {
    setTimeout(() => {
        announceBoss();
        playSFX('boss_appear');
    }, 1500);
}

// ---- BOOT ----

init().catch(err => {
    console.error('Game initialization failed:', err);
    const loadingText = document.getElementById('loading-text');
    if (loadingText) {
        loadingText.textContent = 'ERROR: ' + err.message;
        loadingText.style.color = '#FF3B30';
    }
});

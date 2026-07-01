// ============================================
// UI Manager
// HUD updates, screen transitions, announcements
// ============================================

// Cache DOM elements
let elements = {};
let gameRefs = {
    PLAYER: null,
    weaponState: null,
    WEAPON_DEFS: [],
    getCurrentEvolution: null,
    scoreState: null,
    waveState: null,
};

const HIGH_SCORE_KEY = 'zombieBlasterHighScore';
const DEFAULT_SCORE_STATE = {
    score: 0,
    highScore: 0,
    comboMultiplier: 1,
    maxComboMultiplier: 1,
    totalKills: 0,
};
const DEFAULT_WAVE_STATE = { currentWave: 1 };

function readStoredHighScore() {
    try {
        return parseInt(localStorage.getItem(HIGH_SCORE_KEY) || '0', 10);
    } catch (e) {
        return 0;
    }
}

function getScoreState() {
    if (gameRefs.scoreState) return gameRefs.scoreState;
    DEFAULT_SCORE_STATE.highScore = readStoredHighScore();
    return DEFAULT_SCORE_STATE;
}

function getWaveState() {
    return gameRefs.waveState || DEFAULT_WAVE_STATE;
}

function setGameRefs(refs) {
    gameRefs = { ...gameRefs, ...refs };
    buildWeaponSlots();
}

function initUI() {
    elements = {
        // HUD
        score: document.getElementById('hud-score'),
        comboLabel: document.getElementById('combo-label'),
        comboMultiplier: document.getElementById('combo-multiplier'),
        comboDisplay: document.getElementById('combo-display'),
        wave: document.getElementById('hud-wave'),
        healthBar: document.getElementById('health-bar'),
        healthValue: document.getElementById('health-value'),
        weaponName: document.getElementById('weapon-name'),
        ammoCount: document.getElementById('ammo-count'),
        dashBar: document.getElementById('dash-bar'),
        crosshair: document.getElementById('crosshair'),

        // Screens
        loadingScreen: document.getElementById('loading-screen'),
        titleScreen: document.getElementById('title-screen'),
        controlsOverlay: document.getElementById('controls-overlay'),
        settingsOverlay: document.getElementById('settings-overlay'),
        screenFade: document.getElementById('screen-fade'),
        hud: document.getElementById('hud'),
        pauseScreen: document.getElementById('pause-screen'),
        gameoverScreen: document.getElementById('gameover-screen'),

        // Announcements
        waveAnnounce: document.getElementById('wave-announce'),
        waveAnnounceText: document.getElementById('wave-announce-text'),
        bossAnnounce: document.getElementById('boss-announce'),
        weaponSwitchIndicator: document.getElementById('weapon-switch-indicator'),
        weaponSlots: document.getElementById('weapon-slots'),

        // Title screen
        titleHighScore: document.getElementById('title-high-score'),
        btnStart: document.getElementById('btn-start'),
        btnControls: document.getElementById('btn-controls'),
        btnCloseControls: document.getElementById('btn-close-controls'),

        // Pause
        btnResume: document.getElementById('btn-resume'),
        btnQuit: document.getElementById('btn-quit'),

        // Game over
        finalScore: document.getElementById('final-score'),
        finalWaves: document.getElementById('final-waves'),
        finalCombo: document.getElementById('final-combo'),
        finalKills: document.getElementById('final-kills'),
        gameoverHighScore: document.getElementById('gameover-high-score'),
        newHighScore: document.getElementById('new-high-score'),
        btnRetry: document.getElementById('btn-retry'),
        btnMenu: document.getElementById('btn-menu'),

        // Loading
        loadingBar: document.getElementById('loading-bar'),
        loadingText: document.getElementById('loading-text'),
    };
}

function buildWeaponSlots() {
    if (!elements.weaponSlots) return;
    elements.weaponSlots.innerHTML = '';
    if (!gameRefs.WEAPON_DEFS?.length) return;

    const { WEAPON_DEFS } = gameRefs;
    WEAPON_DEFS.forEach((def, i) => {
        const slot = document.createElement('div');
        slot.className = 'weapon-slot' + (i === 0 ? ' active' : '');
        slot.textContent = `${i + 1}: ${def.name}`;
        slot.dataset.index = i;
        elements.weaponSlots.appendChild(slot);
    });
}

function updateHUD() {
    if (!elements.score) return;
    const { PLAYER, weaponState, getCurrentEvolution } = gameRefs;
    const scoreState = getScoreState();
    const waveState = getWaveState();
    if (!PLAYER || !weaponState || !getCurrentEvolution) return;

    // Score (animated counting)
    elements.score.textContent = scoreState.score.toLocaleString();

    // Combo
    elements.comboMultiplier.textContent = `x${scoreState.comboMultiplier}`;
    if (scoreState.comboMultiplier > 1) {
        elements.comboLabel.textContent = 'COMBO';
        elements.comboDisplay.style.opacity = '1';
    } else {
        elements.comboDisplay.style.opacity = '0.4';
    }

    // Wave
    elements.wave.textContent = waveState.currentWave;

    // Health
    const healthPct = (PLAYER.health / PLAYER.maxHealth) * 100;
    elements.healthBar.style.width = healthPct + '%';
    elements.healthValue.textContent = Math.ceil(PLAYER.health);

    // Health color change when low
    if (healthPct < 25) {
        elements.healthBar.style.background = 'linear-gradient(90deg, #FF3B30, #FF0000)';
        elements.healthBar.style.animation = 'gameoverPulse 0.5s infinite';
    } else if (healthPct < 50) {
        elements.healthBar.style.background = 'linear-gradient(90deg, #FF7F00, #FF3B30)';
        elements.healthBar.style.animation = 'none';
    } else {
        elements.healthBar.style.background = 'linear-gradient(90deg, #FF3B30, #FF1493)';
        elements.healthBar.style.animation = 'none';
    }

    // Weapon
    const evolution = getCurrentEvolution();
    elements.weaponName.textContent = evolution.name;
    const idx = weaponState.currentIndex;
    elements.ammoCount.textContent = `${weaponState.currentAmmo[idx]}/${weaponState.reserveAmmo[idx]}`;

    // Ammo flash when low
    if (weaponState.currentAmmo[idx] <= 5) {
        elements.ammoCount.style.color = '#FF3B30';
    } else {
        elements.ammoCount.style.color = '#00FFFF';
    }

    // Dash cooldown
    const dashPct = Math.max(0, 1 - PLAYER.dashCooldownTimer / PLAYER.dashCooldown) * 100;
    elements.dashBar.style.width = dashPct + '%';
}

function bumpCombo() {
    if (elements.comboDisplay) {
        elements.comboDisplay.classList.add('bump');
        setTimeout(() => elements.comboDisplay.classList.remove('bump'), 100);
    }
}

function announceWave(waveNumber) {
    if (!elements.waveAnnounce) return;
    elements.waveAnnounceText.textContent = `WAVE ${waveNumber}`;
    elements.waveAnnounce.classList.remove('hidden');
    // Force reflow for animation restart
    elements.waveAnnounce.style.animation = 'none';
    void elements.waveAnnounce.offsetHeight;
    elements.waveAnnounce.style.animation = '';

    setTimeout(() => elements.waveAnnounce.classList.add('hidden'), 2500);
}

function announceBoss() {
    if (!elements.bossAnnounce) return;
    elements.bossAnnounce.classList.remove('hidden');
    elements.bossAnnounce.style.animation = 'none';
    void elements.bossAnnounce.offsetHeight;
    elements.bossAnnounce.style.animation = '';

    setTimeout(() => elements.bossAnnounce.classList.add('hidden'), 3500);
}

function showWeaponSwitch(index) {
    if (!elements.weaponSwitchIndicator) return;
    if (!elements.weaponSlots) return;

    // Update active slot
    const slots = elements.weaponSlots.children;
    for (let i = 0; i < slots.length; i++) {
        slots[i].classList.toggle('active', i === index);
    }

    elements.weaponSwitchIndicator.classList.remove('hidden');
    elements.weaponSwitchIndicator.style.animation = 'none';
    void elements.weaponSwitchIndicator.offsetHeight;
    elements.weaponSwitchIndicator.style.animation = '';

    clearTimeout(elements.weaponSwitchIndicator._timeout);
    elements.weaponSwitchIndicator._timeout = setTimeout(() => {
        elements.weaponSwitchIndicator.classList.add('hidden');
    }, 1500);
}

// Screen management
function showScreen(screenName) {
    const scoreState = getScoreState();
    const waveState = getWaveState();

    // Hide all
    ['loadingScreen', 'titleScreen', 'controlsOverlay', 'settingsOverlay', 'hud', 'pauseScreen', 'gameoverScreen'].forEach(key => {
        if (elements[key]) elements[key].classList.add('hidden');
    });

    switch (screenName) {
        case 'loading':
            elements.loadingScreen.classList.remove('hidden');
            break;
        case 'title':
            elements.titleScreen.classList.remove('hidden');
            elements.titleHighScore.textContent = scoreState.highScore.toLocaleString();
            document.body.style.cursor = 'default';
            break;
        case 'controls':
            elements.titleScreen.classList.remove('hidden');
            elements.controlsOverlay.classList.remove('hidden');
            document.body.style.cursor = 'default';
            break;
        case 'gameplay':
            elements.hud.classList.remove('hidden');
            document.body.style.cursor = 'none';
            break;
        case 'pause':
            elements.hud.classList.remove('hidden');
            elements.pauseScreen.classList.remove('hidden');
            document.body.style.cursor = 'default';
            break;
        case 'gameover':
            elements.gameoverScreen.classList.remove('hidden');
            elements.finalScore.textContent = scoreState.score.toLocaleString();
            elements.finalWaves.textContent = waveState.currentWave;
            elements.finalCombo.textContent = `x${scoreState.maxComboMultiplier}`;
            elements.finalKills.textContent = scoreState.totalKills;
            elements.gameoverHighScore.textContent = scoreState.highScore.toLocaleString();
            document.body.style.cursor = 'default';
            break;
    }
}

function showSettingsOverlay() {
    if (elements.settingsOverlay) {
        elements.settingsOverlay.classList.remove('hidden');
        document.body.style.cursor = 'default';
    }
}

function hideSettingsOverlay() {
    if (elements.settingsOverlay) {
        elements.settingsOverlay.classList.add('hidden');
    }
}

function showNewHighScore(isNew) {
    if (elements.newHighScore) {
        if (isNew) {
            elements.newHighScore.classList.remove('hidden');
        } else {
            elements.newHighScore.classList.add('hidden');
        }
    }
}

function updateLoadingBar(progress, text) {
    if (elements.loadingBar) {
        elements.loadingBar.style.width = progress + '%';
    }
    if (elements.loadingText && text) {
        elements.loadingText.textContent = text;
    }
}

function fadeTo(opacity, duration = 420) {
    if (!elements.screenFade) return Promise.resolve();

    const fade = elements.screenFade;
    fade.style.transitionDuration = `${duration}ms`;
    fade.style.pointerEvents = 'all';

    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            fade.removeEventListener('transitionend', onTransitionEnd);
            if (opacity === 0) fade.style.pointerEvents = 'none';
            resolve();
        };
        const onTransitionEnd = (event) => {
            if (event.target === fade && event.propertyName === 'opacity') finish();
        };

        fade.addEventListener('transitionend', onTransitionEnd);
        requestAnimationFrame(() => {
            fade.style.opacity = String(opacity);
        });
        setTimeout(finish, duration + 80);
    });
}

function fadeIn(duration) {
    return fadeTo(0, duration);
}

function fadeOut(duration) {
    return fadeTo(1, duration);
}

async function transitionToScreen(screenName, { outDuration = 320, inDuration = 420 } = {}) {
    await fadeOut(outDuration);
    showScreen(screenName);
    await fadeIn(inDuration);
}

export {
    initUI, setGameRefs, updateHUD, bumpCombo,
    announceWave, announceBoss,
    showWeaponSwitch, showScreen,
    showSettingsOverlay, hideSettingsOverlay,
    showNewHighScore, updateLoadingBar,
    fadeIn, fadeOut, transitionToScreen,
    elements,
};

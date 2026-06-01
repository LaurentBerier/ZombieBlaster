// ============================================
// UI Manager
// HUD updates, screen transitions, announcements
// ============================================

import { PLAYER } from './player.js';
import { weaponState, WEAPON_DEFS, getCurrentWeapon, getCurrentEvolution } from './weapons.js';
import { scoreState } from './gameLogic.js';
import { waveState } from './enemies.js';

// Cache DOM elements
let elements = {};

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

    // Build weapon slots
    buildWeaponSlots();
}

function buildWeaponSlots() {
    if (!elements.weaponSlots) return;
    elements.weaponSlots.innerHTML = '';
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

export {
    initUI, updateHUD, bumpCombo,
    announceWave, announceBoss,
    showWeaponSwitch, showScreen,
    showNewHighScore, updateLoadingBar,
    elements,
};

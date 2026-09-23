/**
 * limbo — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    OVERLAY_EVENT_MS,
    buildDoublesPlayerRoster,
    doublesMembersAt,
    doublesThrowerAvatar,
    doublesThrowerName,
    makePhase,
    slimPlayer,
    throwScoreFromTarget
} = require('./core');

const LIMBO_AIM_NUMBERS = [2, 3, 5];


function limboNextAliveIndex(players, fromIdx) {
    let idx = fromIdx;
    let loops = 0;
    do {
        idx = (idx + 1) % players.length;
        loops++;
    } while (players[idx].lives <= 0 && loops < players.length);
    return idx;
}

function limboAliveCount(players) {
    return players.filter(p => p.lives > 0).length;
}

function limboBeginTurn(gameData) {
    gameData.throwsThisTurn = 0;
    gameData.currentRunningTotal = 0;
    gameData.phase = makePhase('playing');
    gameData.lastThrow = null;
}

function limboApplyLifeLoss(gameData, player) {
    const bar = gameData.currentTargetBar;
    if (gameData.currentRunningTotal > bar) {
        gameData.currentRunningTotal = bar;
        gameData.lastThrow.hitBar = true;
    }
    const livesBefore = player.lives;
    player.lives--;
    gameData.lastThrow.lifeLost = true;
    const throwerName = doublesThrowerName(gameData, gameData.activeIdx);
    const throwerAvatar = doublesThrowerAvatar(gameData, gameData.activeIdx);
    gameData.phase = makePhase('life_loss', {
        playerId: player.id,
        playerName: throwerName,
        avatar: throwerAvatar,
        livesBefore,
        eliminated: livesBefore - 1 === 0,
        members: doublesMembersAt(gameData, gameData.activeIdx)
    });

    if (limboAliveCount(gameData.players) === 1) {
        const winner = gameData.players.find(p => p.lives > 0);
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'limbo_winner', winnerId: winner.id }
        };
    }

    return {
        gameData,
        schedule: { delayMs: OVERLAY_EVENT_MS, next: 'limbo_after_life_loss' }
    };
}

function handleLimboThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }

    const player = gameData.players[gameData.activeIdx];
    if (!player || player.lives <= 0) {
        return { gameData, schedule: null };
    }

    const randomScore = throwSpec
        ? (throwSpec.miss ? 25 : throwScoreFromTarget(throwSpec.number, throwSpec.multiplier))
        : Math.floor(Math.random() * 20) + 1;
    gameData.currentRunningTotal += randomScore;
    gameData.throwsThisTurn++;
    gameData.lastThrow = {
        score: randomScore,
        hitBar: false,
        lifeLost: false,
        miss: !!(throwSpec && throwSpec.miss),
        number: throwSpec ? (throwSpec.miss ? null : throwSpec.number) : null,
        multiplier: throwSpec && !throwSpec.miss ? throwSpec.multiplier : 1
    };

    const bar = gameData.currentTargetBar;
    const remaining = 3 - gameData.throwsThisTurn;
    // Must finish all 3 darts at or under the bar (min 1 per remaining dart).
    // Bust now if already over, or if remaining darts make that impossible.
    if (gameData.currentRunningTotal > bar || gameData.currentRunningTotal + remaining > bar) {
        return limboApplyLifeLoss(gameData, player);
    }

    if (gameData.throwsThisTurn < 3) {
        return { gameData, schedule: null };
    }

    // Full visit complete — total is guaranteed <= bar
    const throwerName = doublesThrowerName(gameData, gameData.activeIdx);
    const throwerAvatar = doublesThrowerAvatar(gameData, gameData.activeIdx);

    if (gameData.currentRunningTotal === bar) {
        gameData.lastThrow.matchedBar = true;
        gameData.phase = makePhase('bar_status', {
            playerId: player.id,
            playerName: throwerName,
            avatar: throwerAvatar,
            mode: 'hold',
            headline: `${throwerName} Matched The Bar!`,
            badge: `BAR HOLDS: ${bar}`,
            barValue: bar
        });
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'limbo_after_bar' }
        };
    }

    gameData.currentTargetBar = gameData.currentRunningTotal;
    gameData.phase = makePhase('bar_status', {
        playerId: player.id,
        playerName: throwerName,
        avatar: throwerAvatar,
        mode: 'clear',
        headline: `${throwerName} Cleared The Bar!`,
        badge: `BAR LOWERED TO: ${gameData.currentTargetBar}`,
        barValue: gameData.currentTargetBar
    });
    return {
        gameData,
        schedule: { delayMs: OVERLAY_EVENT_MS, next: 'limbo_after_bar' }
    };
}

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleLimboThrow(gameData, throwSpec, throwSource);
}

/**
 * Initial state for this game.
 *
 * `ordered` is the lineup already shuffled by the caller; `players` is the
 * original unshuffled list (a couple of games need seat order as registered);
 * `options` carries lineup mode and any game-specific setup.
 */
function init(ordered, options = {}, players = ordered) {
    return {
        gameType: 'limbo',
        players: ordered.map(p => ({ ...slimPlayer(p), lives: 3 })),
        activeIdx: 0,
        currentTargetBar: 60,
        currentRunningTotal: 0,
        throwsThisTurn: 0,
        isDoublesLineup: false,
        throwerIndices: ordered.map(() => 0),
        phase: makePhase('playing'),
        helpVisible: false,
        lastThrow: null
    };
}

/**
 * Which number a simulated/bot throw should aim at right now.
 * Returning null (or omitting this export) means 'no opinion' and the
 * caller falls back to 20.
 */
function aimNumber(gameData) {
    return LIMBO_AIM_NUMBERS[Math.floor(Math.random() * LIMBO_AIM_NUMBERS.length)];
}

/**
 * Initial state for a DOUBLES lineup, where each non-empty team is one
 * scoring entity. A game that has no doubles variant simply does not export
 * this, and the caller falls back to the singles path.
 */
function initDoubles(players, options = {}) {
    const doublesBase = {
        activeIdx: 0,
        throwsThisTurn: 0,
        phase: makePhase('playing'),
        helpVisible: false,
        lastThrow: null
    };

    const roster = buildDoublesPlayerRoster(options.doublesTeams, players, (base) => ({
        ...base,
        lives: 3
    }));
    return {
        gameType: 'limbo',
        ...roster,
        ...doublesBase,
        currentTargetBar: 60,
        currentRunningTotal: 0
    };
}

module.exports = {
    initDoubles,
    aimNumber,
    init,
    handleThrow,
    handleLimboThrow,
    limboAliveCount,
    limboApplyLifeLoss,
    limboBeginTurn,
    limboNextAliveIndex,
    LIMBO_AIM_NUMBERS
};

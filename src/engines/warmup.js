/**
 * warmup — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    makeDart,
    visitTotal,
    makePhase,
    multChar,
    throwScoreFromTarget
} = require('./core');

const WARMUP_HISTORY_MAX = 50;


function handleWarmupThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }
    if ((gameData.throwsThisTurn || 0) >= 3) {
        return { gameData, schedule: null };
    }

    const dart = makeDart(throwSpec);
    if (!Array.isArray(gameData.turnDarts)) gameData.turnDarts = [];
    gameData.turnDarts.push({
        label: dart.label,
        mult: dart.mult,
        score: dart.score
    });
    if (gameData.turnDarts.length > 3) {
        gameData.turnDarts = gameData.turnDarts.slice(-3);
    }

    gameData.throwsThisTurn = (gameData.throwsThisTurn || 0) + 1;
    gameData.lastThrow = {
        label: dart.label,
        mult: dart.mult,
        score: dart.score,
        miss: !!dart.miss,
        number: dart.number,
        multiplier: dart.multiplier
    };

    if (gameData.throwsThisTurn < 3) {
        return { gameData, schedule: null };
    }

    return {
        gameData,
        schedule: { delayMs: 700, next: 'warmup_commit_visit' }
    };
}

function warmupCommitVisit(gameData) {
    const darts = Array.isArray(gameData.turnDarts) ? gameData.turnDarts.slice(0, 3) : [];
    const total = visitTotal(darts);
    if (!Array.isArray(gameData.visitHistory)) gameData.visitHistory = [];
    gameData.visitHistory.unshift({
        id: `${Date.now()}-${gameData.visitCount || 0}`,
        darts,
        total
    });
    if (gameData.visitHistory.length > WARMUP_HISTORY_MAX) {
        gameData.visitHistory = gameData.visitHistory.slice(0, WARMUP_HISTORY_MAX);
    }
    gameData.visitCount = (gameData.visitCount || 0) + 1;
    gameData.turnDarts = [];
    gameData.throwsThisTurn = 0;
    gameData.lastThrow = null;
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleWarmupThrow(gameData, throwSpec, throwSource);
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
        gameType: 'warmup',
        throwsThisTurn: 0,
        turnDarts: [],
        visitHistory: [],
        visitCount: 0,
        phase: makePhase('playing'),
        helpVisible: false,
        lastThrow: null
    };
}

module.exports = {
    init,
    handleThrow,
    handleWarmupThrow,
    warmupCommitVisit,
    WARMUP_HISTORY_MAX
};

/**
 * quick10 — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    makeDart,
    makePhase,
    slimPlayer,
    visitTotal
} = require('./core');

const QUICK10_ROUNDS = 10;
const QUICK10_DARTS_PER_ROUND = 3;

function normalizeThrowSource(source) {
    if (source === 'bot') return 'debug';
    if (source === 'debug' || source === 'correct') return source;
    if (source === 'scolia' || source === 'autodarts' || source === 'opendarts' || source === 'mock') return source;
    // Legacy / unknown board throws — treat as scolia-shaped provenance
    return 'scolia';
}

function quick10MakeDart(throwSpec, throwSource) {
    const dart = makeDart(throwSpec);
    const source = normalizeThrowSource(throwSource);
    return {
        label: dart.label,
        mult: dart.mult,
        score: dart.score,
        miss: !!dart.miss,
        number: dart.number,
        multiplier: dart.multiplier,
        source
    };
}

function selectQuick10Player(gameData, playerId) {
    if (!gameData || gameData.gameType !== 'quick10') return { gameData, schedule: null };
    if (!gameData.phase || gameData.phase.type !== 'pick_player') {
        return { gameData, schedule: null };
    }
    const candidates = Array.isArray(gameData.candidates) ? gameData.candidates : [];
    const chosen = candidates.find((p) => p && p.id === playerId);
    if (!chosen) return { gameData, schedule: null };
    gameData.player = slimPlayer(chosen);
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function handleQuick10Throw(gameData, throwSpec = null, throwSource = null) {
    if (!gameData.player) {
        return { gameData, schedule: null };
    }
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }
    if ((gameData.throwsThisTurn || 0) >= QUICK10_DARTS_PER_ROUND) {
        return { gameData, schedule: null };
    }
    if ((gameData.currentRound || 1) > QUICK10_ROUNDS) {
        return { gameData, schedule: null };
    }

    const dart = quick10MakeDart(throwSpec, throwSource);
    if (dart.source === 'debug') gameData.usedDebug = true;
    if (dart.source === 'correct') gameData.usedCorrection = true;

    if (!Array.isArray(gameData.turnDarts)) gameData.turnDarts = [];
    gameData.turnDarts.push({
        label: dart.label,
        mult: dart.mult,
        score: dart.score,
        miss: dart.miss,
        number: dart.number,
        multiplier: dart.multiplier,
        source: dart.source
    });
    if (gameData.turnDarts.length > QUICK10_DARTS_PER_ROUND) {
        gameData.turnDarts = gameData.turnDarts.slice(-QUICK10_DARTS_PER_ROUND);
    }

    gameData.throwsThisTurn = (gameData.throwsThisTurn || 0) + 1;
    gameData.lastThrow = {
        label: dart.label,
        mult: dart.mult,
        score: dart.score,
        miss: dart.miss,
        number: dart.number,
        multiplier: dart.multiplier,
        source: dart.source
    };

    if (gameData.throwsThisTurn < QUICK10_DARTS_PER_ROUND) {
        return { gameData, schedule: null };
    }

    return {
        gameData,
        schedule: { delayMs: 700, next: 'quick10_commit_visit' }
    };
}

function quick10CommitVisit(gameData) {
    const round = Math.max(1, Number(gameData.currentRound) || 1);
    const darts = Array.isArray(gameData.turnDarts)
        ? gameData.turnDarts.slice(0, QUICK10_DARTS_PER_ROUND)
        : [];
    const total = visitTotal(darts);
    if (!Array.isArray(gameData.roundHistory)) gameData.roundHistory = [];
    gameData.roundHistory.push({
        round,
        darts,
        total
    });
    gameData.totalScore = (Number(gameData.totalScore) || 0) + total;
    gameData.turnDarts = [];
    gameData.throwsThisTurn = 0;
    gameData.lastThrow = null;

    if (round >= QUICK10_ROUNDS) {
        const usedDebug = !!gameData.usedDebug;
        const usedCorrection = !!gameData.usedCorrection;
        gameData.phase = makePhase('complete', {
            totalScore: gameData.totalScore,
            playerName: (gameData.player && gameData.player.name) || 'PLAYER',
            playerAvatar: (gameData.player && gameData.player.avatar) || null,
            usedDebug,
            usedCorrection,
            clean: !usedDebug && !usedCorrection
        });
        gameData.readyToPersist = !gameData.persisted;
        return { gameData, schedule: null, persistQuick10: true };
    }

    gameData.currentRound = round + 1;
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function buildQuick10MatchRecord(gameData, matchId) {
    if (!gameData || gameData.gameType !== 'quick10' || !gameData.player) return null;
    const rounds = Array.isArray(gameData.roundHistory) ? gameData.roundHistory : [];
    const usedDebug = !!gameData.usedDebug;
    const usedCorrection = !!gameData.usedCorrection;
    return {
        id: matchId,
        gameType: 'quick10',
        playedAt: new Date().toISOString(),
        player: {
            id: gameData.player.id,
            name: gameData.player.name,
            avatar: gameData.player.avatar || null
        },
        totalScore: Number(gameData.totalScore) || 0,
        rounds,
        integrity: {
            usedDebug,
            usedCorrection,
            clean: !usedDebug && !usedCorrection
        }
    };
}

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleQuick10Throw(gameData, throwSpec, throwSource);
}

/**
 * Initial state for this game.
 *
 * `ordered` is the lineup already shuffled by the caller; `players` is the
 * original unshuffled list (a couple of games need seat order as registered);
 * `options` carries lineup mode and any game-specific setup.
 */
function init(ordered, options = {}, players = ordered) {
    const candidates = (players || []).map(slimPlayer).filter((p) => p && p.id);
    const single = candidates.length === 1 ? candidates[0] : null;
    return {
        gameType: 'quick10',
        candidates,
        player: single,
        throwsThisTurn: 0,
        turnDarts: [],
        roundHistory: [],
        currentRound: 1,
        totalScore: 0,
        usedDebug: false,
        usedCorrection: false,
        leaderboardVisible: false,
        readyToPersist: false,
        persisted: false,
        phase: single
            ? makePhase('playing')
            : makePhase('pick_player', { candidates }),
        helpVisible: false,
        lastThrow: null
    };
}

/**
 * Controls specific to this game. Returns null when the action is not ours,
 * so the caller can carry on with generic handling.
 */
function handleAction(gameData, payload) {
    if (payload.type === 'TOGGLE_LEADERBOARD') {
        gameData.leaderboardVisible = !gameData.leaderboardVisible;
        return { gameData, schedule: null };
    }
    if (payload.type === 'SELECT_QUICK10_PLAYER') {
        return selectQuick10Player(gameData, payload.playerId);
    }
    return null;
}

/** Quick 10 is single-player: the one registered player is always throwing. */
function activeThrower(gameData) {
    return gameData.player || null;
}

module.exports = {
    activeThrower,
    handleAction,
    init,
    handleThrow,
    buildQuick10MatchRecord,
    handleQuick10Throw,
    normalizeThrowSource,
    quick10CommitVisit,
    quick10MakeDart,
    selectQuick10Player,
    QUICK10_DARTS_PER_ROUND,
    QUICK10_ROUNDS
};

/**
 * shanghai — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    buildDoublesPlayerRoster,
    doublesAdvanceThrowerAfterVisit,
    doublesContenderFields,
    doublesThrowerName,
    doublesWinnerFields,
    makePhase,
    normalizeMultiplier,
    scheduleRoundThenNextPlayer,
    slimPlayer,
    throwScoreFromTarget
} = require('./core');

const SHANGHAI_MAX_ROUNDS = 8;

/* ========== SHANGHAI ========== */

function shanghaiEmptyRoundScores() {
    return Array.from({ length: SHANGHAI_MAX_ROUNDS }, () => null);
}

function shanghaiTargetNumber(gameData) {
    const round = Math.min(Math.max(gameData.currentRound || 1, 1), SHANGHAI_MAX_ROUNDS);
    return round;
}

function shanghaiMultChar(multiplier) {
    return multiplier === 3 ? 'T' : multiplier === 2 ? 'D' : 'S';
}

function shanghaiMakeDart(throwSpec, targetNumber) {
    if (throwSpec) {
        if (throwSpec.miss || throwSpec.number == null || throwSpec.number === 'bull') {
            return {
                label: throwSpec.miss ? 'MISS' : (throwSpec.number === 'bull' ? 'BULL' : '—'),
                mult: null,
                points: 0,
                hit: false,
                number: throwSpec.miss ? null : throwSpec.number,
                multiplier: 1
            };
        }
        const number = Number(throwSpec.number);
        const multiplier = normalizeMultiplier(throwSpec.multiplier);
        const hit = number === targetNumber;
        const points = hit ? throwScoreFromTarget(number, multiplier) : 0;
        return {
            label: String(number),
            mult: shanghaiMultChar(multiplier),
            points,
            hit,
            number,
            multiplier
        };
    }

    // Debug / generic throw: bias toward the live target so playtests score often
    if (Math.random() < 0.12) {
        return { label: 'MISS', mult: null, points: 0, hit: false, number: null, multiplier: 1 };
    }
    const hitTarget = Math.random() < 0.55;
    const number = hitTarget ? targetNumber : (Math.floor(Math.random() * 20) + 1);
    const roll = Math.random();
    let multiplier = 1;
    if (roll > 0.82) multiplier = 3;
    else if (roll > 0.62) multiplier = 2;
    const hit = number === targetNumber;
    const points = hit ? throwScoreFromTarget(number, multiplier) : 0;
    return {
        label: String(number),
        mult: shanghaiMultChar(multiplier),
        points,
        hit,
        number,
        multiplier
    };
}

function shanghaiPushTurnDart(gameData, dart) {
    if (!Array.isArray(gameData.turnDarts)) gameData.turnDarts = [];
    gameData.turnDarts.push({
        label: dart.hit ? `${dart.mult || 'S'}${dart.label}` : (dart.label === 'MISS' ? 'MISS' : dart.label),
        mult: dart.hit ? dart.mult : null,
        points: dart.points || 0,
        hit: !!dart.hit
    });
    if (gameData.turnDarts.length > 3) {
        gameData.turnDarts = gameData.turnDarts.slice(-3);
    }
}

function shanghaiAdvanceTurn(gameData) {
    doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
    gameData.throwsThisTurn = 0;
    gameData.turnDarts = [];
    gameData.activeIdx++;
    if (gameData.activeIdx >= gameData.players.length) {
        gameData.activeIdx = 0;
        gameData.currentRound++;
    }
    gameData.lastThrow = null;
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function shanghaiResolveMatch(gameData) {
    const players = gameData.players || [];
    let bestScore = -Infinity;
    players.forEach(p => {
        bestScore = Math.max(bestScore, p.score || 0);
    });

    const pool = players.filter(p => (p.score || 0) === bestScore);

    if (pool.length > 1) {
        gameData.phase = makePhase('draw', {
            contenders: pool.map(p => doublesContenderFields(p)),
            reason: 'score'
        });
        return { gameData, schedule: null };
    }

    const champ = pool[0] || players[0];
    gameData.phase = makePhase('winner', {
        ...doublesWinnerFields(champ),
        reason: 'score',
        score: champ ? (champ.score || 0) : 0,
        rounds: SHANGHAI_MAX_ROUNDS
    });
    return { gameData, schedule: null };
}

function shanghaiContinueAfterThrow(gameData) {
    if (gameData.throwsThisTurn < 3) {
        gameData.phase = makePhase('playing');
        return { gameData, schedule: null };
    }

    let nextIdx = gameData.activeIdx + 1;
    let nextRound = gameData.currentRound;
    let wrapped = false;
    if (nextIdx >= gameData.players.length) {
        nextIdx = 0;
        nextRound++;
        wrapped = true;
    }

    if (nextRound > SHANGHAI_MAX_ROUNDS) {
        gameData.phase = makePhase('playing');
        return {
            gameData,
            schedule: { delayMs: 600, next: 'shanghai_resolve_match' }
        };
    }

    return scheduleRoundThenNextPlayer(
        gameData,
        'shanghai',
        nextIdx,
        nextRound,
        wrapped,
        { targetNumber: Math.min(nextRound, SHANGHAI_MAX_ROUNDS) }
    );
}

function handleShanghaiThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }
    if ((gameData.throwsThisTurn || 0) >= 3) {
        return { gameData, schedule: null };
    }

    const player = gameData.players[gameData.activeIdx];
    if (!player) return { gameData, schedule: null };

    const targetNumber = shanghaiTargetNumber(gameData);
    const dart = shanghaiMakeDart(throwSpec, targetNumber);

    gameData.throwsThisTurn = (gameData.throwsThisTurn || 0) + 1;
    shanghaiPushTurnDart(gameData, dart);

    if (!Array.isArray(player.roundScores) || player.roundScores.length !== SHANGHAI_MAX_ROUNDS) {
        player.roundScores = shanghaiEmptyRoundScores();
    }
    const roundIdx = targetNumber - 1;
    const prior = player.roundScores[roundIdx];
    const roundTotal = (prior == null ? 0 : prior) + (dart.points || 0);
    player.roundScores[roundIdx] = roundTotal;
    player.score = (player.score || 0) + (dart.points || 0);

    const label = dart.hit
        ? `+${dart.points}`
        : (dart.label === 'MISS' ? 'MISS' : dart.label);

    gameData.lastThrow = {
        points: dart.points || 0,
        hit: !!dart.hit,
        label,
        playerId: player.id,
        playerName: doublesThrowerName(gameData, gameData.activeIdx),
        number: dart.number,
        multiplier: dart.multiplier,
        targetNumber,
        sector: throwSpec && throwSpec.sector ? throwSpec.sector : null
    };

    return shanghaiContinueAfterThrow(gameData);
}

/** Round vocabulary for the shared banner — see core's roundAnnounceInfo. */
const meta = {
    maxRounds: SHANGHAI_MAX_ROUNDS,
    roundEyebrow: 'SCROLL ROUND',
    roundSubtitle: (r) => `AIM FOR ${r}`
};

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleShanghaiThrow(gameData, throwSpec, throwSource);
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
        gameType: 'shanghai',
        players: ordered.map(p => ({
            ...slimPlayer(p),
            score: 0,
            roundScores: shanghaiEmptyRoundScores()
        })),
        activeIdx: 0,
        throwsThisTurn: 0,
        turnDarts: [],
        currentRound: 1,
        isDoublesLineup: false,
        throwerIndices: ordered.map(() => 0),
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('shanghai', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */,
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
    return shanghaiTargetNumber(gameData);
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
        score: 0,
        roundScores: shanghaiEmptyRoundScores()
    }));
    return {
        gameType: 'shanghai',
        ...roster,
        ...doublesBase,
        turnDarts: [],
        currentRound: 1,
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('shanghai', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */
    };
}

module.exports = {
    initDoubles,
    aimNumber,
    init,
    handleThrow,
    SHANGHAI_MAX_ROUNDS,
    meta,
    handleShanghaiThrow,
    shanghaiAdvanceTurn,
    shanghaiContinueAfterThrow,
    shanghaiEmptyRoundScores,
    shanghaiMakeDart,
    shanghaiMultChar,
    shanghaiPushTurnDart,
    shanghaiResolveMatch,
    shanghaiTargetNumber
};

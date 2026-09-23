/**
 * quackshot — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    OVERLAY_EVENT_MS,
    buildDoublesPlayerRoster,
    doublesAdvanceThrowerAfterVisit,
    doublesContenderFields,
    doublesWinnerFields,
    makePhase,
    scheduleRoundThenNextPlayer,
    slimPlayer
} = require('./core');

const QUACKSHOT_MAX_ROUNDS = 6;

const QUACKSHOT_SEG_FLASH_MS = 1260;
const QUACKSHOT_SEG_FLASH_TAIL_MS = 150;


function quackshotOverlayDelayMs() {
    return QUACKSHOT_SEG_FLASH_MS + QUACKSHOT_SEG_FLASH_TAIL_MS + OVERLAY_EVENT_MS;
}

/* ========== QUACKSHOT ========== */

function resolveQuackshotHit(throwSpec) {
    // Scoring:
    //   Bull (inner / double bull) → +3
    //   25 (outer bull) → +2
    //   s# (inner single, between treble & bull) → +1
    //   T# (triple) → −2
    //   anything else (S#, D#, miss) → −1
    if (throwSpec && throwSpec.miss) {
        return { zone: 'miss', points: -1, bullseye: false, label: '−1', title: 'Splash!' };
    }

    if (!throwSpec) {
        const roll = Math.random();
        if (roll < 0.03) return { zone: 'double_bull', points: 3, bullseye: true, label: '+3', title: 'Double Bullseye!' };
        if (roll < 0.09) return { zone: 'bull', points: 2, bullseye: true, label: '+2', title: 'Outer Bull!' };
        if (roll < 0.19) return { zone: 'triple', points: -2, bullseye: false, label: '−2', title: 'Ring of Fire!' };
        if (roll < 0.39) return { zone: 'board', points: -1, bullseye: false, label: '−1', title: 'Splash!' };
        return { zone: 'inner_single', points: 1, bullseye: false, label: '+1', title: null };
    }

    const sector = throwSpec.sector ? String(throwSpec.sector) : null;

    if (sector === 'Bull' || (throwSpec.number === 'bull' && throwSpec.multiplier >= 2)) {
        return { zone: 'double_bull', points: 3, bullseye: true, label: '+3', title: 'Double Bullseye!' };
    }
    if (sector === '25' || (throwSpec.number === 'bull' && throwSpec.multiplier === 1)) {
        return { zone: 'bull', points: 2, bullseye: true, label: '+2', title: 'Outer Bull!' };
    }
    // Inner single (between treble & bull): Scolia/OpenDarts use sN; Autodarts uses bed→sN
    if (
        (sector && /^s(20|1[0-9]|[1-9])$/.test(sector))
        || (sector && /singleinner/i.test(sector))
    ) {
        return { zone: 'inner_single', points: 1, bullseye: false, label: '+1', title: null };
    }
    if (throwSpec.multiplier === 3 || (sector && /^T(20|1[0-9]|[1-9])$/.test(sector))) {
        return { zone: 'triple', points: -2, bullseye: false, label: '−2', title: 'Ring of Fire!' };
    }
    return { zone: 'board', points: -1, bullseye: false, label: '−1', title: 'Splash!' };
}

function quackshotRoundMultiplier(gameData) {
    return (gameData.currentRound || 1) >= QUACKSHOT_MAX_ROUNDS ? 2 : 1;
}

function quackshotAdvanceTurn(gameData) {
    doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
    gameData.throwsThisTurn = 0;
    gameData.activeIdx++;
    if (gameData.activeIdx >= gameData.players.length) {
        gameData.activeIdx = 0;
        gameData.currentRound++;
    }
    gameData.lastThrow = null;
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function quackshotResolveMatch(gameData) {
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
        reason: 'score'
    });
    return { gameData, schedule: null };
}

function quackshotContinueAfterThrow(gameData) {
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

    if (nextRound > QUACKSHOT_MAX_ROUNDS) {
        gameData.phase = makePhase('playing');
        return {
            gameData,
            schedule: { delayMs: 600, next: 'quackshot_resolve_match' }
        };
    }

    return scheduleRoundThenNextPlayer(gameData, 'quackshot', nextIdx, nextRound, wrapped);
}

function handleQuackshotThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }

    const player = gameData.players[gameData.activeIdx];
    if (!player) return { gameData, schedule: null };

    const hit = resolveQuackshotHit(throwSpec);
    const roundMult = quackshotRoundMultiplier(gameData);
    const awarded = hit.points * roundMult;
    gameData.throwsThisTurn++;
    player.score = (player.score || 0) + awarded;
    if (hit.bullseye) {
        player.bullseyes = (player.bullseyes || 0) + 1;
    }

    const label = roundMult > 1
        ? `${hit.label} ×2`
        : hit.label;

    gameData.lastThrow = {
        points: awarded,
        basePoints: hit.points,
        roundMultiplier: roundMult,
        zone: hit.zone,
        label,
        bullseye: !!hit.bullseye,
        playerId: player.id,
        playerName: player.name,
        number: throwSpec && !throwSpec.miss ? throwSpec.number : (hit.bullseye ? 'bull' : null),
        multiplier: throwSpec && !throwSpec.miss ? throwSpec.multiplier : 1,
        sector: throwSpec && throwSpec.sector ? throwSpec.sector : null
    };

    if (hit.bullseye) {
        gameData.phase = makePhase('bullseye', {
            playerName: player.name,
            avatar: player.avatar,
            bullseyes: player.bullseyes,
            zone: hit.zone,
            points: awarded,
            label,
            title: hit.title || (hit.zone === 'bull' ? 'Outer Bull!' : 'Double Bullseye!'),
            winning: false
        });
        return {
            gameData,
            schedule: { delayMs: quackshotOverlayDelayMs(), next: 'quackshot_after_hit' }
        };
    }

    /* +1 inner single: score only, no transition (default hit) */
    if (hit.zone === 'triple') {
        gameData.phase = makePhase('zone_hit', {
            playerName: player.name,
            avatar: player.avatar,
            zone: hit.zone,
            points: awarded,
            label,
            title: hit.title || 'Ring of Fire!'
        });
        return {
            gameData,
            schedule: { delayMs: quackshotOverlayDelayMs(), next: 'quackshot_after_hit' }
        };
    }

    // board / miss → −1 Splash overlay, then continue
    if (hit.zone === 'board' || hit.zone === 'miss') {
        gameData.phase = makePhase('splash', {
            playerName: player.name,
            avatar: player.avatar,
            zone: hit.zone,
            points: awarded,
            label,
            title: hit.title || 'Splash!'
        });
        return {
            gameData,
            schedule: { delayMs: quackshotOverlayDelayMs(), next: 'quackshot_after_hit' }
        };
    }

    return quackshotContinueAfterThrow(gameData);
}

/**
 * What this game tells the shared round-announce banner about itself.
 * See engines/core.js roundAnnounceInfo for the contract.
 */
const meta = {
    maxRounds: QUACKSHOT_MAX_ROUNDS,
    roundEyebrow: 'CARNIVAL ROUND',
    roundMultiplier: (r) => (r >= QUACKSHOT_MAX_ROUNDS ? 2 : 1)
};



/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleQuackshotThrow(gameData, throwSpec, throwSource);
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
        gameType: 'quackshot',
        players: ordered.map(p => ({
            ...slimPlayer(p),
            score: 0,
            bullseyes: 0
        })),
        activeIdx: 0,
        throwsThisTurn: 0,
        currentRound: 1,
        isDoublesLineup: false,
        throwerIndices: ordered.map(() => 0),
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('quackshot', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */,
        lastThrow: null,
        helpVisible: false
    };
}

/** Quackshot aims by inner-circle zone rather than by number. */
function aimedThrow(gameData, profileId, roll) {
    return roll.rollQuackshotAimThrow(profileId);
}

/**
 * Initial state for a DOUBLES lineup, where each non-empty team is one
 * scoring entity. A game with no doubles variant does not export this, and
 * the caller falls back to the singles path.
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
        bullseyes: 0
    }));
    return {
        gameType: 'quackshot',
        ...roster,
        ...doublesBase,
        currentRound: 1,
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('quackshot', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */
    };
}

module.exports = {
    initDoubles,
    aimedThrow,
    init,
    handleThrow,
    QUACKSHOT_MAX_ROUNDS,
    meta,
    handleQuackshotThrow,
    quackshotAdvanceTurn,
    quackshotContinueAfterThrow,
    quackshotOverlayDelayMs,
    quackshotResolveMatch,
    quackshotRoundMultiplier,
    resolveQuackshotHit,
    QUACKSHOT_SEG_FLASH_MS,
    QUACKSHOT_SEG_FLASH_TAIL_MS
};

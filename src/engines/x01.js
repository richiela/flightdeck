/**
 * x01 — game engine.
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
    multChar,
    normalizeMultiplier,
    showNextPlayerIntermission,
    slimPlayer,
    throwScoreFromTarget
} = require('./core');

const X01_MAX_PLAYERS = 4;

const X01_START_SCORE = 301;
const X01_SCORES = [301, 501, 701, 901];
const X01_IN_OUT = ['none', 'double', 'triple'];




/* --- X01 (configurable start / in / out) --- */

function x01NormalizeScore(value) {
    const n = Number(value);
    return X01_SCORES.includes(n) ? n : X01_START_SCORE;
}

function x01NormalizeInOut(value, fallback) {
    const v = String(value || '').toLowerCase();
    return X01_IN_OUT.includes(v) ? v : fallback;
}

function x01MeetsMultRule(number, multiplier, rule) {
    if (rule === 'none') return true;
    const mult = normalizeMultiplier(multiplier);
    if (rule === 'double') {
        if (number === 'bull') return mult === 2;
        return mult === 2;
    }
    if (rule === 'triple') {
        if (number === 'bull') return false;
        return mult === 3;
    }
    return false;
}

function x01IsValidFinish(number, multiplier, dartOut) {
    return x01MeetsMultRule(number, multiplier, dartOut || 'none');
}

function x01IsBust(scoreBefore, dartScore, number, multiplier, miss, dartOut) {
    if (miss) return false;
    const remaining = scoreBefore - dartScore;
    if (remaining < 0) return true;
    const out = dartOut || 'none';
    if (remaining === 0 && !x01IsValidFinish(number, multiplier, out)) return true;
    // Double-out cannot leave 1
    if (out === 'double' && remaining === 1) return true;
    return false;
}

function x01RecordDart(gameData, label, mult, score) {
    if (!Array.isArray(gameData.turnDarts)) gameData.turnDarts = [];
    gameData.turnDarts.push({
        label: label || 'MISS',
        mult: mult || null,
        score: score || 0
    });
    if (gameData.turnDarts.length > 3) {
        gameData.turnDarts = gameData.turnDarts.slice(-3);
    }
}

function x01RollDart(throwSpec, scoreBefore, dartOut) {
    if (throwSpec) {
        if (throwSpec.miss) {
            return { label: 'MISS', mult: null, score: 0, miss: true, number: null, multiplier: 1 };
        }
        const number = throwSpec.number;
        let multiplier = throwSpec.multiplier;
        if (number === 'bull' && multiplier > 2) multiplier = 2;
        return {
            label: number === 'bull' ? 'BULL' : String(number),
            mult: multChar(multiplier),
            score: throwScoreFromTarget(number, multiplier),
            miss: false,
            number,
            multiplier
        };
    }

    const out = dartOut || 'none';
    // Soft checkout assist for common finishes
    if (out === 'double' && scoreBefore >= 2 && scoreBefore <= 40 && scoreBefore % 2 === 0 && Math.random() < 0.4) {
        const d = scoreBefore / 2;
        if (d >= 1 && d <= 20) {
            return {
                label: String(d),
                mult: 'D',
                score: scoreBefore,
                miss: false,
                number: d,
                multiplier: 2
            };
        }
    }
    if (out === 'double' && scoreBefore === 50 && Math.random() < 0.35) {
        return {
            label: 'BULL',
            mult: 'D',
            score: 50,
            miss: false,
            number: 'bull',
            multiplier: 2
        };
    }
    if (out === 'triple' && scoreBefore >= 3 && scoreBefore <= 60 && scoreBefore % 3 === 0 && Math.random() < 0.35) {
        const t = scoreBefore / 3;
        if (t >= 1 && t <= 20) {
            return {
                label: String(t),
                mult: 'T',
                score: scoreBefore,
                miss: false,
                number: t,
                multiplier: 3
            };
        }
    }
    if (out === 'none' && scoreBefore >= 1 && scoreBefore <= 20 && Math.random() < 0.35) {
        return {
            label: String(scoreBefore),
            mult: 'S',
            score: scoreBefore,
            miss: false,
            number: scoreBefore,
            multiplier: 1
        };
    }

    if (Math.random() < 0.08) {
        return { label: 'MISS', mult: null, score: 0, miss: true, number: null, multiplier: 1 };
    }

    let number;
    let multiplier = 1;
    const roll = Math.random();
    if (roll < 0.06) {
        number = 'bull';
        multiplier = Math.random() < 0.35 ? 2 : 1;
    } else {
        number = Math.floor(Math.random() * 20) + 1;
        const mRoll = Math.random();
        if (mRoll < 0.12) multiplier = 3;
        else if (mRoll < 0.32) multiplier = 2;
    }
    return {
        label: number === 'bull' ? 'BULL' : String(number),
        mult: multChar(multiplier),
        score: throwScoreFromTarget(number, multiplier),
        miss: false,
        number,
        multiplier
    };
}

function x01ContinueAfterThrow(gameData) {
    if (gameData.throwsThisTurn >= 3) {
        let nextIdx = gameData.activeIdx + 1;
        if (nextIdx >= gameData.players.length) nextIdx = 0;
        return showNextPlayerIntermission(gameData, 'x01', nextIdx);
    }
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function x01BeginTurnAt(gameData, idx) {
    gameData.activeIdx = idx;
    gameData.throwsThisTurn = 0;
    gameData.turnDarts = [];
    gameData.lastThrow = null;
    const player = gameData.players[idx];
    gameData.turnStartingScore = player ? player.score : (gameData.startScore || X01_START_SCORE);
    gameData.phase = makePhase('playing');
}

function confirmX01Setup(gameData, payload = {}) {
    if (!gameData || gameData.gameType !== 'x01') return { gameData, schedule: null };
    const startScore = x01NormalizeScore(payload.startScore != null ? payload.startScore : gameData.startScore);
    const dartIn = x01NormalizeInOut(payload.dartIn != null ? payload.dartIn : gameData.dartIn, 'none');
    const dartOut = x01NormalizeInOut(payload.dartOut != null ? payload.dartOut : gameData.dartOut, 'none');
    gameData.startScore = startScore;
    gameData.dartIn = dartIn;
    gameData.dartOut = dartOut;
    (gameData.players || []).forEach((p) => {
        p.score = startScore;
        p.hasOpened = dartIn === 'none';
    });
    gameData.activeIdx = 0;
    gameData.throwsThisTurn = 0;
    gameData.turnDarts = [];
    gameData.turnStartingScore = startScore;
    gameData.currentRound = 1;
    gameData.lastThrow = null;
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function handleX01Throw(gameData, throwSpec = null) {
    if (!gameData || gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }
    const player = gameData.players[gameData.activeIdx];
    if (!player) return { gameData, schedule: null };

    if (gameData.turnStartingScore == null) {
        gameData.turnStartingScore = player.score;
    }

    const dartIn = gameData.dartIn || 'none';
    const dartOut = gameData.dartOut || 'none';
    gameData.throwsThisTurn = (gameData.throwsThisTurn || 0) + 1;
    const scoreBefore = player.score;
    const dart = x01RollDart(throwSpec, scoreBefore, dartOut);
    x01RecordDart(gameData, dart.label, dart.mult, dart.score);

    gameData.lastThrow = {
        score: dart.score,
        bust: false,
        checkout: false,
        miss: !!dart.miss,
        number: dart.number,
        multiplier: dart.multiplier,
        label: dart.label,
        mult: dart.mult,
        opened: false
    };

    // Still seeking dart-in — only a matching dart opens (and counts)
    if (!player.hasOpened) {
        const opens = !dart.miss && x01MeetsMultRule(dart.number, dart.multiplier, dartIn);
        if (!opens) {
            return x01ContinueAfterThrow(gameData);
        }
        player.hasOpened = true;
        gameData.lastThrow.opened = true;
    }

    if (x01IsBust(scoreBefore, dart.score, dart.number, dart.multiplier, dart.miss, dartOut)) {
        player.score = gameData.turnStartingScore;
        gameData.lastThrow.bust = true;
        gameData.phase = makePhase('bust', {
            teamIndex: gameData.activeIdx,
            teamName: doublesThrowerName(gameData, gameData.activeIdx),
            playerName: doublesThrowerName(gameData, gameData.activeIdx),
            avatar: doublesThrowerAvatar(gameData, gameData.activeIdx),
            members: doublesMembersAt(gameData, gameData.activeIdx)
        });
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'x01_after_bust' }
        };
    }

    player.score = scoreBefore - dart.score;

    if (player.score === 0) {
        gameData.lastThrow.checkout = true;
        gameData.phase = makePhase('checkout', {
            teamIndex: gameData.activeIdx,
            teamName: doublesThrowerName(gameData, gameData.activeIdx),
            playerName: doublesThrowerName(gameData, gameData.activeIdx),
            avatar: doublesThrowerAvatar(gameData, gameData.activeIdx),
            members: doublesMembersAt(gameData, gameData.activeIdx)
        });
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'x01_show_winner' }
        };
    }

    return x01ContinueAfterThrow(gameData);
}

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleX01Throw(gameData, throwSpec, throwSource);
}

/**
 * Initial state for this game.
 *
 * `ordered` is the lineup already shuffled by the caller; `players` is the
 * original unshuffled list (a couple of games need seat order as registered);
 * `options` carries lineup mode and any game-specific setup.
 */
function init(ordered, options = {}, players = ordered) {
    const roster = ordered.slice(0, X01_MAX_PLAYERS);
    return {
        gameType: 'x01',
        players: roster.map(p => ({
            ...slimPlayer(p),
            score: X01_START_SCORE,
            hasOpened: true
        })),
        activeIdx: 0,
        throwsThisTurn: 0,
        turnDarts: [],
        turnStartingScore: X01_START_SCORE,
        startScore: X01_START_SCORE,
        dartIn: 'none',
        dartOut: 'none',
        currentRound: 1,
        isDoublesLineup: false,
        throwerIndices: roster.map(() => 0),
        phase: makePhase('setup'),
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
    const p = gameData.players && gameData.players[gameData.activeIdx];
    const score = p ? Number(p.score) : 0;
    const dartOut = gameData.dartOut || 'none';
    if (dartOut === 'double' && score >= 2 && score <= 40 && score % 2 === 0) return score / 2;
    if (dartOut === 'double' && score === 50) return 'bull';
    if (dartOut === 'triple' && score >= 3 && score <= 60 && score % 3 === 0) return score / 3;
    if (dartOut === 'none' && score >= 1 && score <= 20) return score;
    return 20;
}

/**
 * Controls specific to this game. Returns null when the action is not ours,
 * so the caller can carry on with generic handling.
 */
function handleAction(gameData, payload) {
    if (payload.type === 'CONFIRM_X01_SETUP') {
        return confirmX01Setup(gameData, payload);
    }
    return null;
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

    const roster = buildDoublesPlayerRoster(
        options.doublesTeams,
        players,
        (base) => ({
            ...base,
            score: X01_START_SCORE,
            hasOpened: true
        }),
        X01_MAX_PLAYERS
    );
    return {
        gameType: 'x01',
        ...roster,
        ...doublesBase,
        turnDarts: [],
        turnStartingScore: X01_START_SCORE,
        startScore: X01_START_SCORE,
        dartIn: 'none',
        dartOut: 'none',
        currentRound: 1,
        phase: makePhase('setup')
    };
}

module.exports = {
    initDoubles,
    handleAction,
    aimNumber,
    init,
    handleThrow,
    X01_MAX_PLAYERS,
    confirmX01Setup,
    handleX01Throw,
    x01BeginTurnAt,
    x01ContinueAfterThrow,
    x01IsBust,
    x01IsValidFinish,
    x01MeetsMultRule,
    x01NormalizeInOut,
    x01NormalizeScore,
    x01RecordDart,
    x01RollDart,
    X01_IN_OUT,
    X01_SCORES,
    X01_START_SCORE
};

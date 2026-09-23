/**
 * cricket — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    OVERLAY_EVENT_MS,
    buildDoublesPlayerRoster,
    doublesThrowerAvatar,
    doublesThrowerName,
    doublesWinnerFields,
    makePhase,
    multChar,
    normalizeMultiplier,
    scheduleRoundThenNextPlayer,
    slimPlayer
} = require('./core');

const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 'bull'];
const CRICKET_MAX_PLAYERS = 4;

/* ========== CRICKET ========== */

function cricketEmptyMarks() {
    const marks = {};
    CRICKET_TARGETS.forEach(t => {
        marks[String(t)] = 0;
    });
    return marks;
}

function cricketTargetKey(target) {
    return String(target);
}

function cricketPointValue(target) {
    return target === 'bull' ? 25 : Number(target);
}

function cricketNormalizeTarget(number) {
    if (number === 'bull') return 'bull';
    const n = Number(number);
    if (CRICKET_TARGETS.includes(n)) return n;
    return null;
}

function cricketMarksForHit(target, multiplier) {
    if (target === 'bull') return multiplier >= 2 ? 2 : 1;
    return normalizeMultiplier(multiplier);
}

function cricketPlayerClosedAll(player) {
    return CRICKET_TARGETS.every(t => (player.marks[cricketTargetKey(t)] || 0) >= 3);
}

function cricketNumberFullyClosed(gameData, target) {
    const key = cricketTargetKey(target);
    return gameData.players.every(p => (p.marks[key] || 0) >= 3);
}

function cricketOthersHaveOpen(gameData, playerId, target) {
    const key = cricketTargetKey(target);
    return gameData.players.some(p => p.id !== playerId && (p.marks[key] || 0) < 3);
}

function cricketCheckWinner(gameData) {
    const closed = gameData.players.filter(cricketPlayerClosedAll);
    if (!closed.length) return false;
    const maxScore = Math.max(...gameData.players.map(p => p.score || 0));
    const winners = closed.filter(p => (p.score || 0) >= maxScore);
    if (!winners.length) return false;
    const active = gameData.players[gameData.activeIdx];
    const winner = (active && winners.find(p => p.id === active.id)) || winners[0];
    gameData.phase = makePhase('winner', {
        ...doublesWinnerFields(winner),
        score: winner.score || 0,
        rounds: gameData.currentRound || 1
    });
    return true;
}

function cricketApplyHit(gameData, player, target, hitMarks) {
    const key = cricketTargetKey(target);
    let remaining = hitMarks;
    let marksAdded = 0;
    let points = 0;
    const before = player.marks[key] || 0;
    let opened = false;
    const wasFullyClosed = cricketNumberFullyClosed(gameData, target);

    while (remaining > 0) {
        const cur = player.marks[key] || 0;
        if (cur < 3) {
            player.marks[key] = cur + 1;
            marksAdded++;
            remaining--;
            if (player.marks[key] === 3 && before < 3) opened = true;
        } else if (cricketOthersHaveOpen(gameData, player.id, target)) {
            const value = cricketPointValue(target);
            points += value;
            player.score = (player.score || 0) + value;
            remaining--;
        } else {
            break;
        }
    }

    return {
        target,
        targetLabel: target === 'bull' ? 'BULL' : String(target),
        marksAdded,
        points,
        opened,
        numberClosed: !wasFullyClosed && cricketNumberFullyClosed(gameData, target),
        marksBefore: before,
        marksAfter: player.marks[key] || 0
    };
}

function cricketContinueAfterThrow(gameData) {
    if (gameData.throwsThisTurn >= 3) {
        let nextIdx = gameData.activeIdx + 1;
        let nextRound = gameData.currentRound || 1;
        let wrapped = false;
        if (nextIdx >= gameData.players.length) {
            nextIdx = 0;
            nextRound++;
            wrapped = true;
        }
        return scheduleRoundThenNextPlayer(gameData, 'cricket', nextIdx, nextRound, wrapped);
    }
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function cricketEventOverlay(result, player, gameData) {
    const displayName = gameData
        ? doublesThrowerName(gameData, gameData.activeIdx)
        : player.name;
    const displayAvatar = gameData
        ? doublesThrowerAvatar(gameData, gameData.activeIdx)
        : player.avatar;
    if (result.points > 0) {
        return makePhase('cricket_score', {
            playerName: displayName,
            avatar: displayAvatar,
            target: result.target,
            targetLabel: result.targetLabel,
            points: result.points,
            marksAfter: result.marksAfter,
            opened: result.opened,
            numberClosed: result.numberClosed,
            totalScore: player.score || 0,
            quip: result.points >= 60 ? 'Big Points!' : (result.points >= 40 ? 'On The Board!' : 'Points!')
        });
    }
    if (result.numberClosed) {
        return makePhase('cricket_dead', {
            playerName: displayName,
            avatar: displayAvatar,
            target: result.target,
            targetLabel: result.targetLabel,
            quip: 'No More Points!'
        });
    }
    if (result.opened) {
        return makePhase('cricket_closed', {
            playerName: displayName,
            avatar: displayAvatar,
            target: result.target,
            targetLabel: result.targetLabel,
            marksAfter: result.marksAfter,
            quip: 'Closed!'
        });
    }
    return null;
}

function cricketRecordDart(gameData, label, mult) {
    if (!Array.isArray(gameData.turnDarts)) gameData.turnDarts = [];
    gameData.turnDarts.push({
        label: label || 'MISS',
        mult: mult || null
    });
    if (gameData.turnDarts.length > 3) {
        gameData.turnDarts = gameData.turnDarts.slice(-3);
    }
}

function handleCricketThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }

    gameData.throwsThisTurn++;
    const currentPlayer = gameData.players[gameData.activeIdx];
    gameData.lastThrow = { hit: false, cricket: false };

    let target = null;
    let multiplier = 1;

    if (throwSpec) {
        if (throwSpec.miss) {
            target = null;
            multiplier = 1;
        } else {
            target = cricketNormalizeTarget(throwSpec.number);
            multiplier = throwSpec.multiplier;
        }
    } else if (Math.random() < 0.72) {
        target = CRICKET_TARGETS[Math.floor(Math.random() * CRICKET_TARGETS.length)];
        const roll = Math.random();
        multiplier = 1;
        if (target === 'bull') {
            if (roll > 0.75) multiplier = 2;
        } else {
            if (roll > 0.70 && roll <= 0.90) multiplier = 2;
            if (roll > 0.90) multiplier = 3;
        }
    }

    if (target == null) {
        // Off the board → MISS. On the board but not 15–20/bull → still announce the dart number.
        if (throwSpec && !throwSpec.miss) {
            const label = throwSpec.number === 'bull' ? 'BULL' : String(throwSpec.number);
            cricketRecordDart(gameData, label, multChar(multiplier));
            gameData.lastThrow = {
                hit: false,
                cricket: false,
                miss: false,
                number: throwSpec.number,
                multiplier,
                offTarget: true
            };
        } else {
            cricketRecordDart(gameData, 'MISS', null);
            gameData.lastThrow = { hit: false, cricket: false, miss: true };
        }
        return cricketContinueAfterThrow(gameData);
    }

    const hitMarks = cricketMarksForHit(target, multiplier);
    const result = cricketApplyHit(gameData, currentPlayer, target, hitMarks);
    cricketRecordDart(
        gameData,
        target === 'bull' ? 'BULL' : String(target),
        multChar(multiplier)
    );
    gameData.lastThrow = {
        hit: result.marksAdded > 0 || result.points > 0,
        cricket: true,
        target,
        number: target,
        multiplier,
        marksAdded: result.marksAdded,
        marksBefore: result.marksBefore,
        marksAfter: result.marksAfter,
        points: result.points,
        opened: result.opened,
        numberClosed: result.numberClosed
    };

    if (cricketCheckWinner(gameData)) {
        return { gameData, schedule: null };
    }

    const overlay = cricketEventOverlay(result, currentPlayer, gameData);
    if (overlay) {
        gameData.phase = overlay;
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'cricket_after_event' }
        };
    }

    return cricketContinueAfterThrow(gameData);
}

/** Round vocabulary for the shared banner — see core's roundAnnounceInfo. */
const meta = {
    roundEyebrow: 'NEXT OVER',
    // No fixed length: cricket runs until someone closes everything out, so a
    // "final round" preview means wherever play currently is.
    openEndedRounds: true
};

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleCricketThrow(gameData, throwSpec, throwSource);
}

/**
 * Initial state for this game.
 *
 * `ordered` is the lineup already shuffled by the caller; `players` is the
 * original unshuffled list (a couple of games need seat order as registered);
 * `options` carries lineup mode and any game-specific setup.
 */
function init(ordered, options = {}, players = ordered) {
    const roster = ordered.slice(0, CRICKET_MAX_PLAYERS);
    return {
        gameType: 'cricket',
        players: roster.map(p => ({
            ...slimPlayer(p),
            score: 0,
            marks: cricketEmptyMarks()
        })),
        activeIdx: 0,
        throwsThisTurn: 0,
        turnDarts: [],
        currentRound: 1,
        isDoublesLineup: false,
        throwerIndices: roster.map(() => 0),
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('cricket', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */,
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
    const open = CRICKET_TARGETS.filter((t) => {
        const key = cricketTargetKey(t);
        return !p || !p.marks || (p.marks[key] || 0) < 3;
    });
    const pool = open.length ? open : CRICKET_TARGETS;
    return pool[Math.floor(Math.random() * pool.length)];
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

    const roster = buildDoublesPlayerRoster(
        options.doublesTeams,
        players,
        (base) => ({
            ...base,
            score: 0,
            marks: cricketEmptyMarks()
        }),
        CRICKET_MAX_PLAYERS
    );
    return {
        gameType: 'cricket',
        ...roster,
        ...doublesBase,
        turnDarts: [],
        currentRound: 1,
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('cricket', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */
    };
}

module.exports = {
    initDoubles,
    aimNumber,
    init,
    handleThrow,
    meta,
    cricketApplyHit,
    cricketCheckWinner,
    cricketContinueAfterThrow,
    cricketEmptyMarks,
    cricketEventOverlay,
    cricketMarksForHit,
    cricketNormalizeTarget,
    cricketNumberFullyClosed,
    cricketOthersHaveOpen,
    cricketPlayerClosedAll,
    cricketPointValue,
    cricketRecordDart,
    cricketTargetKey,
    handleCricketThrow,
    CRICKET_MAX_PLAYERS,
    CRICKET_TARGETS
};

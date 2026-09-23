/**
 * killer — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    DARTBOARD_WHEEL,
    OVERLAY_EVENT_MS,
    OVERLAY_ROUND_ANNOUNCE_MS,
    SEGMENTS_PER_NUMBER,
    buildDoublesPlayerRoster,
    dartboardHitFromSpec,
    doublesAdvanceThrowerAfterVisit,
    doublesContenderFields,
    doublesWinnerFields,
    generateDegreeSpacedTargets,
    makePhase,
    makeRoundAnnouncePhase,
    pickQuip,
    scheduleRoundThenNextPlayer,
    slimPlayer
} = require('./core');

const KILLER_MAX_ROUNDS = 12;

function killerRoundMultiplier(currentRound) {
    const round = Math.min(Math.max(currentRound || 1, 1), KILLER_MAX_ROUNDS);
    if (round >= 10) return 3;
    if (round >= 7) return 2;
    return 1;
}

const KILLER_MARKS_TO_QUALIFY = 3;
const KILLER_STARTING_LIVES = 3;
const KILLER_BOOST_QUIPS = [
    'Double Tap!',
    'Marked Cold!',
    'Closing In!',
    'Dead Eye!',
    'On Target!'
];
const KILLER_KNOCK_QUIPS = [
    'Cut Deep!',
    'Bleed Out!',
    'Wounded!',
    'Hit Confirmed!',
    'Softened Up!'
];


const KILLER_VIDEO_BECAME_MS = 5500;  // became-charon.mp4 ~5.0s
const KILLER_VIDEO_DEATH_MS = 5500;   // elim-skyfall-take-the-shot.mp4 ~4.8s
const KILLER_VIDEO_LOST_MS = 5200;    // lost-excommunicado.mp4 ~4.4s
const KILLER_WEDGE_ANIM_MS = 900;
const KILLER_WEDGE_ANIM_TAIL_MS = 150;

function killerAlivePlayers(players) {
    return players.filter(p => p.lives >= 0);
}

function killerNextAliveIndex(players, fromIdx) {
    let idx = fromIdx;
    let loops = 0;
    do {
        idx = (idx + 1) % players.length;
        loops++;
    } while (players[idx].lives < 0 && loops < players.length);
    return idx;
}

function killerAdvanceTurn(gameData) {
    // Round announce (if any) already played before intermission.
    gameData.throwsThisTurn = 0;
    const prevIdx = gameData.activeIdx;
    doublesAdvanceThrowerAfterVisit(gameData, prevIdx);
    gameData.activeIdx = killerNextAliveIndex(gameData.players, gameData.activeIdx);
    if (gameData.activeIdx <= prevIdx && gameData.currentRound < KILLER_MAX_ROUNDS) {
        gameData.currentRound++;
    }
    gameData.lastThrow = null;
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function killerIsWrapping(gameData, nextIdx) {
    return nextIdx <= gameData.activeIdx;
}

function killerWouldBumpRound(gameData, nextIdx) {
    return killerIsWrapping(gameData, nextIdx) && gameData.currentRound < KILLER_MAX_ROUNDS;
}

/** Wedge fill on the board (0–3). Civilians use marks; Killers sit at 3. */
function killerWedgeCount(player) {
    if (!player || player.lives < 0) return 0;
    if (player.isKiller) return KILLER_MARKS_TO_QUALIFY;
    const marks = Number(player.killerMarks);
    if (Number.isFinite(marks) && marks > 0) return Math.min(KILLER_MARKS_TO_QUALIFY, marks);
    // Untouched civilians start with lives=3 but 0 wedges — don't count starting HP as wedges.
    return 0;
}

/**
 * After round 12 completes:
 * - sole Killer wins
 * - multiple Killers → co-winners
 * - no Killers → most wedges; tied wedges → co-winners
 */
function killerResolveMatch(gameData) {
    const alive = killerAlivePlayers(gameData.players);
    if (alive.length === 1) {
        gameData.phase = makePhase('winner', {
            ...doublesWinnerFields(alive[0]),
            reason: 'last_standing'
        });
        return { gameData, schedule: null };
    }
    if (alive.length === 0) {
        gameData.phase = makePhase('draw', {
            contenders: [],
            reason: 'rounds'
        });
        return { gameData, schedule: null };
    }

    const killers = alive.filter(p => !!p.isKiller);
    if (killers.length === 1) {
        gameData.phase = makePhase('winner', {
            ...doublesWinnerFields(killers[0]),
            reason: 'sole_killer'
        });
        return { gameData, schedule: null };
    }
    if (killers.length > 1) {
        gameData.phase = makePhase('draw', {
            contenders: killers.map(p => doublesContenderFields(p)),
            reason: 'killers'
        });
        return { gameData, schedule: null };
    }

    let bestWedges = -1;
    alive.forEach(p => {
        bestWedges = Math.max(bestWedges, killerWedgeCount(p));
    });
    const top = alive.filter(p => killerWedgeCount(p) === bestWedges);
    if (top.length === 1) {
        gameData.phase = makePhase('winner', {
            ...doublesWinnerFields(top[0]),
            reason: 'wedges',
            wedges: bestWedges
        });
        return { gameData, schedule: null };
    }
    gameData.phase = makePhase('draw', {
        contenders: top.map(p => doublesContenderFields(p)),
        reason: 'wedges',
        wedges: bestWedges
    });
    return { gameData, schedule: null };
}

function killerShowIntermission(gameData) {
    const nextIdx = killerNextAliveIndex(gameData.players, gameData.activeIdx);
    const wrapping = killerIsWrapping(gameData, nextIdx);

    // Finished the last round — don't keep looping on round 12.
    if (wrapping && (gameData.currentRound || 1) >= KILLER_MAX_ROUNDS) {
        return killerResolveMatch(gameData);
    }

    const wouldBump = killerWouldBumpRound(gameData, nextIdx);
    const nextRound = (gameData.currentRound || 1) + (wouldBump ? 1 : 0);

    // Solo survivor: no next-player card — still announce a new round when wrapping.
    if (nextIdx === gameData.activeIdx) {
        if (wouldBump) {
            gameData.phase = makeRoundAnnouncePhase('killer', nextRound);
            return {
                gameData,
                schedule: { delayMs: OVERLAY_ROUND_ANNOUNCE_MS, next: 'killer_advance_turn' }
            };
        }
        return killerAdvanceTurn(gameData);
    }

    return scheduleRoundThenNextPlayer(
        gameData,
        'killer',
        nextIdx,
        nextRound,
        wouldBump,
        { targetNumber: gameData.players[nextIdx].targetNumber }
    );
}

function killerCheckWinner(gameData) {
    const alive = killerAlivePlayers(gameData.players);
    if (alive.length === 1) {
        const winner = alive[0];
        gameData.phase = makePhase('winner', doublesWinnerFields(winner));
        return true;
    }
    return false;
}

function killerWedgeAnimWaitMs(gameData) {
    const last = gameData && gameData.lastThrow;
    if (!last) return 0;
    let count = 0;
    if (last.effect === 'mark' && Array.isArray(last.markSegments)) {
        count = last.markSegments.length;
    } else if (last.effect === 'strike' && Array.isArray(last.strikeSegments)) {
        count = last.strikeSegments.length;
    } else if (last.effect === 'mark' || last.effect === 'strike') {
        count = Math.max(1, last.multiplier || 1);
    }
    if (count <= 0) return 0;
    return (count * KILLER_WEDGE_ANIM_MS) + KILLER_WEDGE_ANIM_TAIL_MS;
}

/** Full event overlay hold = board wedge anim + on-screen takeover time. */
function killerOverlayDelayMs(gameData) {
    return killerWedgeAnimWaitMs(gameData) + OVERLAY_EVENT_MS;
}

function killerScheduleAfterOverlay(gameData, delayMs, opts) {
    const next = gameData.throwsThisTurn >= 3 ? 'killer_show_intermission' : 'killer_resume_playing';
    return {
        gameData,
        schedule: Object.assign({ delayMs, next }, opts || {})
    };
}

function killerContinueAfterThrow(gameData) {
    if (gameData.throwsThisTurn >= 3) {
        return {
            gameData,
            schedule: { delayMs: 600, next: 'killer_show_intermission' }
        };
    }
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

// Rounds 1-6: 1x, 7-9: 2x, 10-12: 3x (matches the right-side rounds tracker)
function handleKillerThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }

    const player = gameData.players[gameData.activeIdx];
    if (!player || player.lives < 0) {
        return { gameData, schedule: null };
    }

    gameData.throwsThisTurn++;
    const hitNumber = throwSpec
        ? dartboardHitFromSpec(throwSpec)
        : (Math.random() < 0.65
            ? DARTBOARD_WHEEL[Math.floor(Math.random() * DARTBOARD_WHEEL.length)]
            : null);

    const dartMultiplier = throwSpec
        ? throwSpec.multiplier
        : (Math.random() < 0.12 ? 3 : Math.random() < 0.28 ? 2 : 1);
    const roundMultiplier = killerRoundMultiplier(gameData.currentRound);
    const multiplier = dartMultiplier * roundMultiplier;
    const trueMultHit = dartMultiplier >= 2;
    const isBullHit = !!(throwSpec && !throwSpec.miss && throwSpec.number === 'bull');

    gameData.lastThrow = {
        hitNumber,
        effect: 'miss',
        // Bull isn't a wedge — no Killer effect, but callout must say BULL not MISS
        miss: hitNumber === null && !isBullHit,
        number: throwSpec
            ? (throwSpec.miss ? null : throwSpec.number)
            : hitNumber,
        multiplier,
        dartMultiplier,
        roundMultiplier
    };
    if (throwSpec && throwSpec.sector) gameData.lastThrow.sector = throwSpec.sector;

    let becameKiller = false;
    let lostKiller = false;
    let eliminated = false;
    let victim = null;
    let marksGained = 0;
    let marksLost = 0;

    if (hitNumber !== null && !player.isKiller && hitNumber === player.targetNumber) {
        const marksBefore = player.killerMarks;
        player.killerMarks = Math.min(
            KILLER_MARKS_TO_QUALIFY,
            player.killerMarks + multiplier
        );
        marksGained = player.killerMarks - marksBefore;
        const markSegments = [];
        for (let s = marksBefore; s < player.killerMarks; s++) {
            markSegments.push(s);
        }
        gameData.lastThrow.effect = 'mark';
        gameData.lastThrow.playerId = player.id;
        gameData.lastThrow.markSegments = markSegments;
        if (player.killerMarks >= KILLER_MARKS_TO_QUALIFY) {
            player.isKiller = true;
            player.lives = player.killerMarks;
            becameKiller = true;
        }
    } else if (hitNumber !== null && player.isKiller) {
        victim = gameData.players.find(p => (
            p.id !== player.id && p.lives >= 0 && p.targetNumber === hitNumber
        ));
        if (victim) {
            const strikeSegments = [];
            const mult = multiplier;
            const wasKiller = !!victim.isKiller;

            if (victim.isKiller) {
                const livesBefore = victim.lives;
                victim.lives -= mult;
                marksLost = Math.min(livesBefore, mult);
                const filledBefore = Math.max(0, Math.min(SEGMENTS_PER_NUMBER, livesBefore));
                const filledAfter = Math.max(0, Math.min(SEGMENTS_PER_NUMBER, victim.lives));
                for (let s = filledBefore - 1; s >= filledAfter; s--) {
                    strikeSegments.push(s);
                }
                if (victim.lives >= 0 && victim.lives < KILLER_MARKS_TO_QUALIFY) {
                    victim.isKiller = false;
                    victim.killerMarks = Math.max(0, victim.lives);
                    lostKiller = wasKiller;
                }
            } else if (victim.killerMarks > 0) {
                const marksBefore = victim.killerMarks;
                victim.killerMarks = Math.max(0, victim.killerMarks - mult);
                marksLost = marksBefore - victim.killerMarks;
                for (let s = marksBefore - 1; s >= victim.killerMarks; s--) {
                    strikeSegments.push(s);
                }
                // Exact clear leaves them empty for a follow-up kill;
                // overkill (e.g. 1 mark vs double) finishes them now.
                if (mult > marksBefore) {
                    victim.killerMarks = 0;
                    victim.lives = -1;
                } else {
                    victim.lives = victim.killerMarks;
                }
            } else {
                // Already empty — kill with no wedge flash
                victim.lives = -1;
            }

            eliminated = victim.lives < 0;
            gameData.lastThrow.effect = 'strike';
            gameData.lastThrow.victimId = victim.id;
            gameData.lastThrow.strikeSegments = strikeSegments;
            gameData.lastThrow.strikeSegment = strikeSegments.length
                ? strikeSegments[0]
                : null;
        }
    }

    if (becameKiller) {
        gameData.phase = makePhase('became_killer', {
            playerId: player.id,
            playerName: player.name,
            avatar: player.avatar,
            targetNumber: player.targetNumber
        });
        if (killerCheckWinner(gameData)) return { gameData, schedule: null };
        return killerScheduleAfterOverlay(gameData, killerOverlayDelayMs(gameData), {
            delayMsWithVideo: killerWedgeAnimWaitMs(gameData) + KILLER_VIDEO_BECAME_MS
        });
    }

    if (eliminated && victim) {
        gameData.phase = makePhase('death', {
            attackerId: player.id,
            attackerName: player.name,
            victimId: victim.id,
            victimName: victim.name,
            victimAvatar: victim.avatar,
            hitNumber
        });
        return {
            gameData,
            schedule: {
                delayMs: killerOverlayDelayMs(gameData),
                delayMsWithVideo: killerWedgeAnimWaitMs(gameData) + KILLER_VIDEO_DEATH_MS,
                next: 'killer_after_elimination'
            }
        };
    }

    if (lostKiller && victim) {
        gameData.phase = makePhase('lost_killer', {
            playerId: victim.id,
            playerName: victim.name,
            avatar: victim.avatar,
            attackerName: player.name,
            targetNumber: victim.targetNumber,
            livesRemaining: victim.lives
        });
        if (killerCheckWinner(gameData)) return { gameData, schedule: null };
        return killerScheduleAfterOverlay(gameData, killerOverlayDelayMs(gameData), {
            delayMsWithVideo: killerWedgeAnimWaitMs(gameData) + KILLER_VIDEO_LOST_MS
        });
    }

    if (trueMultHit && gameData.lastThrow.effect === 'mark' && marksGained > 0) {
        gameData.phase = makePhase('mult_boost', {
            playerName: player.name,
            avatar: player.avatar,
            multiplier: dartMultiplier,
            steps: marksGained,
            quip: pickQuip(KILLER_BOOST_QUIPS),
            targetNumber: player.targetNumber
        });
        return killerScheduleAfterOverlay(gameData, killerOverlayDelayMs(gameData));
    }

    if (trueMultHit && gameData.lastThrow.effect === 'strike' && victim) {
        gameData.phase = makePhase('mult_knock', {
            playerName: victim.name,
            avatar: victim.avatar,
            actorName: player.name,
            multiplier: dartMultiplier,
            steps: Math.max(1, marksLost),
            quip: pickQuip(KILLER_KNOCK_QUIPS),
            targetNumber: victim.targetNumber
        });
        if (killerCheckWinner(gameData)) return { gameData, schedule: null };
        return killerScheduleAfterOverlay(gameData, killerOverlayDelayMs(gameData));
    }

    if (killerCheckWinner(gameData)) return { gameData, schedule: null };
    return killerContinueAfterThrow(gameData);
}

/** Round vocabulary for the shared banner — see core's roundAnnounceInfo. */
const meta = {
    maxRounds: KILLER_MAX_ROUNDS,
    roundEyebrow: 'CONTRACT ROUND',
    roundMultiplier: killerRoundMultiplier,
    // Killer deals in marks and damage, not points.
    multiplierTags: { 2: 'DOUBLE MARKS', 3: 'TRIPLE DAMAGE' }
};

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleKillerThrow(gameData, throwSpec, throwSource);
}

/**
 * Initial state for this game.
 *
 * `ordered` is the lineup already shuffled by the caller; `players` is the
 * original unshuffled list (a couple of games need seat order as registered);
 * `options` carries lineup mode and any game-specific setup.
 */
function init(ordered, options = {}, players = ordered) {
    const targets = generateDegreeSpacedTargets(ordered.length);
    return {
        gameType: 'killer',
        players: ordered.map((p, idx) => ({
            ...slimPlayer(p),
            targetNumber: targets[idx],
            lives: KILLER_STARTING_LIVES,
            killerMarks: 0,
            isKiller: false
        })),
        activeIdx: 0,
        throwsThisTurn: 0,
        currentRound: 1,
        isDoublesLineup: false,
        throwerIndices: ordered.map(() => 0),
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('killer', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */,
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
    if (p && p.isKiller) {
        const living = (gameData.players || []).filter((o, idx) =>
            o && idx !== gameData.activeIdx && !o.eliminated && (o.lives == null || o.lives > 0));
        if (living.length) {
            const victim = living[Math.floor(Math.random() * living.length)];
            return victim.targetNumber || 20;
        }
    }
    return (p && p.targetNumber) || 20;
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
        targetNumber: 0,
        lives: KILLER_STARTING_LIVES,
        killerMarks: 0,
        isKiller: false
    }));
    const targets = generateDegreeSpacedTargets(roster.players.length);
    roster.players.forEach((p, idx) => { p.targetNumber = targets[idx]; });
    return {
        gameType: 'killer',
        ...roster,
        ...doublesBase,
        currentRound: 1,
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('killer', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */
    };
}

module.exports = {
    initDoubles,
    aimNumber,
    init,
    handleThrow,
    KILLER_MAX_ROUNDS,
    killerRoundMultiplier,
    meta,
    handleKillerThrow,
    killerAdvanceTurn,
    killerAlivePlayers,
    killerCheckWinner,
    killerContinueAfterThrow,
    killerIsWrapping,
    killerNextAliveIndex,
    killerOverlayDelayMs,
    killerResolveMatch,
    killerScheduleAfterOverlay,
    killerShowIntermission,
    killerWedgeAnimWaitMs,
    killerWedgeCount,
    killerWouldBumpRound,
    KILLER_BOOST_QUIPS,
    KILLER_KNOCK_QUIPS,
    KILLER_MARKS_TO_QUALIFY,
    KILLER_STARTING_LIVES,
    KILLER_VIDEO_BECAME_MS,
    KILLER_VIDEO_DEATH_MS,
    KILLER_VIDEO_LOST_MS,
    KILLER_WEDGE_ANIM_MS,
    KILLER_WEDGE_ANIM_TAIL_MS
};

/**
 * derby — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    OVERLAY_EVENT_MS,
    buildDoublesPlayerRoster,
    dartboardHitFromSpec,
    doublesContenderFields,
    doublesWinnerFields,
    generateSymmetricTargets,
    makePhase,
    pickQuip,
    scheduleRoundThenNextPlayer,
    slimPlayer
} = require('./core');

const DERBY_MAX_ROUNDS = 8;

const DERBY_MAX_TICKS = 9;
const DERBY_AIM_LEAD_GAP = 3; // opponent this many ticks ahead of us → hunt them
const DERBY_AIM_THREAT_WITHIN = 3; // ticks from finish (MAX 9 → threaten at 6+)
const DERBY_BOOST_QUIPS = [
    'Full Gallop!',
    'Thundering Ahead!',
    'Stretch Drive!',
    'On The Rail!',
    'Lightning Strides!'
];
const DERBY_KNOCK_QUIPS = [
    'Boxed In!',
    'Checked Hard!',
    'Lost A Length!',
    'Reined In!',
    'Fallen Back!'
];
const DERBY_KNOCK_SINGLE_QUIPS = [
    'Nicked!',
    'Tapped Back!',
    'One Length!',
    'Slight Check!',
    'Eased Off!'
];



function derbyPlayersAtFinish(gameData) {
    return (gameData.players || []).filter(p => (p.score || 0) >= DERBY_MAX_TICKS);
}

function derbyLeaders(gameData) {
    let best = -1;
    (gameData.players || []).forEach(p => {
        best = Math.max(best, p.score || 0);
    });
    return (gameData.players || []).filter(p => (p.score || 0) === best);
}

function derbyWinner(gameData, winner = null) {
    const champ = winner || derbyLeaders(gameData)[0] || gameData.players[0];
    gameData.phase = makePhase('winner', doublesWinnerFields(champ));
}

function derbyDraw(gameData, contenders) {
    const list = (contenders || []).map(p => doublesContenderFields(p));
    gameData.phase = makePhase('draw', {
        contenders: list,
        names: list.map(p => p.name)
    });
}

function derbyResolveMatch(gameData) {
    const finishers = derbyPlayersAtFinish(gameData);
    if (finishers.length >= 2) {
        derbyDraw(gameData, finishers);
        return { gameData, schedule: null };
    }
    if (finishers.length === 1) {
        derbyWinner(gameData, finishers[0]);
        return { gameData, schedule: null };
    }

    const leaders = derbyLeaders(gameData);
    if (leaders.length >= 2) {
        derbyDraw(gameData, leaders);
        return { gameData, schedule: null };
    }
    derbyWinner(gameData, leaders[0] || gameData.players[0]);
    return { gameData, schedule: null };
}

function derbyPlayerFinished(player) {
    return !!(player && (player.finished || (player.score || 0) >= DERBY_MAX_TICKS));
}

function derbyPastPostPhase(player) {
    return makePhase('past_post', {
        playerId: player.id,
        playerName: player.name,
        avatar: player.avatar,
        targetNumber: player.targetNumber
    });
}

function derbyMarkFinishIfNeeded(gameData, player) {
    if ((player.score || 0) < DERBY_MAX_TICKS) return false;
    player.score = DERBY_MAX_TICKS;
    gameData.finishLineOpen = true;
    if (player.finished) return false;
    player.finished = true;
    return true;
}

function derbyScheduleAfterPastPost(gameData) {
    return {
        gameData,
        schedule: { delayMs: OVERLAY_EVENT_MS, next: 'derby_after_past_post' }
    };
}

function derbyShowPastPost(gameData, player) {
    gameData.pendingPastPost = null;
    gameData.phase = derbyPastPostPhase(player);
    return derbyScheduleAfterPastPost(gameData);
}

function derbyMultOverlayPhase(selfHit, hitPlayer, actor, multiplier) {
    const quipList = selfHit
        ? DERBY_BOOST_QUIPS
        : (multiplier === 1 ? DERBY_KNOCK_SINGLE_QUIPS : DERBY_KNOCK_QUIPS);
    return makePhase(selfHit ? 'mult_boost' : 'mult_knock', {
        playerName: hitPlayer.name,
        avatar: hitPlayer.avatar,
        actorName: actor.name,
        multiplier,
        steps: multiplier,
        quip: pickQuip(quipList),
        selfHit,
        targetNumber: hitPlayer.targetNumber
    });
}

function derbyContinueAfterThrow(gameData) {
    if (gameData.throwsThisTurn === 3) {
        let nextIdx = gameData.activeIdx + 1;
        let nextRound = gameData.currentRound;
        let wrapped = false;
        if (nextIdx >= gameData.players.length) {
            nextIdx = 0;
            nextRound++;
            wrapped = true;
        }

        // First past the post: finish the current rotation so trailing horses can catch up.
        // Also resolve when all 8 rounds are done.
        if (nextRound > DERBY_MAX_ROUNDS || (gameData.finishLineOpen && wrapped)) {
            gameData.phase = makePhase('playing');
            return {
                gameData,
                schedule: { delayMs: 900, next: 'derby_resolve_match' }
            };
        }

        return scheduleRoundThenNextPlayer(gameData, 'derby', nextIdx, nextRound, wrapped);
    }

    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

function handleDerbyThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing' || gameData.currentRound > 8) {
        return { gameData, schedule: null };
    }

    gameData.throwsThisTurn++;
    const currentPlayer = gameData.players[gameData.activeIdx];
    gameData.lastThrow = { hit: false, selfHit: false, multiplier: 1 };
    gameData.pendingPastPost = null;

    let hitPlayer = null;
    let multiplier = 1;
    let selfHit = false;
    let newlyFinished = false;
    let scoredKnock = false;

    if (throwSpec) {
        const hitNumber = dartboardHitFromSpec(throwSpec);
        if (hitNumber !== null) {
            // Always record the board hit for callouts — even if no horse owns that number
            multiplier = Number(throwSpec.multiplier) || 1;
            gameData.lastThrow.number = hitNumber;
            gameData.lastThrow.multiplier = multiplier;
            if (throwSpec.sector) gameData.lastThrow.sector = throwSpec.sector;

            const rolledIndex = gameData.players.findIndex(p => p.targetNumber === hitNumber);
            if (rolledIndex >= 0) {
                hitPlayer = gameData.players[rolledIndex];
                selfHit = rolledIndex === gameData.activeIdx;
                gameData.lastThrow.hit = true;
                gameData.lastThrow.selfHit = selfHit;
                gameData.lastThrow.hitPlayerName = hitPlayer.name;

                if (selfHit) {
                    currentPlayer.score = (currentPlayer.score || 0) + multiplier;
                    newlyFinished = derbyMarkFinishIfNeeded(gameData, currentPlayer);
                } else if (derbyPlayerFinished(hitPlayer)) {
                    // Finished horses can't be sent backwards
                    gameData.lastThrow.immune = true;
                } else {
                    const before = hitPlayer.score || 0;
                    // Already at the gate — knock is a no-op, skip overlay
                    if (before > 0) {
                        hitPlayer.score = Math.max(0, before - multiplier);
                        scoredKnock = true;
                    }
                }
            }
        } else if (throwSpec.miss) {
            // True board miss / bounce
            gameData.lastThrow.miss = true;
        } else if (throwSpec.number === 'bull') {
            // Bull is never a horse number — no race effect, but announce BULL/25 not MISS
            multiplier = Number(throwSpec.multiplier) || 1;
            gameData.lastThrow.miss = false;
            gameData.lastThrow.hit = false;
            gameData.lastThrow.number = 'bull';
            gameData.lastThrow.multiplier = multiplier;
            if (throwSpec.sector) gameData.lastThrow.sector = throwSpec.sector;
        } else {
            gameData.lastThrow.miss = true;
        }
    } else if (Math.random() < 0.60) {
        const rolledIndex = Math.floor(Math.random() * gameData.players.length);
        hitPlayer = gameData.players[rolledIndex];
        const randMult = Math.random();
        multiplier = 1;
        if (randMult > 0.70 && randMult <= 0.90) multiplier = 2;
        if (randMult > 0.90) multiplier = 3;
        selfHit = rolledIndex === gameData.activeIdx;
        gameData.lastThrow.hit = true;
        gameData.lastThrow.multiplier = multiplier;
        gameData.lastThrow.number = hitPlayer.targetNumber;
        gameData.lastThrow.selfHit = selfHit;
        gameData.lastThrow.hitPlayerName = hitPlayer.name;

        if (selfHit) {
            currentPlayer.score = (currentPlayer.score || 0) + multiplier;
            newlyFinished = derbyMarkFinishIfNeeded(gameData, currentPlayer);
        } else if (derbyPlayerFinished(hitPlayer)) {
            gameData.lastThrow.immune = true;
        } else {
            const before = hitPlayer.score || 0;
            if (before > 0) {
                hitPlayer.score = Math.max(0, before - multiplier);
                scoredKnock = true;
            }
        }
    } else {
        // Random path: no horse effect → treat as board miss for callout
        gameData.lastThrow.miss = true;
    }

    if (newlyFinished) {
        gameData.pendingPastPost = {
            playerId: currentPlayer.id,
            playerName: currentPlayer.name,
            avatar: currentPlayer.avatar,
            targetNumber: currentPlayer.targetNumber
        };
    }

    if (selfHit && multiplier >= 2) {
        gameData.phase = derbyMultOverlayPhase(true, currentPlayer, currentPlayer, multiplier);
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'derby_after_mult' }
        };
    }

    if (scoredKnock) {
        gameData.phase = derbyMultOverlayPhase(false, hitPlayer, currentPlayer, multiplier);
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'derby_after_mult' }
        };
    }

    if (newlyFinished) {
        return derbyShowPastPost(gameData, currentPlayer);
    }

    return derbyContinueAfterThrow(gameData);
}

/** Round vocabulary for the shared banner — see core's roundAnnounceInfo. */
const meta = {
    maxRounds: DERBY_MAX_ROUNDS,
    roundEyebrow: 'POST TIME',
    lastRoundTag: 'FINAL FURLONG'
};

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleDerbyThrow(gameData, throwSpec, throwSource);
}

/**
 * Initial state for this game.
 *
 * `ordered` is the lineup already shuffled by the caller; `players` is the
 * original unshuffled list (a couple of games need seat order as registered);
 * `options` carries lineup mode and any game-specific setup.
 */
function init(ordered, options = {}, players = ordered) {
    const targets = generateSymmetricTargets(ordered.length);
    return {
        gameType: 'derby',
        players: ordered.map((p, idx) => ({
            ...slimPlayer(p),
            score: 0,
            finished: false,
            targetNumber: targets[idx]
        })),
        activeIdx: 0,
        throwsThisTurn: 0,
        currentRound: 1,
        finishLineOpen: false,
        isDoublesLineup: false,
        throwerIndices: ordered.map(() => 0),
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('derby', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */,
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
    return resolveDerbyAimNumber(gameData);
}

/** Derby bot aim: knock near-winners / big leaders first, else self-boost. */



function resolveDerbyAimNumber(gameData) {
    const me = gameData && gameData.players && gameData.players[gameData.activeIdx];
    const myScore = me ? (Number(me.score) || 0) : 0;
    const myTarget = (me && me.targetNumber) || 20;
    const opponents = (gameData.players || []).filter((p, idx) =>
        p && idx !== gameData.activeIdx && !derbyPlayerFinished(p));

    // 1) About to win — highest score among those within N of the finish line
    const threatFloor = DERBY_MAX_TICKS - DERBY_AIM_THREAT_WITHIN;
    const threats = opponents
        .filter((p) => (Number(p.score) || 0) >= threatFloor && (Number(p.score) || 0) > 0)
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    if (threats.length && threats[0].targetNumber) {
        return threats[0].targetNumber;
    }

    // 2) Too far ahead of us — biggest lead (≥ gap)
    const leaders = opponents
        .filter((p) => {
            const s = Number(p.score) || 0;
            return s > 0 && (s - myScore) >= DERBY_AIM_LEAD_GAP;
        })
        .sort((a, b) => {
            const leadA = (Number(a.score) || 0) - myScore;
            const leadB = (Number(b.score) || 0) - myScore;
            return leadB - leadA;
        });
    if (leaders.length && leaders[0].targetNumber) {
        return leaders[0].targetNumber;
    }

    // 3) Self-boost
    return myTarget;
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
        finished: false,
        targetNumber: 0
    }));
    const targets = generateSymmetricTargets(roster.players.length);
    roster.players.forEach((p, idx) => { p.targetNumber = targets[idx]; });
    return {
        gameType: 'derby',
        ...roster,
        ...doublesBase,
        currentRound: 1,
        finishLineOpen: false,
        phase: makePhase('playing') /* was makeRoundAnnouncePhase('derby', 1) -- Round 1 announce skipped, jarring flash-then-animate on game start */
    };
}

module.exports = {
    initDoubles,
    aimNumber,
    init,
    handleThrow,
    DERBY_MAX_ROUNDS,
    meta,
    derbyContinueAfterThrow,
    derbyDraw,
    derbyLeaders,
    derbyMarkFinishIfNeeded,
    derbyMultOverlayPhase,
    derbyPastPostPhase,
    derbyPlayerFinished,
    derbyPlayersAtFinish,
    derbyResolveMatch,
    derbyScheduleAfterPastPost,
    derbyShowPastPost,
    derbyWinner,
    handleDerbyThrow,
    DERBY_AIM_LEAD_GAP,
    DERBY_AIM_THREAT_WITHIN,
    DERBY_BOOST_QUIPS,
    DERBY_KNOCK_QUIPS,
    DERBY_KNOCK_SINGLE_QUIPS,
    DERBY_MAX_TICKS
};

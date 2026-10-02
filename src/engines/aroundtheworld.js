/**
 * aroundtheworld — game engine.
 *
 * Hit every stop on the route in order; the score is how many darts it took.
 * Pure rules and timing: no DOM, no HTML, no CSS.
 *
 * VARIANTS ARE DATA. What a game of Around the World *is* comes down to three
 * questions, and each variant answers them in VARIANTS below rather than in
 * branches through the turn logic:
 *
 *   route      which stops, in which order      (1-20 then bull; board order; out and back)
 *   advance    how far a dart moves you on      (one step; a double skips two; doubles only)
 *   endRule    when a multi-player game ends    (finish the round; everyone to the end)
 *
 * The route is written into gameData at init, so the view draws whatever route
 * it is handed and never needs to know a variant exists. Adding a variant means
 * adding an entry here and passing `options.variant` from the game's setup.
 */

const {
    buildDoublesPlayerRoster,
    doublesAdvanceThrowerAfterVisit,
    doublesDisplayName,
    doublesMembersOf,
    doublesThrowerAvatar,
    doublesThrowerName,
    doublesWinnerFields,
    makeDart,
    makePhase,
    OVERLAY_EVENT_MS,
    showNextPlayerIntermission,
    slimPlayer
} = require('./core');

const GAME_TYPE = 'aroundtheworld';
const DARTS_PER_VISIT = 3;
/** Beat between a solo visit's third dart and the next visit (Quick 10 uses the same). */
const SOLO_NEXT_VISIT_MS = 700;
const RESOLVE_DELAY_MS = 600;

/* ========== ROUTES + VARIANTS ========== */

function numbersThenBull() {
    const route = [];
    for (let n = 1; n <= 20; n++) route.push(n);
    route.push('bull');
    return route;
}

/** A dart lands on a stop when it is in that number's bed; either bull counts for 'bull'. */
function dartHitsStop(dart, stop) {
    if (!dart || dart.miss || dart.number == null) return false;
    if (stop === 'bull') return dart.number === 'bull';
    return Number(dart.number) === Number(stop);
}

const VARIANTS = {
    classic: {
        label: 'Classic',
        route: numbersThenBull,
        /** Stops this dart moves the player on. Classic: any bed of the stop, one step. */
        advance: (dart, stop) => (dartHitsStop(dart, stop) ? 1 : 0),
        /**
         * finish_round: once anyone completes the route, the rest of that round
         * is played so everyone has had the same number of visits, then the
         * fewest darts wins. Players still travelling rank by how far they got.
         */
        endRule: 'finish_round'
    }
};
const DEFAULT_VARIANT = 'classic';

function variantKey(options) {
    const key = options && options.variant;
    return Object.prototype.hasOwnProperty.call(VARIANTS, key) ? key : DEFAULT_VARIANT;
}

function variantOf(gameData) {
    return VARIANTS[variantKey({ variant: gameData && gameData.variant })];
}

/** 'bull' reads BULL on screen and in phases; numbers read as themselves. */
function stopLabel(stop) {
    if (stop == null) return '';
    return stop === 'bull' ? 'BULL' : String(stop);
}

/* ========== STATE ========== */

function freshTraveller(base) {
    return {
        ...base,
        stopIdx: 0,         // index into gameData.route of the stop being aimed at
        darts: 0,           // every dart thrown, hit or miss — this is the score
        /** Darts each stop took, by route index. A stop a dart skipped past
         *  (a variant that advances more than one) records 0. */
        stopDarts: [],
        dartsAtStop: 0,     // darts at the current stop so far
        finished: false,
        finishDarts: null,  // darts on the dart that completed the route
        finishRound: null
    };
}

function baseState(options) {
    const key = variantKey(options);
    const variant = VARIANTS[key];
    return {
        gameType: GAME_TYPE,
        variant: key,
        variantLabel: variant.label,
        route: variant.route(),
        endRule: variant.endRule,
        activeIdx: 0,
        throwsThisTurn: 0,
        turnDarts: [],
        currentRound: 1,
        /** Round in which the first traveller finished; the match ends with it. */
        finishRound: null,
        phase: makePhase('playing'),
        helpVisible: false,
        lastThrow: null
    };
}

function currentStop(gameData, player) {
    const route = gameData.route || [];
    return player ? route[player.stopIdx] : undefined;
}

/* ========== TURN FLOW ========== */

function dartLabel(dart) {
    if (dart.miss) return 'MISS';
    if (dart.number === 'bull') return dart.multiplier === 2 ? 'BULL' : '25';
    return `${dart.mult || 'S'}${dart.number}`;
}

function handleAroundTheWorldThrow(gameData, throwSpec = null, throwSource = null) {
    const idle = { gameData, schedule: null };
    if (!gameData.phase || gameData.phase.type !== 'playing') return idle;
    if ((gameData.throwsThisTurn || 0) >= DARTS_PER_VISIT) return idle;

    const player = (gameData.players || [])[gameData.activeIdx];
    if (!player || player.finished) return idle;

    // Leaderboard integrity, as Quick 10 keeps it: a result that needed a
    // debug dart or a score correction is still saved, but marked.
    if (throwSource === 'debug' || throwSource === 'bot') gameData.usedDebug = true;
    if (throwSource === 'correct') gameData.usedCorrection = true;

    const route = gameData.route || [];
    const stop = route[player.stopIdx];
    const dart = makeDart(throwSpec);
    const steps = Math.max(0, Math.min(
        Number(variantOf(gameData).advance(dart, stop)) || 0,
        route.length - player.stopIdx
    ));

    player.darts = (player.darts || 0) + 1;
    player.dartsAtStop = (player.dartsAtStop || 0) + 1;
    gameData.throwsThisTurn = (gameData.throwsThisTurn || 0) + 1;
    if (steps > 0) {
        if (!Array.isArray(player.stopDarts)) player.stopDarts = [];
        player.stopDarts[player.stopIdx] = player.dartsAtStop;
        for (let k = 1; k < steps; k++) player.stopDarts[player.stopIdx + k] = 0;
        player.dartsAtStop = 0;
    }
    player.stopIdx += steps;

    const label = dartLabel(dart);
    if (!Array.isArray(gameData.turnDarts)) gameData.turnDarts = [];
    gameData.turnDarts.push({ label, hit: steps > 0, stop });
    if (gameData.turnDarts.length > DARTS_PER_VISIT) {
        gameData.turnDarts = gameData.turnDarts.slice(-DARTS_PER_VISIT);
    }

    gameData.lastThrow = {
        label,
        hit: steps > 0,
        miss: !!dart.miss,
        playerId: player.id,
        playerName: doublesThrowerName(gameData, gameData.activeIdx),
        number: dart.number,
        multiplier: dart.multiplier,
        stop,
        stepsAdvanced: steps,
        nextStop: route[player.stopIdx] != null ? route[player.stopIdx] : null,
        sector: throwSpec && throwSpec.sector ? throwSpec.sector : null
    };

    if (player.stopIdx >= route.length) return landTraveller(gameData, player);
    if (gameData.throwsThisTurn < DARTS_PER_VISIT) {
        gameData.phase = makePhase('playing');
        return idle;
    }
    return continueAfterVisit(gameData);
}

/**
 * The route is complete. The visit ends here whatever dart this was — there is
 * nothing left to aim at — so the visit is closed at three darts. That is what
 * tells the server to wait for a takeout (the same way Derby's finish line
 * does), and visitEndedEarly has it discard any darts already queued behind this
 * one. The dart count keeps the darts actually thrown.
 */
function landTraveller(gameData, player) {
    player.finished = true;
    player.finishDarts = player.darts;
    player.finishRound = gameData.currentRound || 1;
    const firstHome = gameData.finishRound == null;
    if (firstHome) gameData.finishRound = player.finishRound;

    if ((gameData.throwsThisTurn || 0) < DARTS_PER_VISIT) {
        gameData.throwsThisTurn = DARTS_PER_VISIT;
        gameData.visitEndedEarly = true;
    }

    const players = gameData.players || [];
    const idx = gameData.activeIdx;
    const leader = bestFinisher(players);
    gameData.phase = makePhase('landed', {
        playerIndex: idx,
        playerName: doublesThrowerName(gameData, idx),
        teamName: doublesDisplayName(doublesMembersOf(player)),
        avatar: doublesThrowerAvatar(gameData, idx),
        members: doublesMembersOf(player),
        darts: player.finishDarts,
        firstHome,
        leading: !!leader && leader.id === player.id,
        solo: players.length === 1,
        /** Players still due a visit this round — the "last call" the view announces. */
        stillToThrow: seatsLeftInRound(gameData, idx)
    });
    return {
        gameData,
        schedule: { delayMs: OVERLAY_EVENT_MS, next: `${GAME_TYPE}_after_landed` }
    };
}

/** Unfinished players seated after `idx` — everyone who still throws this round. */
function seatsLeftInRound(gameData, idx) {
    return (gameData.players || []).filter((p, i) => i > idx && !p.finished).length;
}

/** Next seat to throw after the active one, skipping finished players. */
function nextSeat(gameData) {
    const players = gameData.players || [];
    const n = players.length;
    let idx = gameData.activeIdx;
    let wrapped = false;
    for (let k = 0; k < n; k++) {
        idx++;
        if (idx >= n) { idx = 0; wrapped = true; }
        if (!players[idx].finished) return { idx, wrapped };
    }
    return null; // nobody left travelling
}

function continueAfterVisit(gameData) {
    const players = gameData.players || [];
    const next = nextSeat(gameData);

    const roundOver = !next || next.wrapped;
    if (!next || (gameData.finishRound != null && roundOver && gameData.endRule === 'finish_round')) {
        gameData.phase = makePhase('playing');
        return {
            gameData,
            schedule: { delayMs: RESOLVE_DELAY_MS, next: `${GAME_TYPE}_resolve_match` }
        };
    }

    // Solo: no "up next" card for the only player at the oche — a short beat
    // with the visit's darts still on screen, then the next visit.
    if (players.length === 1) {
        gameData.phase = makePhase('playing');
        return {
            gameData,
            schedule: {
                delayMs: SOLO_NEXT_VISIT_MS,
                next: `${GAME_TYPE}_advance_turn`,
                nextPlayerIndex: next.idx
            }
        };
    }

    const nextPlayer = players[next.idx];
    const leader = bestFinisher(players);
    return showNextPlayerIntermission(gameData, GAME_TYPE, next.idx, {
        targetNumber: currentStop(gameData, nextPlayer),
        stopLabel: stopLabel(currentStop(gameData, nextPlayer)),
        stopIndex: nextPlayer.stopIdx,
        stopsTotal: (gameData.route || []).length,
        darts: nextPlayer.darts || 0,
        lastCall: gameData.finishRound != null,
        beatDarts: leader ? leader.finishDarts : null
    });
}

function advanceTurn(gameData, action = {}) {
    const fromPhase = gameData.phase && gameData.phase.data;
    let nextIdx = action.nextPlayerIndex != null
        ? action.nextPlayerIndex
        : (fromPhase && fromPhase.nextPlayerIndex != null ? fromPhase.nextPlayerIndex : null);
    if (nextIdx == null) {
        const next = nextSeat(gameData);
        if (!next) return resolveMatch(gameData);
        nextIdx = next.idx;
    }

    doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
    // Seats only move forward, so landing on the same seat or an earlier one
    // means the order went round: a new round.
    if (nextIdx <= gameData.activeIdx) {
        gameData.currentRound = (gameData.currentRound || 1) + 1;
    }
    gameData.activeIdx = nextIdx;
    gameData.throwsThisTurn = 0;
    gameData.turnDarts = [];
    gameData.lastThrow = null;
    gameData.phase = makePhase('playing');
    return { gameData, schedule: null };
}

/* ========== RESULT ========== */

function bestFinisher(players) {
    return (players || [])
        .filter((p) => p.finished)
        .reduce((best, p) => (!best || p.finishDarts < best.finishDarts ? p : best), null);
}

/** Finished first by fewest darts; then everyone else by how far they got, fewest darts breaking ties. */
function compareTravellers(a, b) {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) return a.finishDarts - b.finishDarts;
    if (a.stopIdx !== b.stopIdx) return b.stopIdx - a.stopIdx;
    return (a.darts || 0) - (b.darts || 0);
}

function sameResult(a, b) {
    return compareTravellers(a, b) === 0;
}

function buildStandings(gameData) {
    const players = gameData.players || [];
    const total = (gameData.route || []).length;
    const order = players
        .map((p, index) => ({ p, index }))
        .sort((x, y) => compareTravellers(x.p, y.p) || x.index - y.index);
    let place = 0;
    return order.map(({ p, index }, i) => {
        if (i === 0 || !sameResult(order[i - 1].p, p)) place = i + 1;
        const members = doublesMembersOf(p);
        return {
            id: p.id,
            playerIndex: index,
            name: doublesDisplayName(members),
            avatar: members[0] ? members[0].avatar : (p.avatar || null),
            members,
            place,
            finished: !!p.finished,
            darts: p.finished ? p.finishDarts : (p.darts || 0),
            stopsCleared: Math.min(p.stopIdx || 0, total),
            stopsTotal: total,
            reached: p.finished ? null : stopLabel((gameData.route || [])[p.stopIdx])
        };
    });
}

function resolveMatch(gameData) {
    const players = gameData.players || [];
    const standings = buildStandings(gameData);
    gameData.standings = standings;
    gameData.resultReady = true;
    const top = standings.filter((s) => s.place === 1);

    if (top.length > 1) {
        gameData.phase = makePhase('draw', {
            reason: 'darts',
            darts: top[0].darts,
            finished: top[0].finished,
            contenders: top.map((s) => ({
                id: s.id,
                name: s.name,
                avatar: s.avatar,
                members: s.members,
                darts: s.darts
            })),
            standings
        });
        return { gameData, schedule: null };
    }

    const champ = players[top[0] ? top[0].playerIndex : 0];
    gameData.phase = makePhase('winner', {
        ...doublesWinnerFields(champ),
        teamIndex: top[0] ? top[0].playerIndex : 0,
        reason: 'darts',
        darts: top[0] ? top[0].darts : 0,
        finished: top[0] ? top[0].finished : false,
        solo: players.length === 1,
        rounds: gameData.currentRound || 1,
        stopsTotal: (gameData.route || []).length,
        standings
    });
    return { gameData, schedule: null };
}

/* ========== ENGINE INTERFACE ========== */

/**
 * Scheduled steps this game declares for itself. applyScheduledAction looks
 * here when no shared case matches, so none of these names appear in index.js.
 * `aroundtheworld_advance_turn` is also what core's showNextPlayerIntermission
 * schedules after the "up next" card.
 */
const scheduled = {
    [`${GAME_TYPE}_after_landed`]: (gameData) => continueAfterVisit(gameData),
    [`${GAME_TYPE}_advance_turn`]: (gameData, action) => advanceTurn(gameData, action),
    [`${GAME_TYPE}_resolve_match`]: (gameData) => resolveMatch(gameData)
};

/** Rounds run until someone gets round the board; there is no fixed count. */
const meta = {
    maxRounds: null,
    openEndedRounds: true,
    /** Fewest darts round the world. */
    leaderboard: { order: 'asc', unit: 'darts', limit: 10 }
};

/**
 * One leaderboard entry per person who completed the route. Bots and doubles
 * teams are left off: a bot's count says nothing about anyone, and a team's
 * darts were thrown by two people. `gameData.matchKey` (stamped by the server
 * when the match starts) keeps a result that is re-saved after a correction
 * to one entry.
 */
function buildMatchRecords(gameData) {
    if (!gameData || gameData.isDoublesLineup) return [];
    const players = gameData.players || [];
    const usedDebug = !!gameData.usedDebug;
    const usedCorrection = !!gameData.usedCorrection;
    const playedAt = new Date().toISOString();
    return players
        .filter((p) => p && p.finished && !p.isBot)
        .map((p) => ({
            id: `${gameData.matchKey || 'match'}:${p.id}`,
            gameType: GAME_TYPE,
            playedAt,
            player: { id: p.id, name: p.name, avatar: p.avatar || null },
            totalScore: p.finishDarts,
            variant: gameData.variant,
            fieldSize: players.length,
            stopDarts: Array.isArray(p.stopDarts) ? p.stopDarts.slice() : [],
            integrity: { usedDebug, usedCorrection, clean: !usedDebug && !usedCorrection }
        }));
}

function toggleLeaderboard(gameData) {
    gameData.leaderboardVisible = !gameData.leaderboardVisible;
    return { gameData, schedule: null };
}

function handleAction(gameData, payload) {
    if (payload && payload.type === 'TOGGLE_LEADERBOARD') return toggleLeaderboard(gameData);
    return null;
}

function handleThrow(gameData, throwSpec, throwSource) {
    return handleAroundTheWorldThrow(gameData, throwSpec, throwSource);
}

function init(ordered, options = {}) {
    return {
        ...baseState(options),
        players: ordered.map((p) => freshTraveller(slimPlayer(p))),
        isDoublesLineup: false,
        throwerIndices: ordered.map(() => 0)
    };
}

/** Doubles: a team travels together on one route, members alternating visits. */
function initDoubles(players, options = {}) {
    const roster = buildDoublesPlayerRoster(options.doublesTeams, players, freshTraveller);
    return {
        ...baseState(options),
        ...roster
    };
}

/** Bots aim at the stop they are on; 'bull' is understood by the throw roller. */
function aimNumber(gameData) {
    const player = (gameData.players || [])[gameData.activeIdx];
    const stop = currentStop(gameData, player);
    return stop == null ? null : stop;
}

/**
 * Debug previews built from the live lineup, so each screen shows what it
 * really will: the next player's actual stop, a real dart count, real standings.
 */
function debugPreviewPhase(gameData, screen, actor) {
    const players = gameData.players || [];
    const idx = Math.min(actor.teamIndex || 0, Math.max(players.length - 1, 0));
    const player = players[idx] || { name: actor.name, avatar: actor.avatar, stopIdx: 6, darts: 18 };
    const sample = (i, darts, stopIdx, finished) => {
        const p = players[i] || { id: `preview-${i}`, name: `Traveller ${i + 1}`, avatar: null };
        const members = doublesMembersOf(p);
        return {
            id: p.id,
            playerIndex: i,
            name: doublesDisplayName(members),
            avatar: members[0] ? members[0].avatar : (p.avatar || null),
            members,
            finished,
            darts,
            stopsCleared: stopIdx,
            stopsTotal: 21,
            reached: finished ? null : stopLabel(numbersThenBull()[stopIdx])
        };
    };

    const route = gameData.route || numbersThenBull();
    const liveStopIdx = Math.min(player.stopIdx || 0, route.length - 1);

    switch (screen) {
        case 'next':
        case 'intermission':
            return makePhase('intermission', {
                nextPlayerIndex: idx,
                nextPlayerName: actor.name,
                nextTeamName: actor.name,
                avatar: actor.avatar,
                targetNumber: route[liveStopIdx],
                stopLabel: stopLabel(route[liveStopIdx]),
                stopIndex: liveStopIdx,
                stopsTotal: route.length,
                darts: player.darts || 0,
                lastCall: false,
                beatDarts: null
            });
        case 'last_call':
            return makePhase('intermission', {
                nextPlayerIndex: idx,
                nextPlayerName: actor.name,
                nextTeamName: actor.name,
                avatar: actor.avatar,
                targetNumber: 'bull',
                stopLabel: 'BULL',
                stopIndex: 20,
                stopsTotal: 21,
                darts: 44,
                lastCall: true,
                beatDarts: 47
            });
        case 'landed':
            return makePhase('landed', {
                playerIndex: idx,
                playerName: actor.name,
                teamName: actor.name,
                avatar: actor.avatar,
                members: doublesMembersOf(player),
                darts: 47,
                firstHome: true,
                leading: true,
                solo: players.length === 1,
                stillToThrow: Math.max(0, players.length - 1 - idx)
            });
        case 'winner': {
            const standings = [sample(idx, 47, 21, true)]
                .concat(players.map((_, i) => i).filter((i) => i !== idx)
                    .map((i, k) => sample(i, 45 + k * 3, 17 - k * 3, false)));
            standings.forEach((s, i) => { s.place = i + 1; });
            return makePhase('winner', {
                ...doublesWinnerFields(players[idx] || { id: 'preview', name: actor.name, avatar: actor.avatar }),
                teamIndex: idx,
                reason: 'darts',
                darts: 47,
                finished: true,
                solo: players.length === 1,
                rounds: 16,
                stopsTotal: 21,
                standings
            });
        }
        case 'draw': {
            const tied = [0, 1].map((i) => sample(i, 47, 21, true));
            tied.forEach((s) => { s.place = 1; });
            return makePhase('draw', {
                reason: 'darts',
                darts: 47,
                finished: true,
                contenders: tied,
                standings: tied
            });
        }
        default:
            return null;
    }
}

module.exports = {
    aimNumber,
    buildMatchRecords,
    debugPreviewPhase,
    handleAction,
    handleThrow,
    init,
    initDoubles,
    meta,
    scheduled,
    VARIANTS,
    DEFAULT_VARIANT,
    buildStandings,
    compareTravellers,
    dartHitsStop,
    handleAroundTheWorldThrow,
    stopLabel
};

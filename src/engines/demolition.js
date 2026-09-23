/**
 * demolition — game engine.
 *
 * Extracted from gameEngines.js. Pure rules and timing: no DOM, no HTML, no
 * CSS. The view layer reads the state this produces and is untouched by how
 * this file is organised.
 */

const {
    DOUBLES_MAX_TEAMS,
    OVERLAY_EVENT_MS,
    OVERLAY_NEXT_PLAYER_MS,
    buildDoublesTeams,
    doublesAdvanceThrowerAfterVisit,
    doublesCurrentThrower,
    doublesDisplayName,
    doublesMembersAt,
    doublesThrowerAvatar,
    makePhase,
    slimPlayer,
    throwScoreFromTarget
} = require('./core');

function clusterPlayersIntoTeams(playersList) {
    const teamSlots = Array.from({ length: DEMOLITION_MAX_LANES }, () => []);
    playersList.forEach((player, index) => {
        teamSlots[index % DEMOLITION_MAX_LANES].push(player);
    });
    return teamSlots.filter(team => team.length > 0);
}

const DEMOLITION_START = 180;
const DEMOLITION_PLAYOFF_START = 60;
const DEMOLITION_MAX_LANES = 6;
const DEMOLITION_STAGGER = 0.015;

function demolitionCurrentThrower(gameData, teamIdx) {
    return doublesCurrentThrower(gameData, teamIdx);
}

/** Singles-style lane label (TEAM N when clustered). */
function demolitionTeamLabel(teams, index) {
    const team = teams[index];
    if (!team || !team.length) return 'PLAYER';
    return team.length > 1 ? `TEAM ${index + 1}` : team[0].name;
}

function demolitionTeamDisplayName(teams, index) {
    return doublesDisplayName(teams[index]);
}

function demolitionThrowerName(gameData, teamIdx) {
    const thrower = doublesCurrentThrower(gameData, teamIdx);
    if (thrower) return thrower.name;
    return demolitionTeamLabel(gameData.teams, teamIdx);
}

function demolitionThrowerAvatar(gameData, teamIdx) {
    return doublesThrowerAvatar(gameData, teamIdx);
}

function demolitionAdvanceThrowerAfterVisit(gameData, teamIdx) {
    doublesAdvanceThrowerAfterVisit(gameData, teamIdx);
}

function demolitionWinnerName(gameData, teamIdx) {
    if (gameData.isDoublesLineup) return demolitionTeamDisplayName(gameData.teams, teamIdx);
    return demolitionTeamLabel(gameData.teams, teamIdx);
}

function demolitionContenderName(gameData, teams, index) {
    if (gameData.isDoublesLineup) return doublesDisplayName(teams[index]);
    return demolitionTeamLabel(teams, index);
}

function demolitionWinnerMembers(gameData, teamIdx) {
    return doublesMembersAt(gameData, teamIdx);
}

/* --- end shared / demolition doubles helpers --- */

function demolitionMarkTurnActed(gameData, idx) {
    if (!gameData.teamsActedThisRound) {
        gameData.teamsActedThisRound = gameData.teamScores.map(() => false);
    }
    gameData.teamsActedThisRound[idx] = true;
}

function demolitionNextPendingIndex(gameData, fromIdx) {
    const n = gameData.teamScores.length;
    for (let step = 1; step <= n; step++) {
        const i = (fromIdx + step) % n;
        if (gameData.teamsActedThisRound[i]) continue;
        if (gameData.teamScores[i] <= 0) continue;
        return i;
    }
    return -1;
}

function demolitionBeginTurnAt(gameData, idx) {
    gameData.activeTurnIndex = idx;
    gameData.dartsThrownThisTurn = 0;
    gameData.roundInitialScores[idx] = gameData.teamScores[idx];
    gameData.turnStartingScores[idx] = gameData.teamScores[idx];
    gameData.phase = makePhase('playing');
    gameData.lastThrow = null;
}

function demolitionScheduleNextTurn(gameData, fromIdx, delayMs) {
    demolitionMarkTurnActed(gameData, fromIdx);

    if (gameData.finishRoundMode) {
        const nextIdx = demolitionNextPendingIndex(gameData, fromIdx);
        if (nextIdx < 0) {
            return {
                gameData,
                schedule: { delayMs, next: 'demolition_resolve_round' }
            };
        }
        // Wait for brick disappear anim before showing next-player overlay
        if (delayMs > 0) {
            return {
                gameData,
                schedule: { delayMs, next: 'demolition_show_intermission' }
            };
        }
        gameData.phase = makePhase('intermission', {
            nextTeamIndex: nextIdx,
            nextTeamName: demolitionThrowerName(gameData, nextIdx),
            avatar: demolitionThrowerAvatar(gameData, nextIdx)
        });
        return {
            gameData,
            schedule: { delayMs: OVERLAY_NEXT_PLAYER_MS, next: 'demolition_advance_turn' }
        };
    }

    if (gameData.teamsActedThisRound.every(Boolean)) {
        gameData.teamsActedThisRound = gameData.teamScores.map(() => false);
        gameData.checkedOutThisRound = [];
    }

    const nextIdx = (fromIdx + 1) % gameData.teamScores.length;
    if (delayMs > 0) {
        return {
            gameData,
            schedule: { delayMs, next: 'demolition_show_intermission' }
        };
    }
    gameData.phase = makePhase('intermission', {
        nextTeamIndex: nextIdx,
        nextTeamName: demolitionThrowerName(gameData, nextIdx),
        avatar: demolitionThrowerAvatar(gameData, nextIdx)
    });
    return {
        gameData,
        schedule: { delayMs: OVERLAY_NEXT_PLAYER_MS, next: 'demolition_advance_turn' }
    };
}

function demolitionAdvanceTurn(gameData) {
    const from = gameData.activeTurnIndex;
    let nextIdx;

    if (gameData.finishRoundMode) {
        nextIdx = demolitionNextPendingIndex(gameData, from);
        if (nextIdx < 0) {
            return;
        }
    } else {
        nextIdx = (from + 1) % gameData.teamScores.length;
    }

    // Doubles: rotate departing team so their next visit uses the other member
    demolitionAdvanceThrowerAfterVisit(gameData, from);
    demolitionBeginTurnAt(gameData, nextIdx);
}

function demolitionResolveRound(gameData) {
    const checked = gameData.checkedOutThisRound || [];

    if (checked.length <= 1) {
        const idx = checked.length === 1 ? checked[0] : gameData.activeTurnIndex;
        const members = demolitionWinnerMembers(gameData, idx);
        gameData.phase = makePhase('winner', {
            teamIndex: idx,
            winnerName: demolitionWinnerName(gameData, idx),
            avatar: members[0] ? members[0].avatar : null,
            members,
            avatars: members.map(m => m.avatar || null)
        });
        gameData.finishRoundMode = false;
        return { gameData, schedule: null };
    }

    const playoffTeams = checked.map(i => gameData.teams[i]);
    gameData.teams = playoffTeams;
    gameData.teamScores = playoffTeams.map(() => DEMOLITION_PLAYOFF_START);
    gameData.roundInitialScores = [...gameData.teamScores];
    gameData.turnStartingScores = [...gameData.teamScores];
    gameData.teamsActedThisRound = gameData.teamScores.map(() => false);
    gameData.checkedOutThisRound = [];
    gameData.finishRoundMode = false;
    gameData.isPlayoff = true;
    gameData.activeTurnIndex = 0;
    gameData.dartsThrownThisTurn = 0;
    gameData.lastThrow = null;
    gameData.throwerIndices = playoffTeams.map(() => 0);
    gameData.phase = makePhase('playoff', {
        contenderNames: playoffTeams.map((_, i) => demolitionContenderName(gameData, playoffTeams, i)),
        startScore: DEMOLITION_PLAYOFF_START
    });
    return {
        gameData,
        schedule: { delayMs: OVERLAY_EVENT_MS, next: 'demolition_start_playoff' }
    };
}

function handleDemolitionThrow(gameData, throwSpec = null) {
    if (gameData.phase.type !== 'playing') {
        return { gameData, schedule: null };
    }

    const idx = gameData.activeTurnIndex;
    // Already checked out — wait for brick anim + overlay schedule
    if (gameData.teamScores[idx] === 0) {
        return { gameData, schedule: null };
    }
    let currentScore = gameData.teamScores[idx];
    let totalTurnScore = 0;
    let rolledNumber = null;
    let rolledMultiplier = 1;
    let rolledMiss = false;

    if (throwSpec) {
        rolledMiss = !!throwSpec.miss;
        if (throwSpec.miss) {
            totalTurnScore = 0;
        } else {
            rolledNumber = throwSpec.number;
            rolledMultiplier = throwSpec.multiplier;
            totalTurnScore = throwScoreFromTarget(throwSpec.number, throwSpec.multiplier);
        }
    } else if (currentScore <= 20 && Math.random() < 0.33) {
        // Exact checkout helper — no discrete sector to report
        totalTurnScore = currentScore;
    } else {
        rolledNumber = Math.floor(Math.random() * 20) + 1;
        const modifierChance = Math.random() * 100;
        rolledMultiplier = 1;
        if (modifierChance < 15) rolledMultiplier = 3;
        else if (modifierChance < 35) rolledMultiplier = 2;
        totalTurnScore = rolledNumber * rolledMultiplier;
    }

    const scoreBeforeThrow = currentScore;
    gameData.dartsThrownThisTurn++;
    gameData.lastThrow = {
        score: totalTurnScore,
        bust: false,
        checkout: false,
        miss: rolledMiss,
        number: rolledNumber,
        multiplier: rolledMultiplier
    };

    if (currentScore - totalTurnScore < 0) {
        gameData.teamScores[idx] = gameData.roundInitialScores[idx];
        gameData.lastThrow.bust = true;
        const teamName = demolitionThrowerName(gameData, idx);
        gameData.phase = makePhase('bust', {
            teamIndex: idx,
            teamName,
            avatar: demolitionThrowerAvatar(gameData, idx)
        });
        return {
            gameData,
            schedule: { delayMs: OVERLAY_EVENT_MS, next: 'demolition_after_bust' }
        };
    }

    gameData.teamScores[idx] = currentScore - totalTurnScore;

    // Brick wait = this dart's actual score drop (not turnStartingScores — that can go
    // stale if another dart lands before demolition_sync_turn_baseline runs).
    const bricksRemoved = Math.max(0, scoreBeforeThrow - gameData.teamScores[idx]);
    const calculatedStaggerDuration = (bricksRemoved * DEMOLITION_STAGGER * 1000) + 250;
    const animDelay = Math.max(700, calculatedStaggerDuration + 200);

    if (gameData.teamScores[idx] === 0) {
        gameData.lastThrow.checkout = true;
        if (!Array.isArray(gameData.checkedOutThisRound)) gameData.checkedOutThisRound = [];
        if (!gameData.checkedOutThisRound.includes(idx)) {
            gameData.checkedOutThisRound.push(idx);
        }
        gameData.finishRoundMode = true;
        demolitionMarkTurnActed(gameData, idx);
        // Thrower rotation deferred to after_checkout so overlay still shows who checked out

        // Keep phase playing so bricks can animate to zero first, then TVM (if any) → checkout
        return {
            gameData,
            schedule: { delayMs: animDelay, next: 'demolition_show_tvm' }
        };
    }

    // Keep turnStartingScores at the pre-throw value so the viewer can stagger
    // this dart's brick removal. Sync the baseline after the anim completes.
    if (gameData.dartsThrownThisTurn >= 3) {
        return demolitionScheduleNextTurn(gameData, idx, animDelay);
    }

    return {
        gameData,
        schedule: { delayMs: animDelay, next: 'demolition_sync_turn_baseline' }
    };
}

/**
 * Uniform entry point used by the registry dispatch.
 * (gameData, throwSpec, throwSource) — extra arguments are ignored by games
 * that do not need them, so every engine presents the same shape.
 */
function handleThrow(gameData, throwSpec, throwSource) {
    return handleDemolitionThrow(gameData, throwSpec, throwSource);
}

/**
 * Initial state for this game.
 *
 * `ordered` is the lineup already shuffled by the caller; `players` is the
 * original unshuffled list (a couple of games need seat order as registered);
 * `options` carries lineup mode and any game-specific setup.
 */
function init(ordered, options = {}, players = ordered) {
    const teams = clusterPlayersIntoTeams(ordered);
    const teamScores = teams.map(() => DEMOLITION_START);
    return {
        gameType: 'demolition',
        teams: teams.map(team => team.map(slimPlayer)),
        teamScores,
        activeTurnIndex: 0,
        dartsThrownThisTurn: 0,
        roundInitialScores: [...teamScores],
        turnStartingScores: [...teamScores],
        teamsActedThisRound: teams.map(() => false),
        checkedOutThisRound: [],
        finishRoundMode: false,
        isPlayoff: false,
        isDoublesLineup: false,
        throwerIndices: teams.map(() => 0),
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
    const idx = gameData.activeTurnIndex || 0;
    const score = Array.isArray(gameData.teamScores) ? Number(gameData.teamScores[idx]) : 0;
    if (score >= 1 && score <= 20) return score;
    return 20;
}

/** Demolition throws by lane: the lane's current thrower, else its first member. */
function activeThrower(gameData) {
    const idx = gameData.activeTurnIndex;
    return demolitionCurrentThrower(gameData, idx)
        || (Array.isArray(gameData.teams) && gameData.teams[idx] && gameData.teams[idx][0])
        || null;
}

/**
 * Initial state for a DOUBLES lineup, where each non-empty team is one
 * scoring entity. A game that has no doubles variant simply does not export
 * this, and the caller falls back to the singles path.
 */
function initDoubles(players, options = {}) {
    const teams = buildDemolitionDoublesTeams(options.doublesTeams, players);
    const teamScores = teams.map(() => DEMOLITION_START);
    return {
        gameType: 'demolition',
        teams,
        teamScores,
        activeTurnIndex: 0,
        dartsThrownThisTurn: 0,
        roundInitialScores: [...teamScores],
        turnStartingScores: [...teamScores],
        teamsActedThisRound: teams.map(() => false),
        checkedOutThisRound: [],
        finishRoundMode: false,
        isPlayoff: false,
        isDoublesLineup: true,
        throwerIndices: teams.map(() => 0),
        phase: makePhase('playing'),
        helpVisible: false,
        lastThrow: null
    };
}

function buildDemolitionDoublesTeams(doublesTeams, players) {
    return buildDoublesTeams(doublesTeams, players, DEMOLITION_MAX_LANES);
}

module.exports = {
    initDoubles,
    activeThrower,
    aimNumber,
    init,
    clusterPlayersIntoTeams,
    handleThrow,
    demolitionAdvanceThrowerAfterVisit,
    demolitionAdvanceTurn,
    demolitionBeginTurnAt,
    demolitionContenderName,
    demolitionCurrentThrower,
    demolitionMarkTurnActed,
    demolitionNextPendingIndex,
    demolitionResolveRound,
    demolitionScheduleNextTurn,
    demolitionTeamDisplayName,
    demolitionTeamLabel,
    demolitionThrowerAvatar,
    demolitionThrowerName,
    demolitionWinnerMembers,
    demolitionWinnerName,
    handleDemolitionThrow,
    DEMOLITION_MAX_LANES,
    DEMOLITION_PLAYOFF_START,
    DEMOLITION_STAGGER,
    DEMOLITION_START
};

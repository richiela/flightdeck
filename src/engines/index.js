/**
 * The engine layer's front door.
 *
 * server.js requires this and nothing else under engines/. It owns throw
 * simulation, game setup, the scheduled-action dispatch and the debug preview
 * builder; ./registry owns which games exist, and ./core the primitives they
 * share. Games themselves are one file each alongside this one.
 */
/**
 * Optional engine load: a missing module must not be fatal. Games absent
 * from venueConfig's ALL_GAMES are rejected by server.js's SELECT_GAME
 * before any engine call. If one of these names is ever called with the
 * module missing, that is the bug — not this require.
 */
function optionalEngine(path) {
    try {
        return require(path);
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(path.replace('./', ''))) {
            // Every name read off the absent module becomes a function that
            // explains itself. Returning a bare {} instead gives
            // "x is not a function" several frames away from the actual cause.
            return new Proxy({}, {
                get(_target, prop) {
                    return function engineNotInThisBuild() {
                        throw new Error(
                            `${path} is not part of this build (called ${String(prop)}).`
                        );
                    };
                }
            });
        }
        throw err;
    }
}

const { getEngine, registeredGames } = require('./registry');
const {
    buildDoublesPlayerRoster,
    buildDoublesTeams,
    DOUBLES_MAX_TEAMS,
    generateDegreeSpacedTargets,
    generateSymmetricTargets,
    normalizeAngle,
    wheelMidAngle,
    angularDistance,
    engineMeta,
    DARTBOARD_WHEEL,
    SEGMENTS_PER_NUMBER,
    pickQuip,
    dartboardHitFromSpec,
    scheduleAfterRoundAnnounce,
    doublesWinnerFields,
    doublesAdvanceThrowerAfterVisit,
    doublesContenderFields,
    scheduleRoundThenNextPlayer,
    makeRoundAnnouncePhase,
    showNextPlayerIntermission,
    roundAnnounceInfo,
    doublesCurrentThrower,
    doublesDisplayName,
    doublesEnsureThrowerIndices,
    doublesMembersOf,
    OVERLAY_EVENT_MS,
    OVERLAY_NEXT_PLAYER_MS,
    OVERLAY_ROUND_ANNOUNCE_MS,
    doublesMembersAt,
    doublesThrowerName,
    doublesThrowerAvatar,
    THROW_PROFILES,
    THROW_PROFILE_IDS,
    DEFAULT_THROW_PROFILE,
    parseBotFromName,
    slimPlayer,
    makeDart,
    visitTotal,
    normalizeMultiplier,
    throwScoreFromTarget,
    multChar,
    makePhase
} = require('./core');
const {
    clusterPlayersIntoTeams
} = require('./demolition');
const {
    X01_MAX_PLAYERS
} = require('./x01');
const {
    DERBY_MAX_ROUNDS
} = require('./derby');
const {
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
} = require('./demolition');
const {
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
} = require('./killer');
const {
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
} = require('./cricket');
const {
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
} = require('./derby');
const {
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
} = require('./x01');
const {
    handleShanghaiThrow,
    shanghaiAdvanceTurn,
    shanghaiContinueAfterThrow,
    shanghaiEmptyRoundScores,
    shanghaiMakeDart,
    shanghaiMultChar,
    shanghaiPushTurnDart,
    shanghaiResolveMatch,
    shanghaiTargetNumber
} = require('./shanghai');
const {
    handleQuackshotThrow,
    quackshotAdvanceTurn,
    quackshotContinueAfterThrow,
    quackshotOverlayDelayMs,
    quackshotResolveMatch,
    quackshotRoundMultiplier,
    resolveQuackshotHit,
    QUACKSHOT_SEG_FLASH_MS,
    QUACKSHOT_SEG_FLASH_TAIL_MS
} = require('./quackshot');
const {
    handleLimboThrow,
    limboAliveCount,
    limboApplyLifeLoss,
    limboBeginTurn,
    limboNextAliveIndex,
    LIMBO_AIM_NUMBERS
} = require('./limbo');
const {
    buildQuick10MatchRecord,
    handleQuick10Throw,
    normalizeThrowSource,
    quick10CommitVisit,
    quick10MakeDart,
    selectQuick10Player,
    QUICK10_DARTS_PER_ROUND,
    QUICK10_ROUNDS
} = require('./quick10');
const {
    handleWarmupThrow,
    warmupCommitVisit,
    WARMUP_HISTORY_MAX
} = require('./warmup');










/* Viewer flash is 0.42s × 3 in quackshot.html — hold the card until that finishes. */









/** miss.mp4 ~2.0s + buffer when Viewer Video is on */

/** Longest push-*.mp4 ~3.0s + buffer when Viewer Video is on */


/** Longest elim-*.mp4 ~3.5s + buffer when Viewer Video is on */


/** Debug / bot throw skill profiles (locked). */









function normalizeThrowProfileId(value) {
    const key = String(value || '').trim().toLowerCase();
    return THROW_PROFILES[key] ? key : DEFAULT_THROW_PROFILE;
}

function getThrowProfile(profileId) {
    return THROW_PROFILES[normalizeThrowProfileId(profileId)];
}

function pickWeighted(entries) {
    const total = entries.reduce((sum, e) => sum + Math.max(0, Number(e.weight) || 0), 0);
    if (total <= 0) return entries[0] && entries[0].value;
    let r = Math.random() * total;
    for (let i = 0; i < entries.length; i++) {
        r -= Math.max(0, Number(entries[i].weight) || 0);
        if (r <= 0) return entries[i].value;
    }
    return entries[entries.length - 1].value;
}

function wheelIndexForNumber(number) {
    return DARTBOARD_WHEEL.indexOf(Number(number));
}

function wheelNeighbor(number, steps) {
    const idx = wheelIndexForNumber(number);
    if (idx < 0) return null;
    const n = DARTBOARD_WHEEL.length;
    return DARTBOARD_WHEEL[(idx + steps + n * 10) % n];
}

function rollMultiplierFromProfile(profile, { allowTriple = true, allowDouble = true } = {}) {
    const single = Math.max(0, profile.mult.single);
    const double = allowDouble ? Math.max(0, profile.mult.double) : 0;
    const triple = allowTriple ? Math.max(0, profile.mult.triple) : 0;
    const pick = pickWeighted([
        { value: 1, weight: single },
        { value: 2, weight: double },
        { value: 3, weight: triple }
    ]);
    return pick === 3 && !allowTriple ? (allowDouble ? 2 : 1) : pick;
}

function randomBoardNumber(exclude) {
    const excludeSet = new Set((exclude || []).map(Number));
    const pool = DARTBOARD_WHEEL.filter((n) => !excludeSet.has(n));
    const list = pool.length ? pool : DARTBOARD_WHEEL;
    return list[Math.floor(Math.random() * list.length)];
}

function makeThrowSpec(number, multiplier, miss = false, sector = null) {
    if (miss) return { miss: true, number: null, multiplier: 1, sector: null };
    let mult = normalizeMultiplier(multiplier);
    if (number === 'bull' && mult > 2) mult = 2;
    return {
        miss: false,
        number,
        multiplier: mult,
        sector: sector != null ? String(sector) : null
    };
}

/** Roll a dart aimed at a wheel number (1–20) using a skill profile. */
function rollWheelAimThrow(aimNumber, profileId) {
    const profile = getThrowProfile(profileId);
    const aim = Number(aimNumber);
    if (!Number.isFinite(aim) || aim < 1 || aim > 20) {
        return makeThrowSpec(20, 1);
    }

    if (Math.random() < profile.hitNumber) {
        return makeThrowSpec(aim, rollMultiplierFromProfile(profile));
    }

    const missKind = pickWeighted([
        { value: 'adjacent', weight: profile.miss.adjacent },
        { value: 'twoAway', weight: profile.miss.twoAway },
        { value: 'elsewhere', weight: profile.miss.elsewhere },
        { value: 'bounce', weight: profile.miss.bounce }
    ]);

    if (missKind === 'bounce') return makeThrowSpec(null, 1, true);

    let landed = aim;
    if (missKind === 'adjacent') {
        landed = Math.random() < 0.5 ? wheelNeighbor(aim, -1) : wheelNeighbor(aim, 1);
    } else if (missKind === 'twoAway') {
        landed = Math.random() < 0.5 ? wheelNeighbor(aim, -2) : wheelNeighbor(aim, 2);
    } else {
        landed = randomBoardNumber([aim,
            wheelNeighbor(aim, -1), wheelNeighbor(aim, 1),
            wheelNeighbor(aim, -2), wheelNeighbor(aim, 2)]);
    }
    // Wrong number still uses profile mult mix (often singles)
    return makeThrowSpec(landed, rollMultiplierFromProfile(profile));
}

/** Aiming at bull (e.g. Cricket): hit bull or spray elsewhere / bounce. */
function rollBullAimThrow(profileId) {
    const profile = getThrowProfile(profileId);
    if (Math.random() < profile.hitNumber) {
        const mult = rollMultiplierFromProfile(profile, { allowTriple: false, allowDouble: true });
        return makeThrowSpec('bull', mult <= 1 ? 1 : 2, false, mult >= 2 ? 'Bull' : '25');
    }
    const missKind = pickWeighted([
        { value: 'elsewhere', weight: profile.miss.elsewhere + profile.miss.adjacent + profile.miss.twoAway },
        { value: 'bounce', weight: profile.miss.bounce }
    ]);
    if (missKind === 'bounce') return makeThrowSpec(null, 1, true);
    return makeThrowSpec(randomBoardNumber([]), rollMultiplierFromProfile(profile));
}

function rollQuackshotAimThrow(profileId) {
    const profile = getThrowProfile(profileId);
    const q = profile.quackshot;
    const zone = pickWeighted([
        { value: 'doubleBull', weight: q.doubleBull },
        { value: 'outerBull', weight: q.outerBull },
        { value: 'innerSingle', weight: q.innerSingle },
        { value: 'triple', weight: q.triple },
        { value: 'splash', weight: q.splash }
    ]);
    const n = Math.floor(Math.random() * 20) + 1;
    if (zone === 'doubleBull') return makeThrowSpec('bull', 2, false, 'Bull');
    if (zone === 'outerBull') return makeThrowSpec('bull', 1, false, '25');
    if (zone === 'innerSingle') return makeThrowSpec(n, 1, false, `s${n}`);
    if (zone === 'triple') return makeThrowSpec(n, 3, false, `T${n}`);
    // Splash: outer single / miss
    if (Math.random() < 0.35) return makeThrowSpec(null, 1, true);
    return makeThrowSpec(n, 1, false, `S${n}`);
}


function resolveDebugAimNumber(gameData, gameType) {
    if (!gameData) return 20;
    // Each engine decides what its bots aim at. A game with no opinion — or one
    // absent from this build — falls through to the top of the board.
    const engine = getEngine(gameType);
    if (engine && typeof engine.aimNumber === 'function') {
        const n = engine.aimNumber(gameData);
        if (n != null) return n;
    }
    return 20;
}

/**
 * Build a concrete throwSpec for TRIGGER_THROW using the selected skill profile.
 * Quackshot uses the inner-circle zone table.
 */
function buildProfiledThrowSpec(gameData, gameType, profileId) {
    // A game may aim in its own way (Quackshot's inner-circle zones).
    // Anything else aims at a number.
    const engine = getEngine(gameType);
    if (engine && typeof engine.aimedThrow === 'function') {
        const spec = engine.aimedThrow(gameData, profileId, {
            rollQuackshotAimThrow,
            rollAimedSegmentThrow
        });
        if (spec) return spec;
    }
    const aim = resolveDebugAimNumber(gameData, gameType);
    if (aim === 'bull') return rollBullAimThrow(profileId);
    return rollWheelAimThrow(aim, profileId);
}


/** Hit aims at exact bed (number + mult); misses still scatter via profile. */
function rollAimedSegmentThrow(aimNumber, aimMultiplier, profileId) {
    const profile = getThrowProfile(profileId);
    const wantMult = normalizeMultiplier(aimMultiplier);
    if (aimNumber === 'bull') {
        if (Math.random() < profile.hitNumber) {
            return makeThrowSpec('bull', wantMult > 2 ? 2 : wantMult);
        }
        return rollBullAimThrow(profileId);
    }
    const aim = Number(aimNumber);
    if (!Number.isFinite(aim) || aim < 1 || aim > 20) {
        return makeThrowSpec(20, 1);
    }
    if (Math.random() < profile.hitNumber) {
        return makeThrowSpec(aim, wantMult);
    }
    return rollWheelAimThrow(aim, profileId);
}

function parseSpecificThrow(payload) {
    if (!payload || payload.type !== 'TRIGGER_SPECIFIC_THROW') return null;
    if (payload.miss) {
        return { miss: true, number: null, multiplier: 1, sector: null };
    }
    const number = payload.number === 'bull' ? 'bull' : Number(payload.number);
    if (number !== 'bull' && (!Number.isFinite(number) || number < 1 || number > 20)) {
        return null;
    }
    let multiplier = normalizeMultiplier(payload.multiplier);
    // No treble bull on a real board — double bull is the max
    if (number === 'bull' && multiplier > 2) multiplier = 2;
    return {
        number,
        multiplier,
        sector: payload.sector ? String(payload.sector) : null
    };
}




/**
 * Hacky bot marker: name prefix "Bot/D ", "Bot/C ", "Bot/I ", or "Bot/A "
 * (Dummy / Casual / Intermediate / Advanced). Keeps the visible name as-is.
 */

/** Current person throwing (singles player, doubles thrower, demolition lane thrower, Quick10). */
function getActiveThrowerEntity(gameData, gameType) {
    if (!gameData) return null;
    // Games whose notion of "who is throwing" differs from the singles default
    // answer for themselves.
    const engine = getEngine(gameType);
    if (engine && typeof engine.activeThrower === 'function') {
        const who = engine.activeThrower(gameData);
        if (who !== undefined) return who;
    }
    const idx = gameData.activeIdx;
    if (gameData.isDoublesLineup) {
        return doublesCurrentThrower(gameData, idx);
    }
    return (gameData.players || [])[idx] || null;
}



function shufflePlayers(players) {
    const shuffled = [...players];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
    }
    return shuffled;
}

function initGameData(gameType, players, options = {}) {
    const isDoubles = options.lineupMode === 'doubles';

    // Doubles is a per-game variant, not a universal one. A game that supports
    // it exports initDoubles; one that does not (warmup, quick10)
    // simply falls through to the singles path below — which is why there is no
    // longer a list of exceptions here.
    if (isDoubles) {
        const doublesEngine = getEngine(gameType);
        if (doublesEngine && typeof doublesEngine.initDoubles === 'function') {
            return doublesEngine.initDoubles(players, options);
        }
    }

    const ordered = shufflePlayers(players || []);

    // Registry dispatch: each engine builds its own initial state. An unknown
    // game returns null, exactly as the old switch's default did.
    const engine = getEngine(gameType);
    if (engine && typeof engine.init === 'function') {
        return engine.init(ordered, options, players);
    }
    return null;
}




/* Demolition wrappers (keep call sites stable) */

/** Must match public/games/killer.html wedge flash timing. */


/** On-screen takeover hold when Viewer Video is on (wedge wait is added separately). Clip must finish first. */


































function applyScheduledAction(gameData, action) {
    switch (action.next) {
        case 'end_dart_callout': {
            const resume = gameData.dartCalloutResume || null;
            gameData.dartCalloutResume = null;
            if (resume && resume.phase && resume.phase.type) {
                gameData.phase = resume.phase;
                return { gameData, schedule: resume.schedule || null };
            }
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        }
        case 'demolition_after_bust': {
            const idx = gameData.activeTurnIndex;
            return demolitionScheduleNextTurn(gameData, idx, 0);
        }
        case 'demolition_sync_turn_baseline': {
            const idx = gameData.activeTurnIndex;
            gameData.turnStartingScores[idx] = gameData.teamScores[idx];
            return { gameData, schedule: null };
        }
        case 'demolition_show_intermission': {
            const idx = gameData.activeTurnIndex;
            gameData.turnStartingScores[idx] = gameData.teamScores[idx];

            let nextIdx;
            if (gameData.finishRoundMode) {
                nextIdx = demolitionNextPendingIndex(gameData, idx);
                if (nextIdx < 0) {
                    return demolitionResolveRound(gameData);
                }
            } else {
                nextIdx = (idx + 1) % gameData.teamScores.length;
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
        case 'demolition_show_tvm': {
            const idx = gameData.activeTurnIndex;
            gameData.turnStartingScores[idx] = gameData.teamScores[idx];
            const teamName = demolitionThrowerName(gameData, idx);
            gameData.phase = makePhase('tvm', {
                teamIndex: idx,
                teamName,
                avatar: demolitionThrowerAvatar(gameData, idx)
            });
            // Server shortens this when the face clip is ready / ends; long max if dump fails
            return {
                gameData,
                schedule: { delayMs: 20000, next: 'demolition_show_checkout' }
            };
        }
        case 'demolition_show_checkout': {
            const idx = gameData.activeTurnIndex;
            gameData.turnStartingScores[idx] = gameData.teamScores[idx];
            if (gameData.tvmClipUrl) delete gameData.tvmClipUrl;
            const teamName = demolitionThrowerName(gameData, idx);
            gameData.phase = makePhase('checkout', {
                teamIndex: idx,
                teamName,
                avatar: demolitionThrowerAvatar(gameData, idx)
            });

            const nextIdx = demolitionNextPendingIndex(gameData, idx);
            if (nextIdx < 0) {
                return {
                    gameData,
                    schedule: { delayMs: OVERLAY_EVENT_MS, next: 'demolition_resolve_round' }
                };
            }
            return {
                gameData,
                schedule: { delayMs: OVERLAY_EVENT_MS, next: 'demolition_after_checkout' }
            };
        }
        case 'demolition_after_checkout': {
            const idx = gameData.activeTurnIndex;
            const nextIdx = demolitionNextPendingIndex(gameData, idx);
            if (nextIdx < 0) {
                return demolitionResolveRound(gameData);
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
        case 'demolition_resolve_round':
            return demolitionResolveRound(gameData);
        case 'demolition_start_playoff':
            demolitionBeginTurnAt(gameData, 0);
            return { gameData, schedule: null };
        case 'demolition_advance_turn':
            demolitionAdvanceTurn(gameData);
            return { gameData, schedule: null };
        case 'limbo_after_life_loss':
            gameData.currentTargetBar = 60;
            doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
            gameData.activeIdx = limboNextAliveIndex(gameData.players, gameData.activeIdx);
            limboBeginTurn(gameData);
            return { gameData, schedule: null };
        case 'limbo_after_bar':
            doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
            gameData.activeIdx = limboNextAliveIndex(gameData.players, gameData.activeIdx);
            limboBeginTurn(gameData);
            return { gameData, schedule: null };
        case 'limbo_winner': {
            const winner = gameData.players.find(p => p.id === action.winnerId);
            gameData.phase = makePhase('winner', doublesWinnerFields(winner));
            return { gameData, schedule: null };
        }
        case 'derby_show_next_after_round':
        case 'killer_show_next_after_round':
        case 'quackshot_show_next_after_round':
        case 'shanghai_show_next_after_round':
        case 'cricket_show_next_after_round': {
            const gameType = String(action.next).replace('_show_next_after_round', '');
            const nextIdx = action.nextPlayerIndex != null ? action.nextPlayerIndex : 0;
            return showNextPlayerIntermission(
                gameData,
                gameType,
                nextIdx,
                action.intermissionExtra || {}
            );
        }
        case 'derby_advance_turn': {
            // Round announce (if any) already played before intermission.
            doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
            gameData.throwsThisTurn = 0;
            gameData.activeIdx++;
            if (gameData.activeIdx >= gameData.players.length) {
                gameData.activeIdx = 0;
                gameData.currentRound++;
                if (gameData.currentRound > DERBY_MAX_ROUNDS || gameData.finishLineOpen) {
                    return derbyResolveMatch(gameData);
                }
            }
            gameData.lastThrow = null;
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        }
        case 'derby_resolve_match':
            return derbyResolveMatch(gameData);
        case 'derby_after_mult':
            if (gameData.pendingPastPost) {
                const pending = gameData.pendingPastPost;
                gameData.pendingPastPost = null;
                gameData.phase = makePhase('past_post', pending);
                return derbyScheduleAfterPastPost(gameData);
            }
            return derbyContinueAfterThrow(gameData);
        case 'derby_after_past_post':
            gameData.pendingPastPost = null;
            return derbyContinueAfterThrow(gameData);
        case 'killer_resume_playing':
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        case 'killer_after_elimination':
            // Return to the board first...
            gameData.phase = makePhase('playing');
            gameData.lastThrow = null;
            if (killerAlivePlayers(gameData.players).length === 1) {
                // ...then show winner after a short beat on the board
                return {
                    gameData,
                    schedule: { delayMs: 900, next: 'killer_show_winner' }
                };
            }
            if (gameData.throwsThisTurn >= 3) {
                return {
                    gameData,
                    schedule: { delayMs: 400, next: 'killer_show_intermission' }
                };
            }
            return { gameData, schedule: null };
        case 'killer_show_winner':
            killerCheckWinner(gameData);
            return { gameData, schedule: null };
        case 'killer_resolve_match':
            return killerResolveMatch(gameData);
        case 'killer_show_intermission':
            return killerShowIntermission(gameData);
        case 'killer_advance_turn':
            return killerAdvanceTurn(gameData);
        case 'killer_after_round_announce':
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        case 'quackshot_advance_turn':
            return quackshotAdvanceTurn(gameData);
        case 'quackshot_after_round_announce':
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        case 'quackshot_after_hit':
            return quackshotContinueAfterThrow(gameData);
        case 'quackshot_show_winner':
            return quackshotResolveMatch(gameData);
        case 'quackshot_resolve_match':
            return quackshotResolveMatch(gameData);
        case 'shanghai_advance_turn':
            return shanghaiAdvanceTurn(gameData);
        case 'shanghai_after_round_announce':
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        case 'shanghai_resolve_match':
            return shanghaiResolveMatch(gameData);
        case 'cricket_advance_turn': {
            doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
            gameData.throwsThisTurn = 0;
            gameData.turnDarts = [];
            gameData.activeIdx++;
            if (gameData.activeIdx >= gameData.players.length) {
                gameData.activeIdx = 0;
                gameData.currentRound = (gameData.currentRound || 1) + 1;
            }
            gameData.lastThrow = null;
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        }
        case 'cricket_after_round_announce':
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        case 'derby_after_round_announce':
            gameData.phase = makePhase('playing');
            return { gameData, schedule: null };
        case 'cricket_after_event':
            return cricketContinueAfterThrow(gameData);
        case 'x01_after_bust': {
            let nextIdx = gameData.activeIdx + 1;
            if (nextIdx >= gameData.players.length) nextIdx = 0;
            return showNextPlayerIntermission(gameData, 'x01', nextIdx);
        }
        case 'x01_advance_turn': {
            doublesAdvanceThrowerAfterVisit(gameData, gameData.activeIdx);
            let nextIdx = gameData.activeIdx + 1;
            if (nextIdx >= gameData.players.length) {
                nextIdx = 0;
                gameData.currentRound = (gameData.currentRound || 1) + 1;
            }
            x01BeginTurnAt(gameData, nextIdx);
            return { gameData, schedule: null };
        }
        case 'x01_show_winner': {
            const winner = gameData.players[gameData.activeIdx];
            gameData.phase = makePhase('winner', doublesWinnerFields(winner));
            return { gameData, schedule: null };
        }
        case 'warmup_commit_visit':
            return warmupCommitVisit(gameData);
        case 'quick10_commit_visit':
            return quick10CommitVisit(gameData);
        default:
            return { gameData, schedule: null };
    }
}

function handleGameAction(gameData, gameType, payload, options = {}) {
    if (!gameData || !payload) return { gameData, schedule: null };

    if (payload.type === 'TOGGLE_HELP') {
        gameData.helpVisible = !gameData.helpVisible;
        return { gameData, schedule: null };
    }

    // A game's own controls (Quick 10's leaderboard, X01's setup confirm, ...).
    // The engine returns null when the action is not its own, so adding a game
    // with bespoke controls needs no change here.
    {
        const engine = getEngine(gameType);
        if (engine && typeof engine.handleAction === 'function') {
            const handled = engine.handleAction(gameData, payload);
            if (handled) return handled;
        }
    }

    let throwSpec = null;
    if (payload.type === 'TRIGGER_SPECIFIC_THROW') {
        throwSpec = parseSpecificThrow(payload);
        if (!throwSpec) return { gameData, schedule: null };
    } else if (payload.type === 'TRIGGER_THROW') {
        throwSpec = buildProfiledThrowSpec(
            gameData,
            gameType,
            options.debugThrowProfile || DEFAULT_THROW_PROFILE
        );
    } else {
        return { gameData, schedule: null };
    }

    const throwSource = options.throwSource || null;

    // Registry dispatch. Adding a game means adding a file and a line in
    // engines/index.js — this function never learns its name.
    const engine = getEngine(gameType);
    if (engine && typeof engine.handleThrow === 'function') {
        return engine.handleThrow(gameData, throwSpec, throwSource);
    }
    return { gameData, schedule: null };
}


function debugSampleActor(gameData) {
    if (!gameData) return { name: 'PLAYER', avatar: null };
    // Ask the game who is throwing before falling back to the team/player
    // shapes below. Single-player games answer with their one player.
    {
        const engine = getEngine(gameData.gameType);
        const who = engine && typeof engine.activeThrower === 'function'
            ? engine.activeThrower(gameData)
            : null;
        if (who && !Array.isArray(gameData.teams)) {
            return {
                name: who.name || 'PLAYER',
                avatar: who.avatar || null,
                teamIndex: 0
            };
        }
    }
    if (Array.isArray(gameData.teams) && gameData.teams.length) {
        const idx = Math.min(gameData.activeTurnIndex || 0, gameData.teams.length - 1);
        const member = demolitionCurrentThrower(gameData, idx) || (gameData.teams[idx] && gameData.teams[idx][0]);
        if (member) return { name: member.name || 'PLAYER', avatar: member.avatar || null, teamIndex: idx };
    }
    if (Array.isArray(gameData.players) && gameData.players.length) {
        const idx = Math.min(gameData.activeIdx || 0, gameData.players.length - 1);
        const thrower = doublesCurrentThrower(gameData, idx);
        if (thrower) return { name: thrower.name || 'PLAYER', avatar: thrower.avatar || null, teamIndex: idx };
        const p = gameData.players[idx];
        if (p) return { name: p.name || 'PLAYER', avatar: p.avatar || null, teamIndex: idx };
    }
    return { name: 'PLAYER', avatar: null, teamIndex: 0 };
}

function buildDebugPreviewPhase(gameType, gameData, screen) {
    const actor = debugSampleActor(gameData);
    const label = actor.name;

    switch (screen) {
        case 'clear':
        case 'playing':
            return makePhase('playing');

        case 'pick_player': {
            const candidates = (gameData && Array.isArray(gameData.candidates) && gameData.candidates.length)
                ? gameData.candidates
                : [{ id: 'preview', name: label, avatar: actor.avatar }];
            return makePhase('pick_player', { candidates });
        }

        case 'pick_mode':
            return makePhase('playing');

        case 'complete':
            return makePhase('complete', {
                totalScore: Number(gameData && gameData.totalScore) || 180,
                playerName: label,
                playerAvatar: actor.avatar,
                usedDebug: !!(gameData && gameData.usedDebug),
                usedCorrection: !!(gameData && gameData.usedCorrection),
                clean: !(gameData && (gameData.usedDebug || gameData.usedCorrection))
            });

        case 'round':
        case 'round_announce': {
            const r = Math.max(1, Number(gameData && gameData.currentRound) || 1);
            return makeRoundAnnouncePhase(gameType, r);
        }

        case 'round_final': {
            // The game's own declared round count. Open-ended games (cricket)
            // have none, so their "final round" is wherever play has reached.
            const meta = engineMeta(gameType);
            const current = Math.max(1, Number(gameData && gameData.currentRound) || 1);
            const max = meta.maxRounds != null
                ? meta.maxRounds
                : (meta.openEndedRounds ? current : 8);
            return makeRoundAnnouncePhase(gameType, max);
        }

        case 'round_double':
        case 'round_triple': {
            // "Show me a round worth double/triple" — found by asking the game
            // which round that is, rather than hardcoding one per game. A game
            // with no multiplier schedule falls back to a plausible round so
            // the preview still renders something.
            const want = screen === 'round_double' ? 2 : 3;
            const meta = engineMeta(gameType);
            let r = want === 2 ? 6 : 10;
            if (typeof meta.roundMultiplier === 'function') {
                const limit = meta.maxRounds || 20;
                for (let i = 1; i <= limit; i++) {
                    if (meta.roundMultiplier(i) === want) { r = i; break; }
                }
            }
            return makeRoundAnnouncePhase(gameType, r);
        }

        case 'bust':
            return makePhase('bust', {
                teamName: label,
                teamIndex: actor.teamIndex,
                avatar: actor.avatar
            });

        case 'intermission':
        case 'next': {
            const sampleTarget = (gameData.players && gameData.players[actor.teamIndex]
                && gameData.players[actor.teamIndex].targetNumber) || 20;
            return makePhase('intermission', {
                nextTeamIndex: actor.teamIndex,
                nextTeamName: label,
                nextPlayerIndex: actor.teamIndex,
                nextPlayerName: label,
                targetNumber: sampleTarget,
                avatar: actor.avatar
            });
        }

        case 'checkout':
            return makePhase('checkout', {
                teamName: label,
                teamIndex: actor.teamIndex,
                avatar: actor.avatar
            });

        case 'playoff': {
            const names = (gameData.teams || [])
                .slice(0, 2)
                .map((team, i) => (team[0] && team[0].name) || `Team ${i + 1}`);
            while (names.length < 2) names.push('Contender');
            return makePhase('playoff', {
                contenderNames: names,
                startScore: DEMOLITION_PLAYOFF_START
            });
        }

        case 'winner': {
            // A game may have its own winner screen shape.
            const engine = getEngine(gameType);
            if (engine && typeof engine.debugWinnerPhase === 'function') {
                const phase = engine.debugWinnerPhase(gameData, actor, label);
                if (phase) return phase;
            }
            return makePhase('winner', {
                teamIndex: actor.teamIndex,
                winnerId: 'preview',
                winnerName: label,
                avatar: actor.avatar,
                score: 85,
                rounds: 6
            });
        }


        case 'draw': {
            const players = (gameData.players || []).slice(0, 2);
            while (players.length < 2) {
                players.push({ name: `Racer ${players.length + 1}`, avatar: null, score: DERBY_MAX_TICKS });
            }
            return makePhase('draw', {
                contenders: players.map(p => ({
                    id: p.id,
                    name: p.name || 'PLAYER',
                    avatar: p.avatar || null,
                    score: p.score != null ? p.score : DERBY_MAX_TICKS
                })),
                names: players.map(p => p.name || 'PLAYER')
            });
        }

        case 'past_post':
            return makePhase('past_post', {
                playerName: label,
                avatar: actor.avatar,
                targetNumber: (gameData.players && gameData.players[actor.teamIndex]
                    && gameData.players[actor.teamIndex].targetNumber) || 20
            });

        case 'life_loss':
            return makePhase('life_loss', {
                playerName: label,
                avatar: actor.avatar,
                livesBefore: 2,
                eliminated: false
            });

        case 'life_out':
            return makePhase('life_loss', {
                playerName: label,
                avatar: actor.avatar,
                livesBefore: 1,
                eliminated: true
            });

        case 'boost_double':
            return makePhase('mult_boost', {
                playerName: label,
                avatar: actor.avatar,
                actorName: label,
                multiplier: 2,
                steps: 2,
                quip: 'Full Gallop!',
                selfHit: true,
                targetNumber: 20
            });

        case 'boost_triple':
            return makePhase('mult_boost', {
                playerName: label,
                avatar: actor.avatar,
                actorName: label,
                multiplier: 3,
                steps: 3,
                quip: 'Thundering Ahead!',
                selfHit: true,
                targetNumber: 20
            });

        case 'knock_single':
            return makePhase('mult_knock', {
                playerName: label,
                avatar: actor.avatar,
                actorName: 'RIVAL',
                multiplier: 1,
                steps: 1,
                quip: 'Nicked!',
                selfHit: false,
                targetNumber: 20
            });

        case 'knock_double':
            return makePhase('mult_knock', {
                playerName: label,
                avatar: actor.avatar,
                actorName: 'RIVAL',
                multiplier: 2,
                steps: 2,
                quip: 'Boxed In!',
                selfHit: false,
                targetNumber: 20
            });

        case 'knock_triple':
            return makePhase('mult_knock', {
                playerName: label,
                avatar: actor.avatar,
                actorName: 'RIVAL',
                multiplier: 3,
                steps: 3,
                quip: 'Lost A Length!',
                selfHit: false,
                targetNumber: 20
            });

        case 'bar_set':
        case 'bar_status':
        case 'bar_clear':
            return makePhase('bar_status', {
                playerName: label,
                avatar: actor.avatar,
                mode: 'clear',
                headline: `${label} Cleared The Bar!`,
                badge: 'BAR LOWERED TO: 28',
                barValue: 28
            });

        case 'bar_hold':
            return makePhase('bar_status', {
                playerName: label,
                avatar: actor.avatar,
                mode: 'hold',
                headline: `${label} Matched The Bar!`,
                badge: 'BAR HOLDS: 36',
                barValue: 36
            });

        case 'became_killer':
            return makePhase('became_killer', {
                playerName: label,
                avatar: actor.avatar,
                targetNumber: 20
            });

        case 'lost_killer':
            return makePhase('lost_killer', {
                playerName: label,
                avatar: actor.avatar,
                attackerName: 'RIVAL',
                targetNumber: 20,
                livesRemaining: 1
            });

        case 'death':
            return makePhase('death', {
                attackerName: 'RIVAL',
                victimName: label,
                victimAvatar: actor.avatar,
                hitNumber: 20
            });

        case 'k_boost_double':
            return makePhase('mult_boost', {
                playerName: label,
                avatar: actor.avatar,
                multiplier: 2,
                steps: 2,
                quip: 'Double Tap!',
                targetNumber: 20
            });

        case 'k_boost_triple':
            return makePhase('mult_boost', {
                playerName: label,
                avatar: actor.avatar,
                multiplier: 3,
                steps: 3,
                quip: 'Marked Cold!',
                targetNumber: 20
            });

        case 'k_knock_double':
            return makePhase('mult_knock', {
                playerName: label,
                avatar: actor.avatar,
                actorName: 'RIVAL',
                multiplier: 2,
                steps: 2,
                quip: 'Cut Deep!',
                targetNumber: 20
            });

        case 'k_knock_triple':
            return makePhase('mult_knock', {
                playerName: label,
                avatar: actor.avatar,
                actorName: 'RIVAL',
                multiplier: 3,
                steps: 3,
                quip: 'Bleed Out!',
                targetNumber: 20
            });

        case 'strike':
            return makePhase('death', {
                attackerName: 'RIVAL',
                victimName: label,
                victimAvatar: actor.avatar,
                hitNumber: 20
            });

        case 'cricket_score':
            return makePhase('cricket_score', {
                playerName: label,
                avatar: actor.avatar,
                target: 20,
                targetLabel: '20',
                points: 40,
                marksAfter: 3,
                opened: false,
                numberClosed: false,
                totalScore: 40,
                quip: 'On The Board!'
            });

        case 'cricket_closed':
        case 'cricket_open':
            return makePhase('cricket_closed', {
                playerName: label,
                avatar: actor.avatar,
                target: 19,
                targetLabel: '19',
                marksAfter: 3,
                quip: 'Closed!'
            });

        case 'cricket_dead':
        case 'cricket_close':
            return makePhase('cricket_dead', {
                playerName: label,
                avatar: actor.avatar,
                target: 18,
                targetLabel: '18',
                quip: 'No More Points!'
            });

        // Outer bull (+2) and double bull (+3) both use phase type 'bullseye'
        // (engine sets hit.bullseye for zone 'bull' and 'double_bull').
        case 'outer_bull':
            return makePhase('bullseye', {
                playerName: label,
                avatar: actor.avatar,
                bullseyes: 1,
                zone: 'bull',
                points: 2,
                label: '+2',
                title: 'Outer Bull!',
                winning: false
            });

        case 'double_bull':
        case 'bullseye':
            // bullseyes: 2 triggers the double-duck knockdown on the bull overlay
            return makePhase('bullseye', {
                playerName: label,
                avatar: actor.avatar,
                bullseyes: 2,
                zone: 'double_bull',
                points: 3,
                label: '+3',
                title: 'Double Bullseye!',
                winning: false
            });

        case 'zone_minus':
        case 'ring_of_fire':
            return makePhase('zone_hit', {
                playerName: label,
                avatar: actor.avatar,
                zone: 'triple',
                points: -2,
                label: '−2',
                title: 'Ring of Fire!'
            });

        case 'splash':
        case 'zone_splash':
            return makePhase('splash', {
                playerName: label,
                avatar: actor.avatar,
                zone: 'board',
                points: -1,
                label: '−1',
                title: 'Splash!'
            });

        case 'miss':
            return makePhase('miss', {
                playerName: label,
                avatar: actor.avatar,
                hits: 0,
                eliminated: false
            });

        case 'elim':
        case 'eliminated':
            return makePhase('elim', {
                playerName: label,
                avatar: actor.avatar,
                hits: 0,
                eliminated: true
            });

        case 'push':
            return makePhase('push', {
                playerName: label,
                avatar: actor.avatar,
                hits: 1
            });


        default:
            return null;
    }
}

function initialMatchSchedule(gameData) {
    if (!gameData || !gameData.phase || gameData.phase.type !== 'round_announce') return null;
    const gt = gameData.gameType;
    if (!gt) return null;
    return scheduleAfterRoundAnnounce(gt);
}














module.exports = {
    initGameData,
    handleGameAction,
    applyScheduledAction,
    buildDebugPreviewPhase,
    initialMatchSchedule,
    buildQuick10MatchRecord,
    buildProfiledThrowSpec,
    normalizeThrowProfileId,
    getThrowProfile,
    parseBotFromName,
    getActiveThrowerEntity,
    THROW_PROFILES,
    THROW_PROFILE_IDS,
    DEFAULT_THROW_PROFILE,
    CRICKET_MAX_PLAYERS,
    X01_MAX_PLAYERS,
    QUICK10_ROUNDS
};

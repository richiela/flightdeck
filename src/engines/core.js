/**
 * Primitives shared by every game engine.
 *
 * This module must never require an individual engine, or gameEngines.js —
 * engines depend on core, not the other way round. Keeping that arrow pointing
 * one way is what makes the per-game files independent of each other.
 *
 * Everything here is pure except makePhase, which stamps the wall clock.
 */

/** Darts have three multipliers; anything else is a single. */
function normalizeMultiplier(value) {
    const mult = Number(value);
    return mult === 2 ? 2 : mult === 3 ? 3 : 1;
}

/** Points for a target, honouring the no-treble-bull rule. */
function throwScoreFromTarget(number, multiplier) {
    if (number == null) return 0;
    let mult = normalizeMultiplier(multiplier);
    if (number === 'bull') {
        if (mult > 2) mult = 2;
        return 25 * mult;
    }
    const base = Number(number);
    if (!Number.isFinite(base) || base < 1 || base > 20) return 0;
    return base * mult;
}

/**
 * "S" / "D" / "T" prefix for a dart label.
 *
 * Lived in the cricket section as cricketMultChar, but warmup and several
 * other games call it too — it was never cricket's. Exported under a neutral
 * name here; gameEngines.js keeps the old name as an alias so nothing that
 * still calls it has to change in the same step.
 */
function multChar(multiplier) {
    return multiplier === 3 ? 'T' : multiplier === 2 ? 'D' : 'S';
}

/** A phase envelope. Date.now() is the only impurity in this file. */
function makePhase(type, data = {}) {
    return { type, startedAt: Date.now(), data };
}

/* --- shared throw profiles, player shaping, dart construction --- */

const THROW_PROFILES = {
    dummy: {
        id: 'dummy',
        label: 'Dummy',
        // Intentionally awful — a kid should beat this
        hitNumber: 0.12,
        mult: { single: 0.95, double: 0.04, triple: 0.01 },
        miss: { adjacent: 0.25, twoAway: 0.15, elsewhere: 0.40, bounce: 0.20 },
        quackshot: {
            doubleBull: 0.01,
            outerBull: 0.02,
            innerSingle: 0.15,
            triple: 0.08,
            splash: 0.74
        }
    },
    casual: {
        id: 'casual',
        label: 'Casual',
        hitNumber: 0.28,
        mult: { single: 0.88, double: 0.09, triple: 0.03 },
        miss: { adjacent: 0.40, twoAway: 0.15, elsewhere: 0.30, bounce: 0.15 },
        quackshot: {
            doubleBull: 0.02,
            outerBull: 0.04,
            innerSingle: 0.28,
            triple: 0.14,
            splash: 0.52
        }
    },
    intermediate: {
        id: 'intermediate',
        label: 'Intermediate',
        hitNumber: 0.45,
        mult: { single: 0.78, double: 0.15, triple: 0.07 },
        miss: { adjacent: 0.50, twoAway: 0.20, elsewhere: 0.20, bounce: 0.10 },
        quackshot: {
            doubleBull: 0.04,
            outerBull: 0.07,
            innerSingle: 0.42,
            triple: 0.12,
            splash: 0.35
        }
    },
    advanced: {
        id: 'advanced',
        label: 'Advanced',
        hitNumber: 0.62,
        mult: { single: 0.65, double: 0.22, triple: 0.13 },
        miss: { adjacent: 0.58, twoAway: 0.22, elsewhere: 0.12, bounce: 0.08 },
        quackshot: {
            doubleBull: 0.07,
            outerBull: 0.11,
            innerSingle: 0.55,
            triple: 0.10,
            splash: 0.17
        }
    }
};

const THROW_PROFILE_IDS = Object.keys(THROW_PROFILES);

const DEFAULT_THROW_PROFILE = 'intermediate';

function parseBotFromName(name) {
    const m = String(name || '').trim().match(/^bot\/([dcia])(?:\b|[\s:_-]+)/i);
    if (!m) return { isBot: false, botProfile: null };
    const map = { d: 'dummy', c: 'casual', i: 'intermediate', a: 'advanced' };
    return { isBot: true, botProfile: map[m[1].toLowerCase()] || DEFAULT_THROW_PROFILE };
}

function slimPlayer(p) {
    if (!p) return { id: null, name: '', avatar: null };
    const bot = parseBotFromName(p.name);
    const out = { id: p.id, name: p.name, avatar: p.avatar || null };
    if (bot.isBot) {
        out.isBot = true;
        out.botProfile = bot.botProfile;
    }
    return out;
}

function makeDart(throwSpec) {
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

    if (Math.random() < 0.08) {
        return { label: 'MISS', mult: null, score: 0, miss: true, number: null, multiplier: 1 };
    }

    const number = Math.random() < 0.08 ? 'bull' : (Math.floor(Math.random() * 20) + 1);
    const roll = Math.random();
    let multiplier = 1;
    if (number === 'bull') {
        if (roll > 0.7) multiplier = 2;
    } else if (roll > 0.85) {
        multiplier = 3;
    } else if (roll > 0.65) {
        multiplier = 2;
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

function visitTotal(darts) {
    return (darts || []).reduce((sum, d) => sum + (Number(d && d.score) || 0), 0);
}

const OVERLAY_EVENT_MS = 3000;

const OVERLAY_NEXT_PLAYER_MS = 2500;

const OVERLAY_ROUND_ANNOUNCE_MS = 3000;

/** Members for a team lane (demolition teams[]) or player entity (.members). */
function doublesMembersAt(gameData, idx) {
    if (gameData.teams && gameData.teams[idx]) return gameData.teams[idx];
    const p = gameData.players && gameData.players[idx];
    if (!p) return [];
    if (gameData.isDoublesLineup && Array.isArray(p.members) && p.members.length) return p.members;
    return [{ id: p.id, name: p.name, avatar: p.avatar || null }];
}

function doublesThrowerName(gameData, idx) {
    const thrower = doublesCurrentThrower(gameData, idx);
    if (thrower) return thrower.name;
    const members = doublesMembersAt(gameData, idx);
    return doublesDisplayName(members);
}

function doublesThrowerAvatar(gameData, idx) {
    const thrower = doublesCurrentThrower(gameData, idx);
    return thrower ? (thrower.avatar || null) : null;
}

function doublesCurrentThrower(gameData, idx) {
    const members = doublesMembersAt(gameData, idx);
    if (!members.length) return null;
    doublesEnsureThrowerIndices(gameData);
    const ti = gameData.throwerIndices[idx] % members.length;
    return members[ti];
}

function doublesDisplayName(members) {
    const list = doublesMembersOf(members);
    if (!list.length) return 'PLAYER';
    if (list.length === 1) return list[0].name;
    return list.map(m => m.name).join(' & ');
}

function doublesEnsureThrowerIndices(gameData) {
    const n = gameData.teams
        ? gameData.teams.length
        : (gameData.players || []).length;
    if (!Array.isArray(gameData.throwerIndices) || gameData.throwerIndices.length !== n) {
        gameData.throwerIndices = Array.from({ length: n }, () => 0);
    }
}

function doublesMembersOf(playerOrMembers) {
    if (Array.isArray(playerOrMembers)) return playerOrMembers;
    if (!playerOrMembers) return [];
    if (Array.isArray(playerOrMembers.members) && playerOrMembers.members.length) {
        return playerOrMembers.members;
    }
    return [{
        id: playerOrMembers.id,
        name: playerOrMembers.name,
        avatar: playerOrMembers.avatar || null
    }];
}

function doublesContenderFields(player) {
    const members = doublesMembersOf(player);
    return {
        id: player.id,
        name: doublesDisplayName(members),
        avatar: members[0] ? members[0].avatar : (player.avatar || null),
        members,
        score: player.score || 0
    };
}

/** Round first (if wrapping), then next-player intermission. Used by all round-based games. */
function scheduleRoundThenNextPlayer(gameData, gameType, nextIdx, nextRound, wrapped, intermissionExtra = {}) {
    if (wrapped) {
        gameData.phase = makeRoundAnnouncePhase(gameType, nextRound);
        return {
            gameData,
            schedule: {
                delayMs: OVERLAY_ROUND_ANNOUNCE_MS,
                next: `${gameType}_show_next_after_round`,
                nextPlayerIndex: nextIdx,
                intermissionExtra
            }
        };
    }
    return showNextPlayerIntermission(gameData, gameType, nextIdx, intermissionExtra);
}

function makeRoundAnnouncePhase(gameType, round) {
    return makePhase('round_announce', roundAnnounceInfo(gameType, round));
}

function showNextPlayerIntermission(gameData, gameType, nextIdx, intermissionExtra = {}) {
    const nextPlayer = gameData.players[nextIdx] || {};
    gameData.phase = makePhase('intermission', {
        nextPlayerIndex: nextIdx,
        nextPlayerName: doublesThrowerName(gameData, nextIdx),
        nextTeamName: doublesThrowerName(gameData, nextIdx),
        avatar: doublesThrowerAvatar(gameData, nextIdx),
        targetNumber: nextPlayer.targetNumber,
        ...intermissionExtra
    });
    return {
        gameData,
        schedule: { delayMs: OVERLAY_NEXT_PLAYER_MS, next: `${gameType}_advance_turn` }
    };
}

/** Shared round-start takeover payload for round-based games. */
/**
 * The engine registry, handed over by engines/index.js at load time.
 *
 * core must not require a game — that would make the dependency arrow circular
 * and every engine transitively depend on every other. Injection keeps the
 * arrow pointing one way while still letting shared code ask a game about
 * itself.
 */
let ENGINE_REGISTRY = {};

function setEngineRegistry(registry) {
    ENGINE_REGISTRY = registry || {};
}

/**
 * A game's declared metadata, or an empty object.
 *
 * Reading `.meta` off an absent optional engine yields undefined by design,
 * so a missing engine still answers here rather than throwing.
 */
function engineMeta(gameType) {
    const engine = ENGINE_REGISTRY[gameType];
    return (engine && engine.meta) || {};
}

/**
 * Shared round-start banner, assembled from what the game declares about
 * itself. This used to switch on gameType and reach for per-game constants,
 * which meant core had to know every game's name, round count and vocabulary.
 * A game now supplies:
 *
 *   maxRounds       number | null   final-round detection
 *   roundEyebrow    string          'CARNIVAL ROUND', 'NEXT BED', ...
 *   roundMultiplier (r) => number   scoring multiplier for the round
 *   roundSubtitle   (r) => string   e.g. 'AIM FOR 17'
 *   lastRoundTag    string          defaults to 'FINAL ROUND'
 *   multiplierTags  { 2, 3 }        defaults to DOUBLE/TRIPLE POINTS
 *
 * Every field is optional; the defaults are what an unremarkable round game
 * wants, so a new game can declare nothing at all.
 */
function roundAnnounceInfo(gameType, round) {
    const r = Math.max(1, Number(round) || 1);
    const meta = engineMeta(gameType);

    const maxRounds = meta.maxRounds != null ? meta.maxRounds : null;
    const multiplier = typeof meta.roundMultiplier === 'function'
        ? meta.roundMultiplier(r)
        : 1;
    const eyebrow = meta.roundEyebrow || 'NEW ROUND';
    let subtitle = typeof meta.roundSubtitle === 'function'
        ? meta.roundSubtitle(r)
        : '';

    const isLast = maxRounds != null && r >= maxRounds;
    const tags = [];
    if (isLast) tags.push(meta.lastRoundTag || 'FINAL ROUND');
    const multTags = meta.multiplierTags || {};
    if (multiplier === 2) tags.push(multTags[2] || 'DOUBLE POINTS');
    if (multiplier === 3) tags.push(multTags[3] || 'TRIPLE POINTS');
    if (tags.length) {
        subtitle = subtitle ? `${tags.join(' · ')} · ${subtitle}` : tags.join(' · ');
    }

    return {
        gameType,
        round: r,
        maxRounds,
        multiplier,
        isLast: !!isLast,
        eyebrow,
        title: `ROUND ${r}`,
        subtitle,
        tags
    };
}









/** Advance departing team only when the next turn begins (not before intermission). */
function doublesAdvanceThrowerAfterVisit(gameData, idx) {
    if (!gameData.isDoublesLineup) return;
    const members = doublesMembersAt(gameData, idx);
    if (members.length <= 1) return;
    doublesEnsureThrowerIndices(gameData);
    gameData.throwerIndices[idx] = (gameData.throwerIndices[idx] + 1) % members.length;
}

function doublesWinnerFields(player) {
    const members = doublesMembersOf(player);
    return {
        winnerId: player.id,
        winnerName: doublesDisplayName(members),
        avatar: members[0] ? members[0].avatar : (player.avatar || null),
        members,
        avatars: members.map(m => m.avatar || null)
    };
}

function scheduleAfterRoundAnnounce(gameType) {
    return { delayMs: OVERLAY_ROUND_ANNOUNCE_MS, next: `${gameType}_after_round_announce` };
}

function dartboardHitFromSpec(throwSpec) {
    if (!throwSpec || throwSpec.miss || throwSpec.number === 'bull') return null;
    return throwSpec.number;
}

/** Random line from a game's quip list. */
function pickQuip(list) {
    return list[Math.floor(Math.random() * list.length)];
}

const DARTBOARD_WHEEL = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

const SEGMENTS_PER_NUMBER = 3; // Added for Killer game logic








function generateDegreeSpacedTargets(count) {
    const targets = [];
    if (count <= 0) return targets;

    const slotStep = 360 / count;
    const offset = Math.random() * 360;
    const used = new Set();

    for (let i = 0; i < count; i++) {
        const slotAngle = normalizeAngle((i * slotStep) + offset);
        let bestIndex = -1;
        let bestDistance = Infinity;

        for (let wi = 0; wi < DARTBOARD_WHEEL.length; wi++) {
            if (used.has(wi)) continue;
            const dist = angularDistance(wheelMidAngle(wi), slotAngle);
            if (dist < bestDistance) {
                bestDistance = dist;
                bestIndex = wi;
            }
        }

        if (bestIndex < 0) break;
        used.add(bestIndex);
        targets.push(DARTBOARD_WHEEL[bestIndex]);
    }

    return targets;
}

function generateSymmetricTargets(count) {
    const targets = [];
    if (count <= 0) return targets;
    const startIndex = Math.floor(Math.random() * DARTBOARD_WHEEL.length);
    const step = DARTBOARD_WHEEL.length / count;
    for (let i = 0; i < count; i++) {
        const targetIndex = Math.floor(startIndex + (i * step)) % DARTBOARD_WHEEL.length;
        targets.push(DARTBOARD_WHEEL[targetIndex]);
    }
    return targets;
}

function normalizeAngle(deg) {
    let angle = deg % 360;
    if (angle < 0) angle += 360;
    return angle;
}

function wheelMidAngle(wheelIndex) {
    const slice = 360 / DARTBOARD_WHEEL.length;
    return wheelIndex * slice;
}

function angularDistance(a, b) {
    const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
    return Math.min(diff, 360 - diff);
}

/** Build players[] where each doubles team is one scoring entity. */
function buildDoublesPlayerRoster(doublesTeams, players, enrichFn, maxTeams = DOUBLES_MAX_TEAMS) {
    const teams = buildDoublesTeams(doublesTeams, players, maxTeams);
    return {
        players: teams.map(members => {
            const base = { ...slimPlayer(members[0]), members: members.map(m => slimPlayer(m)) };
            return enrichFn ? enrichFn(base, members) : base;
        }),
        isDoublesLineup: true,
        throwerIndices: teams.map(() => 0)
    };
}

function buildDoublesTeams(doublesTeams, players, maxTeams = DOUBLES_MAX_TEAMS) {
    const byId = new Map();
    (players || []).forEach(p => {
        if (p && p.id) byId.set(p.id, slimPlayer(p));
    });
    const teams = [];
    (doublesTeams || []).forEach(slots => {
        const members = [];
        (slots || []).forEach(id => {
            if (id && byId.has(id)) members.push(byId.get(id));
        });
        if (members.length > 0) teams.push(members);
    });
    return teams.slice(0, maxTeams);
}

/* --- Shared doubles lineup helpers (revert: remove this block + isDoublesLineup/throwerIndices usage) --- */
const DOUBLES_MAX_TEAMS = 6;

module.exports = {
    buildDoublesPlayerRoster,
    buildDoublesTeams,
    DOUBLES_MAX_TEAMS,
    generateDegreeSpacedTargets,
    generateSymmetricTargets,
    normalizeAngle,
    wheelMidAngle,
    angularDistance,
    setEngineRegistry,
    engineMeta,
    DARTBOARD_WHEEL,
    SEGMENTS_PER_NUMBER,
    dartboardHitFromSpec,
    pickQuip,
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
};

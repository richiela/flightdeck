const fs = require('fs');
const path = require('path');

const ALL_GAMES = [
    'demolition',
    'limbo',
    'derby',
    'killer',
    'quackshot',
    'shanghai',
    'warmup',
    'quick10',
    'x01',
    'cricket',
];

const DART_CALLOUT_MODES = ['card', 'sound', 'both', 'off'];
/** Subdir names under public/assets/sounds/callouts/ — see that folder's README. */
const DART_CALLOUT_VOICES = ['Bella', 'Daniel'];

const DEFAULT_VENUE = {
    arenaName: "Richie's Flight Deck",
    dartCalloutMs: 1200,
    /** 'card' = show the on-screen "what did you hit" card; 'sound' = play a
     *  clip from public/assets/sounds/callouts/ instead, no viewer delay;
     *  'both' = play the clip immediately AND show the card; 'off' = neither.
     *  Cricket's mark-hit callout is unaffected either way. */
    dartCalloutMode: 'card',
    /** Which public/assets/sounds/callouts/ subdir to play from when mode is 'sound'/'both'.
     *  Not exposed in any UI yet — hand-edit venue.json (config/debug panels TBD). */
    dartCalloutVoice: 'Bella',
    /** Bust/event clips on the viewer. Configurable from Control's Configure modal. */
    viewerVideoEnabled: true,
    /** Registration: release avatar camera after this much quiet (ms). */
    registrationIdleMs: 10 * 60 * 1000,
    /** IN_GAME: release screen wake lock after this much quiet (ms). */
    inGameIdleMs: 10 * 60 * 1000,
    /**
     * Board camera standby (minutes) — Autodarts (PATCH /api/config, low-power
     * motion standby) and OpenDarts (POST /api/idle-timeout, auto-stops the
     * capture loop — a real mechanism difference, see each driver's
     * setStandbyMinutes). Same 5/10/15/30/60 options for both, for one
     * consistent Configure control.
     */
    boardStandbyMinutes: 30,
    splitGameCategories: true,
    games: Object.fromEntries(ALL_GAMES.map((k) => [k, true]))
};

/** Defaults above are the schema for data/venue.json (edit that file; missing keys fall back here). */

/** Board camera standby time options — shared by Autodarts + OpenDarts. */
const BOARD_STANDBY_MINUTES = [5, 10, 15, 30, 60];

function clampCalloutMs(raw) {
    let ms = Number(raw);
    if (!Number.isFinite(ms)) ms = DEFAULT_VENUE.dartCalloutMs;
    return Math.max(0, Math.min(8000, Math.round(ms)));
}

/** Idle timers: 30s … 2h. */
function clampIdleMs(raw, fallback) {
    let ms = Number(raw);
    if (!Number.isFinite(ms)) ms = fallback;
    return Math.max(30 * 1000, Math.min(2 * 60 * 60 * 1000, Math.round(ms)));
}

function normalizeDartCalloutMode(raw) {
    const mode = String(raw != null ? raw : '').trim().toLowerCase();
    return DART_CALLOUT_MODES.includes(mode) ? mode : DEFAULT_VENUE.dartCalloutMode;
}

function normalizeDartCalloutVoice(raw) {
    const voice = String(raw != null ? raw : '').trim();
    return DART_CALLOUT_VOICES.includes(voice) ? voice : DEFAULT_VENUE.dartCalloutVoice;
}

function clampBoardStandbyMinutes(raw) {
    const n = Math.round(Number(raw));
    if (BOARD_STANDBY_MINUTES.includes(n)) return n;
    return DEFAULT_VENUE.boardStandbyMinutes;
}

function normalizeGames(raw) {
    const out = { ...DEFAULT_VENUE.games };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of ALL_GAMES) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) {
            out[key] = !!raw[key];
        }
    }
    return out;
}

function normalizeVenueConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const arenaName = String(src.arenaName != null ? src.arenaName : DEFAULT_VENUE.arenaName).trim()
        || DEFAULT_VENUE.arenaName;
    return {
        arenaName,
        dartCalloutMs: clampCalloutMs(
            src.dartCalloutMs != null ? src.dartCalloutMs : DEFAULT_VENUE.dartCalloutMs
        ),
        dartCalloutMode: normalizeDartCalloutMode(
            src.dartCalloutMode != null ? src.dartCalloutMode : DEFAULT_VENUE.dartCalloutMode
        ),
        dartCalloutVoice: normalizeDartCalloutVoice(
            src.dartCalloutVoice != null ? src.dartCalloutVoice : DEFAULT_VENUE.dartCalloutVoice
        ),
        viewerVideoEnabled: src.viewerVideoEnabled !== false,
        registrationIdleMs: clampIdleMs(
            src.registrationIdleMs != null ? src.registrationIdleMs : DEFAULT_VENUE.registrationIdleMs,
            DEFAULT_VENUE.registrationIdleMs
        ),
        inGameIdleMs: clampIdleMs(
            src.inGameIdleMs != null ? src.inGameIdleMs : DEFAULT_VENUE.inGameIdleMs,
            DEFAULT_VENUE.inGameIdleMs
        ),
        boardStandbyMinutes: clampBoardStandbyMinutes(
            src.boardStandbyMinutes != null
                ? src.boardStandbyMinutes
                : DEFAULT_VENUE.boardStandbyMinutes
        ),
        splitGameCategories: src.splitGameCategories !== false,
        games: normalizeGames(src.games)
    };
}

/** Merge a partial patch into data/venue.json and write it back. Games merge key-by-key. */
function saveVenueConfig(dataDir, patch) {
    const configPath = path.join(dataDir, 'venue.json');
    const current = loadVenueConfig(dataDir);
    const src = patch && typeof patch === 'object' ? patch : {};
    const merged = normalizeVenueConfig({
        ...current,
        ...src,
        games: { ...current.games, ...(src.games || {}) }
    });
    try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
        return { ok: true, config: merged };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function loadVenueConfig(dataDir) {
    const configPath = path.join(dataDir, 'venue.json');
    let file = {};
    try {
        if (fs.existsSync(configPath)) {
            file = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
        }
    } catch (err) {
        console.error('Failed to read data/venue.json:', err.message);
    }
    return normalizeVenueConfig(file);
}

function isGameEnabled(venue, gameKey) {
    if (!gameKey) return false;
    const games = (venue && venue.games) || DEFAULT_VENUE.games;
    if (!Object.prototype.hasOwnProperty.call(games, gameKey)) return true;
    return !!games[gameKey];
}

function firstEnabledGame(venue) {
    for (const key of ALL_GAMES) {
        if (isGameEnabled(venue, key)) return key;
    }
    return 'demolition';
}

module.exports = {
    ALL_GAMES,
    DEFAULT_VENUE,
    BOARD_STANDBY_MINUTES,
    DART_CALLOUT_MODES,
    DART_CALLOUT_VOICES,
    loadVenueConfig,
    saveVenueConfig,
    normalizeVenueConfig,
    isGameEnabled,
    firstEnabledGame,
    clampCalloutMs,
    clampIdleMs,
    clampBoardStandbyMinutes,
    normalizeDartCalloutMode,
    normalizeDartCalloutVoice
};

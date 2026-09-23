const express = require('express');
const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Repo root. Application code lives in src/; the directories the server reads
 * and serves — data/, certs/, public/ — sit beside it, not inside it. One
 * constant rather than a '..' on each join, so the relationship is stated once.
 */
const ROOT = path.join(__dirname, '..');

// Bumped alongside the two HTML version badges + CHANGELOG.md (see the
// deploy-to-prod runbook) — also doubles as a reliable "did nodemon
// actually restart" signal: nodemon only watches server.js and engines/
// (nodemon.json), so a deploy that touches neither never restarts the
// running process. Check this in the startup log / data/server.log.
/**
 * Single source of truth for the app version: package.json.
 *
 * This used to be a literal here, with two more literals in the version badges
 * in control.html and viewer.html — three copies kept in step by hand, and the
 * two the user actually SEES were not connected to this one at all. Bump
 * package.json (or `npm version minor`) and everything follows.
 */
const APP_VERSION = `v${require('../package.json').version}`;

/* --- console -> data/server.log ------------------------------------------
 * The rig is headless and runs for weeks, so console output has to land in a
 * file you can tail. Two things make that less trivial than a shell redirect:
 *
 *  - run.sh launches through nodemon, so Node's stdout is a PIPE, not a TTY,
 *    and Node buffers it. `node server.js >> log` or `| tee` would leave you
 *    staring at a stale file until a whole block fills. Hooking console.*
 *    directly sidesteps the buffer.
 *  - the file would otherwise grow without bound.
 *
 * Writes go through a stream, not fs.writeSync: synchronous disk I/O on every
 * console call sits on the same event loop that scores darts, and on a slow or
 * networked disk that is a stutter mid-visit which is near-impossible to
 * diagnose afterwards.
 */
const LOG_PATH = path.join(ROOT, 'data', 'server.log');
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_KEEP_BYTES = 5 * 1024 * 1024;
let logStream = null;

/** Trim to the trailing KEEP bytes, starting at a line boundary. */
function rotateLogIfLarge() {
    try {
        if (!fs.existsSync(LOG_PATH)) return;
        const size = fs.statSync(LOG_PATH).size;
        if (size <= LOG_MAX_BYTES) return;
        const fd = fs.openSync(LOG_PATH, 'r');
        try {
            const start = Math.max(0, size - LOG_KEEP_BYTES);
            const buf = Buffer.alloc(size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            const nl = buf.indexOf(0x0a);
            fs.writeFileSync(LOG_PATH, nl >= 0 ? buf.subarray(nl + 1) : buf);
        } finally {
            fs.closeSync(fd);
        }
    } catch (_) {
        /* logging must never take the server down */
    }
}

function installLogTee() {
    try {
        fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
        rotateLogIfLarge();
        logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    } catch (err) {
        console.error('[LOG] file logging disabled:', err.message);
        return;
    }

    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        const orig = console[method].bind(console);
        console[method] = (...args) => {
            try { logStream.write(require('util').format(...args) + '\n'); } catch (_) {}
            return orig(...args);
        };
    }

    // Rotation is checked off the hot path rather than on every write. The log
    // grows a few hundred KB a night, so this is a monthly event at most.
    setInterval(() => {
        try {
            if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
                logStream.end();
                rotateLogIfLarge();
                logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
            }
        } catch (_) {}
    }, 5 * 60 * 1000).unref();

    logStream.write(`\n----- FlightDeck log start ${new Date().toISOString()} -----\n`);
}

installLogTee();

const { initGameData, handleGameAction, applyScheduledAction, buildDebugPreviewPhase, initialMatchSchedule, buildQuick10MatchRecord, CRICKET_MAX_PLAYERS, X01_MAX_PLAYERS, normalizeThrowProfileId, DEFAULT_THROW_PROFILE, getActiveThrowerEntity, parseBotFromName } = require('./engines');
const { mapScoliaThrow, isMockMode } = require('./board/scolia/scoliaClient');
const { createBoardDriver, loadBoardConfig, saveBoardConfig } = require('./board/createBoardDriver');
const { appendMatch, topMatches } = require('./matchHistory');
const { loadVenueConfig, saveVenueConfig, isGameEnabled, firstEnabledGame, ALL_GAMES } = require('./venueConfig');
const { createTapoLights } = require('./lights/tapoLights');

const app = express();
const sslOptions = {
    key: fs.readFileSync(path.join(ROOT, 'certs', 'server.key')),
    cert: fs.readFileSync(path.join(ROOT, 'certs', 'server.crt'))
};
const server = https.createServer(sslOptions, app);
const wss = new WebSocket.Server({ server });

const CLIPS_DIR = path.join(ROOT, 'public', 'clips');

/** Phase-2 spike: Mini POSTs raw mp4 body; returns playable /clips/… URL. */
app.post(
    '/api/debug/winner-clip',
    express.raw({ type: () => true, limit: '50mb' }),
    (req, res) => {
        try {
            if (!Buffer.isBuffer(req.body) || req.body.length < 32) {
                res.status(400).json({ ok: false, error: 'empty body — POST raw mp4 bytes' });
                return;
            }
            if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
            const name = `winner-${Date.now()}.mp4`;
            const filePath = path.join(CLIPS_DIR, name);
            const t0 = Date.now();
            fs.writeFileSync(filePath, req.body);
            const writeMs = Date.now() - t0;
            const url = `/clips/${name}`;
            console.log(
                `\x1b[36m[CLIP]\x1b[0m saved ${name} (${req.body.length} bytes, write ${writeMs}ms)`
            );
            res.json({
                ok: true,
                url,
                bytes: req.body.length,
                writeMs,
                absoluteUrl: `${req.protocol}://${req.get('host')}${url}`
            });
        } catch (err) {
            console.error('[CLIP] upload failed:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    }
);

// extensions: ['html'] lets /control and /viewer resolve to control.html/viewer.html
// without a redirect — /control.html etc. still work exactly as before, this just adds
// the shorter path as an alternative.
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const DATA_DIR = path.join(ROOT, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const THROW_QUEUE_MAX = 3;
/** Delay between bot darts / before first dart on a bot turn. */
const BOT_DART_DELAY_MS = 1200;
/** Bust overlay safety max when Video is on (longest bust-*.mp4 ~8.0s + buffer). Viewer advances early on BUST_VIDEO_COMPLETE. */
const DEMOLITION_BUST_VIDEO_OVERLAY_MS = 8500;
/** Max wait in TVM phase for dump+play before forcing checkout (safety net). */
const DEMOLITION_TVM_MAX_MS = 20000;
const DEMOLITION_ASSETS_DIR = path.join(ROOT, 'public', 'assets', 'demolition');
const SHARED_ASSETS_DIR = path.join(ROOT, 'public', 'assets', 'shared');

let venueConfig = loadVenueConfig(DATA_DIR);
/** False until board driver (`boardDriver`) is created — guards venue→board standby apply. */
let boardDriverReady = false;

function logVenueConfig(label = 'VENUE') {
    console.log(
        `\x1b[36m[${label}]\x1b[0m ${venueConfig.arenaName}`
        + ` · callout ${venueConfig.dartCalloutMode}`
        + (['card', 'both'].includes(venueConfig.dartCalloutMode) ? ` (${venueConfig.dartCalloutMs}ms)` : '')
        + (['sound', 'both'].includes(venueConfig.dartCalloutMode) ? ` [${venueConfig.dartCalloutVoice}]` : '')
        + ` · reg idle ${Math.round(venueConfig.registrationIdleMs / 1000)}s`
        + ` · in-game idle ${Math.round(venueConfig.inGameIdleMs / 1000)}s`
        + ` · board standby ${venueConfig.boardStandbyMinutes}m`
        + (venueConfig.tvmRecorderEnabled
            ? ` · TVMRecorder ${venueConfig.tvmRecorderHost}:${venueConfig.tvmRecorderPort}`
            : '')
        + ` · categories ${venueConfig.splitGameCategories ? 'on' : 'off'}`
    );
}

logVenueConfig();

function applyVenueToGameState() {
    if (!gameState) return;
    gameState.arenaName = venueConfig.arenaName;
    gameState.dartCalloutMs = venueConfig.dartCalloutMs;
    gameState.dartCalloutMode = venueConfig.dartCalloutMode;
    gameState.dartCalloutVoice = venueConfig.dartCalloutVoice;
    gameState.viewerVideoEnabled = venueConfig.viewerVideoEnabled;
    gameState.registrationIdleMs = venueConfig.registrationIdleMs;
    gameState.inGameIdleMs = venueConfig.inGameIdleMs;
    gameState.boardStandbyMinutes = venueConfig.boardStandbyMinutes;
    gameState.splitGameCategories = venueConfig.splitGameCategories;
    gameState.enabledGames = { ...venueConfig.games };
    // Don't yank an active match; only re-pick preview selection on setup screens
    if (
        gameState.currentScreen !== 'IN_GAME'
        && !isGameEnabled(venueConfig, gameState.selectedGame)
    ) {
        gameState.selectedGame = firstEnabledGame(venueConfig);
    }
}

function reloadVenueConfigFromDisk(reason) {
    venueConfig = loadVenueConfig(DATA_DIR);
    applyVenueToGameState();
    logVenueConfig(`VENUE reload · ${reason || 'change'}`);
    broadcastState();
    applyBoardStandbyFromVenue();
}

/** TVMRecorder HTTP (buffer start/stop/dump). No-op unless venue.tvmRecorderEnabled. */
function tvmRecorderRequest(method, urlPath, timeoutMs = 2000) {
    return new Promise((resolve) => {
        if (!venueConfig || !venueConfig.tvmRecorderEnabled) {
            resolve({ ok: false, skipped: true });
            return;
        }
        const host = venueConfig.tvmRecorderHost;
        const port = venueConfig.tvmRecorderPort;
        const req = http.request(
            {
                host,
                port,
                path: urlPath,
                method,
                timeout: timeoutMs,
                headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    let data = null;
                    try {
                        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch (_) {
                        data = null;
                    }
                    resolve({
                        ok: !!(res.statusCode >= 200 && res.statusCode < 300 && data && data.ok !== false),
                        status: res.statusCode,
                        data
                    });
                });
            }
        );
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, error: 'timeout' });
        });
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.write('{}');
        req.end();
    });
}

/** Games that may start the ADMac face ring / TV Moments. Expand as we add more. */
const TVM_RECORDER_GAMES = new Set(['demolition']);

function gameSupportsTvmRecorder(gameType) {
    return TVM_RECORDER_GAMES.has(gameType);
}

function tvmRecorderBufferStart(reason) {
    if (!gameSupportsTvmRecorder(gameState && gameState.selectedGame)) {
        logDebugEvent(
            'TVMREC',
            `buffer start skipped — ${gameState && gameState.selectedGame} (TVM games: ${[...TVM_RECORDER_GAMES].join(', ')})`
        );
        return;
    }
    tvmRecorderRequest('POST', '/buffer/start', 3000).then((r) => {
        if (r.skipped) return;
        if (r.ok) logDebugEvent('TVMREC', `buffer start (${reason || 'ok'})`);
        else logDebugEvent('TVMREC', `buffer start failed: ${(r.data && r.data.error) || r.error || r.status}`);
    });
}

function tvmRecorderBufferStop(reason) {
    tvmRecorderRequest('POST', '/buffer/stop', 3000).then((r) => {
        if (r.skipped) return;
        if (r.ok) logDebugEvent('TVMREC', `buffer stop (${reason || 'ok'})`);
        else logDebugEvent('TVMREC', `buffer stop failed: ${(r.data && r.data.error) || r.error || r.status}`);
    });
}

let tvmRecorderDumpInFlight = false;

function tvmRecorderActive() {
    return !!(venueConfig && venueConfig.tvmRecorderEnabled
        && gameState && gameState.viewerVideoEnabled !== false
        && gameSupportsTvmRecorder(gameState.selectedGame));
}

/** TV Moment (tvm) — dump face ring; Demolition: on checkout (hit 0), not final winner. */
function tvmRecorderDumpOnTvm(reason) {
    if (!tvmRecorderActive()) return;
    if (tvmRecorderDumpInFlight) return;
    tvmRecorderDumpInFlight = true;
    if (gameState && gameState.gameData) {
        gameState.gameData.tvmClipUrl = null;
    }
    // Dump waits clipAfterSec on Mini then uploads — allow long timeout
    tvmRecorderRequest('POST', '/buffer/dump', 30000).then((r) => {
        tvmRecorderDumpInFlight = false;
        if (!r.ok) {
            logDebugEvent('TVMREC', `tvm dump failed: ${(r.data && r.data.error) || r.error || r.status}`, { reason });
            return;
        }
        const url = r.data && r.data.url;
        if (url && gameState && gameState.gameData) {
            onTvmClipReady(url);
        } else {
            logDebugEvent('TVMREC', 'tvm dump ok but no url', { reason });
        }
    }).catch((err) => {
        tvmRecorderDumpInFlight = false;
        logDebugEvent('TVMREC', err.message || 'tvm dump failed', { reason });
    });
}

/**
 * Demolition TVM: dump on the checkout throw (during brick anim) so the clip
 * is ready (or nearly) when the tvm phase opens. Fall back if phase enters tvm
 * without a dump already in flight (e.g. debug).
 */
function maybeTvmRecorderDumpForTvm(prevPhase, result) {
    if (!tvmRecorderActive()) return;
    const game = gameState && gameState.selectedGame;
    if (game !== 'demolition') return;

    const gd = result && result.gameData;
    if (
        gd
        && gd.lastThrow
        && gd.lastThrow.checkout
        && result.schedule
        && result.schedule.next === 'demolition_show_tvm'
    ) {
        tvmRecorderDumpOnTvm('demolition checkout throw');
        return;
    }

    const next = currentPhaseType();
    if (next === 'tvm' && prevPhase !== 'tvm') {
        tvmRecorderDumpOnTvm(`demolition ${prevPhase || 'none'}→tvm`);
    }
}

function advanceTvmToCheckout(reason) {
    if (currentPhaseType() !== 'tvm' || !gameState.gameData) return false;
    clearPhaseTimer();
    pendingSchedule = null;
    const result = applyScheduledAction(gameState.gameData, { next: 'demolition_show_checkout' });
    gameState.gameData = result.gameData;
    maybePersistQuick10(result);
    logEvent('PHASE_ADVANCE', { next: 'demolition_show_checkout', reason: reason || 'tvm done' });
    logDebugEvent('TVM', `advance → checkout (${reason || 'done'})`);
    broadcastState();
    if (result.schedule) {
        schedulePhaseAction(result.schedule);
    } else {
        drainThrowQueue();
        nudgeBotAutoThrow('tvm → checkout done');
    }
    return true;
}

/** Fire the pending bust schedule early (Viewer bust video ended). Safety timer remains if message never arrives. */
function advancePendingBust(reason) {
    if (!gameState || !gameState.gameData || !pendingSchedule) return false;
    const next = pendingSchedule.next;
    if (next !== 'demolition_after_bust' && next !== 'x01_after_bust') return false;
    if (currentPhaseType() !== 'bust') return false;

    clearPhaseTimer();
    const scheduleNow = pendingSchedule;
    pendingSchedule = null;
    const prevPhase = currentPhaseType();
    const result = applyScheduledAction(gameState.gameData, scheduleNow);
    gameState.gameData = result.gameData;
    maybePersistQuick10(result);
    maybeTvmRecorderDumpForTvm(prevPhase, result);
    logEvent('PHASE_ADVANCE', { next: scheduleNow.next, reason: reason || 'bust video ended' });
    logDebugEvent('BUST_VIDEO', `advance → ${scheduleNow.next} (${reason || 'ended'})`);
    broadcastState();
    if (result.schedule) {
        schedulePhaseAction(result.schedule);
    } else {
        drainThrowQueue();
        nudgeBotAutoThrow('bust video done');
    }
    return true;
}

function onTvmClipReady(url) {
    if (!gameState || !gameState.gameData) return;
    gameState.gameData.tvmClipUrl = url;
    logDebugEvent('TVMREC', `tvm dump ok → ${url}`);
    broadcastState();
    // Viewer plays the clip and sends TVM_COMPLETE on ended; max timer remains as fallback.
}

/** Bust event clips: public/assets/demolition/bust-*.mp4 (flat per-game folder). */
function listDemolitionBustVideos() {
    try {
        return fs.readdirSync(DEMOLITION_ASSETS_DIR)
            .filter((name) => /^bust-.*\.mp4$/i.test(name))
            .sort()
            .map((name) => `/assets/demolition/${name}`);
    } catch (_) {
        return [];
    }
}

/** Shared winner clips: public/assets/shared/winner-*.mp4 (all games). */
function listSharedWinnerVideos() {
    try {
        return fs.readdirSync(SHARED_ASSETS_DIR)
            .filter((name) => /^winner-.*\.mp4$/i.test(name))
            .sort()
            .map((name) => `/assets/shared/${name}`);
    } catch (_) {
        return [];
    }
}

let phaseTimer = null;
/** Pending overlay schedule (so Correct Score can flush without waiting). */
let pendingSchedule = null;
/** Bot auto-throw timer (v1). */
let botThrowTimer = null;
let boardSync = {
    awaitingTakeout: false
};
/** Throws that arrived during an overlay — applied when phase returns to playing. */
let throwQueue = [];
let drainingThrowQueue = false;

/** Last accepted throw undo (pre-throw snapshot). Last dart only. */
let lastThrowUndo = null;
/**
 * Active Correct Score session.
 * Heavy snapshots stay here — only { active, wasLabel } is broadcast.
 */
let scoreCorrection = null;

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function loadPersistedPlayers() {
    try {
        ensureDataDir();
        if (!fs.existsSync(PLAYERS_FILE)) return [];
        const raw = fs.readFileSync(PLAYERS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(p => p && typeof p.name === 'string' && p.name.trim())
            .map(p => ({
                id: p.id || uuidv4(),
                name: p.name.trim(),
                avatar: p.avatar || null
            }));
    } catch (err) {
        console.error('Failed to load persisted players:', err.message);
        return [];
    }
}

function savePersistedPlayers(players) {
    try {
        ensureDataDir();
        const slim = (players || []).map(p => ({
            id: p.id,
            name: p.name,
            avatar: p.avatar || null
        }));
        fs.writeFileSync(PLAYERS_FILE, JSON.stringify(slim, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save persisted players:', err.message);
    }
}

/* --- Lineup doubles mode (revert: remove these helpers + lineupMode/doublesTeams from state) --- */
const DOUBLES_TEAM_COUNT = 6;
const DOUBLES_SLOTS_PER_TEAM = 2;

function emptyDoublesTeams() {
    return Array.from({ length: DOUBLES_TEAM_COUNT }, () =>
        Array.from({ length: DOUBLES_SLOTS_PER_TEAM }, () => null)
    );
}

function seedDoublesTeamsFromPlayers(players) {
    const teams = emptyDoublesTeams();
    const maxSlots = DOUBLES_TEAM_COUNT * DOUBLES_SLOTS_PER_TEAM;
    (players || []).slice(0, maxSlots).forEach((p, i) => {
        const teamIdx = Math.floor(i / DOUBLES_SLOTS_PER_TEAM);
        const slotIdx = i % DOUBLES_SLOTS_PER_TEAM;
        teams[teamIdx][slotIdx] = p.id;
    });
    return teams;
}

function playersByIdMap(players) {
    const map = new Map();
    (players || []).forEach(p => {
        if (p && p.id) map.set(p.id, p);
    });
    return map;
}

/** Flatten team slots into display/play order; append any unassigned players at the end. */
function flattenDoublesTeamsToPlayers(doublesTeams, players) {
    const byId = playersByIdMap(players);
    const ordered = [];
    const seen = new Set();
    (doublesTeams || []).forEach(team => {
        (team || []).forEach(id => {
            if (id && byId.has(id) && !seen.has(id)) {
                ordered.push(byId.get(id));
                seen.add(id);
            }
        });
    });
    byId.forEach((p, id) => {
        if (!seen.has(id)) ordered.push(p);
    });
    return ordered;
}

function doublesNonEmptyTeamCount(doublesTeams) {
    return (doublesTeams || []).filter(team => (team || []).some(Boolean)).length;
}

/** Singles caps at 6 seated; extras stay on the waiting bench. */
const SINGLES_MAX_PLAYERS = 6;
const SINGLES_SLOT_COUNT = 12;
const LINEUP_BENCH = -1;

function emptySinglesLineup() {
    return Array.from({ length: SINGLES_SLOT_COUNT }, () => null);
}

function seedSinglesLineupFromPlayers(players, maxSeated = SINGLES_MAX_PLAYERS) {
    const slots = emptySinglesLineup();
    const limit = Math.min(maxSeated, SINGLES_SLOT_COUNT);
    (players || []).slice(0, limit).forEach((p, i) => {
        if (p && p.id) slots[i] = p.id;
    });
    return slots;
}

function clearPlayerFromSinglesLineup(playerId) {
    if (!gameState.singlesLineup) return;
    for (let i = 0; i < gameState.singlesLineup.length; i++) {
        if (gameState.singlesLineup[i] === playerId) gameState.singlesLineup[i] = null;
    }
}

function getDoublesSeatedIds() {
    const ids = [];
    (gameState.doublesTeams || []).forEach(team => {
        (team || []).forEach(id => { if (id) ids.push(id); });
    });
    return ids;
}

function getSinglesSeatedIds() {
    return (gameState.singlesLineup || []).filter(Boolean);
}

function getSeatedPlayerIds() {
    return gameState.lineupMode === 'doubles' ? getDoublesSeatedIds() : getSinglesSeatedIds();
}

function getSeatedPlayers() {
    const byId = playersByIdMap(gameState.players);
    return getSeatedPlayerIds().map(id => byId.get(id)).filter(Boolean);
}

/** Count cricket/X01 "players" — doubles teams count as one each; singles uses seated only. */
function cricketRosterCount() {
    if (gameState.lineupMode === 'doubles') {
        return doublesNonEmptyTeamCount(gameState.doublesTeams);
    }
    return getSinglesSeatedIds().length;
}

function fourPlayerCapFor(gameType) {
    if (gameType === 'x01') return X01_MAX_PLAYERS;
    if (gameType === 'cricket') return CRICKET_MAX_PLAYERS;
    return null;
}

function fourPlayerGameLabel(gameType) {
    return gameType === 'x01' ? 'X01' : 'Cricket';
}

/** Warmup / Quick 10 / X01 may start with a single competitor; everyone else needs 2+. */
const SOLO_START_GAMES = new Set(['warmup', 'quick10', 'x01']);

function gameAllowsSoloStart(gameType) {
    return SOLO_START_GAMES.has(gameType);
}

function syncPlayersFromDoublesTeams() {
    gameState.players = flattenDoublesTeamsToPlayers(gameState.doublesTeams, gameState.players);
}

function placePlayerInFirstOpenDoublesSlot(playerId) {
    const teams = gameState.doublesTeams || emptyDoublesTeams();
    for (let t = 0; t < teams.length; t++) {
        for (let s = 0; s < teams[t].length; s++) {
            if (!teams[t][s]) {
                teams[t][s] = playerId;
                gameState.doublesTeams = teams;
                return true;
            }
        }
    }
    gameState.doublesTeams = teams;
    return false;
}

function clearPlayerFromDoublesTeams(playerId) {
    if (!gameState.doublesTeams) return;
    gameState.doublesTeams.forEach(team => {
        for (let s = 0; s < team.length; s++) {
            if (team[s] === playerId) team[s] = null;
        }
    });
}

/**
 * Move within doubles slots, or to/from bench (team === LINEUP_BENCH).
 * Empty dest → place there; occupied dest → swap (bench→occupied sends occupant to bench).
 */
function moveDoublesPlayer(fromTeam, fromSlot, toTeam, toSlot, playerId) {
    const teams = gameState.doublesTeams;
    if (!teams) return false;

    if (toTeam === LINEUP_BENCH) {
        if (fromTeam === LINEUP_BENCH) return false;
        if (fromTeam < 0 || fromTeam >= teams.length || fromSlot < 0 || fromSlot >= DOUBLES_SLOTS_PER_TEAM) {
            return false;
        }
        if (!teams[fromTeam][fromSlot]) return false;
        teams[fromTeam][fromSlot] = null;
        return true;
    }

    if (toTeam < 0 || toTeam >= teams.length || toSlot < 0 || toSlot >= DOUBLES_SLOTS_PER_TEAM) {
        return false;
    }

    if (fromTeam === LINEUP_BENCH) {
        if (!playerId || !playersByIdMap(gameState.players).has(playerId)) return false;
        clearPlayerFromDoublesTeams(playerId);
        // Empty → place; occupied → occupant returns to bench
        teams[toTeam][toSlot] = playerId;
        return true;
    }

    if (
        fromTeam < 0 || fromTeam >= teams.length ||
        fromSlot < 0 || fromSlot >= DOUBLES_SLOTS_PER_TEAM
    ) {
        return false;
    }
    const movingId = teams[fromTeam][fromSlot];
    if (!movingId) return false;
    if (fromTeam === toTeam && fromSlot === toSlot) return false;

    const destId = teams[toTeam][toSlot];
    teams[toTeam][toSlot] = movingId;
    teams[fromTeam][fromSlot] = destId || null; // swap, or leave source empty
    return true;
}

/**
 * Move within singles slots, or to/from bench (slot === LINEUP_BENCH).
 * Empty dest → place there; occupied dest → swap (bench→occupied sends occupant to bench).
 * Singles caps at SINGLES_MAX_PLAYERS when seating into an empty slot from the bench.
 */
function moveSinglesPlayer(fromSlot, toSlot, playerId) {
    if (!gameState.singlesLineup) gameState.singlesLineup = emptySinglesLineup();
    const lineup = gameState.singlesLineup;

    if (toSlot === LINEUP_BENCH) {
        if (fromSlot === LINEUP_BENCH) return false;
        if (fromSlot < 0 || fromSlot >= lineup.length) return false;
        if (!lineup[fromSlot]) return false;
        lineup[fromSlot] = null;
        return true;
    }

    if (toSlot < 0 || toSlot >= lineup.length) return false;

    if (fromSlot === LINEUP_BENCH) {
        if (!playerId || !playersByIdMap(gameState.players).has(playerId)) return false;
        clearPlayerFromSinglesLineup(playerId);
        const destOccupied = !!lineup[toSlot];
        if (!destOccupied && getSinglesSeatedIds().length >= SINGLES_MAX_PLAYERS) return false;
        // Empty → place; occupied → replace (old occupant back on bench via clear + not re-seated)
        lineup[toSlot] = playerId;
        return true;
    }

    if (fromSlot < 0 || fromSlot >= lineup.length) return false;
    const movingId = lineup[fromSlot];
    if (!movingId) return false;
    if (fromSlot === toSlot) return false;

    const destId = lineup[toSlot];
    lineup[toSlot] = movingId;
    lineup[fromSlot] = destId || null;
    return true;
}

function getBenchPlayers() {
    ensureWaitingOrder();
    const seated = new Set(getSeatedPlayerIds());
    const byId = playersByIdMap(gameState.players);
    return (gameState.waitingOrder || [])
        .filter((id) => id && !seated.has(id))
        .map((id) => byId.get(id))
        .filter(Boolean);
}

/** Keep waitingOrder in sync with registered players (append new, drop deleted). */
function ensureWaitingOrder() {
    const ids = (gameState.players || []).map((p) => p && p.id).filter(Boolean);
    const idSet = new Set(ids);
    if (!Array.isArray(gameState.waitingOrder)) gameState.waitingOrder = [];
    const next = gameState.waitingOrder.filter((id) => idSet.has(id));
    ids.forEach((id) => {
        if (!next.includes(id)) next.push(id);
    });
    gameState.waitingOrder = next;
}

/**
 * Insert-reorder among Waiting players only (not swap).
 * beforePlayerId null → move to end of bench.
 */
function reorderWaitingPlayer(playerId, beforePlayerId) {
    if (!playerId) return false;
    ensureWaitingOrder();
    const seated = new Set(getSeatedPlayerIds());
    if (seated.has(playerId)) return false;
    const byId = playersByIdMap(gameState.players);
    if (!byId.has(playerId)) return false;

    const benchIds = (gameState.waitingOrder || []).filter((id) => id && !seated.has(id));
    const fromIdx = benchIds.indexOf(playerId);
    if (fromIdx < 0) return false;
    benchIds.splice(fromIdx, 1);

    let insertAt = benchIds.length;
    if (beforePlayerId && beforePlayerId !== playerId) {
        const toIdx = benchIds.indexOf(beforePlayerId);
        if (toIdx >= 0) insertAt = toIdx;
    }
    benchIds.splice(insertAt, 0, playerId);

    // Preserve any seated ids that were still listed, then bench order
    const seatedOrdered = (gameState.waitingOrder || []).filter((id) => seated.has(id));
    gameState.waitingOrder = [...seatedOrdered, ...benchIds];
    return true;
}

/** Clear seated lineup → everyone on waiting bench (players stay registered). */
function clearLineupToBench() {
    if (gameState.lineupMode === 'doubles') {
        gameState.doublesTeams = emptyDoublesTeams();
        syncPlayersFromDoublesTeams();
    } else {
        gameState.singlesLineup = emptySinglesLineup();
    }
}

/** Force empty singles lineup mode (used after Remove All). */
function resetLineupToSingles() {
    gameState.lineupMode = 'singles';
    gameState.singlesLineup = emptySinglesLineup();
    gameState.doublesTeams = emptyDoublesTeams();
}

/**
 * Seat waiting-bench players into open lineup slots.
 * Singles with more than SINGLES_MAX registered → auto-switch to doubles, then seat all (≤12).
 */
function fillLineupFromBench() {
    const totalPlayers = (gameState.players || []).filter((p) => p && p.id).length;
    if (
        gameState.lineupMode === 'singles'
        && totalPlayers > SINGLES_MAX_PLAYERS
    ) {
        const seated = getSeatedPlayers();
        gameState.lineupMode = 'doubles';
        gameState.doublesTeams = seedDoublesTeamsFromPlayers(seated);
        gameState.singlesLineup = emptySinglesLineup();
        syncPlayersFromDoublesTeams();
        logEvent('SET_LINEUP_MODE', { mode: 'doubles', reason: 'fill_lineup_overflow' });
        logDebugEvent(
            'SET_LINEUP_MODE',
            `Auto doubles on Add All: ${totalPlayers} registered (>${SINGLES_MAX_PLAYERS}).`
        );
    }

    const bench = getBenchPlayers();
    if (!bench.length) return 0;
    let seatedCount = 0;

    if (gameState.lineupMode === 'doubles') {
        if (!gameState.doublesTeams) gameState.doublesTeams = emptyDoublesTeams();
        for (const p of bench) {
            if (!placePlayerInFirstOpenDoublesSlot(p.id)) break;
            seatedCount += 1;
        }
        syncPlayersFromDoublesTeams();
        return seatedCount;
    }

    if (!gameState.singlesLineup) gameState.singlesLineup = emptySinglesLineup();
    const lineup = gameState.singlesLineup;
    for (const p of bench) {
        if (getSinglesSeatedIds().length >= SINGLES_MAX_PLAYERS) break;
        let placed = false;
        for (let i = 0; i < lineup.length; i++) {
            if (!lineup[i]) {
                lineup[i] = p.id;
                placed = true;
                seatedCount += 1;
                break;
            }
        }
        if (!placed) break;
    }
    return seatedCount;
}

function shuffleInPlace(list) {
    const arr = list;
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

/**
 * Randomize seated throw order. Singles: reshuffle seated slot order.
 * Doubles: reshuffle team order and partners within each team (bench untouched).
 */
function randomizeSeatedLineup() {
    if (gameState.lineupMode === 'doubles') {
        const occupied = (gameState.doublesTeams || [])
            .map((team) => (team || []).filter(Boolean))
            .filter((members) => members.length > 0)
            .map((members) => shuffleInPlace([...members]));
        shuffleInPlace(occupied);
        const teams = emptyDoublesTeams();
        occupied.forEach((members, teamIdx) => {
            if (teamIdx >= teams.length) return;
            members.forEach((id, slotIdx) => {
                if (slotIdx < teams[teamIdx].length) teams[teamIdx][slotIdx] = id;
            });
        });
        gameState.doublesTeams = teams;
        syncPlayersFromDoublesTeams();
        return occupied.reduce((n, m) => n + m.length, 0);
    }

    const ids = shuffleInPlace([...getSinglesSeatedIds()]);
    const lineup = emptySinglesLineup();
    ids.forEach((id, i) => {
        if (i < lineup.length) lineup[i] = id;
    });
    gameState.singlesLineup = lineup;
    return ids.length;
}
/* --- end lineup doubles helpers --- */

function normalizePlayerNameKey(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}


function playerNameTaken(players, name, exceptId = null) {
    const key = normalizePlayerNameKey(name);
    if (!key) return false;
    return (players || []).some((p) => {
        if (!p || !p.name) return false;
        if (exceptId && p.id === exceptId) return false;
        return normalizePlayerNameKey(p.name) === key;
    });
}

function createFreshState(players = []) {
    return {
        matchId: uuidv4(),
        currentScreen: 'REGISTRATION',
        players: [...players],
        selectedGame: firstEnabledGame(venueConfig),
        gameData: null,
        selectionError: null,
        viewerCue: null,
        registrationError: null,
        eventLog: [],
        // Lineup doubles / singles slots + bench (revert: drop these fields)
        lineupMode: 'singles',
        doublesTeams: emptyDoublesTeams(),
        // Everyone from players.json starts on the waiting bench
        singlesLineup: emptySinglesLineup(),
        // Waiting-bench display order (session only; insert-reorder, not swap)
        waitingOrder: (players || []).map((p) => p && p.id).filter(Boolean),
        // Bust/event clips on the viewer — from data/venue.json, set via SET_VIEWER_VIDEO
        viewerVideoEnabled: venueConfig.viewerVideoEnabled,
        // Debug / bot throw skill (Casual | Intermediate | Advanced)
        debugThrowProfile: DEFAULT_THROW_PROFILE,
        // Brief Viewer announce after every dart (0 = off) — from data/venue.json
        dartCalloutMs: venueConfig.dartCalloutMs,
        // 'card' | 'sound' | 'off' — see wrapDartCallout(). From data/venue.json
        dartCalloutMode: venueConfig.dartCalloutMode,
        // Which public/assets/sounds/callouts/ subdir to play from. From data/venue.json
        dartCalloutVoice: venueConfig.dartCalloutVoice,
        arenaName: venueConfig.arenaName,
        registrationIdleMs: venueConfig.registrationIdleMs,
        inGameIdleMs: venueConfig.inGameIdleMs,
        boardStandbyMinutes: venueConfig.boardStandbyMinutes,
        /** Last Control action / scoring throw — drives in-game wake-lock idle. */
        lastVenueActivityAt: Date.now(),
        splitGameCategories: venueConfig.splitGameCategories,
        enabledGames: { ...venueConfig.games }
    };
}

let gameState = createFreshState(loadPersistedPlayers());
ensureWaitingOrder();
if (gameState.players.length) {
    logBootPlayers(gameState.players.length);
}

/** Hot-reload data/venue.json (editors often replace the file — watch the data dir). */
(function watchVenueConfigFile() {
    let debounce = null;
    const schedule = (reason) => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
            debounce = null;
            try {
                reloadVenueConfigFromDisk(reason);
            } catch (err) {
                console.error('\x1b[36m[VENUE]\x1b[0m reload failed:', err.message);
            }
        }, 300);
    };
    try {
        fs.watch(DATA_DIR, { persistent: true }, (_eventType, filename) => {
            if (!filename) return;
            const base = path.basename(String(filename));
            if (base === 'venue.json' || base.startsWith('venue.json.')) {
                schedule(base);
            }
        });
        console.log('\x1b[36m[VENUE]\x1b[0m Watching data/venue.json for changes');
    } catch (err) {
        console.warn('\x1b[36m[VENUE]\x1b[0m Watch unavailable:', err.message);
    }
}());

function logBootPlayers(count) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`\x1b[36m[DEBUG - ${timestamp}]\x1b[0m \x1b[33mPLAYERS_LOADED\x1b[0m: Restored ${count} player(s) from disk.`);
}

function logDebugEvent(actionType, message, details = null) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`\x1b[36m[DEBUG - ${timestamp}]\x1b[0m \x1b[33m${actionType}\x1b[0m: ${message}`);
    if (details) {
        console.log(`\x1b[90mDetails:\x1b[0m`, JSON.stringify(details, null, 2));
    }
    console.log(`\x1b[90m--------------------------------------------------------\x1b[0m`);
}

function logEvent(action, details = null) {
    gameState.eventLog.push({
        id: uuidv4(),
        timestamp: Date.now(),
        action,
        details
    });
}

function clearPhaseTimer() {
    if (phaseTimer) {
        clearTimeout(phaseTimer);
        phaseTimer = null;
    }
}

function cancelPhaseChain() {
    clearPhaseTimer();
    pendingSchedule = null;
    clearBotThrowTimer();
}

function cloneGameData(gameData) {
    if (gameData == null) return null;
    return JSON.parse(JSON.stringify(gameData));
}

function parseSectorParts(sector) {
    if (sector == null || sector === '') return null;
    const s = String(sector).trim();
    if (/^(miss|none)$/i.test(s)) return { mult: null, value: 'MISS', miss: true };
    if (/^bull$/i.test(s)) return { mult: 'D', value: 'BULL', miss: false };
    if (s === '25') return { mult: 'S', value: 'BULL', miss: false };
    const m = s.match(/^([SsDT])(.*)$/);
    if (m) {
        const raw = m[1];
        const mult = raw === 'T' ? 'T' : raw === 'D' ? 'D' : 'S';
        const value = (m[2] || '').toUpperCase() || '—';
        return { mult, value, miss: false };
    }
    return { mult: null, value: s, miss: false };
}

function describeThrowParts(gameData, fallbackPayload) {
    const lt = gameData && gameData.lastThrow;
    let mult = null;
    let value = null;
    let miss = false;

    if (lt) {
        // Bull recorded with miss:true (e.g. "no game effect") must still announce BULL/25
        if (lt.miss && lt.number === 'bull') {
            miss = false;
            const m = Number(lt.dartMultiplier != null ? lt.dartMultiplier : lt.multiplier) || 1;
            mult = m >= 2 ? 'D' : 'S';
            value = 'BULL';
        } else if (lt.miss) {
            miss = true;
            value = 'MISS';
        } else if (lt.number != null && lt.number !== '') {
            const m = Number(lt.dartMultiplier != null ? lt.dartMultiplier : lt.multiplier) || 1;
            mult = m === 3 ? 'T' : m === 2 ? 'D' : 'S';
            value = lt.number === 'bull' ? 'BULL' : String(lt.number);
        } else if (lt.mult || lt.label) {
            if (lt.mult) mult = String(lt.mult).toUpperCase();
            value = lt.label != null ? String(lt.label) : null;
            if (String(lt.label).toUpperCase() === 'MISS') {
                miss = true;
                mult = null;
                value = 'MISS';
            }
        } else if (lt.sector) {
            const parsed = parseSectorParts(lt.sector);
            if (parsed) {
                mult = parsed.mult;
                value = parsed.value;
                miss = parsed.miss;
            }
        } else if (lt.score != null && Number.isFinite(Number(lt.score)) && !lt.cricket) {
            // Limbo/random throws often only store score — still show S/D/T chip
            // (skip for cricket: points===0 was wrongly shown as the callout label)
            const m = Number(lt.multiplier) || 1;
            mult = m === 3 ? 'T' : m === 2 ? 'D' : 'S';
            value = String(lt.score);
        } else if (lt.points != null && Number.isFinite(Number(lt.points)) && !lt.cricket) {
            value = String(lt.points);
        }
    } else if (fallbackPayload) {
        if (fallbackPayload.miss) {
            miss = true;
            value = 'MISS';
        } else if (fallbackPayload.number != null && fallbackPayload.number !== '') {
            const m = Number(fallbackPayload.multiplier) || 1;
            mult = m === 3 ? 'T' : m === 2 ? 'D' : 'S';
            value = fallbackPayload.number === 'bull' ? 'BULL' : String(fallbackPayload.number);
        } else if (fallbackPayload.sector) {
            const parsed = parseSectorParts(fallbackPayload.sector);
            if (parsed) {
                mult = parsed.mult;
                value = parsed.value;
                miss = parsed.miss;
            }
        }
    }

    if (!value) value = '—';
    const label = miss ? 'MISS' : (mult ? `${mult}${value}` : value);
    return { mult, value, miss, label };
}

function formatThrowLabel(payload) {
    return describeThrowParts(null, payload).label;
}

function clearThrowUndo() {
    lastThrowUndo = null;
}

function clearScoreCorrection() {
    scoreCorrection = null;
}

function isScoreCorrectionActive() {
    return !!(scoreCorrection && scoreCorrection.active);
}

/**
 * OpenDarts POST /api/visits/{visit}/throws/{index}/correct body fields
 * (ring/sector) from a Correct Score payload. Per opendarts/live/server.py's
 * CorrectThrowRequest, this endpoint uses OD's INTERNAL ring vocabulary —
 * bull/outer_bull/single_inner/treble/single_outer/double/outside — NOT the
 * wire vocabulary the live channel's darts[] uses (wire says "miss", this
 * endpoint wants "outside"). `sector` is the bare wedge number as a string,
 * omitted for bull/outer_bull/outside (sectorless rings).
 *
 * The Correct Score UI DOES let an operator pick inner vs outer for a
 * single — `correctRingRow` in public/control.html ("Single only — Inner
 * (s#) vs Outer (S#)"), which `buildDebugSector()` already encodes into
 * `payload.sector` as lowercase `s{n}` (inner) vs uppercase `S{n}` (outer).
 * Read that instead of guessing.
 */
function openDartsCorrectionFields(payload) {
    if (!payload || payload.miss) return { ring: 'outside' };
    const number = payload.number;
    const multiplier = Number(payload.multiplier) || 1;
    if (number === 'bull' || number === 'Bull') {
        return { ring: multiplier >= 2 ? 'bull' : 'outer_bull' };
    }
    const n = Number(number);
    if (!Number.isFinite(n) || n < 1 || n > 20) return { ring: 'outside' };
    if (multiplier === 3) return { ring: 'treble', sector: String(n) };
    if (multiplier === 2) return { ring: 'double', sector: String(n) };
    const isOuter = typeof payload.sector === 'string' && payload.sector.startsWith('S');
    return { ring: isOuter ? 'single_outer' : 'single_inner', sector: String(n) };
}

/** Sync Correct Score Apply to OpenDarts' visit (last dart index only). No-op for other providers. */
function syncOpenDartsThrowCorrect(index, payload) {
    if (currentBoardProvider() !== 'opendarts') return;
    if (!boardDriver || typeof boardDriver.sendCommand !== 'function') return;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx > 2) {
        logDebugEvent('OPENDARTS_CORRECT', `skip — bad index ${index}`);
        return;
    }
    const pub = boardDriver.getPublicState();
    const visit = pub.opendarts && pub.opendarts.visitId;
    if (visit == null) {
        logDebugEvent('OPENDARTS_CORRECT', 'skip — no known OpenDarts visit id yet');
        return;
    }
    const fields = openDartsCorrectionFields(payload);
    const body = { visit, index: idx, source: 'manual', ...fields };
    Promise.resolve(boardDriver.sendCommand('throws/correct', body))
        .then((result) => {
            if (!result || !result.ok) {
                logDebugEvent('OPENDARTS_CORRECT', (result && result.error) || 'throws/correct failed', body);
                return;
            }
            logDebugEvent(
                'OPENDARTS_CORRECT',
                `ok visit=${visit} index=${idx} → ${fields.ring}${fields.sector ? ` ${fields.sector}` : ''}`
            );
            broadcastScolia();
        })
        .catch((err) => {
            logDebugEvent('OPENDARTS_CORRECT', err.message || 'failed', body);
        });
}

/** Actions that should not count as venue activity (in-game wake-lock idle). */
const VENUE_ACTIVITY_SKIP = new Set([
    'LIGHTS_REFRESH',
    'BOARD_CLEAR_LOG',
    'BOARD_SET_LOG_PAUSED'
]);

function touchVenueActivity() {
    if (!gameState) return;
    gameState.lastVenueActivityAt = Date.now();
}

function isVenueWakeLockDesired(now = Date.now()) {
    if (!gameState || gameState.currentScreen !== 'IN_GAME') return false;
    const idleMs = Number(gameState.inGameIdleMs) || venueConfig.inGameIdleMs;
    const last = Number(gameState.lastVenueActivityAt) || 0;
    return (now - last) < idleMs;
}

function getPublicGameState() {
    const pub = {
        ...gameState,
        appVersion: APP_VERSION,
        wakeLockDesired: isVenueWakeLockDesired(),
        canCorrectScore: !!(lastThrowUndo && !isScoreCorrectionActive()),
        scoreCorrection: isScoreCorrectionActive()
            ? {
                active: true,
                wasLabel: scoreCorrection.wasLabel || '—',
                wasDart: scoreCorrection.wasDart || null
            }
            : null,
        bustVideos: listDemolitionBustVideos(),
        winnerVideos: listSharedWinnerVideos()
    };
    if (gameState.selectedGame === 'quick10' || (gameState.gameData && gameState.gameData.gameType === 'quick10')) {
        pub.quick10Leaderboard = topMatches(DATA_DIR, 'quick10', 10);
    }
    return pub;
}

/** Apply any pending overlay chain immediately (no delays / no re-animation waits). */
function flushPendingPhaseActions() {
    clearPhaseTimer();
    let guard = 0;
    while (pendingSchedule && gameState.gameData && guard < 30) {
        guard++;
        const scheduleNow = pendingSchedule;
        pendingSchedule = null;
        const result = applyScheduledAction(gameState.gameData, scheduleNow);
        gameState.gameData = result.gameData;
        maybePersistQuick10(result);
        logEvent('PHASE_ADVANCE', { next: scheduleNow.next, flushed: true });
        if (result.schedule) {
            pendingSchedule = result.schedule;
        }
    }
}

function captureThrowUndo(payload) {
    // Index of this dart in the current visit (0..2) — Correct Score only ever edits the last dart.
    const boardThrowIndex = visitThrowCount(gameState.gameData, gameState.selectedGame);
    lastThrowUndo = {
        preGameData: cloneGameData(gameState.gameData),
        awaitingTakeout: !!boardSync.awaitingTakeout,
        payload: payload ? { ...payload } : null,
        label: formatThrowLabel(payload),
        parts: describeThrowParts(null, payload),
        boardThrowIndex
    };
}

function clearThrowQueue(reason) {
    if (!throwQueue.length) return;
    logDebugEvent('THROW_QUEUE_CLEAR', reason || 'Queue cleared', { dropped: throwQueue.length });
    throwQueue = [];
}

function currentPhaseType() {
    return gameState.gameData && gameState.gameData.phase
        ? gameState.gameData.phase.type
        : null;
}

/** Active board driver id: scolia | autodarts | opendarts | mock */
function currentBoardProvider() {
    if (!boardDriver) return 'scolia';
    const board = typeof boardDriver.getPublicState === 'function' ? boardDriver.getPublicState() : {};
    const raw = String(boardDriver.provider || board.provider || board.mode || 'scolia').toLowerCase();
    if (raw === 'mock' || board.mode === 'mock') return 'mock';
    if (raw === 'autodarts') return 'autodarts';
    if (raw === 'opendarts') return 'opendarts';
    return 'scolia';
}

const MANUAL_THROW_SOURCES = new Set(['debug', 'correct', 'bot']);
const BOARD_THROW_SOURCES = new Set(['scolia', 'autodarts', 'opendarts', 'mock']);

/** Resolve throw provenance for logs / dart records (real provider when from the board). */
function resolveThrowSource(source) {
    if (MANUAL_THROW_SOURCES.has(source)) return source;
    if (BOARD_THROW_SOURCES.has(source)) return source;
    return currentBoardProvider();
}

function throwDebugActionType(source) {
    if (source === 'correct') return 'CORRECT_THROW';
    if (source === 'bot') return 'BOT_THROW';
    if (source === 'debug') return 'DEBUG_THROW';
    return 'BOARD_THROW';
}

function enqueueThrow(payload, source) {
    const phase = currentPhaseType();
    const resolved = resolveThrowSource(source);
    if (phase === 'winner' || phase === 'draw' || phase === 'complete' || phase === 'pick_player' || phase === 'setup' || phase === 'pick_mode') {
        logDebugEvent('THROW_IGNORED', `Match over or waiting (${phase}) — not queued`, {
            source: resolved,
            sector: payload && payload.sector
        });
        return false;
    }
    if (throwQueue.length >= THROW_QUEUE_MAX) {
        logDebugEvent('THROW_QUEUE_FULL', 'Overlay throw queue full — dropping dart', {
            source: resolved,
            queued: throwQueue.length,
            sector: payload && payload.sector
        });
        return false;
    }
    throwQueue.push({
        payload,
        source: resolved
    });
    logDebugEvent('THROW_QUEUED', `Queued throw during ${phase || 'unknown'} (${throwQueue.length}/${THROW_QUEUE_MAX})`, {
        source: resolved,
        sector: payload && payload.sector,
        number: payload && payload.number,
        multiplier: payload && payload.multiplier
    });
    return true;
}

function schedulePhaseAction(schedule) {
    if (!schedule) return;
    clearPhaseTimer();
    pendingSchedule = schedule;
    let delayMs = Number(schedule.delayMs) || 0;
    // Let the bust video finish before advancing when Video toggle is on.
    // Viewer sends BUST_VIDEO_COMPLETE on ended → advancePendingBust; this delay is the safety max.
    if (
        (schedule.next === 'demolition_after_bust' || schedule.next === 'x01_after_bust')
        && gameState.viewerVideoEnabled
    ) {
        delayMs = Math.max(delayMs, DEMOLITION_BUST_VIDEO_OVERLAY_MS);
    }
    // TVM → checkout: skip immediately when TVMRecorder/Video off; otherwise hold until
    // Viewer TVM_COMPLETE or max safety timer.
    if (schedule.next === 'demolition_show_checkout' && currentPhaseType() === 'tvm') {
        if (!tvmRecorderActive()) {
            delayMs = 0;
        } else {
            delayMs = Math.max(delayMs, DEMOLITION_TVM_MAX_MS);
        }
    }
    // Killer became-killer Charon clip (~5s) when Video is on
    if (schedule.delayMsWithVideo != null && gameState.viewerVideoEnabled) {
        delayMs = Math.max(delayMs, Number(schedule.delayMsWithVideo) || 0);
    }
    phaseTimer = setTimeout(() => {
        phaseTimer = null;
        if (!gameState.gameData) {
            pendingSchedule = null;
            return;
        }
        const scheduleNow = pendingSchedule;
        pendingSchedule = null;
        if (!scheduleNow) return;
        const prevPhase = currentPhaseType();
        const result = applyScheduledAction(gameState.gameData, scheduleNow);
        gameState.gameData = result.gameData;
        maybePersistQuick10(result);
        maybeTvmRecorderDumpForTvm(prevPhase, result);
        logEvent('PHASE_ADVANCE', { next: scheduleNow.next });
        broadcastState();
        if (result.schedule) {
            schedulePhaseAction(result.schedule);
        } else {
            // Overlay chain finished — apply any darts that landed during it
            drainThrowQueue();
            nudgeBotAutoThrow('phase chain done');
        }
    }, delayMs);
}

function broadcastState() {
    const payload = JSON.stringify({ type: 'STATE_UPDATE', data: getPublicGameState() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function visitThrowCount(gameData, gameType) {
    if (!gameData) return 0;
    if (gameType === 'demolition') return gameData.dartsThrownThisTurn || 0;
    return gameData.throwsThisTurn || 0;
}

function visitEndedAfterThrow(gameType, gameData) {
    if (!gameData) return false;
    if (visitThrowCount(gameData, gameType) >= 3) return true;
    const phase = gameData.phase && gameData.phase.type;
    return phase === 'intermission'
        || phase === 'bust'
        || phase === 'winner'
        || phase === 'draw'
        || phase === 'complete'
        || phase === 'pick_player'
        || phase === 'setup'
        || phase === 'pick_mode'
        || phase === 'life_loss'
        || phase === 'playoff'
        || phase === 'round_announce';
}

function maybePersistQuick10(result) {
    if (!result || !result.persistQuick10 || !gameState.gameData) return;
    if (gameState.gameData.gameType !== 'quick10') return;
    if (gameState.gameData.persisted || !gameState.gameData.readyToPersist) return;
    const record = buildQuick10MatchRecord(gameState.gameData, uuidv4());
    if (!record) return;
    const saved = appendMatch(DATA_DIR, record);
    if (saved.ok) {
        gameState.gameData.persisted = true;
        gameState.gameData.readyToPersist = false;
        gameState.gameData.savedMatchId = record.id;
        logDebugEvent('QUICK10_PERSIST', `Saved match ${record.id} — ${record.player.name} scored ${record.totalScore}`, {
            integrity: record.integrity
        });
    } else {
        logDebugEvent('QUICK10_PERSIST_FAIL', saved.error || 'Failed to append match');
    }
}

function deriveHeaderStatus(base, awaitingTakeout) {
    if (base.connection === 'unconfigured') {
        return { key: 'unlinked', label: 'Unlinked', tone: 'muted' };
    }
    if (base.connection !== 'open') {
        return { key: 'offline', label: 'Offline', tone: 'bad' };
    }
    if (base.boardStatus === 'Error') {
        return { key: 'error', label: 'Error', tone: 'bad' };
    }
    if (base.boardStatus === 'Initializing' || base.boardStatus === 'Calibrating') {
        return { key: 'warming', label: 'Warming', tone: 'warn' };
    }
    if (awaitingTakeout || base.boardPhase === 'Takeout') {
        return { key: 'takeout', label: 'Takeout', tone: 'warn' };
    }
    if (base.boardStatus === 'Ready' && base.boardPhase === 'Throw') {
        return { key: 'ready', label: 'Ready', tone: 'ok' };
    }
    return {
        key: 'waiting',
        label: base.boardStatus || 'Waiting',
        tone: 'warn'
    };
}

function getEnrichedScoliaState() {
    const base = boardDriver.getPublicState();
    const boardCfg = loadBoardConfig(DATA_DIR);
    const boardReady = base.connection === 'open'
        && base.boardStatus === 'Ready'
        && base.boardPhase === 'Throw';
    const awaitingTakeout = !!boardSync.awaitingTakeout;
    const header = deriveHeaderStatus(base, awaitingTakeout);
    const provider = boardDriver.provider || base.provider || base.mode || boardCfg.provider || 'scolia';
    return {
        ...base,
        provider,
        boardConfig: {
            provider,
            autodarts: boardCfg.autodarts,
            opendarts: boardCfg.opendarts
        },
        awaitingTakeout,
        readyToScore: boardReady && !awaitingTakeout,
        headerStatus: header.key,
        headerLabel: header.label,
        headerTone: header.tone
    };
}

function broadcastScolia() {
    const data = getEnrichedScoliaState();
    // BOARD_UPDATE is preferred; keep SCOLIA_UPDATE for older clients this session
    const boardMsg = JSON.stringify({ type: 'BOARD_UPDATE', data });
    const legacyMsg = JSON.stringify({ type: 'SCOLIA_UPDATE', data });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(boardMsg);
            client.send(legacyMsg);
        }
    });
}

function broadcastLights() {
    if (!dartLights) return;
    const data = dartLights.getPublicState();
    const msg = JSON.stringify({ type: 'LIGHTS_UPDATE', data });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

let dartLights = createTapoLights({
    dataDir: DATA_DIR,
    onUpdate: broadcastLights
});

function currentBoardProviderId() {
    if (!boardDriver) return null;
    const pub = typeof boardDriver.getPublicState === 'function' ? boardDriver.getPublicState() : {};
    return boardDriver.provider || pub.provider || pub.mode || null;
}

function isDetectionLightsProvider() {
    const provider = currentBoardProviderId();
    return provider === 'autodarts' || provider === 'opendarts';
}

function detectionBoardLooksStopped() {
    if (!isDetectionLightsProvider()) return false;
    const pub = boardDriver.getPublicState();
    if (pub.boardStatus === 'Stopped') return true;

    const provider = currentBoardProviderId();
    if (provider === 'autodarts') {
        const ad = pub.autodarts || {};
        const status = String(ad.status || '');
        const event = String(ad.event || '');
        return !ad.running && (/stop/i.test(status) || /stop/i.test(event));
    }
    if (provider === 'opendarts') {
        const od = pub.opendarts || {};
        return !od.running && /stop/i.test(String(od.status || pub.boardStatus || ''));
    }
    return false;
}

/** Actions that should not wake local cams / lights. */
const BOARD_WAKE_SKIP = new Set([
    'LIGHTS_OFF',
    'LIGHTS_REFRESH',
    'BOARD_CLEAR_LOG',
    'BOARD_SET_LOG_PAUSED',
    'TVM_COMPLETE',
    'BUST_VIDEO_COMPLETE',
    // Manual Board Debug commands (start/stop/calibrate/reset/...) already talk straight to the
    // board — the passive "wake a sleeping board" heuristic double-sends (e.g. start firing twice)
    // and can actively fight an explicit stop/calibrate.
    'BOARD_COMMAND'
]);

let boardWakeInFlight = null;

/** If Autodarts/OpenDarts detection is stopped, Start it and turn dart lights on (Scolia: no-op). */
function maybeWakeBoardForUiAction(action) {
    if (!action || BOARD_WAKE_SKIP.has(action)) return null;
    if (!isDetectionLightsProvider()) return null;
    if (!detectionBoardLooksStopped()) return null;
    if (boardWakeInFlight) return boardWakeInFlight;

    const provider = currentBoardProviderId() || 'board';
    boardWakeInFlight = Promise.resolve()
        .then(async () => {
            logDebugEvent('BOARD_WAKE', `UI ${action} — ${provider} was stopped; starting detection + lights`);
            const startResult = await Promise.resolve(boardDriver.sendCommand('start'));
            if (startResult && startResult.ok === false) {
                logDebugEvent('BOARD_WAKE', startResult.error || 'start failed', {
                    status: startResult.status,
                    path: startResult.path
                });
            }
            if (dartLights) {
                const lightResult = await dartLights.turnOn();
                if (!lightResult || !lightResult.ok) {
                    logDebugEvent('BOARD_WAKE', (lightResult && lightResult.error) || 'lights on failed');
                }
            }
            broadcastScolia();
            broadcastLights();
        })
        .catch((err) => {
            logDebugEvent('BOARD_WAKE', err.message || 'failed');
            broadcastScolia();
            broadcastLights();
        })
        .finally(() => {
            boardWakeInFlight = null;
        });

    return boardWakeInFlight;
}

/** Autodarts/OpenDarts: only cut dart lights after Stopped holds (avoids reset/status flaps). */
const LIGHTS_OFF_AFTER_STOPPED_MS = 3000;
let lightsOffAfterStopTimer = null;

function clearLightsOffAfterStopTimer(reason) {
    if (!lightsOffAfterStopTimer) return;
    clearTimeout(lightsOffAfterStopTimer);
    lightsOffAfterStopTimer = null;
    if (reason) {
        logDebugEvent('LIGHTS', `cancel delayed off — ${reason}`);
    }
}

function onAutodartsDetectionStopped(payload) {
    if (!isDetectionLightsProvider()) return;
    const provider = currentBoardProviderId() || 'board';
    const statusLabel = (payload && payload.status) || 'Stopped';
    logDebugEvent(
        'BOARD_DETECTION_STOPPED',
        `${provider} stopped (${statusLabel}) — lights off in ${LIGHTS_OFF_AFTER_STOPPED_MS}ms if still stopped`
    );
    if (!dartLights) return;

    clearLightsOffAfterStopTimer();
    lightsOffAfterStopTimer = setTimeout(() => {
        lightsOffAfterStopTimer = null;
        if (!isDetectionLightsProvider()) return;
        // Timer only survives if BOARD_DETECTION_STARTED never arrived. Don't skip
        // off just because the provider's "looks stopped" heuristic is messy (esp. 3D).
        logDebugEvent('LIGHTS', `${provider} still stopped after ${LIGHTS_OFF_AFTER_STOPPED_MS}ms — lights off`);
        Promise.resolve(dartLights.turnOff())
            .then((result) => {
                if (!result || !result.ok) {
                    logDebugEvent('LIGHTS', (result && result.error) || 'off failed after board stop');
                }
                broadcastLights();
            })
            .catch((err) => {
                logDebugEvent('LIGHTS', err.message || 'off failed after board stop');
                broadcastLights();
            });
    }, LIGHTS_OFF_AFTER_STOPPED_MS);
}

function onAutodartsDetectionStarted(payload) {
    if (!isDetectionLightsProvider()) return;
    const provider = currentBoardProviderId() || 'board';
    clearLightsOffAfterStopTimer('detection active again');
    logDebugEvent(
        'BOARD_DETECTION_STARTED',
        `${provider} active (${(payload && payload.status) || 'Ready'}) — lights on`
    );
    if (!dartLights) return;
    Promise.resolve(dartLights.turnOn())
        .then((result) => {
            if (!result || !result.ok) {
                logDebugEvent('LIGHTS', (result && result.error) || 'on failed after board start');
            }
            broadcastLights();
        })
        .catch((err) => {
            logDebugEvent('LIGHTS', err.message || 'on failed after board start');
            broadcastLights();
        });
}

function setAwaitingTakeout(value) {
    const next = !!value;
    if (boardSync.awaitingTakeout === next) {
        broadcastScolia();
        return;
    }
    boardSync.awaitingTakeout = next;
    broadcastScolia();
}

function scoliaBoardIsPlayable() {
    const s = boardDriver.getPublicState();
    return s.connection === 'open' && s.boardStatus === 'Ready';
}

function prepareBoardForMatch() {
    if (!scoliaBoardIsPlayable()) {
        return { ok: false, error: 'Dartboard not ready. Wait until the board shows Ready.' };
    }
    // Clear any partial visit (mid-takeout or otherwise) on the board before first throw
    boardDriver.sendCommand('RESET_PHASE');
    boardSync.awaitingTakeout = false;
    return { ok: true };
}

function processGameAction(payload, throwSource = null, profileOverride = null) {
    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') return { ok: false, scheduled: false };

    logEvent('GAME_ACTION', payload);
    const result = handleGameAction(gameState.gameData, gameState.selectedGame, payload, {
        throwSource,
        debugThrowProfile: profileOverride || gameState.debugThrowProfile || DEFAULT_THROW_PROFILE
    });
    gameState.gameData = result.gameData;
    maybePersistQuick10(result);
    broadcastState();
    if (result.schedule) {
        schedulePhaseAction(result.schedule);
        return { ok: true, scheduled: true };
    }
    return { ok: true, scheduled: false };
}

function clonePhaseSnapshot(phase) {
    if (!phase || !phase.type) {
        return { type: 'playing', startedAt: Date.now(), data: {} };
    }
    try {
        return JSON.parse(JSON.stringify(phase));
    } catch (_) {
        return { type: phase.type, startedAt: phase.startedAt || Date.now(), data: phase.data || {} };
    }
}

/** Cricket mark-hit callout hold (avatar + hit label + mark draw). Other cricket darts use dartCalloutMs. */
const CRICKET_MARK_CALLOUT_MS = 1500;

/** Insert a short dart_callout before whatever overlay/schedule the throw produced. */
function wrapDartCallout(gameData, result, thrower, payload) {
    if (!gameData || !gameData.lastThrow) return;
    if (gameData.phase && gameData.phase.type === 'dart_callout') return;

    const parts = describeThrowParts(gameData, payload);
    const lt = gameData.lastThrow;
    // Cricket mark progress only → custom callout. Already-closed target (score/dead) → default.
    const marksProgressed = Number(lt && lt.marksAdded) > 0
        || (Number(lt && lt.marksAfter) > Number(lt && lt.marksBefore));
    const cricketMarks = !!(lt && lt.cricket && !lt.miss && marksProgressed);

    // Cricket's mark-hit callout is part of that game's own mechanics (it's
    // drawing the mark, not just announcing a number) — it always shows as a
    // visual, independent of dartCalloutMode. Only the plain "what did you
    // hit" card/sound respects the mode.
    if (cricketMarks) {
        const holdMs = CRICKET_MARK_CALLOUT_MS;
        gameData.dartCalloutResume = {
            phase: clonePhaseSnapshot(gameData.phase),
            schedule: result.schedule || null
        };
        gameData.phase = {
            type: 'dart_callout',
            startedAt: Date.now(),
            data: {
                label: (parts && parts.label) || '—',
                miss: !!(parts && parts.miss),
                playerName: (thrower && thrower.name) || 'PLAYER',
                avatar: (thrower && thrower.avatar) || null,
                cricketMarks: true,
                markBefore: Math.max(0, Math.min(3, Number(lt.marksBefore) || 0)),
                markAfter: Math.max(0, Math.min(3, Number(lt.marksAfter) || 0)),
                animBudgetMs: holdMs
            }
        };
        result.schedule = {
            delayMs: Math.max(100, Math.min(8000, Math.round(holdMs))),
            next: 'end_dart_callout'
        };
        return;
    }

    const mode = gameState.dartCalloutMode || 'card';
    if (mode === 'off') return;

    const wantsSound = mode === 'sound' || mode === 'both';
    const wantsCard = mode === 'card' || mode === 'both';

    if (wantsSound) {
        // Non-blocking: publish what was thrown for the viewer to announce,
        // but never touch phase/schedule — sound must add zero delay to
        // gameplay, unlike the card below which deliberately holds the phase.
        gameData.dartAnnounceSeq = (gameData.dartAnnounceSeq || 0) + 1;
        gameData.dartAnnounce = {
            seq: gameData.dartAnnounceSeq,
            mult: (parts && parts.mult) || null,
            value: (parts && parts.value) || null,
            miss: !!(parts && parts.miss),
            playerName: (thrower && thrower.name) || 'PLAYER'
        };
    }

    if (!wantsCard) return;

    // Card — the original blocking interstitial, held for dartCalloutMs.
    // Runs independently of the sound branch above (mode 'both' does both).
    const rawMs = Number(gameState.dartCalloutMs);
    if (!Number.isFinite(rawMs) || rawMs <= 0) return;
    gameData.dartCalloutResume = {
        phase: clonePhaseSnapshot(gameData.phase),
        schedule: result.schedule || null
    };
    gameData.phase = {
        type: 'dart_callout',
        startedAt: Date.now(),
        data: {
            label: (parts && parts.label) || '—',
            miss: !!(parts && parts.miss),
            playerName: (thrower && thrower.name) || 'PLAYER',
            avatar: (thrower && thrower.avatar) || null
        }
    };
    result.schedule = {
        delayMs: Math.max(100, Math.min(8000, Math.round(rawMs))),
        next: 'end_dart_callout'
    };
}

/** Apply a throw and update takeout sync. Returns whether an overlay was scheduled. */
function applyThrowPayload(payload, source, profileOverride = null) {
    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') return false;

    const beforeThrows = visitThrowCount(gameState.gameData, gameState.selectedGame);
    const prevPhase = currentPhaseType();
    const dartSource = resolveThrowSource(source);
    const actionType = throwDebugActionType(dartSource);

    const thrower = getActiveThrowerEntity(gameState.gameData, gameState.selectedGame);
    captureThrowUndo(payload);

    logEvent('GAME_ACTION', payload);
    const result = handleGameAction(gameState.gameData, gameState.selectedGame, payload, {
        throwSource: dartSource,
        debugThrowProfile: profileOverride || gameState.debugThrowProfile || DEFAULT_THROW_PROFILE
    });
    gameState.gameData = result.gameData;
    maybePersistQuick10(result);
    // Skip TVM when TVMRecorder/Video off, or checkout by a bot (no face cam worth showing)
    if (
        result.schedule
        && result.schedule.next === 'demolition_show_tvm'
        && (!tvmRecorderActive() || (thrower && thrower.isBot) || dartSource === 'bot')
    ) {
        result.schedule.next = 'demolition_show_checkout';
        if (thrower && thrower.isBot) {
            logDebugEvent('TVM', 'skipped — bot checkout');
        }
    }
    maybeTvmRecorderDumpForTvm(prevPhase, result);

    const afterThrows = visitThrowCount(gameState.gameData, gameState.selectedGame);
    if (afterThrows > beforeThrows) {
        wrapDartCallout(gameState.gameData, result, thrower, payload);
    }

    const parts = describeThrowParts(gameState.gameData, payload);
    if (lastThrowUndo) {
        lastThrowUndo.label = parts.label;
        lastThrowUndo.parts = parts;
    }

    logDebugEvent(
        actionType,
        `Applied ${parts.label}`,
        {
            source: dartSource,
            label: parts.label,
            mult: parts.mult,
            value: parts.value,
            miss: parts.miss,
            sector: payload && payload.sector,
            bounceout: payload && payload.bounceout,
            queuedRemaining: throwQueue.length,
            profile: profileOverride || null,
            calloutMs: gameState.dartCalloutMs
        }
    );

    broadcastState();
    if (result.schedule) {
        schedulePhaseAction(result.schedule);
    }

    if (afterThrows > beforeThrows && visitEndedAfterThrow(gameState.selectedGame, gameState.gameData)) {
        setAwaitingTakeout(true);
        clearThrowQueue('Visit complete — discarding leftover queue until takeout');
        logDebugEvent('BOARD_AWAIT_TAKEOUT', 'Visit complete — waiting for takeout before next scoring throw.', {
            source: dartSource
        });
        if (dartSource === 'bot') {
            boardSync.awaitingTakeout = false;
            boardDriver.sendCommand('RESET_PHASE');
            clearThrowQueue('Bot visit complete');
            broadcastScolia();
        }
    }
    return !!result.schedule;
}

function drainThrowQueue() {
    if (drainingThrowQueue) return;
    drainingThrowQueue = true;
    try {
        while (throwQueue.length > 0) {
            if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') {
                clearThrowQueue('Left match mid-drain');
                break;
            }
            if (boardSync.awaitingTakeout) {
                clearThrowQueue('Awaiting takeout — not draining');
                break;
            }

            const phase = currentPhaseType();
            if (phase === 'winner' || phase === 'draw' || phase === 'complete' || phase === 'pick_player' || phase === 'setup' || phase === 'pick_mode') {
                clearThrowQueue(`Match over or waiting (${phase})`);
                break;
            }
            if (phase !== 'playing') break;

            const item = throwQueue.shift();
            const payload = item && item.payload !== undefined ? item.payload : item;
            const source = resolveThrowSource(item && item.source);
            const scheduled = applyThrowPayload(payload, source);
            // Overlay started — pause drain until schedulePhaseAction finishes the chain
            if (scheduled) break;
        }
    } finally {
        drainingThrowQueue = false;
    }
}

/**
 * Accept a scoring throw now, or queue it if an overlay is up.
 * Keeps FlightDeck visit counts aligned with physical board throws.
 */
function acceptScoringThrow(payload, source, profileOverride = null) {
    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') return;

    const resolved = resolveThrowSource(source);

    if (isScoreCorrectionActive() && resolved !== 'correct') {
        logDebugEvent('THROW_IGNORED', 'Blocked — Correct Score in progress', { source: resolved });
        return;
    }

    const phase = currentPhaseType();
    if (phase === 'complete' || phase === 'pick_player' || phase === 'setup' || phase === 'pick_mode' || phase === 'winner' || phase === 'draw') {
        logDebugEvent('THROW_IGNORED', `Blocked — phase ${phase}`, { source: resolved });
        return;
    }
    if (phase && phase !== 'playing') {
        touchVenueActivity();
        enqueueThrow(payload, resolved);
        return;
    }

    touchVenueActivity();
    const scheduled = applyThrowPayload(payload, resolved, profileOverride);
    if (!scheduled) {
        drainThrowQueue();
    }
    if (resolved !== 'bot') {
        nudgeBotAutoThrow('after human/debug throw');
    }
}

function clearBotThrowTimer() {
    if (botThrowTimer) {
        clearTimeout(botThrowTimer);
        botThrowTimer = null;
    }
}

/** If the active thrower is a bot and the board is playable, schedule a profiled dart. */
function nudgeBotAutoThrow(reason) {
    clearBotThrowTimer();
    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') return;
    if (isScoreCorrectionActive()) return;

    const phase = currentPhaseType();
    if (phase !== 'playing') return;

    const thrower = getActiveThrowerEntity(gameState.gameData, gameState.selectedGame);
    if (!thrower || !thrower.isBot) return;

    // Human left takeout pending — bots can't pull darts, so clear for the bot's turn.
    if (boardSync.awaitingTakeout) {
        boardSync.awaitingTakeout = false;
        boardDriver.sendCommand('RESET_PHASE');
        clearThrowQueue('Bot turn — cleared takeout wait');
        broadcastScolia();
    }

    if (visitThrowCount(gameState.gameData, gameState.selectedGame) >= 3) return;

    botThrowTimer = setTimeout(() => {
        botThrowTimer = null;
        runBotThrowTick(reason);
    }, BOT_DART_DELAY_MS);
}

function runBotThrowTick(reason) {
    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') return;
    if (isScoreCorrectionActive()) return;
    if (currentPhaseType() !== 'playing') {
        nudgeBotAutoThrow('bot wait for playing');
        return;
    }

    const thrower = getActiveThrowerEntity(gameState.gameData, gameState.selectedGame);
    if (!thrower || !thrower.isBot) return;
    if (visitThrowCount(gameState.gameData, gameState.selectedGame) >= 3) return;

    if (boardSync.awaitingTakeout) {
        boardSync.awaitingTakeout = false;
        boardDriver.sendCommand('RESET_PHASE');
        broadcastScolia();
    }

    const profile = normalizeThrowProfileId(thrower.botProfile || DEFAULT_THROW_PROFILE);
    logDebugEvent('BOT_THROW_TICK', `Bot dart (${thrower.name}) [${profile}]`, { reason: reason || null });
    acceptScoringThrow({ type: 'TRIGGER_THROW' }, 'bot', profile);
    nudgeBotAutoThrow('bot after dart');
}

function handleScoliaGameplayEvent(type, payload) {
    if (type === 'BOARD_DETECTION_STOPPED') {
        onAutodartsDetectionStopped(payload);
        return;
    }

    if (type === 'BOARD_DETECTION_STARTED') {
        onAutodartsDetectionStarted(payload);
        return;
    }

    if (type === 'TAKEOUT_FINISHED') {
        if (payload && payload.falseTakeout) {
            logDebugEvent('BOARD_FALSE_TAKEOUT', 'Takeout finished but darts still in board — still waiting.', {
                source: currentBoardProvider()
            });
            setAwaitingTakeout(true);
            return;
        }
        if (boardSync.awaitingTakeout) {
            logDebugEvent('BOARD_TAKEOUT_CLEAR', 'Takeout finished — ready for next throw.', {
                source: currentBoardProvider()
            });
        }
        setAwaitingTakeout(false);
        nudgeBotAutoThrow('takeout finished');
        return;
    }

    if (type === 'TAKEOUT_STARTED') {
        // Physical pull in progress; keep header amber once visit ended
        broadcastScolia();
        return;
    }

    if (type === 'THROW_CORRECTED') {
        // OpenDarts reporting a dart's score changed after the fact (from
        // OD's own dashboard, or echoing FlightDeck's own Correct Score
        // write). Visibility only — this does NOT rewrite an already-
        // advanced match score; see opendartsDriver.js's header for why.
        logDebugEvent('OPENDARTS_THROW_CORRECTED', `Dart corrected: ${formatThrowLabel(payload && payload.mapped)}`, {
            visit: payload && payload.visit,
            index: payload && payload.index,
            source: currentBoardProvider()
        });
        return;
    }

    // Autodarts driver emits already-mapped THROW; Scolia emits THROW_DETECTED (raw)
    const isMappedThrow = type === 'THROW';
    const isRawThrow = type === 'THROW_DETECTED';
    if (!isMappedThrow && !isRawThrow) return;

    if (gameState.currentScreen !== 'IN_GAME' || !gameState.gameData) {
        return;
    }

    if (boardSync.awaitingTakeout) {
        logDebugEvent('BOARD_THROW_IGNORED', 'Throw while awaiting takeout', {
            sector: payload && payload.sector,
            source: currentBoardProvider()
        });
        return;
    }

    const board = boardDriver.getPublicState();
    if (board.boardStatus !== 'Ready') {
        logDebugEvent('BOARD_THROW_IGNORED', 'Board not Ready', { status: board.boardStatus, source: currentBoardProvider() });
        return;
    }

    const provider = currentBoardProvider();
    const mapped = isMappedThrow ? payload : mapScoliaThrow(payload);
    acceptScoringThrow(mapped, provider);
}

let boardDriver = createBoardDriver({
    dataDir: DATA_DIR,
    onUpdate: broadcastScolia,
    onEvent: handleScoliaGameplayEvent
});
boardDriverReady = true;

/** Push venue.boardStandbyMinutes to whichever driver supports it (Autodarts,
 *  OpenDarts) — no-op for Scolia/mock/opendarts3d, which don't implement it. */
function applyBoardStandbyFromVenue() {
    if (!boardDriverReady || !boardDriver) return;
    if (typeof boardDriver.setStandbyMinutes !== 'function') {
        logDebugEvent('BOARD_STANDBY', 'skip — board provider has no setStandbyMinutes');
        return;
    }
    const mins = venueConfig.boardStandbyMinutes;
    logDebugEvent('BOARD_STANDBY', `applying venue standby ${mins}m → ${boardDriver.provider || 'board'}`);
    Promise.resolve(boardDriver.setStandbyMinutes(mins))
        .then((result) => {
            if (!result || !result.ok) {
                logDebugEvent(
                    'BOARD_STANDBY',
                    (result && result.error) || `failed to set standby ${mins}m`
                );
                return;
            }
            if (result.already) {
                logDebugEvent('BOARD_STANDBY', `already ${mins}m`);
            } else {
                logDebugEvent('BOARD_STANDBY', `set camera standby to ${mins}m`);
            }
            broadcastScolia();
        })
        .catch((err) => {
            logDebugEvent('BOARD_STANDBY', err.message || 'failed');
        });
}

function replaceBoardDriver(configOverride) {
    try {
        boardDriverReady = false;
        if (boardDriver && typeof boardDriver.stop === 'function') boardDriver.stop();
    } catch (err) {
        console.warn('[BOARD] stop previous driver:', err.message);
    }
    boardDriver = createBoardDriver({
        dataDir: DATA_DIR,
        onUpdate: broadcastScolia,
        onEvent: handleScoliaGameplayEvent,
        configOverride
    });
    boardDriverReady = true;
    boardDriver.start();
    broadcastScolia();
    applyBoardStandbyFromVenue();
    return boardDriver;
}

/** Debug: finish the current visit with random darts via the normal throw path (overlays keep their timers). */
function debugNextPlayer() {
    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') {
        return { ok: false, reason: 'not in game' };
    }
    if (isScoreCorrectionActive()) {
        return { ok: false, reason: 'correct score active' };
    }

    let phase = currentPhaseType();
    if (phase === 'winner' || phase === 'draw') {
        return { ok: false, reason: 'match over' };
    }

    const already = visitThrowCount(gameState.gameData, gameState.selectedGame);
    const need = Math.max(0, Math.min(3, 3 - already));
    let thrown = 0;
    for (let i = 0; i < need; i++) {
        phase = currentPhaseType();
        if (phase === 'winner' || phase === 'draw') break;
        // Same path as Scolia/debug darts: apply on playing, queue during overlays.
        acceptScoringThrow({ type: 'TRIGGER_THROW' }, 'debug');
        thrown++;
    }

    // Board sync convenience only — do not flush overlay schedules or force playing.
    boardDriver.sendCommand('RESET_PHASE');
    boardSync.awaitingTakeout = false;

    logDebugEvent('DEBUG_NEXT_PLAYER', `Visit throw(s) via normal path (${thrown} random dart(s))`, {
        thrown,
        queued: throwQueue.length,
        phase: currentPhaseType(),
        activeIdx: gameState.gameData && gameState.gameData.activeIdx,
        throwsThisTurn: visitThrowCount(gameState.gameData, gameState.selectedGame)
    });
    broadcastState();
    broadcastScolia();
    nudgeBotAutoThrow('debug next player');
    return { ok: true, thrown };
}

/** Raw TCP reachability check for Configure's board "Test" button — doesn't know or
 *  care about any provider's actual protocol, just whether host:port accepts a connection. */
function testTcpConnection(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        if (!host || !Number.isFinite(port) || port <= 0) {
            resolve({ ok: false, error: 'Missing host/port' });
            return;
        }
        const socket = new net.Socket();
        let done = false;
        const finish = (ok, error) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch (_) {}
            resolve({ ok, error: error || null });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, 'Timed out'));
        socket.once('error', (err) => finish(false, err.message));
        socket.connect(port, host);
    });
}

wss.on('connection', (ws) => {
    logDebugEvent('SOCKET_CONNECT', 'A control or viewer terminal linked up.');
    ws.send(JSON.stringify({ type: 'STATE_UPDATE', data: getPublicGameState() }));
    ws.send(JSON.stringify({ type: 'BOARD_UPDATE', data: getEnrichedScoliaState() }));
    ws.send(JSON.stringify({ type: 'SCOLIA_UPDATE', data: getEnrichedScoliaState() }));
    if (dartLights) {
        ws.send(JSON.stringify({ type: 'LIGHTS_UPDATE', data: dartLights.getPublicState() }));
    }

    ws.on('message', (message) => {
        try {
            const request = JSON.parse(message);

            // Autodarts camera standby: any meaningful Control action wakes detection + lights
            if (request && request.action) {
                maybeWakeBoardForUiAction(request.action);
                if (!VENUE_ACTIVITY_SKIP.has(request.action)) {
                    touchVenueActivity();
                }
            }

            // Viewer may send { type: 'TVM_COMPLETE' | 'BUST_VIDEO_COMPLETE' }; Control uses { action }
            const wsAction = request.action
                || (request.type === 'TVM_COMPLETE' ? 'TVM_COMPLETE' : null)
                || (request.type === 'BUST_VIDEO_COMPLETE' ? 'BUST_VIDEO_COMPLETE' : null);

            switch (wsAction) {
                case 'ADD_PLAYER': {
                    const rawName = typeof request.name === 'string' ? request.name.trim() : '';
                    if (!rawName) {
                        gameState.registrationError = 'Enter a player name.';
                        broadcastState();
                        break;
                    }
                    if (playerNameTaken(gameState.players, rawName)) {
                        gameState.registrationError = `“${rawName}” is already on the roster (names must be unique).`;
                        logDebugEvent('ADD_PLAYER_BLOCKED', gameState.registrationError);
                        broadcastState();
                        break;
                    }
                    const botMeta = parseBotFromName(rawName);
                    const newPlayer = {
                        id: uuidv4(),
                        name: rawName,
                        avatar: request.avatar,
                        ...(botMeta.isBot ? { isBot: true, botProfile: botMeta.botProfile } : {})
                    };
                    gameState.registrationError = null;
                    gameState.players.push(newPlayer);
                    ensureWaitingOrder();
                    // New registrations sit on the waiting bench until dragged into the lineup
                    if (gameState.lineupMode === 'doubles') {
                        syncPlayersFromDoublesTeams();
                    }
                    savePersistedPlayers(gameState.players);
                    logEvent('ADD_PLAYER', { playerId: newPlayer.id, name: newPlayer.name });
                    logDebugEvent('ADD_PLAYER', `Added Player "${newPlayer.name}" (waiting bench).`);
                    broadcastState();
                    break;
                }

                case 'REMOVE_PLAYER': {
                    const index = gameState.players.findIndex(p => p.id === request.id);
                    if (index !== -1) {
                        logEvent('REMOVE_PLAYER', { playerId: request.id });
                        gameState.players.splice(index, 1);
                        clearPlayerFromDoublesTeams(request.id);
                        clearPlayerFromSinglesLineup(request.id);
                        ensureWaitingOrder();
                        if (gameState.lineupMode === 'doubles') {
                            syncPlayersFromDoublesTeams();
                        }
                        savePersistedPlayers(gameState.players);
                        if (cricketRosterCount() <= Math.max(CRICKET_MAX_PLAYERS, X01_MAX_PLAYERS)) {
                            gameState.selectionError = null;
                        }
                        broadcastState();
                    }
                    break;
                }

                case 'REORDER_WAITING': {
                    const playerId = request.playerId;
                    const beforePlayerId = request.beforePlayerId || null;
                    if (reorderWaitingPlayer(playerId, beforePlayerId)) {
                        logEvent('REORDER_WAITING', { playerId, beforePlayerId });
                        logDebugEvent('REORDER_WAITING', `Waiting reorder ${playerId} before ${beforePlayerId || 'END'}.`);
                        broadcastState();
                    }
                    break;
                }

                case 'CLEAR_LINEUP': {
                    clearLineupToBench();
                    resetLineupToSingles();
                    if (cricketRosterCount() <= Math.max(CRICKET_MAX_PLAYERS, X01_MAX_PLAYERS)) {
                        gameState.selectionError = null;
                    }
                    logEvent('CLEAR_LINEUP', { mode: gameState.lineupMode });
                    logDebugEvent('CLEAR_LINEUP', 'Cleared seated lineup — players moved to waiting bench (singles mode).');
                    broadcastState();
                    break;
                }

                case 'FILL_LINEUP': {
                    const seated = fillLineupFromBench();
                    savePersistedPlayers(gameState.players);
                    logEvent('FILL_LINEUP', { mode: gameState.lineupMode, seated });
                    logDebugEvent('FILL_LINEUP', `Seated ${seated} player(s) from waiting bench (${gameState.lineupMode}).`);
                    broadcastState();
                    break;
                }

                case 'RANDOMIZE_LINEUP': {
                    const count = randomizeSeatedLineup();
                    logEvent('RANDOMIZE_LINEUP', { mode: gameState.lineupMode, count });
                    logDebugEvent('RANDOMIZE_LINEUP', `Shuffled ${count} seated player(s) (${gameState.lineupMode}).`);
                    broadcastState();
                    break;
                }

                // Lineup doubles mode toggle (revert: remove this case)
                case 'SET_LINEUP_MODE': {
                    const mode = request.mode === 'doubles' ? 'doubles' : 'singles';
                    if (mode === gameState.lineupMode) {
                        broadcastState();
                        break;
                    }
                    if (mode === 'doubles') {
                        // Seed teams from currently seated singles only; bench stays on bench
                        const seated = getSeatedPlayers();
                        gameState.doublesTeams = seedDoublesTeamsFromPlayers(seated);
                        gameState.singlesLineup = emptySinglesLineup();
                        syncPlayersFromDoublesTeams();
                    } else {
                        // First SINGLES_MAX from doubles seats → singles lineup; extras → bench
                        const seated = getSeatedPlayers();
                        gameState.singlesLineup = seedSinglesLineupFromPlayers(seated, SINGLES_MAX_PLAYERS);
                        syncPlayersFromDoublesTeams();
                    }
                    gameState.lineupMode = mode;
                    savePersistedPlayers(gameState.players);
                    logEvent('SET_LINEUP_MODE', { mode });
                    logDebugEvent('SET_LINEUP_MODE', `Lineup mode set to ${mode}.`);
                    broadcastState();
                    break;
                }

                // Drag-and-drop rearrange within doubles / bench (revert: remove this case)
                case 'MOVE_DOUBLES_PLAYER': {
                    if (gameState.lineupMode !== 'doubles') break;
                    const fromTeam = Number(request.fromTeam);
                    const fromSlot = Number(request.fromSlot);
                    const toTeam = Number(request.toTeam);
                    const toSlot = Number(request.toSlot);
                    if (moveDoublesPlayer(fromTeam, fromSlot, toTeam, toSlot, request.playerId)) {
                        syncPlayersFromDoublesTeams();
                        savePersistedPlayers(gameState.players);
                        logEvent('MOVE_DOUBLES_PLAYER', { fromTeam, fromSlot, toTeam, toSlot, playerId: request.playerId || null });
                        logDebugEvent('MOVE_DOUBLES_PLAYER', `Moved doubles ${fromTeam}:${fromSlot} → ${toTeam}:${toSlot}.`);
                        broadcastState();
                    }
                    break;
                }

                // Drag-and-drop rearrange within singles / bench (revert: remove this case)
                case 'MOVE_SINGLES_PLAYER': {
                    if (gameState.lineupMode !== 'singles') break;
                    const fromSlot = Number(request.fromSlot);
                    const toSlot = Number(request.toSlot);
                    if (moveSinglesPlayer(fromSlot, toSlot, request.playerId)) {
                        logEvent('MOVE_SINGLES_PLAYER', { fromSlot, toSlot, playerId: request.playerId || null });
                        logDebugEvent('MOVE_SINGLES_PLAYER', `Moved singles ${fromSlot} → ${toSlot}.`);
                        broadcastState();
                        break;
                    }
                    // Full singles (6) + drag from bench onto an empty slot → doubles with that 7th player
                    const lineup = gameState.singlesLineup || [];
                    const seatingSeventh = (
                        fromSlot === LINEUP_BENCH
                        && toSlot >= 0
                        && toSlot < lineup.length
                        && !lineup[toSlot]
                        && request.playerId
                        && playersByIdMap(gameState.players).has(request.playerId)
                        && getSinglesSeatedIds().length >= SINGLES_MAX_PLAYERS
                    );
                    if (seatingSeventh) {
                        const seated = getSeatedPlayers();
                        gameState.lineupMode = 'doubles';
                        gameState.doublesTeams = seedDoublesTeamsFromPlayers(seated);
                        gameState.singlesLineup = emptySinglesLineup();
                        placePlayerInFirstOpenDoublesSlot(request.playerId);
                        syncPlayersFromDoublesTeams();
                        savePersistedPlayers(gameState.players);
                        logEvent('SET_LINEUP_MODE', { mode: 'doubles', reason: 'seventh_player' });
                        logEvent('MOVE_SINGLES_PLAYER', {
                            fromSlot,
                            toSlot,
                            playerId: request.playerId,
                            promotedToDoubles: true
                        });
                        logDebugEvent(
                            'SET_LINEUP_MODE',
                            `Auto doubles: 7th player "${playersByIdMap(gameState.players).get(request.playerId)?.name || request.playerId}" seated.`
                        );
                        broadcastState();
                    }
                    break;
                }

                case 'NAVIGATE': {
                    const leftGame = gameState.currentScreen === 'IN_GAME'
                        && (request.screen === 'GAME_SELECTION' || request.screen === 'REGISTRATION');
                    gameState.currentScreen = request.screen;
                    if (request.screen === 'GAME_SELECTION' || request.screen === 'REGISTRATION') {
                        cancelPhaseChain();
                        clearThrowQueue('Left in-game');
                        clearThrowUndo();
                        clearScoreCorrection();
                        gameState.gameData = null;
                        boardSync.awaitingTakeout = false;
                    }
                    if (leftGame) tvmRecorderBufferStop('navigate');
                    logEvent('NAVIGATE', { screen: request.screen });
                    logDebugEvent('NAVIGATE', `App shifted view to: ${gameState.currentScreen}`);
                    broadcastState();
                    broadcastScolia();
                    break;
                }

                case 'SET_VIEWER_VIDEO': {
                    const enabled = !!request.enabled;
                    const saved = saveVenueConfig(DATA_DIR, { viewerVideoEnabled: enabled });
                    if (!saved.ok) {
                        logDebugEvent('SET_VIEWER_VIDEO', saved.error || 'failed to persist');
                        break;
                    }
                    reloadVenueConfigFromDisk('viewer video toggle');
                    logEvent('SET_VIEWER_VIDEO', { enabled: gameState.viewerVideoEnabled });
                    logDebugEvent('SET_VIEWER_VIDEO', `Viewer event videos: ${gameState.viewerVideoEnabled ? 'ON' : 'OFF'}`);
                    break;
                }

                /** Configure modal (Registration screen) — merges a venue.json patch and reloads. */
                case 'SAVE_VENUE_CONFIG': {
                    const saved = saveVenueConfig(DATA_DIR, request.patch || {});
                    if (!saved.ok) {
                        logDebugEvent('SAVE_VENUE_CONFIG', saved.error || 'failed', request.patch);
                        break;
                    }
                    reloadVenueConfigFromDisk('Configure modal save');
                    logDebugEvent('SAVE_VENUE_CONFIG', 'Venue settings updated from Control.');
                    break;
                }

                case 'TVM_COMPLETE': {
                    // Viewer finished the face clip — classic checkout next
                    if (advanceTvmToCheckout('viewer video ended')) break;
                    break;
                }

                case 'BUST_VIDEO_COMPLETE': {
                    // Viewer finished Demolition/X01 bust clip — leave bust overlay
                    if (advancePendingBust('viewer bust video ended')) break;
                    break;
                }

                case 'PREVIEW_GAME':
                    if (!ALL_GAMES.includes(request.gameType)) break;
                    gameState.selectedGame = request.gameType;
                    {
                        const cap = fourPlayerCapFor(request.gameType);
                        if (cap == null || cricketRosterCount() <= cap) {
                            gameState.selectionError = null;
                        }
                    }
                    logEvent('PREVIEW_GAME', { gameType: request.gameType });
                    logDebugEvent('PREVIEW_GAME', `User hovering/previewing game selection: ${gameState.selectedGame}`);
                    broadcastState();
                    break;

                case 'SELECT_GAME': {
                    // isGameEnabled() fails OPEN for a key it's never heard of (forward-
                    // compat with games added after a venue.json was last saved) — so a
                    // gameType removed from ALL_GAMES entirely (not just disabled) needs
                    // its own explicit check, or it'd still dispatch into fully-intact
                    // engine logic despite having no picker card or view file anymore.
                    if (!ALL_GAMES.includes(request.gameType) || !isGameEnabled(venueConfig, request.gameType)) {
                        gameState.selectionError = 'That game is disabled for this venue.';
                        logDebugEvent('SELECT_GAME_BLOCKED', gameState.selectionError);
                        broadcastState();
                        break;
                    }
                    const matchPlayers = getSeatedPlayers();
                    if (!matchPlayers.length) {
                        gameState.selectionError = 'Drag at least one player into the lineup to start.';
                        logDebugEvent('SELECT_GAME_BLOCKED', gameState.selectionError);
                        broadcastState();
                        break;
                    }

                    {
                        const competitors = cricketRosterCount();
                        if (!gameAllowsSoloStart(request.gameType) && competitors < 2) {
                            const unit = gameState.lineupMode === 'doubles' ? 'teams' : 'players';
                            gameState.selectionError = `Need at least 2 ${unit} in the lineup to start.`;
                            logDebugEvent('SELECT_GAME_BLOCKED', gameState.selectionError);
                            broadcastState();
                            break;
                        }
                    }

                    {
                        const cap = fourPlayerCapFor(request.gameType);
                        if (cap != null && cricketRosterCount() > cap) {
                            const count = cricketRosterCount();
                            gameState.selectionError = `${fourPlayerGameLabel(request.gameType)} is limited to ${cap} ${gameState.lineupMode === 'doubles' ? 'teams' : 'players'}. Remove ${count - cap} to start.`;
                            logDebugEvent('SELECT_GAME_BLOCKED', gameState.selectionError);
                            broadcastState();
                            break;
                        }
                    }

                    if (request.gameType === 'quick10' && gameState.lineupMode === 'doubles') {
                        gameState.selectionError = 'Quick 10 is singles only. Switch to Singles lineup to start.';
                        logDebugEvent('SELECT_GAME_BLOCKED', gameState.selectionError);
                        broadcastState();
                        break;
                    }


                    const boardPrep = prepareBoardForMatch();
                    if (!boardPrep.ok) {
                        gameState.selectionError = boardPrep.error;
                        logDebugEvent('SELECT_GAME_BLOCKED', boardPrep.error);
                        broadcastState();
                        broadcastScolia();
                        break;
                    }

                    gameState.selectionError = null;
                    gameState.viewerCue = null;
                    gameState.selectedGame = request.gameType;
                    gameState.currentScreen = 'IN_GAME';
                    // Match uses seated lineup only; full roster (incl. bench) stays in gameState.players
                    if (gameState.lineupMode === 'doubles') {
                        syncPlayersFromDoublesTeams();
                    }
                    gameState.gameData = initGameData(request.gameType, matchPlayers, {
                        lineupMode: gameState.lineupMode,
                        doublesTeams: gameState.doublesTeams
                    });
                    cancelPhaseChain();
                    clearThrowQueue('New match');
                    clearThrowUndo();
                    clearScoreCorrection();
                    boardSync.awaitingTakeout = false;
                    logEvent('SELECT_GAME', { gameType: request.gameType, matchId: gameState.matchId });
                    logDebugEvent('SELECT_GAME', `Match initiated: ${gameState.selectedGame}`);
                    broadcastState();
                    broadcastScolia();
                    tvmRecorderBufferStart('select game');
                    schedulePhaseAction(initialMatchSchedule(gameState.gameData));
                    nudgeBotAutoThrow('select game');
                    break;
                }

                case 'RESET_MATCH':
                    cancelPhaseChain();
                    clearThrowQueue('Match reset');
                    clearThrowUndo();
                    clearScoreCorrection();
                    tvmRecorderBufferStop('reset match');
                    savePersistedPlayers([]);
                    gameState = createFreshState([]);
                    boardSync.awaitingTakeout = false;
                    logEvent('RESET_MATCH', {});
                    logDebugEvent('RESET_MATCH', 'Full reset — roster and match cleared.');
                    broadcastState();
                    broadcastScolia();
                    break;

                case 'FORWARD_GAME_ACTION': {
                    const payload = request.payload;
                    const isThrow = payload && (payload.type === 'TRIGGER_THROW' || payload.type === 'TRIGGER_SPECIFIC_THROW');
                    if (isThrow && isScoreCorrectionActive()) {
                        logDebugEvent('THROW_IGNORED', 'Debug throw blocked — Correct Score in progress.');
                        break;
                    }
                    if (isThrow && boardSync.awaitingTakeout) {
                        logDebugEvent('THROW_IGNORED', 'Debug throw blocked — awaiting takeout. Use Reset Phase if stuck.');
                        break;
                    }
                    if (isThrow && gameState.gameData) {
                        acceptScoringThrow(payload, 'debug');
                    } else {
                        processGameAction(payload);
                        nudgeBotAutoThrow('forward game action');
                    }
                    break;
                }

                case 'CORRECT_SCORE_BEGIN': {
                    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') break;
                    if (isScoreCorrectionActive()) {
                        logDebugEvent('CORRECT_SCORE', 'Already correcting — ignored.');
                        break;
                    }
                    if (!lastThrowUndo || !lastThrowUndo.preGameData) {
                        logDebugEvent('CORRECT_SCORE', 'No last dart to correct.');
                        break;
                    }
                    flushPendingPhaseActions();
                    clearThrowQueue('Correct Score begin');
                    scoreCorrection = {
                        active: true,
                        wasLabel: lastThrowUndo.label || '—',
                        wasDart: lastThrowUndo.parts || describeThrowParts(null, lastThrowUndo.payload),
                        asLeftGameData: cloneGameData(gameState.gameData),
                        asLeftAwaitingTakeout: !!boardSync.awaitingTakeout,
                        preGameData: cloneGameData(lastThrowUndo.preGameData),
                        preAwaitingTakeout: !!lastThrowUndo.awaitingTakeout,
                        boardThrowIndex: Number.isInteger(lastThrowUndo.boardThrowIndex)
                            ? lastThrowUndo.boardThrowIndex
                            : visitThrowCount(lastThrowUndo.preGameData, gameState.selectedGame)
                    };
                    gameState.gameData = cloneGameData(scoreCorrection.preGameData);
                    boardSync.awaitingTakeout = scoreCorrection.preAwaitingTakeout;
                    logEvent('CORRECT_SCORE_BEGIN', { wasLabel: scoreCorrection.wasLabel });
                    logDebugEvent('CORRECT_SCORE_BEGIN', `Rolled back last dart (${scoreCorrection.wasLabel}).`);
                    broadcastState();
                    broadcastScolia();
                    break;
                }

                case 'CORRECT_SCORE_CANCEL': {
                    if (!isScoreCorrectionActive()) break;
                    cancelPhaseChain();
                    clearThrowQueue('Correct Score cancel');
                    gameState.gameData = cloneGameData(scoreCorrection.asLeftGameData);
                    boardSync.awaitingTakeout = scoreCorrection.asLeftAwaitingTakeout;
                    clearScoreCorrection();
                    logEvent('CORRECT_SCORE_CANCEL', {});
                    logDebugEvent('CORRECT_SCORE_CANCEL', 'Restored pre-correct state (no replay).');
                    broadcastState();
                    broadcastScolia();
                    break;
                }

                case 'CORRECT_SCORE_APPLY': {
                    if (!isScoreCorrectionActive()) break;
                    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') break;
                    const payload = request.payload;
                    if (!payload || (payload.type !== 'TRIGGER_SPECIFIC_THROW' && payload.type !== 'TRIGGER_THROW')) {
                        logDebugEvent('CORRECT_SCORE_APPLY', 'Missing throw payload.');
                        break;
                    }
                    const boardThrowIndex = scoreCorrection.boardThrowIndex;
                    // Already on pre-throw state from BEGIN. Leave correction mode, then score normally.
                    clearScoreCorrection();
                    cancelPhaseChain();
                    clearThrowQueue('Correct Score apply');
                    logEvent('CORRECT_SCORE_APPLY', {
                        miss: !!(payload && payload.miss),
                        number: payload && payload.number,
                        multiplier: payload && payload.multiplier,
                        boardThrowIndex
                    });
                    logDebugEvent('CORRECT_SCORE_APPLY', `Applying corrected dart: ${formatThrowLabel(payload)}`);
                    // Keep OpenDarts visit in sync (same last-dart index); game remains source of truth.
                    syncOpenDartsThrowCorrect(boardThrowIndex, payload);
                    broadcastState(); // exit correction UI before throw overlays
                    acceptScoringThrow(payload, 'correct');
                    broadcastScolia();
                    break;
                }

                case 'DEBUG_NEXT_PLAYER': {
                    const result = debugNextPlayer();
                    if (!result.ok) {
                        logDebugEvent('DEBUG_NEXT_PLAYER', `Ignored — ${result.reason}`);
                    }
                    break;
                }

                case 'DEBUG_SET_THROW_PROFILE': {
                    const next = normalizeThrowProfileId(request.profile);
                    gameState.debugThrowProfile = next;
                    logDebugEvent('DEBUG_SET_THROW_PROFILE', `Throw profile: ${next}`);
                    broadcastState();
                    break;
                }

                /** Debug "Say" — forces a dart-callout announce for sound testing,
                 *  independent of dartCalloutMode (even 'off'/'card') and without
                 *  touching phase/schedule/scoring, same as a real 'sound' announce. */
                case 'DEBUG_TEST_ANNOUNCE': {
                    if (!gameState.gameData) {
                        logDebugEvent('DEBUG_TEST_ANNOUNCE', 'Ignored — no active match');
                        break;
                    }
                    const parts = describeThrowParts(null, request.payload || {});
                    gameState.gameData.dartAnnounceSeq = (gameState.gameData.dartAnnounceSeq || 0) + 1;
                    gameState.gameData.dartAnnounce = {
                        seq: gameState.gameData.dartAnnounceSeq,
                        mult: parts.mult || null,
                        value: parts.value || null,
                        miss: !!parts.miss,
                        playerName: 'DEBUG'
                    };
                    logDebugEvent('DEBUG_TEST_ANNOUNCE', `Forced announce: ${parts.label}`);
                    broadcastState();
                    break;
                }

                case 'DEBUG_SHOW_SCREEN': {
                    if (!gameState.gameData || gameState.currentScreen !== 'IN_GAME') break;
                    const screen = request.screen || 'clear';
                    const phase = buildDebugPreviewPhase(gameState.selectedGame, gameState.gameData, screen);
                    if (!phase) {
                        logDebugEvent('DEBUG_SHOW_SCREEN', `Unknown preview screen: ${screen}`);
                        break;
                    }
                    cancelPhaseChain();
                    clearThrowQueue('Debug preview forced');
                    clearThrowUndo();
                    clearScoreCorrection();
                    gameState.gameData.phase = phase;
                    // Limbo bar previews also nudge the live target so the pole moves
                    if (gameState.selectedGame === 'limbo' && phase.type === 'bar_status' && phase.data.barValue != null) {
                        gameState.gameData.currentTargetBar = phase.data.barValue;
                        gameState.gameData.currentRunningTotal = 0;
                    }
                    logDebugEvent('DEBUG_SHOW_SCREEN', `Forced viewer phase: ${phase.type}`);
                    broadcastState();
                    break;
                }

                case 'BOARD_COMMAND': {
                    // Autodarts sendCommand is async; Scolia is sync — Promise.resolve covers both.
                    Promise.resolve(boardDriver.sendCommand(request.command, request.payload))
                        .then((result) => {
                            if (!result || !result.ok) {
                                logDebugEvent(
                                    'BOARD_COMMAND',
                                    (result && result.error) || 'failed',
                                    { command: request.command, status: result && result.status, path: result && result.path }
                                );
                            } else {
                                logDebugEvent(
                                    'BOARD_COMMAND',
                                    `ok ${request.command}${result.path ? ` via ${result.path}` : ''}`,
                                    { status: result.status, path: result.path }
                                );
                            }
                            if (request.command === 'RESET_PHASE' || request.command === 'reset') {
                                boardSync.awaitingTakeout = false;
                                clearThrowQueue('Board phase reset');
                            }
                            broadcastScolia();
                        })
                        .catch((err) => {
                            logDebugEvent('BOARD_COMMAND', err.message || 'failed', { command: request.command });
                            broadcastScolia();
                        });
                    break;
                }

                case 'BOARD_CLEAR_LOG':
                    boardDriver.clearLog();
                    break;

                case 'BOARD_SET_LOG_PAUSED':
                    boardDriver.setLogPaused(!!request.paused);
                    break;

                case 'BOARD_RECONNECT':
                    boardDriver.reconnect();
                    logDebugEvent('BOARD_RECONNECT', 'Manual reconnect requested from control.');
                    break;

                case 'SET_BOARD_PROVIDER': {
                    const saved = saveBoardConfig(DATA_DIR, {
                        provider: request.provider,
                        host: request.host,
                        port: request.port
                    });
                    if (!saved.ok) {
                        logDebugEvent('SET_BOARD_PROVIDER', saved.error || 'failed', request);
                        break;
                    }
                    // Control Apply makes board.json the source of truth for this process
                    delete process.env.BOARD_PROVIDER;
                    delete process.env.AUTODARTS_HOST;
                    delete process.env.AUTODARTS_PORT;
                    delete process.env.OPENDARTS_HOST;
                    delete process.env.OPENDARTS_PORT;
                    if (saved.config.provider === 'mock') {
                        process.env.SCORING_MODE = 'mock';
                    } else {
                        delete process.env.SCORING_MODE;
                    }
                    replaceBoardDriver(saved.config);
                    let where = '';
                    if (saved.config.provider === 'autodarts') {
                        where = ` @ ${saved.config.autodarts.host}:${saved.config.autodarts.port}`;
                    } else if (saved.config.provider === 'opendarts') {
                        where = ` @ ${saved.config.opendarts.host}:${saved.config.opendarts.port}`;
                    }
                    logDebugEvent(
                        'SET_BOARD_PROVIDER',
                        `Board provider → ${saved.config.provider}${where}`
                    );
                    break;
                }

                /** Configure modal's "Test" button — raw TCP reachability check, no
                 *  protocol/app-specific knowledge needed. Replies only to the asking
                 *  client, not a broadcast. */
                case 'TEST_BOARD_CONNECTION': {
                    const host = String(request.host || '').trim();
                    const port = Number(request.port);
                    testTcpConnection(host, port).then((result) => {
                        try {
                            ws.send(JSON.stringify({
                                type: 'BOARD_CONNECTION_TEST_RESULT',
                                data: { host, port, ...result }
                            }));
                        } catch (_) {}
                    });
                    break;
                }

                case 'LIGHTS_ON':
                case 'LIGHTS_OFF':
                case 'LIGHTS_TOGGLE':
                case 'LIGHTS_REFRESH': {
                    const op = request.action === 'LIGHTS_ON'
                        ? dartLights.turnOn()
                        : request.action === 'LIGHTS_OFF'
                            ? dartLights.turnOff()
                            : request.action === 'LIGHTS_TOGGLE'
                                ? dartLights.toggle()
                                : dartLights.refresh();
                    Promise.resolve(op).then((result) => {
                        if (!result || !result.ok) {
                            logDebugEvent('LIGHTS', (result && result.error) || 'failed', { action: request.action });
                        } else {
                            logDebugEvent(
                                'LIGHTS',
                                `${request.action} → ${result.on == null ? 'ok' : (result.on ? 'ON' : 'OFF')}`
                            );
                        }
                        broadcastLights();
                    }).catch((err) => {
                        logDebugEvent('LIGHTS', err.message || 'failed', { action: request.action });
                        broadcastLights();
                    });
                    break;
                }
            }
        } catch (err) {
            console.error("Socket warning:", err);
        }
    });
});

ensureDataDir();
boardDriver.start();
dartLights.start();
applyBoardStandbyFromVenue();

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎪 Engine Restored! [${APP_VERSION}] Control Panel: https://localhost:${PORT}/control.html`);
    console.log(`   Viewer display: https://localhost:${PORT}/viewer.html`);
    console.log(`   LAN access: use https://<your-ip>:${PORT}/ (accept the self-signed cert warning)`);
    const scoliaState = getEnrichedScoliaState();
    const provider = boardDriver.provider || scoliaState.provider || scoliaState.mode || 'scolia';
    if (provider === 'autodarts') {
        const ad = scoliaState.autodarts || {};
        console.log(`   Board: Autodarts local @ ${ad.host || '?'}:${ad.port || '?'}`);
    } else if (provider === 'opendarts') {
        const od = scoliaState.opendarts || {};
        console.log(`   Board: OpenDarts local @ ${od.host || '?'}:${od.port || '?'}`);
    } else if (isMockMode() || scoliaState.mode === 'mock' || provider === 'mock') {
        console.log(`   Board: mock mode on port ${PORT} — Ready (no hardware)`);
    } else if (scoliaState.connection === 'unconfigured') {
        console.log(`   Board: Scolia missing credentials — add data/scolia.json (serialNumber + accessToken)`);
    } else {
        console.log(`   Board: Scolia connecting as ${scoliaState.serialMasked}…`);
    }
    const lights = dartLights.getPublicState();
    if (!lights.configured) {
        console.log('   Lights: Tapo unconfigured — add tapo block to data/credentials.json');
    } else if (!lights.enabled) {
        console.log('   Lights: Tapo disabled in credentials');
    } else {
        console.log(`   Lights: Tapo ${lights.model || 'P110M'} @ ${lights.host} (${lights.connection})`);
    }
});

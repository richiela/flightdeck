const http = require('http');
const WebSocket = require('ws');
const { mapAutodartsThrowEntry } = require('./mapThrow');

const DEFAULT_HOST = 'localhost'; // assumes FlightDeck runs colocated with the engine
const DEFAULT_PORT = 3180;
const RECONNECT_MS = 3000;
const STATE_POLL_MS = 2000;

function httpRequest(host, port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body != null ? JSON.stringify(body) : null;
        const req = http.request(
            {
                host,
                port,
                path: urlPath,
                method,
                headers: payload
                    ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                    : undefined,
                timeout: 5000
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let data = raw;
                    try {
                        data = raw ? JSON.parse(raw) : null;
                    } catch (_) {}
                    resolve({ status: res.statusCode, data, raw });
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * Normalize Autodarts Board Manager status into Scolia-compatible fields
 * so existing Control/Viewer header + ready gating keep working.
 *
 * Important: do NOT treat event "Takeout finished" as still in takeout —
 * that string matches /takeout/i and was leaving the yellow Takeout badge stuck.
 */
function normalizeBoardFields(raw) {
    const status = String((raw && raw.status) || '');
    const event = String((raw && raw.event) || '');
    const running = !!(raw && raw.running);
    const connected = raw && raw.connected !== false;

    let boardStatus = 'Ready';
    let boardPhase = 'Throw';

    const statusTakeout = /^takeout\b/i.test(status); // "Takeout", "Takeout in progress"
    const eventTakeoutActive = /takeout started/i.test(event);

    if (!connected) {
        boardStatus = 'Error';
    } else if (/calibrat/i.test(status) || /calibrat started/i.test(event)) {
        boardStatus = 'Calibrating';
        boardPhase = 'Throw';
    } else if (/stop/i.test(status) || (!running && /stop/i.test(event))) {
        boardStatus = 'Stopped';
        boardPhase = 'Throw';
    } else if (/start/i.test(status) && !running) {
        boardStatus = 'Initializing';
        boardPhase = 'Throw';
    } else if (statusTakeout || eventTakeoutActive) {
        boardStatus = 'Ready';
        boardPhase = 'Takeout';
    } else if (running) {
        boardStatus = 'Ready';
        boardPhase = 'Throw';
    } else {
        boardStatus = 'Stopped';
    }

    return { boardStatus, boardPhase, status, event, running, connected };
}

function createAutodartsDriver({ host, port, onUpdate, onEvent }) {
    const boardHost = String(host || DEFAULT_HOST).trim() || DEFAULT_HOST;
    const boardPort = Number(port) || DEFAULT_PORT;

    let ws = null;
    let intentionalClose = false;
    let reconnectTimer = null;
    let pollTimer = null;
    let lastNumThrows = 0;
    let lastThrowsFingerprint = '';
    /** Desired BM camera standby (minutes); re-applied when WS connects. */
    let desiredStandbyMinutes = null;

    const state = {
        connection: 'connecting',
        closeCode: null,
        closeReason: null,
        lastError: null,
        serialMasked: `${boardHost}:${boardPort}`,
        credentialSource: 'board.json',
        boardStatus: null,
        boardPhase: null,
        errorType: null,
        enableMessageForwardToScolia: false,
        lastHelloAt: null,
        lastEventAt: null,
        lastThrow: null,
        lastTakeout: null,
        log: [],
        logPaused: false,
        mode: 'autodarts',
        provider: 'autodarts',
        autodarts: {
            host: boardHost,
            port: boardPort,
            status: null,
            event: null,
            numThrows: 0,
            running: false,
            standbyMinutes: null
        }
    };

    function emit() {
        if (typeof onUpdate === 'function') onUpdate(getPublicState());
    }

    function pushEvent(type, payload) {
        if (typeof onEvent === 'function') onEvent(type, payload);
    }

    function pushLog(entry) {
        if (state.logPaused) return;
        state.log.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            at: Date.now(),
            direction: entry.direction || 'in',
            type: entry.type || 'UNKNOWN',
            summary: entry.summary != null ? entry.summary : null,
            raw: entry.raw != null ? entry.raw : null
        });
        if (state.log.length > 200) state.log.length = 200;
    }

    function getPublicState() {
        return {
            connection: state.connection,
            closeCode: state.closeCode,
            closeReason: state.closeReason,
            lastError: state.lastError,
            serialMasked: state.serialMasked,
            credentialSource: state.credentialSource,
            boardStatus: state.boardStatus,
            boardPhase: state.boardPhase,
            errorType: state.errorType,
            enableMessageForwardToScolia: false,
            lastHelloAt: state.lastHelloAt,
            lastEventAt: state.lastEventAt,
            lastThrow: state.lastThrow,
            lastTakeout: state.lastTakeout,
            logPaused: state.logPaused,
            mode: 'autodarts',
            provider: 'autodarts',
            readyToScore: state.connection === 'open'
                && state.boardStatus === 'Ready'
                && state.boardPhase === 'Throw',
            log: state.log.slice(),
            autodarts: { ...state.autodarts }
        };
    }

    function applyRawState(raw, source) {
        if (!raw || typeof raw !== 'object') return;
        const norm = normalizeBoardFields(raw);
        const prevPhase = state.boardPhase;
        const prevBoardStatus = state.boardStatus;
        const prevStatus = state.autodarts.status;
        const prevEvent = state.autodarts.event;
        const prevRunning = state.autodarts.running;

        state.autodarts.status = norm.status;
        state.autodarts.event = norm.event;
        state.autodarts.numThrows = Number(raw.numThrows) || 0;
        state.autodarts.running = norm.running;
        state.boardStatus = norm.boardStatus;
        state.boardPhase = norm.boardPhase;
        state.lastEventAt = Date.now();

        if (
            prevStatus !== norm.status
            || prevEvent !== norm.event
            || prevRunning !== norm.running
        ) {
            pushLog({
                direction: 'in',
                type: 'STATE',
                summary: {
                    status: norm.status || null,
                    event: norm.event || null,
                    running: norm.running,
                    source
                },
                raw
            });
        }

        // Camera standby / Stop ↔ active (Start, wake, etc.) — once on edge (lights automation).
        // Fire STARTED as soon as we leave Stopped (incl. Initializing), not only when running=true,
        // so Ready never shows while lights stay off. Also fire on first observation if already active.
        if (prevBoardStatus !== 'Stopped' && norm.boardStatus === 'Stopped') {
            pushEvent('BOARD_DETECTION_STOPPED', {
                status: norm.status,
                event: norm.event,
                source
            });
        }
        const becameActive = prevBoardStatus === 'Stopped' && norm.boardStatus !== 'Stopped';
        const firstSeenActive = prevBoardStatus == null
            && norm.boardStatus !== 'Stopped'
            && (norm.running
                || norm.boardStatus === 'Ready'
                || norm.boardStatus === 'Initializing'
                || norm.boardStatus === 'Calibrating');
        if (becameActive || firstSeenActive) {
            pushEvent('BOARD_DETECTION_STARTED', {
                status: norm.status,
                event: norm.event,
                source
            });
        }

        // Takeout transitions
        const event = norm.event || '';
        if (/takeout started/i.test(event) && prevEvent !== event) {
            state.lastTakeout = { kind: 'started', at: Date.now(), source };
            pushEvent('TAKEOUT_STARTED', { source: 'autodarts' });
        }
        if (/takeout finished/i.test(event) && prevEvent !== event) {
            state.lastTakeout = { kind: 'finished', at: Date.now(), source };
            pushEvent('TAKEOUT_FINISHED', { falseTakeout: false, source: 'autodarts' });
        }
        // Phase entered takeout without explicit event (status-only)
        if (prevPhase !== 'Takeout' && norm.boardPhase === 'Takeout' && !/takeout started/i.test(event)) {
            state.lastTakeout = { kind: 'started', at: Date.now(), source };
            pushEvent('TAKEOUT_STARTED', { source: 'autodarts', via: 'status' });
        }

        // New dart(s): prefer WS payloads that include throws[]
        const throws = Array.isArray(raw.throws) ? raw.throws : null;
        const numThrows = Number(raw.numThrows);
        const knownCount = Number.isFinite(numThrows) ? numThrows : (throws ? throws.length : null);

        if (throws && throws.length > lastNumThrows) {
            for (let i = lastNumThrows; i < throws.length; i++) {
                const mapped = mapAutodartsThrowEntry(throws[i]);
                state.lastThrow = {
                    at: Date.now(),
                    mapped,
                    raw: throws[i],
                    source: 'autodarts'
                };
                pushEvent('THROW', mapped);
            }
            lastNumThrows = throws.length;
            lastThrowsFingerprint = JSON.stringify(throws);
        } else if (throws && throws.length === 0) {
            lastNumThrows = 0;
            lastThrowsFingerprint = '';
        } else if (
            !throws
            && knownCount === 0
            && /takeout finished|manual reset|^started$/i.test(String(norm.event || ''))
        ) {
            // HTTP polls omit throws[]; only clear visit on explicit end/reset events
            lastNumThrows = 0;
            lastThrowsFingerprint = '';
        } else if (throws && JSON.stringify(throws) !== lastThrowsFingerprint) {
            // same count, content changed (correction) — ignore for spike
            lastThrowsFingerprint = JSON.stringify(throws);
        }

        // Manual reset clears visit
        if (/manual reset/i.test(event) && prevEvent !== event) {
            lastNumThrows = 0;
            lastThrowsFingerprint = '';
            if (norm.boardPhase !== 'Takeout') {
                pushEvent('TAKEOUT_FINISHED', { falseTakeout: false, source: 'autodarts', via: 'reset' });
            }
        }

        emit();
    }

    async function fetchState() {
        const res = await httpRequest(boardHost, boardPort, 'GET', '/api/state');
        if (res.status >= 200 && res.status < 300 && res.data) {
            // HTTP /api/state often omits throws[]; still useful for status
            applyRawState(res.data, 'http');
        }
        return res;
    }

    function scheduleReconnect() {
        if (intentionalClose) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectWs();
        }, RECONNECT_MS);
    }

    function connectWs() {
        if (intentionalClose) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        state.connection = 'connecting';
        emit();

        const url = `ws://${boardHost}:${boardPort}/api/events`;
        console.log(`\x1b[36m[AUTODARTS]\x1b[0m Connecting ${url}`);
        ws = new WebSocket(url);

        ws.on('open', () => {
            state.connection = 'open';
            state.lastError = null;
            state.lastHelloAt = Date.now();
            console.log(`\x1b[36m[AUTODARTS]\x1b[0m Connected ${boardHost}:${boardPort}`);
            emit();
            fetchState().catch((err) => {
                state.lastError = err.message;
                emit();
            });
            if (desiredStandbyMinutes != null) {
                setStandbyMinutes(desiredStandbyMinutes).catch(() => {});
            }
        });

        ws.on('message', (buf) => {
            let msg;
            try {
                msg = JSON.parse(buf.toString());
            } catch (_) {
                return;
            }
            if (!msg || typeof msg !== 'object') return;

            // Board Manager gameplay lives on type:"state"
            if (msg.type === 'state' && msg.data && typeof msg.data === 'object') {
                applyRawState(msg.data, 'ws');
            }
        });

        ws.on('close', (code, reasonBuf) => {
            const reason = reasonBuf ? reasonBuf.toString() : '';
            state.connection = 'closed';
            state.closeCode = code;
            state.closeReason = reason || null;
            state.boardStatus = null;
            state.boardPhase = null;
            console.log(`\x1b[36m[AUTODARTS]\x1b[0m Closed (${code}${reason ? ` ${reason}` : ''})`);
            emit();
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            state.lastError = err.message;
            console.error(`\x1b[36m[AUTODARTS]\x1b[0m Error:`, err.message);
            emit();
        });
    }

    /** Try paths in order; first 2xx wins. Used because BM builds vary (/api/start vs /api/detection/start). */
    async function tryHttp(method, paths) {
        let last = null;
        for (const urlPath of paths) {
            try {
                const res = await httpRequest(boardHost, boardPort, method, urlPath);
                last = { ...res, path: urlPath };
                if (res.status >= 200 && res.status < 300) return last;
            } catch (err) {
                last = { status: 0, data: null, raw: '', path: urlPath, error: err.message };
            }
        }
        return last;
    }

    async function ensureDetectionRunning() {
        try {
            const res = await httpRequest(boardHost, boardPort, 'GET', '/api/state');
            if (res.data && res.data.running) return { ok: true, already: true };
            const start = await tryHttp('PUT', ['/api/start', '/api/detection/start']);
            return {
                ok: !!(start && start.status >= 200 && start.status < 300),
                status: start && start.status,
                path: start && start.path,
                error: start && start.error
            };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    async function setStandbyMinutes(minutes) {
        const n = Math.round(Number(minutes));
        if (![5, 10, 15, 30, 60].includes(n)) {
            return { ok: false, error: `standby_minutes must be 5, 10, 15, 30, or 60 (got ${minutes})` };
        }
        desiredStandbyMinutes = n;

        pushLog({
            direction: 'out',
            type: 'SET_STANDBY',
            summary: { standby_minutes: n, sending: true }
        });
        emit();

        try {
            let current = null;
            try {
                const getRes = await httpRequest(boardHost, boardPort, 'GET', '/api/config');
                if (getRes.status >= 200 && getRes.status < 300 && getRes.data && getRes.data.motion) {
                    current = Number(getRes.data.motion.standby_minutes);
                }
            } catch (_) { /* still try patch */ }

            if (current === n) {
                state.autodarts.standbyMinutes = n;
                pushLog({
                    direction: 'out',
                    type: 'SET_STANDBY',
                    summary: { ok: true, standby_minutes: n, already: true }
                });
                emit();
                return { ok: true, standbyMinutes: n, already: true };
            }

            const res = await httpRequest(
                boardHost,
                boardPort,
                'PATCH',
                '/api/config',
                { motion: { standby_minutes: n } }
            );
            const ok = !!(res && res.status >= 200 && res.status < 300);
            if (ok) state.autodarts.standbyMinutes = n;
            pushLog({
                direction: 'out',
                type: 'SET_STANDBY',
                summary: {
                    ok,
                    standby_minutes: n,
                    status: res ? res.status : null,
                    error: ok ? null : ((res && res.error) || `HTTP ${res && res.status}`)
                },
                raw: res && res.data
            });
            emit();
            console.log(
                `\x1b[36m[AUTODARTS]\x1b[0m Camera standby → ${n} min`,
                ok ? 'ok' : `fail (${res && res.status})`
            );
            return {
                ok,
                standbyMinutes: n,
                status: res ? res.status : 0,
                error: ok ? undefined : ((res && res.error) || `HTTP ${res && res.status}`)
            };
        } catch (err) {
            pushLog({
                direction: 'out',
                type: 'SET_STANDBY',
                summary: { ok: false, error: err.message }
            });
            emit();
            return { ok: false, error: err.message };
        }
    }

    function start() {
        intentionalClose = false;
        connectWs();
        ensureDetectionRunning().then((r) => {
            if (!r.ok) {
                console.warn(`\x1b[36m[AUTODARTS]\x1b[0m Could not start detection:`, r.error || r.status);
            }
        });
        if (!pollTimer) {
            pollTimer = setInterval(() => {
                fetchState().catch(() => {});
            }, STATE_POLL_MS);
        }
    }

    function stop() {
        intentionalClose = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (ws) {
            try { ws.close(); } catch (_) {}
            ws = null;
        }
        state.connection = 'closed';
        emit();
    }

    function reconnect() {
        intentionalClose = false;
        if (ws) {
            try {
                intentionalClose = true;
                ws.close();
            } catch (_) {}
            intentionalClose = false;
        }
        connectWs();
        return { ok: true };
    }

    function clearLog() {
        state.log = [];
        emit();
        return { ok: true };
    }

    function setLogPaused(paused) {
        state.logPaused = !!paused;
        emit();
        return { ok: true };
    }

    async function sendCommand(command) {
        const cmd = String(command || '');
        let paths = null;
        let method = 'PUT';

        if (cmd === 'RESET_PHASE' || cmd === 'reset') {
            method = 'POST';
            paths = ['/api/reset'];
        } else if (cmd === 'start') {
            paths = ['/api/start', '/api/detection/start'];
        } else if (cmd === 'stop') {
            paths = ['/api/stop', '/api/detection/stop'];
        } else if (cmd === 'RECALIBRATE' || cmd === 'calibrate') {
            method = 'POST';
            paths = ['/api/config/calibration/auto', '/api/calibration/auto'];
        } else {
            return { ok: false, error: `Unsupported Autodarts command: ${cmd}` };
        }

        pushLog({
            direction: 'out',
            type: cmd,
            summary: { sending: true, method, paths }
        });
        emit();

        try {
            const res = await tryHttp(method, paths);
            const ok = !!(res && res.status >= 200 && res.status < 300);
            if (cmd === 'RESET_PHASE' || cmd === 'reset') {
                lastNumThrows = 0;
                lastThrowsFingerprint = '';
            }
            pushLog({
                direction: 'out',
                type: cmd,
                summary: {
                    ok,
                    status: res ? res.status : null,
                    path: res ? res.path : null,
                    error: res && res.error ? res.error : (ok ? null : `HTTP ${res && res.status}`)
                },
                raw: res
            });
            try {
                await fetchState();
            } catch (_) {}
            emit();
            console.log(
                `\x1b[36m[AUTODARTS]\x1b[0m Command ${cmd} →`,
                ok ? `ok ${res.path} (${res.status})` : `fail ${res && res.path} (${res && (res.error || res.status)})`
            );
            return {
                ok,
                status: res ? res.status : 0,
                path: res ? res.path : null,
                error: ok ? undefined : ((res && res.error) || `HTTP ${res && res.status}`)
            };
        } catch (err) {
            pushLog({
                direction: 'out',
                type: cmd,
                summary: { ok: false, error: err.message }
            });
            emit();
            return { ok: false, error: err.message };
        }
    }

    function reloadAndConnect() {
        return reconnect();
    }

    return {
        start,
        stop,
        reconnect,
        clearLog,
        setLogPaused,
        sendCommand,
        setStandbyMinutes,
        getPublicState,
        reloadAndConnect,
        provider: 'autodarts'
    };
}

module.exports = { createAutodartsDriver, normalizeBoardFields };

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const SCOLIA_WS_BASE = 'wss://game.scoliadarts.com/api/v1/social';
const MAX_LOG_ENTRIES = 200;
const RECONNECT_MS = 3000;

function isMockMode() {
    return String(process.env.SCORING_MODE || '').trim().toLowerCase() === 'mock';
}

function loadCredentials(dataDir) {
    const fromEnv = {
        serialNumber: (process.env.SCOLIA_SERIAL_NUMBER || '').trim(),
        accessToken: (process.env.SCOLIA_ACCESS_TOKEN || '').trim()
    };
    if (fromEnv.serialNumber && fromEnv.accessToken) {
        return { ...fromEnv, source: 'env' };
    }

    const configPath = path.join(dataDir, 'scolia.json');
    try {
        if (!fs.existsSync(configPath)) return null;
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const serialNumber = String(raw.serialNumber || '').trim();
        const accessToken = String(raw.accessToken || '').trim();
        if (!serialNumber || !accessToken) return null;
        return { serialNumber, accessToken, source: 'file' };
    } catch (err) {
        console.error('Failed to read data/scolia.json:', err.message);
        return null;
    }
}

function maskSerial(serial) {
    if (!serial || serial.length < 6) return serial || '—';
    return `${serial.slice(0, 3)}…${serial.slice(-3)}`;
}

function summarizePayload(type, payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (type === 'CAMERA_IMAGES' && Array.isArray(payload.images)) {
        return {
            images: payload.images.map((img) => {
                const len = typeof img === 'string' ? img.length : 0;
                return `[base64 omitted, ${len} chars]`;
            })
        };
    }
    if (type === 'THROW_DETECTED') {
        return {
            sector: payload.sector,
            bounceout: payload.bounceout,
            coordinates: payload.coordinates,
            sectorSuggestions: payload.sectorSuggestions,
            detectionTime: payload.detectionTime,
            angle: payload.angle
        };
    }
    return payload;
}

function createMockScoliaClient({ onUpdate }) {
    let commandNoOpLogged = false;
    const state = {
        connection: 'open',
        closeCode: null,
        closeReason: null,
        lastError: null,
        serialMasked: 'mock',
        credentialSource: 'mock',
        boardStatus: 'Ready',
        boardPhase: 'Throw',
        errorType: null,
        enableMessageForwardToScolia: false,
        lastHelloAt: null,
        lastEventAt: null,
        lastThrow: null,
        lastTakeout: null,
        log: [],
        logPaused: false,
        mode: 'mock'
    };

    function emit() {
        if (typeof onUpdate === 'function') onUpdate(getPublicState());
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
            enableMessageForwardToScolia: state.enableMessageForwardToScolia,
            lastHelloAt: state.lastHelloAt,
            lastEventAt: state.lastEventAt,
            lastThrow: state.lastThrow,
            lastTakeout: state.lastTakeout,
            logPaused: state.logPaused,
            mode: 'mock',
            readyToScore: true,
            log: state.log.slice()
        };
    }

    function start() {
        console.log('\x1b[36m[SCOLIA]\x1b[0m Mock mode — not connecting to board');
        emit();
    }

    function reconnect() {
        state.connection = 'open';
        state.boardStatus = 'Ready';
        state.boardPhase = 'Throw';
        state.lastError = null;
        emit();
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

    function sendCommand(command, payload) {
        if (!commandNoOpLogged) {
            commandNoOpLogged = true;
            console.log(`\x1b[36m[SCOLIA]\x1b[0m Mock mode — commands are no-ops (first: ${command})`);
        }
        if (command === 'CONFIGURE_SBC' && payload && payload.enableMessageForwardToScolia !== undefined) {
            state.enableMessageForwardToScolia = !!payload.enableMessageForwardToScolia;
            emit();
        }
        return { ok: true, mock: true };
    }

    return {
        start,
        reconnect,
        clearLog,
        setLogPaused,
        sendCommand,
        getPublicState,
        reloadAndConnect: reconnect
    };
}

function createLiveScoliaClient({ dataDir, onUpdate, onEvent }) {
    let ws = null;
    let reconnectTimer = null;
    let intentionalClose = false;
    let credentials = loadCredentials(dataDir);

    const state = {
        connection: 'unconfigured',
        closeCode: null,
        closeReason: null,
        lastError: null,
        serialMasked: credentials ? maskSerial(credentials.serialNumber) : null,
        credentialSource: credentials ? credentials.source : null,
        boardStatus: null,
        boardPhase: null,
        errorType: null,
        enableMessageForwardToScolia: null,
        lastHelloAt: null,
        lastEventAt: null,
        lastThrow: null,
        lastTakeout: null,
        log: [],
        logPaused: false
    };

    function emit() {
        if (typeof onUpdate === 'function') onUpdate(getPublicState());
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
            enableMessageForwardToScolia: state.enableMessageForwardToScolia,
            lastHelloAt: state.lastHelloAt,
            lastEventAt: state.lastEventAt,
            lastThrow: state.lastThrow,
            lastTakeout: state.lastTakeout,
            logPaused: state.logPaused,
            mode: 'live',
            readyToScore: state.connection === 'open'
                && state.boardStatus === 'Ready'
                && state.boardPhase === 'Throw',
            log: state.log.slice()
        };
    }

    function notifyEvent(type, payload) {
        if (typeof onEvent === 'function') {
            try {
                onEvent(type, payload || null);
            } catch (err) {
                console.error('[SCOLIA] onEvent error:', err.message);
            }
        }
    }

    function pushLog(entry) {
        if (state.logPaused && entry.direction === 'in') return;
        state.log.unshift(entry);
        if (state.log.length > MAX_LOG_ENTRIES) {
            state.log.length = MAX_LOG_ENTRIES;
        }
        state.lastEventAt = entry.at;
    }

    function applyBoardFields(payload) {
        if (!payload || typeof payload !== 'object') return;
        if (payload.boardStatus !== undefined) state.boardStatus = payload.boardStatus;
        if (payload.boardPhase !== undefined) state.boardPhase = payload.boardPhase;
        if (payload.errorType !== undefined) state.errorType = payload.errorType;
        if (payload.enableMessageForwardToScolia !== undefined) {
            state.enableMessageForwardToScolia = payload.enableMessageForwardToScolia;
        }
    }

    function handleIncoming(msg) {
        const type = msg && msg.type;
        const payload = msg && msg.payload;
        applyBoardFields(payload);

        if (type === 'HELLO_CLIENT') {
            state.lastHelloAt = Date.now();
            // Own the event stream — don't also feed Scolia's app
            sendRaw('CONFIGURE_SBC', { enableMessageForwardToScolia: false });
            sendRaw('GET_SBC_CONFIGURATION');
        }

        if (type === 'THROW_DETECTED') {
            state.lastThrow = {
                at: Date.now(),
                sector: payload && payload.sector,
                bounceout: payload && payload.bounceout,
                suggestions: payload && payload.sectorSuggestions
            };
        }

        if (type === 'TAKEOUT_STARTED' || type === 'TAKEOUT_FINISHED') {
            state.lastTakeout = {
                at: Date.now(),
                kind: type === 'TAKEOUT_STARTED' ? 'started' : 'finished',
                falseTakeout: payload ? !!payload.falseTakeout : false
            };
        }

        if (type === 'SBC_CONFIGURATION') {
            applyBoardFields(payload);
        }

        pushLog({
            id: uuidv4(),
            at: Date.now(),
            direction: 'in',
            type: type || 'UNKNOWN',
            messageId: msg && msg.id,
            summary: summarizePayload(type, payload),
            raw: type === 'CAMERA_IMAGES'
                ? { type, id: msg.id, payload: summarizePayload(type, payload) }
                : msg
        });
        emit();
        if (type) notifyEvent(type, payload);
    }

    function sendRaw(type, payload) {
        const message = { type, id: uuidv4() };
        if (payload !== undefined) message.payload = payload;

        pushLog({
            id: uuidv4(),
            at: Date.now(),
            direction: 'out',
            type,
            messageId: message.id,
            summary: payload || null,
            raw: message
        });

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            state.lastError = `Cannot send ${type}: socket not open`;
            emit();
            return { ok: false, error: state.lastError };
        }

        try {
            ws.send(JSON.stringify(message));
            emit();
            return { ok: true, id: message.id };
        } catch (err) {
            state.lastError = err.message;
            emit();
            return { ok: false, error: err.message };
        }
    }

    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function scheduleReconnect() {
        clearReconnectTimer();
        if (intentionalClose) return;
        if (!credentials) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, RECONNECT_MS);
    }

    function connect() {
        credentials = loadCredentials(dataDir);
        if (!credentials) {
            state.connection = 'unconfigured';
            state.serialMasked = null;
            state.credentialSource = null;
            state.lastError = 'Missing credentials. Create data/scolia.json with serialNumber and accessToken.';
            emit();
            return;
        }

        intentionalClose = false;
        clearReconnectTimer();

        if (ws) {
            try { ws.removeAllListeners(); ws.close(); } catch (_) { /* ignore */ }
            ws = null;
        }

        state.connection = 'connecting';
        state.closeCode = null;
        state.closeReason = null;
        state.lastError = null;
        state.serialMasked = maskSerial(credentials.serialNumber);
        state.credentialSource = credentials.source;
        emit();

        const url = `${SCOLIA_WS_BASE}?serialNumber=${encodeURIComponent(credentials.serialNumber)}&accessToken=${encodeURIComponent(credentials.accessToken)}`;

        try {
            ws = new WebSocket(url);
        } catch (err) {
            state.connection = 'error';
            state.lastError = err.message;
            emit();
            scheduleReconnect();
            return;
        }

        ws.on('open', () => {
            state.connection = 'open';
            state.lastError = null;
            console.log(`\x1b[36m[SCOLIA]\x1b[0m Connected (${state.serialMasked})`);
            emit();
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                handleIncoming(msg);
            } catch (err) {
                pushLog({
                    id: uuidv4(),
                    at: Date.now(),
                    direction: 'in',
                    type: 'PARSE_ERROR',
                    messageId: null,
                    summary: { error: err.message, preview: String(data).slice(0, 200) },
                    raw: null
                });
                emit();
            }
        });

        ws.on('close', (code, reasonBuf) => {
            const reason = reasonBuf ? reasonBuf.toString() : '';
            state.connection = 'closed';
            state.closeCode = code;
            state.closeReason = reason || null;
            state.boardStatus = null;
            state.boardPhase = null;
            console.log(`\x1b[36m[SCOLIA]\x1b[0m Closed (${code}${reason ? ` ${reason}` : ''})`);
            pushLog({
                id: uuidv4(),
                at: Date.now(),
                direction: 'sys',
                type: 'CONNECTION_CLOSED',
                messageId: null,
                summary: { code, reason: reason || null },
                raw: null
            });
            emit();
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            state.lastError = err.message;
            console.error(`\x1b[36m[SCOLIA]\x1b[0m Error:`, err.message);
            emit();
        });
    }

    function start() {
        connect();
    }

    function reconnect() {
        intentionalClose = false;
        if (ws && ws.readyState === WebSocket.OPEN) {
            intentionalClose = true;
            ws.close();
            intentionalClose = false;
        }
        connect();
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

    function sendCommand(command, payload) {
        const allowed = new Set([
            'GET_SBC_STATUS',
            'GET_CAMERA_IMAGES',
            'RECALIBRATE',
            'RESET_PHASE',
            'THROW_CORRECTED',
            'DELETE_THROW',
            'CONFIGURE_SBC',
            'GET_SBC_CONFIGURATION'
        ]);
        if (!allowed.has(command)) {
            return { ok: false, error: `Unknown command: ${command}` };
        }
        if (command === 'CONFIGURE_SBC' && payload && payload.enableMessageForwardToScolia !== undefined) {
            state.enableMessageForwardToScolia = !!payload.enableMessageForwardToScolia;
            emit();
        }
        return sendRaw(command, payload);
    }

    return {
        start,
        reconnect,
        clearLog,
        setLogPaused,
        sendCommand,
        getPublicState,
        reloadAndConnect: reconnect
    };
}

function createScoliaClient(opts) {
    if (isMockMode()) {
        return createMockScoliaClient(opts);
    }
    return createLiveScoliaClient(opts);
}

function mapScoliaThrow(payload) {
    if (!payload || payload.bounceout || !payload.sector || payload.sector === 'None') {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true };
    }
    const sector = String(payload.sector);
    if (sector === 'Bull') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: 'bull', multiplier: 2, sector };
    }
    if (sector === '25') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: 'bull', multiplier: 1, sector };
    }
    const match = sector.match(/^([SsDT])(20|1[0-9]|[1-9])$/);
    if (!match) {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true };
    }
    const multChar = match[1];
    const multiplier = multChar === 'T' ? 3 : multChar === 'D' ? 2 : 1;
    return {
        type: 'TRIGGER_SPECIFIC_THROW',
        number: Number(match[2]),
        multiplier,
        sector
    };
}

module.exports = { createScoliaClient, loadCredentials, mapScoliaThrow, isMockMode };

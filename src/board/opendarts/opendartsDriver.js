const http = require('http');
const WebSocket = require('ws');
const { mapOpenDartsThrow } = require('./mapThrow');

/**
 * OpenDarts board driver, written against OpenDarts `docs/RETAIL_API.md`
 * and cross-checked against `opendarts/live/server.py` (the doc has at
 * least one real inaccuracy — see the takeout note below — so source is
 * authoritative where the two disagree).
 *
 * WHAT CHANGED FROM THE PRIOR REWRITE (same `/api/live` endpoint, meaningfully
 * different contract):
 *   - `visit` is a STRING id (e.g. "visit_1788937678491", a timestamp-based
 *     token — unique across a rig restart, unlike a plain counter), never an
 *     integer. Do not Number() it.
 *   - A new `throw_corrected` event exists — a real correction-visibility
 *     mechanism that didn't exist before (see "Corrections" below).
 *   - A new `GET /api/live/recent` endpoint exists specifically for
 *     reconnect backfill — closes a real gap the prior rewrite had (a turn
 *     that fully completed and cleared while the socket was down was
 *     previously just lost).
 *   - The correction-WRITE endpoint is now
 *     `POST /api/visits/{visit_id}/throws/{index}/correct` (path params,
 *     not body fields), and it uses OD's INTERNAL ring vocabulary
 *     (`outside`, not `miss`) — different from the WIRE vocabulary `darts[]`
 *     itself uses. Conflating the two silently posts a rejected/wrong
 *     correction.
 *   - The raw per-dart signal is rebroadcast as `type: "THROW_DETECTED"`
 *     (not `"throw"`), with `visit_id`/`visit_index` (not `visit`/`index`),
 *     no `value`, and its `sector`/`ring` are the INTERNAL vocabulary too
 *     (per the doc's own warning) — never run through mapOpenDartsThrow.
 *   - `GET /api/state` (used here only for diagnostics) has a completely
 *     different, deeply-nested shape than the prior repo's — no top-level
 *     `status`/`darts`/`n_darts`/`running`, no `calibrating` field at all.
 *     Real shape: `capture_loop.running`, `calibration`, `trigger`,
 *     `packages.count`, `ad_board_status`, `websocket_clients`.
 *   - REST control paths are flat (`/api/start`, `/api/stop`, `/api/reset`,
 *     `/api/restart`, `/api/calibration/refresh`) — not `/api/control/*`.
 *
 * `/api/live` message shapes (two `type` values):
 *   type: 'state' — full snapshot on every lifecycle change, plus once on
 *     connect with `event: 'hello'`. Fields: event, running, status, visit,
 *     n_darts, darts[], at. ALWAYS present, even empty ([] / 0) — never
 *     omitted. `status` ∈ throw|takeout|stopped|connecting|camera_error|
 *     no_live_capture (docs/RETAIL_API.md's list — no `waiting` value is
 *     documented for this repo; phaseToBoardStatus still maps it
 *     defensively in case that's incomplete, at zero cost if it never
 *     arrives). Re-delivery is explicitly PERMITTED and the snapshot is
 *     idempotent — always apply it, then dispatch on `event` for side
 *     effects, never skip a message because "nothing changed".
 *   type: 'THROW_DETECTED' — the raw per-dart signal, rebroadcast verbatim,
 *     fired just before the `state` that includes it. Internal vocabulary,
 *     timing/logging only — see commitThrowDetail.
 *
 * TAKEOUT EVENTS — doc vs source (verified against opendarts/live/server.py
 * directly): entering takeout DOES publish `event: "takeout_started"`
 * (matches the doc's `status` value "takeout" but NOT its events-table
 * name, which just says "takeout"). Leaving takeout publishes NO named
 * event at all — "takeout_finished" is never actually emitted on this
 * channel despite appearing in the doc's table. The real "takeout is done"
 * signal is the turn ending: `visit_complete` (turn completed normally) or
 * `manual_reset` (operator Reset). Both are mapped to TAKEOUT_FINISHED here.
 *
 * RECONNECT — two complementary mechanisms, because they close different
 * gaps:
 *   1. Darts thrown mid-visit while briefly disconnected: `lastDarts` is
 *      now keyed against `lastVisitId` and deliberately NOT reset on WS
 *      close — if `hello` reports the SAME visit on reconnect, the usual
 *      length-diff against the persisted baseline picks up exactly the
 *      darts that landed during the outage, without replaying ones already
 *      scored before it. If the visit changed, the baseline resets for the
 *      new one.
 *   2. A whole turn that started AND completed entirely during a
 *      disconnect: never appears in any `hello` (hello only ever shows the
 *      turn in progress "now"), so it's fetched from `GET /api/live/recent`
 *      on every WS open (initial connect and every reconnect) and replayed
 *      through the same scoring path, deduped by visit id so a later
 *      reconnect never double-counts it.
 *
 * CORRECTIONS — outbound (FlightDeck's own Correct Score writing a fix) and
 * inbound (OD reporting one happened) are both handled, but asymmetrically:
 *   - Outbound: sendCommand('throws/correct', {visit, index, ring, sector?,
 *     source?, note?}) → POST /api/visits/{visit}/throws/{index}/correct.
 *   - Inbound: a `state` with `event: "throw_corrected"` has the corrected
 *     dart(s) marked `corrected: true` in `darts[]`, with `label`/`value`
 *     already reflecting the fix (WIRE vocabulary here, safe to run through
 *     mapOpenDartsThrow). This pushes a THROW_CORRECTED event and updates
 *     `lastThrow`/Board Debug for visibility — it does NOT reach back into
 *     an already-advanced FlightDeck match score. A correction made through
 *     FlightDeck's own Correct Score already updates the game via that
 *     separate path; a correction made from OD's own dashboard has no way
 *     back into a live match yet. Known, deliberate gap — flag before
 *     building anything on top of it.
 *
 * External contract this file MUST keep (unchanged from prior rewrites —
 * nothing outside board/opendarts/ needs to change for this):
 *   - provider: 'opendarts', mode: 'opendarts'
 *   - top-level boardStatus / boardPhase ('Ready'/'Stopped'/'Initializing'/
 *     'Calibrating', 'Throw'/'Takeout')
 *   - opendarts.{running, status, host, port} — `status` here is the
 *     TRANSLATED boardStatus value, NOT the raw enum (that's
 *     opendarts.phase).
 *   - sendCommand('start'/'stop'/'RESET_PHASE'/'RECALIBRATE') — the dart-
 *     lights wake flow (server.js) calls sendCommand('start') directly.
 * opendarts.visitId (renamed from visitNumber — it's a string id, not a
 * number) and opendarts.dartCount are copy-through from the latest
 * /api/live message. opendarts.{calibration, captureLoop, trigger,
 * packagesCount, adBoardStatus, websocketClients} are diagnostic ONLY,
 * sourced from an occasional GET /api/state poll — see
 * applyDiagnosticSnapshot. That poll deliberately never touches
 * boardStatus/boardPhase/running/errorType/phase/status/visitId/dartCount;
 * those are exclusively /api/live-sourced.
 */

/** Assumes FlightDeck runs colocated with the engine — override via OPENDARTS_HOST
 *  or data/board.json if the rig lives elsewhere. Worth knowing when debugging:
 *  this field wants the BOARD's address, and putting FlightDeck's own address
 *  here fails in a way that looks like the board is unreachable rather than
 *  misconfigured — see board/createBoardDriver.js. */
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8420;
const RECONNECT_MS = 3000;
/** Diagnostic-only poll (camera/calibration detail) — only runs while WS is
 *  down, purely to keep Board Debug's camera panel from going stale. Never
 *  a correctness fallback: gameplay-critical fields come exclusively from
 *  /api/live and simply hold their last known value while disconnected. */
const DIAGNOSTIC_POLL_MS = 5000;
const HTTP_TIMEOUT_MS = 5000;
/** Start opens cameras — can take several seconds. */
const HTTP_LONG_TIMEOUT_MS = 60000;
/** Bound on the reconnect-backfill dedup set — OD's own /api/live/recent
 *  buffer only ever holds 12 visits, so this is generous headroom, not a
 *  tight budget. */
const MAX_BACKFILLED_VISIT_IDS = 500;

/** OD's phase enum → FlightDeck's generic boardStatus vocabulary. */
function phaseToBoardStatus(phase) {
    switch (phase) {
        case 'stopped':
        case 'no_live_capture':
        case 'camera_error':
            return 'Stopped';
        case 'connecting':
            return 'Initializing';
        case 'waiting': // not in this repo's documented status list — kept defensively
            return 'Calibrating';
        case 'throw':
        case 'takeout':
            return 'Ready';
        default:
            return null;
    }
}

function phaseToBoardPhase(phase) {
    if (phase === 'takeout') return 'Takeout';
    if (phase === 'throw') return 'Throw';
    return null;
}

/** "Armed and live" — throw and takeout are both a running session. */
function phaseToRunning(phase) {
    return phase === 'throw' || phase === 'takeout';
}

function httpRequest(host, port, method, urlPath, body, timeoutMs) {
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
                timeout: timeoutMs != null ? timeoutMs : HTTP_TIMEOUT_MS
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

function createOpenDartsDriver({ host, port, onUpdate, onEvent }) {
    const boardHost = String(host || DEFAULT_HOST).trim() || DEFAULT_HOST;
    const boardPort = Number(port) || DEFAULT_PORT;

    let ws = null;
    let intentionalClose = false;
    let reconnectTimer = null;
    let pollTimer = null;
    /** Diffed against on every state message (not just throw_detected —
     *  state is idempotent and a hello can also reveal darts thrown while
     *  disconnected). Deliberately NOT reset on WS close — see header. */
    let lastDarts = [];
    let lastVisitId = null;
    /** Visit ids already scored (live or backfilled) — prevents a later
     *  /api/live/recent fetch from replaying a visit twice. */
    const backfilledVisitIds = new Set();
    const backfilledVisitOrder = [];

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
        mode: 'opendarts',
        provider: 'opendarts',
        opendarts: {
            host: boardHost,
            port: boardPort,
            phase: null, // raw OD status enum
            status: null, // mirrors boardStatus — kept for the external contract
            running: false,
            calibrating: false,
            visitId: null, // string id, e.g. "visit_1788937678491"
            dartCount: null,
            calibration: null, // diagnostic-only, see applyDiagnosticSnapshot
            captureLoop: null, // diagnostic-only
            trigger: null, // diagnostic-only
            packagesCount: null, // diagnostic-only
            adBoardStatus: null, // diagnostic-only
            websocketClients: null // diagnostic-only
        }
    };

    function emit() {
        if (typeof onUpdate === 'function') onUpdate(getPublicState());
    }

    function pushEvent(type, payload) {
        if (typeof onEvent === 'function') onEvent(type, payload);
    }

    function rememberBackfilledVisit(visitId) {
        if (visitId == null || backfilledVisitIds.has(visitId)) return;
        backfilledVisitIds.add(visitId);
        backfilledVisitOrder.push(visitId);
        if (backfilledVisitOrder.length > MAX_BACKFILLED_VISIT_IDS) {
            const oldest = backfilledVisitOrder.shift();
            backfilledVisitIds.delete(oldest);
        }
    }

    /** Mirror Autodarts/OpenDarts: Stopped ↔ active edges drive dart-lights automation. */
    function emitDetectionStatusEdges(prevBoardStatus, source) {
        const next = state.boardStatus;
        if (prevBoardStatus !== 'Stopped' && next === 'Stopped') {
            pushEvent('BOARD_DETECTION_STOPPED', { status: next, source: source || 'opendarts' });
        }
        const becameActive = prevBoardStatus === 'Stopped' && next != null && next !== 'Stopped';
        const firstSeenActive = prevBoardStatus == null && next != null && next !== 'Stopped';
        if (becameActive || firstSeenActive) {
            pushEvent('BOARD_DETECTION_STARTED', { status: next, source: source || 'opendarts' });
        }
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
            mode: 'opendarts',
            provider: 'opendarts',
            readyToScore: state.connection === 'open'
                && state.boardStatus === 'Ready'
                && state.boardPhase === 'Throw',
            log: state.log.slice(),
            opendarts: { ...state.opendarts }
        };
    }

    /**
     * The ONLY place that calls pushEvent('THROW', ...) — scoring is driven
     * exclusively by /api/live's darts[] diff (both the live channel and
     * the reconnect backfill funnel through here), never by the raw
     * THROW_DETECTED signal. `dart` is a darts[] entry: {label, sector,
     * ring, value, captured_at_utc} — WIRE vocabulary, the same shape
     * mapOpenDartsThrow already consumes.
     */
    function commitScoredDart(dart, visitId, index, source) {
        const mapped = mapOpenDartsThrow(dart);
        state.lastThrow = {
            at: Date.now(),
            sector: dart.sector,
            ring: dart.ring,
            value: dart.value,
            mapped,
            raw: dart,
            source: 'opendarts'
        };
        pushLog({
            direction: 'in',
            type: 'throw_detected',
            summary: { visit: visitId, index, sector: dart.sector, ring: dart.ring, value: dart.value, source },
            raw: dart
        });
        pushEvent('THROW', mapped);
    }

    /**
     * The raw per-dart signal, `type: "THROW_DETECTED"`, rebroadcast
     * verbatim just before the `state` that includes it. `sector`/`ring`
     * here are OD's INTERNAL vocabulary (board.py's sector_ring_for_point —
     * e.g. "outside", not "miss"), NOT the wire vocabulary darts[] uses —
     * mapOpenDartsThrow must never be called on this payload. Timing/
     * logging only; scoring never depends on this arriving at all.
     */
    function commitThrowDetail(payload, source) {
        if (!payload || typeof payload !== 'object') return;
        pushLog({
            direction: 'in',
            type: 'THROW_DETECTED',
            summary: {
                visitId: payload.visit_id,
                visitIndex: payload.visit_index,
                sector: payload.sector,
                ring: payload.ring,
                ok: payload.ok,
                source
            },
            raw: payload
        });
        emit();
    }

    /**
     * Applies a `state`-typed /api/live message — covers BOTH the initial
     * `event: 'hello'` and every subsequent snapshot, since they're the
     * same shape. Always applies the full snapshot first, THEN dispatches
     * on `event` for side effects only — never gated on "did anything
     * change" (re-delivery is permitted, and a same-fields message can
     * still be a real, distinct event).
     */
    function applyLiveState(msg, source) {
        if (!msg || typeof msg !== 'object') return;
        const phase = msg.status != null ? String(msg.status) : state.opendarts.phase;
        const prevBoardStatus = state.boardStatus;

        state.opendarts.phase = phase;
        state.boardStatus = phaseToBoardStatus(phase);
        state.boardPhase = phaseToBoardPhase(phase);
        state.opendarts.running = phaseToRunning(phase);
        state.opendarts.status = state.boardStatus;
        state.opendarts.calibrating = phase === 'waiting';
        state.errorType = phase === 'camera_error' ? 'camera_error' : null;
        if (msg.n_darts != null) state.opendarts.dartCount = Number(msg.n_darts);

        const darts = Array.isArray(msg.darts) ? msg.darts : [];
        const visitId = msg.visit != null ? msg.visit : null;
        state.opendarts.visitId = visitId;

        emitDetectionStatusEdges(prevBoardStatus, source);

        // A visit change means the diff baseline no longer applies to this
        // visit — start fresh. If `visit` is UNCHANGED across a reconnect,
        // `lastDarts` (persisted, never reset on WS close) still holds what
        // was already scored, so the diff below correctly picks up only
        // darts that landed during the outage.
        if (visitId !== lastVisitId) {
            lastDarts = [];
            lastVisitId = visitId;
            rememberBackfilledVisit(visitId);
        }

        // New-dart detection is a length diff, not an event-name check —
        // covers throw_detected AND a hello that reveals darts thrown
        // while disconnected, uniformly.
        for (let i = lastDarts.length; i < darts.length; i++) {
            commitScoredDart(darts[i], visitId, i, source);
        }
        lastDarts = darts;

        if (msg.event === 'takeout_started') {
            state.lastTakeout = { kind: 'started', at: Date.now(), source };
            pushEvent('TAKEOUT_STARTED', { source: 'opendarts' });
        } else if (msg.event === 'visit_complete' || msg.event === 'manual_reset') {
            // "takeout_finished" is never actually published on this wire
            // (verified against source) despite appearing in the doc's
            // events table — the turn ending IS the real signal.
            state.lastTakeout = { kind: 'finished', at: Date.now(), falseTakeout: false, source };
            pushEvent('TAKEOUT_FINISHED', { falseTakeout: false, source: 'opendarts', via: msg.event });
        } else if (msg.event === 'throw_corrected') {
            darts.forEach((dart, i) => {
                if (!dart || dart.corrected !== true) return;
                const mapped = mapOpenDartsThrow(dart);
                pushLog({
                    direction: 'in',
                    type: 'throw_corrected',
                    summary: { visit: visitId, index: i, sector: dart.sector, ring: dart.ring, value: dart.value, source },
                    raw: dart
                });
                // Board Debug / game-layer awareness only — does NOT rewrite
                // an already-advanced FlightDeck match score. See header.
                pushEvent('THROW_CORRECTED', { visit: visitId, index: i, dart, mapped, source: 'opendarts' });
                if (i === darts.length - 1) {
                    state.lastThrow = {
                        at: Date.now(),
                        sector: dart.sector,
                        ring: dart.ring,
                        value: dart.value,
                        mapped,
                        raw: dart,
                        source: 'opendarts'
                    };
                }
            });
        }
        // Every other event (started/stopped/camera_error/
        // camera_error_cleared/connecting/no_live_capture/hello) needs no
        // extra side effect — the snapshot above already reflects it.

        state.lastEventAt = Date.now();
        emit();
    }

    /**
     * Closes the "missed an entire turn while disconnected" gap: a visit
     * that both started and completed during an outage never appears in
     * any `hello` (hello only ever shows the turn in progress "now"), so
     * it's fetched from history instead. Deduped against backfilledVisitIds
     * so a later reconnect never replays the same visit twice, and safe to
     * race against the live channel — a visit here is by definition already
     * cleared, so it can never also be `hello`'s in-progress one.
     */
    async function backfillRecentVisits(source) {
        try {
            const res = await httpRequest(boardHost, boardPort, 'GET', '/api/live/recent', null, HTTP_TIMEOUT_MS);
            if (!(res.status >= 200 && res.status < 300) || !res.data || !Array.isArray(res.data.visits)) return;
            for (const v of res.data.visits) {
                const visitId = v && v.visit;
                if (visitId == null || backfilledVisitIds.has(visitId)) continue;
                rememberBackfilledVisit(visitId);
                const darts = Array.isArray(v.darts) ? v.darts : [];
                darts.forEach((dart, i) => commitScoredDart(dart, visitId, i, source));
                if (darts.length) {
                    state.lastTakeout = { kind: 'finished', at: Date.now(), falseTakeout: false, source };
                    pushEvent('TAKEOUT_FINISHED', { falseTakeout: false, source: 'opendarts', via: 'recent-backfill' });
                }
            }
        } catch (_) {
            // Best-effort — the live channel is the primary source; this
            // only closes one specific reconnect gap, not a correctness
            // requirement for normal operation.
        }
    }

    /**
     * Diagnostic-only — deliberately does NOT touch boardStatus/boardPhase/
     * running/errorType/phase/status/visitId/dartCount. Those are
     * exclusively /api/live-sourced; this exists only to keep Board Debug's
     * camera/calibration detail populated while the WS is down. Real
     * GET /api/state shape (opendarts/live/server.py's AppState.state_dict)
     * — no top-level status/darts/running/calibrating, hence the different
     * field names from the old (different repo's) diagnostic contract.
     */
    function applyDiagnosticSnapshot(snap) {
        if (!snap || typeof snap !== 'object') return;
        if (snap.calibration != null) state.opendarts.calibration = snap.calibration;
        if (snap.capture_loop != null) state.opendarts.captureLoop = snap.capture_loop;
        if (snap.trigger != null) state.opendarts.trigger = snap.trigger;
        if (snap.packages && snap.packages.count != null) state.opendarts.packagesCount = Number(snap.packages.count);
        if (snap.ad_board_status != null) state.opendarts.adBoardStatus = String(snap.ad_board_status);
        if (snap.websocket_clients != null) state.opendarts.websocketClients = Number(snap.websocket_clients);
        emit();
    }

    async function fetchDiagnosticState() {
        const res = await httpRequest(boardHost, boardPort, 'GET', '/api/state');
        if (res.status >= 200 && res.status < 300 && res.data) {
            applyDiagnosticSnapshot(res.data);
        }
        return res;
    }

    function handleLiveMessage(msg, source) {
        if (!msg || typeof msg !== 'object') return;
        state.lastEventAt = Date.now();

        if (msg.type === 'state') {
            if (msg.event === 'hello') state.lastHelloAt = Date.now();
            applyLiveState(msg, source);
            return;
        }

        if (msg.type === 'THROW_DETECTED') {
            commitThrowDetail(msg, source);
            return;
        }

        // Unknown — still log lightly so nothing silently vanishes.
        pushLog({ direction: 'in', type: msg.type || 'unknown', summary: { source } });
        emit();
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
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        state.connection = 'connecting';
        emit();

        const url = `ws://${boardHost}:${boardPort}/api/live`;
        console.log(`\x1b[36m[OPENDARTS]\x1b[0m Connecting ${url}`);
        ws = new WebSocket(url);

        ws.on('open', () => {
            state.connection = 'open';
            state.lastError = null;
            console.log(`\x1b[36m[OPENDARTS]\x1b[0m Connected ${boardHost}:${boardPort}`);
            stopDiagnosticPoll();
            emit();
            // hello arrives immediately on connect. Backfill runs alongside
            // it (not blocking) to catch any turn that fully completed
            // while this connection was down — see backfillRecentVisits.
            backfillRecentVisits('recent-backfill').catch(() => {});
        });

        ws.on('message', (buf) => {
            let msg;
            try {
                msg = JSON.parse(buf.toString());
            } catch (_) {
                return;
            }
            handleLiveMessage(msg, 'ws');
        });

        ws.on('close', (code, reasonBuf) => {
            const reason = reasonBuf ? reasonBuf.toString() : '';
            state.connection = 'closed';
            state.closeCode = code;
            state.closeReason = reason || null;
            state.boardStatus = null;
            state.boardPhase = null;
            // lastDarts/lastVisitId deliberately NOT reset here — see header
            // ("Darts thrown mid-visit while briefly disconnected").
            console.log(`\x1b[36m[OPENDARTS]\x1b[0m Closed (${code}${reason ? ` ${reason}` : ''})`);
            emit();
            startDiagnosticPoll();
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            state.lastError = err.message;
            console.error(`\x1b[36m[OPENDARTS]\x1b[0m Error:`, err.message);
            emit();
        });
    }

    async function post(path, body, timeoutMs) {
        return httpRequest(boardHost, boardPort, 'POST', path, body, timeoutMs);
    }

    /** OpenDarts often returns HTTP 200 with { ok: false, reason } for its ok/reason-style endpoints. */
    function interpretCommandResult(res) {
        const httpOk = !!(res && res.status >= 200 && res.status < 300);
        if (!httpOk) {
            return {
                ok: false,
                status: res ? res.status : 0,
                error: (res && res.error) || `HTTP ${res && res.status}`
            };
        }
        const data = res.data;
        if (data && typeof data === 'object' && data.ok === false) {
            return {
                ok: false,
                status: res.status,
                error: data.reason || data.error || 'OpenDarts rejected command',
                data
            };
        }
        return { ok: true, status: res.status, data };
    }

    function stopDiagnosticPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startDiagnosticPoll() {
        if (pollTimer || intentionalClose) return;
        if (ws && ws.readyState === WebSocket.OPEN) return;
        pollTimer = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                stopDiagnosticPoll();
                return;
            }
            fetchDiagnosticState().catch(() => {});
        }, DIAGNOSTIC_POLL_MS);
    }

    function start() {
        intentionalClose = false;
        connectWs();
        startDiagnosticPoll();
    }

    function stop() {
        intentionalClose = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        stopDiagnosticPoll();
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

    async function sendCommand(command, payload) {
        const cmd = String(command || '');
        let path = null;
        let body;
        let timeoutMs = HTTP_TIMEOUT_MS;

        if (cmd === 'RESET_PHASE' || cmd === 'reset') {
            path = '/api/reset';
        } else if (cmd === 'start') {
            path = '/api/start';
            timeoutMs = HTTP_LONG_TIMEOUT_MS;
        } else if (cmd === 'stop') {
            path = '/api/stop';
            timeoutMs = HTTP_LONG_TIMEOUT_MS;
        } else if (cmd === 'RECALIBRATE' || cmd === 'calibrate') {
            path = '/api/calibration/refresh';
            timeoutMs = HTTP_LONG_TIMEOUT_MS;
        } else if (cmd === 'restart') {
            path = '/api/restart';
        } else if (cmd === 'THROW_CORRECTED' || cmd === 'throws/correct') {
            // POST /api/visits/{visit}/throws/{index}/correct — visit/index
            // are URL PATH params here, not body fields. Body: {ring
            // (required), sector?, source?, note?} using OD's INTERNAL ring
            // vocabulary (bull/outer_bull/single_inner/treble/single_outer/
            // double/outside — "outside", not "miss"), never the wire
            // vocabulary darts[] uses. See server.js's
            // openDartsCorrectionFields.
            if (!payload || payload.visit == null || payload.index == null || !payload.ring) {
                return { ok: false, error: 'correct requires visit, index, and ring' };
            }
            path = `/api/visits/${encodeURIComponent(payload.visit)}/throws/${encodeURIComponent(payload.index)}/correct`;
            body = { ring: payload.ring, source: payload.source || 'manual' };
            if (payload.sector != null) body.sector = String(payload.sector);
            if (payload.note != null) body.note = payload.note;
        } else if (cmd === 'throws/clear' || cmd === 'CLEAR_THROWS') {
            // Clears the current visit/takeout state — NOT a delete of saved data.
            path = '/api/reset';
        } else if (cmd === 'throws/delete' || cmd === 'DELETE_THROW') {
            // No per-throw delete endpoint exists on this API. The only
            // deletion surface is DELETE /api/packages/delete-all, which
            // wipes EVERY saved package at once — deliberately not wired
            // here, a drop-in mapping would destroy a whole session's
            // corpus on one UI click. Surface as unsupported instead of
            // improvising.
            return {
                ok: false,
                error: 'OpenDarts has no per-throw delete endpoint (only delete-all, which removes every saved package) — unsupported'
            };
        } else {
            return { ok: false, error: `Unsupported OpenDarts command: ${cmd}` };
        }

        pushLog({
            direction: 'out',
            type: cmd,
            summary: { sending: true, path, body: body || null, timeoutMs }
        });
        emit();

        try {
            // Calibrate needs live cams — if Start never ran / cameras aren't
            // open, fail fast with a clear reason instead of OD's own no-op.
            if (cmd === 'RECALIBRATE' || cmd === 'calibrate') {
                try {
                    const st = await httpRequest(boardHost, boardPort, 'GET', '/api/state', null, HTTP_TIMEOUT_MS);
                    const running = !!(st.data && st.data.capture_loop && st.data.capture_loop.running);
                    if (!running) {
                        const err = 'Cameras not running — hit Start before Calibrate';
                        pushLog({ direction: 'out', type: cmd, summary: { ok: false, path, error: err } });
                        emit();
                        return { ok: false, path, error: err };
                    }
                } catch (_) { /* proceed; calibrate will report its own error */ }
            }

            const res = await post(path, body, timeoutMs);
            const interpreted = interpretCommandResult(res);
            pushLog({
                direction: 'out',
                type: cmd,
                summary: {
                    ok: interpreted.ok,
                    status: interpreted.status,
                    path,
                    error: interpreted.ok ? null : interpreted.error
                },
                raw: res
            });
            // Gameplay-critical fields (boardStatus/boardPhase/dartCount/...)
            // are never guessed from a REST response here — /api/live pushes
            // the authoritative update on its own. This poll is
            // diagnostic-only (camera counts, etc.).
            try {
                await fetchDiagnosticState();
            } catch (_) {}
            emit();
            console.log(
                `\x1b[36m[OPENDARTS]\x1b[0m Command ${cmd} →`,
                interpreted.ok
                    ? `ok ${path} (${interpreted.status})`
                    : `fail ${path} (${interpreted.error || interpreted.status})`
            );
            return {
                ok: interpreted.ok,
                status: interpreted.status,
                path,
                error: interpreted.ok ? undefined : interpreted.error
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

    /** PATCH /api/config {idle_timeout_sec} — NOTE this is a real behavioral
     *  difference from Autodarts' setStandbyMinutes: OD doesn't have a
     *  low-power camera-standby mode, this auto-STOPS the capture loop after
     *  N idle seconds (same as hitting Stop). Self-heals in practice since
     *  FlightDeck calls /api/start on the next match, but it is not the same
     *  mechanism as Autodarts'. Same [5,10,15,30,60]-minute menu as Autodarts
     *  for UI consistency — OD's own API actually accepts any non-negative
     *  integer of seconds.
     *  Endpoint changed 2026-09-17 (od-ux, commit 8c7a6aa): POST
     *  /api/idle-timeout was retired with no alias in favor of this general
     *  config endpoint. The request is all-or-nothing: 200
     *  {ok:true, changed, persisted, applied_live, restart_required, ...} or
     *  400 {ok:false, errors:{key:reason}} with nothing written.
     *  idle_timeout_sec isn't on OD's restart_required list, so it should
     *  land in applied_live immediately — this driver just checks ok/error,
     *  it doesn't branch on applied_live vs restart_required. */
    async function setStandbyMinutes(minutes) {
        const n = Math.round(Number(minutes));
        if (![5, 10, 15, 30, 60].includes(n)) {
            return { ok: false, error: `standby_minutes must be 5, 10, 15, 30, or 60 (got ${minutes})` };
        }
        try {
            const res = await httpRequest(boardHost, boardPort, 'PATCH', '/api/config', { idle_timeout_sec: n * 60 }, HTTP_TIMEOUT_MS);
            const httpOk = !!(res && res.status >= 200 && res.status < 300 && !(res.data && res.data.ok === false));
            const error = httpOk
                ? null
                : (res && res.data && res.data.errors && res.data.errors.idle_timeout_sec)
                    || (res && res.data && res.data.error)
                    || `HTTP ${res && res.status}`;
            pushLog({
                direction: 'out',
                type: 'SET_STANDBY',
                summary: {
                    ok: httpOk,
                    standby_minutes: n,
                    error
                },
                raw: res && res.data
            });
            emit();
            return httpOk
                ? { ok: true, standbyMinutes: n }
                : { ok: false, error };
        } catch (err) {
            pushLog({ direction: 'out', type: 'SET_STANDBY', summary: { ok: false, error: err.message } });
            emit();
            return { ok: false, error: err.message };
        }
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
        provider: 'opendarts'
    };
}

module.exports = { createOpenDartsDriver };

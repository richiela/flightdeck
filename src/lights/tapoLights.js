const { loginDeviceByIp } = require('tp-link-tapo-connect');
const { loadCredentials } = require('../credentials');

/**
 * Thin Tapo P110/P110M dart-lights driver (manual control first; idle automation later).
 */
function createTapoLights({ dataDir, onUpdate }) {
    let device = null;
    let deviceHost = null;
    let busy = Promise.resolve();

    const state = {
        provider: 'tapo',
        model: 'P110M',
        enabled: false,
        configured: false,
        host: null,
        connection: 'idle',
        on: null,
        nickname: null,
        lastError: null,
        lastOkAt: null,
        credentialSource: null
    };

    function emit() {
        if (typeof onUpdate === 'function') onUpdate(getPublicState());
    }

    function getPublicState() {
        return { ...state };
    }

    function reloadConfig() {
        const creds = loadCredentials(dataDir);
        const tapo = creds.tapo;
        state.enabled = !!tapo.enabled;
        state.configured = !!tapo.configured;
        state.host = tapo.host || null;
        state.model = tapo.model || 'P110M';
        state.credentialSource = creds.source;
        if (!tapo.configured) {
            state.connection = 'unconfigured';
            state.lastError = 'Add tapo.email + tapo.password (+ host) in data/credentials.json';
            device = null;
            deviceHost = null;
        } else if (!tapo.enabled) {
            state.connection = 'disabled';
            state.lastError = null;
        }
        return tapo;
    }

    async function ensureDevice() {
        const tapo = reloadConfig();
        if (!tapo.enabled) {
            throw new Error('Tapo lights disabled in credentials');
        }
        if (!tapo.configured) {
            throw new Error(state.lastError || 'Tapo not configured');
        }
        if (device && deviceHost === tapo.host) return device;

        state.connection = 'connecting';
        emit();
        device = await loginDeviceByIp(tapo.email, tapo.password, tapo.host);
        deviceHost = tapo.host;
        state.connection = 'open';
        state.lastError = null;
        return device;
    }

    function applyInfo(info) {
        if (!info || typeof info !== 'object') return;
        if (typeof info.device_on === 'boolean') state.on = info.device_on;
        else if (typeof info.deviceOn === 'boolean') state.on = info.deviceOn;
        if (info.nickname) state.nickname = String(info.nickname);
        if (info.model) state.model = String(info.model);
        state.lastOkAt = Date.now();
        state.connection = 'open';
        state.lastError = null;
    }

    function enqueue(fn) {
        const run = busy.then(fn, fn);
        busy = run.catch(() => {});
        return run;
    }

    async function refresh() {
        return enqueue(async () => {
            try {
                const dev = await ensureDevice();
                const info = await dev.getDeviceInfo();
                applyInfo(info);
                emit();
                return { ok: true, on: state.on };
            } catch (err) {
                state.connection = 'error';
                state.lastError = err.message || String(err);
                device = null;
                deviceHost = null;
                emit();
                return { ok: false, error: state.lastError };
            }
        });
    }

    async function turnOn() {
        return enqueue(async () => {
            try {
                const dev = await ensureDevice();
                await dev.turnOn();
                state.on = true;
                state.lastOkAt = Date.now();
                state.connection = 'open';
                state.lastError = null;
                emit();
                try {
                    const info = await dev.getDeviceInfo();
                    applyInfo(info);
                    emit();
                } catch (_) {}
                return { ok: true, on: true };
            } catch (err) {
                state.connection = 'error';
                state.lastError = err.message || String(err);
                device = null;
                deviceHost = null;
                emit();
                return { ok: false, error: state.lastError };
            }
        });
    }

    async function turnOff() {
        return enqueue(async () => {
            try {
                const dev = await ensureDevice();
                await dev.turnOff();
                state.on = false;
                state.lastOkAt = Date.now();
                state.connection = 'open';
                state.lastError = null;
                emit();
                try {
                    const info = await dev.getDeviceInfo();
                    applyInfo(info);
                    emit();
                } catch (_) {}
                return { ok: true, on: false };
            } catch (err) {
                state.connection = 'error';
                state.lastError = err.message || String(err);
                device = null;
                deviceHost = null;
                emit();
                return { ok: false, error: state.lastError };
            }
        });
    }

    async function toggle() {
        return enqueue(async () => {
            try {
                const dev = await ensureDevice();
                if (state.on == null) {
                    const info = await dev.getDeviceInfo();
                    applyInfo(info);
                }
                if (state.on) {
                    await dev.turnOff();
                    state.on = false;
                } else {
                    await dev.turnOn();
                    state.on = true;
                }
                state.lastOkAt = Date.now();
                state.connection = 'open';
                state.lastError = null;
                emit();
                try {
                    const info = await dev.getDeviceInfo();
                    applyInfo(info);
                    emit();
                } catch (_) {}
                return { ok: true, on: state.on };
            } catch (err) {
                state.connection = 'error';
                state.lastError = err.message || String(err);
                device = null;
                deviceHost = null;
                emit();
                return { ok: false, error: state.lastError };
            }
        });
    }

    function start() {
        reloadConfig();
        emit();
        if (state.enabled && state.configured) {
            refresh().catch(() => {});
        }
    }

    return {
        start,
        refresh,
        turnOn,
        turnOff,
        toggle,
        getPublicState,
        reloadConfig
    };
}

module.exports = { createTapoLights };

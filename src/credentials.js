const fs = require('fs');
const path = require('path');

/**
 * Unified local secrets / device auth.
 * data/credentials.json (gitignored via data/) — preferred home for Tapo (and later Scolia).
 * Shape: { "tapo": { "email", "password", "host", "enabled?", "model?" } }
 * Optional legacy: data/tapo.json merged under credentials.tapo if present.
 */
function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`Failed to read ${filePath}:`, err.message);
        return null;
    }
}

function normalizeTapo(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const email = String(src.email || src.username || '').trim();
    const password = String(src.password || '');
    // No default host. `configured` below requires one, so an install that
    // supplies credentials but no address reports "unconfigured" and says so,
    // rather than silently trying to log into whatever address happened to be
    // baked in here.
    const host = String(src.host || src.ip || '').trim();
    const enabled = src.enabled !== false;
    return {
        email,
        password,
        host,
        enabled,
        model: String(src.model || 'P110M'),
        configured: !!(email && password && host)
    };
}

function loadCredentials(dataDir) {
    const unified = readJsonSafe(path.join(dataDir, 'credentials.json')) || {};
    const legacyTapo = readJsonSafe(path.join(dataDir, 'tapo.json'));
    const tapo = normalizeTapo(unified.tapo || legacyTapo || {});
    return {
        tapo,
        // scolia stays in scolia.json for now; migrate later into credentials.scolia
        source: unified.tapo ? 'credentials.json' : (legacyTapo ? 'tapo.json' : null)
    };
}

module.exports = { loadCredentials, normalizeTapo };

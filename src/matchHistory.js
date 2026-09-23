/**
 * Append-only match history (JSONL under data/).
 * One line per finished match; filter by gameType for leaderboards.
 */
const fs = require('fs');
const path = require('path');

const MATCHES_FILE = 'matches.jsonl';

function matchesPath(dataDir) {
    return path.join(dataDir, MATCHES_FILE);
}

function ensureDataDir(dataDir) {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function appendMatch(dataDir, record) {
    if (!record || typeof record !== 'object') return { ok: false, error: 'invalid record' };
    try {
        ensureDataDir(dataDir);
        fs.appendFileSync(matchesPath(dataDir), `${JSON.stringify(record)}\n`, 'utf8');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function readAllMatches(dataDir) {
    const file = matchesPath(dataDir);
    if (!fs.existsSync(file)) return [];
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
        return [];
    }
    const out = [];
    raw.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') out.push(parsed);
        } catch (_) {
            /* skip corrupt line */
        }
    });
    return out;
}

/**
 * Top scores for a game type. Higher totalScore first; earlier playedAt wins ties.
 */
function topMatches(dataDir, gameType, limit = 5) {
    const cap = Math.max(1, Number(limit) || 5);
    return readAllMatches(dataDir)
        .filter((m) => m && m.gameType === gameType && Number.isFinite(Number(m.totalScore)))
        .sort((a, b) => {
            const scoreDiff = Number(b.totalScore) - Number(a.totalScore);
            if (scoreDiff !== 0) return scoreDiff;
            const at = Date.parse(a.playedAt) || 0;
            const bt = Date.parse(b.playedAt) || 0;
            return at - bt;
        })
        .slice(0, cap);
}

module.exports = {
    appendMatch,
    readAllMatches,
    topMatches,
    MATCHES_FILE
};

/**
 * Engine registry.
 *
 * Games register themselves here instead of being named in a switch. Adding a
 * game means adding a file and a line in ENGINE_FILES; nothing else in the
 * codebase needs to learn its name.
 *
 * Load order matters and is not circular:
 *
 *     core.js          knows no game
 *     <game>.js        requires core
 *     index.js         requires the games, then hands the registry to core
 *     gameEngines.js   requires index
 *
 * core never requires a game. It receives the registry (setEngineRegistry) so
 * that shared code — the round-announce banner, for one — can ask a game about
 * itself rather than switching on its name.
 */
const core = require('./core');

/**
 * `optional: true` means the module may be absent from a build. Absence
 * must not be an error: a game missing from venueConfig's ALL_GAMES is
 * rejected before any engine call.
 */
const ENGINE_FILES = [
    { name: 'demolition', path: './demolition' },
    { name: 'limbo', path: './limbo' },
    { name: 'derby', path: './derby' },
    { name: 'killer', path: './killer' },
    { name: 'quackshot', path: './quackshot' },
    { name: 'shanghai', path: './shanghai' },
    { name: 'cricket', path: './cricket' },
    { name: 'x01', path: './x01' },
    { name: 'warmup', path: './warmup' },
    { name: 'quick10', path: './quick10' },
];

function loadOptional(path, name) {
    try {
        return require(path);
    } catch (err) {
        const missingSelf = err
            && err.code === 'MODULE_NOT_FOUND'
            && String(err.message).includes(path.replace('./', ''));
        if (!missingSelf) throw err;
        // Absent by design. Reading any name off this gives a function that
        // explains itself, rather than "x is not a function" several frames
        // from the cause.
        return new Proxy({}, {
            get(_t, prop) {
                if (prop === 'meta' || prop === '__absent') return undefined;
                return function engineNotInThisBuild() {
                    throw new Error(
                        `engine "${name}" is not part of this build (called ${String(prop)}).`
                    );
                };
            }
        });
    }
}

const REGISTRY = {};
for (const spec of ENGINE_FILES) {
    REGISTRY[spec.name] = spec.optional
        ? loadOptional(spec.path, spec.name)
        : require(spec.path);
}

core.setEngineRegistry(REGISTRY);

/** The engine for a game, or null when it is unknown. */
function getEngine(gameType) {
    return Object.prototype.hasOwnProperty.call(REGISTRY, gameType)
        ? REGISTRY[gameType]
        : null;
}

/** Game names this build can actually play. */
function registeredGames() {
    return ENGINE_FILES.map((s) => s.name);
}

module.exports = { REGISTRY, getEngine, registeredGames };

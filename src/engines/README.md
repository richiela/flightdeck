# engines/

One file per game. Rules, scoring and timing only — no DOM, no HTML, no CSS.
The view layer reads the state these produce and knows nothing about how they
are organised.

    index.js         the layer's front door — server.js requires this and
                     nothing else here. Throw simulation, game setup, the
                     scheduled-action dispatch, debug previews.
    registry.js      the one place games are listed
    core.js          primitives every game uses; knows no game's name
    <game>.js        one file per game

Extracted from a single 5,156-line `gameEngines.js`, which is now `index.js`
here — it moved in so the whole subsystem lives in one directory with one way in.

## Adding a game

Write `engines/<name>.js`, add a line to `ENGINE_FILES` in `registry.js`, and
add the name to `ALL_GAMES` in `../venueConfig.js` so it can be selected. Nothing
else learns the name — not `index.js`, not `core.js`.

An engine exports whatever it needs of:

| export | purpose |
|---|---|
| `init(ordered, options, players)` | initial state for a singles lineup |
| `initDoubles(players, options)` | initial state for a doubles lineup; omit if the game has no doubles variant |
| `handleThrow(gameData, throwSpec, throwSource)` | score a dart |
| `handleAction(gameData, payload)` | the game's own controls; return null if the action is not yours |
| `aimNumber(gameData)` | what a bot aims at; omit for "no opinion" |
| `aimedThrow(gameData, profileId, roll)` | aim in some way other than at a number |
| `activeThrower(gameData)` | who is throwing, when it is not the singles default |
| `meta` | round vocabulary — see below |

Everything is optional. A game that exports only `init` and `handleThrow` works.

## meta

The shared round-start banner is assembled from what a game declares, rather
than from a switch on its name:

```js
const meta = {
    maxRounds: 8,                          // final-round detection
    roundEyebrow: 'SCROLL ROUND',          // banner label
    roundMultiplier: (r) => (r >= 8 ? 2 : 1),
    roundSubtitle: (r) => `AIM FOR ${r}`,
    lastRoundTag: 'FINAL FURLONG',         // default 'FINAL ROUND'
    multiplierTags: { 2: 'DOUBLE MARKS' }, // default DOUBLE/TRIPLE POINTS
    openEndedRounds: true                  // no fixed length (cricket)
};
```

## The dependency arrow points one way

    src/server.js  ->  engines/index.js  ->  <game>.js  ->  core.js
                          \-> registry.js

`core.js` must never require a game, and games should not require each other.
Core receives the registry (`setEngineRegistry`) so shared code can ask a game
about itself without importing it. Anything two games need belongs in core.



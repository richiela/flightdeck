# FlightDeck Changelog

Keep **`## Unreleased`** at the **bottom** current between releases — that is the pending-changes list for the side window.

---

## v0.19.1 — FlightDeck.v0.19.1 (Sep 8, 2026)

- First public commit. Dartboard control panel + viewer display for a multi-game dart kiosk: Demolition, Limbo, Derby, Killer, Quackshot, Shanghai, Cricket, X01, Quick 10, and Warm Up, with player registration/avatars, board-provider integrations (Scolia, Autodarts, OpenDarts), dart lights automation, and per-venue configuration.

## v0.19.2 — FlightDeck.v0.19.2 (Sep 14, 2026)

- **Dart-callout modes**: `dartCalloutMode` in `data/venue.json` (`'card' | 'sound' | 'both' | 'off'`) — `'sound'` plays a callout clip the instant a dart lands instead of showing the on-screen card, with zero added delay to gameplay; `'both'` does both. Cricket's mark-hit callout always shows regardless — it's a separate game mechanic, not gated by this setting.
- **Local TTS voice packs**: `public/assets/sounds/callouts/{Bella,Daniel}/` ship full 63-clip callout dictionaries generated locally via Kokoro TTS (Apache-2.0, freely redistributable — unlike the example video clips, no removal-before-shipping caveat applies here). `scripts/generate-callout-sounds.py` regenerates the set or adds another voice. Which voice plays is `dartCalloutVoice` in `data/venue.json` (not yet exposed in any UI).

## v0.20.0 — FlightDeck.v0.20.0 (Sep 18, 2026)

- **Game engines split per game.** `gameEngines.js` (5,156 lines) became `engines/<game>.js`, one module each, plus `engines/core.js` for shared primitives and `engines/index.js` as the registry. Adding a game is now a file, a registry line, and an `ALL_GAMES` entry — no dispatch to edit. Engines declare their own round vocabulary in `meta`, so shared code no longer switches on game type; there are zero game-specific branches left outside `engines/`.
- **Engine test suite.** `npm test` drives every game through scripted deterministic throws — singles and doubles, 21 runs — and compares state hashes against recorded baselines. Behaviour is byte-identical to before the split.
- Configure: Dart Callout Voice stays under Mode (greyed/disabled unless mode is Sound or Both); Card duration also stays put instead of hiding.
- Limbo stage characters: CSS giraffes replaced with user-supplied dinos (`dino-blue.png` / `dino-red.png`).
- Quackshot: static duck gallery replaced with a live London-ratio dartboard (numbers + scoring key; round pill kept).
- Quackshot: event overlay now waits for the viewer's segment flash to finish instead of landing on top of it.
- Retired unreferenced art (dino source/reference variants, the pre-dino giraffe backup, two duck-gallery SVGs).

## v0.20.1 — FlightDeck.v0.20.1 (Sep 18, 2026)

- **One place to set the version.** `package.json` is now the only file that carries it: `server.js` derives `APP_VERSION` from it and broadcasts it as `state.appVersion`, and both HTML badges fill from that. It was previously four hand-synced copies, two of which (the badges people actually see) were not connected to the server's value at all.
- **`consoleTee.js` folded into `server.js`**, 141 lines down to ~60, and taken off the hot path: log writes go through a stream instead of `fs.writeSync`, and rotation is checked on a timer rather than on every `console.*` call. Blocking disk I/O no longer sits on the event loop that scores darts.
- **Application code moved to `src/`** (`server.js`, `engines/`, `board/`, `lights/`, and the config modules). Root keeps metadata, `public/`, and the runtime dirs. `server.js` resolves those through a single `ROOT` constant; nodemon now watches all of `src`, so engine edits restart the server.
- **`gameEngines.js` became `src/engines/index.js`**, the engine layer's front door, and the registry moved to `src/engines/registry.js`. `server.js` requires `./engines` and nothing else under it — one way in, where there were two.
- README: documented why `data/` files are not created for you, added an "Adding a game" section covering the engine layout and `npm test`, and fixed a markdown error plus a passage that contradicted itself.

## v0.21.1 — FlightDeck.v0.21.1 (Sep 21, 2026)

- **Configure opens from every screen**, not just Registration, and has moved into the header. The lights box is hidden when Tapo is unset rather than offering controls for hardware that is not there.
- **The first dart of a visit now gets a callout.** It was being skipped. The announcer also stopped re-fetching and decoding the clip on every dart — the audio is loaded once and reused, so a callout no longer costs a fetch and a decode per throw.
- **`run.sh` supervises and restarts.** It stays up across a crash instead of exiting, and it pulls only when asked (`scripts/update-policy.js`) rather than on every start — a rig mid-session no longer picks up code nobody chose to deploy.
- `run.sh` checks for node, npm and openssl up front and names whichever is missing, instead of failing partway through with a less obvious error.
- Fix: saving venue settings clobbered the configured board provider, silently reverting it. The rest of the config save was unguarded the same way and is now covered too.
- Fix: `run.sh` forced mock mode over a configured board, so a real board was never used.
- Fix: a sentence in the published README was invisible. A public block whose closing marker sat at the end of a prose line stopped matching, leaving the block wrapped in an HTML comment — "Ten games ship out of the box" never rendered for anyone reading the public repo.
- README: Quick start names the prerequisites (node 18+, npm, openssl).
- `package-lock.json` regenerated so it carries the real version.

## Unreleased — since FlightDeck.v0.21.1


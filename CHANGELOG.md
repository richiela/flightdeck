# FlightDeck Changelog

Keep **`## Unreleased`** at the **bottom** current between releases — that is the pending-changes list for the side window.

---

## v0.19.1 (Sep 8, 2026)

- First public commit. Dartboard control panel + viewer display for a multi-game dart kiosk: Demolition, Limbo, Derby, Killer, Quackshot, Shanghai, Cricket, X01, Quick 10, and Warm Up, with player registration/avatars, board-provider integrations (Scolia, Autodarts, OpenDarts), dart lights automation, and per-venue configuration.

## v0.19.2 (Sep 14, 2026)

- **Dart-callout modes**: `dartCalloutMode` in `data/venue.json` (`'card' | 'sound' | 'both' | 'off'`) — `'sound'` plays a callout clip the instant a dart lands instead of showing the on-screen card, with zero added delay to gameplay; `'both'` does both. Cricket's mark-hit callout always shows regardless — it's a separate game mechanic, not gated by this setting.
- **Local TTS voice packs**: `public/assets/sounds/callouts/{Bella,Daniel}/` ship full 63-clip callout dictionaries generated locally via Kokoro TTS (Apache-2.0, freely redistributable — unlike the example video clips, no removal-before-shipping caveat applies here). `scripts/generate-callout-sounds.py` regenerates the set or adds another voice. Which voice plays is `dartCalloutVoice` in `data/venue.json` (not yet exposed in any UI).

## v0.20.0 (Sep 18, 2026)

- **Game engines split per game.** `gameEngines.js` (5,156 lines) became `engines/<game>.js`, one module each, plus `engines/core.js` for shared primitives and `engines/index.js` as the registry. Adding a game is now a file, a registry line, and an `ALL_GAMES` entry — no dispatch to edit. Engines declare their own round vocabulary in `meta`, so shared code no longer switches on game type; there are zero game-specific branches left outside `engines/`.
- **Engine test suite.** `npm test` drives every game through scripted deterministic throws — singles and doubles, 21 runs — and compares state hashes against recorded baselines. Behaviour is byte-identical to before the split.
- Configure: Dart Callout Voice stays under Mode (greyed/disabled unless mode is Sound or Both); Card duration also stays put instead of hiding.
- Limbo stage characters: CSS giraffes replaced with user-supplied dinos (`dino-blue.png` / `dino-red.png`).
- Quackshot: static duck gallery replaced with a live London-ratio dartboard (numbers + scoring key; round pill kept).
- Quackshot: event overlay now waits for the viewer's segment flash to finish instead of landing on top of it.
- Retired unreferenced art (dino source/reference variants, the pre-dino giraffe backup, two duck-gallery SVGs).

## v0.20.1 (Sep 18, 2026)

- **One place to set the version.** `package.json` is now the only file that carries it: `server.js` derives `APP_VERSION` from it and broadcasts it as `state.appVersion`, and both HTML badges fill from that. It was previously four hand-synced copies, two of which (the badges people actually see) were not connected to the server's value at all.
- **`consoleTee.js` folded into `server.js`**, 141 lines down to ~60, and taken off the hot path: log writes go through a stream instead of `fs.writeSync`, and rotation is checked on a timer rather than on every `console.*` call. Blocking disk I/O no longer sits on the event loop that scores darts.
- **Application code moved to `src/`** (`server.js`, `engines/`, `board/`, `lights/`, and the config modules). Root keeps metadata, `public/`, and the runtime dirs. `server.js` resolves those through a single `ROOT` constant; nodemon now watches all of `src`, so engine edits restart the server.
- **`gameEngines.js` became `src/engines/index.js`**, the engine layer's front door, and the registry moved to `src/engines/registry.js`. `server.js` requires `./engines` and nothing else under it — one way in, where there were two.
- README: documented why `data/` files are not created for you, added an "Adding a game" section covering the engine layout and `npm test`, and fixed a markdown error plus a passage that contradicted itself.

## v0.21.1 (Sep 21, 2026)

- **Configure opens from every screen**, not just Registration, and has moved into the header. The lights box is hidden when Tapo is unset rather than offering controls for hardware that is not there.
- **The first dart of a visit now gets a callout.** It was being skipped. The announcer also stopped re-fetching and decoding the clip on every dart — the audio is loaded once and reused, so a callout no longer costs a fetch and a decode per throw.
- **`run.sh` supervises and restarts.** It stays up across a crash instead of exiting, and it pulls only when asked (`scripts/update-policy.js`) rather than on every start — a rig mid-session no longer picks up code nobody chose to deploy.
- `run.sh` checks for node, npm and openssl up front and names whichever is missing, instead of failing partway through with a less obvious error.
- Fix: saving venue settings clobbered the configured board provider, silently reverting it. The rest of the config save was unguarded the same way and is now covered too.
- Fix: `run.sh` forced mock mode over a configured board, so a real board was never used.
- Fix: a sentence in the published README was invisible. A public block whose closing marker sat at the end of a prose line stopped matching, leaving the block wrapped in an HTML comment — "Ten games ship out of the box" never rendered for anyone reading the public repo.
- README: Quick start names the prerequisites (node 18+, npm, openssl).
- `package-lock.json` regenerated so it carries the real version.

## v0.21.2 (Sep 26, 2026)

- Fix: in Derby, a player whose horse crosses the finish line has finished their visit. The "Finds the Post / Official Result" screen already said so, but the game kept waiting for the rest of that player's darts — darts that could not change anything — so when they were last in the round it looked like a hang. The next player's darts now count once the finisher's dart has been pulled from the board.
- Fix: `run.sh` waits for the network, up to 90 seconds, before an auto-update pull. After a reboot the pull ran before the network was up, failed, and started the existing code, so auto-update never updated anything after a power cycle.
- Fix: `run.sh` chooses between the mock and the real board every time it starts the server, so adding or changing `data/board.json` takes effect on the next restart. It used to decide once, when `run.sh` itself started.

## v0.21.3 (Sep 26, 2026)

- **Calls start with the word.** The callout clips were generated with up to 0.4 s of silence before the speech. Both voices are regenerated with that silence trimmed, so every call now starts within a few hundredths of a second, and `scripts/generate-callout-sounds.py` trims it for any voice you add.
- **Dart calls and cards land sooner.** The server sends a small `DART_ANNOUNCE` message the moment it applies a dart, ahead of the full game state, and the viewer passes it straight to the game, so the call and the card no longer wait for the whole state, roster photos included, to arrive, be parsed and be redrawn. The full state still follows and stays authoritative, including for taking the card down. Cricket's mark card still comes from the state, since it needs the mark animation.
- **Calls play through Web Audio.** Every callout clip is decoded up front and started from its buffer, so a call has nothing left to prepare when a dart lands; plain HTML audio remains the fallback for a browser that holds audio until someone clicks. A near-silent keep-alive tone stops an HDMI TV or speaker dozing between darts and clipping the first word of the next call.
- **After updating, reload the viewer page** — restarting the server is not enough. A viewer or kiosk keeps the old call-and-card code in memory until its page reloads.

## v0.22.0 (Sep 29, 2026)

- **New game: Around the World** (Classic tab). Hit 1, 2, 3 … 20 in order, then the bull; any bed of the number counts, and the score is the number of darts it takes. One to six players, or doubles teams sharing a route. When someone lands, the rest of that round gets its last visit, then fewest darts wins; anyone still travelling ranks by how far they got. The screen shows each player's route as a strip of stops, and a flight-plan card maps the thrower's route on the board.
- Engines can declare their own scheduled steps (`scheduled`) and debug previews (`debugPreviewPhase`), so a new game's turn flow needs no case in `engines/index.js`. Around the World's variants (route, how far a dart moves you, when the game ends) are data in its engine, ready for more.
- Around the World's route strip shows, in each cleared stop, how many darts it took to close out.
- **Around the World leaderboard: fewest darts.** Every person who completes the route gets an entry; Control's Leaderboard button shows it on the viewer as a departures board. Bots and doubles teams stay off it, and a result that needed a debug dart or a score correction is saved but marked, the same as Quick 10's. A leaderboard is now something any game can declare (`meta.leaderboard` plus `buildMatchRecords`), in either direction; a result re-saved after a correction replaces the first.
- **Around the World background:** Nicolaes Visscher's 17th-century world map (public domain, via Europeana on Unsplash); credit in `public/assets/aroundtheworld/CREDITS.md`.
- **After updating, reload the viewer and Control pages** — restarting the server is not enough to pick up the new game pages and backgrounds.

## v0.23.0 (Oct 1, 2026)

- **Registration camera framing per device.** Front cameras differ a lot (an iPad's is ultra-wide, a phone's narrow), so one fixed framing put iPad users far away and phone users too close. Control now asks each camera for its widest view, and a − / + zoom on the camera box sets the framing; each device remembers its own, starting from a guess for its kind (iPad tighter, phones wider). The ring shows exactly the square the photo is cut from. Zooming out goes all the way to the camera's full height: the ring grows to nearly the height of the camera box, and past the point where the picture can still fill the box it shrinks inside it, so a face fits even on a narrow camera. A camera that can zoom below 1× in hardware — some Android front cameras — goes wider still. Tap the zoom level to see the camera's resolution and zoom range.
- The camera view is mirrored like a selfie camera, so people move the way they expect, and the saved photo is mirrored to match, so it doesn't flip when it's taken.
- **A front door.** Going to the server's plain address (`https://<host>:4000/`) now offers the two screens, Control and Viewer, instead of a 404.
- Take Photo counts down 3, 2, 1 over the ring, then the whole screen flashes white — lighting the player's face, and making it obvious the photo was taken — and the photo is taken while it's lit. The button reads Cancel during the countdown.
- **Light support removed from FlightDeck.** The cabinet lights and TV belong to the kiosk now, driven from OpenDarts' capture state and FlightDeck's game state, so FlightDeck no longer controls a Tapo plug: the lights box and buttons are gone from Control's Board Debug, nothing switches lights when detection starts or stops, and `tapo` in `data/credentials.json` is no longer read (it can be deleted). Starting the board's detection when Control is used is unchanged.
- Fix: swiping the game cards on Control did nothing inside Fully Kiosk Browser on Android (it scrolled fine in Chrome). Control now scrolls the row itself, with a short glide, when a sideways swipe hasn't moved it — wherever the browser scrolls it natively, nothing changes.
- **After updating, reload the viewer and Control pages** — the camera, front-door and swipe changes live in the pages, so restarting the server alone does not pick them up.

## Unreleased — since v0.23.0

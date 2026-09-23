# flightdeck

A control panel + kiosk display for running a real dartboard as a party/venue
game system, inspired by [Flight Club](https://flightclubdarts.com/). This is a personal fan project,
not affiliated with or endorsed by Flight Club — built for my own dartboard
because I wanted that kind of experience at home. Some of the game names
(Killer, Shanghai, Cricket, X01) are just standard, decades-old pub-darts
terms that predate any single venue. A few others (Demolition, Derby, Limbo,
Quackshot) are closer to Flight Club's own naming.

One screen (**Control**) for the operator to register players, pick a game,
and manage the match; a second screen (**Viewer**) for the big display
everyone actually watches while playing. Obviously, you can just have a laptop
next to you with two tabs open too.

Ten games ship out of the box — Demolition, Limbo, Derby, Killer, Quackshot,
Shanghai, Warm Up, Quick 10, X01, and Cricket — with
player registration, avatar capture, and per-venue configuration (idle
timeouts, callout duration, which games are enabled).

## Quick start

No hardware required — runs against a mock board so you can see every game
end to end.

You need node 18+, npm and openssl installed already — `run.sh` checks for
all three up front and tells you exactly what is missing.

```bash
git clone <this-repo-url>
cd flightdeck
./run.sh
```

That installs dependencies, generates a local self-signed TLS cert on first
run, and starts the server. Open `https://localhost:4000/control.html`
(accept the self-signed cert warning) — that's the operator panel. Point a
second screen or window at `https://localhost:4000/viewer.html` for the
display everyone watches.  We need SSL for camera support.. BOO!

`PORT=5000 ./run.sh` to use a different port.

## Real hardware

FlightDeck talks to three dartboard scoring systems:

- **[Scolia](https://scoliadarts.com/)** — cloud-connected, the default provider
- **[Autodarts](https://autodarts.io/)** — local Board Manager, self-hosted
- **[OpenDarts](https://github.com/richiela/opendarts)** — an opensource dart scoring program

Pick one from Control's Board Debug panel, or set it in `data/board.json`.
Each provider needs its own host/port; see `src/board/createBoardDriver.js`
for the exact config shape.

## Configuration

Everything venue-specific lives in `data/` (gitignored, never committed):

| File | What |
|---|---|
| `board.json` | Which board provider is active, and its host/port |
| `venue.json` | Arena name, idle timeouts, dart-callout duration, which games are enabled |
| `players.json` | Registered player roster + avatars |
| `credentials.json` | Third-party device credentials (e.g. smart-plug dart lights) |
| `scolia.json` | Scolia board credentials (`serialNumber` + `accessToken`), if using that provider |

**None of these are created for you, and that is deliberate.** Running the app
doesn't write them; they appear the first time you change the corresponding
setting (through Control's Configure panel, or Board Debug for `board.json`).
Until then the code simply uses its built-in defaults, from `src/venueConfig.js`
and `src/board/createBoardDriver.js`.

The reason is that a config file, once written, wins forever. If the app
generated `venue.json` on first boot, every later improvement to a default —
a better idle timeout, a newly enabled game — would be silently ignored on
every existing install, because a file written months ago would still be
overriding it. "File absent" meaning "follow current defaults" is what keeps
upgrades working without a migration step.

So you only need to create one of these by hand if you want to set something
without going through the UI. `data/venue.json` is the usual one, and it is a
partial override — include only the keys you care about:

```jsonc
{
  "arenaName": "The Tungsten Arms",
  "dartCalloutMs": 1200,
  "dartCalloutMode": "card",     // 'card' | 'sound' | 'both' | 'off'
  "registrationIdleMs": 600000,  // release the avatar camera after 10 min idle
  "inGameIdleMs": 600000,        // allow display sleep after 10 min idle
  "boardStandbyMinutes": 30,     // Autodarts/OpenDarts camera standby
  "games": { "killer": false }   // list only what you turn off
}
```

`DEFAULT_VENUE` in `src/venueConfig.js` is the full list of keys and their current
values.

## Videos

Winner screens, busts, and eliminations can play a short video instead of
just a text overlay — create your own trash talking videos!! `public/assets/`
ships with a handful of example clips wired up so you can see the feature
working the moment you clone this.

**Those clips are examples I don't hold the rights to.**
They're here purely to demonstrate what the feature can do, not as content
you're meant to keep or redistribute.
**Delete them and drop in your own clips** before you use this
for real, and definitely before forking this into your own public repo.
Point a game's config at any `.mp4` the same way — see
`public/games/event-videos.js` and each game's own HTML for where the
paths are wired up.

## Sounds

Each dart thrown can also get an audible callout ("triple twenty", "bust",
etc.) instead of, or alongside, the on-screen callout card — set
`dartCalloutMode` (`'card' | 'sound' | 'both' | 'off'`) in `data/venue.json`.

Unlike the video clips above, **the callout audio needs no disclaimer**:
`public/assets/sounds/callouts/{Bella,Daniel}/` are locally-generated
synthetic speech, made with Kokoro TTS (Apache-2.0) — not third-party
recordings, so there's nothing to remove before you ship this. Pick the
voice with `dartCalloutVoice` in `data/venue.json`. Run
`scripts/generate-callout-sounds.py` to regenerate a set or add a new voice.

## Adding a game

Application code lives in `src/` (`server.js`, the engines, board drivers and
lights); `public/` is what the browser loads, and `data/` and `certs/` are
created at runtime beside them.

Each game is two files: one in `src/engines/` for the rules, scoring and timing,
and one in `public/games/` for its screen. Register it in `src/engines/registry.js`
and add its name to `ALL_GAMES` in `src/venueConfig.js` — nothing else in the
codebase needs to know it exists. `src/engines/README.md` has the full contract.


## Last things to know
The entire system is completely configurable.  Hate an image or the registration page;
replace the png files.  All images used for games came from stock photo sites.

Working on front facing camera to capture key moments.  Will finish when I get
back to it.

There is a lighting module in the code (Tapo) that controls my LED lights.  It's
not plumbed for other products but can be.  Probably best if you just control
your own LEDs.


## License

MIT — see [LICENSE](LICENSE). Do whatever you want with it.

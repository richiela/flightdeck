# Dart-callout sound clips

Generated via `scripts/generate-callout-sounds.py` (Kokoro TTS). Enable with
`dartCalloutMode: "sound"` or `"both"` in `data/venue.json` (see
`venueConfig.js`). A missing clip just logs a console warning in the viewer
and stays silent — no crash.

## Voices

Two full sets so far, one subdir each:

| Dir | Voice | Notes |
|---|---|---|
| `Bella/` | `af_bella` | American female |
| `Daniel/` | `bm_daniel` | British male |

Which one plays is `dartCalloutVoice` in `data/venue.json` (default
`"Bella"`, see `venueConfig.js` — `DART_CALLOUT_VOICES`). No UI for it yet;
hand-edit the file, it auto-reloads live. See the generation script's
`--out`/`--voice` flags for adding another voice folder.

## Naming

`<mult><value>.mp3`, lowercase, no separator — the same `{mult, value}`
vocabulary `describeThrowParts()` already uses server-side:

| mult | meaning |
|---|---|
| `s` | single |
| `d` | double |
| `t` | treble |
| *(none)* | bull or miss — no ring prefix |

| File | Announces |
|---|---|
| `s1.mp3` … `s20.mp3` | Single 1–20 |
| `d1.mp3` … `d20.mp3` | Double 1–20 |
| `t1.mp3` … `t20.mp3` | Treble 1–20 |
| `sbull.mp3` | Outer bull (25) — "Bull's-eye" |
| `dbull.mp3` | Inner bull (50) — "Double Bull's-eye" |
| `miss.mp3` | Miss / no score |

("Bullseye" as one word comes out of Kokoro/misaki flat on the back half —
no stress on "eye". The apostrophe+hyphen spelling gives it its own stress
and is the version that actually sounded right, verified by ear.)

63 files per voice. Cricket's mark-hit callout is a separate visual mechanic
(see `dart-callout.js`) and doesn't use these clips.

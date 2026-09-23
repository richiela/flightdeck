#!/usr/bin/env python3
"""
Generate the dart-callout sound dictionary for public/assets/sounds/callouts/
using a local Kokoro TTS install.

Requires the `kokoro` package + a working `ffmpeg` on PATH (used to encode
Kokoro's raw float audio down to mp3, since libsndfile can't write mp3
directly). Run with the venv that has kokoro installed, e.g.:

    /path/to/kokoro-env/bin/python scripts/generate-callout-sounds.py

Naming convention matches public/assets/sounds/callouts/README.md, which
matches describeThrowParts()'s {mult, value} vocabulary in server.js:
    s1..s20  = single 1-20        d1..d20 = double 1-20
    t1..t20  = treble 1-20        sbull   = outer bull (25)
    dbull    = bullseye (50)      miss    = miss / no score

Re-run anytime to fill in gaps or regenerate with a different --voice; existing
files are skipped unless --force is passed.
"""
import argparse
import os
import subprocess
import sys
import tempfile
import warnings

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN_WARNING", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
warnings.filterwarnings("ignore")

NUMBER_WORDS = [
    None, "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
    "Eighteen", "Nineteen", "Twenty",
]

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "sounds", "callouts")


def build_phrase_book():
    phrases = {}
    for n in range(1, 21):
        word = NUMBER_WORDS[n]
        phrases[f"s{n}"] = word            # plain number, same as a real caller yelling a single
        phrases[f"d{n}"] = f"Double {word}"
        phrases[f"t{n}"] = f"Triple {word}"  # swap to "Treble" here if you'd rather have that word
    # Plain "Bullseye" comes out of Kokoro/misaki flat on the back half
    # (bˈʊlzI — stress only on "bulls", none on "eye"). The apostrophe+hyphen
    # spelling gives "eye" its own stress (bˈʊlzˌI) and was the version that
    # actually sounded right — verified by ear against several phrasings.
    phrases["sbull"] = "Bull's-eye"
    phrases["dbull"] = "Double Bull's-eye"
    phrases["miss"] = "Miss"
    return phrases


def synth(pipeline, text, voice, speed):
    import numpy as np
    chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=speed) if audio is not None]
    if not chunks:
        raise RuntimeError(f"Kokoro produced no audio for {text!r}")
    return np.concatenate(chunks)


def write_mp3(audio, samplerate, dest_path):
    import soundfile as sf
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_wav = tmp.name
    try:
        sf.write(tmp_wav, audio, samplerate)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp_wav,
             "-codec:a", "libmp3lame", "-qscale:a", "2", dest_path],
            check=True,
        )
    finally:
        os.remove(tmp_wav)


def main():
    parser = argparse.ArgumentParser(description="Generate FlightDeck dart-callout clips via Kokoro TTS")
    parser.add_argument("-v", "--voice", default="af_heart", help="Kokoro voice name (default: af_heart)")
    parser.add_argument("-s", "--speed", type=float, default=1.0, help="Speech speed multiplier (default: 1.0)")
    parser.add_argument("--out", default=OUT_DIR, help="Output directory (default: public/assets/sounds/callouts)")
    parser.add_argument("--force", action="store_true", help="Regenerate files that already exist")
    parser.add_argument("--only", default=None, help="Comma-separated list of keys to (re)generate, e.g. s20,d20,t20")
    args = parser.parse_args()

    try:
        import torch
        from kokoro import KPipeline
    except ImportError as e:
        sys.exit(f"Missing dependency ({e}). Run this with the kokoro venv's python, e.g.:\n"
                  f"  /path/to/kokoro-env/bin/python {sys.argv[0]}")

    phrases = build_phrase_book()
    keys = [k.strip() for k in args.only.split(",")] if args.only else sorted(phrases)
    unknown = [k for k in keys if k not in phrases]
    if unknown:
        sys.exit(f"Unknown callout key(s): {', '.join(unknown)}")

    os.makedirs(args.out, exist_ok=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    lang_code = args.voice[0] if args.voice else "a"
    print(f"Loading Kokoro ({device}, voice={args.voice})...")
    pipeline = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M", device=device)

    made, skipped = 0, 0
    for key in keys:
        dest = os.path.join(args.out, f"{key}.mp3")
        if os.path.exists(dest) and not args.force:
            skipped += 1
            continue
        text = phrases[key]
        audio = synth(pipeline, text, args.voice, args.speed)
        write_mp3(audio, 24000, dest)
        made += 1
        print(f"  {key:<6} <- {text!r:<16} -> {dest}")

    print(f"\nDone: {made} generated, {skipped} skipped (already existed, use --force to redo).")


if __name__ == "__main__":
    main()

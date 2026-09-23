/* FC_DART_ANNOUNCER v1 — plays a callout clip for each landed dart when
   dartCalloutMode is 'sound' or 'both' (data/venue.json). Reacts to
   gameData.dartAnnounce, which the server updates WITHOUT touching
   phase/schedule — unlike the dart_callout card, this never holds up gameplay.
   Clips live at /assets/sounds/callouts/<voice>/<mult><value>.mp3, e.g.
   Bella/s20.mp3, Daniel/t19.mp3, .../sbull.mp3 (outer), .../dbull.mp3
   (bullseye), .../miss.mp3 — the same {mult, value} vocabulary
   describeThrowParts() already uses server-side. Voice folder comes from
   gameState.dartCalloutVoice (data/venue.json, see venueConfig.js) — no UI
   for it yet, hand-edit the file.
   Revert: delete this file + its <script> include in each game HTML. */
(function () {
    const CLIP_ROOT = '/assets/sounds/callouts/';
    const DEFAULT_VOICE = 'Bella';
    const warned = new Set();

    // The whole vocabulary: singles/doubles/trebles 1-20, both bulls, miss.
    // 63 clips, under 900KB a voice, so the entire set is worth preloading.
    const VOCAB = [];
    for (let n = 1; n <= 20; n++) VOCAB.push('s' + n, 'd' + n, 't' + n);
    VOCAB.push('sbull', 'dbull', 'miss');

    // url -> HTMLAudioElement, kept so a clip is fetched and decoded once.
    // Building a fresh Audio() per dart meant the FIRST play of every clip
    // paid for a network round trip plus decode, which is what made the sound
    // trail the card even though the server publishes both in one state.
    const clips = new Map();
    let warmedVoice = null;
    // null = no state seen yet. Armed on the FIRST state, not the first
    // announce — see syncAnnounce.
    let lastSeq = null;

    function clipFor(voice, key) {
        const url = CLIP_ROOT + voice + '/' + key + '.mp3';
        let audio = clips.get(url);
        if (!audio) {
            audio = new Audio();
            audio.preload = 'auto';
            audio.addEventListener('error', function () {
                const warnKey = voice + '/' + key;
                if (warned.has(warnKey)) return;
                warned.add(warnKey);
                console.warn('[dart-announcer] missing/failed clip:', warnKey);
            });
            audio.src = url;
            clips.set(url, audio);
        }
        return audio;
    }

    // Fetch the active voice up front, in small batches so a page load does
    // not fire 63 requests at once alongside the game's own art and video.
    function warmVoice(voice) {
        if (warmedVoice === voice) return;
        warmedVoice = voice;
        let i = 0;
        (function step() {
            const end = Math.min(i + 8, VOCAB.length);
            for (; i < end; i++) clipFor(voice, VOCAB[i]);
            if (i < VOCAB.length) setTimeout(step, 50);
        })();
    }

    function clipKeyFor(announce) {
        if (!announce) return null;
        if (announce.miss || String(announce.value).toUpperCase() === 'MISS') return 'miss';
        const value = String(announce.value || '').toLowerCase();
        if (!value) return null;
        const mult = announce.mult ? String(announce.mult).toLowerCase() : '';
        return mult + value;
    }

    function play(voice, key) {
        const audio = clipFor(voice, key);
        // Reused element: rewind so a repeat of the same call still sounds.
        try { audio.currentTime = 0; } catch (err) { /* not seekable yet */ }
        audio.play().catch(function () {});
    }

    function syncAnnounce(state) {
        const gameData = state && state.gameData;
        const announce = gameData && gameData.dartAnnounce;
        const seq = announce ? Number(announce.seq) : NaN;

        const mode = state && state.dartCalloutMode;
        if (mode === 'sound' || mode === 'both') {
            warmVoice((state && state.dartCalloutVoice) || DEFAULT_VOICE);
        }

        if (lastSeq === null) {
            // First state this page has seen, so whatever it holds predates
            // us: either a dart thrown before we loaded, or no dart at all.
            // Either way it is a baseline to measure from, not something to
            // announce — that is what stops a reload mid-game replaying every
            // dart so far.
            //
            // Arming on the first STATE rather than the first ANNOUNCE is the
            // point. A fresh game has no dartAnnounce at all, so keying off
            // the announce left lastSeq null until the first dart landed, and
            // then swallowed that dart as its baseline. Every game's opening
            // dart went uncalled, and it "fixed itself" on dart two.
            lastSeq = Number.isFinite(seq) ? seq : 0;
            return;
        }
        if (!Number.isFinite(seq) || seq === lastSeq) return;
        lastSeq = seq;
        const key = clipKeyFor(announce);
        if (key) play((state && state.dartCalloutVoice) || DEFAULT_VOICE, key);
    }

    window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data || data.type !== 'SYNC_STATE' || !data.state) return;
        syncAnnounce(data.state);
    });
})();

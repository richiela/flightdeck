/* FC_DART_ANNOUNCER v2 — plays a callout clip for each landed dart when
   dartCalloutMode is 'sound' or 'both' (data/venue.json).
   Clips live at /assets/sounds/callouts/<voice>/<mult><value>.mp3, e.g.
   Bella/s20.mp3, Daniel/t19.mp3, .../sbull.mp3 (outer), .../dbull.mp3
   (bullseye), .../miss.mp3 — the same {mult, value} vocabulary
   describeThrowParts() already uses server-side. Voice folder comes from
   gameState.dartCalloutVoice (data/venue.json, see venueConfig.js).

   Two ways a call arrives, and each dart is played once whichever lands first:
     DART_ANNOUNCE — a few hundred bytes the server sends the moment it applies
                     the dart, ahead of the full state. This is the fast path.
     SYNC_STATE    — the full state, whose gameData.dartAnnounce carries the
                     same call. The fallback, and what a page that loaded
                     mid-game uses to find its baseline.
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

    const urlFor = (voice, key) => CLIP_ROOT + voice + '/' + key + '.mp3';
    function warnOnce(key, why) {
        if (warned.has(key)) return;
        warned.add(key);
        console.warn('[dart-announcer] missing/failed clip:', key, why || '');
    }

    // --- Web Audio: how OpenDarts' own dashboard plays its calls -------------
    // One AudioContext at latencyHint 'interactive', every clip fetched and
    // decoded into an AudioBuffer up front, and each call started with
    // createBufferSource().start() the instant it arrives. An HTMLAudioElement
    // spins up a media pipeline on play() even when its clip is preloaded; a
    // decoded buffer has nothing left to prepare. A 30 Hz tone at -80 dB keeps
    // the output awake between darts, so an HDMI sink that went idle does not
    // have to wake before the first word of a call.
    let ctx = null;
    let ctxFailed = false;
    const buffers = new Map();   // url -> AudioBuffer
    const decoding = new Map();  // url -> Promise

    function audioContext() {
        if (ctx || ctxFailed) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { ctxFailed = true; return null; }
        try {
            ctx = new AC({ latencyHint: 'interactive' });
        } catch (err) {
            ctxFailed = true;
            return null;
        }
        try {
            const tone = ctx.createOscillator();
            const gain = ctx.createGain();
            tone.frequency.value = 30;
            gain.gain.value = 0.0001;
            tone.connect(gain).connect(ctx.destination);
            tone.start();
        } catch (err) { /* keep-alive is a nicety, not a requirement */ }
        // The kiosk runs with --autoplay-policy=no-user-gesture-required, so
        // this starts running at once. An ordinary desktop browser holds it
        // suspended until a click; calls fall back to HTMLAudio until then.
        const resume = () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); };
        resume();
        ['pointerdown', 'keydown', 'touchstart'].forEach(t =>
            window.addEventListener(t, resume, { passive: true }));
        return ctx;
    }

    function decode(url) {
        if (buffers.has(url)) return Promise.resolve(buffers.get(url));
        if (decoding.has(url)) return decoding.get(url);
        const c = audioContext();
        if (!c) return Promise.resolve(null);
        const p = fetch(url)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then(bytes => c.decodeAudioData(bytes))
            .then(buf => { buffers.set(url, buf); decoding.delete(url); return buf; })
            .catch(err => { decoding.delete(url); warnOnce(url, err && err.message); return null; });
        decoding.set(url, p);
        return p;
    }

    // --- HTMLAudio fallback ---------------------------------------------------
    // Used only when Web Audio cannot play yet: no AudioContext, a context the
    // browser is still holding suspended, or a clip not decoded yet.
    const elements = new Map();  // url -> HTMLAudioElement
    function element(url) {
        let audio = elements.get(url);
        if (!audio) {
            audio = new Audio();
            audio.preload = 'auto';
            audio.addEventListener('error', () => warnOnce(url, 'media error'));
            audio.src = url;
            elements.set(url, audio);
        }
        return audio;
    }

    function play(voice, key) {
        const url = urlFor(voice, key);
        const c = audioContext();
        const buf = buffers.get(url);
        if (c && c.state === 'running' && buf) {
            const src = c.createBufferSource();
            src.buffer = buf;
            src.connect(c.destination);
            src.start();
            return;
        }
        if (c && !buf) decode(url);
        const audio = element(url);
        try { audio.currentTime = 0; } catch (err) { /* not seekable yet */ }
        audio.play().catch(() => {});
    }

    // Decode the active voice up front, a few at a time so a page load does not
    // fire 63 requests at once alongside the game's own art.
    let warmedVoice = null;
    function warmVoice(voice) {
        if (warmedVoice === voice) return;
        warmedVoice = voice;
        const c = audioContext();
        let i = 0;
        (function step() {
            const end = Math.min(i + 8, VOCAB.length);
            for (; i < end; i++) {
                const url = urlFor(voice, VOCAB[i]);
                if (c) decode(url); else element(url);
            }
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

    // Each call is played once, by whichever path delivers it first.
    const played = new Set();
    function callOnce(announce, voice) {
        const seq = announce && Number(announce.seq);
        if (!Number.isFinite(seq) || played.has(seq)) return;
        played.add(seq);
        if (played.size > 200) played.delete(played.values().next().value);
        const key = clipKeyFor(announce);
        if (key) play(voice || DEFAULT_VOICE, key);
    }

    // null = no state seen yet. Armed on the FIRST state, not the first
    // announce: a fresh game has no dartAnnounce, so keying off the announce
    // left this null until the first dart landed and then swallowed that dart
    // as the baseline. Every game's opening dart went uncalled.
    let lastSeq = null;

    function syncAnnounce(state) {
        const gameData = state && state.gameData;
        const announce = gameData && gameData.dartAnnounce;
        const seq = announce ? Number(announce.seq) : NaN;

        const mode = state && state.dartCalloutMode;
        if (mode === 'sound' || mode === 'both') {
            warmVoice((state && state.dartCalloutVoice) || DEFAULT_VOICE);
        }

        if (lastSeq === null) {
            // First state this page has seen: whatever it holds predates us, so
            // it is a baseline, not a call. This is what stops a reload
            // mid-game replaying every dart so far.
            lastSeq = Number.isFinite(seq) ? seq : 0;
            if (Number.isFinite(seq)) played.add(seq);
            return;
        }
        if (!Number.isFinite(seq) || seq === lastSeq) return;
        lastSeq = seq;
        callOnce(announce, state && state.dartCalloutVoice);
    }

    window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data) return;
        if (data.type === 'DART_ANNOUNCE') {
            const sig = data.data || {};
            if (sig.sound) callOnce(sig.sound, sig.voice);
            return;
        }
        if (data.type !== 'SYNC_STATE' || !data.state) return;
        syncAnnounce(data.state);
    });
})();

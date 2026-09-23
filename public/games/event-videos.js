/** Shared event-video helpers: winner clips + cheers, Demolition bust clips + bang. */
(function (global) {
    const CHEERS_URL = '/assets/shared/winner-cheers.mp3';
    const CHEERS_VOLUME = 0.4;
    const BUST_BANG_URL = '/assets/demolition/bust-collapse.mp3';
    const BUST_BANG_VOLUME = 0.4;

    // Prefer id-specific targets: x01 keeps #winnerVideo + #bustVideo in one overlay.
    const WINNER_VIDEO_SEL = 'video#winnerVideo, video.fd-winner-video';
    const BUST_VIDEO_SEL = 'video#bustVideo';
    // Killer event clips use .fd-event-video (not #winnerVideo / #bustVideo).
    const EVENT_VIDEO_SEL = 'video.fd-event-video, video#bustVideo';
    const ANY_VIDEO_SEL = 'video#winnerVideo, video#bustVideo, video.fd-winner-video, video.fd-event-video';

    let cheersAudio = null;
    let bustBangAudio = null;

    function getSfx(kind) {
        if (kind === 'bust') {
            if (!bustBangAudio) {
                bustBangAudio = new Audio(BUST_BANG_URL);
                bustBangAudio.preload = 'auto';
                bustBangAudio.volume = BUST_BANG_VOLUME;
            }
            return bustBangAudio;
        }
        if (!cheersAudio) {
            cheersAudio = new Audio(CHEERS_URL);
            cheersAudio.preload = 'auto';
            cheersAudio.volume = CHEERS_VOLUME;
        }
        return cheersAudio;
    }

    function unlockSfx(audio) {
        const prev = audio.volume;
        audio.volume = 0;
        const p = audio.play();
        if (p && typeof p.then === 'function') {
            p.then(() => {
                audio.pause();
                audio.currentTime = 0;
                audio.volume = prev;
            }).catch(() => {
                audio.volume = prev;
            });
        } else {
            audio.volume = prev;
        }
    }

    // Safari/WebKit (iOS + macOS) requires an unmuted <video>.play() to happen inside a
    // real user-gesture call stack before it will allow unmuted autoplay on that element
    // for the rest of the session -- unlike Chrome, which can grant this from accumulated
    // page engagement alone (why long-running Windows kiosk sessions "just work" without
    // ever needing a click). unlockSfx() above already does this for the cheers/bust
    // Audio() objects; unlockVideo() does the same for the actual <video> elements, whose
    // own embedded audio track was previously never primed -- the cheers SFX playing
    // alongside a silently-muted-fallback video masked that the video's own audio was the
    // thing failing, not sound in general.
    function unlockVideo(videoEl, url) {
        if (!videoEl) return;
        try {
            if (url && videoEl.getAttribute('src') !== url) {
                videoEl.src = url;
                videoEl.load();
            }
        } catch (_) {}
        // Same trick as unlockSfx: the autoplay-with-sound policy check is against the
        // `muted` property specifically, not effective loudness, so muted:false + volume:0
        // still registers as a real unmuted play() for future-permission purposes while
        // being genuinely silent during the prime itself. Missed this the first pass --
        // videoEl.muted stayed false with volume at its default (1), so priming actually
        // played the real clip out loud for however long play() took to resolve before
        // pause() landed ("random sounds come on but disappear quickly" on refresh).
        const prevVolume = videoEl.volume;
        videoEl.muted = false;
        videoEl.volume = 0;
        const p = videoEl.play();
        if (p && typeof p.then === 'function') {
            p.then(() => {
                videoEl.pause();
                videoEl.currentTime = 0;
                videoEl.volume = prevVolume;
            }).catch(() => {
                videoEl.volume = prevVolume;
            });
        } else {
            videoEl.volume = prevVolume;
        }
    }

    function unlockAll() {
        unlockSfx(getSfx('cheers'));
        unlockSfx(getSfx('bust'));
        document.querySelectorAll(ANY_VIDEO_SEL).forEach((el) => {
            unlockVideo(el, api.pickUrl() || api.pickBustUrl());
        });
    }

    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
        window.addEventListener(evt, unlockAll, { once: true, passive: true });
    });

    function playSfx(kind, volume) {
        const audio = getSfx(kind);
        try {
            audio.pause();
            audio.currentTime = 0;
            audio.volume = volume;
        } catch (_) {}
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    function stopSfx(kind) {
        const audio = kind === 'bust' ? bustBangAudio : cheersAudio;
        if (!audio) return;
        try {
            audio.pause();
            audio.currentTime = 0;
        } catch (_) {}
    }

    function pickFrom(urls) {
        if (!urls || !urls.length) return null;
        return urls[Math.floor(Math.random() * urls.length)];
    }

    function playVideo(videoEl, url) {
        if (!videoEl || !url) return;
        try {
            videoEl.pause();
            if (videoEl.getAttribute('src') !== url) {
                videoEl.src = url;
                videoEl.load();
            }
            videoEl.currentTime = 0;
            videoEl.muted = false;
            videoEl.volume = 1;
            videoEl.classList.add('fd-winner-video-ready');
        } catch (_) {}
        const p = videoEl.play();
        if (p && typeof p.catch === 'function') {
            p.catch(() => {
                try {
                    videoEl.muted = true;
                    videoEl.play().catch(() => {});
                } catch (_) {}
            });
        }
    }

    function signalBustVideoComplete() {
        try {
            window.parent.postMessage({ type: 'BUST_VIDEO_COMPLETE' }, '*');
        } catch (_) {}
    }

    function bindBustVideoEnded(videoEl) {
        if (!videoEl) {
            signalBustVideoComplete();
            return;
        }
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            try {
                videoEl.onended = null;
                videoEl.ontimeupdate = null;
            } catch (_) {}
            signalBustVideoComplete();
        };
        videoEl.onended = finish;
        // Near-end backup if `ended` is flaky
        videoEl.ontimeupdate = () => {
            try {
                if (!videoEl.duration || !Number.isFinite(videoEl.duration)) return;
                if (videoEl.currentTime >= videoEl.duration - 0.12) finish();
            } catch (_) {}
        };
    }

    function stopVideo(videoEl) {
        if (!videoEl) return;
        try {
            videoEl.onended = null;
            videoEl.ontimeupdate = null;
            videoEl.pause();
            videoEl.currentTime = 0;
            videoEl.classList.remove('fd-winner-video-ready');
        } catch (_) {}
    }

    function stopAllVideos(screenEl) {
        if (!screenEl) return;
        screenEl.querySelectorAll(ANY_VIDEO_SEL).forEach(stopVideo);
    }

    const api = {
        winnerUrls: [],
        bustUrls: [],
        enabled: true,

        applyFromState(state) {
            if (!state) return;
            if (Array.isArray(state.winnerVideos) && state.winnerVideos.length) {
                this.winnerUrls = state.winnerVideos.slice();
            }
            if (Array.isArray(state.bustVideos) && state.bustVideos.length) {
                this.bustUrls = state.bustVideos.slice();
            }
            this.enabled = state.viewerVideoEnabled !== false;
        },

        applyScreenClass(screenEl) {
            if (!screenEl) return;
            screenEl.classList.toggle('video-off', !this.enabled);
            if (!this.enabled) stopAllVideos(screenEl);
        },

        pickUrl() {
            return pickFrom(this.winnerUrls);
        },

        pickBustUrl() {
            return pickFrom(this.bustUrls);
        },

        play(videoEl) {
            if (!this.enabled || !videoEl) return;
            playVideo(videoEl, this.pickUrl());
        },

        stop(videoEl) {
            stopVideo(videoEl);
        },

        /** Crowd clap/cheer — all winner screens (Video on or off). */
        playCheers() {
            playSfx('cheers', CHEERS_VOLUME);
        },

        stopCheers() {
            stopSfx('cheers');
        },

        /** Demolition bust bang — always (Video on or off). */
        playBustBang() {
            playSfx('bust', BUST_BANG_VOLUME);
        },

        stopBustBang() {
            stopSfx('bust');
        },

        playIn(screenEl) {
            if (!screenEl) return;
            this.applyScreenClass(screenEl);
            this.playCheers();
            if (!this.enabled) return;
            this.play(screenEl.querySelector(WINNER_VIDEO_SEL));
        },

        /** Bust: bang SFX + random bust-*.mp4 when Video is on. Signals BUST_VIDEO_COMPLETE on end. */
        playBustIn(screenEl) {
            if (!screenEl) return;
            this.applyScreenClass(screenEl);
            this.playBustBang();
            if (!this.enabled) return;
            const videoEl = screenEl.querySelector(BUST_VIDEO_SEL);
            const url = this.pickBustUrl();
            if (!url || !videoEl) {
                signalBustVideoComplete();
                return;
            }
            bindBustVideoEnded(videoEl);
            playVideo(videoEl, url);
        },

        /** Play a fixed clip URL (e.g. Killer became-killer Charon). */
        playFixedIn(screenEl, url) {
            if (!screenEl) return;
            this.applyScreenClass(screenEl);
            if (!this.enabled || !url) return;
            playVideo(screenEl.querySelector(EVENT_VIDEO_SEL), url);
        },

        stopIn(screenEl) {
            if (!screenEl) return;
            stopAllVideos(screenEl);
            this.stopCheers();
            this.stopBustBang();
        },

        /** Exposed so viewer.html (the parent frame) can unlock audio/video from a
            gesture on ITS OWN window -- a click/tap on viewer.html's own chrome (header,
            frame border) never reaches this iframe's window (DOM events don't cross frame
            boundaries), so relying only on gestures inside the game iframe misses those. */
        unlock() {
            unlockAll();
        }
    };

    global.FlightDeckWinnerVideo = api;
})(window);

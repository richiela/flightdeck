/**
 * Screen keep-awake for Control / Viewer kiosk tabs.
 * Call FlightDeckWakeLock.setDesired(true|false) from page logic.
 *
 * Auto path for all devices (Mac Mini Viewer is the main case):
 *   Screen Wake Lock API when available + muted looping video backup.
 * No tap overlay — iPad may still sleep without a gesture; that is an edge case.
 *
 * Dispatches "flightdeck-wakelock":
 * { desired, held, mode, needsGesture, supported, wakeLock, video }.
 */
(function keepScreenAwake() {
    const SILENT_VIDEO_SRC = '/assets/app/keep-awake-silent.mp4';
    const WATCHDOG_MS = 15000;

    const api = {
        setDesired() {},
        enableFromUserGesture() { return Promise.resolve(false); },
        isDesired() { return false; },
        isHeld() { return false; },
        needsGesture() { return false; },
        getMode() { return 'none'; },
        requiresGesture: false,
        supported: false
    };
    window.FlightDeckWakeLock = api;

    const hasWakeLockApi = !!(
        typeof navigator !== 'undefined'
        && navigator.wakeLock
        && typeof navigator.wakeLock.request === 'function'
    );

    let desired = false;
    let wakeLock = null;
    let videoEl = null;
    let mode = 'none';
    let retryTimer = null;
    let watchdogTimer = null;
    let activateInFlight = null;

    function videoHeld() {
        return !!(videoEl && !videoEl.paused && !videoEl.ended);
    }

    function confidentlyHeld() {
        if (hasWakeLockApi) return !!wakeLock;
        return videoHeld();
    }

    function refreshMode() {
        const wl = !!wakeLock;
        const vid = videoHeld();
        if (wl && vid) mode = 'both';
        else if (wl) mode = 'wakelock';
        else if (vid) mode = 'video';
        else mode = 'none';
        return mode;
    }

    function emit() {
        refreshMode();
        const detail = {
            desired,
            held: confidentlyHeld(),
            mode,
            needsGesture: false,
            requiresGesture: false,
            supported: true,
            wakeLock: !!wakeLock,
            video: videoHeld()
        };
        try {
            window.dispatchEvent(new CustomEvent('flightdeck-wakelock', { detail }));
        } catch (_) {}
        return detail;
    }

    function clearRetry() {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    }

    function clearWatchdog() {
        if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
    }

    function scheduleRetry(ms) {
        if (!desired || retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            activate();
        }, ms);
    }

    function armWatchdog() {
        if (watchdogTimer || !desired) return;
        watchdogTimer = setInterval(() => {
            if (!desired || document.visibilityState !== 'visible') return;
            if (!confidentlyHeld() || (hasWakeLockApi && !wakeLock) || !videoHeld()) {
                activate();
            }
        }, WATCHDOG_MS);
    }

    function ensureVideo() {
        if (videoEl) return videoEl;
        const v = document.createElement('video');
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.setAttribute('muted', '');
        v.muted = true;
        v.defaultMuted = true;
        v.volume = 0;
        v.loop = true;
        v.autoplay = false;
        v.preload = 'auto';
        v.playsInline = true;
        v.src = SILENT_VIDEO_SRC;
        v.style.cssText = [
            'position:fixed',
            'width:2px',
            'height:2px',
            'left:0',
            'top:0',
            'opacity:0.01',
            'pointer-events:none',
            'z-index:-1'
        ].join(';');
        v.addEventListener('pause', () => {
            if (desired && document.visibilityState === 'visible') scheduleRetry(500);
            emit();
        });
        v.addEventListener('ended', () => {
            if (desired) scheduleRetry(250);
            emit();
        });
        v.addEventListener('error', () => {
            if (desired) scheduleRetry(3000);
            emit();
        });
        (document.body || document.documentElement).appendChild(v);
        videoEl = v;
        return v;
    }

    async function stopVideo() {
        if (!videoEl) return;
        try {
            videoEl.pause();
            videoEl.removeAttribute('src');
            videoEl.load();
        } catch (_) {}
        try {
            if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl);
        } catch (_) {}
        videoEl = null;
        refreshMode();
    }

    function startVideo() {
        const v = ensureVideo();
        if (!v.src) v.src = SILENT_VIDEO_SRC;
        v.muted = true;
        v.volume = 0;
        try {
            const p = v.play();
            if (p && typeof p.then === 'function') {
                return p.then(() => videoHeld()).catch(() => {
                    scheduleRetry(2000);
                    return false;
                });
            }
            return Promise.resolve(videoHeld());
        } catch (_) {
            scheduleRetry(2000);
            return Promise.resolve(false);
        }
    }

    async function releaseWakeLock() {
        if (!wakeLock) return;
        const lock = wakeLock;
        wakeLock = null;
        try {
            await lock.release();
        } catch (_) { /* already released */ }
        refreshMode();
    }

    function requestWakeLock() {
        if (!hasWakeLockApi) return Promise.resolve(false);
        if (document.visibilityState !== 'visible') return Promise.resolve(false);
        if (wakeLock) return Promise.resolve(true);

        let req;
        try {
            req = navigator.wakeLock.request('screen');
        } catch (_) {
            return Promise.resolve(false);
        }

        return Promise.resolve(req).then((lock) => {
            wakeLock = lock;
            lock.addEventListener('release', () => {
                if (wakeLock === lock) wakeLock = null;
                refreshMode();
                emit();
                if (desired && document.visibilityState === 'visible') {
                    startVideo();
                    scheduleRetry(800);
                }
            });
            emit();
            return true;
        }).catch(() => false);
    }

    function activate() {
        if (!desired) return Promise.resolve(false);
        if (document.visibilityState !== 'visible') {
            emit();
            return Promise.resolve(false);
        }
        if (activateInFlight) return activateInFlight;

        activateInFlight = Promise.all([requestWakeLock(), startVideo()])
            .then(() => {
                refreshMode();
                emit();
                armWatchdog();
                return confidentlyHeld();
            })
            .finally(() => {
                activateInFlight = null;
            });
        return activateInFlight;
    }

    async function deactivate() {
        clearRetry();
        clearWatchdog();
        activateInFlight = null;
        await releaseWakeLock();
        await stopVideo();
        mode = 'none';
        emit();
    }

    api.supported = true;
    api.isDesired = () => desired;
    api.isHeld = () => confidentlyHeld();
    api.needsGesture = () => false;
    api.getMode = () => mode;
    api.enableFromUserGesture = () => {
        desired = true;
        armWatchdog();
        return activate();
    };
    api.setDesired = (on) => {
        const next = !!on;
        if (next === desired) {
            if (next && !confidentlyHeld()) activate();
            else emit();
            return;
        }
        desired = next;
        if (desired) {
            armWatchdog();
            activate();
        } else {
            deactivate();
        }
        emit();
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && desired) {
            wakeLock = null;
            activate();
            emit();
        } else if (document.visibilityState !== 'visible') {
            wakeLock = null;
            refreshMode();
            emit();
        }
    });

    window.addEventListener('pageshow', () => {
        if (desired) {
            wakeLock = null;
            activate();
            emit();
        }
    });

    emit();
})();

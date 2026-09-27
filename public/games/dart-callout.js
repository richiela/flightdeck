/* FC_DART_CALLOUT v1 — listens for SYNC_STATE; shows phase dart_callout.
   Revert: delete with dart-callout.css + game HTML includes + server wrap.
   Cricket mark hits: data.cricketMarks → avatar + label + mark draw. */
(function () {
    function initialsFromName(name) {
        const t = String(name || '?').trim();
        if (!t) return '?';
        const parts = t.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return t.slice(0, 2).toUpperCase();
    }

    function ensureEl() {
        let el = document.getElementById('fcDartCallout');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'fcDartCallout';
        el.className = 'fc-dart-callout';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML =
            '<div class="fc-dart-callout-card">' +
            '<div class="fc-dart-callout-avatar" id="fcDartCalloutAvatar" hidden></div>' +
            '<div class="fc-dart-callout-name" id="fcDartCalloutName"></div>' +
            '<div class="fc-dart-callout-hit">' +
            '<div class="fc-dart-callout-label" id="fcDartCalloutLabel"></div>' +
            '<div class="fc-dart-callout-mark" id="fcDartCalloutMark" hidden aria-hidden="true"></div>' +
            '</div>' +
            '</div>';
        document.body.appendChild(el);
        return el;
    }

    let lastCricketKey = '';

    // The plain card can be raised early, from DART_ANNOUNCE -- a few hundred
    // bytes the server sends the moment it applies a dart, ahead of the ~180 KB
    // full state. The state that raised the card follows milliseconds behind,
    // so for a short window a state still showing the previous phase must not
    // take the card down. If the confirming state never comes, the safety
    // timer does. Cricket's mark card is never raised early: it needs the mark
    // animation data that only the state carries.
    let earlyUntil = 0;
    let earlyConfirmed = true;
    let earlyTimer = null;

    function hideCard(el) {
        el.classList.remove('is-visible', 'is-miss', 'is-hit', 'is-cricket-marks');
        el.setAttribute('aria-hidden', 'true');
        lastCricketKey = '';
    }

    function showEarlyCard(card) {
        if (!card) return;
        const el = ensureEl();
        const nameEl = document.getElementById('fcDartCalloutName');
        const labelEl = document.getElementById('fcDartCalloutLabel');
        const avatarEl = document.getElementById('fcDartCalloutAvatar');
        const markEl = document.getElementById('fcDartCalloutMark');
        lastCricketKey = '';
        if (nameEl) nameEl.textContent = card.playerName || 'PLAYER';
        if (labelEl) {
            labelEl.hidden = false;
            labelEl.textContent = card.label || '—';
        }
        if (avatarEl) {
            avatarEl.innerHTML = '';
            avatarEl.hidden = true;
        }
        if (markEl) {
            markEl.innerHTML = '';
            markEl.hidden = true;
            markEl.setAttribute('aria-hidden', 'true');
        }
        el.classList.toggle('is-miss', !!card.miss);
        el.classList.toggle('is-hit', !card.miss);
        el.classList.remove('is-cricket-marks');
        el.classList.add('is-visible');
        el.setAttribute('aria-hidden', 'false');

        earlyConfirmed = false;
        earlyUntil = Date.now() + 500;
        clearTimeout(earlyTimer);
        earlyTimer = setTimeout(() => {
            if (!earlyConfirmed) hideCard(el);
        }, (Number(card.holdMs) || 1200) + 1500);
    }

    function syncDartCallout(gameData) {
        const el = ensureEl();
        const phase = gameData && gameData.phase;
        const show = !!(phase && phase.type === 'dart_callout');
        if (!show) {
            if (Date.now() < earlyUntil) return;
            hideCard(el);
            return;
        }
        earlyConfirmed = true;
        earlyUntil = 0;
        const data = phase.data || {};
        const cricketMarks = !!data.cricketMarks;
        const name = data.playerName || 'PLAYER';
        const nameEl = document.getElementById('fcDartCalloutName');
        const labelEl = document.getElementById('fcDartCalloutLabel');
        const avatarEl = document.getElementById('fcDartCalloutAvatar');
        const markEl = document.getElementById('fcDartCalloutMark');

        if (nameEl) nameEl.textContent = name;

        if (cricketMarks) {
            // Avatar + hit label + mark animation
            if (labelEl) {
                labelEl.hidden = false;
                labelEl.textContent = data.label || '—';
            }
            if (avatarEl) {
                if (data.avatar) {
                    avatarEl.innerHTML = '<img src="' + data.avatar + '" alt="">';
                } else {
                    avatarEl.innerHTML = '<span class="fc-dart-callout-initials">' + initialsFromName(name) + '</span>';
                }
                avatarEl.hidden = false;
            }
            if (markEl) {
                markEl.hidden = false;
                markEl.setAttribute('aria-hidden', 'false');
                const key = [phase.startedAt || '', data.markBefore, data.markAfter, data.label || ''].join('|');
                if (key !== lastCricketKey) {
                    lastCricketKey = key;
                    if (typeof window.FC_playCricketMarkDraw === 'function') {
                        window.FC_playCricketMarkDraw(markEl, {
                            markBefore: data.markBefore,
                            markAfter: data.markAfter,
                            budgetMs: data.animBudgetMs
                        });
                    } else {
                        markEl.textContent = '';
                    }
                }
            }
        } else {
            lastCricketKey = '';
            if (labelEl) {
                labelEl.hidden = false;
                labelEl.textContent = data.label || '—';
            }
            if (avatarEl) {
                avatarEl.innerHTML = '';
                avatarEl.hidden = true;
            }
            if (markEl) {
                markEl.innerHTML = '';
                markEl.hidden = true;
                markEl.setAttribute('aria-hidden', 'true');
            }
        }

        el.classList.toggle('is-miss', !!data.miss);
        el.classList.toggle('is-hit', !data.miss);
        el.classList.toggle('is-cricket-marks', cricketMarks);
        el.classList.add('is-visible');
        el.setAttribute('aria-hidden', 'false');
    }

    window.addEventListener('message', function (event) {
        const data = event.data;
        if (data && data.type === 'DART_ANNOUNCE') {
            showEarlyCard(data.data && data.data.card);
            return;
        }
        if (!data || data.type !== 'SYNC_STATE' || !data.state) return;
        syncDartCallout(data.state.gameData);
    });
})();

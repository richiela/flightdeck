/**
 * Cricket mark stroke animation.
 * Include cricket-mark-draw.css. Call:
 *   FC_playCricketMarkDraw(containerEl, { markBefore, markAfter, budgetMs })
 *
 * Progressive draw: first X-stroke → second stroke (X) → circle (circled-X).
 * Wired from Cricket dart_callout when data.cricketMarks is set.
 */
(function (global) {
    function cricketMarkSvgHtml() {
        return (
            '<svg class="fc-cricket-mark-svg" viewBox="0 0 24 24" aria-hidden="true">' +
            /* X extends past the circle so tips stay visible when circled */
            '<line class="fc-mk fc-mk-1" x1="3.2" y1="3.2" x2="20.8" y2="20.8" />' +
            '<line class="fc-mk fc-mk-2" x1="20.8" y1="3.2" x2="3.2" y2="20.8" />' +
            '<circle class="fc-mk fc-mk-3" cx="12" cy="12" r="10" />' +
            '</svg>'
        );
    }

    function prepareMarkStroke(el) {
        if (!el || typeof el.getTotalLength !== 'function') return 0;
        const len = el.getTotalLength();
        el.style.strokeDasharray = String(len);
        el.style.strokeDashoffset = String(len);
        return len;
    }

    function setMarkDrawn(el, drawn, instant) {
        if (!el) return;
        el.classList.toggle('is-instant', !!instant);
        el.classList.toggle('is-drawn', !!drawn);
        if (drawn) {
            el.style.strokeDashoffset = '0';
        } else {
            const len = el.getTotalLength ? el.getTotalLength() : 0;
            el.style.strokeDashoffset = String(len);
        }
    }

    /**
     * @param {HTMLElement} markEl - container; SVG is injected
     * @param {{ markBefore?: number, markAfter?: number, budgetMs?: number }} opts
     */
    function playCricketMarkDraw(markEl, opts) {
        if (!markEl) return;
        const markBefore = opts && opts.markBefore;
        const markAfter = opts && opts.markAfter;
        const budgetMs = opts && opts.budgetMs;

        markEl.innerHTML = cricketMarkSvgHtml();
        const svg = markEl.querySelector('svg');
        if (!svg) return;

        const mk1 = svg.querySelector('.fc-mk-1');
        const mk2 = svg.querySelector('.fc-mk-2');
        const mk3 = svg.querySelector('.fc-mk-3');
        const parts = [mk1, mk2, mk3];

        parts.forEach((p) => {
            if (!p) return;
            prepareMarkStroke(p);
            p.classList.remove('is-drawn', 'is-instant', 'is-pending');
        });

        const before = Math.max(0, Math.min(3, Number(markBefore) || 0));
        const after = Math.max(0, Math.min(3, Number(markAfter) || 0));

        for (let i = 0; i < before; i++) {
            setMarkDrawn(parts[i], true, true);
        }
        for (let i = before; i < 3; i++) {
            if (parts[i]) {
                parts[i].classList.add('is-pending');
                setMarkDrawn(parts[i], false, true);
            }
        }

        if (after <= before) return;

        const steps = after - before;
        const budget = Math.max(280, Number(budgetMs) || 1200);
        const usable = Math.max(240, budget * 0.72);
        const strokeMs = Math.min(420, Math.max(160, usable / steps));
        const gapMs = Math.min(90, strokeMs * 0.2);

        let delay = 80;
        for (let level = before + 1; level <= after; level++) {
            const el = parts[level - 1];
            if (!el) continue;
            const startAt = delay;
            window.setTimeout(() => {
                el.classList.remove('is-pending', 'is-instant');
                prepareMarkStroke(el);
                el.getBoundingClientRect();
                requestAnimationFrame(() => {
                    el.style.transitionDuration = strokeMs + 'ms';
                    setMarkDrawn(el, true, false);
                });
            }, startAt);
            delay += strokeMs + gapMs;
        }
    }

    global.FC_playCricketMarkDraw = playCricketMarkDraw;
})(typeof window !== 'undefined' ? window : globalThis);

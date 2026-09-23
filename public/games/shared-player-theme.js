/* FLIGHTCLUB_PLAYER_THEME v1 — keep in sync with shared-player-theme.css */
window.FC_PLAYER_COLORS = [
    '#8FD91B', /* Lime */
    '#2BA4FF', /* Azure */
    '#FF7A18', /* Orange */
    '#B44AFF', /* Violet */
    '#FF2E55', /* Crimson */
    '#F0C400', /* Gold */
    '#00C97B', /* Emerald */
    '#E1008C'  /* Magenta */
];
window.FC_AVATAR_INPLAY = 120;

/* ===== BEGIN FC_PLAYER_BADGE v1 =====
   Revert: delete this block + undo game HTML that calls these helpers. */
window.FC_escapeHtml = function FC_escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
};

window.FC_playerInitials = function FC_playerInitials(name) {
    return String(name || '?')
        .split(/\s+/)
        .filter(Boolean)
        .map(part => part[0])
        .join('')
        .toUpperCase()
        .substring(0, 2) || '?';
};

window.FC_renderAvatarHtml = function FC_renderAvatarHtml(avatar, name) {
    if (avatar) {
        return `<img src="${FC_escapeHtml(avatar)}" alt="">`;
    }
    return `<div class="initials">${FC_escapeHtml(FC_playerInitials(name))}</div>`;
};

/**
 * Standard circle avatar + name plate (Derby look).
 * @param {string|null} avatar
 * @param {string} name
 * @param {{ colorIndex?: number, className?: string, name?: string, orbit?: boolean }} [opts]
 */
window.FC_renderPlayerBadge = function FC_renderPlayerBadge(avatar, name, opts) {
    opts = opts || {};
    const label = opts.name != null ? opts.name : (name || 'PLAYER');
    const colorClass = opts.colorIndex != null ? ` color-${opts.colorIndex % 8}` : '';
    const extra = opts.className ? ` ${opts.className}` : '';
    const orbit = (opts.orbit && typeof window.FC_renderActiveOrbitHtml === 'function')
        ? FC_renderActiveOrbitHtml()
        : '';
    return `<div class="fc-player-badge${colorClass}${extra}">` +
        orbit +
        `<div class="avatar-box">${FC_renderAvatarHtml(avatar, name)}</div>` +
        `<div class="player-name-plate">${FC_escapeHtml(label)}</div>` +
        `</div>`;
};

/** Members list for a roster entity (doubles team or solo). */
window.FC_doublesMembersOf = function FC_doublesMembersOf(player, gd) {
    if (player && Array.isArray(player.members) && player.members.length) {
        return player.members;
    }
    return player ? [player] : [];
};

/**
 * Doubles duo dock: side-by-side badges; optional dartsHtml to the right of the pair.
 * @param {Array} members
 * @param {{ isActive?: boolean, throwerIdx?: number, colorIndex?: number, dartsHtml?: string }} [opts]
 */
window.FC_renderDoublesDuo = function FC_renderDoublesDuo(members, opts) {
    opts = opts || {};
    const list = members && members.length ? members : [];
    if (list.length <= 1) {
        const m = list[0] || { name: 'PLAYER', avatar: null };
        const badge = FC_renderPlayerBadge(m.avatar, m.name, {
            colorIndex: opts.colorIndex,
            className: opts.isActive ? 'thrower-active' : '',
            orbit: !!opts.isActive
        });
        if (!opts.dartsHtml) return badge;
        return `<div class="fc-duo-row">${badge}<div class="fc-duo-darts">${opts.dartsHtml}</div></div>`;
    }
    const isActive = !!opts.isActive;
    const throwerIdx = opts.throwerIdx != null ? opts.throwerIdx : 0;
    let badges = '';
    list.forEach((m, pi) => {
        const isThrower = isActive && pi === (throwerIdx % list.length);
        const idlePartner = isActive && !isThrower;
        const cls = [
            isThrower ? 'thrower-active' : '',
            idlePartner ? 'thrower-idle' : ''
        ].filter(Boolean).join(' ');
        badges += FC_renderPlayerBadge(m.avatar, m.name, {
            colorIndex: opts.colorIndex,
            className: cls,
            orbit: isThrower
        });
    });
    const darts = opts.dartsHtml
        ? `<div class="fc-duo-darts">${opts.dartsHtml}</div>`
        : '';
    return `<div class="fc-duo-row is-duo"><div class="fc-duo-stack">${badges}</div>${darts}</div>`;
};

/* ===== END FC_PLAYER_BADGE v1 ===== */


/* ===== BEGIN FC_ACTIVE_ORBIT v1 ===== */
/** Bead + soft glow trail on the avatar ring. Injected by FC_renderPlayerBadge({ orbit: true }). */
window.FC_renderActiveOrbitHtml = function FC_renderActiveOrbitHtml() {
    return '<div class="fc-active-orbit" aria-hidden="true">'
        + '<div class="fc-orbit-spin">'
        + '<span class="fc-orbit-trail"></span>'
        + '<span class="fc-orbit-bead"></span>'
        + '</div>'
        + '</div>';
};
/* ===== END FC_ACTIVE_ORBIT v1 ===== */

/* ===== BEGIN FC_WINDOW_TITLE_BG v1 =====
   Aligns .window-game-title with body --page-bg (fixed attachment fails in iframes). */
window.FC_syncWindowTitleBackground = function FC_syncWindowTitleBackground() {
    const title = document.querySelector('.window-game-title');
    if (!title) return;
    const pageBg = getComputedStyle(document.body).getPropertyValue('--page-bg').trim();
    if (!pageBg) return;
    const rect = title.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    title.style.backgroundImage = pageBg;
    title.style.backgroundColor = 'transparent';
    title.style.backgroundRepeat = 'no-repeat';
    title.style.backgroundAttachment = 'scroll';
    title.style.backgroundSize = `${w}px ${h}px`;
    title.style.backgroundPosition = `${-Math.round(rect.left)}px ${-Math.round(rect.top)}px`;
};

(function FC_bindWindowTitleBackground() {
    const run = function () {
        window.FC_syncWindowTitleBackground();
        requestAnimationFrame(function () {
            window.FC_syncWindowTitleBackground();
        });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
    window.addEventListener('load', run);
    window.addEventListener('resize', run);
})();
/* ===== END FC_WINDOW_TITLE_BG v1 ===== */

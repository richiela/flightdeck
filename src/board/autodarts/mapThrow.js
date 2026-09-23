/**
 * Autodarts Board Manager segment → FlightDeck TRIGGER_SPECIFIC_THROW
 * Based on qa/autodarts-captures capability probe + bull extrapolation (25 + mult).
 */
function mapAutodartsSegment(segment) {
    if (!segment || typeof segment !== 'object') {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true };
    }

    const name = String(segment.name || '').trim();
    const bed = String(segment.bed || '').trim();
    const number = segment.number;
    const multiplier = Number(segment.multiplier);

    // Miss / outside
    if (
        multiplier === 0
        || /^miss$/i.test(name)
        || /^m\d+$/i.test(name)
        || /^outside$/i.test(bed)
    ) {
        return {
            type: 'TRIGGER_SPECIFIC_THROW',
            miss: true,
            sector: name || bed || 'Miss'
        };
    }

    // Bull: Autodarts uses number 25 with mult 1 (outer) or 2 (inner)
    const nameUpper = name.toUpperCase();
    const isBull =
        Number(number) === 25
        || nameUpper === '25'
        || nameUpper === 'S25'
        || nameUpper === 'BULL'
        || nameUpper === 'DBULL'
        || nameUpper === 'BULLSEYE'
        || /^bull/i.test(bed);

    if (isBull) {
        const mult = multiplier === 2 ? 2 : 1;
        return {
            type: 'TRIGGER_SPECIFIC_THROW',
            number: 'bull',
            multiplier: mult,
            sector: name || (mult === 2 ? 'Bull' : '25')
        };
    }

    const n = Number(number);
    if (!Number.isFinite(n) || n < 1 || n > 20) {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true, sector: name || String(number) };
    }

    let mult = multiplier;
    if (![1, 2, 3].includes(mult)) {
        if (/^t/i.test(name) || /triple/i.test(bed)) mult = 3;
        else if (/^d/i.test(name) || /double/i.test(bed)) mult = 2;
        else mult = 1;
    }

    // Quackshot (and Scolia-style sectors) need inner vs outer single:
    //   SingleInner → sN  (+1 duck)
    //   SingleOuter → SN  (−1 splash)
    // Autodarts names both as "S5"; the bed field is the real discriminator.
    let sector = name;
    if (mult === 1) {
        if (/singleinner/i.test(bed) || /^inner/i.test(bed)) {
            sector = `s${n}`;
        } else if (/singleouter/i.test(bed) || /^outer/i.test(bed)) {
            sector = `S${n}`;
        } else if (!sector) {
            sector = `S${n}`;
        }
    } else if (!sector) {
        sector = `${mult === 3 ? 'T' : 'D'}${n}`;
    }

    return {
        type: 'TRIGGER_SPECIFIC_THROW',
        number: n,
        multiplier: mult,
        sector
    };
}

function mapAutodartsThrowEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true };
    }
    return mapAutodartsSegment(entry.segment);
}

module.exports = { mapAutodartsSegment, mapAutodartsThrowEntry };

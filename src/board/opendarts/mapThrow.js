/**
 * OpenDarts `throw` event → FlightDeck TRIGGER_SPECIFIC_THROW
 *
 * Vocabulary per OpenDarts `docs/LIVE_API.md`, "Ring / sector / label /
 * value" section.
 *
 * This is the LIVE-WIRE vocabulary (top-level `ring`/`sector` on a `throw`
 * event, i.e. Zeus's own answer — Zeus being the consensus/voting engine;
 * see `consensus`, a separate real object on the event). NOT the same as
 * the persisted on-disk package vocabulary ("outside"/"OUT" instead of
 * "miss"/"MISS") — that vocabulary is never reachable over this live API
 * and must not be used to build fixtures for this mapper.
 *
 *   ring          sector           label              meaning
 *   ------------  ---------------  -----------------  --------------------------------
 *   bull          25 (convention)  "BULL"             double bull / 50
 *   outer_bull    25 (convention)  "25"               outer/single bull / 25
 *   single_inner  1-20             "S{n}"             single, inside the treble ring
 *   single_outer  1-20             "S{n}"             single, outside the treble ring
 *   treble        1-20             "T{n}"             treble ring
 *   double        1-20             "D{n}"             double ring
 *   miss          0                "MISS"             off the board — a confident answer
 *   "" (empty)    0                "failed to score"  NO answer at all (an abstention,
 *                                                      e.g. Apollo distrusting its own
 *                                                      triangulation) — genuinely
 *                                                      different from "miss", do not
 *                                                      collapse the two.
 *
 * bull and outer_bull share sector=25 — the multiplier MUST come from
 * `ring`, never inferred from `sector` alone.
 *
 * single_inner/single_outer deliberately stay distinct on the wire (sN vs
 * SN) — same convention Autodarts/OpenDarts use here (see those
 * providers' own mapThrow.js): SingleInner → sN (+1 Quackshot duck),
 * SingleOuter → SN (−1 splash). Ring, not a shared "S5" string, is the
 * real discriminator.
 *
 * `value` (sector * multiplier, already computed server-side) is the
 * authoritative score and safe to trust directly if a caller only needs
 * the total — this mapper still derives number+multiplier separately
 * because FlightDeck's throw model wants them split out.
 */
function mapOpenDartsThrow(payload) {
    if (!payload || typeof payload !== 'object') {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true };
    }

    const ring = payload.ring != null ? String(payload.ring) : '';

    // Engine reached NO answer at all (ok:false abstention) — distinct fact
    // from a confident off-board "miss". Both score as a miss for gameplay,
    // but keep the sector label distinguishable for logs/diagnostics.
    if (ring === '') {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true, sector: 'no answer' };
    }

    if (ring === 'miss') {
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true, sector: 'MISS' };
    }

    if (ring === 'bull') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: 'bull', multiplier: 2, sector: 'Bull' };
    }

    if (ring === 'outer_bull') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: 'bull', multiplier: 1, sector: '25' };
    }

    const n = Number(payload.sector);
    if (!Number.isFinite(n) || n < 1 || n > 20) {
        // Unknown/out-of-range sector for a wedge ring — don't guess, don't misscore.
        return { type: 'TRIGGER_SPECIFIC_THROW', miss: true, sector: `${ring}:${payload.sector}` };
    }

    if (ring === 'treble') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: n, multiplier: 3, sector: `T${n}` };
    }
    if (ring === 'double') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: n, multiplier: 2, sector: `D${n}` };
    }
    if (ring === 'single_inner') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: n, multiplier: 1, sector: `s${n}` };
    }
    if (ring === 'single_outer') {
        return { type: 'TRIGGER_SPECIFIC_THROW', number: n, multiplier: 1, sector: `S${n}` };
    }

    // Unknown ring name (future API addition) — don't silently misscore.
    return { type: 'TRIGGER_SPECIFIC_THROW', miss: true, sector: `${ring}:${payload.sector}` };
}

module.exports = { mapOpenDartsThrow };

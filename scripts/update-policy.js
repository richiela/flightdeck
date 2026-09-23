#!/usr/bin/env node
/* Decides whether run.sh should pull before it starts the server, and prints
 * that decision on stdout: a line beginning "pull" means pull, anything else
 * (including no output at all) means start what is already here.
 *
 * This mirrors opendarts' own update_policy.py, and exists for the same two
 * reasons.
 *
 * ONE PARSER. The flags live in JSON, and a grep/sed against hand-editable
 * JSON is a second parser that will eventually disagree with the real one
 * about the single file deciding which code this rig runs. So bash asks node,
 * and node uses JSON.parse.
 *
 * THE ONE-SHOT IS CLEARED AS IT IS READ, before the pull is attempted rather
 * than after. A pull that fails, or a crash during one, must not leave a rig
 * pulling on every restart for ever -- the failure is loud once and then the
 * rig stays where it is.
 *
 * Flags live in data/update.json, which is gitignored along with the rest of
 * data/ and is absent by default (absent means "never pull"):
 *
 *   { "alwaysUpdate": false, "updateOnNextRestart": false }
 *
 *   alwaysUpdate          this machine follows its branch; pull every restart.
 *                         For a dev box that wants the old behaviour.
 *   updateOnNextRestart   pull once, on the next restart only. This is the one
 *                         to set to deploy: push, set it, restart.
 *
 * Deliberately NOT part of data/venue.json: saveVenueConfig() normalises that
 * file to its known keys, so anything extra would be silently dropped the next
 * time someone saved the Configure modal.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'update.json');

let cfg = {};
try {
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
} catch (err) {
    // Told apart from "do not pull" on purpose: a rig behaving as configured
    // and a rig whose configuration cannot be read are different problems.
    process.stderr.write(`[update-policy] cannot read ${file}: ${err.message}\n`);
    process.exit(2);
}

const always = cfg.alwaysUpdate === true;
const once = cfg.updateOnNextRestart === true;

if (once) {
    // Clear first, then report. If writing back fails, say so and do NOT ask
    // for the pull -- a flag we cannot clear is one that would fire for ever.
    try {
        cfg.updateOnNextRestart = false;
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    } catch (err) {
        process.stderr.write(`[update-policy] could not clear updateOnNextRestart: ${err.message}\n`);
        process.exit(2);
    }
    process.stdout.write('pull (updateOnNextRestart, now cleared)\n');
} else if (always) {
    process.stdout.write('pull (alwaysUpdate)\n');
} else {
    process.stdout.write('skip\n');
}

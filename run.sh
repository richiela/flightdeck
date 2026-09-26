#!/usr/bin/env bash
# Starts FlightDeck and keeps it started: if the server exits for any reason,
# this relaunches it. With no data/board.json it runs against a mock board, so
# a fresh clone needs no hardware; once a board is configured, that is what runs.
#
#   ./run.sh                     # port 4000
#   PORT=5000 ./run.sh           # different port
#   SCORING_MODE=mock ./run.sh   # force the mock board even when configured
#
# Deploying is "push, then ask for an update" -- see update policy below. To
# develop with auto-reload on file changes, use `npm run dev` instead; this
# script runs node directly, because nodemon restarts in-process and the
# supervisor loop below would then never see the server exit.
#
# `set -e` would be wrong here: this is a supervisor, and it must survive the
# things it supervises failing.
set -uo pipefail
cd "$(dirname "$0")"

# Check what we need and say what is missing, rather than installing it.
# Installing a runtime wants a package manager and usually root, differs on
# every platform, and would quietly shadow an nvm/asdf node the machine already
# manages. A precise error you can act on beats a surprise system change.
NODE_MIN=18   # express 5 requires >= 18; nothing in src/ needs newer

missing=()

if ! command -v node >/dev/null 2>&1; then
    missing+=("node ${NODE_MIN}+ — not installed")
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MIN" ]; then
    missing+=("node ${NODE_MIN}+ — found $(node -v), too old (express 5 needs ${NODE_MIN}+)")
fi

command -v npm >/dev/null 2>&1 || missing+=("npm — not installed (normally ships with node)")
command -v openssl >/dev/null 2>&1 || missing+=("openssl — not installed, needed for the local TLS cert")

if [ ${#missing[@]} -gt 0 ]; then
    echo "FlightDeck can't start. Missing:" >&2
    for m in "${missing[@]}"; do echo "  - $m" >&2; done
    echo "" >&2
    echo "  macOS:   brew install node openssl" >&2
    echo "  Debian:  sudo apt install nodejs npm openssl" >&2
    echo "  or:      https://nodejs.org/ (LTS)" >&2
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm install || { echo "[run.sh] npm install failed" >&2; exit 1; }
fi

if [ ! -f certs/server.key ] || [ ! -f certs/server.crt ]; then
    echo "Generating a local self-signed TLS cert (certs/server.key + server.crt)..."
    mkdir -p certs
    openssl req -x509 -newkey rsa:2048 -keyout certs/server.key -out certs/server.crt \
        -days 365 -nodes -subj "/CN=localhost"
fi

PORT="${PORT:-4000}"

# Mock only when nothing is configured; SCORING_MODE beats data/board.json by
# design, so run.sh must not set it when a board IS configured, or the rig
# silently scores nothing.
#
# The choice is made per LAUNCH, inside the loop below, not once here. It used
# to be exported once at startup, which made it stick: mini's supervisor
# started before it had a board.json, and every server restart afterwards
# inherited mock, so writing board.json and restarting the server changed
# nothing. Now adding or removing board.json takes effect on the next restart.
#
# A SCORING_MODE given by whoever started us is an explicit override and still
# wins, both ways. It is remembered in FD_SCORING_MODE_EXPLICIT so it survives
# the self re-exec after a pull, then removed from our own environment so it
# can only ever reach the server through the launch line.
if [ -z "${FD_SCORING_MODE_EXPLICIT+set}" ]; then
    export FD_SCORING_MODE_EXPLICIT="${SCORING_MODE:-}"
fi
unset SCORING_MODE

# ------------------------------------------------------------ update policy --
# THIS LOOP DELIBERATELY DOES NOT PULL ON EVERY RELAUNCH. The relaunch happens
# whenever the server exits, which includes crashing -- so pulling here would
# mean a rig that fell over mid-match comes back on whatever was on its branch
# at that second, possibly a commit pushed minutes earlier by someone who did
# not know a match was running. Updating would be something that happens TO the
# operator. opendarts' run.sh shipped exactly that bug and removed it; this is
# the same design, and scripts/update-policy.js is the counterpart of its
# update_policy.py.
#
# To deploy: push, then ask for the update and restart.
#     echo '{"updateOnNextRestart":true}' > data/update.json
# or set "alwaysUpdate": true for a machine that should always follow its branch.
pull_if_requested() {
    local branch="$1" decision=""
    decision="$(node scripts/update-policy.js 2>/dev/null)"
    if [ -z "$decision" ]; then
        echo "[run.sh] WARNING: could not read data/update.json — NOT pulling." >&2
        return 1
    fi
    case "$decision" in
        pull*) ;;
        *) return 1 ;;
    esac

    # A reboot runs this before the network is up. On dartsrig the pull fired
    # 7 s after boot and failed with "Could not resolve host", so auto-update
    # never happened on a reboot at all. The service's After=network-online
    # does not cover it: darts-apps is a USER unit, and the user manager's
    # network-online.target does not track the real network. So wait for the
    # remote itself, bounded, instead of trusting startup order. No `timeout`
    # command here -- macOS rigs do not ship one -- so git's own low-speed
    # limit keeps a half-up network from hanging a probe.
    local waited=0
    until git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=8 \
              ls-remote --exit-code -q origin HEAD >/dev/null 2>&1; do
        if [ "$waited" -ge 90 ]; then
            echo "[run.sh] WARNING: $(git remote get-url origin 2>/dev/null) still unreachable after ${waited}s — NOT pulling." >&2
            echo "[run.sh] Starting the code that is already here. A one-shot update request has been used up; set it again once the network is back." >&2
            return 1
        fi
        [ "$waited" -eq 0 ] && echo "[run.sh] waiting for the network before pulling..."
        sleep 3; waited=$((waited + 3))
    done

    echo "[run.sh] $(date): pulling latest ($branch) — $decision"
    if ! git pull --ff-only origin "$branch"; then
        # Loud, and it does not retry: the one-shot flag is already cleared, and
        # a repository that cannot fast-forward would otherwise fail this way on
        # every single restart while starting the old code regardless.
        echo "[run.sh] ERROR: git pull failed or was not a fast-forward." >&2
        echo "[run.sh] STARTING THE EXISTING CODE AS-IS. This will not retry by" >&2
        echo "[run.sh] itself — ask again once the repository can fast-forward." >&2
        return 1
    fi
    return 0
}

while true; do
    # Follows whatever branch is checked out, so a rig can run a feature branch
    # by checking it out once.
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
    before="$(git rev-parse HEAD 2>/dev/null || echo none)"

    if pull_if_requested "$branch"; then
        after="$(git rev-parse HEAD 2>/dev/null || echo none)"

        # Bash reads a script by BYTE OFFSET as it runs it. If the pull rewrote
        # run.sh underneath us, everything after this point is read from the new
        # file at the old offset — which is how a deploy turns into a syntax
        # error in the middle of a line. Start over from the new script instead.
        if [ "$before" != "$after" ] && ! git diff --quiet "$before" "$after" -- run.sh 2>/dev/null; then
            echo "[run.sh] run.sh itself changed in that pull — re-executing it"
            exec "$0" "$@"
        fi

        # Dependencies can move with the code, so only after a pull that landed.
        if [ "$before" != "$after" ]; then
            npm install || echo "[run.sh] WARNING: npm install failed — starting with what is installed" >&2
        fi
    fi

    if [ -n "$FD_SCORING_MODE_EXPLICIT" ]; then
        board_mode="$FD_SCORING_MODE_EXPLICIT"
    elif [ ! -f data/board.json ]; then
        board_mode=mock
    else
        board_mode=""
    fi
    if [ "$board_mode" = mock ]; then
        board_desc="mock board, no hardware needed"
    else
        board_desc="board from data/board.json"
    fi

    echo ""
    echo "[run.sh] $(date): starting FlightDeck (${board_desc})"
    echo "[run.sh] open https://localhost:${PORT}/control.html"
    echo "[run.sh] (accept the self-signed cert warning the first time)"
    echo ""

    if [ -n "$board_mode" ]; then
        SCORING_MODE="$board_mode" PORT="$PORT" node src/server.js "$@"
    else
        PORT="$PORT" node src/server.js "$@"
    fi

    echo "[run.sh] $(date): server exited, restarting in 3s..."
    sleep 3
done

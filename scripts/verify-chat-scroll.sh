#!/usr/bin/env bash
set -euo pipefail

# Brings up a throwaway gateway with a long seeded transcript and prints the URL to
# drive the chat-scroll QA against. Everything it needs is in this repository, and
# everything it creates is removed on exit, pass or fail.
#
# The caller's shell usually carries its own live instance: a Jinn session exports
# JINN_HOME, JINN_PORT, JINN_HOST, JINN_INSTANCE and the gateway URL/token/session id.
# Those are not inert here. resolveJinnHome() (packages/jinn/src/shared/home.ts) returns
# $JINN_HOME outright, and applyGatewayEnvOverrides() (packages/jinn/src/shared/config.ts)
# then replaces whatever port the sandbox's own config.yaml declares with $JINN_PORT.
# Inherited, they aim this script's setup/start/pair/stop cycle at the operator's gateway
# instead of the throwaway sandbox — which is how a verification run reached production
# once already. Scrub them before anything reads them. The script's own inputs, the
# JINN_VERIFY_* knobs, are deliberately kept.
unset JINN_HOME JINN_PORT JINN_HOST JINN_INSTANCE JINN_GATEWAY_URL JINN_GATEWAY_TOKEN JINN_SESSION_ID

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${JINN_VERIFY_PORT:-8062}"
TMP_BASE="${JINN_VERIFY_TMP_ROOT:-/tmp}"
HOLD_SECONDS="${JINN_VERIFY_HOLD_SECONDS:-900}"
SESSION="device-scroll-check"
JINN_CLI="$REPO/packages/jinn/dist/bin/jinn.js"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 8060 )) || [[ "$PORT" == "7777" || "$PORT" == "7788" ]]; then
  echo "JINN_VERIFY_PORT must be an integer at or above 8060 and cannot be 7777 or 7788" >&2
  exit 2
fi
if [[ ! "$HOLD_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "JINN_VERIFY_HOLD_SECONDS must be a whole number of seconds (0 tears down immediately)" >&2
  exit 2
fi

# The Node this checkout's native addons are compiled against, not whatever `node`
# resolves to. A machine that also carries a Homebrew Node has a different ABI first
# on PATH, and better-sqlite3 then fails to load halfway through the run. `.npmrc`
# pins `use-node-version`, so pnpm knows the right one even when the shell does not.
PNPM_BIN="$(command -v pnpm || true)"
if [[ -z "$PNPM_BIN" ]]; then echo "pnpm is required to resolve the Node this checkout is built for" >&2; exit 2; fi
PINNED_NODE="$(tr -d '[:space:]' < "$REPO/.nvmrc")"
NODE_BIN="${JINN_VERIFY_NODE_BIN:-$(cd "$REPO" && "$PNPM_BIN" exec node -e 'process.stdout.write(process.execPath)')}"
NODE_VERSION="$("$NODE_BIN" -e 'process.stdout.write(process.versions.node)')"
if [[ "$NODE_VERSION" != "$PINNED_NODE" ]]; then
  echo "Resolved Node $NODE_VERSION, but this checkout is pinned to $PINNED_NODE by .nvmrc." >&2
  echo "Install it (nvm install $PINNED_NODE) or point JINN_VERIFY_NODE_BIN at that binary." >&2
  exit 2
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

# better-sqlite3 loads its addon on first open rather than on require, so an ABI
# mismatch surfaces deep inside `setup` as a dlopen stack trace. Open one throwaway
# database up front and turn that into a sentence with the fix in it.
if ! JINN_VERIFY_REPO="$REPO" "$NODE_BIN" -e '
const { createRequire } = require("node:module")
const Database = createRequire(process.env.JINN_VERIFY_REPO + "/packages/jinn/package.json")("better-sqlite3")
new Database(":memory:").close()' >/dev/null 2>&1; then
  echo "better-sqlite3 in this checkout does not load under Node $NODE_VERSION." >&2
  echo "Rebuild it for the pinned Node: pnpm rebuild better-sqlite3" >&2
  exit 2
fi

if [[ ! -f "$JINN_CLI" ]]; then
  echo "$JINN_CLI is missing — run pnpm build first" >&2
  exit 2
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Candidate port $PORT is already in use" >&2
  exit 2
fi

VERIFY_ROOT="$(mktemp -d "$TMP_BASE/jinn-chat-scroll.XXXXXX")"
HOST_HOME="$VERIFY_ROOT/host"
SANDBOX_HOME="$HOST_HOME/.jinn-chat-scroll-check"
CONFIG_FILE="$SANDBOX_HOME/config.yaml"
BASE_URL="http://127.0.0.1:$PORT"
GATEWAY_PID=""
HOLD_PID=""

# Every process this run is answerable for: HOST_HOME is a mktemp path created moments
# ago, so a process whose environment names it is the daemon this script started or
# something that daemon started in turn. Parent links are not enough — the gateway probes
# its engines at boot, and a `codex` plugin clone or an `npx` fetch left orphaned by an
# early teardown is reparented away from the tree while it goes on writing into the home.
# `jinn stop` is not used either: when its PID file looks stale it falls back to killing
# whoever owns the port, and this script has no business signalling something it did not
# start. A listener that survives is reported, never killed.
pids_holding_sandbox_home() {
  JINN_VERIFY_SANDBOX_HOME="$HOST_HOME" "$NODE_BIN" -e '
const { spawnSync } = require("node:child_process")
// The scan must not find itself. This process carries the home in its own environment and
// any child would inherit it, so `ps` is given PATH and nothing else, and this pid is
// skipped. Reading the table through a shell pipeline instead puts the home into the
// arguments of the pipeline itself: a match that never clears and a sweep that never ends.
const needle = "HOME=" + process.env.JINN_VERIFY_SANDBOX_HOME + " "
// `ps -A` exits non-zero when a process disappears mid-listing, and the rows it did print
// are still the answer, so its status is ignored rather than thrown on.
const listing = spawnSync("ps", ["eww", "-A", "-o", "pid=,state=,command="], { encoding: "utf8", env: { PATH: process.env.PATH } })
for (const line of (listing.stdout || "").split("\n")) {
  const [pid, state] = line.trim().split(/\s+/)
  // A zombie is already dead; it sits in the table until init reaps it, and waiting for
  // one to leave never ends.
  if (!pid || !state || state.startsWith("Z") || Number(pid) === process.pid) continue
  if ((line + " ").includes(needle)) process.stdout.write(pid + "\n")
}'
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$HOLD_PID" ]]; then kill "$HOLD_PID" 2>/dev/null || true; fi
  # The gateway probes its engines at boot, and those children finish on their own within a
  # few seconds. Killing one mid-write is what leaves a straggler writing into the home after
  # the delete, so wait for the daemon to be the only holder left rather than interrupting
  # them. What stays invisible to this scan is handled by the repeated delete further down.
  local holders=""
  for _ in {1..60}; do
    holders="$(pids_holding_sandbox_home 2>/dev/null | tr '\n' ' ' || true)"
    if [[ -z "${holders// /}" || "${holders// /}" == "$GATEWAY_PID" ]]; then break; fi
    sleep 0.25
  done

  for attempt in {1..60}; do
    holders="$(pids_holding_sandbox_home 2>/dev/null | tr '\n' ' ' || true)"
    if [[ -z "${holders// /}" ]]; then break; fi
    if (( attempt < 12 )); then
      kill -TERM $holders 2>/dev/null || true
    else
      kill -KILL $holders 2>/dev/null || true
    fi
    sleep 0.25
  done
  if [[ -n "${holders// /}" ]]; then
    echo "Processes started by this run still hold $HOST_HOME: $holders" >&2
    status=3
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "A listener remains on port $PORT" >&2
    status=3
  fi
  if [[ "$VERIFY_ROOT" != "$TMP_BASE"/jinn-chat-scroll.* ]]; then
    echo "Refusing to remove a path outside the run's own root: $VERIFY_ROOT" >&2
    status=3
  else
    # The sweep above accounts for everything whose environment macOS will show, which is
    # every node process the gateway started. A system binary hides its environment, so an
    # engine's boot-time plugin clone can be orphaned by a teardown that lands seconds after
    # start and write a cache directory back here about a second later. Measured, that is one
    # late burst rather than a stream, so the delete repeats until the ground has stayed
    # clear for two seconds.
    local absent_streak=0
    for _ in {1..32}; do
      rm -rf "$VERIFY_ROOT" 2>/dev/null || true
      sleep 0.25
      if [[ -e "$VERIFY_ROOT" ]]; then absent_streak=0; else absent_streak=$(( absent_streak + 1 )); fi
      if (( absent_streak >= 8 )); then break; fi
    done
  fi
  if [[ -e "$VERIFY_ROOT" ]]; then
    # Nothing that matters is left: the gateway is stopped, the port is free and the sandbox
    # home is gone. What came back is an empty npm cache skeleton written by an engine probe
    # orphaned at boot, whose environment macOS does not expose, so it cannot be waited for
    # by name. Say where it is rather than fail a run whose guarantees all held.
    echo "Left behind an empty cache directory at $VERIFY_ROOT — safe to delete." >&2
  else
    echo "Stopped the chat-scroll sandbox and removed $VERIFY_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Merges a JSON patch into the sandbox's `gateway:` block, through the same YAML
# parser the gateway reads it with.
patch_gateway_config() {
  SANDBOX_CONFIG="$CONFIG_FILE" GATEWAY_PATCH="$1" JINN_VERIFY_REPO="$REPO" "$NODE_BIN" -e '
const fs = require("node:fs")
const { createRequire } = require("node:module")
const YAML = createRequire(process.env.JINN_VERIFY_REPO + "/packages/jinn/package.json")("yaml")
const file = process.env.SANDBOX_CONFIG
const config = YAML.parse(fs.readFileSync(file, "utf8")) ?? {}
config.gateway = { ...(config.gateway ?? {}), ...JSON.parse(process.env.GATEWAY_PATCH) }
fs.writeFileSync(file, YAML.stringify(config))'
}

mkdir -p "$HOST_HOME"
echo "Creating a throwaway home at $SANDBOX_HOME"
env HOME="$HOST_HOME" JINN_HOME="$SANDBOX_HOME" JINN_NO_OPEN=1 "$NODE_BIN" "$JINN_CLI" setup </dev/null

# A fresh home ships gateway.port 7777, and the start/stop lifecycle kills whatever owns
# the CONFIGURED port — so the file has to be rewritten before anything reads it, not
# merely overridden with -p at start.
patch_gateway_config "{\"port\": $PORT, \"authRequired\": false}"

# Seeds the long transcript. The gateway must not be running: the fixture opens the
# home's sqlite registry directly.
"$NODE_BIN" "$REPO/scripts/device-scroll-fixture.mjs" --home "$SANDBOX_HOME"

# The fixture opens the bind to 0.0.0.0 so a physical phone can reach it. This run is a
# desktop review, so put it back on loopback; a non-loopback bind would also force auth
# back on.
patch_gateway_config '{"host": "127.0.0.1"}'

CONFIGURED_PORT="$(SANDBOX_CONFIG="$CONFIG_FILE" JINN_VERIFY_REPO="$REPO" "$NODE_BIN" -e '
const fs = require("node:fs")
const { createRequire } = require("node:module")
const YAML = createRequire(process.env.JINN_VERIFY_REPO + "/packages/jinn/package.json")("yaml")
const port = YAML.parse(fs.readFileSync(process.env.SANDBOX_CONFIG, "utf8"))?.gateway?.port
process.stdout.write(port === undefined || port === null ? "" : String(port))')"
if [[ "$CONFIGURED_PORT" == "7777" || "$CONFIGURED_PORT" == "7788" ]]; then
  echo "Sandbox config.yaml declares gateway port $CONFIGURED_PORT — 7777 is the production gateway and 7788 the operator's demo instance, and the lifecycle kills whatever owns the configured port." >&2
  echo "Fix: set gateway.port in $CONFIG_FILE to a free port at or above 8060, or re-run with JINN_VERIFY_PORT set to one." >&2
  exit 2
fi
if [[ "$CONFIGURED_PORT" != "$PORT" ]]; then
  echo "Sandbox config.yaml declares gateway port ${CONFIGURED_PORT:-<none>}, expected $PORT" >&2
  exit 2
fi
echo "Sandbox config.yaml declares gateway port $CONFIGURED_PORT before start"

env HOME="$HOST_HOME" JINN_HOME="$SANDBOX_HOME" JINN_NO_OPEN=1 "$NODE_BIN" "$JINN_CLI" start --daemon -p "$PORT"
GATEWAY_PID="$(cat "$SANDBOX_HOME/gateway.pid" 2>/dev/null || true)"
if [[ -z "$GATEWAY_PID" ]]; then
  echo "The daemon did not record a PID in $SANDBOX_HOME/gateway.pid" >&2
  exit 2
fi

# `start --daemon` returns as soon as the child is spawned, so the pairing request below
# would race the listener. Wait for the gateway to answer, and give up early if the
# daemon exits instead.
READY=0
for _ in {1..80}; do
  if curl -sS -o /dev/null --max-time 2 "$BASE_URL/" 2>/dev/null; then READY=1; break; fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "The sandbox gateway exited during startup; its logs are in $SANDBOX_HOME/logs" >&2
    exit 2
  fi
  sleep 0.25
done
if (( READY != 1 )); then
  echo "The sandbox gateway did not answer on $BASE_URL within 20s" >&2
  exit 2
fi

PAIRING_CODE="$(env HOME="$HOST_HOME" JINN_HOME="$SANDBOX_HOME" "$NODE_BIN" "$JINN_CLI" pair --json \
  | "$NODE_BIN" -e 'let raw = ""
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).code))')"

cat <<BANNER

The chat-scroll sandbox is up.

  Open:         $BASE_URL/chat?session=$SESSION
  Pairing code: $PAIRING_CODE
  Sandbox home: $SANDBOX_HOME (removed on exit)
  Gateway PID:  $GATEWAY_PID on 127.0.0.1:$PORT

Set localStorage 'jinn-onboarded' to 'true' to skip the first-run wizard on this
fresh home. Drive the page with agent-browser on a profile of its own. Do not use
'pnpm dev': the Vite dev server proxies its API and HMR socket back to the gateway
port it is given, which reaches straight into production.
BANNER

if (( HOLD_SECONDS > 0 )); then
  echo
  echo "Holding for ${HOLD_SECONDS}s — press Ctrl-C when the QA run is done."
  echo "JINN_VERIFY_HOLD_SECONDS=0 tears the sandbox down as soon as it is proven up."
  # `wait` is interruptible where `sleep` is not: bash defers a trap until the current
  # foreground command returns, so sleeping directly here would swallow Ctrl-C.
  sleep "$HOLD_SECONDS" &
  HOLD_PID=$!
  wait "$HOLD_PID" || true
fi

#!/usr/bin/env bash
# Boot-level verification of a built Jinn image.
#
# `docker build` never loads a native addon and never starts the gateway, so the failure
# worth catching — an image that builds but cannot spawn a session — is invisible to it.
# This script is what actually exercises that: a wrong-ABI better-sqlite3 binding, a
# skipped node-pty build, a build filtered to the jinn package so the dashboard is
# missing, a broken HEALTHCHECK, or a boot that trips over a stale gateway.pid.
#
# Shared by the CI `docker` job and the GHCR publish workflow rather than duplicated in
# both: CI proves amd64 on every push to main, and the publish workflow is the only place
# arm64 is ever built, so the two must be asking the same questions.
#
# Usage: scripts/docker-smoke.sh <image> [container-name] [host-port]
set -euo pipefail

IMAGE="${1:?usage: docker-smoke.sh <image> [container-name] [host-port]}"
CONTAINER="${2:-jinn-smoke}"
PORT="${3:-7777}"

WORK_DIR="$(mktemp -d)"

# Both docker calls tolerate a container that is already gone: under `set -e` a failure
# inside the helper aborts the script before it reaches the echo, so the one message
# explaining the failure would be lost with it.
give_up() {
  docker logs "$CONTAINER" || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
  echo "$1"
  exit 1
}

# An interrupted run (job cancelled, timeout) must not leave the container behind to
# collide with the next one on the same runner.
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK_DIR"' EXIT

# -m: a gateway that accepts and never answers would otherwise hold the script until the
# job timeout instead of reaching give_up.
wait_for_status() {
  for _ in $(seq 1 60); do
    curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Formula/jinn.rb asserts the same for the Homebrew install. --workdir is the jinn package
# because pnpm links these under packages/jinn/node_modules. Fails closed: a lost exit
# event must not drain the loop and exit 0.
native_probe=$(cat <<'JS'
process.exitCode = 1;
const Database = require("better-sqlite3");
new Database(":memory:").close();
const pty = require("node-pty");
const timer = setTimeout(() => {
  console.error("pty exit event never arrived");
  process.exit(1);
}, 30000);
const p = pty.spawn("/bin/sh", ["-c", "exit 0"], {});
p.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0) { console.error("pty exited " + exitCode); return; }
  process.exitCode = 0;
  console.log("better-sqlite3 + node-pty OK");
});
JS
)

echo "==> native addons load and a PTY spawns"
docker run --rm --workdir /opt/jinn/packages/jinn --entrypoint node "$IMAGE" -e "$native_probe"

# End-to-end boot: first-run `jinn setup` on an empty volume, scripts/docker-configure.mjs
# (which exits non-zero rather than leaving the gateway on the container's loopback), and
# the port publish. /api/status is deliberately auth-exempt, so this needs no token.
echo "==> gateway boots and answers"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --init -p "127.0.0.1:${PORT}:7777" "$IMAGE" >/dev/null
wait_for_status || give_up "gateway never answered on /api/status"

# A healthy public status route does not prove the auth boundary survived the
# image/entrypoint wiring. A protected read must reject a request with no token.
protected_status=$(curl -sS -m 10 -o "$WORK_DIR/protected.json" -w '%{http_code}' \
  "http://127.0.0.1:${PORT}/api/sessions") \
  || give_up "the protected-route auth probe could not reach the gateway"
[ "$protected_status" = "401" ] \
  || give_up "unauthenticated /api/sessions returned HTTP $protected_status instead of 401"

# The dashboard, not just the API: a build filtered to the jinn package ships a gateway
# with no UI, and /api/status answers 200 either way. `id="root"` is the marker
# dashboardIsReady() uses in gateway/lifecycle.ts. Not piped into grep — `grep -q` closes
# the pipe on the first match and curl then fails under pipefail.
curl -fsS -m 10 "http://127.0.0.1:${PORT}/" -o "$WORK_DIR/index.html" \
  || give_up "the gateway did not serve / at all"
grep -q 'id="root"' "$WORK_DIR/index.html" \
  || give_up "the gateway served no dashboard at / (image built without dist/web?)"

# The HEALTHCHECK is the only signal for a gateway that is alive but not serving, so a
# broken probe is a silent loss of it. `|| true` because docker inspect exits non-zero on
# a container that has gone, which under `set -e` would kill the script before give_up()
# dumps the logs.
health=
for _ in $(seq 1 45); do
  health=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)
  [ "$health" = "healthy" ] && break
  sleep 2
done
[ "$health" = "healthy" ] || give_up "HEALTHCHECK never reported healthy (last: ${health:-none})"

# A leftover gateway.pid names a number the next container has recycled, and it answers
# kill(pid, 0) as an unrelated process — `jinn start` then detaches and exits PID 1 into a
# restart loop. The boot has to clear it.
docker exec "$CONTAINER" sh -c 'echo 1 > /home/node/.jinn/gateway.pid'
docker restart "$CONTAINER" >/dev/null
wait_for_status || give_up "gateway did not come back after a restart with a stale gateway.pid"

docker logs "$CONTAINER"
docker rm -f "$CONTAINER" >/dev/null
echo "==> $IMAGE passed"

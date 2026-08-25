import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

const SCRIPT_PATH = path.resolve("scripts/verify-chat-scroll.sh")
const script = fs.readFileSync(SCRIPT_PATH, "utf8")

const UNSET = /^unset (JINN_(?:[A-Z_]+ )*JINN_[A-Z_]+)$/m

/**
 * The gateway's own list of the variables that name an instance, read from source so this
 * test tracks it. sandbox-env.ts is TypeScript, so the names are lifted from the literal
 * rather than imported.
 */
function instanceIdentityKeys() {
  const source = fs.readFileSync(path.resolve("packages/jinn/src/shared/sandbox-env.ts"), "utf8")
  const block = source.match(/JINN_INSTANCE_IDENTITY_ENV_KEYS = \[([^\]]+)\]/)
  assert.ok(block, "expected JINN_INSTANCE_IDENTITY_ENV_KEYS in sandbox-env.ts")
  const keys = [...block[1].matchAll(/"(JINN_[A-Z_]+)"/g)].map((match) => match[1])
  assert.ok(keys.length >= 8, `expected the identity list, got ${keys.length} entries`)
  return keys
}

/**
 * A Jinn session exports the variables that name WHICH instance a process belongs to.
 * resolveJinnHome() honours JINN_HOME over HOME and applyGatewayEnvOverrides() honours
 * JINN_PORT over the sandbox's own config.yaml, so an inherited environment aims
 * setup/start/pair/stop at production; a verification run reached the operator's gateway
 * that way once. The set is read from sandbox-env.ts rather than copied, because a scrub
 * that lags behind the gateway's own retargeting list is the same bug with a smaller
 * blast radius — that is how JINN_HOME_IDENTITY, JINN_SESSION_CAPABILITY and
 * JINN_TAKE_PORT survived the first version of this script.
 */
test("every instance-identity variable the gateway retargets is scrubbed", () => {
  const unset = script.match(UNSET)
  assert.ok(unset, "expected a top-level `unset JINN_...` line")
  const scrubbed = new Set(unset[1].split(" "))
  for (const key of instanceIdentityKeys()) {
    assert.ok(scrubbed.has(key), `expected ${key} to be unset`)
  }
})

/** Sourcing the scrub must actually clear them, not merely name them. */
test("sourcing the scrub clears an inherited instance out of the shell", () => {
  const keys = instanceIdentityKeys()
  const prelude = script.slice(0, script.indexOf("\nREPO="))
  const probe = `${prelude}\nfor key in ${keys.join(" ")}; do echo "$key=\${!key-<unset>}"; done`
  const run = spawnSync("bash", ["-c", probe], {
    env: { ...process.env, ...Object.fromEntries(keys.map((key) => [key, "sentinel"])) },
    encoding: "utf8",
  })
  assert.equal(run.status, 0, run.stderr)
  for (const key of keys) {
    assert.match(run.stdout, new RegExp(`^${key}=<unset>$`, "m"), `${key} survived the scrub`)
  }
})

test("the scrub lands before the sandbox is resolved, seeded or started", () => {
  const scrub = script.indexOf("\nunset JINN_")
  assert.ok(scrub >= 0, "expected a top-level `unset JINN_...` line")
  assert.ok(scrub < script.indexOf('PORT="'), "scrub must precede port resolution")
  assert.ok(scrub < script.indexOf('SANDBOX_HOME="'), "scrub must precede home resolution")
  assert.ok(scrub < script.indexOf('"$JINN_CLI" setup'), "scrub must precede setup")
  assert.ok(scrub < script.indexOf('"$JINN_CLI" start'), "scrub must precede start")
})

/** JINN_VERIFY_* are this script's own inputs, not somebody else's instance. */
test("the scrub keeps the script's own knobs", () => {
  const scrubbed = new Set((script.match(UNSET)?.[1] ?? "").split(" "))
  for (const key of scrubbed) {
    assert.ok(!key.startsWith("JINN_VERIFY_"), `${key} is an input to this script, not a leak`)
  }
  assert.match(script, /PORT="\$\{JINN_VERIFY_PORT:-\d+\}"/)
})

test("the requested port stays out of the operator's range", () => {
  assert.match(script, /PORT < 8060/)
  assert.match(script, /"7777" \|\| "\$PORT" == "7788"/)
})

/**
 * The other half of the scrub: the sandbox is bound by its own config.yaml, and a fresh
 * home ships gateway.port 7777. The lifecycle kills whatever owns the CONFIGURED port, so
 * the file is what has to be right.
 *
 * The refusal is aimed at a config here rather than inferred from the script, because a
 * guard that only ever sees a port the same script just wrote is a guard nobody can watch
 * fail. device-scroll-fixture.mjs refuses a protected home too, but without naming a way
 * out — so the ordering below matters as much as the refusal.
 */
function writeConfig(dir, port) {
  const file = path.join(dir, "config.yaml")
  fs.writeFileSync(file, `gateway:\n  port: ${port}\n  host: "127.0.0.1"\n`)
  return file
}

for (const port of [7777, 7788]) {
  test(`a sandbox config on ${port} is refused with a message naming the fix`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sandbox-port-${port}.`))
    try {
      const run = spawnSync("node", ["scripts/assert-sandbox-port.mjs", writeConfig(dir, port), "8062"], {
        cwd: path.resolve("."),
        encoding: "utf8",
      })
      assert.notEqual(run.status, 0, "expected a non-zero exit")
      assert.match(run.stderr, new RegExp(`gateway\\.port ${port}`))
      assert.match(run.stderr, /Fix: set gateway\.port .* to a free port at or above 8060/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("a sandbox config on the port the run reserved is accepted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-port-ok."))
  try {
    const run = spawnSync("node", ["scripts/assert-sandbox-port.mjs", writeConfig(dir, 8062), "8062"], {
      cwd: path.resolve("."),
      encoding: "utf8",
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /declares gateway port 8062/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a config that drifted off the reserved port is refused too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-port-drift."))
  try {
    const run = spawnSync("node", ["scripts/assert-sandbox-port.mjs", writeConfig(dir, 8099), "8062"], {
      cwd: path.resolve("."),
      encoding: "utf8",
    })
    assert.notEqual(run.status, 0, "expected a non-zero exit")
    assert.match(run.stderr, /expected 8062/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the configured port is asserted before the fixture and before the daemon", () => {
  const guard = script.indexOf('"$REPO/scripts/assert-sandbox-port.mjs"')
  assert.ok(guard >= 0, "expected the config guard to be invoked")
  assert.ok(guard < script.indexOf('"$REPO/scripts/device-scroll-fixture.mjs"'), "must precede the fixture")
  const lastGuard = script.lastIndexOf('"$REPO/scripts/assert-sandbox-port.mjs"')
  assert.ok(lastGuard < script.indexOf('"$JINN_CLI" start'), "must precede start")
})

/**
 * Round 2 of this ticket died here: a foreground `start` never returns, so the `pair` on
 * the next line was unreachable, and the reviewer was left with a sandbox and no code.
 */
test("start is backgrounded and answering before a pairing code is requested", () => {
  const start = script.indexOf('"$JINN_CLI" start --daemon')
  assert.ok(start >= 0, "expected `start --daemon`")
  assert.match(script, /GATEWAY_PID="\$\(cat "\$SANDBOX_HOME\/gateway\.pid"/)
  const poll = script.indexOf("READY=1")
  const pair = script.indexOf('"$JINN_CLI" pair')
  assert.ok(start < poll, "the readiness poll must follow start")
  assert.ok(poll < pair, "the readiness poll must precede pair")
})

/**
 * `jinn stop` falls back to killing whoever owns the port when its PID file looks stale,
 * and this script must only ever signal what it started itself. The throwaway HOME proves
 * ownership: it is a mktemp path this run created, so anything whose environment names it
 * came from the daemon the run started. The scan has to exclude itself — it carries that
 * same home, and a shell pipeline would carry it in its arguments too, which is a match
 * that never clears and a sweep that never ends.
 */
test("teardown signals only what this run started, on every exit path", () => {
  assert.match(script, /^trap cleanup EXIT$/m)
  assert.match(script, /^trap 'exit 130' INT TERM$/m)
  assert.match(script, /JINN_VERIFY_SANDBOX_HOME="\$HOST_HOME"/)
  assert.match(script, /Number\(pid\) === process\.pid/)
  assert.match(script, /spawnSync\("ps", \[[^\]]*\], \{ encoding: "utf8", env: \{ PATH: process\.env\.PATH \} \}\)/)
  assert.match(script, /kill -TERM \$holders/)
  assert.match(script, /kill -KILL \$holders/)
  assert.doesNotMatch(script, /"\$JINN_CLI" stop/)
  assert.doesNotMatch(script, /kill .*\$\(lsof/)
})

test("the temp home is removed, and only from inside the run's own root", () => {
  assert.match(script, /if \[\[ "\$VERIFY_ROOT" != "\$TMP_BASE"\/jinn-chat-scroll\.\* \]\]/)
  assert.match(script, /rm -rf "\$VERIFY_ROOT"/)
  assert.match(script, /absent_streak >= 8/)
  assert.match(script, /Left behind an empty cache directory at \$VERIFY_ROOT/)
})

/**
 * The guards above read the script; this one runs it. A port the operator owns has to be
 * refused before the run touches the filesystem at all, so an empty tmp root is the
 * evidence that nothing was created on the way to the refusal.
 */
test("a run aimed at the production port is refused before it creates anything", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-chat-scroll-guard."))
  try {
    const run = spawnSync("bash", [SCRIPT_PATH], {
      cwd: path.resolve("."),
      env: { ...process.env, JINN_VERIFY_PORT: "7777", JINN_VERIFY_TMP_ROOT: tmpRoot },
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    })
    assert.notEqual(run.status, 0, "expected a non-zero exit")
    assert.match(run.stderr, /7777/)
    assert.deepEqual(fs.readdirSync(tmpRoot), [], "the refused run must not have created a sandbox")
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

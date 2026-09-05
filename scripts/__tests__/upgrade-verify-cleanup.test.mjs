import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createDisposableRoot, NONCE_FILE, removeDisposableRoot, stopGateway } from "../upgrade-verify-lib.mjs"

const library = new URL("../upgrade-verify-lib.mjs", import.meta.url).href

function disposable(t) {
  const root = createDisposableRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

// Run in a fresh process: Node's recursive remover captures fs.rmdir on first
// use. Interpose a real file write at the emptied-directory boundary, then let
// the real syscall produce ENOTEMPTY. There are no timing or load assumptions.
function racingRemoval(root, target, mode) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import path from 'node:path';
    const root = ${JSON.stringify(root)};
    const target = ${JSON.stringify(target)};
    const mode = ${JSON.stringify(mode)};
    const original = fs.rmdir;
    let writes = 0;
    fs.rmdir = function(directory, ...args) {
      if (String(directory) === target && fs.existsSync(target) && fs.readdirSync(target).length === 0
          && (mode === 'persistent' || writes < 3)) {
        fs.writeFileSync(path.join(target, 'late-wal-' + writes++), 'flushed after walk');
      }
      return original.call(this, directory, ...args);
    };
    if (mode === 'no-retries') {
      const remove = fs.promises.rm;
      fs.promises.rm = (directory, options) => remove(directory, { ...options, maxRetries: 0 });
    }
    const { removeDisposableRoot, NONCE_FILE } = await import(${JSON.stringify(library)});
    let error;
    try { await removeDisposableRoot(root); } catch (caught) { error = caught.message; }
    console.log(JSON.stringify({ writes, error, exists: fs.existsSync(root),
      guarded: fs.existsSync(path.join(root, NONCE_FILE)) }));
  `], { encoding: "utf8", timeout: 30_000 })
}

test("cleanup retries actual ENOTEMPTY from repeated writes after a directory was emptied", (t) => {
  const root = disposable(t)
  const target = path.join(root, "customized", "home", ".gemini", "cache")
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, "initial"), "old data")
  const unretried = racingRemoval(root, target, "no-retries")
  assert.equal(unretried.status, 0, unretried.stderr)
  const failure = JSON.parse(unretried.stdout)
  assert.ok(failure.writes > 0)
  assert.match(failure.error, /ENOTEMPTY/)
  assert.equal(failure.exists, true)
  const child = racingRemoval(root, target, "transient")
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout)
  assert.equal(result.writes, 3, "the race must actually occur repeatedly")
  assert.equal(result.error, undefined)
  assert.equal(result.exists, false)
})

test("an exhausted recursive cleanup preserves the original nonce for a later invocation", async (t) => {
  const root = disposable(t)
  const marker = path.join(root, NONCE_FILE)
  const nonce = fs.readFileSync(marker, "utf8")
  const target = path.join(root, "customized")
  fs.mkdirSync(target)
  const child = racingRemoval(root, target, "persistent")
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout)
  assert.match(result.error, /ENOTEMPTY/)
  assert.ok(result.writes > 1)
  assert.equal(result.guarded, true)
  assert.equal(fs.readFileSync(marker, "utf8"), nonce)
  await removeDisposableRoot(root)
  assert.equal(fs.existsSync(root), false)
})

test("a write during the final root rmdir restores the nonce and retries", (t) => {
  const root = disposable(t)
  // promises.rmdir uses the same syscall but bypasses the callback interposer.
  // Interpose only that final call; its real syscall still raises ENOTEMPTY.
  const original = fs.promises.rmdir
  let writes = 0
  t.mock.method(fs.promises, "rmdir", async (directory) => {
    if (String(directory) === root && writes++ < 3) fs.writeFileSync(path.join(root, "late-root-file"), "late")
    return original(directory)
  })
  return removeDisposableRoot(root).then(() => {
    assert.equal(writes, 4)
    assert.equal(fs.existsSync(root), false)
  })
})

test("a final rmdir failure leaves the root provable and cleanable", async (t) => {
  const root = disposable(t)
  const nonce = fs.readFileSync(path.join(root, NONCE_FILE), "utf8")
  const original = fs.promises.rmdir
  const mock = t.mock.method(fs.promises, "rmdir", async (directory) => {
    fs.writeFileSync(path.join(String(directory), "late-root-file"), "late")
    return original(directory)
  })
  await assert.rejects(async () => removeDisposableRoot(root), /ENOTEMPTY/)
  assert.equal(fs.readFileSync(path.join(root, NONCE_FILE), "utf8"), nonce)
  mock.mock.restore()
  await removeDisposableRoot(root)
  assert.equal(fs.existsSync(root), false)
})

test("cleanup refuses an unverified directory without modifying it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unverified-upgrade-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "keep"), "operator data")
  await assert.rejects(async () => removeDisposableRoot(root), /refusing cleanup without/)
  assert.equal(fs.readFileSync(path.join(root, "keep"), "utf8"), "operator data")
})

test("stopGateway waits for delayed shutdown writes and actual child exit", { skip: process.platform === "win32" }, async (t) => {
  const root = disposable(t)
  const marker = path.join(root, "shutdown-finished")
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(marker)}, 'finished'); process.exit(0);
    }, 200));
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `], { stdio: ["ignore", "pipe", "pipe"] })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  await once(child.stdout, "data")
  const log = fs.openSync(path.join(root, "gateway.log"), "a")
  await stopGateway({ child, log })
  assert.equal(child.exitCode, 0)
  assert.equal(fs.readFileSync(marker, "utf8"), "finished")
  await removeDisposableRoot(root)
  assert.equal(fs.existsSync(root), false)
})

function runCliWithLeak(t, assertionFailure) {
  const fixture = disposable(t)
  const tarball = path.join(fixture, "candidate.tgz")
  fs.writeFileSync(tarball, "local candidate fixture")
  const entrypoint = new URL("../upgrade-verify.mjs", import.meta.url)
  const installation = new URL("./fixtures/upgrade-verify-install.mjs", import.meta.url)
  const preload = path.join(fixture, "preload.mjs")
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import path from 'node:path';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(entrypoint.href)} && specifier === './upgrade-verify-lib.mjs') {
        return { url: ${JSON.stringify(installation.href)}, shortCircuit: true };
      }
      return next(specifier, context);
    }});
    // Fail cleanup with a real ENOTEMPTY, including on the pre-fix sync path.
    const original = fs.rmSync;
    fs.rmSync = function(directory, options) {
      if (path.basename(String(directory)).startsWith('jinn-upgrade-verify-')) {
        fs.unlinkSync(path.join(directory, '.jinn-upgrade-verify-nonce'));
        fs.writeFileSync(path.join(directory, 'late-file'), 'late');
        return fs.rmdirSync(directory);
      }
      return original(directory, options);
    };
    const rmdir = fs.promises.rmdir;
    fs.promises.rmdir = async function(directory) {
      fs.writeFileSync(path.join(directory, 'late-file'), 'late');
      return rmdir(directory);
    };
  `)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("JINN_")))
  if (assertionFailure) env.UPGRADE_TEST_ASSERTION_FAILURE = String(assertionFailure)
  const child = spawnSync(process.execPath, ["--import", preload, fileURLToPath(entrypoint), "--candidate-tarball", tarball], {
    env, encoding: "utf8", timeout: 30_000,
  })
  const leaked = /disposable root ([^;\n]+)/.exec(child.stderr)?.[1] ?? /'(.*jinn-upgrade-verify-[^']*)'/.exec(child.stderr)?.[1]
  if (leaked) t.after(() => fs.rmSync(leaked, { recursive: true, force: true }))
  return { ...child, leaked }
}

test("a green CLI exits zero with both PASS results and reports a guarded leak by path", (t) => {
  const child = runCliWithLeak(t, false)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.match(child.stdout, /PASS published jinn-cli@1.0.0 -> candidate jinn-cli@1.0.1/)
  assert.match(child.stdout, /PASS stock /)
  assert.match(child.stdout, /PASS customized /)
  assert.match(child.stderr, /CLEANUP LEAK: disposable root .*ENOTEMPTY.*verification result unchanged/)
  assert.doesNotMatch(child.stderr, /FAIL upgrade verification/)
  assert.doesNotMatch(child.stdout, /CLEANUP removed|all started gateways stopped/)
  assert.ok(child.leaked)
  assert.equal(fs.existsSync(path.join(child.leaked, NONCE_FILE)), true)
})

test("a cleanup error preserves the original verification failure and nonzero exit", (t) => {
  const child = runCliWithLeak(t, true)
  assert.equal(child.status, 1, child.stderr)
  assert.match(child.stderr, /CLEANUP LEAK: disposable root /)
  assert.match(child.stderr, /FAIL upgrade verification: candidate rejection: candidate-first-boot failed: injected upgrade assertion failure/)
  assert.doesNotMatch(child.stdout, /PASS published/)
})

test("a baseline boot failure identifies a harness/environment fault, not a candidate rejection", (t) => {
  const child = runCliWithLeak(t, "baseline")
  assert.equal(child.status, 1, child.stderr)
  assert.match(child.stderr, /harness\/environment fault: published baseline could not complete boot; candidate not evaluated/)
  assert.match(child.stderr, /published-latest gateway exited before readiness: missing native binding/)
  assert.doesNotMatch(child.stderr, /candidate rejection/)
  assert.doesNotMatch(child.stdout, /PASS published/)
})

test("shutdown stops an owned descendant that would recreate HOME after its gateway exits", { skip: process.platform === "win32" }, async (t) => {
  const root = disposable(t)
  const lateFile = path.join(root, "home", ".hermes", "late-write")
  const writer = `
    import fs from 'node:fs';
    import path from 'node:path';
    process.on('SIGTERM', () => {});
    setTimeout(() => {
      fs.mkdirSync(path.dirname(${JSON.stringify(lateFile)}), { recursive: true });
      fs.writeFileSync(${JSON.stringify(lateFile)}, 'recreated after gateway exit');
    }, 800);
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    process.on('SIGTERM', () => process.exit(0));
    const writer = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(writer)}], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    writer.stdout.once('data', () => process.stdout.write(String(writer.pid)));
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
  })
  const [data] = await once(child.stdout, "data")
  const writerPid = Number(String(data))
  const log = fs.openSync(path.join(root, "gateway.log"), "a")
  await stopGateway({ child, log, processGroup: true })
  assert.equal(child.exitCode, 0)
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(writerPid)], { encoding: "utf8" }).stdout.trim()
  assert.ok(state === "" || state.startsWith("Z"), `writer is still alive: ${state}`)
  await removeDisposableRoot(root)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  assert.equal(fs.existsSync(root), false, "the late writer must not recreate the deleted root")
})

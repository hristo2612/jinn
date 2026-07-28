import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertIsolatedTestHome,
  ensureIsolatedTestHome,
} from './vitest.test-home.js';

const TEMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

// Engine binaries the dispatch path probes for on PATH (models.ts engineAvailable).
// A large slice of the gateway/session integration tests inject a STUB engine but
// still traverse the real availability probe first; on a dev box the CLIs happen
// to be installed so the probe passes, but a bare CI runner has none of them and
// the session is blocked before the stub is ever consulted. We keep the suite
// hermetic by dropping harmless no-op shims for these bins on PATH for the test
// run — the shims are never executed (engines are stubbed), they only satisfy the
// presence check so tests don't depend on what the host happens to have installed.
const ENGINE_SHIM_BINS = ['codex'] as const;

function installEngineShims(systemTempRoot: string): {
  restore: () => void;
} {
  const shimDir = fs.mkdtempSync(path.join(systemTempRoot, 'jinn-engine-shims-'));
  for (const bin of ENGINE_SHIM_BINS) {
    const shimPath = path.join(shimDir, bin);
    fs.writeFileSync(shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(shimPath, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath
    ? `${shimDir}${path.delimiter}${previousPath}`
    : shimDir;
  return {
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

function makeTestDirectoriesRemovable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;

  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    makeTestDirectoriesRemovable(path.join(root, entry.name));
  }
}

export default function setup(): () => void {
  const systemTempRoot = os.tmpdir();
  const result = ensureIsolatedTestHome();

  // Belt-and-suspenders: never continue if assignment/canonicalization did not
  // actually move the run away from the production or another non-temp home.
  assertIsolatedTestHome(process.env.JINN_HOME);

  fs.mkdirSync(result.home, { recursive: true });
  const runTempRoot = fs.mkdtempSync(path.join(result.home, 'tmp-'));
  const previousTempEnv = Object.fromEntries(
    TEMP_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof TEMP_ENV_KEYS)[number], string | undefined>;
  const previousSystemTempRoot = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT;

  process.env.JINN_VITEST_SYSTEM_TEMP_ROOT = systemTempRoot;
  for (const key of TEMP_ENV_KEYS) process.env[key] = runTempRoot;

  // Put no-op engine shims on PATH BEFORE the temp env is repointed, using the
  // real system temp root so the shim dir lives outside the isolated home we tear
  // down below. Prepended to PATH so worker forks (which inherit env at spawn)
  // see the shimmed engines as available.
  const engineShims = installEngineShims(systemTempRoot);

  return () => {
    engineShims.restore();

    for (const key of TEMP_ENV_KEYS) {
      const previous = previousTempEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    if (previousSystemTempRoot === undefined) {
      delete process.env.JINN_VITEST_SYSTEM_TEMP_ROOT;
    } else {
      process.env.JINN_VITEST_SYSTEM_TEMP_ROOT = previousSystemTempRoot;
    }

    const cleanupRoot = result.created ? result.home : runTempRoot;
    makeTestDirectoriesRemovable(cleanupRoot);
    fs.rmSync(cleanupRoot, {
      recursive: true,
      force: true,
      // Windows refuses to unlink a file whose handle is still open, and a
      // handle can outlive the code that owned it — a sqlite connection just
      // closed, or a child process the OS has not finished reaping. Retrying is
      // Node's documented mitigation (EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM).
      // Without it this throws out of teardown and reports the whole run as
      // failed after every test has already passed.
      maxRetries: process.platform === 'win32' ? 10 : 0,
      retryDelay: 50,
    });
  };
}

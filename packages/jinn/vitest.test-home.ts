import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROD_HOME = path.join(os.homedir(), '.jinn');
// Global setup redirects the workers' generic temp variables beneath JINN_HOME.
// Keep the pre-redirect OS root for the safety check so JINN_HOME remains a
// valid child of the real temp directory inside every worker.
const TEMP_ROOT = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT ?? os.tmpdir();

/** Resolve symlinks in the existing prefix while preserving a missing tail. */
export function canonicalPath(pathname: string): string {
  let cursor = path.resolve(pathname);
  const missing: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  let canonicalPrefix = cursor;
  try {
    canonicalPrefix = fs.realpathSync.native(cursor);
  } catch {
    // `path.resolve` is still deterministic if the existing prefix disappears
    // between existsSync and realpathSync.
  }

  return path.join(canonicalPrefix, ...missing);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function isTempPath(pathname: string): boolean {
  return isWithin(canonicalPath(TEMP_ROOT), canonicalPath(pathname));
}

/** Fail closed when a Vitest worker did not inherit an isolated home. */
export function assertIsolatedTestHome(home: string | undefined): string {
  if (!home) {
    throw new Error('refusing to run tests with an unset JINN_HOME');
  }

  const canonicalHome = canonicalPath(home);
  if (canonicalHome === canonicalPath(PROD_HOME)) {
    throw new Error('refusing to run tests against prod JINN_HOME=~/.jinn');
  }
  if (!isTempPath(canonicalHome)) {
    throw new Error(`refusing to run tests against non-temp JINN_HOME=${home}`);
  }

  return canonicalHome;
}

/**
 * Establish one safe home for the Vitest run. Existing temp homes are accepted
 * for focused/CI runs; unset, production, and other non-temp homes are replaced.
 */
export function ensureIsolatedTestHome(
  env: NodeJS.ProcessEnv = process.env,
): { home: string; created: boolean } {
  const configuredHome = env.JINN_HOME;
  if (configuredHome) {
    try {
      assertIsolatedTestHome(configuredHome);
      const home = path.resolve(configuredHome);
      env.JINN_HOME = home;
      return { home, created: false };
    } catch {
      // Unsafe launch environments are redirected below, then asserted again.
    }
  }

  const home = fs.mkdtempSync(path.join(TEMP_ROOT, 'jinn-vitest-'));
  env.JINN_HOME = home;
  assertIsolatedTestHome(env.JINN_HOME);
  return { home, created: true };
}

/** Allocate before a file's static imports; the run cleanup owns this subtree. */
export function createIsolatedTestFileHome(env: NodeJS.ProcessEnv = process.env): string {
  assertIsolatedTestHome(env.JINN_HOME);
  const root = env.TMPDIR ?? env.TEMP ?? env.TMP ?? os.tmpdir();
  assertIsolatedTestHome(root);
  const home = fs.mkdtempSync(path.join(root, 'jinn-vitest-file-'));
  const temp = path.join(home, 'tmp');
  fs.mkdirSync(temp);
  env.JINN_HOME = home;
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) env[key] = temp;
  return home;
}

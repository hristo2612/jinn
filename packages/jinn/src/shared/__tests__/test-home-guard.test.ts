import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertIsolatedTestHome,
  canonicalPath,
  createIsolatedTestFileHome,
  ensureIsolatedTestHome,
  isTempPath,
} from '../../../vitest.test-home.js';
import vitestConfig from '../../../vitest.config.js';
import setupVitest from '../../../vitest.global-setup.js';
import { JINN_HOME, SESSIONS_DB, assertTestRunIsIsolated } from '../paths.js';
import { assertNotProductionGateway } from '../sandbox-env.js';
import { initDb } from '../db.js';
import { createWorkItem } from '../../work-items/store.js';

const createdHomes: string[] = [];

afterEach(() => {
  for (const home of createdHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('Vitest JINN_HOME guard', () => {
  it('runs both the pre-worker redirect and the per-worker assertion', () => {
    const config = vitestConfig as { test?: { globalSetup?: string; setupFiles?: string[] } };

    expect(config.test?.globalSetup).toBe('./vitest.global-setup.ts');
    expect(config.test?.setupFiles).toEqual(['./vitest.setup.ts']);
  });

  it('loudly rejects the default production home', () => {
    expect(() => assertIsolatedTestHome(path.join(os.homedir(), '.jinn')))
      .toThrow('refusing to run tests against prod JINN_HOME=~/.jinn');
  });

  it('redirects the default production home before workers launch', () => {
    const env: NodeJS.ProcessEnv = {
      JINN_HOME: path.join(os.homedir(), '.jinn'),
    };

    const result = ensureIsolatedTestHome(env);
    createdHomes.push(result.home);

    expect(result.created).toBe(true);
    expect(env.JINN_HOME).toBe(result.home);
    expect(isTempPath(result.home)).toBe(true);
  });

  it('redirects an unset home to a fresh directory under the OS temp root', () => {
    const env: NodeJS.ProcessEnv = {};

    const result = ensureIsolatedTestHome(env);
    createdHomes.push(result.home);

    expect(result.created).toBe(true);
    expect(env.JINN_HOME).toBe(result.home);
    expect(isTempPath(result.home)).toBe(true);
  });

  it('redirects a non-temp home instead of trusting it', () => {
    const env: NodeJS.ProcessEnv = {
      JINN_HOME: path.join(os.homedir(), '.jinn-test-unsafe'),
    };

    const result = ensureIsolatedTestHome(env);
    createdHomes.push(result.home);

    expect(result.created).toBe(true);
    expect(env.JINN_HOME).toBe(result.home);
    expect(isTempPath(result.home)).toBe(true);
  });

  it('opens a file-owned registry instead of the inherited run registry', () => {
    const runHome = process.env.JINN_VITEST_RUN_HOME!;
    expect(runHome).toBeTruthy();
    expect(JINN_HOME).not.toBe(runHome);
    expect(initDb().name).not.toBe(path.join(runHome, 'sessions', 'registry.db'));
  });

  it('isolates registry state even when files inherit the same run environment', () => {
    const inherited = { ...process.env };
    const first = createIsolatedTestFileHome({ ...inherited });
    const second = createIsolatedTestFileHome({ ...inherited });
    createdHomes.push(first, second);
    const writer = new Database(path.join(first, 'registry.db'));
    const reader = new Database(path.join(second, 'registry.db'));
    try {
      writer.exec("CREATE TABLE fixture_state (value TEXT); INSERT INTO fixture_state VALUES ('first')");
      expect(reader.prepare("SELECT name FROM sqlite_master WHERE name = 'fixture_state'").get())
        .toBeUndefined();
      expect(initDb().name).toBe(path.join(process.env.JINN_HOME!, 'sessions', 'registry.db'));
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('routes generic test temp fixtures beneath the cleanup-owned home', () => {
    const relative = path.relative(
      canonicalPath(process.env.JINN_HOME!),
      canonicalPath(os.tmpdir()),
    );

    expect(relative).not.toBe('');
    expect(relative).not.toBe('..');
    expect(relative.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
  });

  it('removes read-only fixture directories during run cleanup', () => {
    const previousSystemTempRoot = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT;
    const teardown = setupVitest();
    const runTempRoot = os.tmpdir();
    const lockedDir = path.join(runTempRoot, 'locked-fixture');
    const lockedFile = path.join(lockedDir, 'artifact');
    fs.mkdirSync(lockedDir);
    fs.writeFileSync(lockedFile, 'fixture');
    fs.chmodSync(lockedFile, 0o500);
    fs.chmodSync(lockedDir, 0o500);

    try {
      expect(() => teardown()).not.toThrow();
      expect(process.env.JINN_VITEST_SYSTEM_TEMP_ROOT).toBe(previousSystemTempRoot);
    } finally {
      if (fs.existsSync(lockedDir)) fs.chmodSync(lockedDir, 0o700);
      fs.rmSync(runTempRoot, { recursive: true, force: true });
    }
  });

  it('routes a real work-item write to the guarded temp registry', () => {
    expect(isTempPath(JINN_HOME)).toBe(true);
    expect(SESSIONS_DB).toBe(path.join(JINN_HOME, 'sessions', 'registry.db'));
    expect(SESSIONS_DB).not.toBe(
      path.join(os.homedir(), '.jinn', 'sessions', 'registry.db'),
    );

    const item = createWorkItem({ title: 'test-home guard integration' });
    const row = initDb()
      .prepare('SELECT title FROM work_items WHERE id = ?')
      .get(item.id);

    expect(row).toEqual({ title: 'test-home guard integration' });
    expect(fs.existsSync(SESSIONS_DB)).toBe(true);
  });
});

describe('worker gateway-binding scrub', () => {
  // Reproduce by running the suite from inside a live gateway session, which exports
  // the gateway's own JINN_PORT/JINN_HOST into every child: without the vitest.setup.ts
  // scrub they land in each worker, and JINN_PORT outranks the config.yaml of whatever
  // fixture home a test just wrote.
  it.each(['JINN_PORT', 'JINN_HOST', 'JINN_INSTANCE'])('leaves no ambient %s in the worker', (name) => {
    expect(process.env[name]).toBeUndefined();
  });

  it('refuses to run a worker that still resolves the default instance home', () => {
    // Fabricated under the temp root, so the assertion never names this machine's home.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-default-home-'));
    createdHomes.push(homeDir);
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

    expect(() => assertNotProductionGateway({ home: path.join(homeDir, '.jinn') }))
      .toThrow(/default instance home/);
    expect(() => assertNotProductionGateway({ home: process.env.JINN_HOME })).not.toThrow();

    vi.restoreAllMocks();
  });
});

/**
 * The layer-1 guard above (globalSetup + setupFiles) only arms when Vitest
 * loads packages/jinn/vitest.config.ts. Running `npx vitest` from the repo ROOT
 * finds no config, so Vitest uses defaults and NONE of it runs — an ambient
 * JINN_HOME=~/.jinn then reaches every suite and the tests write into the live
 * gateway registry. That happened 2026-07-06, and again 4x larger on
 * 2026-07-25, burning Todo IDs ICI-580…595 out of an append-only allocator.
 *
 * paths.ts therefore re-asserts at the boundary that every registry-touching
 * module imports, so no cwd/config/runner choice can bypass it.
 */
describe('paths.ts boundary guard (layer 2, config-independent)', () => {
  const PROD = path.join(os.homedir(), '.jinn');
  const underVitest = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    ({ VITEST: 'true', ...over });

  it('refuses the production home', () => {
    expect(() => assertTestRunIsIsolated(PROD, underVitest()))
      .toThrow(/Refusing to run tests against a non-temp JINN_HOME/);
  });

  it('names the correct command in the error, so the next person does not repeat it', () => {
    expect(() => assertTestRunIsIsolated(PROD, underVitest())).toThrow(/pnpm/);
  });

  it('refuses any non-temp home, not just ~/.jinn', () => {
    expect(() => assertTestRunIsIsolated(path.join(os.homedir(), '.jinn-elsewhere'), underVitest()))
      .toThrow(/Refusing to run tests against a non-temp JINN_HOME/);
  });

  it('allows a temp home', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-guard-ok-'));
    createdHomes.push(home);
    expect(() => assertTestRunIsIsolated(home, underVitest())).not.toThrow();
  });

  it('honours JINN_VITEST_SYSTEM_TEMP_ROOT when global setup has repointed temp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-guard-root-'));
    const home = path.join(root, 'worker-home');
    fs.mkdirSync(home);
    createdHomes.push(root);
    expect(() => assertTestRunIsIsolated(home, underVitest({ JINN_VITEST_SYSTEM_TEMP_ROOT: root })))
      .not.toThrow();
  });

  it('fires for a worker that only has VITEST_WORKER_ID', () => {
    expect(() => assertTestRunIsIsolated(PROD, { VITEST_WORKER_ID: '3' }))
      .toThrow(/Refusing to run tests/);
  });

  it('stays inert outside Vitest so the gateway resolves its real home', () => {
    // The single most important negative case: production must be unaffected.
    expect(() => assertTestRunIsIsolated(PROD, {})).not.toThrow();
  });

  it('guards the home this very suite resolved', () => {
    // End-to-end, with the REAL worker env. Global setup repoints os.tmpdir()
    // beneath JINN_HOME and records the pre-redirect OS root in
    // JINN_VITEST_SYSTEM_TEMP_ROOT, so the guard must read that rather than
    // calling os.tmpdir() blind — otherwise it would reject its own safe home.
    expect(process.env.JINN_VITEST_SYSTEM_TEMP_ROOT).toBeTruthy();
    expect(() => assertTestRunIsIsolated(JINN_HOME, process.env)).not.toThrow();
    expect(isTempPath(JINN_HOME)).toBe(true);
  });
});

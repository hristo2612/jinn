import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type MigrationModule = typeof import('../repository-migrations.js');
type PathsModule = typeof import('../../shared/paths.js');

const PHYSICAL_V1_SQL = `
CREATE TABLE workflow_schema (version INTEGER NOT NULL);
CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, retired_at TEXT, definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
  workflow_title TEXT NOT NULL, definition_revision INTEGER NOT NULL, definition_json TEXT NOT NULL,
  input_json TEXT NOT NULL, trigger_json TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
  idempotency_key TEXT, invocation_session_id TEXT, cancel_requested_at TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, error_json TEXT, UNIQUE(workflow_id, idempotency_key)
);
CREATE TABLE workflow_node_runs (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, node_id TEXT NOT NULL,
  node_type TEXT NOT NULL, status TEXT NOT NULL, activated INTEGER NOT NULL DEFAULT 0,
  resolved_config_json TEXT, input_json TEXT, output_json TEXT, error_json TEXT,
  resume_at TEXT, started_at TEXT, ended_at TEXT, PRIMARY KEY(run_id, node_id)
);
CREATE TABLE workflow_attempts (
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt INTEGER NOT NULL, session_id TEXT,
  status TEXT NOT NULL, resolved_config_json TEXT NOT NULL, input_json TEXT NOT NULL,
  output_json TEXT, error_json TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  PRIMARY KEY(run_id, node_id, attempt),
  FOREIGN KEY(run_id, node_id) REFERENCES workflow_node_runs(run_id, node_id) ON DELETE CASCADE
);
CREATE TABLE workflow_approvals (
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL,
  approver_ref TEXT, decided_at TEXT, decided_by TEXT, decision TEXT, reason TEXT,
  PRIMARY KEY(run_id, node_id),
  FOREIGN KEY(run_id, node_id) REFERENCES workflow_node_runs(run_id, node_id) ON DELETE CASCADE
);
CREATE INDEX workflow_runs_by_workflow_started ON workflow_runs(workflow_id, started_at DESC, id DESC);
CREATE INDEX workflow_runs_by_status_started ON workflow_runs(status, started_at DESC, id DESC);
CREATE INDEX workflow_attempts_by_session ON workflow_attempts(session_id);
CREATE INDEX workflow_approvals_pending ON workflow_approvals(status, requested_at);
CREATE INDEX workflow_node_runs_due ON workflow_node_runs(status, resume_at);
INSERT INTO workflow_schema VALUES (1);
INSERT INTO workflow_definitions
  (id, title, revision, definition_json, created_at, updated_at)
  VALUES ('physical-v1', 'Fixture', 1, '{}', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z');
`;

let suiteRoot: string;
let previousJinnHome: string | undefined;
let migrations: MigrationModule;
let paths: PathsModule;

const SYMLINK_ERROR = 'Workflow database default store must not contain symbolic links.';

beforeAll(async () => {
  suiteRoot = mkdtempSync(join(tmpdir(), 'jinn-workflow-recovery-'));
  previousJinnHome = process.env.JINN_HOME;
  process.env.JINN_HOME = suiteRoot;
  vi.resetModules();
  paths = await import('../../shared/paths.js');
  migrations = await import('../repository-migrations.js');
});

afterAll(() => {
  if (previousJinnHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = previousJinnHome;
  rmSync(suiteRoot, { recursive: true, force: true });
});

function resetDefaultStore(): void {
  rmSync(paths.WORKFLOWS_DIR, { recursive: true, force: true });
}

function expectDefaultOpenToFailClosed(): void {
  let db: Database.Database | undefined;
  expect(() => {
    try {
      db = migrations.openWorkflowDatabase();
    } finally {
      db?.close();
    }
  }).toThrowError(SYMLINK_ERROR);
}

describe('workflow recovery gate', () => {
  it('opens a handcrafted physical v1 database through the public opener', () => {
    const file = join(suiteRoot, 'physical-v1', 'workflows.db');
    mkdirSync(dirname(file), { recursive: true });
    const raw = new Database(file);
    raw.exec(PHYSICAL_V1_SQL);
    raw.close();

    const db = migrations.openWorkflowDatabase(file);
    try {
      expect(db.prepare('SELECT version FROM workflow_schema').pluck().get())
        .toBe(migrations.WORKFLOW_DB_SCHEMA_VERSION);
      expect(db.prepare('SELECT title FROM workflow_definitions WHERE id = ?').pluck().get('physical-v1'))
        .toBe('Fixture');
    } finally {
      db.close();
    }
  });

  it('enforces owner-only modes for the exact default database store on POSIX', () => {
    if (process.platform === 'win32') return;
    mkdirSync(paths.WORKFLOWS_DIR, { recursive: true, mode: 0o755 });
    chmodSync(paths.WORKFLOWS_DIR, 0o755);
    const previousUmask = process.umask(0);
    let db: Database.Database | undefined;
    try {
      db = migrations.openWorkflowDatabase(paths.WORKFLOWS_DB_PATH);
      for (const file of [paths.WORKFLOWS_DB_PATH, `${paths.WORKFLOWS_DB_PATH}-wal`, `${paths.WORKFLOWS_DB_PATH}-shm`]) {
        expect(existsSync(file)).toBe(true);
        expectPosixMode(statSync(file), 0o600);
      }
      expectPosixMode(statSync(paths.WORKFLOWS_DIR), 0o700);
    } finally {
      db?.close();
      process.umask(previousUmask);
    }
  });

  it('rejects a symlinked default directory without touching its caller-owned target', () => {
    if (process.platform === 'win32') return;
    resetDefaultStore();
    const target = join(suiteRoot, 'caller-directory');
    const sentinel = join(target, 'sentinel.txt');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    writeFileSync(sentinel, 'caller-owned-directory');
    const before = readFileSync(sentinel);
    symlinkSync(target, paths.WORKFLOWS_DIR, 'dir');

    expectDefaultOpenToFailClosed();

    expectPosixMode(statSync(target), 0o755);
    expect(readFileSync(sentinel)).toEqual(before);
  });

  it('rejects a symlinked default database without touching its caller-owned target', () => {
    if (process.platform === 'win32') return;
    resetDefaultStore();
    mkdirSync(paths.WORKFLOWS_DIR, { mode: 0o700 });
    const target = join(suiteRoot, 'caller-database');
    writeFileSync(target, 'caller-owned-database');
    chmodSync(target, 0o644);
    const before = readFileSync(target);
    symlinkSync(target, paths.WORKFLOWS_DB_PATH);

    expectDefaultOpenToFailClosed();

    expectPosixMode(statSync(target), 0o644);
    expect(readFileSync(target)).toEqual(before);
  });

  it.each(['-wal', '-shm'])('rejects a planted %s symlink before SQLite can follow it', (suffix) => {
    if (process.platform === 'win32') return;
    resetDefaultStore();
    mkdirSync(paths.WORKFLOWS_DIR, { mode: 0o700 });
    const raw = new Database(paths.WORKFLOWS_DB_PATH);
    raw.close();
    chmodSync(paths.WORKFLOWS_DB_PATH, 0o600);
    const databaseBefore = readFileSync(paths.WORKFLOWS_DB_PATH);
    const target = join(suiteRoot, `caller-sidecar${suffix}`);
    writeFileSync(target, `caller-owned${suffix}`);
    chmodSync(target, 0o644);
    const targetBefore = readFileSync(target);
    symlinkSync(target, `${paths.WORKFLOWS_DB_PATH}${suffix}`);

    expectDefaultOpenToFailClosed();

    expect(readFileSync(paths.WORKFLOWS_DB_PATH)).toEqual(databaseBefore);
    expectPosixMode(statSync(target), 0o644);
    expect(readFileSync(target)).toEqual(targetBefore);
  });
});

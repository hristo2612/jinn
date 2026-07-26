import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type MigrationModule = typeof import('../repository-migrations.js');
type PathsModule = typeof import('../../shared/paths.js');

interface TableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexColumn {
  name: string | null;
  desc: number;
  key: number;
}

let suiteRoot: string;
let previousJinnHome: string | undefined;
let migrations: MigrationModule;
let paths: PathsModule;

beforeAll(async () => {
  suiteRoot = mkdtempSync(join(tmpdir(), 'jinn-workflow-database-'));
  previousJinnHome = process.env.JINN_HOME;
  process.env.JINN_HOME = suiteRoot;
  paths = await import('../../shared/paths.js');
  migrations = await import('../repository-migrations.js');
});

afterAll(() => {
  if (previousJinnHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = previousJinnHome;
  rmSync(suiteRoot, { recursive: true, force: true });
});

function databasePath(name: string): string {
  return join(suiteRoot, name, 'workflows.db');
}

function withWorkflowDatabase<T>(file: string | undefined, run: (db: Database.Database) => T): T {
  const db = migrations.openWorkflowDatabase(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function withRawDatabase<T>(file: string, run: (db: Database.Database) => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function tableNames(db: Database.Database): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck().all() as string[];
}

function domainTableNames(db: Database.Database): string[] {
  return tableNames(db).filter((name) => name !== 'workflow_schema' && name !== 'marker');
}

function tableInfo(db: Database.Database, table: string): TableColumn[] {
  return db.pragma(`table_info(${table})`) as TableColumn[];
}

function column(name: string, type: string, notnull: number, dflt: string | null, pk: number): Omit<TableColumn, 'cid'> {
  return { name, type, notnull, dflt_value: dflt, pk };
}

function expectedColumns(columns: Array<Omit<TableColumn, 'cid'>>): TableColumn[] {
  return columns.map((entry, cid) => ({ cid, ...entry }));
}

function foreignKeys(db: Database.Database, table: string): Array<Omit<ForeignKey, 'id'>> {
  return (db.pragma(`foreign_key_list(${table})`) as ForeignKey[])
    .map(({ id: _id, ...entry }) => entry);
}

function namedIndexes(db: Database.Database): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck().all() as string[];
}

function indexColumns(db: Database.Database, index: string): Array<{ name: string; desc: number }> {
  return (db.pragma(`index_xinfo(${index})`) as IndexColumn[])
    .filter((entry) => entry.key === 1)
    .map((entry) => ({ name: entry.name!, desc: entry.desc }));
}

function schemaSql(db: Database.Database): string[] {
  return db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").pluck().all() as string[];
}

function databaseSnapshot(file: string): string {
  return withRawDatabase(file, (db) => JSON.stringify({
    schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").all(),
    versions: tableNames(db).some((name) => name.toLowerCase() === 'workflow_schema') ? db.prepare('SELECT * FROM workflow_schema').all() : [],
    definitions: tableNames(db).some((name) => name.toLowerCase() === 'workflow_definitions')
      ? db.prepare('SELECT * FROM workflow_definitions ORDER BY id').all() : [],
  }));
}

function rejectedDatabaseSnapshot(file: string): object {
  const bytes = readFileSync(file);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let inspected: object;
  try {
    const names = tableNames(db);
    inspected = {
      schema: db.prepare(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name',
      ).all(),
      versions: names.includes('workflow_schema') ? db.prepare('SELECT * FROM workflow_schema').all() : [],
      data: names.includes('marker') ? db.prepare('SELECT * FROM marker ORDER BY rowid').all()
        : names.includes('workflow_definitions') ? db.prepare('SELECT * FROM workflow_definitions ORDER BY id').all() : [],
      journalMode: db.pragma('journal_mode', { simple: true }),
    };
  } finally {
    db.close();
  }
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...inspected,
    sidecars: ['-journal', '-wal', '-shm'].map((suffix) => existsSync(`${file}${suffix}`)),
  };
}

function expectRejectedWithoutMutation(file: string, error: string): void {
  const before = rejectedDatabaseSnapshot(file);
  expect(before).toMatchObject({ journalMode: 'delete', sidecars: [false, false, false] });
  expect(() => migrations.openWorkflowDatabase(file)).toThrowError(error);
  expect(rejectedDatabaseSnapshot(file)).toEqual(before);
  const moved = `${file}.closed`;
  renameSync(file, moved);
  renameSync(moved, file);
}

function expectMalformedWithoutMutation(file: string): void {
  const before = databaseSnapshot(file);
  expect(() => migrations.openWorkflowDatabase(file)).toThrowError('Malformed workflow database schema version.');
  expect(databaseSnapshot(file)).toBe(before);
}

function currentDatabase(name: string): string {
  const file = databasePath(name);
  withWorkflowDatabase(file, (db) => insertDefinition(db, 'sentinel'));
  return file;
}

function versionTwoDatabase(name: string): string {
  const file = currentDatabase(name);
  withRawDatabase(file, (db) => {
    const columns = tableInfo(db, 'workflow_attempts').map((entry) => entry.name);
    if (columns.includes('reminders_sent')) {
      db.exec(`
        DROP INDEX workflow_attempts_due_reminder;
        ALTER TABLE workflow_attempts DROP COLUMN reminders_sent;
        ALTER TABLE workflow_attempts DROP COLUMN next_reminder_at;
        ALTER TABLE workflow_attempts DROP COLUMN extensions;
        ALTER TABLE workflow_attempts DROP COLUMN last_extension_reason;
        ALTER TABLE workflow_attempts DROP COLUMN pending_output_error;
        ALTER TABLE workflow_attempts DROP COLUMN last_processed_turn;
        ALTER TABLE workflow_attempts DROP COLUMN prompt_text;
        UPDATE workflow_schema SET version = 2;
      `);
    }
  });
  return file;
}

function versionOneDatabase(name: string): string {
  const file = versionTwoDatabase(name);
  withRawDatabase(file, (db) => db.exec(`
    DROP INDEX workflow_attempts_retry_key;
    ALTER TABLE workflow_attempts DROP COLUMN retry_idempotency_key;
    UPDATE workflow_schema SET version = 1;
  `));
  return file;
}

function uppercaseCurrentDatabase(name: string): string {
  const source = currentDatabase(`${name}-source`);
  const ddl = withRawDatabase(source, (db) => (db.prepare(
    "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type = 'table' DESC, name",
  ).pluck().all() as string[]).join(';\n'));
  const file = databasePath(name);
  withRawDatabase(file, (db) => {
    db.exec(`${ddl.toUpperCase()}; INSERT INTO WORKFLOW_SCHEMA VALUES (${migrations.WORKFLOW_DB_SCHEMA_VERSION})`);
    insertDefinition(db, 'sentinel');
  });
  return file;
}

function insertDefinition(db: Database.Database, id = 'workflow'): void {
  db.prepare(`INSERT INTO workflow_definitions
    (id, title, revision, definition_json, created_at, updated_at)
    VALUES (?, 'Fixture', 1, '{}', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`).run(id);
}

function insertRun(db: Database.Database, id: string, workflowId = 'workflow', key: string | null = null): void {
  db.prepare(`INSERT INTO workflow_runs
    (id, workflow_id, workflow_title, definition_revision, definition_json, input_json,
     trigger_json, status, revision, idempotency_key, started_at)
    VALUES (?, ?, 'Fixture', 1, '{}', '{}', '{}', 'running', 1, ?, '2026-07-20T00:00:00.000Z')`)
    .run(id, workflowId, key);
}

function insertNode(db: Database.Database, runId: string, nodeId = 'node'): void {
  db.prepare(`INSERT INTO workflow_node_runs (run_id, node_id, node_type, status)
    VALUES (?, ?, 'employee', 'running')`).run(runId, nodeId);
}

const tables = [
  'workflow_approvals',
  'workflow_attempts',
  'workflow_definitions',
  'workflow_node_runs',
  'workflow_runs',
  'workflow_schema',
];

const indexes = [
  'workflow_approvals_pending',
  'workflow_attempts_by_session',
  'workflow_attempts_due_reminder',
  'workflow_attempts_retry_key',
  'workflow_node_runs_due',
  'workflow_runs_by_status_started',
  'workflow_runs_by_workflow_started',
];

const alteredApprovalTable = `
DROP TABLE workflow_approvals;
CREATE TABLE workflow_approvals (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  approver_ref TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decision TEXT,
  reason INTEGER,
  PRIMARY KEY(run_id, node_id),
  FOREIGN KEY(run_id, node_id) REFERENCES workflow_node_runs(run_id, node_id) ON DELETE RESTRICT
);`;

const v1SchemaMutations = [
  ['one missing table', 'DROP TABLE workflow_approvals'],
  ['one missing named index', 'DROP INDEX workflow_approvals_pending'],
  ['altered column, default, and foreign key', alteredApprovalTable],
  ['altered index columns and direction', `DROP INDEX workflow_runs_by_status_started;
    CREATE INDEX workflow_runs_by_status_started ON workflow_runs(status DESC, ended_at, id ASC)`],
  ['an extra workflow table', 'CREATE TABLE workflow_extra (value TEXT)'],
  ['an extra workflow index', 'CREATE INDEX workflow_extra_index ON workflow_definitions(title)'],
  ['an extra workflow trigger', `CREATE TRIGGER workflow_extra_trigger AFTER UPDATE ON workflow_definitions
    BEGIN SELECT 1; END`],
  ['an extra workflow view', 'CREATE VIEW workflow_extra_view AS SELECT id FROM workflow_definitions'],
] as const;

describe('workflow database paths and connection', () => {
  it('resolves constants from the isolated JINN_HOME and opens the default path', () => {
    expect(paths.WORKFLOWS_DIR).toBe(join(suiteRoot, 'workflows'));
    expect(paths.WORKFLOWS_DB_PATH).toBe(join(suiteRoot, 'workflows', 'workflows.db'));
    withWorkflowDatabase(undefined, (db) => expect(db.open).toBe(true));
    expect(existsSync(paths.WORKFLOWS_DB_PATH)).toBe(true);
  });

  it('leaves an injected caller-owned parent and database modes unchanged', () => {
    const ownerParent = join(suiteRoot, 'caller-owned');
    const target = join(ownerParent, 'workflows.db');
    mkdirSync(ownerParent, { mode: 0o755 });
    withRawDatabase(target, () => undefined);
    if (process.platform !== 'win32') {
      chmodSync(ownerParent, 0o755);
      chmodSync(target, 0o640);
    }
    withWorkflowDatabase(target, (db) => expect(db.open).toBe(true));
    if (process.platform !== 'win32') {
      expectPosixMode(statSync(ownerParent), 0o755);
      expectPosixMode(statSync(target), 0o640);
    }
  });

  it('sets pragmas on the first connection and an independent reopen', () => {
    const file = databasePath('pragmas');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      withWorkflowDatabase(file, (db) => {
        expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
        expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      });
    }
  });

  it('supports repeated close/open and a Unicode absolute path without residue', () => {
    const file = databasePath('special space — 流程');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      withWorkflowDatabase(file, (db) => expect(db.open).toBe(true));
      expect(existsSync(`${file}-wal`)).toBe(false);
      expect(existsSync(`${file}-shm`)).toBe(false);
    }
    const moved = `${file}.moved`;
    renameSync(file, moved);
    renameSync(moved, file);
  });
});

describe('fresh version 3 schema', () => {
  it('creates the exact table set and definition/run column shapes', () => {
    withWorkflowDatabase(databasePath('columns'), (db) => {
      expect(tableNames(db)).toEqual(tables);
      expect(tableInfo(db, 'workflow_schema')).toEqual(expectedColumns([
        column('version', 'INTEGER', 1, null, 0),
      ]));
      expect(tableInfo(db, 'workflow_definitions')).toEqual(expectedColumns([
        column('id', 'TEXT', 0, null, 1), column('title', 'TEXT', 1, null, 0),
        column('revision', 'INTEGER', 1, null, 0), column('enabled', 'INTEGER', 1, '0', 0),
        column('retired_at', 'TEXT', 0, null, 0), column('definition_json', 'TEXT', 1, null, 0),
        column('created_at', 'TEXT', 1, null, 0), column('updated_at', 'TEXT', 1, null, 0),
      ]));
      expect(tableInfo(db, 'workflow_runs')).toEqual(expectedColumns([
        column('id', 'TEXT', 0, null, 1), column('workflow_id', 'TEXT', 1, null, 0),
        column('workflow_title', 'TEXT', 1, null, 0), column('definition_revision', 'INTEGER', 1, null, 0),
        column('definition_json', 'TEXT', 1, null, 0), column('input_json', 'TEXT', 1, null, 0),
        column('trigger_json', 'TEXT', 1, null, 0), column('status', 'TEXT', 1, null, 0),
        column('revision', 'INTEGER', 1, null, 0), column('idempotency_key', 'TEXT', 0, null, 0),
        column('invocation_session_id', 'TEXT', 0, null, 0), column('cancel_requested_at', 'TEXT', 0, null, 0),
        column('started_at', 'TEXT', 1, null, 0), column('ended_at', 'TEXT', 0, null, 0),
        column('error_json', 'TEXT', 0, null, 0),
      ]));
    });
  });

  it('creates the locked node-run column shape', () => {
    withWorkflowDatabase(databasePath('node-run-columns'), (db) => {
      expect(tableInfo(db, 'workflow_node_runs')).toEqual(expectedColumns([
        column('run_id', 'TEXT', 1, null, 1), column('node_id', 'TEXT', 1, null, 2),
        column('node_type', 'TEXT', 1, null, 0), column('status', 'TEXT', 1, null, 0),
        column('activated', 'INTEGER', 1, '0', 0), column('resolved_config_json', 'TEXT', 0, null, 0),
        column('input_json', 'TEXT', 0, null, 0), column('output_json', 'TEXT', 0, null, 0),
        column('error_json', 'TEXT', 0, null, 0), column('resume_at', 'TEXT', 0, null, 0),
        column('started_at', 'TEXT', 0, null, 0), column('ended_at', 'TEXT', 0, null, 0),
      ]));
    });
  });

  it('creates the locked attempt and approval column shapes', () => {
    withWorkflowDatabase(databasePath('attempt-approval-columns'), (db) => {
      expect(tableInfo(db, 'workflow_attempts')).toEqual(expectedColumns([
        column('run_id', 'TEXT', 1, null, 1), column('node_id', 'TEXT', 1, null, 2),
        column('attempt', 'INTEGER', 1, null, 3), column('session_id', 'TEXT', 0, null, 0),
        column('status', 'TEXT', 1, null, 0), column('resolved_config_json', 'TEXT', 1, null, 0),
        column('input_json', 'TEXT', 1, null, 0), column('output_json', 'TEXT', 0, null, 0),
        column('error_json', 'TEXT', 0, null, 0), column('started_at', 'TEXT', 1, null, 0),
        column('ended_at', 'TEXT', 0, null, 0), column('retry_idempotency_key', 'TEXT', 0, null, 0),
        column('reminders_sent', 'INTEGER', 1, '0', 0), column('next_reminder_at', 'TEXT', 0, null, 0),
        column('extensions', 'INTEGER', 1, '0', 0), column('last_extension_reason', 'TEXT', 0, null, 0),
        column('pending_output_error', 'TEXT', 0, null, 0),
        column('last_processed_turn', 'INTEGER', 1, '0', 0),
        column('prompt_text', 'TEXT', 0, null, 0),
      ]));
      expect(tableInfo(db, 'workflow_approvals')).toEqual(expectedColumns([
        column('run_id', 'TEXT', 1, null, 1), column('node_id', 'TEXT', 1, null, 2),
        column('status', 'TEXT', 1, null, 0), column('requested_at', 'TEXT', 1, null, 0),
        column('approver_ref', 'TEXT', 0, null, 0), column('decided_at', 'TEXT', 0, null, 0),
        column('decided_by', 'TEXT', 0, null, 0), column('decision', 'TEXT', 0, null, 0),
        column('reason', 'TEXT', 0, null, 0),
      ]));
    });
  });
});

describe('fresh version 3 schema metadata', () => {
  it('creates exactly the seven named indexes with locked columns and directions', () => {
    withWorkflowDatabase(databasePath('indexes'), (db) => {
      expect(namedIndexes(db)).toEqual(indexes);
      expect(indexColumns(db, 'workflow_runs_by_workflow_started')).toEqual([
        { name: 'workflow_id', desc: 0 }, { name: 'started_at', desc: 1 }, { name: 'id', desc: 1 },
      ]);
      expect(indexColumns(db, 'workflow_runs_by_status_started')).toEqual([
        { name: 'status', desc: 0 }, { name: 'started_at', desc: 1 }, { name: 'id', desc: 1 },
      ]);
      expect(indexColumns(db, 'workflow_attempts_by_session')).toEqual([{ name: 'session_id', desc: 0 }]);
      expect(indexColumns(db, 'workflow_attempts_due_reminder')).toEqual([
        { name: 'status', desc: 0 }, { name: 'next_reminder_at', desc: 0 },
      ]);
      expect(indexColumns(db, 'workflow_attempts_retry_key')).toEqual([
        { name: 'run_id', desc: 0 }, { name: 'retry_idempotency_key', desc: 0 },
      ]);
      expect(indexColumns(db, 'workflow_approvals_pending')).toEqual([
        { name: 'status', desc: 0 }, { name: 'requested_at', desc: 0 },
      ]);
      expect(indexColumns(db, 'workflow_node_runs_due')).toEqual([
        { name: 'status', desc: 0 }, { name: 'resume_at', desc: 0 },
      ]);
    });
  });

  it('stores exactly one schema version row equal to the exported version', () => {
    withWorkflowDatabase(databasePath('version'), (db) => {
      expect(migrations.WORKFLOW_DB_SCHEMA_VERSION).toBe(3);
      const inventory = migrations as unknown as Record<string, unknown>;
      const physicalVersions = Array.from(
        { length: migrations.WORKFLOW_DB_SCHEMA_VERSION }, (_, index) => index + 1,
      );
      expect(inventory.WORKFLOW_DB_PHYSICAL_SCHEMA_VERSIONS).toEqual(physicalVersions);
      expect(inventory.WORKFLOW_DB_MIGRATION_SOURCE_VERSIONS)
        .toEqual(physicalVersions.map((version) => version - 1));
      expect(db.prepare('SELECT version FROM workflow_schema').all()).toEqual([{ version: 3 }]);
    });
  });

  it('uses the locked foreign-key shapes', () => {
    withWorkflowDatabase(databasePath('foreign-key-shapes'), (db) => {
      expect(foreignKeys(db, 'workflow_runs')).toEqual([
        { seq: 0, table: 'workflow_definitions', from: 'workflow_id', to: 'id', on_update: 'NO ACTION', on_delete: 'NO ACTION', match: 'NONE' },
      ]);
      expect(foreignKeys(db, 'workflow_node_runs')).toEqual([
        { seq: 0, table: 'workflow_runs', from: 'run_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
      ]);
      for (const table of ['workflow_attempts', 'workflow_approvals']) {
        expect(foreignKeys(db, table)).toEqual([
          { seq: 0, table: 'workflow_node_runs', from: 'run_id', to: 'run_id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
          { seq: 1, table: 'workflow_node_runs', from: 'node_id', to: 'node_id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
        ]);
      }
    });
  });
});

describe('migration safety and idempotency', () => {
  it('upgrades an exact v1 database in place while preserving data and adding retry claims', () => {
    const file = versionOneDatabase('v1-retry-migration');
    withWorkflowDatabase(file, (db) => {
      expect(db.prepare('SELECT version FROM workflow_schema').pluck().get()).toBe(3);
      expect(tableInfo(db, 'workflow_attempts').map((entry) => entry.name)).toContain('retry_idempotency_key');
      expect(tableInfo(db, 'workflow_attempts').map((entry) => entry.name)).toContain('reminders_sent');
      expect(db.prepare("SELECT title FROM workflow_definitions WHERE id = 'sentinel'").pluck().get()).toBe('Fixture');
    });
  });

  it('upgrades an exact v2 database in place while preserving attempts and adding reminder state', () => {
    const file = versionTwoDatabase('v2-reminder-migration');
    withRawDatabase(file, (db) => {
      insertRun(db, 'run', 'sentinel');
      insertNode(db, 'run');
      db.prepare(`INSERT INTO workflow_attempts
        (run_id, node_id, attempt, session_id, status, resolved_config_json, input_json, started_at)
        VALUES ('run', 'node', 1, 'session-1', 'running', '{}', '{}', '2026-07-20T00:00:00.000Z')`).run();
    });
    withWorkflowDatabase(file, (db) => {
      expect(db.prepare('SELECT version FROM workflow_schema').pluck().get()).toBe(3);
      expect(db.prepare(`SELECT session_id, reminders_sent, next_reminder_at, extensions,
        last_extension_reason, pending_output_error, last_processed_turn, prompt_text FROM workflow_attempts`).get()).toEqual({
        session_id: 'session-1',
        reminders_sent: 0,
        next_reminder_at: null,
        extensions: 0,
        last_extension_reason: null,
        pending_output_error: null,
        last_processed_turn: 0,
        prompt_text: null,
      });
    });
  });

  it('is idempotent on one connection and reopen while preserving data and schema', () => {
    const file = databasePath('idempotent');
    let expectedSchema: string[] = [];
    withWorkflowDatabase(file, (db) => {
      insertDefinition(db, 'sentinel');
      expectedSchema = schemaSql(db);
      migrations.migrateWorkflowDatabase(db);
      migrations.migrateWorkflowDatabase(db);
      expect(schemaSql(db)).toEqual(expectedSchema);
      expect(db.prepare("SELECT title FROM workflow_definitions WHERE id = 'sentinel'").pluck().get()).toBe('Fixture');
    });
    withWorkflowDatabase(file, (db) => {
      expect(schemaSql(db)).toEqual(expectedSchema);
      expect(db.prepare("SELECT COUNT(*) FROM workflow_definitions WHERE id = 'sentinel'").pluck().get()).toBe(1);
    });
  });

  it('rejects a DELETE-journal future v4 without changing bytes, schema, data, mode, or sidecars', () => {
    const file = databasePath('future');
    withRawDatabase(file, (db) => {
      expect(db.pragma('journal_mode = DELETE', { simple: true })).toBe('delete');
      db.exec('CREATE TABLE workflow_schema (version INTEGER NOT NULL); INSERT INTO workflow_schema VALUES (4); CREATE TABLE marker (value TEXT)');
      db.prepare("INSERT INTO marker VALUES ('preserve-me')").run();
    });
    expectRejectedWithoutMutation(file, 'Unsupported workflow database schema version.');
  });

  it('rejects a malformed DELETE-journal v3 without changing bytes, schema, data, mode, or sidecars', () => {
    const file = currentDatabase('malformed-v1-no-mutation');
    withRawDatabase(file, (db) => {
      expect(db.pragma('journal_mode = DELETE', { simple: true })).toBe('delete');
      db.exec('DROP INDEX workflow_approvals_pending');
    });
    expectRejectedWithoutMutation(file, 'Malformed workflow database schema version.');
  });

  it.each([
    ['empty', []],
    ['multiple', [1, 1]],
    ['non-integer', ['version-one']],
    ['negative', [-1]],
  ])('rejects a malformed %s version shape non-destructively', (_label, versions) => {
    const file = databasePath(`malformed-${_label}`);
    withRawDatabase(file, (db) => {
      db.exec('CREATE TABLE workflow_schema (version INTEGER NOT NULL); CREATE TABLE marker (value TEXT)');
      const insert = db.prepare('INSERT INTO workflow_schema VALUES (?)');
      for (const version of versions) insert.run(version);
      db.prepare("INSERT INTO marker VALUES ('preserve-me')").run();
    });
    expect(() => migrations.openWorkflowDatabase(file)).toThrowError('Malformed workflow database schema version.');
    withRawDatabase(file, (db) => {
      expect(db.prepare('SELECT version, typeof(version) AS type FROM workflow_schema').all()).toHaveLength(versions.length);
      expect(db.prepare('SELECT value FROM marker').pluck().get()).toBe('preserve-me');
      expect(domainTableNames(db)).toEqual([]);
    });
  });

  it('rolls back a supported 0-to-1 migration fault without enabling WAL', () => {
    const file = databasePath('rollback');
    mkdirSync(dirname(file), { recursive: true });
    const originalExec = Database.prototype.exec;
    const exec = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes('CREATE TABLE workflow_definitions')) throw new Error('injected migration fault');
      return originalExec.call(this, sql);
    });
    try {
      expect(() => migrations.openWorkflowDatabase(file)).toThrowError('injected migration fault');
    } finally {
      exec.mockRestore();
    }
    const snapshot = rejectedDatabaseSnapshot(file);
    expect(snapshot).toMatchObject({ schema: [], journalMode: 'delete', sidecars: [false, false, false] });
  });
});

describe('schema structure classification', () => {
  it('accepts mixed-case version 0 with whitespace and trailing semicolons and migrates it', () => {
    const file = databasePath('mixed-case-version-zero');
    withRawDatabase(file, (db) => db.exec(`
      cReAtE tAbLe WORKFLOW_SCHEMA (version iNtEgEr nOt nUlL) ;
      iNsErT iNtO WORKFLOW_SCHEMA vAlUeS (0) ;
    `));
    withWorkflowDatabase(file, (db) => {
      expect(tableNames(db).map((name) => name.toLowerCase()).sort()).toEqual(tables);
      expect(db.prepare('SELECT version FROM workflow_schema').pluck().get()).toBe(3);
    });
  });

  it('accepts complete version 3 with uppercase keywords, types, and identifiers', () => {
    const file = uppercaseCurrentDatabase('uppercase-current');
    withWorkflowDatabase(file, (db) => {
      expect(db.prepare("SELECT definition_json FROM workflow_definitions WHERE id = 'sentinel'").pluck().get()).toBe('{}');
    });
  });

  it('does not confuse a similarly named table for the schema table', () => {
    const file = databasePath('schema-name-suffix');
    withRawDatabase(file, (db) => db.exec('CREATE TABLE workflow_schema_extra (value TEXT)'));
    expectMalformedWithoutMutation(file);
  });
  it.each([
    ['extra column', 'ALTER TABLE workflow_approvals ADD COLUMN rogue TEXT'],
    ['changed default and missing ON DELETE', alteredApprovalTable.replace(' ON DELETE RESTRICT', '')],
    ['changed index direction and column', v1SchemaMutations[3][1]],
    ['extra object', 'CREATE TABLE workflow_mixed_extra (value TEXT)'],
  ])('still rejects mixed-case version 1 with %s', (label, mutation) => {
    const file = uppercaseCurrentDatabase(`mixed-material-${label.replaceAll(' ', '-')}`);
    withRawDatabase(file, (db) => db.exec(mutation));
    expectMalformedWithoutMutation(file);
  });

  it.each([0, 1, 2, 3])('rejects and preserves an extra-column schema table at version %i', (version) => {
    const file = databasePath(`extra-schema-column-${version}`);
    withRawDatabase(file, (db) => db.exec(`
      CREATE TABLE workflow_schema (version INTEGER NOT NULL, rogue TEXT);
      INSERT INTO workflow_schema VALUES (${version}, 'preserve-me');
    `));
    expectMalformedWithoutMutation(file);
  });

  it('rejects and preserves a forged version 1 with no domain objects', () => {
    const file = databasePath('forged-empty-v1');
    withRawDatabase(file, (db) => db.exec(`
      CREATE TABLE workflow_schema (version INTEGER NOT NULL);
      INSERT INTO workflow_schema VALUES (1);
    `));
    expectMalformedWithoutMutation(file);
  });

  it.each(v1SchemaMutations)('rejects and preserves version 3 with %s', (label, mutation) => {
    const file = currentDatabase(`forged-${label.replaceAll(' ', '-')}`);
    withRawDatabase(file, (db) => db.exec(mutation));
    expectMalformedWithoutMutation(file);
  });

  it('migrates an exact schema-table-only version 0 and accepts the resulting current schema', () => {
    const file = databasePath('exact-version-zero');
    withRawDatabase(file, (db) => db.exec(`
      CREATE TABLE workflow_schema (version INTEGER NOT NULL);
      INSERT INTO workflow_schema VALUES (0);
    `));
    withWorkflowDatabase(file, (db) => {
      expect(tableNames(db)).toEqual(tables);
      expect(db.prepare('SELECT version FROM workflow_schema').pluck().all()).toEqual([3]);
      migrations.migrateWorkflowDatabase(db);
    });
  });

  it('accepts an exact current version 3 on independent reopen without changing sentinel data', () => {
    const file = currentDatabase('exact-current-reopen');
    const before = databaseSnapshot(file);
    withWorkflowDatabase(file, (db) => migrations.migrateWorkflowDatabase(db));
    expect(databaseSnapshot(file)).toBe(before);
  });
});

describe('locked constraints', () => {
  it('rejects a run whose definition does not exist', () => {
    withWorkflowDatabase(databasePath('foreign-key-rejection'), (db) => {
      expect(() => insertRun(db, 'orphan', 'missing')).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  it('cascades run deletion through nodes, attempts, and approvals and protects definitions', () => {
    withWorkflowDatabase(databasePath('cascades'), (db) => {
      insertDefinition(db);
      insertRun(db, 'run');
      insertNode(db, 'run');
      db.prepare(`INSERT INTO workflow_attempts
        (run_id, node_id, attempt, status, resolved_config_json, input_json, started_at)
        VALUES ('run', 'node', 1, 'running', '{}', '{}', '2026-07-20T00:00:00.000Z')`).run();
      db.prepare(`INSERT INTO workflow_approvals (run_id, node_id, status, requested_at)
        VALUES ('run', 'node', 'pending', '2026-07-20T00:00:00.000Z')`).run();
      expect(() => db.prepare("DELETE FROM workflow_definitions WHERE id = 'workflow'").run())
        .toThrow(/FOREIGN KEY constraint failed/);
      db.prepare("DELETE FROM workflow_runs WHERE id = 'run'").run();
      for (const table of ['workflow_node_runs', 'workflow_attempts', 'workflow_approvals']) {
        expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
      }
      expect(db.prepare('SELECT COUNT(*) FROM workflow_definitions').pluck().get()).toBe(1);
    });
  });

  it('enforces non-null idempotency uniqueness per workflow while allowing multiple NULL keys', () => {
    withWorkflowDatabase(databasePath('idempotency'), (db) => {
      insertDefinition(db, 'first');
      insertDefinition(db, 'second');
      insertRun(db, 'first-key', 'first', 'same-key');
      expect(() => insertRun(db, 'duplicate-key', 'first', 'same-key')).toThrow(/UNIQUE constraint failed/);
      insertRun(db, 'other-workflow-key', 'second', 'same-key');
      insertRun(db, 'first-null', 'first');
      insertRun(db, 'second-null', 'first');
      expect(db.prepare('SELECT COUNT(*) FROM workflow_runs').pluck().get()).toBe(4);
    });
  });
});

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, statSync, statfsSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SESSIONS_DB } from '../shared/paths.js';
import { getPackageVersion } from '../shared/version.js';
import { logger } from '../shared/logger.js';
import {
  migrateWorkItemsSchema,
  preflightWorkItemsDatabase,
  UNSUPPORTED_PRERELEASE_TODO_DATA,
  WORK_ITEMS_BACKUP_SUFFIX,
} from '../work-items/migrate.js';
import type { WorkItemSchemaPreflight } from '../work-items/migrate.js';
import { parseTodoId } from '../work-items/id.js';
import type { ChatBlock, ChatBlockEnvelope, EngineSessionRef, EngineSessionRefs, JsonObject, ReplyContext, Session, SessionAttemptOutcome, SessionDelivery, SessionDeliveryIdentity, SessionDeliveryPayload, WorkflowAttemptInterruptionCause, WorkflowSessionProvenance } from '../shared/types.js';
import { blockFallbackText, mergeBlock, validateBlockEnvelope } from '../shared/blocks.js';
import { ptySnapshotStore } from '../engines/pty-snapshot.js';

let db: Database.Database | undefined;

export const RESTART_ACK_META_KEY = "restartAcknowledgedAt";
export const GATEWAY_RESTARTED_MESSAGE = "Gateway restarted successfully.";

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  engine_sessions TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  connector TEXT,
  session_key TEXT,
  reply_context TEXT,
  message_id TEXT,
  transport_meta TEXT,
  employee TEXT,
  model TEXT,
  title TEXT,
  prompt_excerpt TEXT,
  parent_session_id TEXT,
  workflow_kind TEXT,
  workflow_id TEXT,
  workflow_name TEXT,
  workflow_run_id TEXT,
  workflow_trigger_source TEXT,
  workflow_phase_node_id TEXT,
  workflow_phase_name TEXT,
  workflow_phase_index INTEGER,
  workflow_phase_round INTEGER,
  workflow_phase_attempt INTEGER,
  user_id TEXT,
  status TEXT DEFAULT 'idle',
  attempt_outcome TEXT,
  attempt_token TEXT,
  attempt_terminal_version INTEGER NOT NULL DEFAULT 0,
  attempt_turn INTEGER NOT NULL DEFAULT 0,
  attempt_interruption_cause TEXT,
  attempt_interruption_turn INTEGER,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT
)`;

const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
)`;

const CREATE_MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, timestamp)
`;

const CREATE_MESSAGES_ORDER_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session_order ON messages (session_id, timestamp, seq)
`;

const CREATE_SESSION_KEY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions (session_key, last_activity)
`;

/** Caller-supplied delegation idempotency keys map to one durable session. The
 * key stored in session_key is a scoped hash, so the unique index is both
 * restart-safe and safe to add to existing databases. */
const CREATE_DELEGATION_IDEMPOTENCY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_delegation_idempotency
  ON sessions (session_key) WHERE session_key LIKE 'delegation-idempotency:%'
`;

// Backs `ORDER BY last_activity DESC` in the session list (was a full scan + sort).
const CREATE_LAST_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity DESC)
`;

// Backs the children lookup (was a full-table deserialization + JS filter).
const CREATE_PARENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)
`;

// Backs provenance filters and workflow-run grouping lookups without parsing the
// deterministic sourceRef. Partial because ordinary chats never carry a run id.
const CREATE_WORKFLOW_RUN_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_workflow_run ON sessions (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL
`;

// Backs the highly-selective status filter (running ~6 of 2.5k rows) used on
// every boot (recoverStaleSessions / getInterruptedSessions) and every
// status-reconciler tick (listSessions({status:'running'})) — all of which were
// SCANning the full sessions table. Composite with last_activity DESC so the
// status-filtered list read also gets its ORDER BY from the index.
const CREATE_STATUS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status, last_activity DESC)
`;

// Backs the `WHERE partial = 1` hot path — the boot sweep (clearAllPartialMessages)
// and every turn-settle (deletePartialMessages / finalizePartialMessages /
// getPartialMessages), which were full-SCANning the (largest) messages table to
// touch a handful of live mid-turn rows. Partial index: only the tiny set of
// currently-partial rows is indexed, so it stays cheap regardless of history size.
const CREATE_MESSAGES_PARTIAL_INDEX = `
DROP INDEX IF EXISTS idx_messages_partial;
CREATE INDEX IF NOT EXISTS idx_messages_partial_order
  ON messages (session_id, timestamp, COALESCE(seq, 0)) WHERE partial = 1
`;

const CREATE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mimetype TEXT,
  path TEXT,
  created_at TEXT NOT NULL
)
`;

// Generic key/value store for one-off migration progress flags (e.g. the FTS
// backfill watermark). Keep entries tiny — this is not a config table.
const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
)
`;

const CREATE_CHAT_PINS_TABLE = `
CREATE TABLE IF NOT EXISTS chat_pins (
  pin_key TEXT PRIMARY KEY,
  pinned_at TEXT NOT NULL
)
`;

function callbackDeliveriesTableSql(tableName = 'callback_deliveries'): string {
  return `
CREATE TABLE ${tableName} (
  id TEXT PRIMARY KEY,
  target_session_id TEXT NOT NULL CHECK (length(target_session_id) > 0 AND target_session_id = jinn_callback_identity(target_session_id)),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('session', 'workflow-run')),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0 AND source_id = jinn_callback_identity(source_id)),
  source_attempt TEXT NOT NULL CHECK (length(source_attempt) > 0 AND source_attempt = jinn_callback_identity(source_attempt)),
  source_outcome TEXT NOT NULL CHECK (length(source_outcome) > 0 AND source_outcome = jinn_callback_identity(source_outcome)),
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  delivery_kind TEXT NOT NULL CHECK (length(delivery_kind) > 0 AND delivery_kind = jinn_callback_identity(delivery_kind)),
  payload TEXT NOT NULL CHECK (
    json_valid(payload)
    AND json_type(payload) = 'object'
    AND json_type(payload, '$.message') IS 'text'
    AND json_type(payload, '$.displayMessage') IS 'text'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dead_letter')),
  message_id TEXT,
  queue_item_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT,
  dead_lettered_at INTEGER,
  created_at TEXT NOT NULL,
  accepted_at TEXT
)
`;
}

const CREATE_CALLBACK_DELIVERIES_TABLE = callbackDeliveriesTableSql();

const CALLBACK_DELIVERY_REQUIRED_COLUMNS = [
  'id',
  'target_session_id',
  'source_kind',
  'source_id',
  'source_attempt',
  'source_outcome',
  'source_version',
  'delivery_kind',
  'payload',
  'status',
  'message_id',
  'queue_item_id',
  'attempt_count',
  'next_attempt_at',
  'last_attempt_at',
  'last_error',
  'dead_lettered_at',
  'created_at',
  'accepted_at',
] as const;

// Work-item primitive (GRS-002, elevated to the Todos model by GRS-021a). The
// durable unit of intended work; sessions are execution attempts against it
// (see sessions.work_item_id below). The DDL lives in `work-items/migrate.ts`
// (single source of truth shared with the vocabulary rebuild); CHECK constraints
// enforce the valid status/priority/source sets at the DB layer and the partial
// UNIQUE index gives machine-minted items idempotency on (source, source_ref).
// Created inside initDb's sequence to avoid an init-order race. The store module
// (`work-items/store.ts`) + guarded `work-items/transitions.ts` are the only
// write paths.

// Backs listSessionsByWorkItem (the GRS-002 read-back path) and any future
// per-item session lookup. Partial: only sessions actually linked to an item.
const CREATE_WORK_ITEM_SESSION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_work_item ON sessions (work_item_id) WHERE work_item_id IS NOT NULL
`;

// Full-text search over message bodies. External-content FTS5 table (the index
// lives here; `content` is read back from `messages` via rowid for snippets), so
// it stays in lockstep with `messages` through the AI/AD/AU triggers below. Only
// user/assistant rows are indexed — notification/tool rows are deliberately
// excluded (they're machine chatter, not conversation). Pre-existing rows are
// seeded by a yielded backfill after listen(). While that backfill is in flight,
// the AD/AU triggers only issue an FTS delete for rowids known to be indexed:
// already-drained legacy rows or post-watermark rows owned by the AI trigger.
// This keeps legacy updates/deletes safe without blocking gateway boot.
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
WHEN new.role IN ('user','assistant') AND (
  COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
  OR new.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
  OR new.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
) BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
WHEN old.role IN ('user','assistant') AND (
  COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
  OR old.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
  OR old.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
) BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  SELECT 'delete', old.rowid, old.content
  WHERE old.role IN ('user','assistant') AND (
    COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
    OR old.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
    OR old.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
  );
  INSERT INTO messages_fts(rowid, content)
  SELECT new.rowid, new.content
  WHERE new.role IN ('user','assistant') AND (
    COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
    OR new.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
    OR new.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
  );
END;
`;

function parseJsonObject(value: unknown, label?: string): JsonObject | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as JsonObject;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Graceful degrade (don't crash the load), but surface it — silent loss of
    // reply_context/transport_meta otherwise shows up as a cryptic "no target".
    logger.warn(`registry: dropped corrupt JSON in ${label ?? 'session field'}`);
    return null;
  }
}

function parseEngineSessions(value: unknown): EngineSessionRefs | null {
  const parsed = parseJsonObject(value, 'engine_sessions');
  if (!parsed) return null;

  const refs: EngineSessionRefs = {};
  for (const [engine, raw] of Object.entries(parsed)) {
    if (!engine || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const ref: EngineSessionRef = {};
    if (typeof obj.id === 'string' && obj.id.trim()) ref.id = obj.id;
    if (typeof obj.model === 'string' && obj.model.trim()) ref.model = obj.model;
    if (typeof obj.effortLevel === 'string' && obj.effortLevel.trim()) ref.effortLevel = obj.effortLevel;
    if (typeof obj.lastSyncedAt === 'string' && obj.lastSyncedAt.trim()) ref.lastSyncedAt = obj.lastSyncedAt;
    if (typeof obj.platformContextFingerprint === 'string' && obj.platformContextFingerprint.trim()) {
      ref.platformContextFingerprint = obj.platformContextFingerprint;
    }
    if (Object.keys(ref).length > 0) refs[engine] = ref;
  }
  return Object.keys(refs).length > 0 ? refs : null;
}

function cleanEngineSessionRef(ref: EngineSessionRef): EngineSessionRef {
  const cleaned: EngineSessionRef = {};
  if (ref.id?.trim()) cleaned.id = ref.id;
  if (ref.model?.trim()) cleaned.model = ref.model;
  if (ref.effortLevel?.trim()) cleaned.effortLevel = ref.effortLevel;
  if (ref.lastSyncedAt?.trim()) cleaned.lastSyncedAt = ref.lastSyncedAt;
  if (ref.platformContextFingerprint?.trim()) cleaned.platformContextFingerprint = ref.platformContextFingerprint;
  return cleaned;
}

function cleanEngineSessionRefs(refs: EngineSessionRefs | null | undefined): EngineSessionRefs | null {
  if (!refs || typeof refs !== 'object') return null;
  const cleaned: EngineSessionRefs = {};
  for (const [engine, ref] of Object.entries(refs)) {
    if (!engine || !ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const next = cleanEngineSessionRef(ref);
    if (Object.keys(next).length > 0) cleaned[engine] = next;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function workflowProvenanceFromRow(row: Record<string, unknown>): WorkflowSessionProvenance | null {
  const kind = row.workflow_kind;
  const workflowId = row.workflow_id;
  const workflowName = row.workflow_name;
  const runId = row.workflow_run_id;
  const triggerSource = row.workflow_trigger_source;
  if (
    kind !== 'phase' ||
    typeof workflowId !== 'string' || !workflowId ||
    typeof workflowName !== 'string' || !workflowName ||
    typeof runId !== 'string' || !runId ||
    typeof triggerSource !== 'string' || !triggerSource
  ) {
    return null;
  }
  const nodeId = row.workflow_phase_node_id;
  const name = row.workflow_phase_name;
  const index = row.workflow_phase_index;
  const round = row.workflow_phase_round;
  const attempt = row.workflow_phase_attempt;
  if (
    typeof nodeId !== 'string' || !nodeId ||
    typeof name !== 'string' || !name ||
    typeof index !== 'number' || !Number.isInteger(index) || index < 1 ||
    typeof round !== 'number' || !Number.isInteger(round) || round < 1 ||
    typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1
  ) {
    logger.warn(`registry: dropped incomplete workflow phase provenance for session ${String(row.id ?? '')}`);
    return null;
  }
  return {
    kind,
    workflowId,
    workflowName,
    runId,
    triggerSource,
    phase: { nodeId, name, index, round, attempt },
  };
}

function rowToSession(row: Record<string, unknown>): Session {
  const replyContext = parseJsonObject(row.reply_context, 'reply_context');
  const transportMeta = parseJsonObject(row.transport_meta, 'transport_meta');
  const engineSessions = parseEngineSessions(row.engine_sessions);
  const sessionKey = ((row.session_key as string) || (row.source_ref as string));
  const connector = (row.connector as string) ?? (row.source as string) ?? null;
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    engineSessions,
    source: row.source as string,
    sourceRef: row.source_ref as string,
    connector,
    sessionKey,
    workItemId: (row.work_item_id as string) ?? null,
    replyContext: replyContext as ReplyContext | null,
    messageId: (row.message_id as string) ?? null,
    transportMeta,
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    title: (row.title as string) ?? null,
    promptExcerpt: (row.prompt_excerpt as string) ?? null,
    archivedAt: (row.archived_at as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    workflowProvenance: workflowProvenanceFromRow(row),
    userId: (row.user_id as string) ?? null,
    effortLevel: (row.effort_level as string) ?? null,
    status: row.status as Session['status'],
    attemptOutcome: (row.attempt_outcome as SessionAttemptOutcome) ?? null,
    attemptToken: (row.attempt_token as string) ?? null,
    attemptTerminalVersion: (row.attempt_terminal_version as number) ?? 0,
    attemptTurn: (row.attempt_turn as number) ?? 0,
    attemptInterruptionCause: (row.attempt_interruption_cause as WorkflowAttemptInterruptionCause) ?? null,
    attemptInterruptionTurn: (row.attempt_interruption_turn as number) ?? null,
    totalCost: (row.total_cost as number) ?? 0,
    totalTurns: (row.total_turns as number) ?? 0,
    lastContextTokens: (row.last_context_tokens as number) ?? null,
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
  };
}

// --- Upgrade safety around the session database -----------------------------
// Migrations are transactional (atomic rollback on failure), but two failure
// modes still deserve belt-and-suspenders: (1) running out of disk mid-migration
// — the classic corruption trigger — and (2) an operator wanting to undo an
// upgrade. So before an upgrade migration we refuse to proceed on a near-full
// disk and snapshot the existing DB, logging where it went.
const MIN_FREE_BYTES_FOR_DB = 200 * 1024 * 1024; // 200 MB headroom for a migration
const DB_VERSION_SIDECAR = `${SESSIONS_DB}.version`;
const DB_BACKUP_DIR = path.join(path.dirname(SESSIONS_DB), 'backups');
const KEEP_PREMIGRATION_BACKUPS = 3;

function preflightSessionDiskSpace(): void {
  let free: number;
  try {
    const dir = existsSync(path.dirname(SESSIONS_DB))
      ? path.dirname(SESSIONS_DB)
      : path.dirname(path.dirname(SESSIONS_DB));
    const fs = statfsSync(dir);
    free = fs.bavail * fs.bsize;
  } catch {
    return; // can't stat the filesystem — don't block boot on that alone
  }
  if (free < MIN_FREE_BYTES_FOR_DB) {
    const mb = Math.round(free / (1024 * 1024));
    throw new Error(
      `Refusing to open the session database: only ${mb} MB free on the disk holding ${SESSIONS_DB}. ` +
        `Free up space before starting — running out of disk during a schema migration can corrupt the database.`,
    );
  }
}

function prunePremigrationBackups(): void {
  try {
    const bases = readdirSync(DB_BACKUP_DIR)
      .filter((n) => n.startsWith('registry.db.pre-') && !n.endsWith('-wal') && !n.endsWith('-shm'))
      .sort(); // ISO-timestamped names sort chronologically
    for (const name of bases.slice(0, Math.max(0, bases.length - KEEP_PREMIGRATION_BACKUPS))) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(path.join(DB_BACKUP_DIR, name + suffix), { force: true });
    }
  } catch {
    /* best-effort pruning */
  }
}

function maybeBackupBeforeMigration(): void {
  if (!existsSync(SESSIONS_DB) || statSync(SESSIONS_DB).size === 0) return; // fresh install — nothing to snapshot
  const current = getPackageVersion();
  let last = '';
  try {
    last = readFileSync(DB_VERSION_SIDECAR, 'utf8').trim();
  } catch {
    last = '';
  }
  if (last === current) return; // same version already booted — no upgrade migration expected
  try {
    mkdirSync(DB_BACKUP_DIR, { recursive: true });
    // Idempotent per version: if a backup for this target version already exists
    // (a prior boot, or a racing concurrent first-boot process just made one),
    // don't snapshot again.
    if (readdirSync(DB_BACKUP_DIR).some((n) => n.startsWith(`registry.db.pre-${current}-`))) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const from = last || 'preversioned';
    const dest = path.join(DB_BACKUP_DIR, `registry.db.pre-${current}-from-${from}-${stamp}`);
    // Copy the whole consistent set so a checkpoint-pending WAL rides with its base file.
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(SESSIONS_DB + suffix)) copyFileSync(SESSIONS_DB + suffix, dest + suffix);
    }
    logger.info(`Pre-migration session DB backup created: ${dest} (upgrade ${from} → ${current})`);
    prunePremigrationBackups();
  } catch (err) {
    // A backup failure must not block boot, but it must be loud.
    logger.warn(`Could not create pre-migration session DB backup: ${err instanceof Error ? err.message : err}`);
  }
}

function recordDbVersion(): void {
  try {
    writeFileSync(DB_VERSION_SIDECAR, getPackageVersion(), 'utf8');
  } catch {
    /* best-effort — sidecar only gates the backup, never correctness */
  }
}

/**
 * Read-only Todo preflight that tolerates a peer's concurrent first-boot migration.
 *
 * The preflight is deliberately read-only and runs before any lock, so several
 * gateway processes discovering the same fresh/upgraded home at once can have one
 * of them mid-migration while another probes. During that window the probe can
 * momentarily observe an inconsistent schema shape (e.g. an uncheckpointed WAL a
 * read-only connection can't fully resolve) and classify it as an unsupported
 * prerelease refusal even though the database is perfectly valid.
 *
 * That early refusal is NOT authoritative: {@link migrateWorkItemsSchema} re-runs
 * the SAME classification under `BEGIN IMMEDIATE` on the write connection — which
 * has full, consistent visibility — and refuses genuinely-unsupported data there,
 * rolling back without persisting any write. So on that specific refusal we retry
 * the read-only probe within a bounded budget: genuinely-unsupported data is stable
 * and keeps refusing (so we still refuse fast, before any write), while a racing
 * migration commits a valid schema within the window and a retry then succeeds.
 * Corruption/disk-space errors are not this refusal and propagate immediately.
 */
function preflightWorkItemsToleratingConcurrentInit(
  filename: string,
): WorkItemSchemaPreflight {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      return preflightWorkItemsDatabase(filename);
    } catch (error) {
      const isPrereleaseRefusal =
        error instanceof Error && error.message === UNSUPPORTED_PRERELEASE_TODO_DATA;
      if (!isPrereleaseRefusal || Date.now() >= deadline) throw error;
      // Synchronous sleep (initDb is sync) before re-reading a fresh snapshot.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Tables of the removed Activity ledger, dropped in dependency-free order. */
const ACTIVITY_LEDGER_TABLES = [
  'activity_event_search',
  'activity_story_versions',
  'activity_stories',
  'activity_events',
  'activity_ledger_meta',
] as const;

/**
 * Drop the Activity ledger left behind on homes that booted a version which
 * created it. No shipped code path ever appended to it, so those tables are
 * empty, and fresh homes never create them — this is a no-op there. SQLite
 * removes a table's indexes and triggers along with the table, so naming the
 * tables is enough. Idempotent; runs inside the boot migration transaction.
 *
 * If a home somehow does hold events, keep everything and say so loudly:
 * silently deleting operator data is never the right answer to a surprise.
 */
function dropActivityLedgerSchema(database: Database.Database): void {
  const lookup = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").pluck();
  const present = ACTIVITY_LEDGER_TABLES.filter((table) => lookup.get(table) !== undefined);
  if (present.length === 0) return;
  if (present.includes('activity_events')) {
    const rows = database.prepare('SELECT COUNT(*) FROM activity_events').pluck().get() as number;
    if (rows > 0) {
      logger.warn(
        `Refusing to drop the removed Activity ledger: activity_events holds ${rows} row(s). ` +
        `Leaving ${present.join(', ')} in place — drop them by hand once those rows are exported.`,
      );
      return;
    }
  }
  for (const table of present) database.exec(`DROP TABLE ${table}`);
}

export function initDb(): Database.Database {
  if (db) return db;
  // Fail fast on a near-full disk before any write — running out of space during
  // a migration is the classic corruption trigger.
  preflightSessionDiskSpace();
  // Todo classification is deliberately the first database operation. It opens
  // an existing file read-only and refuses unsupported prerelease data before
  // WAL mode, migrations, or any other schema write can occur.
  const todoPreflight = preflightWorkItemsToleratingConcurrentInit(SESSIONS_DB);
  // A v1 ledger is about to be rebuilt in place — keep a one-time pristine file
  // copy (plus WAL/SHM sidecars) beside it so the operator can always roll back.
  if (todoPreflight === 'v1') {
    const backup = `${SESSIONS_DB}${WORK_ITEMS_BACKUP_SUFFIX}`;
    if (!existsSync(backup)) {
      copyFileSync(SESSIONS_DB, backup);
      for (const suffix of ['-wal', '-shm'] as const) {
        if (existsSync(`${SESSIONS_DB}${suffix}`)) copyFileSync(`${SESSIONS_DB}${suffix}`, `${backup}${suffix}`);
      }
    }
  }
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  // Snapshot the existing DB before an upgrade migration mutates it (version-gated,
  // so this runs once per upgrade, never on a steady-state boot).
  maybeBackupBeforeMigration();
  const database = new Database(SESSIONS_DB);
  db = database;
  // Register the busy handler before WAL/DDL. Several gateway processes may
  // discover the same fresh or upgraded home concurrently; initialization is
  // serialized by SQLite instead of surfacing a transient SQLITE_BUSY.
  database.pragma('busy_timeout = 10000');
  runSqliteBusyRetry(() => database.pragma('journal_mode = WAL'));
  const initialize = database.transaction(() => {
    database.exec(CREATE_TABLE);
    database.exec(CREATE_MESSAGES_TABLE);
    database.exec(CREATE_MESSAGES_INDEX);
    database.exec(CREATE_META_TABLE);
    migrateMessagesSchema(database);
    database.exec(CREATE_MESSAGES_ORDER_INDEX);
    // Partial-message index needs the `partial` column, added by migrateMessagesSchema above.
    database.exec(CREATE_MESSAGES_PARTIAL_INDEX);
    migrateFtsSchema(database);
    // Pre-existing rows are intentionally NOT drained here. startGateway schedules
    // the chunked backfill after server.listen(), and searchMessages also schedules
    // it as a lazy fallback for non-gateway callers. The guarded AD/AU triggers above
    // keep writes safe while that one-time backfill is incomplete.
    migrateSessionsSchema(database);
    database.exec(CREATE_SESSION_KEY_INDEX);
    database.exec(CREATE_DELEGATION_IDEMPOTENCY_INDEX);
    database.exec(CREATE_LAST_ACTIVITY_INDEX);
    database.exec(CREATE_PARENT_INDEX);
    database.exec(CREATE_WORKFLOW_RUN_INDEX);
    database.exec(CREATE_STATUS_INDEX);
    // The next public release is the first Todo release: create the clean model
    // directly, or replace only a read-only-preflighted empty prerelease shape.
    migrateWorkItemsSchema(database, todoPreflight);
    database.exec(CREATE_WORK_ITEM_SESSION_INDEX);
    dropActivityLedgerSchema(database);
    database.exec(`
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        internal INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queue_session
        ON queue_items (session_key, status, position);
    `);
    migrateQueueItemsSchema(database);
    migrateCallbackDeliveriesSchema(database);
    database.exec(CREATE_FILES_TABLE);
    database.exec(CREATE_CHAT_PINS_TABLE);
  });
  try {
    runImmediateMigrationWithRetry(initialize);
    // Migration succeeded — stamp the version so the next boot at the same version
    // skips the pre-migration backup.
    recordDbVersion();
    return database;
  } catch (error) {
    database.close();
    db = undefined;
    throw error;
  }
}

/** Test-only restart seam: close the process singleton so the next initDb()
 * reopens the same sanitized home and reruns migrations. */
export function __closeDbForTest(): void {
  db?.close();
  db = undefined;
}

/**
 * Additive, nullable migration: add the `media` column to an existing messages
 * table. Safe to run repeatedly and on legacy DBs created before media support.
 */
export function migrateMessagesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('media')) {
    database.exec('ALTER TABLE messages ADD COLUMN media TEXT');
  }
  // Mid-turn streaming: `partial=1` rows are the live blocks (text segments + tool
  // calls) persisted DURING a turn so a refresh restores in-progress output. They
  // are deleted at turn end and replaced by the single consolidated final message
  // (same end-state as before). `seq` orders blocks within a turn (timestamp ms
  // collides across blocks); `tool_call` carries the tool name so a reloaded tool
  // block renders as a tool card, matching the live stream. All additive/nullable.
  if (!colNames.has('partial')) {
    database.exec('ALTER TABLE messages ADD COLUMN partial INTEGER');
  }
  if (!colNames.has('seq')) {
    database.exec('ALTER TABLE messages ADD COLUMN seq INTEGER');
  }
  if (!colNames.has('tool_call')) {
    database.exec('ALTER TABLE messages ADD COLUMN tool_call TEXT');
  }
  if (!colNames.has('tool_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN tool_id TEXT');
  }
  if (!colNames.has('blocks')) {
    database.exec('ALTER TABLE messages ADD COLUMN blocks TEXT');
  }
  if (!colNames.has('meta')) {
    database.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
  }
}

/** Additive migration for restart-safe system work. Internal queue rows use the
 * same durable ordering/replay machinery as user messages, but stay out of the
 * operator-facing queue panel and its cancel/clear controls. */
export function migrateQueueItemsSchema(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(queue_items)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'internal')) {
    database.exec('ALTER TABLE queue_items ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');
  }
}

function hasSessionDeliveryConstraints(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
  const canonicalColumns = [
    'target_session_id',
    'source_id',
    'source_attempt',
    'source_outcome',
    'delivery_kind',
  ];
  return canonicalColumns.every((column) =>
    normalized.includes(`length(${column}) > 0 and ${column} = jinn_callback_identity(${column})`),
  )
    && normalized.includes("source_kind in ('session', 'workflow-run')")
    && normalized.includes('source_version >= 1')
    && normalized.includes('json_valid(payload)')
    && normalized.includes("json_type(payload) = 'object'")
    && normalized.includes("json_type(payload, '$.message') is 'text'")
    && normalized.includes("json_type(payload, '$.displaymessage') is 'text'")
    && normalized.includes("status in ('pending', 'accepted', 'dead_letter')")
    && normalized.includes('attempt_count >= 0');
}

/** Install the callback outbox atomically. A malformed pre-existing table is
 * never silently indexed: validation throws inside the transaction so any DDL
 * from this migration is rolled back as one unit. */
export function migrateCallbackDeliveriesSchema(database: Database.Database): void {
  database.pragma('busy_timeout = 10000');
  database.function('jinn_callback_identity', { deterministic: true }, canonicalCallbackIdentityText);
  const migrate = database.transaction(() => {
    const existing = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'
    `).get() as { sql: string } | undefined;
    if (!existing) {
      database.exec(CREATE_CALLBACK_DELIVERIES_TABLE);
    } else {
      const columns = database.prepare('PRAGMA table_info(callback_deliveries)').all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      const legacyIdentity = [
        'parent_session_id',
        'child_session_id',
        'attempt_token',
        'terminal_outcome',
        'terminal_version',
        'callback_kind',
      ];
      const lifecycleRequired = [
        'id',
        'payload',
        'status',
        'message_id',
        'queue_item_id',
        'created_at',
        'accepted_at',
      ];
      const missingLifecycle = lifecycleRequired.filter((column) => !names.has(column));
      const hasLegacyIdentity = legacyIdentity.every((column) => names.has(column));
      const hasGenericIdentity = CALLBACK_DELIVERY_REQUIRED_COLUMNS.every((column) => names.has(column));
      if (missingLifecycle.length > 0 || (!hasLegacyIdentity && !hasGenericIdentity)) {
        throw new Error(`Incompatible callback_deliveries schema: missing ${missingLifecycle.join(', ') || 'delivery identity columns'}`);
      }
      if (hasLegacyIdentity || !hasSessionDeliveryConstraints(existing.sql)) {
        rebuildCallbackDeliveriesTable(database, names, hasLegacyIdentity ? 'legacy-session' : 'generic');
      }
    }
    const columns = database.prepare('PRAGMA table_info(callback_deliveries)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const missing = CALLBACK_DELIVERY_REQUIRED_COLUMNS.filter((column) => !names.has(column));
    if (missing.length > 0) {
      throw new Error(`Incompatible callback_deliveries schema: missing ${missing.join(', ')}`);
    }
    ensureCallbackDeliveryIndexes(database);
    const identityColumns = database.prepare('PRAGMA index_info(uq_callback_delivery_identity)').all() as Array<{ name: string }>;
    const expectedIdentity = [
      'target_session_id',
      'source_kind',
      'source_id',
      'source_attempt',
      'source_outcome',
      'source_version',
      'delivery_kind',
    ];
    if (identityColumns.map((column) => column.name).join('|') !== expectedIdentity.join('|')) {
      throw new Error('Incompatible callback delivery identity index');
    }
    const indexList = database.prepare('PRAGMA index_list(callback_deliveries)').all() as Array<{ name: string; unique: number }>;
    if (indexList.find((index) => index.name === 'uq_callback_delivery_identity')?.unique !== 1) {
      throw new Error('Incompatible callback delivery identity uniqueness');
    }
    const pendingColumns = database.prepare('PRAGMA index_info(idx_callback_deliveries_pending)').all() as Array<{ name: string }>;
    const pendingSql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_callback_deliveries_pending'
    `).get() as { sql: string } | undefined)?.sql.replace(/\s+/g, ' ').toLowerCase() ?? '';
    if (
      pendingColumns.map((column) => column.name).join('|') !== 'status|next_attempt_at|created_at'
      || !pendingSql.includes("where status = 'pending'")
    ) {
      throw new Error('Incompatible callback delivery pending index');
    }
    const installedSql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'
    `).get() as { sql: string }).sql;
    if (!hasSessionDeliveryConstraints(installedSql)) {
      throw new Error('Incompatible callback_deliveries constraints');
    }
  });
  runImmediateMigrationWithRetry(migrate);
}

function ensureCallbackDeliveryIndexes(database: Database.Database): void {
  const expectedIdentity = [
    'target_session_id',
    'source_kind',
    'source_id',
    'source_attempt',
    'source_outcome',
    'source_version',
    'delivery_kind',
  ];
  const indexes = database.prepare('PRAGMA index_list(callback_deliveries)').all() as Array<{ name: string; unique: number }>;
  const identity = indexes.find((index) => index.name === 'uq_callback_delivery_identity');
  const identityColumns = identity
    ? database.prepare('PRAGMA index_info(uq_callback_delivery_identity)').all() as Array<{ name: string }>
    : [];
  if (
    identity
    && (identity.unique !== 1 || identityColumns.map((column) => column.name).join('|') !== expectedIdentity.join('|'))
  ) {
    database.exec('DROP INDEX uq_callback_delivery_identity');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_callback_delivery_identity
      ON callback_deliveries (
        target_session_id,
        source_kind,
        source_id,
        source_attempt,
        source_outcome,
        source_version,
        delivery_kind
      )
  `);

  const refreshedIndexes = database.prepare('PRAGMA index_list(callback_deliveries)').all() as Array<{ name: string; unique: number }>;
  const pending = refreshedIndexes.find((index) => index.name === 'idx_callback_deliveries_pending');
  const pendingColumns = pending
    ? database.prepare('PRAGMA index_info(idx_callback_deliveries_pending)').all() as Array<{ name: string }>
    : [];
  const pendingSql = pending
    ? (database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_callback_deliveries_pending'
      `).get() as { sql: string } | undefined)?.sql.replace(/\s+/g, ' ').toLowerCase() ?? ''
    : '';
  if (
    pending
    && (
      pending.unique !== 0
      || pendingColumns.map((column) => column.name).join('|') !== 'status|next_attempt_at|created_at'
      || !pendingSql.includes("where status = 'pending'")
    )
  ) {
    database.exec('DROP INDEX idx_callback_deliveries_pending');
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_callback_deliveries_pending
      ON callback_deliveries (status, next_attempt_at, created_at)
      WHERE status = 'pending'
  `);
}

function runImmediateMigrationWithRetry<T>(migration: Database.Transaction<() => T>): T {
  return runSqliteBusyRetry(() => migration.immediate());
}

/** Error classes worth waiting out when several processes open one database.
 *
 *  SQLITE_BUSY is the obvious one. SQLITE_READONLY belongs here too, and only
 *  Windows shows why: `journal_mode = WAL` has to take a brief exclusive lock to
 *  rewrite the header, and when a peer holds the file at that instant SQLite
 *  reports "attempt to write a readonly database" rather than BUSY. Sixteen
 *  processes racing to initialize produced it roughly one run in five.
 *
 *  Retrying a database that is genuinely read-only — bad permissions, a
 *  read-only mount — costs the same bounded wait and then throws the identical
 *  error, so nothing is masked by including it. */
function isTransientSqliteError(code: string): boolean {
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_READONLY');
}

/** How long to keep retrying transient contention before giving up.
 *
 *  A time budget rather than an attempt count, because the thing being waited
 *  out is a window of contention whose length has nothing to do with how many
 *  times we have asked. The previous fixed ladder spent ~1.76s on Windows and
 *  then threw; sixteen processes initializing one database on a CI runner held
 *  the lock for longer than that, so the ladder ran out mid-race.
 *
 *  Matched to the `busy_timeout` already set on the connection: SQLite waits ten
 *  seconds for a BUSY lock, so waiting a comparable span for the same class of
 *  contention is consistent rather than arbitrary. Only ever reached on an error
 *  path — a database that is genuinely read-only pays this once at boot and then
 *  fails with the same message it would have before.
 *
 *  This raises a ceiling; it does not remove one. Instrumented at six times CI's
 *  concurrency the loop still exhausts the full budget and throws, because no
 *  bounded wait can be sufficient for unbounded contention. Serializing
 *  initialization across processes is the fix that would not have a ceiling, and
 *  it is a larger change than this one. */
const SQLITE_RETRY_BUDGET_MS = process.platform === 'win32' ? 15_000 : 5_000;

function runSqliteBusyRetry<T>(operation: () => T): T {
  // performance.now(), not Date.now(): this runs at process start and the sleep
  // below blocks the thread outright, so a backward wall-clock step during the
  // wait (w32time resyncing at boot, an NTP correction, a VM snapshot restore)
  // would extend a synchronous block by the size of the step, unbounded and
  // unlogged — the gateway would simply appear hung. A forward step would
  // silently truncate the budget instead. performance.now() is monotonic from
  // process start and immune to both.
  const deadline = performance.now() + SQLITE_RETRY_BUDGET_MS;
  let delayMs = 10;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      const remainingMs = deadline - performance.now();
      if (!isTransientSqliteError(code) || remainingMs <= 0) throw error;
      // Jittered exponential backoff. Without the jitter, peers that collided
      // once back off by the same amount and collide again on every subsequent
      // attempt, which is how a ladder that looks generous still exhausts itself.
      const jittered = delayMs * (0.5 + Math.random());
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(jittered, remainingMs)));
      delayMs = Math.min(delayMs * 2, 500);
    }
  }
}

function canonicalCallbackIdentityText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
    : '';
}

function rebuildCallbackDeliveriesTable(
  database: Database.Database,
  columns: Set<string>,
  shape: 'legacy-session' | 'generic',
): void {
  const rows = database.prepare('SELECT * FROM callback_deliveries ORDER BY created_at ASC, id ASC').all() as Array<Record<string, unknown>>;
  database.exec('DROP TABLE IF EXISTS callback_deliveries_v2');
  database.exec(callbackDeliveriesTableSql('callback_deliveries_v2'));
  const insert = database.prepare(`
    INSERT INTO callback_deliveries_v2 (
      id, target_session_id, source_kind, source_id, source_attempt, source_outcome,
      source_version, delivery_kind, payload, status, message_id, queue_item_id,
      attempt_count, next_attempt_at, last_attempt_at, last_error, dead_lettered_at,
      created_at, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : String(row.id ?? randomUUID());
    const targetSessionId = canonicalCallbackIdentityText(
      shape === 'legacy-session' ? row.parent_session_id : row.target_session_id,
    );
    const sourceKind = shape === 'legacy-session' ? 'session' : canonicalCallbackIdentityText(row.source_kind);
    const sourceId = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.child_session_id : row.source_id);
    const sourceAttempt = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.attempt_token : row.source_attempt);
    const sourceOutcome = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.terminal_outcome : row.source_outcome);
    const deliveryKind = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.callback_kind : row.delivery_kind);
    const sourceVersion = Number(shape === 'legacy-session' ? row.terminal_version : row.source_version);
    const candidate: SessionDeliveryRow = {
      id,
      targetSessionId,
      sourceKind: sourceKind as SessionDeliveryIdentity['sourceKind'],
      sourceId,
      sourceAttempt,
      sourceOutcome,
      sourceVersion,
      deliveryKind,
      payload: typeof row.payload === 'string' ? row.payload : '',
      status: row.status as SessionDelivery['status'],
      messageId: (row.message_id ?? null) as string | null,
      queueItemId: (row.queue_item_id ?? null) as string | null,
      attemptCount: columns.has('attempt_count') ? Number(row.attempt_count ?? 0) : 0,
      nextAttemptAt: (columns.has('next_attempt_at') ? row.next_attempt_at ?? null : null) as number | null,
      lastAttemptAt: (columns.has('last_attempt_at') ? row.last_attempt_at ?? null : null) as number | null,
      lastError: (columns.has('last_error') ? row.last_error ?? null : null) as string | null,
      deadLetteredAt: (columns.has('dead_lettered_at') ? row.dead_lettered_at ?? null : null) as number | null,
      createdAt: row.created_at as string,
      acceptedAt: (row.accepted_at ?? null) as string | null,
    };
    let persisted = candidate;
    try {
      sessionDeliveryFromRow(candidate);
    } catch (error) {
      persisted = quarantinedMigrationDelivery(candidate, error instanceof Error ? error.message : String(error));
    }
    let values = sessionDeliveryInsertValues(persisted);
    try {
      insert.run(...values);
    } catch (error) {
      if (!(error instanceof Error) || !/unique constraint/i.test(error.message)) throw error;
      persisted = quarantinedMigrationDelivery(candidate, 'duplicate canonical session delivery identity during migration');
      values = sessionDeliveryInsertValues(persisted);
      insert.run(...values);
    }
  }
  database.exec(`
    DROP TABLE callback_deliveries;
    ALTER TABLE callback_deliveries_v2 RENAME TO callback_deliveries;
  `);
}

function sessionDeliveryInsertValues(row: SessionDeliveryRow): unknown[] {
  return [
    row.id,
    row.targetSessionId,
    row.sourceKind,
    row.sourceId,
    row.sourceAttempt,
    row.sourceOutcome,
    row.sourceVersion,
    row.deliveryKind,
    row.payload,
    row.status,
    row.messageId,
    row.queueItemId,
    row.attemptCount,
    row.nextAttemptAt,
    row.lastAttemptAt,
    row.lastError,
    row.deadLetteredAt,
    row.createdAt,
    row.acceptedAt,
  ];
}

function quarantinedMigrationDelivery(row: SessionDeliveryRow, diagnostic: string): SessionDeliveryRow {
  const safeId = canonicalCallbackIdentityText(row.id) || randomUUID();
  return {
    id: row.id,
    targetSessionId: `quarantined-target:${safeId}`,
    sourceKind: 'session',
    sourceId: `quarantined-source:${safeId}`,
    sourceAttempt: `quarantined-attempt:${safeId}`,
    sourceOutcome: 'quarantined',
    sourceVersion: 1,
    deliveryKind: 'quarantined',
    payload: JSON.stringify({ message: '', displayMessage: '' }),
    status: 'dead_letter',
    messageId: null,
    queueItemId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastError: `migration quarantine: ${diagnostic}`,
    deadLetteredAt: Date.now(),
    createdAt: typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
      ? row.createdAt
      : new Date().toISOString(),
    acceptedAt: null,
  };
}

function getMeta(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function setMeta(database: Database.Database, key: string, value: string): void {
  database
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** Read a value from the generic key/value meta store (one-off progress flags /
 * watermarks). Returns null when the key was never written. */
export function getMetaValue(key: string): string | null {
  return getMeta(initDb(), key);
}

/** Upsert a value into the generic key/value meta store. Keep entries tiny. */
export function setMetaValue(key: string, value: string): void {
  setMeta(initDb(), key, value);
}

/**
 * Create the FTS5 search index + sync triggers, and record the backfill watermark.
 *
 * The triggers keep the index current for every message written from now on. Rows
 * that already existed before this table did are NOT seen by the triggers, so they
 * are seeded separately by the chunked backfill (`scheduleFtsBackfill`). To stop
 * the backfill from double-indexing rows the triggers also handle, we snapshot the
 * current MAX(rowid) here — synchronously, before any new insert can race in — and
 * the backfill only ever touches `rowid <= fts_backfill_max`. Anything above that
 * watermark is a brand-new row and belongs to the triggers.
 *
 * Idempotent: safe to run on every boot. On a DB where the backfill already
 * completed it is a no-op.
 */
export function migrateFtsSchema(database: Database.Database): void {
  database.exec(CREATE_META_TABLE);
  // Trigger definitions changed when the boot drain became asynchronous. Rebuild
  // them idempotently so upgraded databases get the guarded AD/AU behavior too;
  // CREATE TRIGGER IF NOT EXISTS alone would preserve the unsafe legacy bodies.
  database.exec(`
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
  `);
  database.exec(CREATE_FTS);
  // First time we see this DB and the backfill hasn't run: pin the watermark.
  if (getMeta(database, 'fts_backfill_done') !== '1' && getMeta(database, 'fts_backfill_max') === null) {
    const row = database.prepare('SELECT MAX(rowid) AS m FROM messages').get() as { m: number | null };
    setMeta(database, 'fts_backfill_max', String(row.m ?? 0));
    setMeta(database, 'fts_backfill_rowid', '0');
  }
}

const FTS_BACKFILL_CHUNK = 1000;

/**
 * Seed one chunk of pre-existing user/assistant rows into the FTS index, in a
 * single transaction. Resumable: progress is persisted in `meta.fts_backfill_rowid`
 * so a mid-backfill restart picks up where it left off. Returns true once there is
 * no more work (and stamps `fts_backfill_done`).
 */
function ftsBackfillStep(database: Database.Database, chunkSize = FTS_BACKFILL_CHUNK): boolean {
  if (getMeta(database, 'fts_backfill_done') === '1') return true;
  const max = Number(getMeta(database, 'fts_backfill_max') ?? '0');
  const progress = Number(getMeta(database, 'fts_backfill_rowid') ?? '0');
  if (progress >= max) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  const rows = database
    .prepare(
      `SELECT rowid, content FROM messages
       WHERE role IN ('user','assistant') AND rowid > ? AND rowid <= ?
       ORDER BY rowid ASC LIMIT ?`,
    )
    .all(progress, max, chunkSize) as Array<{ rowid: number; content: string }>;
  if (rows.length === 0) {
    // No indexable rows left in (progress, max] — we're done.
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  const insert = database.prepare('INSERT INTO messages_fts(rowid, content) VALUES (?, ?)');
  const txn = database.transaction((items: Array<{ rowid: number; content: string }>) => {
    for (const r of items) insert.run(r.rowid, r.content);
  });
  txn(rows);
  const lastRowid = rows[rows.length - 1].rowid;
  setMeta(database, 'fts_backfill_rowid', String(lastRowid));
  if (lastRowid >= max) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  return false;
}

/**
 * Run the FTS backfill to completion synchronously. Exposed for tests and for
 * callers that genuinely want to block; the request path uses
 * `scheduleFtsBackfill` (which yields between chunks) instead.
 */
export function backfillFtsSync(database: Database.Database, chunkSize = FTS_BACKFILL_CHUNK): void {
  while (!ftsBackfillStep(database, chunkSize)) {
    /* keep draining chunks */
  }
}

// Set to false when the FTS boot drain fails. `searchMessages` checks this first so it
// returns [] immediately without touching a broken or absent table.
let ftsAvailable = true;

/**
 * Drop all FTS infrastructure from `database` and reset the backfill progress flags so
 * the NEXT boot retries the migration + backfill from scratch. Sets `ftsAvailable =
 * false` for the lifetime of this process so that `searchMessages` returns [] without
 * hitting the (now-absent) table.
 *
 * Called automatically by `initDb()` when the boot drain throws. Also exported as a
 * seam for tests and for callers that want to explicitly disable FTS (e.g. on detecting
 * external corruption).
 */
export function disableFtsForProcess(database: Database.Database, reason?: unknown): void {
  const msg = reason instanceof Error ? reason.message : reason != null ? String(reason) : 'explicit disable';
  console.error(`[fts] Boot drain failed (${msg}). Disabling FTS for this process — next boot will retry.`);
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TABLE IF EXISTS messages_fts;
    `);
  } catch (dropErr) {
    console.error(`[fts] Failed to drop FTS infrastructure during disable: ${dropErr instanceof Error ? dropErr.message : dropErr}`);
  }
  try {
    database.prepare("DELETE FROM meta WHERE key IN ('fts_backfill_done','fts_backfill_rowid','fts_backfill_max')").run();
  } catch {
    // meta table may not exist in edge cases — not a fatal error
  }
  ftsAvailable = false;
}

const ftsBackfillPromises = new WeakMap<Database.Database, Promise<void>>();

/**
 * Kick the one-time FTS backfill off the hot path. startGateway calls this only
 * after listen(); searchMessages calls it as a lazy fallback for library/test
 * consumers. Guarded by the persistent `fts_backfill_done` flag and a per-DB
 * in-process promise so concurrent callers share one drain. Each chunk is its own
 * transaction with a `setImmediate` yield in between, so a large historical table
 * is seeded without blocking the event loop.
 */
export function scheduleFtsBackfill(
  database: Database.Database = initDb(),
  chunkSize = FTS_BACKFILL_CHUNK,
): Promise<void> {
  if (!ftsAvailable || getMeta(database, 'fts_backfill_done') === '1') return Promise.resolve();
  const existing = ftsBackfillPromises.get(database);
  if (existing) return existing;

  const completion = new Promise<void>((resolve) => {
    const pump = (): void => {
      try {
        if (ftsBackfillStep(database, chunkSize)) {
          ftsBackfillPromises.delete(database);
          resolve();
          return;
        }
        setImmediate(pump);
      } catch (err) {
        logger.warn(`FTS backfill failed: ${err instanceof Error ? err.message : err}`);
        disableFtsForProcess(database, err);
        ftsBackfillPromises.delete(database);
        resolve();
      }
    };
    setImmediate(pump);
  });
  ftsBackfillPromises.set(database, completion);
  return completion;
}

export interface MessageSearchResult {
  /** Anchor for getMessageContext — the matched message's id. */
  messageId: string;
  sessionId: string;
  snippet: string;
  role: string;
  timestamp: number;
  /** Owning session's employee/engine (null when the session row is gone). */
  employee: string | null;
  engine: string | null;
}

/** Replace NUL and other non-printing control bytes with spaces (GRS-020a-fix
 *  finding 2). Shared by the FTS sanitizer and the search routes so hostile
 *  encoded input (%00 etc.) yields a normal result everywhere, never a 500. */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** True if the string carries a NUL or other non-printing control byte. The
 *  REJECT-don't-strip gate for security-critical PATH params (GRS-020b-fix):
 *  {@link stripControlChars} would silently REPAIR a `%00`-tampered path into a
 *  valid one, so the knowledge read surface rejects on the raw param instead. */
export function hasControlBytes(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** Deterministic AND-composed narrowing for searchMessages (GRS-020a). All
 *  values become bound SQL parameters — never spliced into the statement. */
export interface MessageSearchFilter {
  sessionId?: string;
  /** Exclude one session's messages (GRS-020a-fix finding 1: the MCP tool
   *  passes the caller's own session here by default, so "search for X" never
   *  returns the caller's own act of searching for X). */
  excludeSessionId?: string;
  /** Case-insensitive equality on the owning session's employee. */
  employee?: string;
  /** Case-insensitive equality on the owning session's engine. */
  engine?: string;
  role?: 'user' | 'assistant';
  /** Inclusive epoch-ms bounds on the message timestamp. */
  since?: number;
  until?: number;
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. NUL and other
 * control bytes are stripped first (GRS-020a-fix finding 2: an embedded NUL
 * inside a quoted FTS5 phrase throws "unterminated string" — hostile input must
 * yield a normal result, never an error). Then each whitespace token becomes a
 * double-quoted phrase (any embedded `"` stripped), so FTS5 operators (`*`, `(`,
 * `)`, `-`, `NEAR`, `"`) are treated as literal text and can never throw a
 * syntax error. Space-separated phrases AND together implicitly, so a
 * multi-word query requires all words. Returns '' when nothing indexable remains.
 */
function sanitizeFtsQuery(query: string): string {
  return stripControlChars(query)
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, ''))
    .filter(Boolean)
    .map((tok) => `"${tok}"`)
    .join(' ');
}

/**
 * Full-text search over user/assistant message bodies, newest-first. `snippet`
 * wraps matched terms in «»; results are capped by `limit` (default 50). Triggers
 * the one-time backfill on first call so older history becomes searchable.
 *
 * GRS-020a: optional AND-composed filters, every value a bound parameter. The
 * sessions join is a LEFT JOIN so an orphan message (invariant breach — deleteSession
 * removes both) still surfaces when no session-field filter is passed; an
 * employee/engine equality predicate on a NULL join simply never matches, which is
 * the correct narrowing semantics.
 */
export function searchMessages(query: string, limit = 50, filter?: MessageSearchFilter): MessageSearchResult[] {
  const db = initDb();
  if (!ftsAvailable) return [];
  void scheduleFtsBackfill(db);
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const cap = Math.max(1, Math.min(Math.floor(limit) || 50, 200));
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter?.sessionId) {
    conditions.push('m.session_id = ?');
    values.push(filter.sessionId);
  }
  if (filter?.excludeSessionId) {
    conditions.push('m.session_id != ?');
    values.push(filter.excludeSessionId);
  }
  if (filter?.role) {
    conditions.push('m.role = ?');
    values.push(filter.role);
  }
  if (typeof filter?.since === 'number') {
    conditions.push('m.timestamp >= ?');
    values.push(filter.since);
  }
  if (typeof filter?.until === 'number') {
    conditions.push('m.timestamp <= ?');
    values.push(filter.until);
  }
  if (filter?.employee) {
    conditions.push('LOWER(s.employee) = ?');
    values.push(filter.employee.toLowerCase());
  }
  if (filter?.engine) {
    conditions.push('LOWER(s.engine) = ?');
    values.push(filter.engine.toLowerCase());
  }
  const extra = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  try {
    return db
      .prepare(
        `SELECT m.id AS messageId,
                m.session_id AS sessionId,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
                m.role AS role,
                m.timestamp AS timestamp,
                s.employee AS employee,
                s.engine AS engine
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         LEFT JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ?${extra}
         ORDER BY m.timestamp DESC
         LIMIT ?`,
      )
      .all(match, ...values, cap) as MessageSearchResult[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such table')) return [];
    throw err;
  }
}

export function migrateSessionsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['title', 'TEXT'],
    ['parent_session_id', 'TEXT'],
    ['workflow_kind', 'TEXT'],
    ['workflow_id', 'TEXT'],
    ['workflow_name', 'TEXT'],
    ['workflow_run_id', 'TEXT'],
    ['workflow_trigger_source', 'TEXT'],
    ['workflow_phase_node_id', 'TEXT'],
    ['workflow_phase_name', 'TEXT'],
    ['workflow_phase_index', 'INTEGER'],
    ['workflow_phase_round', 'INTEGER'],
    ['workflow_phase_attempt', 'INTEGER'],
    ['connector', 'TEXT'],
    ['session_key', 'TEXT'],
    ['reply_context', 'TEXT'],
    ['message_id', 'TEXT'],
    ['transport_meta', 'TEXT'],
    ['engine_sessions', 'TEXT'],
    ['total_cost', 'REAL', '0'],
    ['total_turns', 'INTEGER', '0'],
    ['effort_level', 'TEXT'],
    ['last_context_tokens', 'INTEGER'],
    ['user_id', 'TEXT'],
    // No backfill: pre-existing sessions stay NULL (no excerpt); only new sessions populate it.
    ['prompt_excerpt', 'TEXT'],
    // Work-item link (GRS-002). Nullable; NULL = unchanged legacy behavior. The
    // partial index idx_sessions_work_item is created in initDb.
    ['work_item_id', 'TEXT'],
    // Explicit latest-attempt receipt. NULL means no successful/failed terminal
    // engine result has been recorded; `idle` by itself is not completion proof.
    ['attempt_outcome', 'TEXT'],
    // Per-dispatch generation used for compare-and-set terminal writes.
    ['attempt_token', 'TEXT'],
    ['attempt_terminal_version', 'INTEGER NOT NULL', '0'],
    ['attempt_turn', 'INTEGER NOT NULL', '0'],
    ['attempt_interruption_cause', 'TEXT'],
    ['attempt_interruption_turn', 'INTEGER'],
    // Archive is reversible: retain the durable chat and only hide it from
    // normal list queries. NULL keeps all pre-existing sessions visible.
    ['archived_at', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  const refreshedCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const refreshedNames = new Set(refreshedCols.map((c) => c.name));
  if (refreshedNames.has('session_key')) {
    database.exec(`UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = ''`);
  }
  if (refreshedNames.has('connector')) {
    database.exec(`UPDATE sessions SET connector = COALESCE(connector, source) WHERE connector IS NULL OR connector = ''`);
  }
}

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  connector?: string | null;
  sessionKey?: string;
  replyContext?: ReplyContext | null;
  messageId?: string;
  transportMeta?: JsonObject | null;
  employee?: string | null;
  model?: string;
  title?: string;
  parentSessionId?: string;
  workflowProvenance?: WorkflowSessionProvenance | null;
  userId?: string | null;
  effortLevel?: string;
  /**
   * Optional human-facing excerpt override. When the prompt is scaffolded
   * (e.g. talk delegation wraps the operator's ask in a brief + verbatim
   * block), callers pass the original ask here so list UIs don't show
   * scaffold junk. Still flattened/truncated via promptExcerptOf.
   */
  promptExcerpt?: string;
}

function getNextSessionNumber(): number {
  const db = initDb();
  // MAX(rowid) is an O(1) b-tree seek (COUNT(*) walks the whole table) and keeps
  // numbers monotonic even after deletions.
  const row = db.prepare('SELECT MAX(rowid) as maxRowid FROM sessions').get() as { maxRowid: number | null };
  return (row.maxRowid ?? 0) + 1;
}

function generateTitle(prompt?: string): string {
  const num = getNextSessionNumber();
  if (!prompt) return `#${num}`;
  const cleaned = prompt.replace(/\n/g, ' ').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `#${num}`;
  const summary = cleaned.slice(0, 30).trim();
  return `#${num} - ${summary}${cleaned.length > 30 ? '...' : ''}`;
}

/** Whitespace-flattened, ≤140-char excerpt of a prompt (undefined when empty). */
export function promptExcerptOf(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 140 ? flat.slice(0, 139).trimEnd() + '…' : flat;
}

export function createSession(opts: CreateSessionOpts & { prompt?: string; portalName?: string }): Session {
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const title = opts.title ?? generateTitle(opts.prompt);
  const promptExcerpt = promptExcerptOf(opts.promptExcerpt) ?? promptExcerptOf(opts.prompt) ?? null;
  const sessionKey = opts.sessionKey ?? opts.sourceRef;
  const connector = opts.connector ?? opts.source;
  const replyContext = opts.replyContext ? JSON.stringify(opts.replyContext) : null;
  const transportMeta = opts.transportMeta ? JSON.stringify(opts.transportMeta) : null;
  const workflow = opts.workflowProvenance ?? null;
  const phase = workflow?.kind === 'phase' ? workflow.phase : undefined;

  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, model, title, prompt_excerpt, parent_session_id,
      workflow_kind, workflow_id, workflow_name, workflow_run_id, workflow_trigger_source,
      workflow_phase_node_id, workflow_phase_name, workflow_phase_index, workflow_phase_round, workflow_phase_attempt,
      user_id, effort_level, status, created_at, last_activity
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, 'idle', ?, ?
    )
  `);
  stmt.run(
    id,
    opts.engine,
    opts.source,
    opts.sourceRef,
    connector,
    sessionKey,
    replyContext,
    opts.messageId ?? null,
    transportMeta,
    opts.employee ?? null,
    opts.model ?? null,
    title,
    promptExcerpt,
    opts.parentSessionId ?? null,
    workflow?.kind ?? null,
    workflow?.workflowId ?? null,
    workflow?.workflowName ?? null,
    workflow?.runId ?? null,
    workflow?.triggerSource ?? null,
    phase?.nodeId ?? null,
    phase?.name ?? null,
    phase?.index ?? null,
    phase?.round ?? null,
    phase?.attempt ?? null,
    opts.userId ?? null,
    opts.effortLevel ?? null,
    now,
    now,
  );

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    engineSessions: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    connector,
    sessionKey,
    workItemId: null,
    replyContext: opts.replyContext ?? null,
    messageId: opts.messageId ?? null,
    transportMeta: opts.transportMeta ?? null,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    title,
    promptExcerpt,
    archivedAt: null,
    parentSessionId: opts.parentSessionId ?? null,
    workflowProvenance: workflow,
    userId: opts.userId ?? null,
    effortLevel: opts.effortLevel ?? null,
    status: 'idle',
    attemptOutcome: null,
    attemptToken: null,
    attemptTerminalVersion: 0,
    attemptTurn: 0,
    attemptInterruptionCause: null,
    attemptInterruptionTurn: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: now,
    lastActivity: now,
    lastError: null,
  };
}

type WorkflowAttemptSessionOpts = CreateSessionOpts & { prompt?: string; workflowProvenance: WorkflowSessionProvenance };
function assertWorkflowAttemptSession(session: Session, opts: WorkflowAttemptSessionOpts, key: string): void {
  const expected = opts.workflowProvenance; const actual = session.workflowProvenance; const sameOwner = expected.kind === 'phase' && expected.phase && actual?.kind === 'phase' && actual.phase
    && actual.workflowId === expected.workflowId && actual.runId === expected.runId && actual.phase.nodeId === expected.phase.nodeId && actual.phase.attempt === expected.phase.attempt;
  if (!sameOwner) throw new Error(`Workflow attempt session key collision for ${key}.`);
  if (session.sessionKey !== key || session.sourceRef !== key) throw new Error(`Workflow attempt session key mismatch for ${key}.`);
  if ([session.engine, session.employee, session.model, session.effortLevel].some((value, index) => value !== [opts.engine, opts.employee ?? null, opts.model ?? null, opts.effortLevel ?? null][index])) throw new Error(`Workflow attempt session configuration mismatch for ${key}.`);
}
export function getOrCreateWorkflowAttemptSession(opts: WorkflowAttemptSessionOpts): Session {
  const database = initDb(); const workflow = opts.workflowProvenance; const phase = workflow.kind === 'phase' ? workflow.phase : undefined; if (!phase) throw new Error('Workflow attempt sessions require phase provenance.');
  const key = opts.sessionKey ?? opts.sourceRef;
  const getOrCreate = database.transaction(() => {
    const rows = database.prepare(`SELECT * FROM sessions WHERE session_key = ? OR (workflow_kind = 'phase' AND workflow_id = ? AND workflow_run_id = ? AND workflow_phase_node_id = ? AND workflow_phase_attempt = ?)`).all(key, workflow.workflowId, workflow.runId, phase.nodeId, phase.attempt) as Record<string, unknown>[];
    if (rows.length > 1) throw new Error(`Workflow attempt session key collision for ${key}.`); const existing = rows[0] ? rowToSession(rows[0]) : undefined;
    if (!existing) return createSession(opts); assertWorkflowAttemptSession(existing, opts, key); return existing; });
  return getOrCreate.immediate();
}
export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  return getSessionBySessionKey(sourceRef);
}

export function getSessionBySessionKey(sessionKey: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export interface UpdateSessionFields {
  sessionKey?: string;
  engine?: string;
  engineSessionId?: string | null;
  engineSessions?: EngineSessionRefs | null;
  status?: Session['status'];
  attemptOutcome?: SessionAttemptOutcome | null;
  attemptToken?: string | null;
  attemptTerminalVersion?: number;
  attemptTurn?: number;
  attemptInterruptionCause?: WorkflowAttemptInterruptionCause | null;
  attemptInterruptionTurn?: number | null;
  model?: string | null;
  effortLevel?: string | null;
  lastContextTokens?: number | null;
  replyContext?: ReplyContext | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  lastActivity?: string;
  lastError?: string | null;
  title?: string;
  archivedAt?: string | null;
  userId?: string | null;
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.sessionKey !== undefined) {
    sets.push('session_key = ?');
    values.push(updates.sessionKey);
  }

  if (updates.engine !== undefined) {
    sets.push('engine = ?');
    values.push(updates.engine);
  }
  if (updates.engineSessionId !== undefined) {
    sets.push('engine_session_id = ?');
    values.push(updates.engineSessionId);
  }
  if (updates.engineSessions !== undefined) {
    sets.push('engine_sessions = ?');
    const cleaned = cleanEngineSessionRefs(updates.engineSessions);
    values.push(cleaned ? JSON.stringify(cleaned) : null);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.attemptOutcome !== undefined) {
    sets.push('attempt_outcome = ?');
    values.push(updates.attemptOutcome);
  } else if (updates.status === 'running' || updates.status === 'waiting') {
    sets.push('attempt_outcome = NULL');
  } else if (updates.status === 'error') {
    sets.push("attempt_outcome = 'failed'");
  } else if (updates.status === 'interrupted') {
    sets.push("attempt_outcome = 'interrupted'");
  }
  if (updates.attemptToken !== undefined) {
    sets.push('attempt_token = ?');
    values.push(updates.attemptToken);
  }
  if (updates.attemptTerminalVersion !== undefined) {
    sets.push('attempt_terminal_version = ?');
    values.push(updates.attemptTerminalVersion);
  } else if (
    (updates.attemptOutcome !== undefined && updates.attemptOutcome !== null)
    || (updates.attemptOutcome === undefined && (updates.status === 'error' || updates.status === 'interrupted'))
  ) {
    sets.push('attempt_terminal_version = attempt_terminal_version + 1');
  }
  if (updates.attemptTurn !== undefined) {
    sets.push('attempt_turn = ?');
    values.push(updates.attemptTurn);
  } else if (
    (updates.attemptOutcome !== undefined && updates.attemptOutcome !== null)
    || (updates.attemptOutcome === undefined && (updates.status === 'error' || updates.status === 'interrupted'))
  ) {
    sets.push('attempt_turn = attempt_turn + 1');
  }
  if (updates.attemptInterruptionCause !== undefined) {
    sets.push('attempt_interruption_cause = ?');
    values.push(updates.attemptInterruptionCause);
  }
  if (updates.attemptInterruptionTurn !== undefined) {
    sets.push('attempt_interruption_turn = ?');
    values.push(updates.attemptInterruptionTurn);
  }
  if (updates.model !== undefined) {
    sets.push('model = ?');
    values.push(updates.model);
  }
  if (updates.effortLevel !== undefined) {
    sets.push('effort_level = ?');
    values.push(updates.effortLevel);
  }
  if (updates.lastContextTokens !== undefined) {
    sets.push('last_context_tokens = ?');
    values.push(updates.lastContextTokens);
  }
  if (updates.replyContext !== undefined) {
    sets.push('reply_context = ?');
    values.push(updates.replyContext ? JSON.stringify(updates.replyContext) : null);
  }
  if (updates.messageId !== undefined) {
    sets.push('message_id = ?');
    values.push(updates.messageId);
  }
  if (updates.transportMeta !== undefined) {
    sets.push('transport_meta = ?');
    values.push(updates.transportMeta ? JSON.stringify(updates.transportMeta) : null);
  }
  if (updates.lastActivity !== undefined) {
    sets.push('last_activity = ?');
    values.push(updates.lastActivity);
  }
  if (updates.lastError !== undefined) {
    sets.push('last_error = ?');
    values.push(updates.lastError);
  }
  if (updates.title !== undefined) {
    sets.push('title = ?');
    values.push(updates.title);
  }
  if (updates.archivedAt !== undefined) {
    sets.push('archived_at = ?');
    values.push(updates.archivedAt);
  }
  if (updates.userId !== undefined) {
    sets.push('user_id = ?');
    values.push(updates.userId);
  }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

/** Hide a chat from normal lists without deleting its session, messages, or
 * engine state. Repeated archive requests preserve the original timestamp. */
export function archiveSession(id: string): Session | undefined {
  const db = initDb();
  db.prepare('UPDATE sessions SET archived_at = COALESCE(archived_at, ?) WHERE id = ?')
    .run(new Date().toISOString(), id);
  return getSession(id);
}

/** Restore an archived chat to every normal session list. */
export function unarchiveSession(id: string): Session | undefined {
  const db = initDb();
  db.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(id);
  return getSession(id);
}

/**
 * Atomically claim the single delegation-completion nudge for a work item.
 * The JSON guard and its compare predicate live in one SQLite UPDATE so two
 * duplicate idle callbacks cannot both observe an empty guard and both win.
 */
export function claimDelegationCompletionNudge(id: string, workItemId: string): Session | undefined {
  const db = initDb();
  const todoId = parseTodoId(workItemId);
  const result = db.prepare(`
    UPDATE sessions
    SET transport_meta = json_set(
      COALESCE(transport_meta, '{}'),
      '$.delegationCompletionContract',
      json_object('workItemId', ?, 'state', 'nudged')
    )
    WHERE id = ?
      AND (
        json_extract(transport_meta, '$.delegationCompletionContract.workItemId') IS NULL
        OR json_extract(transport_meta, '$.delegationCompletionContract.workItemId') <> ?
      )
  `).run(todoId, id, todoId);
  return result.changes === 1 ? getSession(id) : undefined;
}

/** Atomically consume a previously claimed nudge before surfacing to parent. */
export function markDelegationCompletionSurfaced(id: string, workItemId: string): Session | undefined {
  const db = initDb();
  const todoId = parseTodoId(workItemId);
  const result = db.prepare(`
    UPDATE sessions
    SET transport_meta = json_set(
      COALESCE(transport_meta, '{}'),
      '$.delegationCompletionContract.state',
      'surfaced'
    )
    WHERE id = ?
      AND json_extract(transport_meta, '$.delegationCompletionContract.workItemId') = ?
      AND json_extract(transport_meta, '$.delegationCompletionContract.state') = 'nudged'
  `).run(id, todoId);
  return result.changes === 1 ? getSession(id) : undefined;
}

/** Release only the nudge this caller owns; never erase a later surfaced state. */
export function releaseDelegationCompletionNudge(id: string, workItemId: string): Session | undefined {
  const db = initDb();
  const todoId = parseTodoId(workItemId);
  const result = db.prepare(`
    UPDATE sessions
    SET transport_meta = json_remove(transport_meta, '$.delegationCompletionContract')
    WHERE id = ?
      AND json_extract(transport_meta, '$.delegationCompletionContract.workItemId') = ?
      AND json_extract(transport_meta, '$.delegationCompletionContract.state') = 'nudged'
  `).run(id, todoId);
  return result.changes === 1 ? getSession(id) : undefined;
}

/**
 * Atomically clear only the guard observed by the caller. A newer work-item
 * claim wins over a stale operator-cycle reset, and unrelated live metadata is
 * preserved because json_remove executes against the current row.
 */
export function clearDelegationCompletionGuard(id: string, expectedWorkItemId: string): Session | undefined {
  const db = initDb();
  const todoId = parseTodoId(expectedWorkItemId);
  const result = db.prepare(`
    UPDATE sessions
    SET transport_meta = json_remove(transport_meta, '$.delegationCompletionContract')
    WHERE id = ?
      AND json_extract(transport_meta, '$.delegationCompletionContract.workItemId') = ?
  `).run(id, todoId);
  return result.changes === 1 ? getSession(id) : undefined;
}

/**
 * Record that a child explicitly reported UP to its parent via send_to_session
 * during its current attempt. The automatic parent-completion callback for that
 * same attempt is a duplicate of the explicit relay, so notifyParentSession
 * suppresses it when this marker matches the child's live attempt token. The
 * marker is per-attempt: a new turn mints a new token, so it self-expires.
 */
export function recordChildReportedToParent(id: string, attemptToken: string): void {
  const db = initDb();
  db.prepare(`
    UPDATE sessions
    SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.reportedToParentAttempt', ?)
    WHERE id = ?
  `).run(attemptToken, id);
}

/** Persisted nudge claims whose queue post may have been lost to a restart. */
export function listDelegationCompletionNudgedSessions(): Session[] {
  const db = initDb();
  const rows = db.prepare(`
    SELECT s.* FROM sessions s
    WHERE json_extract(s.transport_meta, '$.delegationCompletionContract.state') = 'nudged'
      AND NOT EXISTS (
        SELECT 1 FROM queue_items q
        WHERE q.session_id = s.id
          AND q.internal = 1
          AND q.status IN ('pending', 'running')
      )
      AND NOT EXISTS (
      SELECT 1 FROM callback_deliveries d
        WHERE d.target_session_id = s.id
          AND d.source_kind = 'session'
          AND d.source_id = s.id
          AND d.source_attempt = s.attempt_token
          AND d.delivery_kind = 'delegation-completion-nudge'
          AND d.status IN ('pending', 'accepted')
      )
  `).all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Start a new execution generation and make it the sole owner of terminal
 * writes for this session. The token is durable so stop/reset wins across
 * asynchronous engine completion and process boundaries. */
export function beginSessionAttempt(id: string, updates: UpdateSessionFields = {}): Session | undefined {
  return updateSession(id, {
    ...updates,
    status: 'running',
    attemptOutcome: null,
    attemptToken: uuidv4(),
    attemptTerminalVersion: 0,
  });
}

/** Compare-and-set an update against the active attempt generation and state.
 * Returns undefined when a stop/reset/newer turn has taken ownership. */
export function updateSessionForAttempt(
  id: string,
  attemptToken: string,
  updates: UpdateSessionFields,
  expectedStatuses: readonly Session['status'][] = ['running'],
): Session | undefined {
  if (expectedStatuses.length === 0) return undefined;
  const database = initDb();
  const before = getSession(id);
  if (!before || before.attemptToken !== attemptToken || !expectedStatuses.includes(before.status)) return undefined;

  const tx = database.transaction(() => {
    const current = database
      .prepare('SELECT status, attempt_token FROM sessions WHERE id = ?')
      .get(id) as { status: Session['status']; attempt_token: string | null } | undefined;
    if (!current || current.attempt_token !== attemptToken || !expectedStatuses.includes(current.status)) return undefined;
    return updateSession(id, updates);
  });
  return tx();
}

/** Terminal attempt receipt. Only the same generation while actively running
 * may settle; an interrupted row is therefore immutable to late success. */
export function completeSessionAttempt(
  id: string,
  attemptToken: string,
  updates: UpdateSessionFields,
): Session | undefined {
  return updateSessionForAttempt(id, attemptToken, updates, ['running']);
}

export function interruptSessionAttempt(id: string, reason: string, completedAt: string): Session | undefined {
  // The explicit stop owns this turn: clear any same-turn user-message marker in
  // the same statement, or a crash before the completion listener would let
  // recovery reclassify the stop as a user interruption.
  const result = initDb().prepare(`UPDATE sessions SET status = 'interrupted', attempt_outcome = 'interrupted',
    attempt_terminal_version = 1, attempt_turn = attempt_turn + 1, last_activity = ?, last_error = ?,
    attempt_interruption_cause = NULL, attempt_interruption_turn = NULL
    WHERE id = ? AND workflow_kind = 'phase' AND attempt_outcome IS NULL AND attempt_terminal_version = 0`)
    .run(completedAt, reason, id);
  return result.changes === 1 ? getSession(id) : undefined;
}
/** Upgrade a legacy terminal row that predates attempt tokens. The outcome and
 * terminal version are compare predicates, so a stale callback can never borrow
 * the token of a newer resume generation. */
export function ensureCallbackAttemptToken(
  id: string,
  expectedOutcome: string,
  expectedTerminalVersion: number,
): string | undefined {
  const database = initDb();
  const ensure = database.transaction(() => {
    const current = database.prepare(`
      SELECT attempt_token, attempt_outcome, attempt_terminal_version
      FROM sessions
      WHERE id = ?
    `).get(id) as {
      attempt_token: string | null;
      attempt_outcome: string | null;
      attempt_terminal_version: number;
    } | undefined;
    if (!current || current.attempt_outcome !== expectedOutcome) return undefined;
    const upgradesLegacyVersion =
      !current.attempt_token
      && current.attempt_terminal_version === 0
      && expectedTerminalVersion === 1;
    if (current.attempt_terminal_version !== expectedTerminalVersion && !upgradesLegacyVersion) return undefined;
    if (current.attempt_token) return current.attempt_token;
    const token = uuidv4();
    const result = database.prepare(`
      UPDATE sessions
      SET attempt_token = ?, attempt_terminal_version = ?
      WHERE id = ?
        AND attempt_token IS NULL
        AND attempt_outcome = ?
        AND attempt_terminal_version = ?
    `).run(token, expectedTerminalVersion, id, expectedOutcome, current.attempt_terminal_version);
    if (result.changes === 1) return token;
    const winner = database.prepare('SELECT attempt_token FROM sessions WHERE id = ?').get(id) as { attempt_token: string | null } | undefined;
    return winner?.attempt_token ?? undefined;
  });
  return ensure();
}

export function getEngineSessionRef(session: Session, engine = session.engine): EngineSessionRef {
  const stored = cleanEngineSessionRef(session.engineSessions?.[engine] ?? {});
  if (engine === session.engine) {
    if (!stored.id && session.engineSessionId) stored.id = session.engineSessionId;
    if (!stored.model && session.model) stored.model = session.model;
    if (!stored.effortLevel && session.effortLevel) stored.effortLevel = session.effortLevel;
  }
  return stored;
}

export function recordEngineSessionId(
  sessionId: string,
  engine: string,
  nativeId: string,
  meta: Omit<EngineSessionRef, 'id'> = {},
): Session | undefined {
  const session = getSession(sessionId);
  const id = nativeId.trim();
  if (!session || !engine || !id) return session;

  const refs = cleanEngineSessionRefs(session.engineSessions) ?? {};
  const existing = getEngineSessionRef(session, engine);
  const next = cleanEngineSessionRef({
    ...existing,
    ...meta,
    id,
  });
  refs[engine] = next;

  const updates: UpdateSessionFields = { engineSessions: refs };
  if (session.engine === engine) {
    updates.engineSessionId = next.id ?? null;
  }
  return updateSession(sessionId, updates);
}

export interface SwitchSessionEngineOptions {
  model?: string | null;
  effortLevel?: string | null;
}

export function switchSessionEngine(
  sessionId: string,
  nextEngine: string,
  opts: SwitchSessionEngineOptions = {},
): Session | undefined {
  const session = getSession(sessionId);
  if (!session || !nextEngine) return session;

  const refs = cleanEngineSessionRefs(session.engineSessions) ?? {};
  if (session.engine) {
    const currentRef = getEngineSessionRef(session, session.engine);
    const current = cleanEngineSessionRef({
      ...currentRef,
      id: session.engineSessionId ?? currentRef.id,
      model: session.model ?? currentRef.model,
      effortLevel: session.effortLevel ?? currentRef.effortLevel,
    });
    if (Object.keys(current).length > 0) refs[session.engine] = current;
  }

  let target = cleanEngineSessionRef(refs[nextEngine] ?? {});
  const requestedTargetModel = typeof opts.model === 'string' && opts.model.trim() ? opts.model : undefined;
  if (nextEngine === 'grok' && target.id && requestedTargetModel && target.model !== requestedTargetModel) {
    target = cleanEngineSessionRef({
      ...target,
      id: undefined,
      lastSyncedAt: undefined,
      platformContextFingerprint: undefined,
      model: requestedTargetModel,
    });
  }
  const nextModel = opts.model !== undefined ? opts.model : target.model ?? null;
  const nextEffort = opts.effortLevel !== undefined ? opts.effortLevel : target.effortLevel ?? null;
  const nextTarget = cleanEngineSessionRef({
    ...target,
    model: nextModel ?? undefined,
    effortLevel: nextEffort ?? undefined,
  });
  if (Object.keys(nextTarget).length > 0) refs[nextEngine] = nextTarget;

  const transportMeta = (session.transportMeta && typeof session.transportMeta === 'object' && !Array.isArray(session.transportMeta))
    ? { ...session.transportMeta }
    : {};
  if (nextEngine !== session.engine) {
    transportMeta.engineSyncTarget = nextEngine;
    transportMeta.engineSyncSince = target.lastSyncedAt ?? session.createdAt;
  }
  delete transportMeta.engineOverride;

  return updateSession(sessionId, {
    engine: nextEngine,
    engineSessionId: target.id ?? null,
    engineSessions: refs,
    status: "idle",
    model: nextModel ?? null,
    effortLevel: nextEffort ?? null,
    lastContextTokens: null,
    transportMeta: transportMeta as JsonObject,
    lastError: null,
  });
}

export function clearEngineSessionRefs(sessionId: string, engine?: string): Session | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  if (!engine) {
    return updateSession(sessionId, { engineSessionId: null, engineSessions: null });
  }
  const refs = cleanEngineSessionRefs(session.engineSessions) ?? {};
  delete refs[engine];
  return updateSession(sessionId, {
    engineSessionId: session.engine === engine ? null : session.engineSessionId,
    engineSessions: refs,
  });
}

export interface ListSessionsFilter {
  status?: Session['status'];
  source?: string;
  engine?: string;
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = ['archived_at IS NULL', 'workflow_kind IS NULL'];
  const values: unknown[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter?.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter?.engine) {
    conditions.push('engine = ?');
    values.push(filter.engine);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export interface ChatPin {
  key: string;
  kind: 'session' | 'employee';
  pinnedAt: string;
}

export function listChatPins(): ChatPin[] {
  const rows = initDb()
    .prepare(`
      SELECT chat_pins.pin_key, chat_pins.pinned_at
      FROM chat_pins
      LEFT JOIN sessions ON sessions.id = chat_pins.pin_key
      WHERE chat_pins.pin_key LIKE 'emp:%' OR sessions.id IS NOT NULL
    `)
    .all() as Array<{ pin_key: string; pinned_at: string }>;
  return rows.map((row) => ({
    key: row.pin_key,
    kind: row.pin_key.startsWith('emp:') ? 'employee' : 'session',
    pinnedAt: row.pinned_at,
  }));
}

export function pinChat(key: string): void {
  initDb()
    .prepare('INSERT INTO chat_pins (pin_key, pinned_at) VALUES (?, ?) ON CONFLICT(pin_key) DO NOTHING')
    .run(key, new Date().toISOString());
}

export function unpinChat(key: string): void {
  initDb().prepare('DELETE FROM chat_pins WHERE pin_key = ?').run(key);
}

export function listPinnedSessions(): Session[] {
  const rows = initDb()
    .prepare(`
      SELECT sessions.*
      FROM sessions
      INNER JOIN chat_pins ON chat_pins.pin_key = sessions.id
      WHERE sessions.archived_at IS NULL AND sessions.workflow_kind IS NULL
      ORDER BY sessions.last_activity DESC
    `)
    .all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * The N most-recently-active sessions, newest first — a bounded window for
 * polled endpoints that only ever surface the recent tail.
 * `offset` pages deeper (newest-first) when the first window is all non-emitting
 * rows. Backed by idx_sessions_last_activity; avoids hydrating every row.
 */
export function listRecentSessions(limit: number, offset = 0): Session[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY last_activity DESC LIMIT ? OFFSET ?')
    .all(Math.max(0, Math.floor(limit)), Math.max(0, Math.floor(offset))) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Total session count. A pure `COUNT(*)` — no row hydration or JSON parse —
 * for endpoints (e.g. /api/onboarding) that only need the number, not the rows.
 */
export function countSessions(): number {
  const db = initDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  return row.n;
}

// Sidebar groups sessions into cron, "direct" (no employee), and per-employee
// buckets. These sentinels mirror that grouping so the server can paginate and
// count per group without the client having to load every row. Keep this SQL in
// sync with isCronSession/isDirectSession in the web chat-sidebar.
export const CRON_GROUP = '__cron__';
export const DIRECT_GROUP = '__direct__';
const IS_CRON_SQL = `(source = 'cron' OR source_ref LIKE 'cron:%')`;

/**
 * A session whose `employee` equals the portal name (case-insensitively) is a
 * direct/COO session that happened to be tagged with the portal slug — there is
 * no org employee by that name. Collapse it to `null` so it buckets into the
 * direct group instead of spawning a phantom pseudo-employee group that renders
 * with the same title as the portal. Real org employees are unaffected.
 */
export function coercePortalEmployee(
  employee: string | null | undefined,
  portalName: string | null | undefined,
): string | null {
  const emp = employee?.trim();
  if (!emp) return null;
  const slug = portalName?.trim().toLowerCase();
  if (slug && emp.toLowerCase() === slug) return null;
  return emp;
}

/**
 * True for the gateway's own top-level agent session — the portal COO the
 * operator talks to, which by design has no employee identity of its own.
 *
 * Having no employee is NOT on its own the test: an employee can spawn a plain
 * session, and that child is employee-less too. What no session can produce is
 * a PARENTLESS one — every spawn and delegation route records a session caller
 * as the child's parent, whatever the request body asks for — and a workflow
 * attempt always carries its run in `workflowProvenance`. So the shape below is
 * reachable only from a surface the operator drives: the web console, a
 * connector conversation, an operator-authored cron, or the gateway itself.
 */
export function isPortalAgentSession(session: Session): boolean {
  return !session.employee && !session.parentSessionId && !session.workflowProvenance;
}

// Build the CASE that maps a row to its sidebar group. When a portalSlug is
// supplied, portal-slug-tagged rows fold into the direct group (defensive +
// retroactive for any rows that predate coercePortalEmployee). Returns the SQL
// plus the bound params it references so callers can splice them in order.
function groupKeySql(portalSlug?: string | null): { sql: string; params: unknown[] } {
  const slug = portalSlug?.trim().toLowerCase();
  const directExtra = slug ? ` OR LOWER(employee) = ?` : '';
  const sql = `CASE
  WHEN ${IS_CRON_SQL} THEN '${CRON_GROUP}'
  WHEN employee IS NULL OR employee = ''${directExtra} THEN '${DIRECT_GROUP}'
  ELSE employee
END`;
  return { sql, params: slug ? [slug] : [] };
}

function groupFilter(group: string, portalSlug?: string | null): { clause: string; params: unknown[] } {
  const slug = portalSlug?.trim().toLowerCase();
  if (group === CRON_GROUP) return { clause: IS_CRON_SQL, params: [] };
  if (group === DIRECT_GROUP) {
    const directExtra = slug ? ` OR LOWER(employee) = ?` : '';
    return {
      clause: `NOT ${IS_CRON_SQL} AND (employee IS NULL OR employee = ''${directExtra})`,
      params: slug ? [slug] : [],
    };
  }
  // A per-employee page must never leak portal-slug rows (they live in direct).
  // If the requested group *is* the portal slug, this yields nothing.
  const slugExclude = slug ? ` AND LOWER(employee) <> ?` : '';
  return {
    clause: `NOT ${IS_CRON_SQL} AND employee = ?${slugExclude}`,
    params: slug ? [group, slug] : [group],
  };
}

/** Most-recent `perGroup` sessions for each group — the bounded default payload. */
export function listRecentPerGroup(perGroup: number, portalSlug?: string | null): Session[] {
  const db = initDb();
  const { sql: keySql, params } = groupKeySql(portalSlug);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ${keySql} ORDER BY last_activity DESC) AS __rn
         FROM sessions
         WHERE archived_at IS NULL
       ) WHERE __rn <= ? ORDER BY last_activity DESC`,
    )
    .all(...params, perGroup) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** One group's sessions, newest first — used by the sidebar "load more" button. */
export function listSessionsForGroup(
  group: string,
  limit: number,
  offset: number,
  portalSlug?: string | null,
): Session[] {
  const db = initDb();
  const { clause, params } = groupFilter(group, portalSlug);
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE archived_at IS NULL AND (${clause}) ORDER BY last_activity DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Search across ALL sessions by title / employee / id (newest first, bounded). */
export function searchSessions(query: string, limit = 100): Session[] {
  const db = initDb();
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE title LIKE ? ESCAPE '\\' OR employee LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'
       ORDER BY last_activity DESC LIMIT ?`,
    )
    .all(like, like, like, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Deterministic AND-composed session search (GRS-020a). At least one filter is
 *  required — an empty filter would be an unbounded alias of listSessions. */
export interface SearchSessionsFilter {
  /** Escaped-LIKE substring over title + prompt_excerpt + id (%/_ are literal). */
  text?: string;
  /** Case-insensitive equality. */
  employee?: string;
  /** Case-insensitive equality. */
  engine?: string;
  status?: Session['status'];
  source?: string;
  parentSessionId?: string;
  workflowId?: string;
  workflowRunId?: string;
  workflowPhaseName?: string;
  /** Inclusive ISO-8601 bounds on last_activity (ISO strings compare lexicographically). */
  activeSince?: string;
  activeBefore?: string;
  /** Deterministic derivation: status IN ('error','interrupted'). `waiting` is
   *  deliberately excluded (operator ruling — usage-limit pauses self-resolve). */
  needsAttention?: boolean;
}

export function searchSessionsFiltered(filter: SearchSessionsFilter, limit = 20): Session[] {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.text) {
    // The ESCAPE character itself must be escaped too, so a literal backslash
    // in the query matches literally (GRS-020a-fix finding 4 — unescaped, `\b`
    // under ESCAPE '\' matches plain `b`). The character class handles all
    // three in one pass, so `\` never double-escapes the added prefixes.
    const like = `%${filter.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conditions.push("(title LIKE ? ESCAPE '\\' OR prompt_excerpt LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
    values.push(like, like, like);
  }
  if (filter.employee) {
    conditions.push('LOWER(employee) = ?');
    values.push(filter.employee.toLowerCase());
  }
  if (filter.engine) {
    conditions.push('LOWER(engine) = ?');
    values.push(filter.engine.toLowerCase());
  }
  if (filter.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter.parentSessionId) {
    conditions.push('parent_session_id = ?');
    values.push(filter.parentSessionId);
  }
  if (filter.workflowId) {
    conditions.push('workflow_id = ?');
    values.push(filter.workflowId);
  }
  if (filter.workflowRunId) {
    conditions.push('workflow_run_id = ?');
    values.push(filter.workflowRunId);
  }
  if (filter.workflowPhaseName) {
    conditions.push('workflow_phase_name = ?');
    values.push(filter.workflowPhaseName);
  }
  if (filter.activeSince) {
    conditions.push('last_activity >= ?');
    values.push(filter.activeSince);
  }
  if (filter.activeBefore) {
    conditions.push('last_activity <= ?');
    values.push(filter.activeBefore);
  }
  if (filter.needsAttention) {
    conditions.push("status IN ('error','interrupted')");
  }
  if (conditions.length === 0) {
    throw new Error('searchSessionsFiltered requires at least one filter');
  }
  const cap = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE ${conditions.join(' AND ')} ORDER BY last_activity DESC LIMIT ?`)
    .all(...values, cap) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Recent sessions for a given source, newest first (bounded). */
export function listSessionsBySource(source: string, limit: number): Session[] {
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE source = ? ORDER BY last_activity DESC LIMIT ?`)
    .all(source, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Child sessions of a parent — backed by idx_sessions_parent. */
export function listChildSessions(parentSessionId: string): Session[] {
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY last_activity DESC`)
    .all(parentSessionId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Execution attempts (sessions) linked to a work item — backed by
 * idx_sessions_work_item. The read-back half of the GRS-002 work-item slice
 * (cron mints+links an item; this reads its sessions). Newest first.
 */
export function listSessionsByWorkItem(workItemId: string): Session[] {
  const db = initDb();
  const todoId = parseTodoId(workItemId);
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE work_item_id = ? ORDER BY last_activity DESC`)
    .all(todoId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Total session count per group, so the UI can show accurate "+N more". */
export function getSessionGroupCounts(portalSlug?: string | null): Record<string, number> {
  const db = initDb();
  const { sql: keySql, params } = groupKeySql(portalSlug);
  const rows = db
    .prepare(`SELECT ${keySql} AS grp, COUNT(*) AS n FROM sessions WHERE archived_at IS NULL GROUP BY grp`)
    .all(...params) as Array<{ grp: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.grp] = r.n;
  return out;
}

/**
 * Mark any sessions stuck in "running" status as "interrupted".
 * Called on gateway startup — if the gateway is starting, no sessions can actually be running.
 * Sessions with an engine_session_id can be resumed via the Claude --resume flag.
 */
export function recoverStaleSessions(): number {
  const db = initDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE sessions SET status = 'interrupted', attempt_outcome = 'interrupted', attempt_terminal_version = attempt_terminal_version + 1, last_activity = ?, last_error = 'Interrupted: gateway restarted while session was running' WHERE status = 'running' AND workflow_kind IS NULL",
  ).run(now);
  return result.changes;
}

/** Settle workflow attempts whose engine process was lost with the old gateway. */
export function recoverStaleWorkflowAttemptSessions(): number {
  const database = initDb();
  const now = new Date().toISOString();
  return database.transaction(() => {
    database.prepare(`
      UPDATE queue_items
      SET status = 'cancelled'
      WHERE internal = 1
        AND status IN ('pending', 'running')
        AND EXISTS (
          SELECT 1
          FROM sessions
          WHERE sessions.id = queue_items.session_id
            AND sessions.status = 'running'
            AND sessions.workflow_kind = 'phase'
            AND sessions.attempt_outcome IS NULL
            AND sessions.attempt_terminal_version = 0
        )
    `).run();
    return database.prepare(`
      UPDATE sessions
      SET status = 'interrupted',
        attempt_outcome = 'interrupted',
        attempt_terminal_version = 1,
        attempt_turn = MAX(attempt_turn, 1),
        attempt_interruption_cause = NULL,
        attempt_interruption_turn = NULL,
        last_activity = ?,
        last_error = 'Interrupted: gateway restarted while workflow attempt was running'
      WHERE status = 'running'
        AND workflow_kind = 'phase'
        AND attempt_outcome IS NULL
        AND attempt_terminal_version = 0
    `).run(now).changes;
  }).immediate();
}

/**
 * Turn restart requests recorded by the old gateway into durable chat notices
 * after the replacement gateway is listening. Message insertion and marker
 * removal share one transaction, so a crash can neither lose nor duplicate the
 * acknowledgement on the next boot.
 */
export function consumeRestartAcknowledgements(): number {
  const database = initDb();
  const jsonPath = `$.${RESTART_ACK_META_KEY}`;
  const rows = database
    .prepare("SELECT id FROM sessions WHERE json_type(transport_meta, ?) = 'text' AND workflow_kind IS NULL")
    .all(jsonPath) as Array<{ id: string }>;
  if (rows.length === 0) return 0;

  const insert = database.prepare(
    "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'notification', ?, ?)",
  );
  const clear = database.prepare(
    "UPDATE sessions SET transport_meta = NULLIF(json_remove(transport_meta, ?), '{}') WHERE id = ?",
  );
  const commit = database.transaction(() => {
    for (const row of rows) {
      insert.run(uuidv4(), row.id, GATEWAY_RESTARTED_MESSAGE, Date.now());
      clear.run(jsonPath, row.id);
    }
  });
  commit();
  return rows.length;
}

/**
 * Get sessions that were interrupted by a gateway restart and can be resumed.
 * A session is resumable if it has an engine_session_id (Claude's internal session ID).
 */
export function getInterruptedSessions(): Session[] {
  const db = initDb();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE status = 'interrupted' AND engine_session_id IS NOT NULL AND workflow_kind IS NULL ORDER BY last_activity DESC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Record one completed turn's cost and turn count against a session.
 *
 * The single accounting entry point for EVERY turn-completion site, in both
 * manager.ts and the gateway's runWebSession. It exists because those two
 * runners drifted: runWebSession had three structurally identical completion
 * sites and none of them accumulated, so every web- and talk-sourced session
 * recorded total_turns = 0 and total_cost = 0. That silently disabled employee
 * budget caps, which are enforced from SUM(total_cost), since the overwhelming
 * majority of turns are web-sourced.
 *
 * `result.cost` MUST be a per-turn delta, not a session-to-date total — see the
 * note on sumTranscriptUsage in claude-interactive.ts.
 */
export function recordTurnAccounting(
  sessionId: string,
  result: { cost?: number; numTurns?: number },
): void {
  accumulateSessionCost(sessionId, result.cost ?? 0, result.numTurns ?? 1);
}

/**
 * Accumulate cost and turns for a session (called after each engine run).
 */
export function accumulateSessionCost(id: string, cost: number, turns: number): void {
  const db = initDb();
  db.prepare(
    'UPDATE sessions SET total_cost = total_cost + ?, total_turns = total_turns + ? WHERE id = ?',
  ).run(cost, turns, id);
}

export function getSessionSpend(sessionIds: string[]): number {
  if (sessionIds.length === 0) return 0;
  const placeholders = sessionIds.map(() => "?").join(", ");
  const row = initDb()
    .prepare(`SELECT COALESCE(SUM(total_cost), 0) AS spend FROM sessions WHERE id IN (${placeholders})`)
    .get(...sessionIds) as { spend: number };
  return row.spend;
}

export interface CostReportFilter {
  groupBy?: 'employee' | 'day';
  since?: string;
  until?: string;
  employee?: string;
  limit?: number;
}

export interface CostReportRow {
  key: string;
  cost: number;
  turns: number;
  sessions: number;
}

export interface CostReport {
  range: { since: string | null; until: string | null };
  groupBy: 'employee' | 'day';
  rows: CostReportRow[];
  total: { cost: number; turns: number; sessions: number };
}

/**
 * Deterministic cost/spend report over existing session accounting only.
 * No budgets, no work-item joins, no judgment: this wraps sessions.total_cost
 * and sessions.total_turns exactly as the engines recorded them.
 */
export function getCostReport(filter: CostReportFilter = {}): CostReport {
  const db = initDb();
  const groupBy = filter.groupBy ?? 'employee';
  if (groupBy !== 'employee' && groupBy !== 'day') throw new Error('groupBy must be "employee" or "day"');
  const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 100), 100));
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.since) {
    where.push('created_at >= ?');
    values.push(filter.since);
  }
  if (filter.until) {
    where.push('created_at <= ?');
    values.push(filter.until);
  }
  if (filter.employee) {
    where.push('LOWER(employee) = ?');
    values.push(filter.employee.toLowerCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const keyExpr = groupBy === 'employee'
    ? "COALESCE(NULLIF(employee, ''), '__unassigned__')"
    : "substr(created_at, 1, 10)";
  const rows = db.prepare(
    `SELECT ${keyExpr} AS key,
            ROUND(COALESCE(SUM(total_cost), 0), 6) AS cost,
            COALESCE(SUM(total_turns), 0) AS turns,
            COUNT(*) AS sessions
     FROM sessions
     ${whereSql}
     GROUP BY key
     ORDER BY cost DESC, key ASC
     LIMIT ?`,
  ).all(...values, limit) as Array<{ key: string | null; cost: number | null; turns: number | null; sessions: number }>;

  const total = db.prepare(
    `SELECT ROUND(COALESCE(SUM(total_cost), 0), 6) AS cost,
            COALESCE(SUM(total_turns), 0) AS turns,
            COUNT(*) AS sessions
     FROM sessions
     ${whereSql}`,
  ).get(...values) as { cost: number | null; turns: number | null; sessions: number };

  return {
    range: { since: filter.since ?? null, until: filter.until ?? null },
    groupBy,
    rows: rows.map((r) => ({
      key: r.key ?? '__unassigned__',
      cost: Number(r.cost ?? 0),
      turns: Number(r.turns ?? 0),
      sessions: Number(r.sessions ?? 0),
    })),
    total: {
      cost: Number(total.cost ?? 0),
      turns: Number(total.turns ?? 0),
      sessions: Number(total.sessions ?? 0),
    },
  };
}

/**
 * Duplicate a session and all its messages, returning a new session with a fresh ID.
 * Does NOT fork the engine session — the caller handles that separately.
 */
export function duplicateSession(sourceId: string, newTitle?: string): { session: Session; messageCount: number } {
  const db = initDb();
  const source = getSession(sourceId);
  if (!source) throw new Error(`Session ${sourceId} not found`);
  if (!source.engineSessionId) throw new Error(`Session ${sourceId} has no engine session ID — cannot duplicate`);

  const now = new Date().toISOString();
  const newId = uuidv4();
  const title = newTitle ?? `Copy of ${source.title || sourceId.slice(0, 8)}`;
  const newSessionKey = `web:${Date.now()}`;

  // Copy session + messages in a single transaction for consistency
  const messages = db.prepare(
    'SELECT role, content, timestamp, media, blocks, meta FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
  ).all(sourceId) as Array<{ role: string; content: string; timestamp: number; media: string | null; blocks: string | null; meta: string | null }>;

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (
        id, engine, engine_session_id, source, source_ref, connector, session_key,
        reply_context, message_id, transport_meta,
        employee, model, title, parent_session_id, effort_level, status,
        total_cost, total_turns, created_at, last_activity
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'idle', 0, 0, ?, ?)
    `).run(
      newId,
      source.engine,
      source.source,
      source.sourceRef,
      source.connector,
      newSessionKey,
      source.replyContext ? JSON.stringify(source.replyContext) : null,
      source.messageId,
      source.transportMeta ? JSON.stringify(source.transportMeta) : null,
      source.employee,
      source.model,
      title,
      source.effortLevel,
      now,
      now,
    );

    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const msg of messages) {
      insertMsg.run(uuidv4(), newId, msg.role, msg.content, msg.timestamp, msg.media ?? null, msg.blocks ?? null, msg.meta ?? null);
    }
  });
  txn();

  const newSession = getSession(newId)!;
  return { session: newSession, messageCount: messages.length };
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  const txn = db.transaction(() => {
    const session = db.prepare('SELECT work_item_id FROM sessions WHERE id = ?').get(id) as { work_item_id: string | null } | undefined;
    if (!session || session.work_item_id) return false;
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM queue_items WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM chat_pins WHERE pin_key = ?').run(id);
    return db.prepare('DELETE FROM sessions WHERE id = ? AND work_item_id IS NULL').run(id).changes > 0;
  });
  const deleted = txn();
  if (deleted) ptySnapshotStore.deleteSync(id);
  return deleted;
}

export function deleteSessions(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = initDb();
  const txn = db.transaction((): { changes: number; deletedIds: string[] } => {
    const requestedPlaceholders = ids.map(() => '?').join(',');
    const deletable = (db.prepare(
      `SELECT id FROM sessions WHERE id IN (${requestedPlaceholders}) AND work_item_id IS NULL`,
    ).all(...ids) as Array<{ id: string }>).map((row) => row.id);
    if (deletable.length === 0) return { changes: 0, deletedIds: [] };
    const placeholders = deletable.map(() => '?').join(',');
    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...deletable);
    db.prepare(`DELETE FROM queue_items WHERE session_id IN (${placeholders})`).run(...deletable);
    db.prepare(`DELETE FROM chat_pins WHERE pin_key IN (${placeholders})`).run(...deletable);
    const result = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders}) AND work_item_id IS NULL`).run(...deletable);
    return { changes: result.changes, deletedIds: deletable };
  });
  const result = txn();
  for (const id of result.deletedIds) ptySnapshotStore.deleteSync(id);
  return result.changes;
}

/** Attachment descriptor stored alongside a message and rendered by the web UI. */
export interface MessageMedia {
  type: 'image' | 'audio' | 'file';
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  /** Parsed from the `media` JSON column; undefined when the message has no attachments. */
  media?: MessageMedia[];
  /** True for a live mid-turn block. Most engines replace these at turn end. */
  partial?: boolean;
  /** Tool name when this block is a tool call — lets a reloaded block render as a tool card. */
  toolCall?: string;
  /** Native engine call id used to correlate interleaved tool results. */
  toolId?: string;
  /** Structured Chat Mode blocks rendered by the web UI. */
  blocks?: ChatBlock[];
  /** Safe structured UI metadata, used for reload-stable callback attribution. */
  meta?: JsonObject;
}

interface MessageRow {
  rowid: number;
  id: string;
  role: string;
  content: string;
  timestamp: number;
  media: string | null;
  partial: number | null;
  seq: number | null;
  tool_call: string | null;
  tool_id: string | null;
  blocks: string | null;
  meta: string | null;
}

export interface MessagePage {
  messages: SessionMessage[];
  hasOlder: boolean;
}

export interface MessagePageOptions {
  /** Fetch messages strictly older than this message id. Omit for the newest tail. */
  before?: string;
  /** Number of messages to return. Clamped to a bounded positive page size. */
  limit?: number;
}

function parseMediaColumn(value: unknown): MessageMedia[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MessageMedia[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseBlocksColumn(value: unknown): ChatBlock[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const blocks = parsed.flatMap((block) => {
      const result = validateBlockEnvelope({ op: "put", block });
      return result.ok ? [result.envelope.block] : [];
    });
    return blocks.length > 0 ? blocks : undefined;
  } catch {
    return undefined;
  }
}

function parseMetaColumn(value: unknown): JsonObject | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function rowToMessage(r: MessageRow): SessionMessage {
  const msg: SessionMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp };
  const media = parseMediaColumn(r.media);
  const blocks = parseBlocksColumn(r.blocks);
  const meta = parseMetaColumn(r.meta);
  if (media) msg.media = media;
  if (blocks) msg.blocks = blocks;
  if (meta) msg.meta = meta;
  if (r.partial) msg.partial = true;
  if (r.tool_call) msg.toolCall = r.tool_call;
  if (r.tool_id) msg.toolId = r.tool_id;
  return msg;
}

function normalizeMessagePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return 100;
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function blockFallbackCandidates(block: ChatBlock, fallbackText?: string): string[] {
  return [
    fallbackText,
    blockFallbackText(block),
    block.title,
    block.summary,
    block.type,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function isSyntheticBlockContent(content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  const trimmed = content.trim();
  return blockFallbackCandidates(block, fallbackText).some((candidate) => candidate.trim() === trimmed);
}

function isSyntheticBlockRow(rowId: string, content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  if (rowId.startsWith(`block-${block.id}-`)) return true;
  return isSyntheticBlockContent(content, block, fallbackText);
}

export function insertMessage(
  sessionId: string,
  role: string,
  content: string,
  media?: MessageMedia[],
  blocks?: ChatBlock[],
  presetId?: string,
  meta?: JsonObject,
): string {
  const db = initDb();
  // presetId (GRS-016e-fix2): workflow follow-up turns pre-mint the row id and
  // persist it as the receipt's settle anchor BEFORE this insert — the row must
  // carry exactly that id so crash recovery disambiguates by identity. Only ever
  // used for a row that does not exist yet (the id was never used on a re-post).
  const id = presetId ?? uuidv4();
  const mediaJson = media && media.length > 0 ? JSON.stringify(media) : null;
  const blocksJson = blocks && blocks.length > 0 ? JSON.stringify(blocks) : null;
  const metaJson = meta ? JSON.stringify(meta) : null;
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, sessionId, role, content, Date.now(), mediaJson, blocksJson, metaJson,
  );
  return id;
}

/** Insert a canonical row strictly after streamed evidence, even when settlement
 * and the last delta share a millisecond. This keeps tail pagination and reload
 * order aligned with the live event order without rewriting evidence timestamps. */
export function insertMessageAfter(
  sessionId: string,
  role: string,
  content: string,
  afterTimestamp: number,
  media?: MessageMedia[],
  blocks?: ChatBlock[],
): string {
  const db = initDb();
  const id = uuidv4();
  const mediaJson = media && media.length > 0 ? JSON.stringify(media) : null;
  const blocksJson = blocks && blocks.length > 0 ? JSON.stringify(blocks) : null;
  const timestamp = Math.max(Date.now(), Math.floor(afterTimestamp) + 1);
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, sessionId, role, content, timestamp, mediaJson, blocksJson,
  );
  return id;
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, tool_id, blocks, meta FROM messages WHERE session_id = ? ORDER BY timestamp ASC, COALESCE(seq, 0) ASC, rowid ASC')
    .all(sessionId) as MessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Just the live mid-turn (`partial=1`) blocks for a session, in stream order.
 * Backed by idx_messages_partial_order so turn-settle reads only the handful of live
 * rows instead of loading + parsing the whole transcript to filter them out
 * (the heaviest sessions were 600+ messages loaded on EVERY turn-settle).
 */
export function getPartialMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, tool_id, blocks, meta FROM messages WHERE session_id = ? AND partial = 1 ORDER BY timestamp ASC, COALESCE(seq, 0) ASC, rowid ASC')
    .all(sessionId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getMessagePage(sessionId: string, options: MessagePageOptions = {}): MessagePage {
  const db = initDb();
  const limit = normalizeMessagePageLimit(options.limit);
  const pageLimit = limit + 1;
  let rows: MessageRow[];

  if (options.before) {
    const cursor = db
      .prepare('SELECT rowid, timestamp, COALESCE(seq, 0) AS seq_order FROM messages WHERE session_id = ? AND id = ?')
      .get(sessionId, options.before) as { rowid: number; timestamp: number; seq_order: number } | undefined;
    if (!cursor) return { messages: [], hasOlder: false };

    rows = db
      .prepare(`
        SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, tool_id, blocks, meta
        FROM messages
        WHERE session_id = ?
          AND (
            timestamp < ?
            OR (timestamp = ? AND COALESCE(seq, 0) < ?)
            OR (timestamp = ? AND COALESCE(seq, 0) = ? AND rowid < ?)
          )
        ORDER BY timestamp DESC, COALESCE(seq, 0) DESC, rowid DESC
        LIMIT ?
      `)
      .all(
        sessionId,
        cursor.timestamp,
        cursor.timestamp,
        cursor.seq_order,
        cursor.timestamp,
        cursor.seq_order,
        cursor.rowid,
        pageLimit,
      ) as MessageRow[];
  } else {
    rows = db
      .prepare(`
        SELECT rowid, id, role, content, timestamp, media, partial, seq, tool_call, tool_id, blocks, meta
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp DESC, COALESCE(seq, 0) DESC, rowid DESC
        LIMIT ?
      `)
      .all(sessionId, pageLimit) as MessageRow[];
  }

  const hasOlder = rows.length > limit;
  const pageRows = (hasOlder ? rows.slice(0, limit) : rows).reverse();
  return { messages: pageRows.map(rowToMessage), hasOlder };
}

/** Max messages each side of the anchor. */
export const MESSAGE_CONTEXT_MAX_RADIUS = 100;

export interface MessageContextEntry {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  isAnchor: boolean;
}

export interface MessageContext {
  sessionId: string;
  anchorMessageId: string;
  messages: MessageContextEntry[];
}

/**
 * GRS-020a — the ±radius window around a message anchor (a search_messages
 * hit), so a search result becomes readable in place without pulling a whole
 * transcript. The radius is clamped to {@link MESSAGE_CONTEXT_MAX_RADIUS};
 * selected message bodies are returned as stored.
 * Returns undefined when the message doesn't exist IN THAT SESSION (an anchor
 * from another session must not leak across).
 */
export function getMessageContext(sessionId: string, messageId: string, radius = 3): MessageContext | undefined {
  const db = initDb();
  const r = Math.max(1, Math.min(Math.floor(radius) || 3, MESSAGE_CONTEXT_MAX_RADIUS));
  // GRS-020a-fix finding 6: O(radius), not O(session) — locate the anchor with
  // one bound lookup, then fetch its neighbors with two bounded LIMIT queries
  // walking the (session_id, timestamp) index. Ordering matches getMessages
  // (timestamp ASC, seq ASC) with rowid as a deterministic final tie-break;
  // seq is COALESCEd to -1 so NULL (the common final-message value) keeps its
  // sorts-before-numbers position explicitly.
  interface Row {
    id: string;
    role: string;
    content: string;
    timestamp: number;
    seq: number | null;
    rowid: number;
  }
  const anchor = db
    .prepare('SELECT id, role, content, timestamp, seq, rowid FROM messages WHERE session_id = ? AND id = ?')
    .get(sessionId, messageId) as Row | undefined;
  if (!anchor) return undefined;
  const aSeq = anchor.seq ?? -1;
  const before = db
    .prepare(
      `SELECT id, role, content, timestamp, seq, rowid FROM messages
       WHERE session_id = ?
         AND (timestamp < ?
              OR (timestamp = ? AND COALESCE(seq, -1) < ?)
              OR (timestamp = ? AND COALESCE(seq, -1) = ? AND rowid < ?))
       ORDER BY timestamp DESC, COALESCE(seq, -1) DESC, rowid DESC
       LIMIT ?`,
    )
    .all(sessionId, anchor.timestamp, anchor.timestamp, aSeq, anchor.timestamp, aSeq, anchor.rowid, r) as Row[];
  const after = db
    .prepare(
      `SELECT id, role, content, timestamp, seq, rowid FROM messages
       WHERE session_id = ?
         AND (timestamp > ?
              OR (timestamp = ? AND COALESCE(seq, -1) > ?)
              OR (timestamp = ? AND COALESCE(seq, -1) = ? AND rowid > ?))
       ORDER BY timestamp ASC, COALESCE(seq, -1) ASC, rowid ASC
       LIMIT ?`,
    )
    .all(sessionId, anchor.timestamp, anchor.timestamp, aSeq, anchor.timestamp, aSeq, anchor.rowid, r) as Row[];
  const messages: MessageContextEntry[] = [...before.reverse(), anchor, ...after].map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    isAnchor: row.id === messageId,
  }));
  return { sessionId, anchorMessageId: messageId, messages };
}

export function applyBlockEnvelope(
  sessionId: string,
  input: ChatBlockEnvelope,
  fallbackText?: string,
  options?: { partial?: boolean; seq?: number },
): string | null {
  const result = validateBlockEnvelope(input);
  if (!result.ok) throw new Error(result.error);
  const envelope = result.envelope;
  const db = initDb();
  const partialOnly = options?.partial === true;
  const rows = db
    .prepare(`SELECT id, content, blocks FROM messages WHERE session_id = ? AND role = ?${partialOnly ? ' AND partial = 1' : ''} ORDER BY timestamp ASC, seq ASC`)
    .all(sessionId, 'assistant') as Array<{ id: string; content: string; blocks: string | null }>;
  const existing = rows
    .map((row) => ({ row, blocks: parseBlocksColumn(row.blocks) ?? [] }))
    .find((entry) => entry.blocks.some((block) => block.id === envelope.block.id));

  if (envelope.op === 'remove') {
    if (!existing) return null;
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    const remainingBlocks = existing.blocks.filter((block) => block.id !== envelope.block.id);
    if (remainingBlocks.length > 0) {
      db.prepare('UPDATE messages SET blocks = ? WHERE id = ?').run(JSON.stringify(remainingBlocks), existing.row.id);
    } else if (isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(existing.row.id);
    } else {
      db.prepare('UPDATE messages SET blocks = NULL WHERE id = ?').run(existing.row.id);
    }
    return existing.row.id;
  }

  if (existing) {
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    if (oldBlock) {
      if (envelope.block.version < oldBlock.version) return existing.row.id;
      if (envelope.block.version === oldBlock.version
        && (oldBlock.type === 'todo-activity'
          || oldBlock.type === 'workflow-definition'
          || oldBlock.type === 'workflow-run')) {
        const oldOrder = oldBlock.activityOrder;
        const nextOrder = envelope.block.activityOrder;
        if (oldOrder === undefined && nextOrder === undefined) return existing.row.id;
        if (nextOrder === undefined) return existing.row.id;
        if (oldOrder !== undefined && nextOrder <= oldOrder) return existing.row.id;
      }
    }
    const nextBlocks = existing.blocks.map((block) =>
      block.id === envelope.block.id
        ? envelope.op === "patch" ? mergeBlock(block, envelope.block) : envelope.block
        : block,
    );
    const target = nextBlocks.find((block) => block.id === envelope.block.id) ?? envelope.block;
    const nextContent = isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)
      ? fallbackText?.trim() || blockFallbackText(target)
      : existing.row.content;
    db.prepare('UPDATE messages SET content = ?, blocks = ? WHERE id = ?').run(
      nextContent,
      JSON.stringify(nextBlocks),
      existing.row.id,
    );
    return existing.row.id;
  }

  if (envelope.op === 'patch') return null;

  const id = `block-${envelope.block.id}-${uuidv4()}`;
  if (partialOnly) {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, blocks) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      options?.seq ?? 0,
      JSON.stringify([envelope.block]),
    );
  } else {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, blocks) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      JSON.stringify([envelope.block]),
    );
  }
  return id;
}

/**
 * Insert a live mid-turn block (`partial=1`). `seq` orders blocks within the turn;
 * `toolCall` is set when the block is a tool call (renders as a tool card on reload).
 * These rows are usually wiped by `deletePartialMessages` at turn end.
 */
export function insertPartialMessage(
  sessionId: string,
  role: string,
  content: string,
  seq: number,
  toolCall?: string,
  toolId?: string,
): string {
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, tool_call, tool_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(
    id, sessionId, role, content, Date.now(), seq, toolCall ?? null, toolId ?? null,
  );
  return id;
}

/** Grow the current partial text block in place (debounced text streaming). */
export function updatePartialMessage(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ? AND partial = 1').run(content, id);
}

/** Settle one exact partial tool row and attach its durable activity receipt. */
export function settlePartialToolMessage(id: string, content: string, activityReceiptId?: string): void {
  const db = initDb();
  const row = db.prepare('SELECT meta FROM messages WHERE id = ? AND partial = 1').get(id) as { meta: string | null } | undefined;
  if (!row) return;
  const current = parseMetaColumn(row.meta) ?? {};
  const meta = activityReceiptId ? { ...current, activityReceiptId } : current;
  db.prepare('UPDATE messages SET content = ?, meta = ? WHERE id = ? AND partial = 1').run(
    content,
    Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
    id,
  );
}

/** Replace a stored (non-partial) message's text in place. Used by external-turn
 *  sync to upgrade a truncated early-Stop assistant row to the complete transcript
 *  text instead of inserting a duplicate row. */
export function updateMessageContent(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
}

/** Delete all live partial blocks for a session (called at turn end before the final insert). */
export function deletePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('DELETE FROM messages WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

/** Keep streamed blocks as canonical history. Used by engines whose final
 * answer is already represented as interleaved text + tool rows. */
export function finalizePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('UPDATE messages SET partial = NULL WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

/** Settle one completed stream atomically: selected rows become durable evidence
 * and every other partial row is discarded. Updating selected ids first lets the
 * indexed trailing DELETE remove transient/duplicate rows without a large IN list. */
export function settlePartialMessages(sessionId: string, preserveMessageIds: ReadonlySet<string>): number {
  const db = initDb();
  const settle = db.transaction(() => {
    let finalized = 0;
    const finalize = db.prepare(
      'UPDATE messages SET partial = NULL WHERE session_id = ? AND id = ? AND partial = 1',
    );
    for (const id of preserveMessageIds) {
      finalized += finalize.run(sessionId, id).changes;
    }
    const deleted = db.prepare('DELETE FROM messages WHERE session_id = ? AND partial = 1').run(sessionId).changes;
    return finalized + deleted;
  });
  return settle();
}

/** Boot sweep: drop any partial blocks stranded by a mid-turn gateway restart. */
export function clearAllPartialMessages(): number {
  const db = initDb();
  return db.prepare('DELETE FROM messages WHERE partial = 1').run().changes;
}

interface SessionDeliveryRow {
  id: string;
  targetSessionId: string;
  sourceKind: SessionDeliveryIdentity['sourceKind'];
  sourceId: string;
  sourceAttempt: string;
  sourceOutcome: string;
  sourceVersion: number;
  deliveryKind: string;
  payload: string;
  status: SessionDelivery['status'];
  messageId: string | null;
  queueItemId: string | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: string;
  acceptedAt: string | null;
}

const CALLBACK_DELIVERY_SELECT = `
  SELECT
    id,
    target_session_id AS targetSessionId,
    source_kind AS sourceKind,
    source_id AS sourceId,
    source_attempt AS sourceAttempt,
    source_outcome AS sourceOutcome,
    source_version AS sourceVersion,
    delivery_kind AS deliveryKind,
    payload,
    status,
    message_id AS messageId,
    queue_item_id AS queueItemId,
    attempt_count AS attemptCount,
    next_attempt_at AS nextAttemptAt,
    last_attempt_at AS lastAttemptAt,
    last_error AS lastError,
    dead_lettered_at AS deadLetteredAt,
    created_at AS createdAt,
    accepted_at AS acceptedAt
  FROM callback_deliveries
`;

function sessionDeliveryFromRow(row: SessionDeliveryRow): SessionDelivery {
  if (row.deliveryKind === 'quarantined' || row.sourceOutcome === 'quarantined') {
    throw new Error(`Session delivery ${row.id} is quarantined${row.lastError ? `: ${row.lastError}` : ''}`);
  }
  const canonicalIdentity = canonicalSessionDeliveryIdentity(row);
  validateSessionDeliveryIdentity(canonicalIdentity);
  for (const field of [
    'targetSessionId',
    'sourceId',
    'sourceAttempt',
    'sourceOutcome',
    'deliveryKind',
  ] as const) {
    if (row[field] !== canonicalIdentity[field]) {
      throw new Error(`Callback delivery ${row.id} has noncanonical ${field}`);
    }
  }
  if (!Number.isInteger(row.sourceVersion) || row.sourceVersion < 1) {
    throw new Error(`Session delivery ${row.id} has an invalid source version`);
  }
  if (row.sourceKind !== 'session' && row.sourceKind !== 'workflow-run') {
    throw new Error(`Session delivery ${row.id} has an invalid source kind`);
  }
  if (!['pending', 'accepted', 'dead_letter'].includes(row.status)) {
    throw new Error(`Callback delivery ${row.id} has an invalid lifecycle status`);
  }
  if (!Number.isInteger(row.attemptCount) || row.attemptCount < 0) {
    throw new Error(`Callback delivery ${row.id} has an invalid attempt count`);
  }
  for (const [field, value] of Object.entries({
    nextAttemptAt: row.nextAttemptAt,
    lastAttemptAt: row.lastAttemptAt,
    deadLetteredAt: row.deadLetteredAt,
  })) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`Callback delivery ${row.id} has an invalid ${field}`);
    }
  }
  if (typeof row.createdAt !== 'string' || !row.createdAt || !Number.isFinite(Date.parse(row.createdAt))) {
    throw new Error(`Callback delivery ${row.id} has an invalid createdAt`);
  }
  for (const [field, value] of Object.entries({
    messageId: row.messageId,
    queueItemId: row.queueItemId,
    acceptedAt: row.acceptedAt,
    lastError: row.lastError,
  })) {
    if (value !== null && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`Callback delivery ${row.id} has an invalid ${field}`);
    }
  }
  if (row.acceptedAt !== null && !Number.isFinite(Date.parse(row.acceptedAt))) {
    throw new Error(`Callback delivery ${row.id} has an invalid acceptedAt`);
  }
  const createdAtMs = Date.parse(row.createdAt);
  const acceptedAtMs = row.acceptedAt === null ? null : Date.parse(row.acceptedAt);
  if (acceptedAtMs !== null && acceptedAtMs < createdAtMs) {
    throw new Error(`Callback delivery ${row.id} has acceptedAt before createdAt`);
  }
  if (row.deadLetteredAt !== null && row.deadLetteredAt < createdAtMs) {
    throw new Error(`Callback delivery ${row.id} has deadLetteredAt before createdAt`);
  }
  if (row.lastError !== null && row.lastError.trim() === '') {
    throw new Error(`Callback delivery ${row.id} has an empty lastError`);
  }
  if (row.attemptCount === 0 && (row.nextAttemptAt !== null || row.lastAttemptAt !== null || row.lastError !== null)) {
    throw new Error(`Callback delivery ${row.id} has attempt state without an attempt`);
  }
  if (row.attemptCount > 0 && row.lastAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has an attempt without lastAttemptAt`);
  }
  if (row.status === 'pending' && row.attemptCount > 0 && row.nextAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has a pending attempt without nextAttemptAt`);
  }
  if (row.lastAttemptAt !== null && row.lastAttemptAt < createdAtMs) {
    throw new Error(`Callback delivery ${row.id} has lastAttemptAt before createdAt`);
  }
  if (row.nextAttemptAt !== null && row.lastAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has nextAttemptAt without lastAttemptAt`);
  }
  if (row.nextAttemptAt !== null && row.lastAttemptAt !== null && row.nextAttemptAt < row.lastAttemptAt) {
    throw new Error(`Callback delivery ${row.id} has nextAttemptAt before lastAttemptAt`);
  }
  if (row.status === 'accepted') {
    if (
      !row.messageId
      || !row.queueItemId
      || !row.acceptedAt
      || row.nextAttemptAt !== null
      || row.lastError !== null
      || row.deadLetteredAt !== null
    ) {
      throw new Error(`Callback delivery ${row.id} has an invalid accepted lifecycle`);
    }
    if (acceptedAtMs !== null && row.lastAttemptAt !== null && acceptedAtMs < row.lastAttemptAt) {
      throw new Error(`Callback delivery ${row.id} has acceptedAt before lastAttemptAt`);
    }
  } else if (row.messageId !== null || row.queueItemId !== null || row.acceptedAt !== null) {
    throw new Error(`Callback delivery ${row.id} has callback acceptance state before acceptance`);
  }
  if (row.status === 'dead_letter') {
    if (row.deadLetteredAt === null || row.nextAttemptAt !== null || !row.lastError) {
      throw new Error(`Callback delivery ${row.id} has an invalid dead-letter lifecycle`);
    }
    if (row.lastAttemptAt !== null && row.deadLetteredAt < row.lastAttemptAt) {
      throw new Error(`Callback delivery ${row.id} has deadLetteredAt before lastAttemptAt`);
    }
  }
  if (row.status === 'pending' && row.deadLetteredAt !== null) {
    throw new Error(`Callback delivery ${row.id} has dead-letter state while pending`);
  }
  if (row.status === 'pending' && row.lastError !== null && row.nextAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has retry error without nextAttemptAt`);
  }
  let payload: SessionDeliveryPayload;
  try {
    payload = JSON.parse(row.payload) as SessionDeliveryPayload;
  } catch {
    throw new Error(`Callback delivery ${row.id} has invalid payload JSON`);
  }
  if (
    !payload
    || typeof payload !== 'object'
    || typeof payload.message !== 'string'
    || typeof payload.displayMessage !== 'string'
  ) {
    throw new Error(`Callback delivery ${row.id} has an invalid payload`);
  }
  return { ...row, payload };
}

function canonicalSessionDeliveryIdentity(identity: SessionDeliveryIdentity): SessionDeliveryIdentity {
  return {
    targetSessionId: canonicalCallbackIdentityText(identity.targetSessionId),
    sourceKind: identity.sourceKind,
    sourceId: canonicalCallbackIdentityText(identity.sourceId),
    sourceAttempt: canonicalCallbackIdentityText(identity.sourceAttempt),
    sourceOutcome: canonicalCallbackIdentityText(identity.sourceOutcome),
    sourceVersion: identity.sourceVersion,
    deliveryKind: canonicalCallbackIdentityText(identity.deliveryKind),
  };
}

function validateSessionDeliveryIdentity(identity: SessionDeliveryIdentity): void {
  for (const [name, value] of Object.entries({
    targetSessionId: identity.targetSessionId,
    sourceId: identity.sourceId,
    sourceAttempt: identity.sourceAttempt,
    sourceOutcome: identity.sourceOutcome,
    deliveryKind: identity.deliveryKind,
  })) {
    if (typeof value !== 'string' || !canonicalCallbackIdentityText(value)) throw new Error(`${name} is required for session delivery`);
  }
  if (identity.sourceKind !== 'session' && identity.sourceKind !== 'workflow-run') {
    throw new Error('sourceKind is invalid for session delivery');
  }
  if (!Number.isInteger(identity.sourceVersion) || identity.sourceVersion < 1) {
    throw new Error('sourceVersion must be a positive integer for session delivery');
  }
}

export function getSessionDelivery(id: string): SessionDelivery | undefined {
  const row = initDb().prepare(`${CALLBACK_DELIVERY_SELECT} WHERE id = ?`).get(id) as SessionDeliveryRow | undefined;
  return row ? sessionDeliveryFromRow(row) : undefined;
}

export function getSessionDeliveryByQueueItemId(queueItemId: string): SessionDelivery | undefined {
  const row = initDb()
    .prepare(`${CALLBACK_DELIVERY_SELECT} WHERE queue_item_id = ?`)
    .get(queueItemId) as SessionDeliveryRow | undefined;
  return row ? sessionDeliveryFromRow(row) : undefined;
}

export function listPendingSessionDeliveries(): SessionDelivery[] {
  const database = initDb();
  const rows = database
    .prepare(`${CALLBACK_DELIVERY_SELECT} WHERE status = 'pending' ORDER BY created_at ASC, id ASC`)
    .all() as SessionDeliveryRow[];
  const deliveries: SessionDelivery[] = [];
  for (const row of rows) {
    try {
      deliveries.push(sessionDeliveryFromRow(row));
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      quarantineSessionDeliveryRow(database, row, diagnostic);
    }
  }
  return deliveries;
}

function quarantineSessionDeliveryRow(
  database: Database.Database,
  row: SessionDeliveryRow,
  diagnostic: string,
): void {
  const safeId = canonicalCallbackIdentityText(row.id) || randomUUID();
  database.prepare(`
    UPDATE callback_deliveries
    SET target_session_id = ?,
        source_kind = 'session',
        source_id = ?,
        source_attempt = ?,
        source_outcome = 'quarantined',
        source_version = 1,
        delivery_kind = 'quarantined',
        payload = ?,
        status = 'dead_letter',
        message_id = NULL,
        queue_item_id = NULL,
        attempt_count = 0,
        next_attempt_at = NULL,
        last_attempt_at = NULL,
        last_error = ?,
        dead_lettered_at = ?,
        created_at = ?,
        accepted_at = NULL
    WHERE id = ? AND status = 'pending'
  `).run(
    `quarantined-target:${safeId}`,
    `quarantined-source:${safeId}`,
    `quarantined-attempt:${safeId}`,
    JSON.stringify({ message: '', displayMessage: '' }),
    diagnostic,
    Date.now(),
    new Date().toISOString(),
    row.id,
  );
}

export function listDeadLetterSessionDeliveries(): import("../shared/types.js").SessionDeliveryDeadLetter[] {
  const rows = initDb()
    .prepare(`${CALLBACK_DELIVERY_SELECT} WHERE status = 'dead_letter' ORDER BY dead_lettered_at ASC, created_at ASC, id ASC`)
    .all() as SessionDeliveryRow[];
  return rows.map((row) => {
    try {
      return { ...sessionDeliveryFromRow(row), payloadError: null };
    } catch (error) {
      return {
        ...row,
        payload: null,
        payloadError: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** Atomically return one valid exhausted receipt to the live outbox. The
 * durable identity and id are retained; accepted rows are immutable. */
export function requeueDeadLetterSessionDelivery(deliveryId: string): SessionDelivery {
  const database = initDb();
  const requeue = database.transaction(() => {
    const row = database.prepare(`${CALLBACK_DELIVERY_SELECT} WHERE id = ?`).get(deliveryId) as SessionDeliveryRow | undefined;
    if (!row) throw new Error(`Callback delivery ${deliveryId} not found`);
    if (row.status !== 'dead_letter') {
      throw new Error(`Callback delivery ${deliveryId} is not dead-lettered`);
    }
    // Permanent poison must stay quarantined until its stored data is repaired.
    sessionDeliveryFromRow(row);
    const updated = database.prepare(`
      UPDATE callback_deliveries
      SET status = 'pending',
          attempt_count = 0,
          next_attempt_at = NULL,
          last_attempt_at = NULL,
          last_error = NULL,
          dead_lettered_at = NULL
      WHERE id = ? AND status = 'dead_letter'
    `).run(deliveryId);
    if (updated.changes !== 1) throw new Error(`Callback delivery ${deliveryId} lost its dead-letter claim`);
    return getSessionDelivery(deliveryId)!;
  });
  return requeue.immediate();
}

/** Persist the callback intent before any HTTP enqueue/send. The composite
 * unique index is the concurrency arbiter; losers reuse the winning outbox id. */
export function claimSessionDelivery(
  input: SessionDeliveryIdentity & { payload: SessionDeliveryPayload },
): { delivery: SessionDelivery; claimed: boolean } {
  const identity = canonicalSessionDeliveryIdentity(input);
  validateSessionDeliveryIdentity(identity);
  if (typeof input.payload.message !== 'string' || typeof input.payload.displayMessage !== 'string') {
    throw new Error('callback delivery payload requires message and displayMessage');
  }
  const database = initDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const result = database.prepare(`
    INSERT INTO callback_deliveries (
      id,
      target_session_id,
      source_kind,
      source_id,
      source_attempt,
      source_outcome,
      source_version,
      delivery_kind,
      payload,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT DO NOTHING
  `).run(
    id,
    identity.targetSessionId,
    identity.sourceKind,
    identity.sourceId,
    identity.sourceAttempt,
    identity.sourceOutcome,
    identity.sourceVersion,
    identity.deliveryKind,
    JSON.stringify(input.payload),
    createdAt,
  );
  const delivery = result.changes === 1
    ? getSessionDelivery(id)
    : sessionDeliveryFromRow(database.prepare(`
        ${CALLBACK_DELIVERY_SELECT}
        WHERE target_session_id = ?
          AND source_kind = ?
          AND source_id = ?
          AND source_attempt = ?
          AND source_outcome = ?
          AND source_version = ?
          AND delivery_kind = ?
      `).get(
        identity.targetSessionId,
        identity.sourceKind,
        identity.sourceId,
        identity.sourceAttempt,
        identity.sourceOutcome,
        identity.sourceVersion,
        identity.deliveryKind,
      ) as SessionDeliveryRow);
  if (!delivery) throw new Error('Callback delivery claim was not persisted');
  return { delivery, claimed: result.changes === 1 };
}

/**
 * Claim one source-bound delivery without letting that source exceed a durable
 * delivery budget. The source attempt is checked first without the target, so
 * retrying after a newer target appears reuses the original receipt.
 */
export function claimSessionDeliveryWithinSourceLimit(
  input: SessionDeliveryIdentity & { payload: SessionDeliveryPayload },
  maxDeliveries: number,
): { delivery?: SessionDelivery; claimed: boolean; capped: boolean } {
  if (!Number.isInteger(maxDeliveries) || maxDeliveries < 1) {
    throw new Error('maxDeliveries must be a positive integer');
  }
  const identity = canonicalSessionDeliveryIdentity(input);
  validateSessionDeliveryIdentity(identity);
  if (typeof input.payload.message !== 'string' || typeof input.payload.displayMessage !== 'string') {
    throw new Error('callback delivery payload requires message and displayMessage');
  }
  const database = initDb();
  const claim = database.transaction(() => {
    const existing = database.prepare(`
      ${CALLBACK_DELIVERY_SELECT}
      WHERE source_kind = ?
        AND source_id = ?
        AND source_attempt = ?
        AND source_outcome = ?
        AND source_version = ?
        AND delivery_kind = ?
      ORDER BY created_at, id
      LIMIT 1
    `).get(
      identity.sourceKind,
      identity.sourceId,
      identity.sourceAttempt,
      identity.sourceOutcome,
      identity.sourceVersion,
      identity.deliveryKind,
    ) as SessionDeliveryRow | undefined;
    if (existing) {
      return { delivery: sessionDeliveryFromRow(existing), claimed: false, capped: false };
    }
    const count = Number(database.prepare(`
      SELECT COUNT(*)
      FROM callback_deliveries
      WHERE source_kind = ?
        AND source_id = ?
        AND source_outcome = ?
        AND delivery_kind = ?
    `).pluck().get(
      identity.sourceKind,
      identity.sourceId,
      identity.sourceOutcome,
      identity.deliveryKind,
    ));
    if (count >= maxDeliveries) return { claimed: false, capped: true };
    return { ...claimSessionDelivery(input), capped: false };
  });
  return claim.immediate();
}

/** Lease one due pending receipt before network I/O. The lease itself is stored
 * in next_attempt_at, so duplicate emitters and retry sweeps cannot concurrently
 * spend multiple retry attempts for the same durable identity. */
export function claimSessionDeliveryAttempt(
  deliveryId: string,
  now: number,
  leaseMs: number,
): SessionDelivery | undefined {
  const database = initDb();
  const result = database.prepare(`
    UPDATE callback_deliveries
    SET attempt_count = attempt_count + 1,
        last_attempt_at = ?,
        next_attempt_at = ?,
        last_error = NULL
    WHERE id = ?
      AND status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  `).run(now, now + Math.max(1, leaseMs), deliveryId, now);
  return result.changes === 1 ? getSessionDelivery(deliveryId) : undefined;
}

export function recordSessionDeliveryFailure(
  deliveryId: string,
  error: string,
  options: { now: number; nextAttemptAt: number; maxAttempts: number },
): SessionDelivery | undefined {
  const database = initDb();
  const update = database.transaction(() => {
    const row = database.prepare(`${CALLBACK_DELIVERY_SELECT} WHERE id = ?`).get(deliveryId) as SessionDeliveryRow | undefined;
    if (!row) return undefined;
    if (row.status !== 'pending') return sessionDeliveryFromRow(row);
    if (row.attemptCount >= options.maxAttempts) {
      database.prepare(`
        UPDATE callback_deliveries
        SET status = 'dead_letter', next_attempt_at = NULL, last_error = ?, dead_lettered_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(error, options.now, deliveryId);
    } else {
      database.prepare(`
        UPDATE callback_deliveries
        SET next_attempt_at = ?, last_error = ?
        WHERE id = ? AND status = 'pending'
      `).run(options.nextAttemptAt, error, deliveryId);
    }
    return getSessionDelivery(deliveryId);
  });
  return update();
}

/** Atomically turn one pending outbox row into the parent notification message
 * and its restart-safe internal queue intent. Accepted retries return the same
 * ids without inserting, emitting, or waking anything again. */
export function acceptSessionDelivery(
  deliveryId: string,
  targetSessionId: string,
  sessionKey: string,
): { delivery: SessionDelivery; accepted: boolean } {
  const database = initDb();
  const accept = database.transaction(() => {
    const row = database.prepare(`${CALLBACK_DELIVERY_SELECT} WHERE id = ?`).get(deliveryId) as SessionDeliveryRow | undefined;
    if (!row) throw new Error(`Callback delivery ${deliveryId} not found`);
    if (row.targetSessionId !== targetSessionId) throw new Error('Session delivery target mismatch');
    if (row.status === 'accepted') return { delivery: sessionDeliveryFromRow(row), accepted: false };
    if (row.status === 'dead_letter') throw new Error(`Callback delivery ${deliveryId} is dead-lettered`);

    const delivery = sessionDeliveryFromRow(row);
    const queueItemId = randomUUID();
    const messageId = uuidv4();
    const now = new Date().toISOString();
    const position = (database.prepare(
      "SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM queue_items WHERE session_key = ? AND status = 'pending'",
    ).get(sessionKey) as { pos: number }).pos;
    database.prepare(`
      INSERT INTO queue_items (
        id, session_id, session_key, prompt, status, internal, position, created_at
      ) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)
    `).run(queueItemId, targetSessionId, sessionKey, delivery.payload.message, position, now);
    database.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, meta)
      VALUES (?, ?, 'notification', ?, ?, ?)
    `).run(
      messageId,
      targetSessionId,
      delivery.payload.displayMessage,
      Date.now(),
      delivery.payload.meta ? JSON.stringify(delivery.payload.meta) : null,
    );
    if (delivery.payload.block) applyBlockEnvelope(targetSessionId, delivery.payload.block);
    const updated = database.prepare(`
      UPDATE callback_deliveries
      SET status = 'accepted', message_id = ?, queue_item_id = ?, accepted_at = ?,
          next_attempt_at = NULL, last_error = NULL
      WHERE id = ? AND status = 'pending'
    `).run(messageId, queueItemId, now, deliveryId);
    if (updated.changes !== 1) throw new Error(`Callback delivery ${deliveryId} lost its pending claim`);
    return { delivery: getSessionDelivery(deliveryId)!, accepted: true };
  });
  return accept();
}

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  internal: boolean;
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface QueueItemRow extends Omit<QueueItem, "internal"> {
  internal: number;
}

function rowToQueueItem(row: QueueItemRow): QueueItem {
  return { ...row, internal: row.internal === 1 };
}

const QUEUE_ITEM_SELECT =
  "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, internal, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items";

export function enqueueQueueItem(
  sessionId: string,
  sessionKey: string,
  prompt: string,
  options: { internal?: boolean } = {},
): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, internal, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, options.internal ? 1 : 0, position, new Date().toISOString());
  return id;
}

export function markQueueItemRunning(itemId: string): boolean {
  const db = initDb();
  return db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), itemId).changes === 1;
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function markRunningQueueItemsCompletedForSession(sessionId: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'completed', completed_at = ? WHERE session_id = ? AND status = 'running'"
  ).run(new Date().toISOString(), sessionId);
  return result.changes;
}

export function getQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  const row = db.prepare(`${QUEUE_ITEM_SELECT} WHERE id = ?`).get(itemId) as QueueItemRow | undefined;
  return row ? rowToQueueItem(row) : undefined;
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE session_key = ? AND internal = 0 AND status IN ('pending', 'running') ORDER BY position ASC`
  ).all(sessionKey) as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND internal = 0 AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  // If the gateway restarts mid-run, move any "running" items back to "pending"
  // so they can be replayed. Do NOT cancel pending work.
  const result = db.prepare(
    `UPDATE queue_items
     SET status = 'pending', started_at = NULL
     WHERE status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE sessions.id = queue_items.session_id
           AND sessions.workflow_kind IS NOT NULL
       )`
  ).run();
  return result.changes;
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE status = 'pending' ORDER BY created_at ASC, position ASC`
  ).all() as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

export function claimWorkflowAttemptDispatch(sessionId: string, sessionKey: string, prompt: string): string | null {
  const db = initDb(); return db.transaction(() => {
    const session = db.prepare(`SELECT id FROM sessions WHERE id = ? AND session_key = ?
      AND workflow_kind = 'phase' AND status = 'idle'
      AND (attempt_outcome IS NULL OR attempt_outcome = 'succeeded')`).get(sessionId, sessionKey);
    if (!session) return null;
    const existing = db.prepare(`${QUEUE_ITEM_SELECT} WHERE session_id = ? AND internal = 1 AND status IN ('pending', 'running') ORDER BY created_at, position LIMIT 1`).get(sessionId) as QueueItemRow | undefined;
    if (existing && (existing.sessionKey !== sessionKey || existing.prompt !== prompt)) throw new Error(`Workflow session ${sessionId} dispatch claim does not match its immutable command.`);
    if (existing?.status === 'running') return null; const itemId = existing?.id ?? enqueueQueueItem(sessionId, sessionKey, prompt, { internal: true });
    return itemId; }).immediate();
}
export function cancelWorkflowAttemptDispatch(sessionId: string): number { return initDb().prepare(`UPDATE queue_items SET status = 'cancelled' WHERE session_id = ? AND internal = 1 AND status IN ('pending', 'running')`).run(sessionId).changes; }
export function listPendingWorkflowAttemptDispatches(): QueueItem[] {
  return (initDb().prepare(`${QUEUE_ITEM_SELECT} WHERE status = 'pending' AND internal = 1
    AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = queue_items.session_id
      AND sessions.workflow_kind = 'phase' AND sessions.status = 'idle'
      AND (sessions.attempt_outcome IS NULL OR sessions.attempt_outcome = 'succeeded'))
    ORDER BY created_at, position`).all() as QueueItemRow[]).map(rowToQueueItem);
}
// ── File management ──────────────────────────────────────────────────

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  createdAt: string;
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: { id: string; filename: string; size: number; mimetype: string | null; path: string | null }): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (id, filename, size, mimetype, path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    meta.id, meta.filename, meta.size, meta.mimetype, meta.path, now,
  );
  return { ...meta, createdAt: now };
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Update the recorded on-disk path for a file (used when re-homing into the uploads dir). */
export function setFilePath(id: string, filePath: string): void {
  const db = initDb();
  db.prepare('UPDATE files SET path = ? WHERE id = ?').run(filePath, id);
}

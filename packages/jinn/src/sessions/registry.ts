import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../shared/logger.js';
import { initDb } from '../shared/db.js';
import { stripControlChars } from '../shared/sanitize.js';
import { getMeta, setMeta, canonicalCallbackIdentityText, canonicalSessionDeliveryIdentity, sessionDeliveryFromRow, validateSessionDeliveryIdentity, type SessionDeliveryRow } from './migrate.js';
import { parseTodoId } from '../work-items/id.js';
import type { ChatBlock, ChatBlockEnvelope, EngineSessionRef, EngineSessionRefs, JsonObject, ReplyContext, Session, SessionAttemptOutcome, SessionDelivery, SessionDeliveryIdentity, SessionDeliveryPayload, WorkflowAttemptInterruptionCause, WorkflowSessionProvenance } from '../shared/types.js';
import { blockFallbackText, mergeBlock, validateBlockEnvelope } from '../shared/blocks.js';
import { ptySnapshotStore } from '../engines/pty-snapshot.js';

export const RESTART_ACK_META_KEY = "restartAcknowledgedAt";
/** Stamped on a session the gateway itself interrupted, so the next boot can tell it apart from one that was already idle. Consumed in sessions/restart-resume.ts. */
export const RESTART_RESUME_META_KEY = "restartInterruptedAt";
export const GATEWAY_RESTARTED_MESSAGE = "Gateway restarted successfully.";

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
 * Atomically claim the next delegation-completion nudge. The JSON guard and its compare predicate live in one
 * SQLite UPDATE, so two duplicate idle callbacks cannot both observe the same count and both win. The observed
 * count reads 0 for another work item or none and 1 for a guard written before it; a surfaced guard never matches.
 */
export function claimDelegationCompletionNudge(id: string, workItemId: string, sentNudges = 0): Session | undefined {
  const db = initDb();
  const todoId = parseTodoId(workItemId);
  const result = db.prepare(`
    UPDATE sessions
    SET transport_meta = json_set(
      COALESCE(transport_meta, '{}'),
      '$.delegationCompletionContract',
      json_object('workItemId', ?, 'state', 'nudged', 'nudges', ?)
    )
    WHERE id = ?
      AND ? = CASE WHEN COALESCE(json_extract(transport_meta, '$.delegationCompletionContract.workItemId'), '') <> ? THEN 0
        WHEN json_extract(transport_meta, '$.delegationCompletionContract.state') <> 'nudged' THEN -1
        ELSE COALESCE(json_extract(transport_meta, '$.delegationCompletionContract.nudges'), 1) END
  `).run(todoId, sentNudges + 1, id, sentNudges, todoId);
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

/** Roll back only the nudge this caller claimed, to the count that preceded it: a failed first nudge leaves no guard, a failed second leaves the first standing. */
export function releaseDelegationCompletionNudge(id: string, workItemId: string, sentNudges = 0): Session | undefined {
  const db = initDb();
  const todoId = parseTodoId(workItemId);
  const result = db.prepare(`
    UPDATE sessions
    SET transport_meta = CASE WHEN ? = 0 THEN json_remove(transport_meta, '$.delegationCompletionContract') ELSE json_set(transport_meta, '$.delegationCompletionContract.nudges', ?) END
    WHERE id = ?
      AND json_extract(transport_meta, '$.delegationCompletionContract.workItemId') = ?
      AND ? = CASE WHEN json_extract(transport_meta, '$.delegationCompletionContract.state') = 'nudged' THEN COALESCE(json_extract(transport_meta, '$.delegationCompletionContract.nudges'), 1) ELSE -1 END
  `).run(sentNudges, sentNudges, id, todoId, sentNudges + 1);
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
 * Returns undefined when a stop/reset/newer turn has taken ownership. A fields
 * producer runs inside the fence, so its merge cannot outlive a rejected write. */
export function updateSessionForAttempt(
  id: string,
  attemptToken: string,
  updates: UpdateSessionFields | ((current: Session) => UpdateSessionFields),
  expectedStatuses: readonly Session['status'][] = ['running'],
): Session | undefined {
  if (expectedStatuses.length === 0) return undefined;
  const database = initDb();
  const before = getSession(id);
  if (!before || before.attemptToken !== attemptToken || !expectedStatuses.includes(before.status)) return undefined;

  const tx = database.transaction(() => {
    const current = getSession(id);
    if (!current || current.attemptToken !== attemptToken || !expectedStatuses.includes(current.status)) return undefined;
    return updateSession(id, typeof updates === 'function' ? updates(current) : updates);
  });
  return tx();
}

/** Terminal attempt receipt. Only the same generation while actively running
 * may settle; an interrupted row is therefore immutable to late success. */
export function completeSessionAttempt(
  id: string,
  attemptToken: string,
  updates: UpdateSessionFields | ((current: Session) => UpdateSessionFields),
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
    if (!stored.id && session.engineSessionId && !session.transportMeta?.engineOverride) stored.id = session.engineSessionId; // a live override parks the PREVIOUS engine's id in the mirror
    if (!stored.model && session.model) stored.model = session.model;
    if (!stored.effortLevel && session.effortLevel) stored.effortLevel = session.effortLevel;
  }
  return stored;
}

/** The fields a recorded native id merges into a session, without writing them.
 * Exposed so a caller that must not race folds the merge into its own fence. */
export function nextEngineSessionFields(
  session: Session,
  engine: string,
  nativeId: string,
  meta: Omit<EngineSessionRef, 'id'> = {},
): UpdateSessionFields {
  const id = nativeId.trim();
  if (!engine || !id) return {};
  const next = cleanEngineSessionRef({ ...getEngineSessionRef(session, engine), ...meta, id });
  const updates: UpdateSessionFields = { engineSessions: { ...cleanEngineSessionRefs(session.engineSessions), [engine]: next } };
  if (session.engine === engine) updates.engineSessionId = next.id ?? null;
  return updates;
}

export function recordEngineSessionId(
  sessionId: string,
  engine: string,
  nativeId: string,
  meta: Omit<EngineSessionRef, 'id'> = {},
): Session | undefined {
  const session = getSession(sessionId);
  const updates = session ? nextEngineSessionFields(session, engine, nativeId, meta) : {};
  return updates.engineSessions ? updateSession(sessionId, updates) : session;
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

/**
 * Every session id in the registry — archived and workflow-phase rows included.
 * Retention sweeps over per-session on-disk state must use this rather than
 * `listSessions`, whose `archived_at IS NULL AND workflow_kind IS NULL` filter is
 * a display concern: to a sweep an absent id means "delete that session's data",
 * and both of those kinds still resume.
 */
export function listAllSessionIds(): string[] {
  const rows = initDb().prepare('SELECT id FROM sessions').all() as { id: string }[];
  return rows.map((row) => row.id);
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

/** Search across ALL sessions by identity, title, or settled message text. */
export function searchSessions(query: string, limit = 100): Session[] {
  const db = initDb();
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE title LIKE ? ESCAPE '\\' OR employee LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id AND messages.content LIKE ? ESCAPE '\\')
       ORDER BY last_activity DESC LIMIT ?`,
    )
    .all(like, like, like, like, limit) as Record<string, unknown>[];
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
 * idx_sessions_work_item. The read-back half of the work-item slice
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

/** Mark any sessions stuck in "running" status as "interrupted". Called on gateway startup — if the
 * gateway is starting, no sessions can actually be running. Sessions with an engine_session_id can be
 * resumed via the Claude --resume flag, so each one is stamped for the restart resume nudge as well.
 */
export function recoverStaleSessions(): number {
  const db = initDb();
  const now = new Date().toISOString();
  return db.prepare(
    `UPDATE sessions SET status = 'interrupted', attempt_outcome = 'interrupted', attempt_terminal_version = attempt_terminal_version + 1, last_activity = ?, transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${RESTART_RESUME_META_KEY}', ?), last_error = 'Interrupted: gateway restarted while session was running' WHERE status = 'running' AND workflow_kind IS NULL`,
  ).run(now, now).changes;
}

/** Settle workflow attempts whose engine process was lost with the old gateway. The cause is stamped over any same-turn marker — that turn died with the gateway, it did not end on a message — and is what lets the runtime replace the attempt rather than spend its retry budget (see workflows/restart-redispatch.ts). */
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
        attempt_interruption_cause = 'gateway-restart',
        attempt_interruption_turn = MAX(attempt_turn, 1),
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
 * Called from exactly one place: settleTurn, in sessions/turn/completion.ts.
 * It exists because two session runners once kept their own copies of the
 * completion sequence and drifted — the web runner had three completion sites
 * and none accumulated, so every web- and talk-sourced session recorded
 * total_turns = 0 and total_cost = 0, silently disabling the employee budget
 * caps enforced from SUM(total_cost). Both runners now settle through
 * settleTurn; a caller anywhere else is the second copy that opened the hole.
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
  type: 'image' | 'audio' | 'video' | 'file';
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
  /** Displayed pixel size of an image, so the client can reserve its box before
   * the bytes arrive. Absent when nothing measured it. */
  width?: number;
  height?: number;
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

const COMPLETION_BATCH_MAX_ITEMS = 32;
const COMPLETION_BATCH_MAX_CHARS = 128_000;

/**
 * Build one engine-facing turn from immutable completion receipts that arrived
 * while the target was already busy. The receipts and their transcript banners
 * remain separate; only the expensive engine dispatch is shared.
 */
function completionBatchPrompt(deliveries: readonly SessionDelivery[]): string {
  if (deliveries.length === 1) return deliveries[0]!.payload.message;
  const updates = deliveries.map((delivery, index) =>
    `--- Completion update ${index + 1} of ${deliveries.length} ---\n${delivery.payload.message}`,
  );
  return [
    `📬 ${deliveries.length} durable completion updates accumulated while this session was busy. ` +
      "Review every update below together; each original receipt and transcript message remains intact.",
    ...updates,
  ].join("\n\n");
}

function pendingCompletionBatch(
  database: Database.Database,
  delivery: SessionDelivery,
  targetSessionId: string,
  sessionKey: string,
): { queueItemId: string; prompt: string } | undefined {
  if (delivery.deliveryKind !== "parent-completion") return undefined;
  // A newly accepted callback belongs at the tail. Only fold it into the
  // existing tail row: reaching past an intervening operator/workflow turn
  // would reorder work even though the queue positions stayed unchanged.
  const candidate = database.prepare(`
    SELECT q.id
    FROM queue_items q
    WHERE q.session_id = ?
      AND q.session_key = ?
      AND q.status = 'pending'
    ORDER BY q.position DESC, q.created_at DESC, q.rowid DESC
    LIMIT 1
  `).get(targetSessionId, sessionKey) as { id: string } | undefined;
  if (!candidate) return undefined;
  const kinds = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'accepted' AND delivery_kind = 'parent-completion' THEN 1 ELSE 0 END) AS completions
    FROM callback_deliveries
    WHERE queue_item_id = ?
  `).get(candidate.id) as { total: number; completions: number | null };
  if (kinds.total === 0 || kinds.completions !== kinds.total) return undefined;
  const rows = database.prepare(`
    ${CALLBACK_DELIVERY_SELECT}
    WHERE queue_item_id = ?
      AND status = 'accepted'
      AND delivery_kind = 'parent-completion'
    ORDER BY (
      SELECT m.rowid FROM messages m WHERE m.id = callback_deliveries.message_id
    ), callback_deliveries.rowid
  `).all(candidate.id) as SessionDeliveryRow[];
  const existing = rows.map(sessionDeliveryFromRow);
  if (existing.length >= COMPLETION_BATCH_MAX_ITEMS) return undefined;
  // `delivery` is being accepted by this transaction now, so append it after
  // every already-accepted row even when their wall-clock timestamps collide.
  const prompt = completionBatchPrompt([...existing, delivery]);
  return prompt.length <= COMPLETION_BATCH_MAX_CHARS
    ? { queueItemId: candidate.id, prompt }
    : undefined;
}

interface PendingQueueOrderRow {
  id: string;
  sessionId: string;
  sessionKey: string;
  position: number;
  createdAt: string;
  completionCount: number;
  deliveryCount: number;
}

function packCompletionDeliveries(deliveries: readonly SessionDelivery[]): SessionDelivery[][] {
  const batches: SessionDelivery[][] = [];
  let current: SessionDelivery[] = [];
  for (const delivery of deliveries) {
    const candidate = [...current, delivery];
    if (current.length > 0 && (
      candidate.length > COMPLETION_BATCH_MAX_ITEMS
      || completionBatchPrompt(candidate).length > COMPLETION_BATCH_MAX_CHARS
    )) {
      batches.push(current);
      current = [delivery];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Upgrade/restart repair for the pre-batching durable shape. Only contiguous
 * pending completion rows are compacted, so an operator, workflow, approval or
 * other callback row remains an ordering fence. Superseded queue rows are kept
 * as cancelled evidence; every receipt and transcript message stays intact.
 */
export function coalescePendingParentCompletionQueueItems(): number {
  const database = initDb();
  return database.transaction(() => {
    const rows = database.prepare(`
      SELECT
        q.id,
        q.session_id AS sessionId,
        q.session_key AS sessionKey,
        q.position,
        q.created_at AS createdAt,
        COUNT(d.id) AS deliveryCount,
        SUM(CASE WHEN d.status = 'accepted' AND d.delivery_kind = 'parent-completion' THEN 1 ELSE 0 END) AS completionCount
      FROM queue_items q
      LEFT JOIN callback_deliveries d ON d.queue_item_id = q.id
      WHERE q.status = 'pending'
      GROUP BY q.id
      ORDER BY q.session_key, q.position, q.created_at, q.rowid
    `).all() as PendingQueueOrderRow[];

    let compacted = 0;
    let run: PendingQueueOrderRow[] = [];
    const flush = () => {
      if (run.length < 2) {
        run = [];
        return;
      }
      const placeholders = run.map(() => "?").join(", ");
      const orderedIds = database.prepare(`
        SELECT d.id
        FROM callback_deliveries d
        JOIN queue_items q ON q.id = d.queue_item_id
        LEFT JOIN messages m ON m.id = d.message_id
        WHERE d.queue_item_id IN (${placeholders})
          AND d.status = 'accepted'
          AND d.delivery_kind = 'parent-completion'
        ORDER BY q.position, q.created_at, q.rowid, m.rowid, d.rowid
      `).all(...run.map((row) => row.id)) as Array<{ id: string }>;
      const read = database.prepare(`${CALLBACK_DELIVERY_SELECT} WHERE id = ?`);
      const deliveries = orderedIds.map(({ id }) =>
        sessionDeliveryFromRow(read.get(id) as SessionDeliveryRow),
      );
      const batches = packCompletionDeliveries(deliveries);
      // Every supported historical row held at least one delivery. Refuse an
      // unexpected overfilled shape rather than deleting evidence to make room.
      if (batches.length > run.length) {
        run = [];
        return;
      }
      const canonicalIds = new Set<string>();
      for (const [index, batch] of batches.entries()) {
        const canonicalId = run[index]!.id;
        canonicalIds.add(canonicalId);
        database.prepare("UPDATE queue_items SET prompt = ? WHERE id = ? AND status = 'pending'")
          .run(completionBatchPrompt(batch), canonicalId);
        const deliveryIds = batch.map((delivery) => delivery.id);
        database.prepare(`
          UPDATE callback_deliveries
          SET queue_item_id = ?
          WHERE id IN (${deliveryIds.map(() => "?").join(", ")})
            AND status = 'accepted'
        `).run(canonicalId, ...deliveryIds);
      }
      for (const row of run) {
        if (canonicalIds.has(row.id)) continue;
        compacted += database.prepare(
          "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
        ).run(row.id).changes;
      }
      run = [];
    };

    for (const row of rows) {
      const exactCompletion = row.deliveryCount > 0 && row.deliveryCount === row.completionCount;
      const sameRun = run.length === 0
        || (run[0]!.sessionId === row.sessionId && run[0]!.sessionKey === row.sessionKey);
      if (!exactCompletion || !sameRun) flush();
      if (exactCompletion) run.push(row);
    }
    flush();
    return compacted;
  }).immediate();
}

function nextPendingQueueItemIsParentCompletion(database: Database.Database, sessionId: string): boolean {
  return Boolean(database.prepare(`
    SELECT 1
    FROM queue_items q
    WHERE q.id = (
      SELECT next.id
      FROM queue_items next
      WHERE next.session_id = ?
        AND next.status = 'pending'
      ORDER BY next.position, next.created_at, next.rowid
      LIMIT 1
    )
      AND EXISTS (
        SELECT 1 FROM callback_deliveries d
        WHERE d.queue_item_id = q.id
          AND d.status = 'accepted'
          AND d.delivery_kind = 'parent-completion'
      )
      AND NOT EXISTS (
        SELECT 1 FROM callback_deliveries d
        WHERE d.queue_item_id = q.id
          AND (d.status <> 'accepted' OR d.delivery_kind <> 'parent-completion')
      )
  `).get(sessionId));
}

function runningQueueItemIsParentCompletion(database: Database.Database, sessionId: string): boolean {
  return Boolean(database.prepare(`
    SELECT 1
    FROM queue_items q
    WHERE q.session_id = ?
      AND q.status = 'running'
      AND EXISTS (
        SELECT 1 FROM callback_deliveries d
        WHERE d.queue_item_id = q.id
          AND d.status = 'accepted'
          AND d.delivery_kind = 'parent-completion'
      )
      AND NOT EXISTS (
        SELECT 1 FROM callback_deliveries d
        WHERE d.queue_item_id = q.id
          AND (d.status <> 'accepted' OR d.delivery_kind <> 'parent-completion')
      )
    LIMIT 1
  `).get(sessionId));
}

function sourceCompletionIsDraining(
  database: Database.Database,
  sourceSessionId: string,
  targetQueueItemId: string,
): boolean {
  if (nextPendingQueueItemIsParentCompletion(database, sourceSessionId)) return true;
  if (!runningQueueItemIsParentCompletion(database, sourceSessionId)) return false;
  const source = database.prepare(
    "SELECT attempt_token AS attemptToken FROM sessions WHERE id = ?",
  ).get(sourceSessionId) as { attemptToken: string | null } | undefined;
  if (!source?.attemptToken) return true;
  const currentTurnReported = database.prepare(`
    SELECT 1
    FROM callback_deliveries
    WHERE queue_item_id = ?
      AND status = 'accepted'
      AND delivery_kind = 'parent-completion'
      AND source_kind = 'session'
      AND source_id = ?
      AND source_attempt = ?
    LIMIT 1
  `).get(targetQueueItemId, sourceSessionId, source.attemptToken);
  return !currentTurnReported;
}

/**
 * Hold an accepted upstream completion batch while one of its source sessions
 * has newer completion input durably next in line. The receipts are already
 * accepted and visible; delaying only their engine dispatch lets the source's
 * final drain-boundary result join the same lossless parent turn. A different
 * queued work kind is a causal fence and never delays the relay.
 */
export function shouldHoldParentCompletionQueueDispatch(queueItemId: string): boolean {
  const database = initDb();
  const sources = database.prepare(`
    SELECT DISTINCT source_id AS sourceId, source_outcome AS sourceOutcome
    FROM callback_deliveries
    WHERE queue_item_id = ?
      AND status = 'accepted'
      AND delivery_kind = 'parent-completion'
      AND source_kind = 'session'
  `).all(queueItemId) as Array<{ sourceId: string; sourceOutcome: string }>;
  if (sources.some(({ sourceOutcome }) =>
    sourceOutcome === "failed" || sourceOutcome === "error" || sourceOutcome === "interrupted",
  )) return false;
  return sources.some(({ sourceId }) =>
    sourceCompletionIsDraining(database, sourceId, queueItemId),
  );
}

export function listReleasableParentCompletionQueuesForSource(sourceSessionId: string): Array<{
  queueItemId: string;
  sessionKey: string;
}> {
  const database = initDb();
  const rows = database.prepare(`
    SELECT DISTINCT q.id AS queueItemId, q.session_key AS sessionKey
    FROM queue_items q
    JOIN callback_deliveries d ON d.queue_item_id = q.id
    WHERE q.status = 'pending'
      AND d.status = 'accepted'
      AND d.delivery_kind = 'parent-completion'
      AND d.source_kind = 'session'
      AND d.source_id = ?
    ORDER BY q.position, q.created_at, q.rowid
  `).all(sourceSessionId) as Array<{ queueItemId: string; sessionKey: string }>;
  return rows.filter(({ queueItemId }) => !shouldHoldParentCompletionQueueDispatch(queueItemId));
}

/** Atomically turn one pending outbox row into the parent notification message
 * and its restart-safe internal queue intent. Accepted retries return the same
 * ids without inserting, emitting, or waking anything again. Completion
 * receipts may share a bounded pending row: this preserves every receipt and
 * banner while preventing a settled backlog from spawning one engine per row. */
export function acceptSessionDelivery(
  deliveryId: string,
  targetSessionId: string,
  sessionKey: string,
): { delivery: SessionDelivery; accepted: boolean; queueCreated: boolean } {
  const database = initDb();
  const accept = database.transaction(() => {
    const row = database.prepare(`${CALLBACK_DELIVERY_SELECT} WHERE id = ?`).get(deliveryId) as SessionDeliveryRow | undefined;
    if (!row) throw new Error(`Callback delivery ${deliveryId} not found`);
    if (row.targetSessionId !== targetSessionId) throw new Error('Session delivery target mismatch');
    if (row.status === 'accepted') return { delivery: sessionDeliveryFromRow(row), accepted: false, queueCreated: false };
    if (row.status === 'dead_letter') throw new Error(`Callback delivery ${deliveryId} is dead-lettered`);

    const delivery = sessionDeliveryFromRow(row);
    const batch = pendingCompletionBatch(database, delivery, targetSessionId, sessionKey);
    const queueItemId = batch?.queueItemId ?? randomUUID();
    const messageId = uuidv4();
    const now = new Date().toISOString();
    if (batch) {
      const updated = database.prepare(
        "UPDATE queue_items SET prompt = ? WHERE id = ? AND status = 'pending'",
      ).run(batch.prompt, batch.queueItemId);
      if (updated.changes !== 1) throw new Error(`Callback completion batch ${batch.queueItemId} lost its pending claim`);
    } else {
      const position = (database.prepare(
        "SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM queue_items WHERE session_key = ? AND status = 'pending'",
      ).get(sessionKey) as { pos: number }).pos;
      database.prepare(`
        INSERT INTO queue_items (
          id, session_id, session_key, prompt, status, internal, position, created_at
        ) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)
      `).run(queueItemId, targetSessionId, sessionKey, delivery.payload.message, position, now);
    }
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
    return { delivery: getSessionDelivery(deliveryId)!, accepted: true, queueCreated: !batch };
  });
  return accept();
}

// ── Queue items ──────────────────────────────────────────────────────
// Kept re-exported here so the many callers that reach for the turn queue
// through the registry keep working; the rows themselves live in
// queue-item-registry.ts.
export {
  enqueueQueueItem, markQueueItemRunning, markQueueItemCompleted, markRunningQueueItemsCompletedForSession,
  getQueueItem, cancelQueueItem, getQueueItems, cancelAllPendingQueueItems, recoverStaleQueueItems,
  listAllPendingQueueItems, claimWorkflowAttemptDispatch, cancelWorkflowAttemptDispatch,
  listPendingWorkflowAttemptDispatches, editPendingQueueItem, reassignPendingQueuePayloads, type QueueItem,
} from './queue-item-registry.js';
// ── File management ──────────────────────────────────────────────────
// Kept re-exported here so the many callers that reach for a file through the
// registry keep working; the rows themselves live in file-registry.ts.
export { insertFile, getFile, listFiles, deleteFile, setFilePath, type FileMeta } from './file-registry.js';

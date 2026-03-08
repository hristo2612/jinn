import path from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SESSIONS_DB } from '../shared/paths.js';
import type { Session } from '../shared/types.js';

let db: Database.Database;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  employee TEXT,
  model TEXT,
  title TEXT,
  parent_session_id TEXT,
  status TEXT DEFAULT 'idle',
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

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    source: row.source as string,
    sourceRef: row.source_ref as string,
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    title: (row.title as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    status: row.status as Session['status'],
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
  };
}

export function initDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  db = new Database(SESSIONS_DB);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE);
  db.exec(CREATE_MESSAGES_TABLE);
  db.exec(CREATE_MESSAGES_INDEX);

  // Migrate: add title column if missing
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('title')) {
    db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
  }
  if (!colNames.has('parent_session_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
  }

  return db;
}

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  employee?: string;
  model?: string;
  title?: string;
  parentSessionId?: string;
}

function generateTitle(employee?: string, prompt?: string): string {
  const name = employee || 'Jimmy';
  if (!prompt) return name;
  const cleaned = prompt.replace(/\n/g, ' ').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return name;
  const summary = cleaned.slice(0, 30).trim();
  return `${name} - ${summary}${cleaned.length > 30 ? '...' : ''}`;
}

export function createSession(opts: CreateSessionOpts & { prompt?: string }): Session {
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const title = opts.title ?? generateTitle(opts.employee, opts.prompt);

  const stmt = db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, employee, model, title, parent_session_id, status, created_at, last_activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `);
  stmt.run(id, opts.engine, opts.source, opts.sourceRef, opts.employee ?? null, opts.model ?? null, title, opts.parentSessionId ?? null, now, now);

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    title,
    parentSessionId: opts.parentSessionId ?? null,
    status: 'idle',
    createdAt: now,
    lastActivity: now,
    lastError: null,
  };
}

export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE source_ref = ? ORDER BY last_activity DESC LIMIT 1').get(sourceRef) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export interface UpdateSessionFields {
  engineSessionId?: string;
  status?: Session['status'];
  lastActivity?: string;
  lastError?: string | null;
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.engineSessionId !== undefined) {
    sets.push('engine_session_id = ?');
    values.push(updates.engineSessionId);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.lastActivity !== undefined) {
    sets.push('last_activity = ?');
    values.push(updates.lastActivity);
  }
  if (updates.lastError !== undefined) {
    sets.push('last_error = ?');
    values.push(updates.lastError);
  }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

export interface ListSessionsFilter {
  status?: Session['status'];
  source?: string;
  engine?: string;
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = [];
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
 * Mark any sessions stuck in "running" status as "idle".
 * Called on gateway startup — if the gateway is starting, no sessions can actually be running.
 */
export function recoverStaleSessions(): number {
  const db = initDb();
  const result = db.prepare("UPDATE sessions SET status = 'idle', last_error = 'Recovered: gateway restarted while session was running' WHERE status = 'running'").run();
  return result.changes;
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

export function insertMessage(sessionId: string, role: string, content: string): void {
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, role, content, Date.now());
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  return db.prepare('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as SessionMessage[];
}

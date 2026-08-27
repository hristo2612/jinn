import type { Database as DatabaseType } from "better-sqlite3";
import { CREATE_META_TABLE } from "../sessions/migrate.js";

/** ICI-1357: the Todos the operator keeps on Home.
 *
 *  Home used to be `created_by = 'operator'`, so a Todo an agent raised was
 *  reachable only from its department board. Keeping is the operator's gesture
 *  for "follow this one" — PLA-172 removed the auto-keep on create, because
 *  `created_by = 'operator'` is every caller holding the gateway credential
 *  rather than the operator's own hand, and Home filled up with work they never
 *  asked to follow. Since PLA-230 a pin is no longer the only thing on Home:
 *  the operator's own Todos join it as a term in `HOME_SCOPE_SQL`, read at
 *  query time. The explicit default is quick capture: its authenticated Shaper
 *  creation is pinned because capture means "keep this rough idea in Home"
 *  even when the operator chose Shape without dispatch.
 *
 *  Additive, never a column on `work_items`: the exact-shape verifier refuses
 *  any drift in an existing table, so a new table is the only extension a
 *  deployed database can survive.
 *
 *  Keyed by Todo alone, documented as the operator's. This gateway has one
 *  operator; a second one needs an actor column, which is a forward migration
 *  rather than a rewrite.
 *
 *  Every function takes the caller's `db` so it composes inside the caller's
 *  transaction — and so this module never imports the database opener, which
 *  would close a cycle back through `migrate.ts`. */
export const WORK_ITEM_KEPT_DDL = `
CREATE TABLE IF NOT EXISTS work_item_kept (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  kept_at      TEXT NOT NULL
)`;

/** Kept, as a correlated EXISTS that the list query AND-composes like any other
 *  filter. It lives here so the table's one reader in SQL sits with the table. */
export const KEPT_EXISTS_SQL = "EXISTS (SELECT 1 FROM work_item_kept k WHERE k.work_item_id = work_items.id)";

/** The Home board's whole scope (PLA-230): what the operator pinned, plus what
 *  they created. Parenthesised as one term so the OR survives AND-composition
 *  with every other filter the board sends. */
export const HOME_SCOPE_SQL = `(${KEPT_EXISTS_SQL} OR work_items.created_by = 'operator')`;

/** Keep a Todo; true when it was not already kept. Idempotent, and keeping a
 *  kept Todo leaves the original `kept_at` alone, so Home does not reshuffle
 *  when something re-keeps what is already there. */
export function keepWorkItem(db: DatabaseType, workItemId: string, at: string): boolean {
  return db
    .prepare("INSERT OR IGNORE INTO work_item_kept (work_item_id, kept_at) VALUES (?, ?)")
    .run(workItemId, at).changes > 0;
}

/** Set the Todo's kept state. Returns whether this changed anything, so a
 *  caller can audit a real change and stay silent about a repeat. */
export function setWorkItemKept(db: DatabaseType, workItemId: string, kept: boolean): boolean {
  if (kept) return keepWorkItem(db, workItemId, new Date().toISOString());
  return db.prepare("DELETE FROM work_item_kept WHERE work_item_id = ?").run(workItemId).changes > 0;
}

export function isWorkItemKept(db: DatabaseType, workItemId: string): boolean {
  return !!db.prepare("SELECT 1 FROM work_item_kept WHERE work_item_id = ?").get(workItemId);
}

/** Batch form for list payloads: ONE query for the whole page, never per item. */
export function keptSet(db: DatabaseType, workItemIds: string[]): Set<string> {
  if (workItemIds.length === 0) return new Set();
  const placeholders = workItemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT work_item_id FROM work_item_kept WHERE work_item_id IN (${placeholders})`)
    .pluck()
    .all(...workItemIds) as string[];
  return new Set(rows);
}

/** The key that marks the auto-keep cleanup done. Lives in `meta`, the
 *  registry's key/value store for one-off migration flags. */
const AUTO_KEEP_CLEARED_KEY = "work_item_kept_auto_keep_cleared";

/** One-shot: empty the kept set that auto-keep and its `created_by` backfill
 *  filled, so Home starts as nothing and holds what the operator pins.
 *
 *  Marked in `meta` rather than inferred from the table being new: the point of
 *  the flag is that a pin made after the cleanup survives the next boot. Every
 *  row this deletes was written by machinery PLA-172 removed — the pin shipped
 *  hours earlier and was invisible, so there is no hand-curated set to lose. */
export function clearAutoKeptOnce(db: DatabaseType): void {
  db.exec(CREATE_META_TABLE);
  if (db.prepare("SELECT 1 FROM meta WHERE key = ?").get(AUTO_KEEP_CLEARED_KEY)) return;
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_item_kept'").get();
  if (table) db.prepare("DELETE FROM work_item_kept").run();
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(AUTO_KEEP_CLEARED_KEY, "1");
}

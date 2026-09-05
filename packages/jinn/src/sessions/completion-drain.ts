import type Database from "better-sqlite3";
import { initDb } from "../shared/db.js";

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

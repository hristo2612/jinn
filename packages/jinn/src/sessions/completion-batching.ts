import type Database from "better-sqlite3";
import { initDb } from "../shared/db.js";
import type { SessionDelivery } from "../shared/types.js";
import { sessionDeliveryFromRow, type SessionDeliveryRow } from "./migrate.js";
import { CALLBACK_DELIVERY_SELECT } from "./callback-delivery-query.js";

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

export function pendingCompletionBatch(
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
      compacted += compactCompletionRun(database, run);
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

function compactCompletionRun(database: Database.Database, run: PendingQueueOrderRow[]): number {
  let compacted = 0;
  if (run.length < 2) {
    return 0;
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
    return 0;
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
  return compacted;
}

import {
  effectiveVerifyMode,
  getWorkItem,
  isBlockDeclared,
  listWorkItems,
  RECONCILER_ACTOR,
  STICKY_STATUSES,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from './store.js';
import { transitionDerived } from './transitions.js';
import { notifyTodoChanged } from './live-events.js';
import { listSessionsByWorkItem } from '../sessions/registry.js';
import { logger } from '../shared/logger.js';
import type { SessionAttemptOutcome } from '../shared/types.js';

/**
 * Work-item status reconciler (GRS-003a, elevated to the Todos vocabulary by
 * GRS-021a design §1.1).
 *
 * A work item's status is DERIVED from the terminal/recovery states of its
 * linked execution attempts (sessions), not from scattered ad-hoc writes. The
 * elevated rules:
 *
 *   - `done`/`cancelled`/`escalated` are STICKY. Closes are decisions; escalated
 *     is a deliberate routing to the operator — session churn never silently
 *     pulls an item off his queue.
 *   - ZERO linked sessions → untouched (`backlog`/`assigned` are never clobbered).
 *   - Any session in flight (`running`/`waiting`) → `executing`.
 *   - Newest attempt with an explicit `succeeded` receipt → `in_review` (the vision's "session completes →
 *     in_review, NOT done" made structural) — then the TRUST policy hook runs in
 *     the same pass: an item whose effective verify mode is `trust` auto-closes
 *     to `done` (actor `policy:trust`, event-audited), so cron/fire-and-forget
 *     items never pile into a fake review queue.
 *   - Newest attempt with an explicit `failed`/`interrupted` receipt → `blocked`.
 *
 * All writes go through the guarded `transitions.ts` (event-audited, optimistic,
 * sticky-safe) — the reconciler is a consumer of the state machine, not a second
 * write path.
 */

/** Session lifecycle states, mirrored from `Session.status` in shared/types.ts. */
type SessionStatus = 'idle' | 'running' | 'error' | 'waiting' | 'interrupted';

export interface WorkItemAttemptEvidence {
  status: SessionStatus;
  outcome: SessionAttemptOutcome | null;
}

/** A session is "in flight" (work is actively happening) in these states. */
const IN_FLIGHT: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['running', 'waiting']);

/** Extra derivation context that cannot be read from session receipts alone. */
export interface DeriveWorkItemOptions {
  /**
   * True when the item's current `blocked` was DECLARED by a caller (an agent or
   * the operator saying "this needs a decision") rather than DERIVED from a
   * failed/interrupted receipt. Computed by `reconcileWorkItem` from the latest
   * block event so this function stays pure.
   */
  blockDeclared?: boolean;
}

/**
 * Pure derivation: given an item's current status, its provenance, and the
 * terminal receipts of its linked sessions **ordered newest-first** (as
 * `listSessionsByWorkItem` returns them, by `last_activity DESC`), return the
 * status the item SHOULD have. Never yields a sticky terminal — `done` is a
 * policy/human decision layered on top by the TRUST hook.
 */
export function deriveWorkItemStatus(
  current: WorkItemStatus,
  attempts: readonly WorkItemAttemptEvidence[],
  source?: WorkItemSource,
  opts?: DeriveWorkItemOptions,
): WorkItemStatus {
  if (STICKY_STATUSES.has(current)) return current;
  if (attempts.length === 0) return current;
  // Review is a governance phase, not a reflection of session transport state.
  // Parent callbacks and review conversations may run on linked sessions after
  // submission; only an explicit review bounce may reopen execution.
  if (current === 'in_review') return current;
  // A DECLARED block is governance too — the same argument as `in_review`. An
  // agent saying "I need an operator decision" must not be erased because some
  // linked session is still live: a follow-up investigation, a watchdog, or the
  // manager's own probe all count as in-flight and would silently derive the
  // item back to `executing`, dropping the blocker off the operator's queue
  // before it was ever seen. A block DERIVED from a failed receipt stays
  // transport state and keeps re-deriving as before.
  if (current === 'blocked' && opts?.blockDeclared) return current;
  if (attempts.some((attempt) => IN_FLIGHT.has(attempt.status))) return 'executing';
  // Nothing in flight — the most recent attempt (index 0, newest-first) is the
  // authority (an old clean settle must not mask a newer failure, and a newer
  // clean retry must clear an older failure).
  const newest = attempts[0].outcome;
  if (newest === 'succeeded') return 'in_review';
  if (newest === 'failed' || newest === 'interrupted') return 'blocked';
  return current;
}

export interface ReconcileResult {
  item: WorkItem;
  changed: boolean;
}

/**
 * Reconcile a single work item from its linked sessions, then apply the TRUST
 * auto-close hook. Returns the (possibly updated) item and whether anything
 * changed, or undefined if the id is unknown. A no-op when the derived status
 * already matches — no write, no `updated_at` churn, no events.
 */
export function reconcileWorkItem(id: string): ReconcileResult | undefined {
  const item = getWorkItem(id);
  if (!item) return undefined;
  // Workflow-created Todos predate native Workflow run authority. They are
  // frozen audit records: automatic session reconciliation must never derive,
  // TRUST-close, or otherwise rewrite them. Explicit guarded Todo actions remain
  // available through the normal operator surfaces.
  if (item.source === 'workflow') return { item, changed: false };
  const attempts = listSessionsByWorkItem(id).map((s) => ({
    status: s.status as SessionStatus,
    outcome: s.attemptOutcome ?? null,
  }));
  // Only pay for the block-provenance lookup when the item is actually blocked.
  const derived = deriveWorkItemStatus(item.status, attempts, item.source, {
    blockDeclared: item.status === 'blocked' ? isBlockDeclared(id) : false,
  });

  let current = item;
  let changed = false;
  if (derived !== item.status) {
    // transitionDerived returns undefined on a sticky/concurrent race — report
    // the fresh truth as unchanged rather than clobbering a deliberate decision.
    const updated = transitionDerived(id, derived, RECONCILER_ACTOR, { declared: false });
    if (updated) {
      current = updated;
      changed = true;
    } else {
      const latest = getWorkItem(id);
      return latest ? { item: latest, changed: false } : undefined;
    }
  }

  // TRUST policy hook (design §1.5): an item landing (or sitting) in `in_review`
  // whose effective verify mode is `trust` auto-closes in the SAME pass —
  // settle → in_review → done reads as one truthful story in the event log.
  if (current.status === 'in_review' && effectiveVerifyMode(current) === 'trust') {
    const closed = transitionDerived(id, 'done', 'policy:trust', { policy: 'trust', auto: true });
    if (closed) {
      current = closed;
      changed = true;
    }
  }

  // ICI-570: reconciles run from session lifecycle and cron — in-process lanes
  // with no route-level event. One live signal per actual change.
  if (changed) notifyTodoChanged(current, 'reconciled');

  return { item: current, changed };
}

export interface ReconcileSweepResult {
  checked: number;
  changed: number;
}

/** The non-sticky statuses a sweep re-derives. `in_review` is included so a
 *  pre-existing trust-tier item settles on the next pass even if its landing
 *  pass predates this code. */
const SWEEP_STATUSES: readonly WorkItemStatus[] = ['backlog', 'assigned', 'executing', 'in_review', 'blocked'];

/**
 * Reconcile every non-sticky item. Invoked at gateway startup right after
 * `recoverStaleSessions()` (the exact moment `running` sessions became
 * `interrupted`, so their items must move to `blocked`) and periodically by
 * `startWorkItemReconciler` (so settles reach `in_review`/`done` while the
 * gateway runs, not just at the next boot). One indexed session query per
 * candidate — negligible at this table's scale (see GRS-003a's note).
 */
export function reconcileActiveWorkItems(): ReconcileSweepResult {
  const candidates = SWEEP_STATUSES.flatMap((status) => listWorkItems({ status }));
  let changed = 0;
  for (const item of candidates) {
    const result = reconcileWorkItem(item.id);
    if (result?.changed) changed++;
  }
  return { checked: candidates.length, changed };
}

/**
 * Startup hook: reconcile work items and log a one-line summary. Best-effort — a
 * reconcile failure must never block gateway boot (mirrors the cron consumer's
 * guard). Returns the count of items whose status changed (0 on any error).
 */
export function reconcileWorkItemsOnStartup(): number {
  try {
    const { checked, changed } = reconcileActiveWorkItems();
    if (changed > 0) {
      logger.info(`Reconciled ${changed} work item(s) from linked session state (of ${checked} non-sticky)`);
    }
    return changed;
  } catch (err) {
    logger.warn(`Work-item startup reconcile skipped: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

const DEFAULT_RECONCILE_INTERVAL_MS = 20_000;

/**
 * Periodic work-item reconcile (GRS-021a): without it, a session that settles
 * mid-process would only reach `in_review`/`done` at the NEXT boot or the next
 * mint-time reconcile — a stale ledger, the exact failure Todos exist to kill.
 * Same primitive as the gateway's status reconciler (unref'd interval, one
 * guarded sweep per tick, ticks never overlap because the sweep is synchronous).
 * Returns a stop function.
 */
export function startWorkItemReconciler(intervalMs: number = DEFAULT_RECONCILE_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    try {
      reconcileActiveWorkItems();
    } catch (err) {
      logger.warn(`Work-item reconcile sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

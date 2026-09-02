import { loadConfig } from "../shared/config.js";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { JsonObject, Session } from "../shared/types.js";
import { deliverClaimedSessionDelivery } from "./callbacks.js";
import {
  RESTART_ACK_META_KEY,
  RESTART_RESUME_META_KEY,
  claimSessionDelivery,
  ensureCallbackAttemptToken,
  getSession,
  listSessions,
  updateSession,
} from "./registry.js";

/**
 * A restart can strand any number of conversational sessions at once. Waking
 * them all in the same tick spawns that many engine processes simultaneously,
 * which is exactly the moment a rate-limited primary engine starts refusing —
 * so the tail is capped and the rest are spaced far enough apart that later
 * nudges land on the fallback chain instead of failing together.
 */
export const MAX_RESTART_RESUMES = 10;
export const RESTART_RESUME_STAGGER_MS = 15_000;

const RESTART_RESUME_DELIVERY_KIND = "gateway-restart-resume";
const RESTART_RESUME_SOURCE_OUTCOME = "gateway-restart";

export interface RestartResume {
  sessionId: string;
  dueAt: number;
}

export interface RestartResumePlan {
  resumes: RestartResume[];
  /** Candidates over the cap. Reported so a busy restart is visible in the log
   *  rather than silently losing the oldest sessions. */
  deferred: number;
}

/** Preserve running conversational Sessions for resume. Exported as a shutdown test seam. */
export function interruptRunningSessionsForShutdown(): void {
  for (const session of listSessions({ status: "running" })) {
    const now = new Date().toISOString();
    if (hasRestartAcknowledgement(session)) {
      updateSession(session.id, {
        status: "idle",
        attemptOutcome: "interrupted",
        lastActivity: now,
        lastError: null,
        transportMeta: { ...existingTransportMeta(session), [RESTART_RESUME_META_KEY]: now },
      });
      logger.info(`Marked restart-requesting session ${session.id} for resume after gateway shutdown`);
      continue;
    }
    updateSession(session.id, {
      status: "interrupted",
      attemptOutcome: "interrupted",
      lastActivity: now,
      lastError: "Interrupted: gateway shutting down gracefully",
      transportMeta: { ...existingTransportMeta(session), [RESTART_RESUME_META_KEY]: now },
    });
    logger.info(`Marked session ${session.id} as interrupted for resume`);
  }
}

/**
 * Take the sessions this gateway's own restart interrupted, exactly once.
 * Selecting the marks and clearing them share one transaction, so a second boot
 * can never re-fire the first restart's nudges.
 *
 * Every mark is cleared, including the ones this returns nothing for: a session
 * whose turn `resumePendingWebQueueItems` already re-dispatched is resumed, just
 * not by us, and leaving its mark behind would turn it into a nudge on some
 * later restart it had nothing to do with.
 */
export function consumeRestartResumeCandidates(): Session[] {
  const database = initDb();
  const jsonPath = `$.${RESTART_RESUME_META_KEY}`;
  const marked = database.prepare(
    "SELECT id FROM sessions WHERE json_type(transport_meta, ?) = 'text' AND workflow_kind IS NULL",
  );
  const clear = database.prepare(
    "UPDATE sessions SET transport_meta = NULLIF(json_remove(transport_meta, ?), '{}') WHERE id = ?",
  );
  const alreadyResuming = database.prepare(
    "SELECT 1 FROM queue_items WHERE session_id = ? AND status IN ('pending', 'running') LIMIT 1",
  );
  const consume = database.transaction(() => {
    const resumable: string[] = [];
    for (const row of marked.all(jsonPath) as Array<{ id: string }>) {
      clear.run(jsonPath, row.id);
      if (!alreadyResuming.get(row.id)) resumable.push(row.id);
    }
    return resumable;
  });
  return consume.immediate()
    .map((id) => getSession(id))
    .filter((session): session is Session => Boolean(session));
}

/** Order the sessions a restart interrupted, newest conversation first, and
 *  spread their wake-ups over the stagger window. */
export function planRestartResumes(input: { candidates: Session[]; now: number }): RestartResumePlan {
  const ordered = [...input.candidates].sort((a, b) => {
    const activity = activityMillis(b) - activityMillis(a);
    return activity !== 0 ? activity : a.id.localeCompare(b.id);
  });
  const resumes = ordered.slice(0, MAX_RESTART_RESUMES).map((session, index) => ({
    sessionId: session.id,
    dueAt: input.now + index * RESTART_RESUME_STAGGER_MS,
  }));
  return { resumes, deferred: ordered.length - resumes.length };
}

/** The wake-up itself. Both halves matter: the session must know the break was
 *  the gateway's doing and not the operator's, and it must re-check anything
 *  that was mid-flight rather than assume it ran or blindly run it again. */
export function restartResumeMessage(gatewayVersion: string): string {
  return (
    `[Gateway] Restart complete (v${gatewayVersion}). Your previous turn was interrupted by a gateway ` +
    `restart, not by the operator. Continue from where you left off — but re-verify the outcome of any ` +
    `command that was in flight before assuming it ran or re-running it.`
  );
}

/**
 * Wake one interrupted session through the durable delivery outbox, which
 * retries on its own and collapses a repeat claim onto the same row. Returns
 * whether this call is the one that claimed the nudge.
 */
export function notifyGatewayRestartResume(session: Session, gatewayVersion: string): boolean {
  const terminalOutcome = session.attemptOutcome ?? "interrupted";
  const terminalVersion = Math.max(1, session.attemptTerminalVersion ?? 0);
  const attemptToken = session.attemptToken
    ?? ensureCallbackAttemptToken(session.id, terminalOutcome, terminalVersion);
  if (!attemptToken) {
    logger.warn(`[restart-resume] Session ${session.id} has no callback attempt token; not nudging it to continue`);
    return false;
  }
  const message = restartResumeMessage(gatewayVersion);
  const { delivery, claimed } = claimSessionDelivery({
    targetSessionId: session.id,
    sourceKind: "session",
    sourceId: session.id,
    sourceAttempt: attemptToken,
    sourceOutcome: RESTART_RESUME_SOURCE_OUTCOME,
    sourceVersion: terminalVersion,
    deliveryKind: RESTART_RESUME_DELIVERY_KIND,
    payload: { message, displayMessage: message },
  });
  if (delivery.status === "accepted") return false;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[restart-resume] Failed to nudge session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return claimed;
}

/**
 * Boot step: tell every session this restart interrupted to carry on. Runs after
 * the pending web queue replay, so a session already back on the engine through
 * its own queue item is skipped rather than resumed twice.
 */
export function resumeRestartInterruptedSessions(gatewayVersion: string): void {
  const candidates = consumeRestartResumeCandidates();
  if (candidates.length === 0) return;
  if (loadConfig().gateway.resumeInterruptedSessions === false) {
    logger.info(`Restart resume nudges are off — left ${candidates.length} interrupted session(s) for the operator`);
    return;
  }
  const plan = planRestartResumes({ candidates, now: Date.now() });
  const byId = new Map(candidates.map((session) => [session.id, session]));
  for (const resume of plan.resumes) {
    const session = byId.get(resume.sessionId)!;
    setTimeout(() => {
      if (notifyGatewayRestartResume(session, gatewayVersion)) {
        logger.info(`Nudged interrupted session ${session.id} (${session.engine}${session.employee ? `, ${session.employee}` : ""}) to continue after restart`);
      }
    }, Math.max(0, resume.dueAt - Date.now())).unref();
  }
  const overflow = plan.deferred > 0 ? ` (${plan.deferred} deferred over the cap of ${MAX_RESTART_RESUMES})` : "";
  logger.info(`Resuming ${plan.resumes.length} interrupted session(s) after restart${overflow}`);
}

function hasRestartAcknowledgement(session: Session): boolean {
  const meta = session.transportMeta;
  return Boolean(meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta[RESTART_ACK_META_KEY] === "string");
}

function existingTransportMeta(session: Session): JsonObject {
  const meta = session.transportMeta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

function activityMillis(session: Session): number {
  const parsed = Date.parse(session.lastActivity);
  return Number.isNaN(parsed) ? 0 : parsed;
}

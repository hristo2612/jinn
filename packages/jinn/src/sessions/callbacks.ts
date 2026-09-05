import { internalGatewayConnection, internalGatewayHeaders } from "./callback-connection.js";
import {
  getSession,
  getSessionDelivery,
  claimSessionDelivery,
  claimSessionDeliveryAttempt,
  recordSessionDeliveryFailure,
  ensureCallbackAttemptToken,
  listDelegationCompletionNudgedSessions,
  listPendingSessionDeliveries,
  markDelegationCompletionSurfaced,
} from "./registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { STRUCTURED_MESSAGE_BODY_MAX_CHARS, type Session } from "../shared/types.js";
import type { ChatBlockEnvelope, JsonObject } from "../shared/types.js";
import { enforceDelegationCompletionContract } from "./delegation-completion-contract.js";
import type { SessionDeliveryPayload } from "../shared/types.js";

export const CALLBACK_DELIVERY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
export const CALLBACK_DELIVERY_MAX_ATTEMPTS = CALLBACK_DELIVERY_RETRY_DELAYS_MS.length + 1;
// Parent wakes travel through argv on cold spawns and bracketed paste on warm PTYs.
// This is a transport ceiling with headroom under macOS ARG_MAX, not a preview budget.
export const CALLBACK_REPLY_MAX_CHARS = 128_000;
const CALLBACK_DELIVERY_ATTEMPT_LEASE_MS = 60_000;

let callbackRetryTimer: ReturnType<typeof setTimeout> | undefined;
let callbackRetrySweepRunning: Promise<number> | undefined;

export interface ManagerVisibilityDetails {
  manager: string;
  managerDisplay: string;
  delegator: string | null;
  delegatorDisplay: string;
  employee: string;
  employeeDisplay: string;
  childSessionId: string;
  workItemId: string;
  title: string;
}

type CallbackSemantics = "terminal" | "nonterminal-lifecycle";

/**
 * Give a manager lightweight visibility into one skip-level delegation. The
 * session-message route persists this notification in the restart-safe internal
 * queue before its manager turn starts. Fire-and-forget, like parent callbacks.
 */
export function notifyManagerVisibility(
  managerSessionId: string,
  details: ManagerVisibilityDetails,
): void {
  const message =
    `👀 Skip-level visibility: ${details.delegatorDisplay} delegated directly to ${details.employeeDisplay}.\n\n` +
    `Task: ${details.title}\n` +
    `Todo: ${details.workItemId}\n` +
    `Child session: ${details.childSessionId}\n\n` +
    `You retain manager visibility; no action is required unless coordination or review is needed.`;
  const displayMessage =
    `👀 Skip-level visibility · ${details.employeeDisplay}\n${_clean(details.title, 220)}`;
  const meta: JsonObject = {
    kind: "manager-visibility",
    manager: details.manager,
    delegator: details.delegator ?? "operator",
    employee: details.employee,
    childSessionId: details.childSessionId,
    workItemId: details.workItemId,
  };

  const { delivery } = claimSessionDelivery({
    targetSessionId: managerSessionId,
    sourceKind: "session",
    sourceId: details.childSessionId,
    sourceAttempt: `manager-visibility:${details.workItemId}`,
    sourceOutcome: "manager-visibility",
    sourceVersion: 1,
    deliveryKind: "manager-visibility",
    payload: { message, displayMessage, meta },
  });
  if (delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[callbacks] Failed to notify manager session ${managerSessionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Notify the parent session that a child session has replied.
 * Sends an internal message to the parent via the local HTTP API.
 * Fire-and-forget compatibility wrapper. Turn settlement uses the awaited
 * variant below so a source-drain hold cannot release before the final durable
 * callback is accepted.
 */
export function notifyParentSession(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean },
): void {
  void notifyParentSessionAndWait(childSession, result, options);
}

/** Awaitable parent notification for completion paths that need durable ordering. */
export async function notifyParentSessionAndWait(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean },
): Promise<void> {
  if (!result.error && !hasMeaningfulReply(result.result)) return;

  if (!childSession.parentSessionId) return;

  // Cross-channel de-duplication: if the child already reported UP to this parent
  // via send_to_session during its current attempt, that explicit relay and this
  // automatic parent-completion callback are two injections of the SAME turn — the
  // operator sees the second as a spurious "duplicate callback" wake. Suppress it.
  // Errors always surface (the explicit report may predate the failure); a re-read
  // sees the marker written mid-turn; and a NEW attempt mints a token that no
  // longer matches, so the callback re-enables for genuinely new work.
  if (!result.error) {
    const fresh = getSession(childSession.id) ?? childSession;
    if (fresh.attemptToken && fresh.transportMeta?.reportedToParentAttempt === fresh.attemptToken) {
      return;
    }
  }

  await _sendNotification(childSession, result, options).catch((err) => {
    logger.warn(`[callbacks] Failed to notify parent session ${childSession.parentSessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Post-listen restart recovery for a claim persisted before its continuation
 * notification reached the durable queue. Surface first; mark surfaced only
 * after the parent-message route accepts it. Failure leaves `nudged` intact so
 * the next restart retries instead of silently stranding the delegation.
 */
export async function recoverOrphanedDelegationCompletionClaims(): Promise<number> {
  let recovered = 0;
  for (const child of listDelegationCompletionNudgedSessions()) {
    if (!child.parentSessionId || !child.workItemId) continue;
    const parent = getSession(child.parentSessionId);
    if (!parent || parent.status === "error") continue;
    try {
      await _sendNotification(child, {
        error:
          "Delegation completion recovery: a restart occurred after the automatic continuation was claimed, " +
          "so completion could not be confirmed. The child was not nudged again; parent review is required.",
      }, {
        skipCompletionContract: true,
        callbackKind: "delegation-completion-recovery",
        terminalOutcome: child.attemptOutcome ?? "interrupted",
      });
      if (markDelegationCompletionSurfaced(child.id, child.workItemId)) recovered++;
    } catch (error) {
      logger.warn(
        `[delegation-contract] restart recovery could not surface child ${child.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return recovered;
}

/** Replay callback intents claimed before their parent route accepted the
 * queue/message transaction. Accepted rows are absent from this scan, so boot
 * recovery can never emit or wake an already delivered callback again. */
export async function recoverPendingSessionDeliveries(): Promise<number> {
  if (callbackRetrySweepRunning) return callbackRetrySweepRunning;
  callbackRetrySweepRunning = (async () => {
    const now = Date.now();
    const due = listPendingSessionDeliveries().filter(
      (delivery) => delivery.nextAttemptAt === null || delivery.nextAttemptAt <= now,
    );
    const results = await Promise.allSettled(due.map((delivery) => deliverClaimedSessionDelivery(delivery.id)));
    armCallbackRetrySweep();
    return results.filter((result) => result.status === "fulfilled" && result.value !== "deferred").length;
  })().finally(() => {
    callbackRetrySweepRunning = undefined;
  });
  return callbackRetrySweepRunning;
}

/** Startup owns callback recovery before orphan-guard recovery. Each phase is
 * caught independently so poison or transport failure cannot reject boot. */
export async function recoverSessionDeliveryStateOnStartup(): Promise<{
  pendingRecovered: number;
  orphanedRecovered: number;
}> {
  let pendingRecovered = 0;
  let orphanedRecovered = 0;
  try {
    pendingRecovered = await recoverPendingSessionDeliveries();
  } catch (error) {
    logger.error(`[callbacks] Startup callback recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    orphanedRecovered = await recoverOrphanedDelegationCompletionClaims();
  } catch (error) {
    logger.error(`[callbacks] Startup orphan recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { pendingRecovered, orphanedRecovered };
}

/**
 * Notify the parent session that a child session has been rate-limited and will auto-resume.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimited(
  childSession: Session,
  estimatedResumeTime?: string, // ISO timestamp or human-readable
): void {
  if (!childSession.parentSessionId) return;

  _sendNotification(childSession, {
    error: null,
    result: `⏳ Session is rate-limited and will auto-resume${estimatedResumeTime ? ` around ${estimatedResumeTime}` : ' when the limit resets'}. No action needed.`,
  }, {
    semantics: "nonterminal-lifecycle",
    callbackKind: "rate-limited",
    terminalOutcome: "rate-limited",
    terminalVersion: Math.max(1, childSession.attemptTerminalVersion ?? 0),
  }).catch((err) => {
    logger.warn(`[callbacks] Failed to send rate-limit notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a rate-limited child session has successfully resumed.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimitResumed(
  childSession: Session,
): void {
  if (!childSession.parentSessionId) return;

  const employeeName = childSession.employee || "Unknown";
  const message = `🔄 Employee "${employeeName}" (session ${childSession.id}) has resumed after rate limit cleared.`;

  const terminalVersion = Math.max(1, childSession.attemptTerminalVersion ?? 0);
  const attemptToken = childSession.attemptToken
    ?? ensureCallbackAttemptToken(childSession.id, "rate-limit-resumed", terminalVersion);
  if (!attemptToken) {
    logger.warn(`[callbacks] Failed to send resume notification: child ${childSession.id} has no immutable callback attempt token`);
    return;
  }
  const { delivery } = claimSessionDelivery({
    targetSessionId: childSession.parentSessionId,
    sourceKind: "session",
    sourceId: childSession.id,
    sourceAttempt: attemptToken,
    sourceOutcome: "rate-limit-resumed",
    sourceVersion: terminalVersion,
    deliveryKind: "rate-limit-resumed",
    payload: { message, displayMessage: message },
  });
  if (delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(delivery.id).catch((err) => {
    logger.warn(`[callbacks] Failed to send resume notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendNotification(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: {
    alwaysNotify?: boolean;
    skipCompletionContract?: boolean;
    semantics?: CallbackSemantics;
    callbackKind?: string;
    terminalOutcome?: string;
    terminalVersion?: number;
  },
): Promise<void> {
  const parent = getSession(childSession.parentSessionId!);
  if (!parent) return; // Parent gone or expired
  if (parent.status === "error") return; // Parent already in error — skip
  const isTerminal = options?.semantics !== "nonterminal-lifecycle";

  // Delegation completion contract: a narrowly-qualified progress-only idle
  // settlement gets one durable follow-up instead of prematurely waking the
  // parent. The next idle settlement is surfaced and can never nudge again.
  const contract = options?.skipCompletionContract || !isTerminal
    ? "pass"
    : await enforceDelegationCompletionContract(childSession, result, {
        postFollowUp: (sessionId, message, displayMessage) =>
          _sendCompletionContractNudge(childSession, sessionId, message, displayMessage),
      });
  if (contract === "nudged" || contract === "suppress") return;
  if (contract === "surface") {
    const latest = result.result?.trim() || "(no output)";
    result = {
      ...result,
      result:
        `⚠️ Delegation completion contract: the child settled idle again after its single automatic continuation nudge. ` +
        `No further nudge was sent; parent review is required.\n\nLatest reply:\n${latest}`,
    };
  }
  if (options?.alwaysNotify === false && contract !== "surface") return;

  const employeeName = childSession.employee || "Unknown";
  const childId = childSession.id;

  // Dual audience: `message` is what the parent ENGINE (e.g. the COO) reads —
  // it carries full context and the API hints it needs to follow up.
  // `displayMessage` is the clean, human-facing version shown in the web UI
  // notification banner.
  let message: string;
  let displayMessage: string;
  let notificationMeta: JsonObject | undefined;
  let notificationBlock: ChatBlockEnvelope | undefined;
  if (result.error) {
    message = `⚠️ Employee "${employeeName}" (child session ${childId}) hit an error and could not finish: ${result.error}`;
    displayMessage = `⚠️ ${employeeName} couldn't finish\n${_clean(result.error, 220)}`;
    if (isTerminal) {
      notificationMeta = childNotificationMeta("child-error", childSession, result.error);
    }
  } else {
    const raw = (result.result || "").trim() || "(no output)";
    if (raw.length > CALLBACK_REPLY_MAX_CHARS) {
      const inlineReply = raw.slice(0, CALLBACK_REPLY_MAX_CHARS) + "…";
      message =
        `📩 Employee "${employeeName}" replied in child session ${childId}.\n\n` +
        `Reply (clipped to first ${CALLBACK_REPLY_MAX_CHARS.toLocaleString("en-US")} of ${raw.length.toLocaleString("en-US")} characters):\n${inlineReply}\n\n` +
        `The full reply is intact in child session ${childId}; nothing was lost. ` +
        `Read it with read_session { sessionId: "${childId}", last: N } rather than asking the child to resend, shorten, or compress it.`;
    } else {
      message =
        `📩 Employee "${employeeName}" replied in child session ${childId}.\n\n` +
        `Reply:\n${raw}\n\n` +
        `To read the reply in context: read_session { sessionId: "${childId}", last: N } · ` +
        `to follow up: send_to_session { sessionId: "${childId}", message: "<message>" }`;
    }
    displayMessage = `📩 ${employeeName} replied\n${_clean(raw, 220)}`;
    if (isTerminal) {
      notificationMeta = childNotificationMeta("child-reply", childSession, raw);
    }
  }

  if (isTerminal && childSession.workItemId) {
    notificationBlock = {
      op: "patch",
      block: {
        id: `dg-${childSession.workItemId}`,
        type: "delegation",
        version: 1,
        status: result.error ? "error" : "done",
        payload: { repliedAt: Date.now() },
      },
    };
  }

  const terminalOutcome = options?.terminalOutcome
    ?? childSession.attemptOutcome
    ?? (result.error ? "failed" : "succeeded");
  const terminalVersion = options?.terminalVersion
    ?? Math.max(1, childSession.attemptTerminalVersion ?? 0);
  const attemptToken = childSession.attemptToken
    ?? ensureCallbackAttemptToken(childSession.id, terminalOutcome, terminalVersion);
  if (!attemptToken) {
    throw new Error(`child ${childSession.id} has no immutable callback attempt token`);
  }
  const payload: SessionDeliveryPayload = {
    message,
    displayMessage,
    ...(notificationMeta ? { meta: notificationMeta } : {}),
    ...(notificationBlock ? { block: notificationBlock } : {}),
  };
  const { delivery } = claimSessionDelivery({
    targetSessionId: childSession.parentSessionId!,
    sourceKind: "session",
    sourceId: childSession.id,
    sourceAttempt: attemptToken,
    sourceOutcome: terminalOutcome,
    sourceVersion: terminalVersion,
    deliveryKind: options?.callbackKind ?? "parent-completion",
    payload,
  });
  if (delivery.status === "accepted") return;

  await deliverClaimedSessionDelivery(delivery.id);
}

async function _sendCompletionContractNudge(
  childSession: Session,
  targetSessionId: string,
  message: string,
  displayMessage: string,
): Promise<void> {
  const terminalOutcome = childSession.attemptOutcome ?? "idle-progress";
  const terminalVersion = Math.max(1, childSession.attemptTerminalVersion ?? 0);
  const attemptToken = childSession.attemptToken
    ?? ensureCallbackAttemptToken(childSession.id, terminalOutcome, terminalVersion);
  if (!attemptToken) throw new Error(`child ${childSession.id} has no immutable callback attempt token`);
  const { delivery } = claimSessionDelivery({
    targetSessionId,
    sourceKind: "session",
    sourceId: childSession.id,
    sourceAttempt: attemptToken,
    sourceOutcome: terminalOutcome,
    sourceVersion: terminalVersion,
    deliveryKind: "delegation-completion-nudge",
    payload: { message, displayMessage },
  });
  if (delivery.status === "accepted") return;
  await deliverClaimedSessionDelivery(delivery.id);
}

function childNotificationMeta(
  kind: "child-reply" | "child-error",
  childSession: Session,
  fullMessage: string,
): JsonObject {
  const employee = childSession.employee || "Unknown";
  const storedDisplay = childSession.transportMeta?.delegationEmployeeDisplay;
  const employeeDisplay = typeof storedDisplay === "string" && storedDisplay.trim()
    ? storedDisplay.trim()
    : employee
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  return {
    kind,
    employee,
    employeeDisplay,
    childSessionId: childSession.id,
    fullMessage: fullMessage.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS),
  };
}

function hasMeaningfulReply(result: string | null | undefined): boolean {
  return Boolean(result?.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim());
}

/** Trim to a word boundary for a tidy human-facing preview. */
function _clean(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Send a fixed notification to the operator's configured channel
 * (`notifications.connector` + `notifications.channel`; Discord by default).
 * Used for alerts that must reach a human without depending on an LLM — rate
 * limits, and a workflow parked on a decision with no employee session to wake.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyOperatorChannel(message: string): void {
  _sendOperatorNotification(message).catch((err) => {
    logger.warn(`[callbacks] Failed to send operator notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendOperatorNotification(message: string): Promise<void> {
  let connector = "discord";
  let channel: string | undefined;
  const gateway = internalGatewayConnection();

  try {
    const config = loadConfig();
    connector = config.notifications?.connector || "discord";
    channel = config.notifications?.channel;
  } catch {
    // Use defaults if config is unavailable
  }

  if (!channel) {
    logger.debug("[callbacks] No notifications.channel configured — skipping operator notification");
    return;
  }

  const response = await fetch(`${gateway.baseUrl}/api/connectors/${connector}/send`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({ channel, text: message }),
  });
  if (!response.ok) throw new Error(`connector notification failed (${response.status})`);
}

async function _sendRaw(
  parentSessionId: string,
  message: string,
  displayMessage?: string,
  structured?: { meta?: JsonObject; block?: ChatBlockEnvelope; callbackDeliveryId?: string },
): Promise<void> {
  const gateway = internalGatewayConnection();

  const response = await fetch(`${gateway.baseUrl}/api/sessions/${parentSessionId}/message`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({
      message,
      role: "notification",
      ...(displayMessage ? { displayMessage } : {}),
      ...(structured?.meta ? { meta: structured.meta } : {}),
      ...(structured?.block ? { block: structured.block } : {}),
      ...(structured?.callbackDeliveryId ? { callbackDeliveryId: structured.callbackDeliveryId } : {}),
    }),
  });
  if (!response.ok) throw new Error(`parent notification failed (${response.status})`);
}

type SessionDeliveryAttemptResult = "accepted" | "scheduled" | "deferred";

export async function deliverClaimedSessionDelivery(deliveryId: string): Promise<SessionDeliveryAttemptResult> {
  const delivery = getSessionDelivery(deliveryId);
  if (!delivery) return "deferred";
  const attempt = claimSessionDeliveryAttempt(deliveryId, Date.now(), CALLBACK_DELIVERY_ATTEMPT_LEASE_MS);
  if (!attempt) {
    armCallbackRetrySweep();
    return getSessionDelivery(deliveryId)?.status === "accepted" ? "accepted" : "deferred";
  }
  try {
    await _sendRaw(attempt.targetSessionId, attempt.payload.message, attempt.payload.displayMessage, {
      meta: attempt.payload.meta,
      block: attempt.payload.block,
      callbackDeliveryId: attempt.id,
    });
    if (getSessionDelivery(attempt.id)?.status === "pending") armCallbackRetrySweep();
    return "accepted";
  } catch (error) {
    if (getSessionDelivery(attempt.id)?.status === "accepted") return "accepted";
    const diagnostic = error instanceof Error ? error.message : String(error);
    const delayIndex = Math.min(attempt.attemptCount - 1, CALLBACK_DELIVERY_RETRY_DELAYS_MS.length - 1);
    const failed = recordSessionDeliveryFailure(attempt.id, diagnostic, {
      now: Date.now(),
      nextAttemptAt: Date.now() + CALLBACK_DELIVERY_RETRY_DELAYS_MS[Math.max(0, delayIndex)],
      maxAttempts: CALLBACK_DELIVERY_MAX_ATTEMPTS,
    });
    if (failed?.status === "pending") {
      armCallbackRetrySweep();
      logger.warn(`[callbacks] Delivery ${attempt.id} failed; retry ${attempt.attemptCount + 1} scheduled: ${diagnostic}`);
      return "scheduled";
    }
    logger.error(`[callbacks] Delivery ${attempt.id} exhausted after ${attempt.attemptCount} attempts: ${diagnostic}`);
    return "scheduled";
  }
}

function armCallbackRetrySweep(): void {
  const pending = listPendingSessionDeliveries();
  if (callbackRetryTimer) {
    clearTimeout(callbackRetryTimer);
    callbackRetryTimer = undefined;
  }
  if (pending.length === 0) return;
  const now = Date.now();
  const nextAt = Math.min(...pending.map((delivery) => delivery.nextAttemptAt ?? now));
  callbackRetryTimer = setTimeout(() => {
    callbackRetryTimer = undefined;
    void recoverPendingSessionDeliveries().catch((error) => {
      logger.error(`[callbacks] Live retry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      armCallbackRetrySweep();
    });
  }, Math.max(0, nextAt - now));
  callbackRetryTimer.unref?.();
}

export function __resetCallbackRetrySweepForTest(): void {
  if (callbackRetryTimer) clearTimeout(callbackRetryTimer);
  callbackRetryTimer = undefined;
  callbackRetrySweepRunning = undefined;
}

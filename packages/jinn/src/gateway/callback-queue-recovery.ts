import type { ApiContext } from "./api.js";
import { logger } from "../shared/logger.js";
import { maybeRevertEngineOverride } from "../sessions/manager.js";
import { runtimeSessionSource } from "../sessions/context.js";
import {
  type QueueItem, coalescePendingParentCompletionQueueItems, listAllPendingQueueItems, getSession,
  cancelQueueItem, listReleasableParentCompletionQueuesForSource,
  getSessionDeliveryByQueueItemId, shouldHoldParentCompletionQueueDispatch, updateSession,
} from "../sessions/registry.js";
import { dispatchWebSessionRun } from "./web-session-dispatch.js";

export function resumePendingWebQueueItems(context: ApiContext): void {
  coalescePendingParentCompletionQueueItems();
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  let resumed = 0;
  for (const item of pending) {
    if (resumePendingQueueItem(item, context)) resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
}

function resumePendingQueueItem(item: QueueItem, context: ApiContext): boolean {
  let session = getSession(item.sessionId);
  if (!session) {
    cancelQueueItem(item.id);
    for (const held of listReleasableParentCompletionQueuesForSource(item.sessionId)) {
      context.sessionManager.getQueue().releaseCallbackDrain(held.sessionKey, held.queueItemId);
    }
    return false;
  }
  // Ordinary non-web queue ownership remains connector-specific. Callback
  // receipts are the exception: acceptance already committed this internal
  // turn, so startup replay must finish it regardless of the parent's source.
  const callbackDelivery = getSessionDeliveryByQueueItemId(item.id);
  if (runtimeSessionSource(session.source) !== "web" && !callbackDelivery) return false;
  if (callbackDelivery && shouldHoldParentCompletionQueueDispatch(item.id)) {
    context.sessionManager.getQueue().holdForCallbackDrain(item.sessionKey, item.id);
  }
  // Hot-reload calls this too: a row waiting its turn here is owned, not orphaned.
  if (context.sessionManager.getQueue().hasInFlightItem(item.id)) return false;
  session = maybeRevertEngineOverride(session);

  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) {
    const diagnostic = `Engine "${session.engine}" not available`;
    if (callbackDelivery) {
      // Acceptance committed this exact queue row as part of the callback
      // outbox. Engine availability is transient operational state, not a
      // reason to destroy that accepted intent. Keep the row pending so a
      // later config/engine reload can replay the same durable ID.
      updateSession(session.id, { lastActivity: new Date().toISOString(), lastError: diagnostic });
      logger.warn(`Deferred accepted callback queue ${item.id}: ${diagnostic}`);
    } else {
      cancelQueueItem(item.id);
      updateSession(session.id, { status: "error", lastActivity: new Date().toISOString(), lastError: diagnostic });
    }
    return false;
  }

  // Ensure the session is in a runnable state
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });

  dispatchWebSessionRun(session, item.prompt, engine, context, { queueItemId: item.id });
  return true;
}

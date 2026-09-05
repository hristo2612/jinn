import fs from "node:fs";
import path from "node:path";
import {
  getFile,
  getSession,
  getQueueItem,
  beginSessionAttempt,
  listReleasableParentCompletionQueuesForSource,
} from "../sessions/registry.js";
import { FILES_DIR } from "../shared/paths.js";
import { settleTurn } from "../sessions/turn/completion.js";
import { resolveTurnHierarchy } from "../sessions/turn/preflight.js";
import { orgRegistry } from "./org-registry.js";
import { runTurn } from "../sessions/turn/runner.js";
import { logger } from "../shared/logger.js";
import type { Engine, Session } from "../shared/types.js";
import { createWebTurnSurface } from "./web-turn-surface.js";
import { resolveMessageAudiences } from "./speech-context.js";
// Type-only, so the pair below can name the context every web route already
// carries without this module and api.ts importing each other at runtime.
import type { ApiContext } from "./api.js";

/**
 * How a turn on a web-surfaced session is dispatched and run.
 *
 * Lifted out of api.ts unchanged so a caller that is not an HTTP route — the
 * plugin host's `sessions.spawn` — starts a turn the same way every route does,
 * rather than through a second copy of the queue, attempt and settlement dance.
 */

/** The turn surface every web-dispatched turn reports through. */
export function webTurnSurface(sessionId: string, context: ApiContext) {
  return createWebTurnSurface({
    sessionId,
    emit: context.emit,
    connectors: context.connectors,
    getConfig: context.getConfig,
  });
}

/**
 * A turn that never reached settlement, settled.
 *
 * Only when an attempt was actually begun: without a token there is no attempt
 * to fail, and inventing one would mark a session errored for a dispatch that
 * never started it.
 */
async function settleDispatchFailure(
  session: Session,
  context: ApiContext,
  attemptToken: string | undefined,
  err: unknown,
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
  if (!attemptToken) return;
  const erroredOnDispatch = await settleTurn({
    sessionId: session.id,
    attemptToken,
    outcome: "failed",
    error: errMsg,
    surface: webTurnSurface(session.id, context),
  });
  if (erroredOnDispatch?.workflowProvenance?.kind === "phase") {
    context.sessionManager.emitWorkflowAttemptTurnCompletion(session.id);
  }
}

/**
 * One turn, once the queue has let it through.
 *
 * `onAttempt` fires the moment the attempt exists rather than when the turn
 * finishes, because a turn that throws still has an attempt to settle — a
 * token published only on success would leave exactly the failures that need
 * settling with nothing to settle.
 */
async function runQueuedTurn(
  session: Session,
  context: ApiContext,
  request: Omit<WebTurnRequest, "attemptToken">,
  opts: { sessionKey: string; queueItemId?: string; onAttempt: (token: string) => void },
): Promise<void> {
  const startedAttempt = beginSessionAttempt(session.id, {
    lastActivity: new Date().toISOString(),
    lastError: null,
  });
  if (!startedAttempt?.attemptToken) {
    logger.info(`Skipping web session ${session.id}: attempt could not be started`);
    return;
  }
  opts.onAttempt(startedAttempt.attemptToken);
  context.emit("session:started", { sessionId: session.id });
  // Item moved pending → running: refresh the queue panel.
  if (opts.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey: opts.sessionKey });
  await runWebSession(startedAttempt, context, { ...request, attemptToken: startedAttempt.attemptToken });
  if (startedAttempt.workflowProvenance?.kind === "phase") {
    context.sessionManager.emitWorkflowAttemptTurnCompletion(session.id);
  }
}

/**
 * What this turn actually runs, decided when the queue lets it through rather
 * than when it was enqueued.
 *
 * A parked row can be edited, or have another message's payload rotated onto it
 * by "send this one now", while it waits. The operator is looking at the row, so
 * the row wins — and it wins whole: text, attachments and speech origin travel
 * together, because a promoted message arriving with the attachment of the row
 * it displaced would be worse than not reordering at all. The speech note is
 * recomputed from that text exactly as `resolveMessageAudiences` requires:
 * derived per dispatch, never persisted.
 */
function requestForTurn(
  dispatched: Omit<WebTurnRequest, "attemptToken">,
  queueItemId?: string,
): Omit<WebTurnRequest, "attemptToken"> {
  const parked = queueItemId ? getQueueItem(queueItemId) : undefined;
  if (!parked) return dispatched;
  // Its text always. Its attachments only if it recorded any: the notification,
  // workflow and plugin paths enqueue without a payload and still carry files on
  // the closure, and overriding those with "none" would silently drop them.
  const prompt = resolveMessageAudiences(parked.prompt, parked.dispatch?.speechDerived === true).engine;
  if (!parked.dispatch) return { ...dispatched, prompt };
  return { ...dispatched, prompt, attachments: parked.dispatch.attachments.length > 0 ? parked.dispatch.attachments : undefined };
}

export function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[] },
): void {
  let dispatchedAttemptToken: string | undefined;
  const sessionKey = session.sessionKey || session.sourceRef;
  const run = async () => {
    try {
      await context.sessionManager.getQueue().enqueue(sessionKey, () =>
        runQueuedTurn(session, context, requestForTurn({ prompt, engine, attachments: opts?.attachments }, opts?.queueItemId), {
          sessionKey,
          queueItemId: opts?.queueItemId,
          onAttempt: (token) => {
            dispatchedAttemptToken = token;
          },
        }), opts?.queueItemId);
    } finally {
      // Item settled (completed/cancelled/errored): refresh so the "N queued"
      // panel drains. Without this the panel only refreshes on enqueue and the
      // badge sticks at its peak. (queue.ts marks the DB row done in its finally.)
      if (opts?.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey });
      for (const held of listReleasableParentCompletionQueuesForSource(session.id)) {
        context.sessionManager.getQueue().releaseCallbackDrain(held.sessionKey, held.queueItemId);
      }
    }
  };

  const launch = () => {
    run().catch((err) => settleDispatchFailure(session, context, dispatchedAttemptToken, err));
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(launch, opts.delayMs);
  } else {
    launch();
  }
}
/** What one turn needs beyond the session and the gateway it runs in. */
interface WebTurnRequest {
  prompt: string;
  engine: Engine;
  attemptToken: string;
  attachments?: string[];
}

async function runWebSession(
  session: Session,
  context: ApiContext,
  request: WebTurnRequest,
): Promise<void> {
  const currentSession = getSession(session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${session.id} before run start`);
    return;
  }

  // CLI-mode sends run against the PTY-backed view of the engine so the user
  // sees the turn stream into their live xterm; everything else takes the
  // headless engine from the session manager.
  const preferredPtyView = context.ptyViewEngines?.[session.engine] === request.engine;
  const runtimeEngine = (preferredPtyView ? context.ptyViewEngines?.[currentSession.engine] : undefined)
    ?? context.sessionManager.getEngine(currentSession.engine);

  let employee: import("../shared/types.js").Employee | undefined;
  if (currentSession.employee) {
    employee = orgRegistry(context.getConfig()).get(currentSession.employee);
  }

  await runTurn({
    session: currentSession,
    attemptToken: request.attemptToken,
    prompt: request.prompt,
    attachments: request.attachments ?? [],
    employee,
    config: context.getConfig(),
    engines: context.sessionManager.getEngines(),
    engineOverride: runtimeEngine,
    gatewayBootId: context.gatewayBootId ?? "",
    connectorNames: Array.from(context.connectors.keys()),
    roster: await resolveTurnHierarchy(context.getConfig()),
    channel: currentSession.sourceRef,
    user: currentSession.userId ?? "web-user",
  }, webTurnSurface(currentSession.id, context));
}
/** Resolve an array of file IDs to local filesystem paths for engine consumption. */
export function resolveAttachmentPaths(fileIds: unknown): string[] {
  if (!Array.isArray(fileIds)) return [];
  const paths: string[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (!meta) {
      logger.warn(`Attachment file not found: ${id}`);
      continue;
    }
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (fs.existsSync(filePath)) {
      paths.push(filePath);
    } else if (meta.path && fs.existsSync(meta.path)) {
      paths.push(meta.path);
    } else {
      logger.warn(`Attachment file missing on disk: ${id} (${meta.filename})`);
    }
  }
  return paths;
}

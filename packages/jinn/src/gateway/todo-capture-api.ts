import crypto from "node:crypto";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { createSession, getSession, insertMessage, updateSession } from "../sessions/registry.js";
import { enqueueQueueItem } from "../sessions/queue-item-registry.js";
import { getWorkItem, linkSession } from "../work-items/store.js";
import { logger } from "../shared/logger.js";
import { readJsonBody } from "./http-helpers.js";
import { resolveCallerIdentity } from "./session-comm-guards.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import { isTodoId } from "../work-items/id.js";
import { orgRegistry } from "./org-registry.js";
import { json, matchRoute, serverError, type ParsedRoute } from "./route-helpers.js";
import { resolveMessageAudiences } from "./speech-context.js";
import { preflightSystemEmployee } from "./system-employee-spawn.js";
import { TODO_SHAPER_NAME } from "./system-employees.js";
import {
  TODO_CAPTURE_ACTIONS,
  TODO_CAPTURE_SESSION_KEY_PREFIX,
  type TodoCaptureAction,
} from "./todo-capture-contract.js";
import { refreshTodoCapture } from "./todo-capture-facts.js";
import { type TodoCaptureState } from "./todo-capture-stage.js";
import { dispatchWebSessionRun } from "./web-session-dispatch.js";
import type { Employee, Engine } from "../shared/types.js";
import type { ApiContext } from "./api.js";

/**
 * Quick capture: one rough sentence in, one shaping session out.
 *
 * The POST is the whole compact-composer contract — it spawns the Todo Shaper
 * on the operator's raw text and returns immediately. The optional GET answers
 * how far an accepted capture later got by DERIVING the stage from real state
 * (todo-capture-facts.ts reads it, todo-capture-stage.ts rules on it), rather
 * than reading a stage anyone wrote down.
 *
 * The spawn deliberately follows the Todo Dispatcher route's recipe step for
 * step — org lookup, attachment check, engine check, createSession /
 * insertMessage / updateSession / enqueue / dispatch — because the two are the
 * same act and a second, subtly different spawn is how one of them rots.
 */

const CAPTURE_TEXT_MAX = 4_000;

/** The wire shape. `captureId` is the shaping session's id: the session IS the
 *  capture, so there is no second identifier to keep in step with it, and a
 *  capture survives a restart exactly as long as its session does. */
export interface TodoCaptureWire extends TodoCaptureState {}

function capturePrompt(text: string, action: TodoCaptureAction): string {
  const handoff = action === "shape"
    ? "Shape only. Create or land the Todo, then stop without dispatching it."
    : "Shape & Dispatch. Create or land the Todo, then dispatch a newly created Todo.";
  return [
    "A capture was thrown at the Todos board. Shape it into one well-formed Todo.",
    handoff,
    "",
    "Capture:",
    text,
  ].join("\n");
}

/** Both halves of the honesty contract at once: the operator sees the POST
 *  refusal beside the retryable composer, and the same sentence lands in the
 *  gateway log. A refusal that only ever existed in one HTTP response is not
 *  diagnosable after the fact. */
function refuse(res: ServerResponse, status: number, error: string): void {
  logger.warn(`Quick capture refused (${status}): ${error}`);
  json(res, { error }, status);
}

/** The capture itself, or a refusal already written to the response. */
async function readCapture(
  req: HttpRequest,
  res: ServerResponse,
): Promise<{ text: string; speechDerived: boolean; action: TodoCaptureAction } | undefined> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return undefined;
  const body = (parsed.body ?? {}) as { text?: unknown; speechDerived?: unknown; action?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    refuse(res, 400, "text is required — a capture with nothing in it has nothing to shape");
    return undefined;
  }
  if (text.length > CAPTURE_TEXT_MAX) {
    refuse(res, 400, `text is ${text.length} characters; the cap is ${CAPTURE_TEXT_MAX}. Use the full Todo form for something this long.`);
    return undefined;
  }
  const action = body.action === undefined ? "shape-and-dispatch" : body.action;
  if (!TODO_CAPTURE_ACTIONS.some((candidate) => candidate === action)) {
    refuse(res, 400, "action must be either shape or shape-and-dispatch");
    return undefined;
  }
  return { text, speechDerived: body.speechDerived === true, action: action as TodoCaptureAction };
}

/** The Shaper and a live engine for it, or a refusal already written. */
function readyShaper(
  res: ServerResponse,
  context: ApiContext,
  config: ReturnType<ApiContext["getConfig"]>,
): { shaper: Employee; engine: Engine } | undefined {
  const shaper = orgRegistry(config).get(TODO_SHAPER_NAME);
  if (!shaper?.system) {
    const error = "the built-in Todo Shaper is unavailable";
    logger.warn(`Quick capture refused (500): ${error}`);
    serverError(res, error);
    return undefined;
  }
  // The same two questions the Dispatcher route asks, answered in the same
  // words: a Shaper that cannot attach the company tools cannot create a Todo,
  // so starting it would spend a turn to achieve nothing.
  const preflight = preflightSystemEmployee({
    employee: shaper, label: "Todo Shaper", settingLabel: "Todo Shaper",
    engineName: shaper.engine, globalMcp: config.mcp,
    getEngine: (name) => context.sessionManager.getEngine(name),
  });
  if (!preflight.ok) {
    refuse(res, preflight.status, preflight.error);
    return undefined;
  }
  return { shaper, engine: preflight.engine };
}

async function startCapture(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  const capture = await readCapture(req, res);
  if (!capture) return;
  const { text, speechDerived, action } = capture;

  const config = context.getConfig();
  const ready = readyShaper(res, context, config);
  if (!ready) return;
  const { shaper, engine } = ready;

  const prompt = capturePrompt(text, action);
  // A voice capture is a transcription and may be misheard. The Shaper is told
  // so on the engine side only; the operator's own words are what gets stored.
  const { visible, engine: enginePrompt } = resolveMessageAudiences(prompt, speechDerived);
  const sessionKey = `${TODO_CAPTURE_SESSION_KEY_PREFIX}${crypto.randomUUID()}`;
  const session = createSession({
    engine: shaper.engine,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    employee: shaper.name,
    model: shaper.model,
    effortLevel: shaper.effortLevel,
    prompt: visible,
    title: "Quick capture",
    portalName: config.portal?.portalName,
  });
  insertMessage(session.id, "user", visible);
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  session.status = "running";

  const queueItemId = enqueueQueueItem(session.id, sessionKey, visible, { dispatch: { attachments: [], speechDerived } });
  context.emit("queue:updated", { sessionId: session.id, sessionKey });
  dispatchWebSessionRun(session, enginePrompt, engine, context, { queueItemId });

  return json(res, refreshTodoCapture(context, session.id), 201);
}

/**
 * A capture that restated a Todo the board already had.
 *
 * It lives beside the capture routes rather than among the work-item ones
 * because it is a fact about a CAPTURE — it is the third way one can end, and
 * `factsFor` above is its only reader. The route is essentially one call:
 * `linkSession` is what turns "the Shaper said this was a duplicate" from prose
 * in a comment into something the derived stage is allowed to read, and it
 * already appends the `session_linked` audit event.
 *
 * Session callers only. The operator has no capture to land, and an operator
 * link here would put a stage on a capture that never claimed it.
 */
function recordCaptureLanding(req: HttpRequest, res: ServerResponse, todoId: string): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
  });
  if (identity.kind !== "session") {
    const error = identity.kind === "unidentified-tool"
      ? UNIDENTIFIED_TOOL_CALL_ERROR
      : "capture-landing records where a session's own capture landed, so it needs a session caller";
    return json(res, { error }, 403), true;
  }
  if (!isTodoId(todoId)) {
    return json(res, { error: "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix" }, 400), true;
  }
  const item = getWorkItem(todoId);
  if (!item) return json(res, { error: `Todo ${todoId} not found` }, 404), true;
  try {
    linkSession(item.id, identity.callerId, getSession(identity.callerId)?.employee ?? null);
  } catch (error) {
    return serverError(res, `capture landing on ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`), true;
  }
  return json(res, { workItemId: item.id, workItemTitle: item.title, sessionId: identity.callerId }), true;
}

export async function handleTodoCaptureApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  if (route.method === "POST" && route.pathname === "/api/todo-captures") {
    await startCapture(req, res, context);
    return true;
  }

  const landing = matchRoute("/api/work-items/:id/capture-landing", route.pathname);
  if (route.method === "POST" && landing) return recordCaptureLanding(req, res, landing.id);

  const params = matchRoute("/api/todo-captures/:id", route.pathname);
  if (route.method === "GET" && params) {
    if (!getSession(params.id)) {
      return json(res, { error: `capture ${params.id} not found` }, 404), true;
    }
    return json(res, refreshTodoCapture(context, params.id)), true;
  }

  return false;
}

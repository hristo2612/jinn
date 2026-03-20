import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { CronJob, Engine, IncomingMessage, JinnConfig, Session, Target } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildContext } from "../sessions/context.js";
import {
  initDb,
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  deleteSessions,
  insertMessage,
  getMessages,
  enqueueQueueItem,
  cancelQueueItem,
  getQueueItems,
  cancelAllPendingQueueItems,
  listAllPendingQueueItems,
  getFile,
} from "../sessions/registry.js";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  LOGS_DIR,
  TMP_DIR,
  FILES_DIR,
} from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { getSttStatus, downloadModel, transcribe as sttTranscribe, resolveLanguages, WHISPER_LANGUAGES } from "../stt/stt.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveEffort } from "../shared/effort.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt, recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { loadJobs, saveJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { runCronJob } from "../cron/runner.js";
import QRCode from "qrcode";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { handleFilesRequest, ensureFilesDir } from "./files.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel } from "../sessions/callbacks.js";
import { loadInstances } from "../cli/instances.js";

export interface ApiContext {
  config: JinnConfig;
  sessionManager: SessionManager;
  startTime: number;
  getConfig: () => JinnConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../shared/types.js").Connector>;
  reloadConnectorInstances?: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
}

export function resumePendingWebQueueItems(context: ApiContext): void {
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  let resumed = 0;
  for (const item of pending) {
    let session = getSession(item.sessionId);
    if (!session) {
      cancelQueueItem(item.id);
      continue;
    }
    if (session.source !== "web") continue;
    session = maybeRevertEngineOverride(session);

    const config = context.getConfig();
    const engine = context.sessionManager.getEngine(session.engine);
    if (!engine) {
      cancelQueueItem(item.id);
      updateSession(session.id, { status: "error", lastActivity: new Date().toISOString(), lastError: `Engine "${session.engine}" not available` });
      continue;
    }

    // Ensure the session is in a runnable state
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });

    dispatchWebSessionRun(session, item.prompt, engine, config, context, { queueItemId: item.id });
    resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
}

function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[] },
): void {
  const run = async () => {
    await context.sessionManager.getQueue().enqueue(session.sessionKey || session.sourceRef, async () => {
      context.emit("session:started", { sessionId: session.id });
      await runWebSession(session, prompt, engine, config, context, opts?.attachments);
    }, opts?.queueItemId);
  };

  const launch = () => {
    run().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
      updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", {
        sessionId: session.id,
        result: null,
        error: errMsg,
      });
    });
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(launch, opts.delayMs);
  } else {
    launch();
  }
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function readBodyRaw(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req: HttpRequest, res: ServerResponse): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const raw = await readBody(req);
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    badRequest(res, "Invalid JSON in request body");
    return { ok: false };
  }
}

/** Resolve an array of file IDs to local filesystem paths for engine consumption. */
function resolveAttachmentPaths(fileIds: unknown): string[] {
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

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

const SANITIZED_KEYS = new Set(["token", "botToken", "signingSecret", "appToken"]);

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    // Skip sanitized secret placeholders — keep original value
    if (SANITIZED_KEYS.has(key) && sv === "***") continue;
    if (Array.isArray(sv)) {
      // For arrays (e.g. instances), preserve secrets from matching items
      if (Array.isArray(tv)) {
        result[key] = sv.map((item: unknown) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const srcItem = item as Record<string, unknown>;
            // Find matching target item by id
            const matchTarget = (tv as unknown[]).find(
              (t) => t && typeof t === "object" && (t as Record<string, unknown>).id === srcItem.id
            ) as Record<string, unknown> | undefined;
            if (matchTarget) return deepMerge(matchTarget, srcItem);
          }
          return item;
        });
      } else {
        result[key] = sv;
      }
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function serializeSession(session: Session, context: ApiContext): Session {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  return {
    ...session,
    queueDepth,
    transportState,
  };
}

function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port, path: "/api/status", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export async function handleApiRequest(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  try {
    // GET /api/status
    if (method === "GET" && pathname === "/api/status") {
      const config = context.getConfig();
      const sessions = listSessions();
      const running = sessions.filter((s) => s.status === "running").length;
      const connectors = Object.fromEntries(
        Array.from(context.connectors.values()).map((connector) => [connector.name, connector.getHealth()]),
      );
      return json(res, {
        status: "ok",
        uptime: Math.floor((Date.now() - context.startTime) / 1000),
        port: config.gateway.port || 7777,
        engines: {
          default: config.engines.default,
          claude: { model: config.engines.claude.model, available: true },
          codex: { model: config.engines.codex.model, available: true },
        },
        sessions: { total: sessions.length, running, active: running },
        connectors,
      });
    }

    // GET /api/instances
    if (method === "GET" && pathname === "/api/instances") {
      const instances = loadInstances();
      const currentPort = context.getConfig().gateway.port || 7777;
      const results = await Promise.all(
        instances.map(async (inst) => ({
          name: inst.name,
          port: inst.port,
          running: inst.port === currentPort ? true : await checkInstanceHealth(inst.port),
          current: inst.port === currentPort,
        }))
      );
      return json(res, results);
    }

    // GET /api/sessions
    if (method === "GET" && pathname === "/api/sessions") {
      const sessions = listSessions();
      return json(res, sessions.map((session) => serializeSession(session, context)));
    }

    // GET /api/sessions/interrupted — list sessions that can be resumed after a restart
    if (method === "GET" && pathname === "/api/sessions/interrupted") {
      const { getInterruptedSessions } = await import("../sessions/registry.js");
      const interrupted = getInterruptedSessions();
      return json(res, interrupted.map((session) => serializeSession(session, context)));
    }

    // GET /api/sessions/:id
    let params = matchRoute("/api/sessions/:id", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      let messages = getMessages(params.id);

      // Backfill from Claude Code's JSONL transcript if our DB has no messages
      if (messages.length === 0 && session.engineSessionId) {
        const transcriptMessages = loadTranscriptMessages(session.engineSessionId);
        if (transcriptMessages.length > 0) {
          for (const tm of transcriptMessages) {
            insertMessage(params.id, tm.role, tm.content);
          }
          messages = getMessages(params.id);
        }
      }

      // Support ?last=N to return only the N most recent messages
      const lastN = parseInt(url.searchParams.get("last") || "0", 10);
      if (lastN > 0 && messages.length > lastN) {
        messages = messages.slice(-lastN);
      }

      return json(res, { ...serializeSession(session, context), messages });
    }

    // DELETE /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);

      // Kill any live engine process for this session before deleting it.
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine) && engine.isAlive(params.id)) {
        logger.info(`Killing live engine process for deleted session ${params.id}`);
        engine.kill(params.id);
      }

      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // POST /api/sessions/:id/stop
    params = matchRoute("/api/sessions/:id/stop", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine) && engine.isAlive(params.id)) {
        engine.kill(params.id, "Interrupted by user");
      }
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      updateSession(params.id, { status: "idle", lastActivity: new Date().toISOString(), lastError: null });
      context.emit("session:stopped", { sessionId: params.id });
      return json(res, { status: "stopped", sessionId: params.id });
    }

    // POST /api/sessions/:id/reset — clear stuck session state (stale engine IDs, errors)
    params = matchRoute("/api/sessions/:id/reset", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine) && engine.isAlive(params.id)) {
        engine.kill(params.id, "Interrupted by reset");
      }
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
      delete meta["engineSessions"];
      delete meta["engineOverride"];
      updateSession(params.id, {
        status: "idle",
        engineSessionId: null,
        lastActivity: new Date().toISOString(),
        lastError: null,
        transportMeta: meta as any,
      });
      logger.info(`Session ${params.id} reset via API (cleared engineSessions, engineOverride, engineSessionId, lastError)`);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, { status: "reset", sessionId: params.id });
    }

    // DELETE /api/sessions/:id/queue/:itemId — cancel specific item
    const queueItemParams = matchRoute("/api/sessions/:id/queue/:itemId", pathname);
    if (method === "DELETE" && queueItemParams) {
      const session = getSession(queueItemParams.id);
      if (!session) return notFound(res);
      const cancelled = cancelQueueItem(queueItemParams.itemId);
      if (!cancelled) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Item not found or already running" }));
        return;
      }
      context.emit("queue:updated", { sessionId: queueItemParams.id, sessionKey: session.sessionKey });
      return json(res, { status: "cancelled", itemId: queueItemParams.itemId });
    }

    // GET /api/sessions/:id/queue
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const items = getQueueItems(session.sessionKey || session.sourceRef || session.id);
      return json(res, items);
    }

    // DELETE /api/sessions/:id/queue — clear all pending
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().clearQueue(sessionKey);
      const cancelled = cancelAllPendingQueueItems(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
      return json(res, { status: "cleared", cancelled });
    }

    // POST /api/sessions/:id/queue/pause
    params = matchRoute("/api/sessions/:id/queue/pause", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().pauseQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
      return json(res, { status: "paused", sessionId: params.id });
    }

    // POST /api/sessions/:id/queue/resume
    params = matchRoute("/api/sessions/:id/queue/resume", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().resumeQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
      return json(res, { status: "resumed", sessionId: params.id });
    }

    // POST /api/sessions/bulk-delete
    if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const ids: string[] = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, "ids array is required");

      // Kill any live engine processes before deleting
      for (const id of ids) {
        const session = getSession(id);
        if (!session) continue;
        const engine = context.sessionManager.getEngine(session.engine);
        if (engine && isInterruptibleEngine(engine) && engine.isAlive(id)) {
          engine.kill(id);
        }
      }

      const count = deleteSessions(ids);
      for (const id of ids) {
        context.emit("session:deleted", { sessionId: id });
      }
      logger.info(`Bulk deleted ${count} sessions`);
      return json(res, { status: "deleted", count });
    }

    // GET /api/sessions/:id/children
    params = matchRoute("/api/sessions/:id/children", pathname);
    if (method === "GET" && params) {
      const children = listSessions().filter((s) => s.parentSessionId === params!.id);
      return json(res, children.map((child) => serializeSession(child, context)));
    }

    // GET /api/sessions/:id/transcript — return raw Claude Code session transcript
    params = matchRoute("/api/sessions/:id/transcript", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      if (!session.engineSessionId) return json(res, []);
      const entries = loadRawTranscript(session.engineSessionId);
      return json(res, entries);
    }

    // POST /api/sessions/stub — create a session with a pre-populated assistant
    // message but do NOT run the engine. Used for lazy onboarding.
    if (method === "POST" && pathname === "/api/sessions/stub") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const greeting = body.greeting || "Hey! Say hi when you're ready to get started.";
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: body.employee,
        title: body.title,
        portalName: config.portal?.portalName,
      });
      insertMessage(session.id, "assistant", greeting);
      logger.info(`Stub session created: ${session.id}`);
      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = body.prompt || body.message;
      if (!prompt) return badRequest(res, "prompt or message is required");
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: body.employee,
        parentSessionId: body.parentSessionId,
        effortLevel: body.effortLevel,
        prompt,
        portalName: config.portal?.portalName,
      });
      logger.info(`Web session created: ${session.id}`);
      insertMessage(session.id, "user", prompt);

      // Run engine asynchronously — respond immediately, push result via WebSocket
      const engine = context.sessionManager.getEngine(engineName);
      if (!engine) {
        updateSession(session.id, {
          status: "error",
          lastError: `Engine "${engineName}" not available`,
        });
        return json(res, { ...serializeSession({ ...session, status: "error", lastError: `Engine "${engineName}" not available` }, context) }, 201);
      }

      // Set status to "running" synchronously BEFORE returning the response.
      // This prevents a race condition where the caller polls immediately and
      // sees "idle" status before runWebSession has a chance to set "running".
      updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
      session.status = "running";

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, queueSessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });

      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      let session = getSession(params.id);
      if (!session) return notFound(res);
      session = maybeRevertEngineOverride(session);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = body.message || body.prompt;
      if (!prompt) return badRequest(res, "message is required");

      // Allow internal callers (e.g. child session callbacks) to specify a non-user role
      const messageRole: string = body.role === "notification" ? "notification" : "user";
      const isNotification = messageRole === "notification";

      const config = context.getConfig();
      const engine = context.sessionManager.getEngine(session.engine);
      if (!engine) return serverError(res, `Engine "${session.engine}" not available`);

      // Persist the message immediately
      insertMessage(session.id, messageRole, prompt);

      // Emit notification event for UI display (renders as system banner, not user bubble)
      if (isNotification) {
        context.emit("session:notification", { sessionId: session.id, message: prompt });
        // Don't return early — fall through to enqueue + dispatch so the engine
        // (e.g. the COO) actually processes the notification and can respond.
      }

      if (!isNotification && session.status === "waiting") {
        const expectedResetAt = getClaudeExpectedResetAt();
        const resumeText = expectedResetAt
          ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
          : null;
        const queuedText =
          `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. Your message is queued and will run automatically.`;
        insertMessage(session.id, "notification", queuedText);
        context.emit("session:notification", { sessionId: session.id, message: queuedText });
      }

      // If a turn is already running, check whether we should interrupt or queue.
      // Notifications (child completion callbacks) should never interrupt — just queue.
      if (session.status === "running") {
        if (!isNotification && (config.sessions?.interruptOnNewMessage ?? true) && isInterruptibleEngine(engine) && engine.isAlive(session.id)) {
          logger.info(`Interrupting running session ${session.id} for new message`);
          engine.kill(session.id, "Interrupted: new message received");
          // Wait briefly for the process to exit so the queue slot frees up
          await new Promise((resolve) => setTimeout(resolve, 500));
          context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
        } else {
          context.emit("session:queued", { sessionId: session.id, message: prompt });
        }
      }

      // If session was interrupted by a restart, clear the error and resume
      if (session.status === "interrupted") {
        logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
        updateSession(session.id, {
          status: "running",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        context.emit("session:resumed", { sessionId: session.id });
      }

      // Clear any pending cancellation so the new message runs normally.
      context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey });

      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, { status: "queued", sessionId: session.id });
    }

    // GET /api/cron
    if (method === "GET" && pathname === "/api/cron") {
      const jobs = loadJobs();
      // Enrich with last run status
      const enriched = jobs.map((job) => {
        const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
        let lastRun = null;
        if (fs.existsSync(runFile)) {
          const lines = fs.readFileSync(runFile, "utf-8").trim().split("\n").filter(Boolean);
          if (lines.length > 0) {
            try { lastRun = JSON.parse(lines[lines.length - 1]); } catch {}
          }
        }
        return { ...job, lastRun };
      });
      return json(res, enriched);
    }

    // GET /api/cron/:id/runs
    params = matchRoute("/api/cron/:id/runs", pathname);
    if (method === "GET" && params) {
      const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);
      if (!fs.existsSync(runFile)) return json(res, []);
      const lines = fs
        .readFileSync(runFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return json(res, lines);
    }

    // POST /api/cron — create new cron job
    if (method === "POST" && pathname === "/api/cron") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const jobs = loadJobs();
      const newJob: CronJob = {
        id: body.id || crypto.randomUUID(),
        name: body.name || "untitled",
        enabled: body.enabled ?? true,
        schedule: body.schedule || "0 * * * *",
        timezone: body.timezone,
        engine: body.engine,
        model: body.model,
        employee: body.employee,
        prompt: body.prompt || "",
        delivery: body.delivery,
      };
      jobs.push(newJob);
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, newJob, 201);
    }

    // PUT /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "PUT" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      jobs[idx] = { ...jobs[idx], ...body, id: params.id };
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, jobs[idx]);
    }

    // DELETE /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "DELETE" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const removed = jobs.splice(idx, 1)[0];
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, { deleted: removed.id, name: removed.name });
    }

    // POST /api/cron/:id/trigger — manually run a cron job now
    params = matchRoute("/api/cron/:id/trigger", pathname);
    if (method === "POST" && params) {
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === params!.id);
      if (!job) return notFound(res);

      logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);

      // Fire and forget — respond immediately, run in background
      runCronJob(job, context.sessionManager, context.getConfig(), context.connectors).catch(
        (err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`)
      );

      return json(res, {
        triggered: true,
        jobId: job.id,
        name: job.name,
        employee: job.employee,
        message: `Cron job "${job.name}" triggered manually`,
      });
    }

    // GET /api/org
    if (method === "GET" && pathname === "/api/org") {
      const { scanOrgFull } = await import("./org.js");
      const { employees: empMap, departments: deptMap } = scanOrgFull();
      const departments = Array.from(deptMap.keys()); // paths like "nexamon-studio/design"
      const employees = Array.from(empMap.keys());
      return json(res, { departments, employees });
    }

    // GET /api/org/tree — nested org hierarchy
    if (method === "GET" && pathname === "/api/org/tree") {
      const { scanOrgFull } = await import("./org.js");
      const { employees: empMap, departments: deptMap } = scanOrgFull();

      interface DeptNode {
        name: string;
        displayName: string;
        description?: string;
        path: string;
        manager?: { name: string; displayName: string; rank: string } | null;
        employees: { name: string; displayName: string; rank: string }[];
        children: DeptNode[];
      }

      function buildNode(deptPath: string): DeptNode | null {
        const dept = deptMap.get(deptPath);
        if (!dept) return null;

        const managerEmp = dept.manager ? empMap.get(dept.manager) : undefined;
        const node: DeptNode = {
          name: dept.name,
          displayName: dept.displayName,
          description: dept.description,
          path: dept.path,
          manager: managerEmp
            ? { name: managerEmp.name, displayName: managerEmp.displayName, rank: managerEmp.rank }
            : dept.manager ? { name: dept.manager, displayName: dept.manager, rank: "unknown" } : null,
          employees: dept.employees
            .filter((eName) => eName !== dept.manager) // manager listed separately
            .map((eName) => {
              const emp = empMap.get(eName);
              return emp
                ? { name: emp.name, displayName: emp.displayName, rank: emp.rank }
                : { name: eName, displayName: eName, rank: "unknown" };
            }),
          children: dept.children
            .map((childPath) => buildNode(childPath))
            .filter((n): n is DeptNode => n !== null),
        };
        return node;
      }

      // Root departments: those with no parent
      const roots: DeptNode[] = [];
      for (const [deptPath, dept] of deptMap) {
        if (!dept.parent || !deptMap.has(dept.parent)) {
          const node = buildNode(deptPath);
          if (node) roots.push(node);
        }
      }

      // Also include unassigned employees (orgPath undefined or not matching any dept)
      const assignedEmployees = new Set<string>();
      for (const dept of deptMap.values()) {
        for (const eName of dept.employees) assignedEmployees.add(eName);
      }
      const unassigned = Array.from(empMap.values())
        .filter((emp) => !assignedEmployees.has(emp.name))
        .map((emp) => ({ name: emp.name, displayName: emp.displayName, rank: emp.rank }));

      return json(res, { tree: roots, unassigned });
    }

    // GET /api/org/employees/:name
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "GET" && params) {
      // Recursive search for employee YAML at any depth
      const findEmployeeFile = (dir: string, name: string): string | null => {
        if (!fs.existsSync(dir)) return null;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isFile() && (entry.name === `${name}.yaml` || entry.name === `${name}.yml`) && entry.name !== "department.yaml") {
            return fullPath;
          }
          if (entry.isDirectory()) {
            const found = findEmployeeFile(fullPath, name);
            if (found) return found;
          }
        }
        return null;
      };
      const filePath = findEmployeeFile(ORG_DIR, params.name);
      if (!filePath) return notFound(res);
      const content = yaml.load(fs.readFileSync(filePath, "utf-8"));
      return json(res, content);
    }

    // GET /api/org/departments/*/board — supports nested paths like nexamon-studio/design
    if (method === "GET" && pathname.startsWith("/api/org/departments/") && pathname.endsWith("/board")) {
      const deptPath = pathname.slice("/api/org/departments/".length, -"/board".length);
      const boardPath = path.join(ORG_DIR, deptPath, "board.json");
      if (!fs.existsSync(boardPath)) return notFound(res);
      const board = JSON.parse(fs.readFileSync(boardPath, "utf-8"));
      return json(res, board);
    }

    // PUT /api/org/departments/*/board — supports nested paths
    if (method === "PUT" && pathname.startsWith("/api/org/departments/") && pathname.endsWith("/board")) {
      const deptPath = pathname.slice("/api/org/departments/".length, -"/board".length);
      const deptDir = path.join(ORG_DIR, deptPath);
      if (!fs.existsSync(deptDir)) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const boardPath = path.join(deptDir, "board.json");
      fs.writeFileSync(boardPath, JSON.stringify(body, null, 2));
      context.emit("board:updated", { department: deptPath });
      return json(res, { status: "ok" });
    }

    // GET /api/skills/search?q=<query> — search the skills.sh registry
    if (method === "GET" && pathname === "/api/skills/search") {
      const query = url.searchParams.get("q") || "";
      if (!query) return badRequest(res, "q parameter is required");
      try {
        const { execFileSync } = await import("node:child_process");
        const output = execFileSync("npx", ["skills", "find", query], {
          encoding: "utf-8",
          timeout: 30000,
        });
        const results = parseSkillsSearchOutput(output);
        return json(res, results);
      } catch (err) {
        const msg = err instanceof Error ? (err as any).stderr || err.message : String(err);
        return json(res, { results: [], error: msg });
      }
    }

    // GET /api/skills/manifest — return skills.json contents
    if (method === "GET" && pathname === "/api/skills/manifest") {
      const { readManifest } = await import("../cli/skills.js");
      return json(res, readManifest());
    }

    // POST /api/skills/install — install a skill from skills.sh
    if (method === "POST" && pathname === "/api/skills/install") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const source = body.source;
      if (!source) return badRequest(res, "source is required");
      try {
        const {
          snapshotDirs, diffSnapshots, copySkillToInstance,
          upsertManifest, extractSkillName, findExistingSkill,
        } = await import("../cli/skills.js");
        const { execFileSync } = await import("node:child_process");

        const before = snapshotDirs();
        execFileSync("npx", ["skills", "add", String(source), "-g", "-y"], {
          encoding: "utf-8",
          timeout: 60000,
        });
        const after = snapshotDirs();
        const newDirs = diffSnapshots(before, after);

        let skillName: string;
        if (newDirs.length > 0) {
          const installed = newDirs[0];
          skillName = installed.name;
          copySkillToInstance(installed.name, path.join(installed.dir, installed.name));
        } else {
          skillName = extractSkillName(source);
          const existing = findExistingSkill(skillName);
          if (existing) {
            copySkillToInstance(existing.name, existing.dir);
          } else {
            return serverError(res, "Skill installed globally but could not locate the directory");
          }
        }
        upsertManifest(skillName, source);
        return json(res, { status: "installed", name: skillName });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, msg);
      }
    }

    // GET /api/skills
    if (method === "GET" && pathname === "/api/skills") {
      if (!fs.existsSync(SKILLS_DIR)) return json(res, []);
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      const skills = entries.filter((e) => e.isDirectory()).map((e) => {
        const skillMdPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
        let description = "";
        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          // Extract description from YAML frontmatter, ## Trigger section, or first paragraph
          const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
            if (descMatch) {
              description = descMatch[1].trim();
            }
          }
          if (!description) {
            const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
            if (triggerMatch) {
              description = triggerMatch[1].trim();
            } else {
              // Use first non-heading, non-empty, non-frontmatter line
              const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
              const lines = bodyContent.split("\n");
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("#")) {
                  description = trimmed;
                  break;
                }
              }
            }
          }
        }
        return { name: e.name, description };
      });
      return json(res, skills);
    }

    // GET /api/skills/:name
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "GET" && params) {
      const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) return notFound(res);
      const content = fs.readFileSync(skillMd, "utf-8");
      return json(res, { name: params.name, content });
    }

    // DELETE /api/skills/:name — remove a skill
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "DELETE" && params) {
      const skillDir = path.join(SKILLS_DIR, params.name);
      if (!fs.existsSync(skillDir)) return notFound(res);
      fs.rmSync(skillDir, { recursive: true, force: true });
      const { removeFromManifest } = await import("../cli/skills.js");
      removeFromManifest(params.name);
      logger.info(`Skill removed via API: ${params.name}`);
      return json(res, { status: "removed", name: params.name });
    }

    // GET /api/config
    if (method === "GET" && pathname === "/api/config") {
      const config = context.getConfig();
      // Sanitize: remove any secrets/tokens from connectors
      const rawConnectors = config.connectors || {};
      const sanitizedConnectors: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawConnectors)) {
        if (k === "instances" && Array.isArray(v)) {
          sanitizedConnectors.instances = v.map((inst: any) => ({
            ...inst,
            token: inst?.token ? "***" : undefined,
            signingSecret: inst?.signingSecret ? "***" : undefined,
            botToken: inst?.botToken ? "***" : undefined,
            appToken: inst?.appToken ? "***" : undefined,
          }));
        } else if (v && typeof v === "object") {
          sanitizedConnectors[k] = {
            ...v,
            token: (v as any)?.token ? "***" : undefined,
            signingSecret: (v as any)?.signingSecret ? "***" : undefined,
            botToken: (v as any)?.botToken ? "***" : undefined,
            appToken: (v as any)?.appToken ? "***" : undefined,
          };
        } else {
          sanitizedConnectors[k] = v;
        }
      }
      const sanitized = {
        ...config,
        connectors: sanitizedConnectors,
      };
      return json(res, sanitized);
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      // Basic validation: must be a plain object
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "Config must be a JSON object");
      }
      // Validate known top-level keys
      // Keep this aligned with `JinnConfig` in src/shared/types.ts
      const KNOWN_KEYS = [
        "jinn",
        "gateway",
        "engines",
        "connectors",
        "logging",
        "mcp",
        "sessions",
        "cron",
        "notifications",
        "portal",
        "context",
        "stt",
        "skills",
        "remotes",
      ];
      const unknownKeys = Object.keys(body).filter((k) => !KNOWN_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return badRequest(res, `Unknown config keys: ${unknownKeys.join(", ")}`);
      }
      // Validate critical field types
      if (body.gateway !== undefined) {
        if (typeof body.gateway !== "object" || Array.isArray(body.gateway)) {
          return badRequest(res, "gateway must be an object");
        }
        if (body.gateway.port !== undefined && typeof body.gateway.port !== "number") {
          return badRequest(res, "gateway.port must be a number");
        }
      }
      if (body.engines !== undefined && (typeof body.engines !== "object" || Array.isArray(body.engines))) {
        return badRequest(res, "engines must be an object");
      }
      // Deep-merge incoming config with existing config to preserve
      // fields not included in the update (e.g. connector tokens).
      let existing: Record<string, unknown> = {};
      try {
        existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
      } catch { /* start fresh if unreadable */ }
      const merged = deepMerge(existing, body);
      const yamlStr = yaml.dump(merged);
      fs.writeFileSync(CONFIG_PATH, yamlStr);
      logger.info("Config updated via API");
      return json(res, { status: "ok" });
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      const logFile = path.join(LOGS_DIR, "gateway.log");
      if (!fs.existsSync(logFile)) return json(res, { lines: [] });
      const n = parseInt(url.searchParams.get("n") || "100", 10);
      // Read only the last 64KB to avoid loading the entire file into memory
      const MAX_BYTES = 64 * 1024;
      const stat = fs.statSync(logFile);
      const readSize = Math.min(stat.size, MAX_BYTES);
      const fd = fs.openSync(logFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      const allLines = buf.toString("utf-8").split("\n").filter(Boolean);
      const lines = allLines.slice(-n);
      return json(res, { lines });
    }

    // POST /api/connectors/reload — stop all instance connectors and restart from config
    if (method === "POST" && pathname === "/api/connectors/reload") {
      if (!context.reloadConnectorInstances) {
        return json(res, { error: "Connector reload not available" }, 501);
      }
      try {
        const result = await context.reloadConnectorInstances();
        context.emit("connectors:reloaded", result);
        return json(res, result);
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /api/connectors/:id/incoming — receive proxied Discord messages from primary instance
    // Supports both the legacy /api/connectors/discord/incoming and named instance ids
    params = matchRoute("/api/connectors/:id/incoming", pathname);
    if (method === "POST" && params && params.id) {
      // Try the exact instance id first, then fall back to "discord" for the legacy path
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);
      if (!("deliverMessage" in connector)) {
        return json(res, { error: "Discord connector is not in remote mode" }, 400);
      }

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // Download attachments from Discord CDN URLs to local temp
      const { downloadAttachment } = await import("../connectors/discord/format.js");
      const attachments = await Promise.all(
        (body.attachments || []).map(async (att: { name: string; url: string; mimeType: string }) => {
          if (att.url) {
            try {
              const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
              return { name: att.name, url: att.url, mimeType: att.mimeType, localPath };
            } catch {
              return { name: att.name, url: att.url, mimeType: att.mimeType };
            }
          }
          return att;
        }),
      );

      const incomingMsg: IncomingMessage = {
        connector: params.id,
        source: "discord",
        sessionKey: body.sessionKey,
        channel: body.channel,
        thread: body.thread,
        user: body.user,
        userId: body.userId,
        text: body.text,
        messageId: body.messageId,
        attachments,
        replyContext: body.replyContext || {},
        transportMeta: body.transportMeta,
        raw: body,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connector as any).deliverMessage(incomingMsg);
      return json(res, { status: "delivered" });
    }

    // POST /api/connectors/:id/proxy — proxy connector operations from remote instances
    // Supports both the legacy /api/connectors/discord/proxy and named instance ids
    params = matchRoute("/api/connectors/:id/proxy", pathname);
    if (method === "POST" && params && params.id) {
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      const action = body.action as string;
      const target = body.target as Target | undefined;
      let messageId: string | undefined;

      switch (action) {
        case "sendMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.sendMessage(target, body.text)) as string | undefined;
          break;
        case "replyMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.replyMessage(target, body.text)) as string | undefined;
          break;
        case "editMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          await connector.editMessage(target, body.text);
          break;
        case "addReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.addReaction(target, body.emoji);
          break;
        case "removeReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.removeReaction(target, body.emoji);
          break;
        case "setTypingStatus":
          if (connector.setTypingStatus) {
            await connector.setTypingStatus(body.channelId ?? "", body.threadTs, body.status ?? "");
          }
          break;
        default:
          return badRequest(res, `Unknown proxy action: ${action}`);
      }

      return json(res, { status: "ok", messageId });
    }

    // POST /api/connectors/:name/send — send a message via a connector
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      await connector.sendMessage(
        { channel: body.channel, thread: body.thread },
        body.text,
      );
      return json(res, { status: "sent" });
    }

    // GET /api/connectors/whatsapp/qr — return current QR code as PNG data URL
    if (method === "GET" && pathname === "/api/connectors/whatsapp/qr") {
      const waConnector = context.connectors.get("whatsapp");
      if (!waConnector) return notFound(res);
      const qrString = (waConnector as WhatsAppConnector).getQrCode();
      if (!qrString) return json(res, { qr: null });
      const dataUrl = await QRCode.toDataURL(qrString, { width: 256, margin: 2 });
      return json(res, { qr: dataUrl });
    }

    // GET /api/connectors — list available connectors
    if (method === "GET" && pathname === "/api/connectors") {
      const connectors = Array.from(context.connectors.entries()).map(([instanceId, connector]) => ({
        name: connector.name,
        instanceId,
        // Include employee binding if the connector exposes it
        employee: (connector as any).config?.employee ?? undefined,
        ...connector.getHealth(),
      }));
      return json(res, connectors);
    }

    // GET /api/activity — recent activity derived from sessions
    if (method === "GET" && pathname === "/api/activity") {
      const sessions = listSessions();
      const events: Array<{ event: string; payload: unknown; ts: number }> = [];
      for (const s of sessions) {
        const ts = new Date(s.lastActivity || s.createdAt).getTime();
        const transportState = context.sessionManager.getQueue().getTransportState(s.sessionKey || s.sourceRef, s.status);
        if (transportState === "running") {
          events.push({ event: "session:started", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "queued") {
          events.push({ event: "session:queued", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "idle") {
          events.push({ event: "session:completed", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "error") {
          events.push({ event: "session:error", payload: { sessionId: s.id, employee: s.employee, error: s.lastError, connector: s.connector }, ts });
        }
      }
      events.sort((a, b) => b.ts - a.ts);
      return json(res, events.slice(0, 30));
    }

    // GET /api/onboarding — check if onboarding is needed
    if (method === "GET" && pathname === "/api/onboarding") {
      const sessions = listSessions();
      const hasEmployees = fs.existsSync(ORG_DIR) &&
        fs.readdirSync(ORG_DIR, { recursive: true }).some(
          (f) => String(f).endsWith(".yaml") && !String(f).endsWith("department.yaml")
        );
      const config = context.getConfig();
      const onboarded = config.portal?.onboarded === true;
      return json(res, {
        needed: !onboarded && sessions.length === 0 && !hasEmployees,
        onboarded,
        sessionsCount: sessions.length,
        hasEmployees,
        portalName: config.portal?.portalName ?? null,
        operatorName: config.portal?.operatorName ?? null,
      });
    }

    // POST /api/onboarding — persist portal personalization
    if (method === "POST" && pathname === "/api/onboarding") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const { portalName, operatorName, language } = body;

      // Read current config and merge portal settings
      const config = context.getConfig();
      const updated = {
        ...config,
        portal: {
          ...config.portal,
          onboarded: true,
          ...(portalName !== undefined && { portalName: portalName || undefined }),
          ...(operatorName !== undefined && { operatorName: operatorName || undefined }),
          ...(language !== undefined && { language: language || undefined }),
        },
      };

      // Write updated config
      const yamlStr = yaml.dump(updated, { lineWidth: -1 });
      fs.writeFileSync(CONFIG_PATH, yamlStr);
      logger.info(`Onboarding: portal name="${portalName}", operator="${operatorName}", language="${language}"`);

      const effectiveName = portalName || "Jinn";
      const languageSection = language && language !== "English"
        ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
        : "";

      // Update CLAUDE.md with personalized COO name and language
      const claudeMdPath = path.join(JINN_HOME, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) {
        let claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
        // Replace the identity line in CLAUDE.md
        claudeMd = claudeMd.replace(
          /^You are \w+, the COO of the user's AI organization\.$/m,
          `You are ${effectiveName}, the COO of the user's AI organization.`,
        );
        // Remove existing language section if present, then add new one if needed
        claudeMd = claudeMd.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) {
          claudeMd = claudeMd.trimEnd() + languageSection + "\n";
        }
        fs.writeFileSync(claudeMdPath, claudeMd);
      }

      // Update AGENTS.md with personalized name and language
      const agentsMdPath = path.join(JINN_HOME, "AGENTS.md");
      if (fs.existsSync(agentsMdPath)) {
        let agentsMd = fs.readFileSync(agentsMdPath, "utf-8");
        // Replace the bold identity line (e.g. "You are **Jinn**")
        agentsMd = agentsMd.replace(
          /You are \*\*\w+\*\*/,
          `You are **${effectiveName}**`,
        );
        // Remove existing language section if present, then add new one if needed
        agentsMd = agentsMd.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) {
          agentsMd = agentsMd.trimEnd() + languageSection + "\n";
        }
        fs.writeFileSync(agentsMdPath, agentsMd);
      }

      context.emit("config:updated", { portal: updated.portal });
      return json(res, { status: "ok", portal: updated.portal });
    }

    // ── STT (Speech-to-Text) ──────────────────────────────────
    if (method === "GET" && pathname === "/api/stt/status") {
      const config = context.getConfig();
      const languages = resolveLanguages(config.stt);
      const status = getSttStatus(config.stt?.model, languages);
      return json(res, status);
    }

    if (method === "POST" && pathname === "/api/stt/download") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";

      downloadModel(model, (progress) => {
        context.emit("stt:download:progress", { progress });
      }).then(() => {
        // Update config to mark STT as enabled
        try {
          const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
          const cfg = yaml.load(raw) as Record<string, unknown>;
          if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
          const sttCfg = cfg.stt as Record<string, unknown>;
          sttCfg.enabled = true;
          sttCfg.model = model;
          if (!sttCfg.languages) sttCfg.languages = ["en"];
          fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
        } catch (err) {
          logger.error(`Failed to update config after STT download: ${err}`);
        }
        context.emit("stt:download:complete", { model });
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT download failed: ${msg}`);
        context.emit("stt:download:error", { error: msg });
      });

      return json(res, { status: "downloading", model });
    }

    if (method === "POST" && pathname === "/api/stt/transcribe") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";
      const languages = resolveLanguages(config.stt);
      // Accept language from query param, fall back to first configured language
      const requestedLang = url.searchParams.get("language");
      const language = requestedLang && languages.includes(requestedLang) ? requestedLang : languages[0];

      const audioBuffer = await readBodyRaw(req);
      if (audioBuffer.length === 0) return badRequest(res, "No audio data");
      if (audioBuffer.length > 100 * 1024 * 1024) return badRequest(res, "Audio too large (100MB max)");

      const contentType = req.headers["content-type"] || "audio/webm";
      const ext = contentType.includes("wav") ? ".wav"
        : contentType.includes("mp4") || contentType.includes("m4a") ? ".m4a"
        : contentType.includes("ogg") ? ".ogg"
        : ".webm";

      const tmpFile = path.join(TMP_DIR, `stt-${crypto.randomUUID()}${ext}`);
      fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(tmpFile, audioBuffer);

      try {
        const text = await sttTranscribe(tmpFile, model, language);
        return json(res, { text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT transcription failed: ${msg}`);
        return serverError(res, `Transcription failed: ${msg}`);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }

    if (method === "PUT" && pathname === "/api/stt/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const langs = body.languages;

      if (!Array.isArray(langs) || langs.length === 0) {
        return badRequest(res, "languages must be a non-empty array");
      }

      const invalid = langs.filter((l) => typeof l !== "string" || !WHISPER_LANGUAGES[l]);
      if (invalid.length > 0) {
        return badRequest(res, `Invalid language codes: ${invalid.join(", ")}`);
      }

      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = yaml.load(raw) as Record<string, unknown>;
        if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
        const sttCfg = cfg.stt as Record<string, unknown>;
        sttCfg.languages = langs;
        // Remove deprecated language field if present
        delete sttCfg.language;
        fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
        return json(res, { status: "ok", languages: langs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, `Failed to update STT config: ${msg}`);
      }
    }

    // /api/files — file upload/download/management
    if (pathname.startsWith("/api/files")) {
      const handled = await handleFilesRequest(req, res, pathname, method, context);
      if (handled) return;
    }

    // ── Goals ────────────────────────────────────────────────────────
    // GET /api/goals
    if (method === "GET" && pathname === "/api/goals") {
      const { listGoals } = await import("./goals.js");
      const db = initDb();
      return json(res, listGoals(db));
    }

    // GET /api/goals/tree
    if (method === "GET" && pathname === "/api/goals/tree") {
      const { getGoalTree } = await import("./goals.js");
      const db = initDb();
      return json(res, getGoalTree(db));
    }

    // POST /api/goals
    if (method === "POST" && pathname === "/api/goals") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const { createGoal } = await import("./goals.js");
      const db = initDb();
      const goal = createGoal(db, _parsed.body as Record<string, unknown>);
      return json(res, goal, 201);
    }

    // GET /api/goals/:id
    params = matchRoute("/api/goals/:id", pathname);
    if (method === "GET" && params) {
      const { getGoal } = await import("./goals.js");
      const db = initDb();
      const goal = getGoal(db, params.id);
      if (!goal) return notFound(res);
      return json(res, goal);
    }

    // PUT /api/goals/:id
    params = matchRoute("/api/goals/:id", pathname);
    if (method === "PUT" && params) {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const { updateGoal } = await import("./goals.js");
      const db = initDb();
      const goal = updateGoal(db, params.id, _parsed.body as Record<string, unknown>);
      if (!goal) return notFound(res);
      return json(res, goal);
    }

    // DELETE /api/goals/:id
    params = matchRoute("/api/goals/:id", pathname);
    if (method === "DELETE" && params) {
      const { deleteGoal } = await import("./goals.js");
      const db = initDb();
      deleteGoal(db, params.id);
      return json(res, { status: "ok" });
    }

    // ── Costs ────────────────────────────────────────────────────────
    // GET /api/costs/summary
    if (method === "GET" && pathname === "/api/costs/summary") {
      const { getCostSummary } = await import("./costs.js");
      const rawPeriod = url.searchParams.get("period") ?? "month";
      const period = (rawPeriod === "day" || rawPeriod === "week" || rawPeriod === "month") ? rawPeriod : "month";
      return json(res, getCostSummary(period));
    }

    // GET /api/costs/by-employee
    if (method === "GET" && pathname === "/api/costs/by-employee") {
      const { getCostsByEmployee } = await import("./costs.js");
      const rawPeriod = url.searchParams.get("period") ?? "month";
      const period = (rawPeriod === "week") ? "week" : "month";
      return json(res, getCostsByEmployee(period));
    }

    // ── Budgets ──────────────────────────────────────────────────────
    // GET /api/budgets
    if (method === "GET" && pathname === "/api/budgets") {
      const { getBudgetStatus } = await import("./budgets.js");
      const config = context.getConfig();
      const budgetConfig = (config as any).budgets?.employees as Record<string, number> | undefined ?? {};
      const employees = Object.keys(budgetConfig);
      const statuses = employees.map((emp) => ({
        employee: emp,
        ...getBudgetStatus(emp, budgetConfig),
      }));
      return json(res, { employees: budgetConfig, statuses });
    }

    // PUT /api/budgets
    if (method === "PUT" && pathname === "/api/budgets") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as Record<string, unknown>;
      let existing: Record<string, unknown> = {};
      try {
        existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
      } catch { /* start fresh if unreadable */ }
      const merged = deepMerge(existing, { budgets: { employees: body } });
      fs.writeFileSync(CONFIG_PATH, yaml.dump(merged));
      logger.info("Budget limits updated via API");
      return json(res, { status: "ok" });
    }

    // POST /api/budgets/:employee/override
    params = matchRoute("/api/budgets/:employee/override", pathname);
    if (method === "POST" && params) {
      const { overrideBudget } = await import("./budgets.js");
      const config = context.getConfig();
      const budgetConfig = (config as any).budgets?.employees as Record<string, number> | undefined ?? {};
      return json(res, overrideBudget(params.employee, budgetConfig));
    }

    // GET /api/budgets/events
    if (method === "GET" && pathname === "/api/budgets/events") {
      const { getBudgetEvents } = await import("./budgets.js");
      return json(res, getBudgetEvents());
    }

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    return serverError(res, msg);
  }
}

/**
 * Parse the output of `npx skills find <query>` into structured results.
 *
 * Format:
 * ```
 * owner/repo@skill-name  <N> installs
 * └ https://skills.sh/owner/repo/skill-name
 * ```
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseSkillsSearchOutput(
  output: string,
): Array<{ name: string; source: string; url: string; installs: number }> {
  const results: Array<{ name: string; source: string; url: string; installs: number }> = [];
  const lines = output.trim().split("\n");

  for (let i = 0; i < lines.length; i++) {
    const headerLine = stripAnsi(lines[i]).trim();
    // Match "owner/repo@skill-name  <N> installs"
    const headerMatch = headerLine.match(/^(\S+)\s+(\d+)\s+installs?$/);
    if (!headerMatch) continue;

    const source = headerMatch[1];
    const installs = parseInt(headerMatch[2], 10);
    const atIdx = source.lastIndexOf("@");
    const name = atIdx > 0 ? source.slice(atIdx + 1) : source;

    // Next line should be the URL
    let url = "";
    if (i + 1 < lines.length) {
      const urlLine = stripAnsi(lines[i + 1]).trim();
      const urlMatch = urlLine.match(/[└]\s*(https?:\/\/\S+)/);
      if (urlMatch) {
        url = urlMatch[1];
        i++; // consume the URL line
      }
    }

    results.push({ name, source, url, installs });
  }
  return results;
}

/**
 * Load messages from a Claude Code JSONL transcript file.
 * Used as a fallback when the messages DB is empty (pre-existing sessions).
 */
interface TranscriptContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  id?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  content: TranscriptContentBlock[];
}

function loadRawTranscript(engineSessionId: string): TranscriptEntry[] {
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const entries: TranscriptEntry[] = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        const rawContent = msg.content;
        const blocks: TranscriptContentBlock[] = [];

        if (typeof rawContent === "string") {
          if (rawContent.trim()) blocks.push({ type: "text", text: rawContent });
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            const blockType = String(b.type || "");
            if (blockType === "text") {
              blocks.push({ type: "text", text: String(b.text || "") });
            } else if (blockType === "tool_use") {
              blocks.push({
                type: "tool_use",
                name: String(b.name || ""),
                input: (b.input as Record<string, unknown>) || {},
              });
            } else if (blockType === "tool_result") {
              const resultContent = b.content;
              let resultText: string;
              if (typeof resultContent === "string") {
                resultText = resultContent;
              } else if (Array.isArray(resultContent)) {
                resultText = (resultContent as Record<string, unknown>[])
                  .filter((rc) => rc.type === "text")
                  .map((rc) => String(rc.text || ""))
                  .join("");
              } else {
                resultText = "";
              }
              blocks.push({ type: "tool_result", text: resultText });
            } else if (blockType === "thinking") {
              blocks.push({ type: "thinking", text: String(b.thinking || b.text || "") });
            }
          }
        }

        if (blocks.length > 0) {
          entries.push({ role: type as "user" | "assistant", content: blocks });
        }
      } catch {
        continue;
      }
    }
    return entries;
  }
  return [];
}

function loadTranscriptMessages(engineSessionId: string): Array<{ role: string; content: string }> {
  // Claude Code stores transcripts in ~/.claude/projects/<project-key>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  // Search all project dirs for the transcript
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const messages: Array<{ role: string; content: string }> = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        let content = msg.content;
        if (Array.isArray(content)) {
          content = content
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text)
            .join("");
        }
        if (typeof content === "string" && content.trim()) {
          messages.push({ role: type, content: content.trim() });
        }
      } catch {
        continue;
      }
    }
    return messages;
  }
  return [];
}

async function runWebSession(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  attachments?: string[],
): Promise<void> {
  const currentSession = getSession(session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${session.id} before run start`);
    return;
  }
  logger.info(`Web session ${currentSession.id} running engine "${currentSession.engine}" (model: ${currentSession.model || "default"})`);

  // Ensure status is "running" (may already be set by the POST handler)
  const currentStatus = getSession(currentSession.id);
  if (currentStatus && currentStatus.status !== "running") {
    updateSession(currentSession.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });
  }

  try {
    // If this session has an assigned employee, load their persona
    let employee: import("../shared/types.js").Employee | undefined;
    if (currentSession.employee) {
      const { findEmployee } = await import("./org.js");
      const { scanOrg } = await import("./org.js");
      const registry = scanOrg();
      employee = findEmployee(currentSession.employee, registry);
    }

    const systemPrompt = buildContext({
      source: "web",
      channel: currentSession.sourceRef,
      user: "web-user",
      employee,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: currentSession.id,
    });

    const engineConfig = currentSession.engine === "codex"
      ? config.engines.codex
      : config.engines.claude;
    const effortLevel = resolveEffort(engineConfig, currentSession, employee);

    let lastHeartbeatAt = 0;
    const runHeartbeat = setInterval(() => {
      updateSession(currentSession.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
    }, 5000);

    const syncSinceIso = (currentSession.transportMeta as any)?.claudeSyncSince;
    const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
    const syncRequested = currentSession.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
    const promptToRun = syncRequested
      ? (() => {
        const sinceMessages = getMessages(currentSession.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        return `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      })()
      : prompt;

    const result = await engine.run({
      prompt: promptToRun,
      resumeSessionId: currentSession.engineSessionId ?? undefined,
      systemPrompt,
      cwd: JINN_HOME,
      bin: engineConfig.bin,
      model: currentSession.model ?? engineConfig.model,
      effortLevel,
      cliFlags: employee?.cliFlags,
      attachments: attachments?.length ? attachments : undefined,
      sessionId: currentSession.id,
      onStream: (delta) => {
        const now = Date.now();
        if (now - lastHeartbeatAt >= 2000) {
          lastHeartbeatAt = now;
          updateSession(currentSession.id, {
            status: "running",
            lastActivity: new Date(now).toISOString(),
          });
        }
        try {
          context.emit("session:delta", {
            sessionId: currentSession.id,
            type: delta.type,
            content: delta.content,
            toolName: delta.toolName,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
      },
    }).finally(() => {
      clearInterval(runHeartbeat);
    });

    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    const wasInterrupted = result.error?.startsWith("Interrupted");
    const rateLimit = !wasInterrupted ? detectRateLimit(result) : { limited: false as const };

    if (rateLimit.limited) {
      recordClaudeRateLimit(rateLimit.resetsAt);
      const strategy = config.sessions?.rateLimitStrategy ?? "fallback";

      // Optional fallback: switch to GPT (Codex) while Claude resets
      if (currentSession.engine === "claude" && strategy === "fallback") {
        const fallbackName = config.sessions?.fallbackEngine ?? "codex";
        const fallbackEngine = context.sessionManager.getEngine(fallbackName);
        if (fallbackEngine) {
          const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
          const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
          const syncSince = new Date().toISOString();

          const resumeText = resumeAt
            ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
            : null;

          const notificationText =
            `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`;
          insertMessage(currentSession.id, "notification", notificationText);
          context.emit("session:notification", { sessionId: currentSession.id, message: notificationText });

          const nextMeta = { ...(currentSession.transportMeta || {}) } as Record<string, unknown>;
          const engineSessionsRaw = nextMeta.engineSessions;
          const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
            ? { ...(engineSessionsRaw as Record<string, unknown>) }
            : {};
          if (currentSession.engineSessionId) {
            engineSessions.claude = currentSession.engineSessionId;
          }
          nextMeta.engineSessions = engineSessions;
          nextMeta.engineOverride = { originalEngine: "claude", originalEngineSessionId: currentSession.engineSessionId, until: until.toISOString(), syncSince };

          updateSession(currentSession.id, {
            engine: fallbackName,
            transportMeta: nextMeta as any,
            status: "running",
            lastActivity: new Date().toISOString(),
            lastError: resumeAt
              ? `Claude usage limit — using GPT until ${resumeAt.toISOString()}`
              : "Claude usage limit — using GPT temporarily",
          });

          notifyDiscordChannel(
            `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} switching to GPT.`,
          );

          const fallbackConfig = config.engines.codex;
          const fallbackEffort = resolveEffort(fallbackConfig, currentSession, employee);
          const codexResume = typeof engineSessions.codex === "string" ? (engineSessions.codex as string) : undefined;
          const history = getMessages(currentSession.id)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
          const historyText = history.slice(-12).join("\n\n");
          const fallbackPrompt = codexResume
            ? prompt
            : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;
          const fallbackResult = await fallbackEngine.run({
            prompt: fallbackPrompt,
            resumeSessionId: codexResume,
            systemPrompt,
            cwd: JINN_HOME,
            bin: fallbackConfig.bin,
            model: currentSession.model ?? fallbackConfig.model,
            effortLevel: fallbackEffort,
            cliFlags: employee?.cliFlags,
            sessionId: currentSession.id,
            onStream: (delta) => {
              context.emit("session:delta", {
                sessionId: currentSession.id,
                type: delta.type,
                content: delta.content,
                toolName: delta.toolName,
              });
            },
          });

          if (fallbackResult.result) {
            insertMessage(currentSession.id, "assistant", fallbackResult.result);
          }

          // Persist Codex thread id so future fallbacks can resume it
          const nextEngineSessions = { ...engineSessions };
          if (fallbackResult.sessionId) {
            nextEngineSessions.codex = fallbackResult.sessionId;
          }
          const metaAfter = { ...(getSession(currentSession.id)?.transportMeta || nextMeta) } as Record<string, unknown>;
          metaAfter.engineSessions = nextEngineSessions;
          updateSession(currentSession.id, { transportMeta: metaAfter as any });

          const completedFallback = updateSession(currentSession.id, {
            engineSessionId: fallbackResult.sessionId,
            status: fallbackResult.error ? "error" : "idle",
            lastActivity: new Date().toISOString(),
            lastError: fallbackResult.error ?? null,
          });
          if (completedFallback) {
            notifyParentSession(completedFallback, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs });
          }

          context.emit("session:completed", {
            sessionId: currentSession.id,
            employee: currentSession.employee || config.portal?.portalName || "Jinn",
            title: currentSession.title,
            result: fallbackResult.result,
            error: fallbackResult.error || null,
            cost: fallbackResult.cost,
            durationMs: fallbackResult.durationMs,
          });

          return;
        }
      }

      // Otherwise: wait until reset and retry automatically
      const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
      const deadlineMs = computeRateLimitDeadlineMs(
        rateLimit.resetsAt,
        rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
      );

      const resumeText = resumeAt
        ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;

      logger.info(
        `Web session ${currentSession.id} hit Claude usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
      );

      // Send hardcoded Discord notification — does not depend on the LLM
      notifyDiscordChannel(
        `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
      );

      const notificationText =
        `⏳ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`;
      insertMessage(currentSession.id, "notification", notificationText);
      context.emit("session:notification", { sessionId: currentSession.id, message: notificationText });

      const waitingSession = updateSession(currentSession.id, {
        ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
        status: "waiting",
        lastActivity: new Date().toISOString(),
        lastError: resumeAt
          ? `Claude usage limit — resumes ${resumeAt.toISOString()}`
          : "Claude usage limit — waiting for reset",
      });

      // Notify parent session about rate limit (fire-and-forget)
      notifyRateLimited(
        (waitingSession ?? { ...currentSession, status: "waiting" }) as Session,
        resumeAt
          ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
          : undefined,
      );

      context.emit("session:rate-limited", {
        sessionId: currentSession.id,
        employee: currentSession.employee,
        error: result.error,
        resetsAt: rateLimit.resetsAt ?? null,
      });

      // Keep lastActivity fresh while waiting (UI / status endpoints)
      const heartbeat = setInterval(() => {
        updateSession(currentSession.id, { status: "waiting", lastActivity: new Date().toISOString() });
      }, 60_000);

      try {
        let attempt = 0;
        let nextDelayMs = delayMs;

        while (Date.now() < deadlineMs) {
          await new Promise<void>((r) => setTimeout(r, nextDelayMs));
          attempt++;

          // Check session still exists and hasn't been cancelled
          const current = getSession(currentSession.id);
          if (!current || current.status === "error") {
            logger.info(`Web session ${currentSession.id} stopped while waiting for usage reset`);
            return;
          }

          logger.info(`Web session ${currentSession.id} retrying after usage limit (attempt ${attempt})`);

          const retryResult = await engine.run({
            prompt,
            resumeSessionId: current.engineSessionId ?? undefined,
            systemPrompt,
            cwd: JINN_HOME,
            bin: engineConfig.bin,
            model: current.model ?? engineConfig.model,
            effortLevel,
            cliFlags: employee?.cliFlags,
            sessionId: currentSession.id,
            onStream: (delta) => {
              context.emit("session:delta", {
                sessionId: currentSession.id,
                type: delta.type,
                content: delta.content,
                toolName: delta.toolName,
              });
            },
          });

          const retryInterrupted = retryResult.error?.startsWith("Interrupted");
          const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };

          if (retryRateLimit.limited) {
            recordClaudeRateLimit(retryRateLimit.resetsAt);
            logger.info(`Web session ${currentSession.id} still rate limited (attempt ${attempt})`);

            const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
            nextDelayMs = next.delayMs;

            updateSession(currentSession.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              status: "waiting",
              lastActivity: new Date().toISOString(),
              lastError: next.resumeAt
                ? `Claude usage limit — resumes ${next.resumeAt.toISOString()}`
                : "Claude usage limit — waiting for reset",
            });

            continue;
          }

          // Usage limit cleared — handle result
          if (retryResult.result) {
            insertMessage(currentSession.id, "assistant", retryResult.result);
          }

          const completedAfterRetry = updateSession(currentSession.id, {
            ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
            status: retryResult.error ? "error" : "idle",
            lastActivity: new Date().toISOString(),
            lastError: retryResult.error ?? null,
          });

          if (completedAfterRetry) {
            notifyRateLimitResumed(completedAfterRetry);
            notifyDiscordChannel(
              `✅ Claude usage limit cleared. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} resumed.`,
            );
            notifyParentSession(completedAfterRetry, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs });
          }

          context.emit("session:completed", {
            sessionId: currentSession.id,
            employee: currentSession.employee || config.portal?.portalName || "Jinn",
            title: currentSession.title,
            result: retryResult.result,
            error: retryResult.error || null,
            cost: retryResult.cost,
            durationMs: retryResult.durationMs,
          });

          logger.info(`Web session ${currentSession.id} resumed after usage reset`);
          return;
        }

        // Exhausted waiting window
        notifyDiscordChannel(
          `❌ Claude usage limit did not clear in time. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} has been stopped.`,
        );
        const erroredSession = updateSession(currentSession.id, {
          status: "error",
          lastActivity: new Date().toISOString(),
          lastError: "Claude usage limit did not clear in time",
        });
        if (erroredSession) {
          notifyParentSession(erroredSession, { error: "Claude usage limit did not clear in time" });
        }
        context.emit("session:completed", {
          sessionId: currentSession.id,
          result: null,
          error: "Claude usage limit did not clear in time",
        });
        logger.warn(`Web session ${currentSession.id} exhausted usage limit retries`);
        return;
      } finally {
        clearInterval(heartbeat);
      }
    }

    // Persist the assistant response
    if (result.result) {
      insertMessage(currentSession.id, "assistant", result.result);
    }

    const completedSession = updateSession(currentSession.id, {
      ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
      status: result.error ? "error" : "idle",
      lastActivity: new Date().toISOString(),
      lastError: result.error ?? null,
    });
    if (syncRequested && !rateLimit.limited && !wasInterrupted) {
      const meta = (getSession(currentSession.id)?.transportMeta || currentSession.transportMeta || {}) as Record<string, unknown>;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const nextMeta = { ...meta } as Record<string, unknown>;
        delete nextMeta["claudeSyncSince"];
        updateSession(currentSession.id, { transportMeta: nextMeta as any });
      }
    }
    if (completedSession) {
      notifyParentSession(completedSession, { result: result.result, error: result.error ?? null, cost: result.cost, durationMs: result.durationMs });
    }

    context.emit("session:completed", {
      sessionId: currentSession.id,
      employee: currentSession.employee || config.portal?.portalName || "Jinn",
      title: currentSession.title,
      result: result.result,
      error: result.error || null,
      cost: result.cost,
      durationMs: result.durationMs,
    });

    logger.info(
      `Web session ${currentSession.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!getSession(currentSession.id)) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
      return;
    }
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg });
    }
    context.emit("session:completed", {
      sessionId: currentSession.id,
      result: null,
      error: errMsg,
    });
    logger.error(`Web session ${currentSession.id} error: ${errMsg}`);
  }
}

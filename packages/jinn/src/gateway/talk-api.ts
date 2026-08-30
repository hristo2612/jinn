/**
 * `/api/talk/*` — the gateway half of the voice orb.
 *
 * The gateway mints a short-lived provider credential and does the accounting;
 * the browser opens its own connection to the provider and carries the audio.
 * Nothing here touches a media stream. Modelled on workflow-api.ts: one exported
 * handler the main dispatcher tries before its own routes.
 *
 * docs/talk-session-runtime.md is the contract this file implements.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../shared/logger.js";
import { initDb } from "../shared/db.js";
import type { JinnConfig, Session } from "../shared/types.js";
import { createSession } from "../sessions/registry.js";
import { buildTalkControlManifest } from "../talk/control/manifest.js";
import { createTalkDomainRuntime } from "../talk/control/domain-adapters.js";
import type { TalkControlRuntime } from "../talk/control/runtime.js";
import { orgRegistry } from "./org-registry.js";
import { buildStandingBrief } from "../talk/session/brief.js";
import { UNPINNED_MODEL } from "../talk/session/pricing.js";
import { TALK_SESSION_TTL_MS, TalkSessionError, TalkSessionRegistry } from "../talk/session/registry.js";
import { TalkSessionRepository, TalkToolReceiptRepository } from "../talk/session/repository.js";
import { allTools, toolsByName } from "../talk/session/tools.js";
import type { TalkSession } from "../talk/session/types.js";
import { json, type ParsedRoute } from "./route-helpers.js";
import { handleTalkControl } from "./talk-control-api.js";
import { talkSessionStatus } from "./talk-session-status.js";
import { handleTalkConfigApi } from "./talk-config-api.js";
import { handleTalkTtsApi } from "./talk-tts-api.js";
import { handleTalkTranscript } from "./talk-transcript-api.js";
import { handleTalkTopicContext } from "./talk-topic-api.js";
import { mintTalkToken } from "./talk-token-api.js";
import { handOff, recordAction, recordTurn } from "./talk-turn-api.js";
import type { ApiContext } from "./api.js";
import type { CallerIdentity } from "./session-comm-guards.js";
import { handleTalkProactiveApi } from "./talk-proactive-api.js";
import { recordInterruption } from "./talk-interruption-api.js";
import { readTalkAudioProfile, readTalkOpenRequest } from "./talk-audio-profile.js";
import { talkCredentialResponse } from "./talk-credential-response.js";

export interface TalkApiOptions {
  getConfig: () => JinnConfig;
  caller: CallerIdentity;
  context: ApiContext;
  /** Start the engine run for a handoff session. The dispatcher owns the engine
   *  wiring, so it passes this in rather than being imported from here. */
  runHandoff?: (session: Session, prompt: string) => void;
}

const talkDatabase = initDb();
const talkSessions = new TalkSessionRegistry(() => Date.now(), new TalkSessionRepository(talkDatabase));
const controlReceipts = new TalkToolReceiptRepository(talkDatabase);
const controlRuntimes = new Map<string, TalkControlRuntime>();
const controlManifest = buildTalkControlManifest();

export function reapTalkSessions(): void {
  for (const id of talkSessions.reap()) {
    controlRuntimes.delete(id);
    logger.info(`Talk session ${id} parked: no heartbeat for ${TALK_SESSION_TTL_MS}ms`);
  }
}

// Only the argument order is local: talk chooses the status per failure, so one
// shim covers every send — including the 500 that lands on serverError's shape.
const send = (res: ServerResponse, status: number, body: unknown): void => json(res, body, status);

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof TalkSessionError) {
    send(res, error.status, { error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`Talk API failed: ${message}`);
  send(res, 500, { error: "The talk session runtime failed to handle this request." });
}

/** The model the session is billed as. Unset means the provider picks, and a
 *  model the gateway cannot name is a model it cannot price. */
function pinnedModel(config: JinnConfig): string {
  return config.realtime?.model?.trim() || UNPINNED_MODEL;
}

function runtimeFor(session: TalkSession, options: TalkApiOptions): TalkControlRuntime {
  const existing = controlRuntimes.get(session.id);
  if (existing) return existing;
  const runtime = createTalkDomainRuntime(controlManifest, {
    context: options.context,
    sourceSessionId: session.sessionId,
    receipts: controlReceipts,
  });
  controlRuntimes.set(session.id, runtime);
  return runtime;
}

/** The collection itself: POST opens a session, and nothing else lives here. */
async function openRoute(req: IncomingMessage, res: ServerResponse, options: TalkApiOptions, method: string): Promise<boolean> {
  if (method !== "POST") return false;
  const requested = await readTalkOpenRequest(req, res);
  if (!requested) return true;
  const config = options.getConfig();
  const tools = allTools();
  const token = await mintTalkToken(res, config, tools, undefined, requested.noiseReduction);
  if (!token) return true; // mint already answered with 503 or 502
  // The row exists so spend reuses the session ledger. `talk` is already a
  // non-connector source, so nothing tries to reply into it.
  const row = createSession({
    engine: config.realtime?.provider ?? "realtime",
    source: "talk",
    sourceRef: `talk:${randomUUID()}`,
    connector: "talk",
  });
  const session = talkSessions.open({
    sessionId: row.id,
    model: pinnedModel(config),
    brief: buildStandingBrief(config, orgRegistry(config)).text,
    tokenExpiresAt: token.expiresAt,
    ...(requested.browserInstanceId ? { browserInstanceId: requested.browserInstanceId } : {}),
  });
  runtimeFor(session, options);
  send(res, 201, talkCredentialResponse(session, controlManifest, token, tools));
  return true;
}

/** Re-mint for an expiring credential or a resume, against the same universal
 *  catalog the session opened with. */
async function reissueToken(
  res: ServerResponse,
  config: JinnConfig,
  session: TalkSession,
  noiseReduction?: "near_field" | "far_field",
): Promise<void> {
  const tools = toolsByName(session.exposedTools);
  const token = await mintTalkToken(res, config, tools, session.tokenExpiresAt, noiseReduction);
  if (!token) return;
  talkSessions.recordToken(session.id, token.expiresAt);
  const current = talkSessions.get(session.id)!;
  send(res, 200, talkCredentialResponse(current, controlManifest, token, tools));
}

async function recordSessionEvidence(req: IncomingMessage, res: ServerResponse, id: string, action: string): Promise<boolean> {
  if (action === "turn") {
    await recordTurn(req, res, talkSessions.heartbeat(id), talkSessions);
    return true;
  }
  if (action === "transcript") {
    await handleTalkTranscript(req, res, talkSessions.heartbeat(id), { send });
    return true;
  }
  if (action === "context") {
    await handleTalkTopicContext(req, res, talkSessions.heartbeat(id), { send });
    return true;
  }
  if (action === "interruptions") {
    await recordInterruption(req, res, talkSessions.heartbeat(id), talkSessions);
    return true;
  }
  return false;
}

/** `/api/talk/sessions/:id` itself: read it or close it. */
function sessionResource(res: ServerResponse, id: string, method: string): boolean {
  if (method === "DELETE") {
    talkSessions.close(id);
    controlRuntimes.delete(id);
    send(res, 200, { id, state: "closed" });
    return true;
  }
  if (method !== "GET") return false;
  const session = talkSessions.get(id);
  if (!session) {
    send(res, 404, { error: `Talk session ${id} does not exist: it was closed or never opened.` });
    return true;
  }
  send(res, 200, talkSessionStatus(session, controlManifest));
  return true;
}

/** Page lifecycle delivery is best-effort and may replay while an earlier
 * keepalive request settles. The HTTP edge is idempotent; the registry keeps
 * its strict transition contract for all other callers. */
function parkTransportSession(id: string): TalkSession {
  const current = talkSessions.get(id);
  return current?.state === "parked" ? current : talkSessions.park(id);
}

async function rotateSessionCredential(req: IncomingMessage, res: ServerResponse, id: string,
  options: TalkApiOptions, resume: boolean): Promise<boolean> {
  const noiseReduction = await readTalkAudioProfile(req, res);
  if (noiseReduction === null) return true;
  const session = resume ? talkSessions.resume(id) : talkSessions.heartbeat(id);
  if (resume) runtimeFor(session, options);
  await reissueToken(res, options.getConfig(), session, noiseReduction);
  return true;
}

/** `/api/talk/sessions/:id/<action>`. Every branch resolves the session through
 *  the registry, which raises a typed 404 of its own when the id is unknown. */
async function sessionAction(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  action: string,
  options: TalkApiOptions,
): Promise<boolean> {
  if (await recordSessionEvidence(req, res, id, action)) return true;
  switch (action) {
    case "park":
      send(res, 200, talkSessionStatus(parkTransportSession(id), controlManifest));
      return true;
    case "resume":
      return rotateSessionCredential(req, res, id, options, true);
    case "token":
      return rotateSessionCredential(req, res, id, options, false);
    case "heartbeat":
      send(res, 200, talkSessionStatus(talkSessions.heartbeat(id), controlManifest));
      return true;
    case "actions":
      await recordAction(req, res, talkSessions.heartbeat(id), talkSessions);
      return true;
    case "control":
      await handleTalkControl(req, res, id, {
        caller: options.caller,
        manifest: controlManifest,
        registry: talkSessions,
        runtime: runtimeFor(talkSessions.heartbeat(id), options),
        send,
      });
      return true;
    case "handoff":
      await handOff(req, res, talkSessions.heartbeat(id), options.getConfig(), options.runHandoff);
      return true;
    default:
      return false;
  }
}

/** The path segments of a `/api/talk/sessions[/:id[/action]]` request, or null
 *  for anything this router does not own. */
function talkSessionsPath(pathname: string): string[] | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "talk" || parts[2] !== "sessions") return null;
  if (parts.length < 3 || parts.length > 5) return null;
  return parts;
}

/** Writes need the operator. Reads stay open, like the rest of the read surface. */
function unauthorizedWrite(res: ServerResponse, method: string, options: TalkApiOptions): boolean {
  if (method === "GET" || options.caller.kind === "operator") return false;
  const status = options.caller.kind === "unauthenticated" ? 401 : 403;
  send(res, status, { error: "Talk session operator authentication required." });
  return true;
}

/** The talk routes that are not sessions: read-aloud, and the voice-setup probe.
 *  Tried before the session router for the same reason this module is tried
 *  before the main dispatcher — whoever owns the path answers it. */
async function nonSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: JinnConfig,
  options: TalkApiOptions,
): Promise<boolean> {
  if (await handleTalkProactiveApi(req, res, pathname, options.caller)) return true;
  if (await handleTalkTtsApi(req, res, pathname, config)) return true;
  return handleTalkConfigApi(req, res, pathname, config);
}

export async function handleTalkApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: ParsedRoute,
  options: TalkApiOptions,
): Promise<boolean> {
  const { pathname, method } = route;
  const config = options.getConfig();
  if (await nonSessionRoutes(req, res, pathname, config, options)) return true;

  const parts = talkSessionsPath(pathname);
  if (!parts) return false;
  if (unauthorizedWrite(res, method, options)) return true;

  try {
    if (parts.length === 3) return await openRoute(req, res, options, method);
    if (parts.length === 4) return sessionResource(res, parts[3]!, method);
    if (method !== "POST") return false;
    return await sessionAction(req, res, parts[3]!, parts[4]!, options);
  } catch (error) {
    fail(res, error);
    return true;
  }
}

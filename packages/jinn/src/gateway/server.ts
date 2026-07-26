import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { JinnConfig, Connector, Employee, Engine, JsonObject, Session } from "../shared/types.js";
import { loadConfig, normalizeClaudeEngineConfig } from "../shared/config.js";
import {
  getModelRegistry,
  invalidateModelRegistry,
  refreshAntigravityModels,
  refreshClaudeModels,
  refreshCodexModels,
  refreshGrokModels,
  refreshHermesModels,
  refreshPiModels,
} from "../shared/models.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb, scheduleFtsBackfill, recoverStaleSessions, recoverStaleQueueItems, clearAllPartialMessages, consumeRestartAcknowledgements, getInterruptedSessions, listSessions, updateSession, getSession, getMessages, RESTART_ACK_META_KEY } from "../sessions/registry.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import { recoverSessionDeliveryStateOnStartup } from "../sessions/callbacks.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { enforcePtyIdleCap, PtyLifecycleManager, type PtyLifecycleOpts } from "../engines/pty-lifecycle.js";
import { CodexEngine, sweepOrphanCodexSessionHomes } from "../engines/codex.js";
import { CodexInteractiveEngine } from "../engines/codex-interactive.js";
import { AntigravityEngine } from "../engines/antigravity.js";
import { PiEngine } from "../engines/pi.js";
import { GrokEngine } from "../engines/grok.js";
import { GrokInteractiveEngine } from "../engines/grok-interactive.js";
import { HermesAcpEngine } from "../engines/hermes-acp.js";
import { HermesInteractiveEngine } from "../engines/hermes-interactive.js";
import type { PtyViewEngine } from "../engines/pty-view-engine.js";
import { HookRegistry } from "./hook-registry.js";
import { writeGatewayInfo, readGatewayInfo, updateGatewayPtyPids, staleGatewayPids, gatewayBaseUrl } from "./gateway-info.js";
import { authenticateGatewayRequest, authRequiredForRequest, ensureGatewayAuthToken, shouldRequireGatewayAuth, validateGatewayExposure, verifyGatewayAuth } from "./auth.js";
import { reconcileWorkItemsOnStartup, startWorkItemReconciler } from "../work-items/reconcile.js";
import { setTodoLiveEmitter } from "../work-items/live-events.js";
import { setTodoStatusChangeListener } from "../work-items/transitions.js";
import { seedTrust, cleanupSessionSettings } from "../shared/claude-settings.js";
import { GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, JINN_HOME, CLAUDE_SETTINGS_DIR } from "../shared/paths.js";
import { enforceOwnerOnlyDirectory, pathIsOwnerOnly } from "../shared/owner-only.js";

/** Records that boot already tightened JINN_HOME once, so an operator who
 *  deliberately re-widens it afterwards is warned rather than silently overridden. */
const OWNER_ONLY_HEAL_MARKER = path.join(JINN_HOME, ".owner-only-healed");
import { handleApiRequest, isSameOriginBrowserRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { resolveCallerIdentity, sessionCommGuards, LATERAL_MAX_HOPS, type CallerIdentityOptions } from "./session-comm-guards.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import { cleanupMcpConfigFile, sweepOrphanMcpConfigFiles } from "../mcp/resolver.js";
import { startStatusReconciler } from "./status-reconciler.js";
import { armJinnAttachGate } from "../mcp/attachment.js";
import { syncExternalTurn } from "./external-turns.js";
import { pickEncoding, isCompressibleExt, compressStream } from "./compress.js";
import { attachPtyWebSocket } from "./pty-ws.js";
import { openWorkflowDatabase } from "../workflows/repository-migrations.js";
import { importLegacyWorkflowDefinitions } from "../workflows/import-v1.js";
import { WorkflowRepository } from "../workflows/repository.js";
import { WorkflowSessionExecutor } from "../workflows/session-executor.js";
import { WorkflowService } from "../workflows/service.js";

function hasRestartAcknowledgement(session: Session): boolean {
  const meta = session.transportMeta;
  return Boolean(meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta[RESTART_ACK_META_KEY] === "string");
}

/** Preserve running conversational Sessions for resume. Exported as a shutdown test seam. */
export function interruptRunningSessionsForShutdown(): void {
  for (const session of listSessions({ status: "running" })) {
    if (hasRestartAcknowledgement(session)) {
      updateSession(session.id, {
        status: "idle",
        attemptOutcome: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: null,
      });
      logger.info(`Left restart-requesting session ${session.id} idle during gateway shutdown`);
      continue;
    }
    updateSession(session.id, {
      status: "interrupted",
      attemptOutcome: "interrupted",
      lastActivity: new Date().toISOString(),
      lastError: "Interrupted: gateway shutting down gracefully",
    });
    logger.info(`Marked session ${session.id} as interrupted for resume`);
  }
}
import { startWsHeartbeat, trackHeartbeat } from "./ws-heartbeat.js";
import { ensureFilesDir, cleanupOldUploads } from "./files.js";
import { initStt } from "../stt/stt.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import { SlackConnector } from "../connectors/slack/index.js";
import { DiscordConnector, type DiscordConnectorConfig } from "../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../connectors/discord/remote.js";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { TelegramConnector } from "../connectors/telegram/index.js";
import { loadJobs } from "../cron/jobs.js";
import { startScheduler, reloadScheduler, stopScheduler } from "../cron/scheduler.js";
import { scanOrg } from "./org.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type UpgradeRejectionSocket = {
  write(chunk: string): unknown;
  destroy(): unknown;
};

// Extract the lowercased hostname from a Host header (or any host[:port]
// string), tolerating IPv6 brackets and missing ports. Returns null if unparseable.
function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedCorsOrigin(origin: string | undefined, requestHost?: string): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]") {
    return true;
  }
  // Same-origin requests: when the dashboard is served by this same gateway over
  // Tailscale/LAN, the browser's Origin host matches the request's Host header.
  // (Browsers attach Origin on same-origin POST/PUT/etc., so without this remote
  // message sends 403 even though the page itself loaded fine.) Reflecting only an
  // exact host match keeps arbitrary cross sites (evil.example) rejected.
  const reqHostname = hostnameOf(requestHost);
  if (reqHostname && reqHostname === host) return true;
  return false;
}

export function rejectUnverifiedIdentifiedUpgradeCaller(
  req: http.IncomingMessage,
  socket: UpgradeRejectionSocket,
  options: Pick<CallerIdentityOptions, "sessionExists"> = {},
): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: options.sessionExists ?? ((sessionId) => !!getSession(sessionId)),
    verifySessionCapability,
    requireCapability: true,
  });
  if (identity.kind !== "unidentified-tool") return false;
  socket.write(
    "HTTP/1.1 403 Forbidden\r\n" +
    "Connection: close\r\n" +
    "Content-Type: application/json\r\n" +
    "\r\n" +
    JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }),
  );
  socket.destroy();
  return true;
}

export function rejectNonOperatorPtyUpgradeCaller(
  req: http.IncomingMessage,
  socket: UpgradeRejectionSocket,
  options: Pick<CallerIdentityOptions, "sessionExists" | "operatorAuthenticated"> = {},
): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: options.sessionExists ?? ((sessionId) => !!getSession(sessionId)),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated: options.operatorAuthenticated,
  });
  if (identity.kind === "operator") return false;
  const error = identity.kind === "unidentified-tool"
    ? UNIDENTIFIED_TOOL_CALL_ERROR
    : "/ws/pty is operator-only; capability-bound sessions cannot attach to or inject stdin into PTY sessions";
  socket.write(
    "HTTP/1.1 403 Forbidden\r\n" +
    "Connection: close\r\n" +
    "Content-Type: application/json\r\n" +
    "\r\n" +
    JSON.stringify({ error }),
  );
  socket.destroy();
  return true;
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  const allowed = isAllowedCorsOrigin(origin, req.headers.host);
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Jinn-Bootstrap-Grant");
  }
  return allowed;
}

/**
 * How often to re-run dynamic engine model discovery while the gateway is up.
 * Discovery otherwise only runs on boot, on config reload, and as a post-failure
 * fallback — so a gateway with multi-day uptime keeps serving a stale catalog and
 * never sees a model published after it booted. Six hours is cheap (a handful of
 * short-lived CLI spawns plus one Anthropic catalog GET) and bounds that staleness.
 */
export const MODEL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type RuntimeActivityInfo = { activeStreams: number; lastActivityAt: number };
type RuntimeActivitySource = {
  onRuntimeActivity?: (cb: (sessionId: string, info: RuntimeActivityInfo | null) => void) => void;
};

export function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
): boolean {
  if (!fs.existsSync(webDir)) return false;

  // Strip query string before resolving file path
  const urlPath = (req.url || "/").split("?")[0];
  let filePath = path.join(webDir, urlPath);
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(webDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  // Hashed assets (Vite emits /assets/<name>-<hash>.<ext>) are content-addressed
  // — safe to cache forever. Everything else (index.html, root files) must
  // revalidate so the user picks up new hash refs after a deploy. Without this,
  // iOS Safari over Tailscale caches HTML indefinitely and serves stale JS/CSS.
  const isHashedAsset = urlPath.startsWith("/assets/");
  const cacheControl = isHashedAsset
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    if (urlPath.startsWith("/assets/")) {
      res.writeHead(404, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end("Not found");
      return true;
    }

    // SPA fallback to index.html for client-side routing
    const indexPath = path.join(webDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
    return false;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const enc = isCompressibleExt(ext) ? pickEncoding(req.headers["accept-encoding"]) : null;
  const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": cacheControl };
  if (enc) {
    headers["Content-Encoding"] = enc;
    headers["Vary"] = "Accept-Encoding";
    res.writeHead(200, headers);
    fs.createReadStream(resolved).pipe(compressStream(enc)).pipe(res);
    return true;
  }
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
  return true;
}

export type GatewayCleanup = () => Promise<void>;

export async function startGateway(
  config: JinnConfig,
): Promise<GatewayCleanup> {
  const bootId = randomUUID().slice(0, 8);

  // Configure logging
  configureLogger({
    level: config.logging.level,
    stdout: config.logging.stdout,
    file: config.logging.file,
  });

  const gatewayName = config.portal?.portalName || "Jinn";
  logger.info(`Starting ${gatewayName} gateway (boot ${bootId}, pid ${process.pid})...`);

  // Initialize database and recover any sessions stuck from a previous run
  initDb();
  ensureFilesDir();
  // Retention: drop session-upload buckets older than 30 days on boot, then daily.
  try { cleanupOldUploads(30); } catch { /* best-effort */ }
  const uploadCleanupTimer = setInterval(() => {
    try { cleanupOldUploads(30); } catch { /* best-effort */ }
  }, 24 * 60 * 60 * 1000);
  uploadCleanupTimer.unref?.();
  // Retention: sweep orphaned per-session Codex CODEX_HOME overlays whose session
  // records are gone (crash/hard-delete/pre-fix accumulation). This leak reached
  // 276 dirs / 2.4GB. Keep overlays for every session the registry still lists.
  try {
    const swept = sweepOrphanCodexSessionHomes(listSessions().map((s) => s.id));
    if (swept > 0) logger.info(`Swept ${swept} orphaned Codex session home(s)`);
  } catch { /* best-effort */ }
  // Same for per-session --mcp-config temp files: they live as long as the PTY, so
  // a hard kill can orphan them. Keep one for every session the registry still lists.
  try {
    const swept = sweepOrphanMcpConfigFiles(listSessions().map((s) => s.id));
    if (swept > 0) logger.info(`Swept ${swept} orphaned MCP config file(s)`);
  } catch { /* best-effort */ }
  const recovered = recoverStaleSessions();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale session(s) — marked as "interrupted" for resume`);
  }
  // GRS-003a split-brain fix: the sessions just flipped running→interrupted above, so any
  // work item still marked `executing` on the strength of one of those sessions is now stale.
  // Re-derive work-item status from linked-session evidence. Best-effort and idempotent, and
  // the 20s periodic reconciler (startWorkItemReconciler) covers it anyway — so it is DEFERRED
  // past server.listen() (see the setImmediate below) to let the gateway accept requests first
  // instead of blocking boot on an O(active work items) synchronous re-derivation.

  // Log resumable sessions so operators know what can be picked up
  const resumable = getInterruptedSessions();
  if (resumable.length > 0) {
    logger.info(`${resumable.length} interrupted session(s) available for resume:`);
    for (const s of resumable) {
      logger.info(`  - ${s.id} (engine: ${s.engine}, employee: ${s.employee || "none"}, engineSessionId: ${s.engineSessionId})`);
    }
  }
  const recoveredQueue = recoverStaleQueueItems();
  if (recoveredQueue > 0) {
    logger.info(`Recovered ${recoveredQueue} in-flight queue item(s) from previous run — reset to pending`);
  }
  // Resolve gateway port/host early so boot artifacts (gateway.json) can record it.
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";
  const exposure = validateGatewayExposure(config);
  if (!exposure.ok) throw new Error(exposure.error);
  const gatewayAuthToken = ensureGatewayAuthToken(JINN_HOME);
  if (shouldRequireGatewayAuth(config)) logger.info("Gateway auth enabled for privileged API and WebSocket routes");

  // Expose the auth token + base URL to spawned sessions. Every engine builds its
  // child PTY env by spreading `process.env`, so an in-session agent inherits these
  // and can dispatch/poll child sessions in one curl instead of hunting for the
  // token. Same trust boundary as the 0600 gateway.json it already came from.
  // gatewayBaseUrl maps a wildcard bind (0.0.0.0) to 127.0.0.1 and keeps a specific
  // host as-is, so the URL is always reachable from the child.
  process.env.JINN_GATEWAY_TOKEN = gatewayAuthToken;
  process.env.JINN_GATEWAY_URL = gatewayBaseUrl({ port, host });

  // Normalize claude engine config (idempotent — loadConfig already normalized it)
  const claudeCfg = normalizeClaudeEngineConfig(config.engines.claude);

  // The instance holds the gateway token, connector secrets and every session
  // transcript. Report when something else can read it — a broad ACE inherited
  // from the profile on Windows, or group/other bits on POSIX.
  //
  // On POSIX this self-heals ONCE. `jinn setup` now restricts the home, but every
  // instance created before that ran is 0755 (mkdir under a 022 umask), so without
  // a heal those operators would get this warning on every boot forever. chmod 700
  // on a directory we own is cheap, reversible, and exactly what setup does.
  //
  // Windows is warn-only, and the asymmetry is deliberate: repairing there means
  // /inheritance:r, which strips ACEs an operator may have granted on purpose (a
  // sandboxed engine account that needs to read config), and doing that silently
  // under a running install could break it.
  //
  // Once, not every boot: a marker records the attempt, so an operator who
  // deliberately re-widens the directory is told rather than overridden.
  if (!pathIsOwnerOnly(JINN_HOME)) {
    const healed = process.platform !== "win32" && !fs.existsSync(OWNER_ONLY_HEAL_MARKER)
      && enforceOwnerOnlyDirectory(JINN_HOME);
    if (healed) {
      try { fs.writeFileSync(OWNER_ONLY_HEAL_MARKER, new Date().toISOString(), { mode: 0o600 }); } catch { /* best effort */ }
      logger.info(
        `Restricted ${JINN_HOME} to owner-only (0700). It held the gateway token, connector `
        + `secrets and session history while group/other-readable. Done once; re-widen it and `
        + `this becomes a warning rather than a repair.`,
      );
    } else {
      logger.warn(
        `Instance directory ${JINN_HOME} is readable beyond your account — the gateway token, `
        + `connector secrets and session history are exposed to those principals. `
        + `Restrict it with ${process.platform === "win32"
          ? `icacls "${JINN_HOME}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)(F)"`
          : `chmod 700 "${JINN_HOME}"`}`,
      );
    }
  }

  // Reap any orphaned PTYs from a prior crashed run before writing the fresh gateway.json.
  const oldInfo = readGatewayInfo(GATEWAY_INFO_FILE);
  if (oldInfo) {
    for (const pid of staleGatewayPids(oldInfo)) {
      try {
        process.kill(pid, "SIGTERM");
        logger.info(`Reaping stale pid ${pid} from prior gateway`);
      } catch (err: unknown) {
        // ESRCH = no such process — already gone, which is the normal case.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          logger.warn(`Unexpected error reaping stale pid ${pid}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // Write gateway connection info (port + hook secret + pid) for hook-relay discovery.
  const gatewayInfo = writeGatewayInfo(GATEWAY_INFO_FILE, { port, host, pid: process.pid, token: gatewayAuthToken });

  // Hook registry — shared by the interactive engine and the internal hook route.
  const hookRegistry = new HookRegistry();

  // Claude engine — InteractiveClaudeEngine (PTY): runs all work turns
  // (chat, employees, cron, child sessions) AND backs the live xterm CLI view.

  // Copy hook-relay asset next to JINN_HOME so PTY-spawned Claude can find it.
  const relayCandidates = [
    path.join(__dirname, "..", "..", "..", "assets", "hook-relay.mjs"),
    path.join(__dirname, "..", "..", "assets", "hook-relay.mjs"),
    path.join(__dirname, "..", "assets", "hook-relay.mjs"),
  ];
  try {
    const relaySrc = relayCandidates.find((p) => fs.existsSync(p));
    if (relaySrc) {
      fs.copyFileSync(relaySrc, HOOK_RELAY_SCRIPT);
    } else {
      logger.warn(`hook-relay.mjs asset not found in any candidate location; interactive Claude hooks may not work`);
    }
  } catch (err) {
    logger.warn(`Failed to copy hook-relay.mjs: ${err instanceof Error ? err.message : err}`);
  }

  // Seed trust for the Jinn project dir so interactive Claude doesn't prompt.
  try {
    seedTrust(path.join(os.homedir(), ".claude.json"), JINN_HOME);
  } catch (err) {
    logger.warn(`Failed to seed Claude trust: ${err instanceof Error ? err.message : err}`);
  }

  // Orphan-PTY tracking spans all interactive engines.
  // Declared as a hoisted function so the lifecycle callbacks below can reference
  // the not-yet-constructed managers (only invoked later, on adopt/cleanup).
  let codexLifecycle: PtyLifecycleManager | undefined;
  let antigravityLifecycle: PtyLifecycleManager | undefined;
  let grokLifecycle: PtyLifecycleManager | undefined;
  let hermesLifecycle: PtyLifecycleManager | undefined;
  const ptyLifecycles: PtyLifecycleManager[] = [];
  let enforcingGlobalIdleCap = false;
  function refreshPtyPids(): void {
    try {
      const pids = [
        ...claudeLifecycle.livePids(),
        ...(codexLifecycle ? codexLifecycle.livePids() : []),
        ...(antigravityLifecycle ? antigravityLifecycle.livePids() : []),
        ...(grokLifecycle ? grokLifecycle.livePids() : []),
        ...(hermesLifecycle ? hermesLifecycle.livePids() : []),
      ];
      updateGatewayPtyPids(GATEWAY_INFO_FILE, pids);
    } catch { /* best effort */ }
  }
  function enforceGlobalIdleCap(): void {
    if (enforcingGlobalIdleCap) return;
    enforcingGlobalIdleCap = true;
    try {
      enforcePtyIdleCap(ptyLifecycles, claudeCfg.maxLivePtys!);
    } finally {
      enforcingGlobalIdleCap = false;
    }
  }
  function createPtyLifecycle(opts: Omit<PtyLifecycleOpts, "maxLivePtys" | "onIdleStateChange">): PtyLifecycleManager {
    const lifecycle = new PtyLifecycleManager({
      ...opts,
      maxLivePtys: claudeCfg.maxLivePtys!,
      enforceLocalCap: false,
      onIdleStateChange: enforceGlobalIdleCap,
    });
    ptyLifecycles.push(lifecycle);
    return lifecycle;
  }

  const claudeLifecycle: PtyLifecycleManager = createPtyLifecycle({
    onAdopt: () => refreshPtyPids(),
    onCleanup: (id) => {
      cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
      // The --mcp-config temp file stays on the PTY's command line for its whole
      // life (a cold respawn re-reads it), so it dies with the PTY, not the turn.
      cleanupMcpConfigFile(id);
      hookRegistry.unregister(id);
      refreshPtyPids();
    },
  });
  const interactiveClaudeEngine = new InteractiveClaudeEngine(claudeLifecycle, hookRegistry);

  // Codex has two modes: headless `codex exec --json` for chat/default work
  // turns, and real `codex` TUI PTYs for the dashboard CLI view.
  codexLifecycle = createPtyLifecycle({
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const codexInteractiveEngine = new CodexInteractiveEngine(codexLifecycle);

  // Antigravity (`agy`) — PTY-interactive engine. One instance both runs turns
  // and backs the xterm view (agy has no headless mode), so it needs its own
  // PTY lifecycle manager.
  antigravityLifecycle = createPtyLifecycle({
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const antigravityEngine = new AntigravityEngine(antigravityLifecycle);
  grokLifecycle = createPtyLifecycle({
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const grokInteractiveEngine = new GrokInteractiveEngine(grokLifecycle);
  hermesLifecycle = createPtyLifecycle({
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const hermesInteractiveEngine = new HermesInteractiveEngine(hermesLifecycle);
  const piEngine = new PiEngine();
  logger.info("Engines initialized: claude (interactive PTY), codex (headless + interactive PTY), antigravity (interactive PTY), grok (headless + interactive PTY), hermes (headless + interactive PTY), pi");

  const codexEngine = new CodexEngine();
  const grokEngine = new GrokEngine();
  const hermesEngine = new HermesAcpEngine();
  const engines = new Map<string, Engine>();
  // Claude WORK TURNS (chat, employees, cron, child sessions) run on the
  // interactive PTY engine → cc_entrypoint=cli, covered by the Max subscription
  // (per-content-block streaming via transcript tail).
  engines.set("claude", interactiveClaudeEngine);
  logger.info("Claude work turns: INTERACTIVE PTY (cc_entrypoint=cli, Max-subsidized)");
  engines.set("codex", codexEngine);
  engines.set("antigravity", antigravityEngine);
  engines.set("grok", grokEngine);
  engines.set("hermes", hermesEngine);
  engines.set("pi", piEngine);

  // PTY-capable engines, keyed by engine name — the /ws/pty handler routes by
  // session.engine so the xterm view attaches to the right engine.
  const ptyViewEngines: Record<string, Engine & PtyViewEngine> = {
    claude: interactiveClaudeEngine,
    codex: codexInteractiveEngine,
    antigravity: antigravityEngine,
    grok: grokInteractiveEngine,
    hermes: hermesInteractiveEngine,
  };

  // Derive connector names from config
  const connectorNames: string[] = [];
  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    connectorNames.push("slack");
  }
  if (config.connectors?.discord?.botToken || config.connectors?.discord?.proxyVia) {
    connectorNames.push("discord");
  }
  if (config.connectors?.telegram?.botToken) {
    connectorNames.push("telegram");
  }
  if (config.connectors?.whatsapp) {
    connectorNames.push("whatsapp");
  }

  // Build employee registry
  let employeeRegistry = scanOrg();
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);
  const sessionManager = new SessionManager(config, engines, connectorNames, bootId, (id) => employeeRegistry.get(id));

  // Start connectors
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  /** IDs of connectors created from config.connectors.instances[] (vs legacy top-level connectors) */
  const instanceConnectorIds = new Set<string>();

  /**
   * Shared boilerplate for legacy top-level connectors: create, wire onMessage
   * routing, register, and fire-and-forget start. Per-connector config guards
   * and construction stay explicit at the call sites.
   */
  const initConnector = (opts: {
    id: string;
    label: string;
    create: () => Connector;
    /** Read at message time so it tracks the captured config like before. */
    employee: () => string | undefined;
    startMsg?: string;
  }): void => {
    try {
      const connector = opts.create();
      connector.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        const employeeName = opts.employee();
        if (employeeName) {
          const emp = employeeRegistry.get(employeeName);
          if (emp) routeOpts.employee = emp;
        }
        sessionManager.route(msg, connector, routeOpts).catch((err) => {
          logger.error(`${opts.label} route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      // Push to registry before starting so shutdown can clean up even if start is in-flight.
      connectors.push(connector);
      connectorMap.set(opts.id, connector);
      // Fire-and-forget: don't block boot — a slow handshake must not delay HTTP listen.
      connector.start().catch((err) => {
        logger.error(`Failed to start ${opts.label} connector: ${err instanceof Error ? err.message : err}`);
      });
      if (opts.startMsg) logger.info(opts.startMsg);
    } catch (err) {
      logger.error(`Failed to initialize ${opts.label} connector: ${err instanceof Error ? err.message : err}`);
    }
  };

  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    const slackConfig = config.connectors.slack;
    initConnector({
      id: "slack",
      label: "Slack",
      create: () =>
        new SlackConnector({
          appToken: slackConfig.appToken,
          botToken: slackConfig.botToken,
          allowFrom: slackConfig.allowFrom,
          ignoreOldMessagesOnBoot: slackConfig.ignoreOldMessagesOnBoot,
        }),
      employee: () => config.connectors.slack?.employee,
    });
  }

  if (config.connectors?.discord?.proxyVia) {
    // Remote mode: proxy all Discord operations through the primary instance
    const discordConfig = config.connectors.discord;
    initConnector({
      id: "discord",
      label: "remote Discord",
      create: () =>
        new RemoteDiscordConnector({
          proxyVia: discordConfig.proxyVia!,
          channelId: discordConfig.channelId,
        }),
      employee: () => config.connectors.discord?.employee,
      startMsg: "Discord remote connector starting",
    });
  } else if (config.connectors?.discord?.botToken) {
    // Primary mode: direct Discord bot connection
    initConnector({
      id: "discord",
      label: "Discord",
      create: () => new DiscordConnector(config.connectors.discord as DiscordConnectorConfig),
      employee: () => config.connectors.discord?.employee,
      startMsg: "Discord connector starting",
    });
  }

  if (config.connectors?.telegram?.botToken) {
    const telegramConfig = config.connectors.telegram;
    initConnector({
      id: "telegram",
      label: "Telegram",
      create: () =>
        new TelegramConnector({
          botToken: telegramConfig.botToken,
          allowFrom: telegramConfig.allowFrom,
          ignoreOldMessagesOnBoot: telegramConfig.ignoreOldMessagesOnBoot,
          stt: config.stt,
        }),
      employee: () => config.connectors.telegram?.employee,
    });
  }

  if (config.connectors?.whatsapp) {
    initConnector({
      id: "whatsapp",
      label: "WhatsApp",
      create: () => new WhatsAppConnector(config.connectors.whatsapp ?? {}),
      employee: () => config.connectors.whatsapp?.employee,
      startMsg: "WhatsApp connector starting (scan QR code if first run)",
    });
  }

  // Process named connector instances (allows multiple connectors of the same type)
  if (config.connectors?.instances) {
    for (const instance of config.connectors.instances) {
      const { id, type, employee, ...typeConfig } = instance;
      if (!id || !type) {
        logger.warn(`Skipping connector instance without id or type`);
        continue;
      }
      if (connectorMap.has(id)) {
        logger.warn(`Duplicate connector instance id "${id}", skipping`);
        continue;
      }

      try {
        let connector: Connector;
        switch (type) {
          case "discord": {
            const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
            const discord = new DiscordConnector(discordConfig);
            discord.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, discord, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await discord.start();
            connector = discord;
            break;
          }
          case "slack": {
            const slackConfig = { ...typeConfig, id } as any;
            const slack = new SlackConnector(slackConfig);
            slack.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, slack, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await slack.start();
            connector = slack;
            break;
          }
          case "whatsapp": {
            const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
            whatsapp.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await whatsapp.start();
            connector = whatsapp;
            break;
          }
          case "telegram": {
            const telegramConfig = { ...typeConfig, id, stt: config.stt } as any;
            const tg = new TelegramConnector(telegramConfig);
            tg.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, tg, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await tg.start();
            connector = tg;
            break;
          }
          default:
            logger.warn(`Unknown connector type "${type}" for instance "${id}"`);
            continue;
        }
        connectors.push(connector);
        connectorMap.set(id, connector);
        instanceConnectorIds.add(id);
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      } catch (err) {
        logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  sessionManager.setConnectorProvider(() => connectorMap);

  // Reload connector instances from config (stop old instances, start new ones)
  async function reloadConnectorInstances(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const freshConfig = loadConfig();
    const started: string[] = [];
    const stopped: string[] = [];
    const errors: string[] = [];

    // Find instance-based connectors (keys that came from instances array)
    const instanceIds = new Set<string>();
    if (freshConfig.connectors?.instances) {
      for (const inst of freshConfig.connectors.instances) {
        if (inst.id) instanceIds.add(inst.id);
      }
    }

    // Stop old instance connectors that are no longer in config or need refresh
    for (const [id, connector] of connectorMap.entries()) {
      // Skip legacy (top-level) connectors — only reload instance-based ones
      if (!instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        connectorMap.delete(id);
        instanceConnectorIds.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped connector instance "${id}" for reload`);
      } catch (err) {
        errors.push(`Failed to stop ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Start new instances from fresh config
    if (freshConfig.connectors?.instances) {
      for (const instance of freshConfig.connectors.instances) {
        const { id, type, employee, ...typeConfig } = instance;
        if (!id || !type) continue;
        if (connectorMap.has(id)) continue;

        try {
          let connector: Connector;
          switch (type) {
            case "discord": {
              const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
              const discord = new DiscordConnector(discordConfig);
              discord.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, discord, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await discord.start();
              connector = discord;
              break;
            }
            case "slack": {
              const slackConfig = { ...typeConfig, id } as any;
              const slack = new SlackConnector(slackConfig);
              slack.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, slack, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await slack.start();
              connector = slack;
              break;
            }
            case "whatsapp": {
              const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
              whatsapp.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await whatsapp.start();
              connector = whatsapp;
              break;
            }
            case "telegram": {
              const telegramConfig = { ...typeConfig, id, stt: config.stt } as any;
              const tg = new TelegramConnector(telegramConfig);
              tg.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, tg, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await tg.start();
              connector = tg;
              break;
            }
            default:
              errors.push(`Unknown connector type "${type}" for instance "${id}"`);
              continue;
          }
          connectors.push(connector);
          connectorMap.set(id, connector);
          instanceConnectorIds.add(id);
          started.push(id);
          logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
        } catch (err) {
          errors.push(`Failed to start "${id}": ${err instanceof Error ? err.message : err}`);
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    return { started, stopped, errors };
  }

  // Mutable config reference for hot-reload
  let currentConfig = config;

  const startTime = Date.now();

  // Broadcast function (defined early so apiContext can reference it)
  const wsClients = new Set<import("ws").WebSocket>();
  const emit = (event: string, payload: unknown): void => {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.warn(`WebSocket send failed, removing dead client: ${err instanceof Error ? err.message : err}`);
          wsClients.delete(client);
        }
      }
    }
  };
  // ICI-570: in-process Todo writes (cron mints, session-lifecycle reconciles)
  // reach the dashboard through the same company:changed lane the routes use.
  setTodoLiveEmitter((event) => emit("company:changed", event));
  const workflowDatabase = openWorkflowDatabase();
  importLegacyWorkflowDefinitions(workflowDatabase);
  const workflowRepository = new WorkflowRepository(workflowDatabase);
  const workflowService = new WorkflowService({ repository: workflowRepository,
    executor: new WorkflowSessionExecutor(sessionManager, (id) => { const session = getSession(id); if (!session) return null;
      const finalText = [...getMessages(id)].reverse().find((message) => message.role === "assistant")?.content; return { session, ...(finalText ? { finalText } : {}) }; }),
    employees: () => employeeRegistry, models: () => getModelRegistry(currentConfig),
    readTranscript: (id) => getMessages(id).map(({ id: messageId, role, content, timestamp }) => ({ id: messageId, role, content, timestamp })),
    onChange: ({ workflowId, runId }) => emit("company:changed", { entity: "workflow", workflowId, runId }),
    onDefinitionChange: ({ workflowId, revision }) => emit("company:changed", { entity: "workflow", workflowId, revision }) });
  await workflowService.recover(new Date().toISOString());

  // Discover dynamic engine models in the background. Fire-and-forget: the
  // registry serves known/synthesized fallbacks until the snapshots land, then
  // the web UI invalidates its model registry cache via engines:updated.
  const refreshDynamicModels = (cfg: JinnConfig): void => {
    void Promise.all([
      refreshClaudeModels(cfg),
      refreshCodexModels(cfg),
      refreshAntigravityModels(cfg),
      refreshPiModels(cfg),
      refreshGrokModels(cfg),
      refreshHermesModels(cfg),
    ])
      .finally(() => emit("engines:updated", {}));
  };
  refreshDynamicModels(currentConfig);
  // Re-discover periodically so a long-lived gateway picks up models published
  // after boot. Reads `currentConfig` at fire time (not the boot snapshot) so a
  // config reload between ticks is respected. unref'd: never holds the process open.
  const modelRefreshTimer = setInterval(() => {
    refreshDynamicModels(currentConfig);
  }, MODEL_REFRESH_INTERVAL_MS);
  modelRefreshTimer.unref?.();

  // Synchronously re-scan org/ into the in-memory registry. Shared by the API
  // employee-update handler (immediate refresh, no watcher lag) and the chokidar
  // onOrgChange watcher.
  const reloadOrg = () => {
    employeeRegistry = scanOrg();
    logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
    // GRS-017e-fix (finding 1): an employee YAML gaining/losing `jinnMcp: true`
    // changes whether the jinn-attachment smoke gate must be armed — re-arm on
    // every org reload. Fail-closed while the probe is in flight (finding 2),
    // so fire-and-forget cannot widen attachment through a stale verdict.
    void armJinnAttachGate(currentConfig.mcp, { gatewayUrl: process.env.JINN_GATEWAY_URL!, log: logger, employees: employeeRegistry.values() }).catch(() => {});
    // Keep warm PTYs alive on org reload. Native CLI schedulers can sleep inside
    // an otherwise idle PTY for days; recycling "idle" PTYs here would silently
    // delete those loops. New sessions and cold respawns pick up the fresh org.
    emit("org:changed", {});
  };

  // Runtime activity after the foreground turn has settled (in-memory only).
  // Native CLI schedulers such as /loop wake inside the PTY without entering
  // Jinn's queue; engines can expose onRuntimeActivity so the UI stops showing
  // those sessions as transport-idle while the native work is awake.
  const backgroundActivity = new Map<string, { activeStreams: number; lastActivityAt: number }>();
  const handleRuntimeActivity = (sessionId: string, info: RuntimeActivityInfo | null): void => {
    if (info) backgroundActivity.set(sessionId, info);
    else backgroundActivity.delete(sessionId);
    const session = getSession(sessionId);
    const baseTransportState = session
      ? sessionManager.getQueue().getTransportState(session.sessionKey || session.sourceRef, session.status)
      : "idle";
    const transportState = info && info.activeStreams > 0 && baseTransportState !== "error" && baseTransportState !== "interrupted"
      ? "running"
      : baseTransportState;
    emit("session:background", {
      sessionId,
      transportState,
      backgroundActivity: info
        ? { activeStreams: info.activeStreams, lastActivityAt: new Date(info.lastActivityAt).toISOString() }
        : null,
    });
  };
  for (const engine of new Set(Object.values(ptyViewEngines))) {
    (engine as RuntimeActivitySource).onRuntimeActivity?.(handleRuntimeActivity);
  }

  // Unsolicited-Stop consumer: a Stop hook nobody claims within the registry's
  // grace delay means a PTY-native turn (typed straight into the CLI/xterm
  // view — no run() in flight) or a Stop past the late-recovery window. Persist
  // that turn into the messages DB from the transcript tail so chat mode sees it.
  hookRegistry.setUnclaimedHookHandler((jinnSessionId, payload) => {
    try {
      syncExternalTurn(jinnSessionId, emit, payload);
    } catch (err) {
      logger.warn(`Unclaimed-Stop sync failed for session ${jinnSessionId}: ${err instanceof Error ? err.message : err}`);
    }
  });

  // API context
  const apiContext: ApiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    gatewayBootId: bootId,
    runtimePort: config.gateway.port || 7777,
    getConfig: () => currentConfig,
    emit,
    connectors: connectorMap,
    reloadConnectorInstances,
    hookRegistry,
    hookSecret: gatewayInfo.secret,
    interactiveClaudeEngine,
    ptyViewEngines,
    reloadOrg,
    backgroundActivity,
    gatewayAuthToken,
    workflowService,
  };

  // Re-read config.yaml into memory. Used by both the file-watcher (debounced)
  // and by API handlers that write config.yaml and need getConfig() to reflect
  // the change immediately (e.g. onboarding / PUT /api/config).
  // Apply the configurable lateral-send hop cap to the guards singleton. The
  // guard clamps out-of-range values, so config can widen/narrow the bound but
  // never disable the runaway-loop protection.
  const applyLateralHopConfig = (cfg: typeof config): void => {
    sessionCommGuards.setMaxHops(cfg.sessions?.lateralMaxHops ?? LATERAL_MAX_HOPS);
  };
  applyLateralHopConfig(currentConfig);

  const reloadConfig = (): void => {
    try {
      currentConfig = loadConfig();
      apiContext.config = currentConfig;
      sessionManager.setConfig(currentConfig);
      applyLateralHopConfig(currentConfig);
      invalidateModelRegistry(); // rebuild the model/capability registry from the new config
      refreshDynamicModels(currentConfig); // re-discover dynamic models (engine bins/auth may have changed)
      // GRS-017e: re-arm (or disarm) the jinn-attachment smoke gate for the new
      // config, so the operator's one-line `mcp.gateway.enabled: true` flip in
      // config.yaml gets its authed smoke check without a gateway restart.
      // Fire-and-forget is SAFE (GRS-017e-fix, codex finding 2): armJinnAttachGate
      // replaces any stale verdict with a denying probe-in-flight state before
      // its first await, so the reload window fails closed, never stale-open.
      // Employees threaded so a jinnMcp pilot arms the gate too (finding 1).
      void armJinnAttachGate(currentConfig.mcp, { gatewayUrl: process.env.JINN_GATEWAY_URL!, log: logger, employees: employeeRegistry.values() }).catch(() => {});
      // Accepted callback queue intents survive a temporarily unavailable
      // engine. Re-evaluate them whenever configuration/model availability is
      // refreshed so recovery does not require another restart or callback.
      resumePendingWebQueueItems(apiContext);
      logger.info("Config reloaded successfully");
      emit("config:reloaded", {});
    } catch (err) {
      logger.error(`Failed to reload config: ${err instanceof Error ? err.message : err}`);
    }
  };
  apiContext.reloadConfig = reloadConfig;

  // Unstick sessions whose completion event was lost (status:"running" with no
  // live turn). 15s sweep; logs one line per fix.
  const stopStatusReconciler = startStatusReconciler({ engines, emit });

  // Todos ledger truth-keeping (GRS-021a): periodically re-derive work-item
  // status from linked-session evidence, so a session settling mid-process moves
  // its item to in_review/done (trust) without waiting for the next boot.
  const stopWorkItemReconciler = startWorkItemReconciler();

  setTodoStatusChangeListener(() => {
    void workflowService.recover(new Date().toISOString()).catch((error) => {
      logger.warn(`Workflow Todo trigger recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  const cronJobs = loadJobs();
  startScheduler(cronJobs, sessionManager, config, connectorMap);
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

  // Resolve web UI directory — bundled into dist/web/ by postbuild script
  // At runtime __dirname is dist/src/gateway/, so ../../web resolves to dist/web/
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Create HTTP server
  const authRequiredNow = (): boolean => shouldRequireGatewayAuth(currentConfig);

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    const corsAllowed = setCorsHeaders(req, res);

    if (url.startsWith("/api/") && !corsAllowed) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Origin not allowed" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = url.split("?")[0];
    if (authRequiredNow() && authRequiredForRequest(req.method, pathname)) {
      const auth = authenticateGatewayRequest(req, gatewayAuthToken, JINN_HOME);
      if (!auth.ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: auth.reason || "Unauthorized" }));
        return;
      }
    }

    // API routes
    if (url.startsWith("/api/")) {
      handleApiRequest(req, res, apiContext);
      return;
    }

    // Static files for web UI
    if (!serveStatic(req, res, webDir)) {
      if (url === "/" || url === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Web UI not built</h1><p>Run <code>pnpm build</code> from the project root to build the web UI.</p></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    }
  });

  // Node's parser rejects some malformed authorities before the request
  // handler can validate them. Keep that boundary deterministic and never
  // reflect or log raw Host/private input from the parser error.
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    const body = JSON.stringify({ error: "Invalid request authority" });
    socket.end(
      "HTTP/1.1 400 Bad Request\r\n"
      + "Connection: close\r\n"
      + "Content-Type: application/json\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "\r\n"
      + body,
    );
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  // Dedicated WS server for per-session PTY streams (/ws/pty/:sessionId) — kept
  // separate from the global broadcast `wss` so its connections aren't added to
  // the broadcast client set.
  const ptyWss = new WebSocketServer({ noServer: true });

  // Protocol-level ping/pong sweep across both WS servers. Terminates half-open
  // (dead but readyState===OPEN) sockets; terminating a PTY socket fires its
  // close handler -> onDisconnect -> viewerCount decrement, fixing the leak.
  const stopWsHeartbeat = startWsHeartbeat([wss, ptyWss], {
    onSweep: (r) => { if (r.terminated > 0) logger.info(`WS heartbeat reaped ${r.terminated} dead socket(s)`); },
  });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    trackHeartbeat(ws);
    logger.info(`WebSocket client connected (${wsClients.size} total)`);

    // App-level ping echo: the browser client cannot observe protocol-level
    // pongs from JS, so it sends an app `ping` and watches for this `pong` to
    // confirm server liveness during idle.
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.event === "ping" && ws.readyState === 1) {
          ws.send(JSON.stringify({ event: "pong", payload: {} }));
        }
      } catch {
        // ignore non-JSON / unknown frames
      }
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      logger.info(`WebSocket client disconnected (${wsClients.size} total)`);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";
    const pathname = reqUrl.split("?")[0];
    if (rejectUnverifiedIdentifiedUpgradeCaller(req, socket)) return;
    if (authRequiredNow() && authRequiredForRequest("GET", pathname)) {
      const auth = authenticateGatewayRequest(req, gatewayAuthToken, JINN_HOME);
      if (!auth.ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (reqUrl === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    // Dedicated per-session PTY channel for the live xterm CLI view.
    const ptyMatch = reqUrl.split("?")[0].match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      // A browser WebSocket cannot send an Authorization header and has no auth
      // cookie on a loopback gateway, so verifyGatewayAuth alone rejected the
      // operator's own CLI view (empty terminal). Trust a same-origin browser
      // upgrade as operator when gateway auth isn't required — mirroring the
      // same-origin fetch trust for HTTP writes — while auth-required gateways
      // and header-bearing tool callers stay gated exactly as before.
      if (rejectNonOperatorPtyUpgradeCaller(req, socket, {
        operatorAuthenticated:
          verifyGatewayAuth(req.headers, gatewayAuthToken, JINN_HOME)
          || (!authRequiredNow() && isSameOriginBrowserRequest(req, currentConfig)),
      })) return;
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(ptyMatch[1]);
      } catch {
        socket.destroy();
        return;
      }
      const ptySession = getSession(sessionId);
      // Route to the session's OWN engine. Do NOT fall back to claude: codex has no
      // PTY view, and attaching the claude TUI to a codex session showed the wrong
      // engine. No view engine for this engine → refuse the upgrade (FE hides the
      // CLI toggle for codex so this only catches stragglers).
      const ptyEngine = ptySession ? ptyViewEngines[ptySession.engine] : undefined;
      if (!ptyEngine) { socket.destroy(); return; }
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        trackHeartbeat(ws);
        try {
          attachPtyWebSocket(ws, sessionId, ptyEngine);
        } catch (err) {
          logger.warn(`PTY websocket attach failed for ${sessionId}: ${err instanceof Error ? err.message : err}`);
          ws.close();
        }
      });
      return;
    }
    socket.destroy();
  });


  // Sync skill symlinks to .claude/skills/ and .agents/skills/
  syncSkillSymlinks();

  // Initialize STT model symlinks
  try {
    initStt();
  } catch (err) {
    logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Start file watchers
  startWatchers({
    onConfigReload: reloadConfig,
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: reloadOrg,
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  // Start listening (port/host resolved earlier at boot). During `jinn restart`
  // the replacement daemon can race the old process' graceful shutdown; retry
  // EADDRINUSE briefly instead of exiting and leaving the gateway stopped.
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const retryForMs = 15_000;
    const retryDelayMs = 250;
    const listen = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && Date.now() - startedAt < retryForMs) {
          setTimeout(listen, retryDelayMs).unref?.();
          return;
        }
        if (err.code === "EADDRINUSE") {
          const msg = `Port ${port} is already in use.`;
          logger.error(msg);
          console.error(`\nError: ${msg}`);
          console.error(`\nTry: jinn start -p ${port + 1}`);
          console.error(`Or update the port in config.yaml\n`);
          process.exit(1);
        }
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        logger.info(`${gatewayName} gateway listening on http://${host}:${port} (boot ${bootId})`);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    };
    listen();
  });

  // Deferred non-critical startup work (perf: the gateway is now accepting
  // requests). The work-item startup reconcile is best-effort, idempotent, and
  // already covered by the 20s periodic reconciler — so it runs on a setImmediate
  // tick after listen() rather than blocking boot. Everything genuinely
  // order-critical stayed pre-listen by design:
  //   • recoverStaleSessions / getInterruptedSessions — must stamp dead sessions
  //     `interrupted` BEFORE we serve /api/status|/api/sessions, or we'd report
  //     previous-process sessions as still "running".
  setImmediate(() => {
    // Drop any mid-turn streaming blocks stranded by a restart — their turn's final
    // message was never written, so the partials have nothing to consolidate into.
    // This index-backed maintenance is safe to run after readiness and should never
    // delay the first health check on a large historical message table.
    const sweptPartials = clearAllPartialMessages();
    if (sweptPartials > 0) {
      logger.info(`Swept ${sweptPartials} stranded mid-turn partial message(s) from previous run`);
    }
    reconcileWorkItemsOnStartup();
  });
  // FTS migration installs guarded triggers synchronously, but historical row
  // seeding is a yielded, resumable maintenance job. Start it only after the HTTP
  // server accepts requests so first-upgrade history never delays readiness.
  void scheduleFtsBackfill();

  // GRS-017e: arm the jinn-attachment authed smoke gate. Runs right after
  // listen (the probe is one loopback GET against this very server, using the
  // bearer read from the 0600 gateway.json — the child's clean-env channel,
  // GRS-018 §3b) and is AWAITED so no session can resolve MCP before the gate
  // reflects reality. Employees threaded (GRS-017e-fix, finding 1) so a
  // `jinnMcp: true` pilot arms the probe even with the master switch absent.
  // When NO attach path exists (globally off, no pilot — the shipped default),
  // this resets the gate and makes ZERO calls — the default path stays
  // byte-identical to today. A failed probe logs loudly and every attach
  // decision degrades to no-attach until a config/org reload re-checks; the
  // decision side ALSO fails closed on an unarmed gate, so nothing attaches
  // before this line runs.
  await armJinnAttachGate(currentConfig.mcp, { gatewayUrl: process.env.JINN_GATEWAY_URL!, log: logger, employees: employeeRegistry.values() });

  const restartNotices = consumeRestartAcknowledgements();
  if (restartNotices > 0) logger.info(`Persisted gateway restart notice in ${restartNotices} requesting session(s)`);

  // Replay any pending web queue items (e.g. gateway restart mid-run) only after
  // the jinn MCP attach gate is armed. Recovered Codex first turns need the same
  // resolved builtin-jinn server as normal web/connector turns so their rollout
  // is written under the per-session CODEX_HOME that later resumes will use.
  resumePendingWebQueueItems(apiContext);

  // Pending callback receipts must recover before orphan completion guards are
  // inspected. Otherwise a durable-but-unaccepted child nudge can race a
  // contradictory parent recovery message. The combined recovery owns both
  // ordering and top-level isolation so boot cannot reject on one poison row.
  const callbackRecovery = await recoverSessionDeliveryStateOnStartup();
  if (callbackRecovery.pendingRecovered > 0) {
    logger.info(`Re-submitted ${callbackRecovery.pendingRecovered} pending callback delivery claim(s) after restart`);
  }
  if (callbackRecovery.orphanedRecovered > 0) {
    logger.warn(`Surfaced ${callbackRecovery.orphanedRecovered} orphaned delegation completion claim(s) after restart`);
  }

  // Notify connected WebSocket clients about interrupted sessions available for resume
  if (resumable.length > 0) {
    // Small delay to let WebSocket clients connect after server starts
    setTimeout(() => {
      emit("sessions:interrupted", {
        count: resumable.length,
        sessions: resumable.map((s) => ({
          id: s.id,
          engine: s.engine,
          employee: s.employee,
          title: s.title,
          lastActivity: s.lastActivity,
        })),
      });
    }, 1000);
  }

  // Prevent macOS from sleeping while the gateway is running
  let caffeinate: ChildProcess | null = null;
  if (process.platform === "darwin") {
    caffeinate = spawn("caffeinate", ["-s"], {
      stdio: "ignore",
      detached: false,
    });
    caffeinate.unref();
    caffeinate.on("error", (err) => {
      logger.warn(`caffeinate failed to start: ${err.message}`);
      caffeinate = null;
    });
    logger.info("caffeinate started — macOS sleep prevention active");
  }

  // Return cleanup function
  return async () => {
    logger.info("Gateway cleanup starting...");

    // Stop the status reconciler sweep before we start marking sessions
    // interrupted below — a mid-shutdown sweep must not race the teardown.
    stopStatusReconciler();
    stopWorkItemReconciler();
    clearInterval(modelRefreshTimer);
    workflowService.dispose(); workflowDatabase.close();

    // Stop caffeinate
    if (caffeinate && caffeinate.exitCode === null) {
      caffeinate.kill();
      logger.info("caffeinate stopped");
    }

    // Mark all running sessions as "interrupted" before killing engine processes.
    // This preserves their engine_session_id so they can be resumed on next startup.
    interruptRunningSessionsForShutdown();

    // Terminate live engine subprocesses after marking sessions.
    interactiveClaudeEngine.killAll();
    codexEngine.killAll();
    codexInteractiveEngine.killAll();
    antigravityEngine.killAll();
    grokEngine.killAll();
    grokInteractiveEngine.killAll();
    hermesEngine.killAll();
    hermesInteractiveEngine.killAll();
    piEngine.killAll();

    // Dispose the PTY lifecycle manager.
    try {
      claudeLifecycle.dispose();
    } catch (err) {
      logger.warn(`Failed to dispose PTY lifecycle manager: ${err instanceof Error ? err.message : err}`);
    }

    // Dispose the hook registry so its periodic sweep timer is cleared. The
    // timer is .unref()'d so the process exits anyway in production, but
    // in-process shutdown (tests, future hot-reload) requires explicit cleanup.
    try {
      hookRegistry.dispose();
    } catch (err) {
      logger.warn(`Failed to dispose hook registry: ${err instanceof Error ? err.message : err}`);
    }

    // Remove the gateway connection info file.
    try {
      fs.rmSync(GATEWAY_INFO_FILE, { force: true });
    } catch (err) {
      logger.warn(`Failed to remove ${GATEWAY_INFO_FILE}: ${err instanceof Error ? err.message : err}`);
    }

    // Stop cron scheduler
    stopScheduler();
    setTodoStatusChangeListener(null);

    // Stop connectors
    for (const connector of connectors) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Stop watchers
    await stopWatchers();

    // Stop the WS heartbeat sweep before tearing down the WS servers.
    stopWsHeartbeat();

    // Close WebSocket connections. Use terminate() during shutdown so lingering
    // PTY/SSE clients cannot hold server.close() open until the force-exit timer.
    for (const client of wsClients) {
      client.terminate();
    }
    wsClients.clear();
    for (const client of ptyWss.clients) {
      client.terminate();
    }

    // Close WebSocket servers
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => ptyWss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}

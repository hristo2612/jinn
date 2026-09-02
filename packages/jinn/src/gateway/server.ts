import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { JinnConfig, Connector, Engine, SlackConnectorConfig, TelegramConnectorConfig, WhatsAppConnectorConfig } from "../shared/types.js";
import { loadConfig, normalizeClaudeEngineConfig } from "../shared/config.js";
import {
  getModelRegistry,
  invalidateModelRegistry,
  type EngineName, type PtyViewEngineName,
} from "../shared/models.js";
import { configureLogger, logger } from "../shared/logger.js";
import { CONNECTOR_ID_REQUIREMENTS, isValidConnectorId } from "../shared/connector-id.js";
import { scheduleFtsBackfill, recoverStaleSessions, recoverStaleWorkflowAttemptSessions, recoverStaleQueueItems, clearAllPartialMessages, consumeRestartAcknowledgements, getInterruptedSessions, listSessions, getSession, getMessages, getSessionSpend, listAllSessionIds } from "../sessions/registry.js";
import { getPackageVersion } from "../shared/version.js";
import { interruptRunningSessionsForShutdown, resumeRestartInterruptedSessions } from "../sessions/restart-resume.js";
import { initDb } from "../shared/db.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import { recoverSessionDeliveryStateOnStartup } from "../sessions/callbacks.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { enforcePtyIdleCap, PtyLifecycleManager, type PtyLifecycleOpts } from "../engines/pty-lifecycle.js";
import { CodexEngine, startCodexSessionHomeSweeps } from "../engines/codex.js";
import { CodexInteractiveEngine } from "../engines/codex-interactive.js";
import { createAntigravityEnginePair } from "../engines/antigravity-runtime.js";
import { PiEngine } from "../engines/pi.js";
import { GrokEngine } from "../engines/grok.js";
import { GrokInteractiveEngine } from "../engines/grok-interactive.js";
import { HermesAcpEngine } from "../engines/hermes-acp.js";
import { HermesInteractiveEngine } from "../engines/hermes-interactive.js";
import type { PtyViewEngine } from "../engines/pty-view-engine.js";
import { startBackgroundRefreshes } from "./background-refresh.js";
import { HookRegistry } from "./hook-registry.js";
import { writeGatewayInfo, readGatewayInfo, updateGatewayPtyPids, startupGatewayPids, gatewayBaseUrl } from "./gateway-info.js";
import { authenticateGatewayRequest, authRequiredForRequest, ensureGatewayAuthToken, shouldRequireGatewayAuth, validateGatewayExposure, verifyGatewayAuth } from "./auth.js";
import { reconcileWorkItemsOnStartup, startWorkItemReconciler } from "../work-items/reconcile.js";
import { setTodoLabelsChangeListener, setTodoLiveEmitter } from "../work-items/live-events.js";
import { setTodoStatusChangeListener } from "../work-items/transitions.js";
import { firstOperatorCommentAfter } from "../work-items/comments.js";
import { watchTodoReplies } from "./todo-reply-sweep.js";
import { requestApproval, setTodoApprovalDecisionListener } from "../work-items/approvals.js";
import { parseTodoApprovalRef } from "../workflows/todo-approval-ref.js";
import { deciderAuthority } from "./workflow-decider-authority.js";
import { workflowRunOnChange, workflowTodoDispatch, workflowTodoSessions } from "./workflow-todo-runs.js";
import { workflowTodoApprovals, workflowTodoLifecycle } from "./workflow-todo-surface.js";
import { seedTrust, cleanupSessionSettings } from "../shared/claude-settings.js";
import { claudeJsonPath } from "../shared/home.js";
import { GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, JINN_HOME, CLAUDE_SETTINGS_DIR } from "../shared/paths.js";
import { enforceOwnerOnlyDirectory, pathIsOwnerOnly } from "../shared/owner-only.js";
import { isSameOriginBrowserRequest, resumePendingWebQueueItems, sessionsHoldingEngineCapacity, type ApiContext } from "./api.js";
import { startTodoSweeps } from "./todo-sweeps.js";
import { createGatewayRequestHandler } from "./request-handler.js";
import { sessionCommGuards, LATERAL_MAX_HOPS } from "./session-comm-guards.js";
import { rejectNonOperatorPtyUpgradeCaller, rejectUnverifiedIdentifiedUpgradeCaller } from "./upgrade-guards.js";
import { cleanupMcpConfigFile, sweepOrphanMcpConfigFiles } from "../mcp/resolver.js";
import { startStatusReconciler } from "./status-reconciler.js";
import { webTurnSurface } from "./web-session-dispatch.js";
import { startHeartbeatScheduler } from "../heartbeats/scheduler.js";
import { armJinnAttachGate } from "../mcp/attachment.js";
import { syncExternalTurn } from "./external-turns.js";
import { pickEncoding, isCompressibleExt, compressBuffer, compressStream, type Encoding } from "./compress.js";
import { MIME_TYPES } from "./static-mime.js";
import { attachPtyWebSocket } from "./pty-ws.js";
import { openWorkflowDatabase } from "../workflows/repository-migrations.js";
import { importLegacyWorkflowDefinitions } from "../workflows/import-v1.js";
import { WorkflowRepository } from "../workflows/repository.js";
import { WorkflowSessionExecutor } from "../workflows/session-executor.js";
import { WorkflowService } from "../workflows/service.js";
import { createTalkProactiveGatewayEmit } from "./talk-proactive-events.js";

import { startWsHeartbeat, trackHeartbeat } from "./ws-heartbeat.js";
import { ensureFilesDir, cleanupOldUploads } from "./files.js";
import { initStt } from "../stt/stt.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import { gatewayWatchCallbacks } from "./watch-callbacks.js";
import { createPluginEventsChannel, matchPluginEventsPath } from "./plugin-events-ws.js";
import { startPluginRuntime, stopPluginRuntime } from "../plugins/runtime.js";
import { SlackConnector } from "../connectors/slack/index.js";
import { DiscordConnector, type DiscordConnectorConfig } from "../connectors/discord/index.js";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { TelegramConnector } from "../connectors/telegram/index.js";
import { loadJobs } from "../cron/jobs.js";
import { startScheduler, stopScheduler } from "../cron/scheduler.js";
import { orgRegistry, refreshOrg } from "./org-registry.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Records that boot already tightened JINN_HOME once, so an operator who
 *  deliberately re-widens it afterwards is warned rather than silently overridden. */
const OWNER_ONLY_HEAL_MARKER = path.join(JINN_HOME, ".owner-only-healed");

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

type RuntimeActivityInfo = {
  activeStreams: number;
  activeAgents?: number;
  activeMonitors?: number;
  lastActivityAt: number;
};
type RuntimeActivitySource = {
  onRuntimeActivity?: (cb: (sessionId: string, info: RuntimeActivityInfo | null) => void) => void;
};

type ServeStaticOptions = {
  compress?: (encoding: Encoding, input: Buffer) => Buffer;
  compressionCache?: {
    entries: Map<string, Buffer>;
    totalBytes: number;
  };
  compressionCacheMaxEntries?: number;
  compressionCacheMaxBytes?: number;
};

const DEFAULT_COMPRESSED_ASSET_CACHE_MAX_ENTRIES = 256;
const DEFAULT_COMPRESSED_ASSET_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const compressedAssetCache = {
  entries: new Map<string, Buffer>(),
  totalBytes: 0,
};

export function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
  options: ServeStaticOptions = {},
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
    if (isHashedAsset) {
      const key = `${resolved}\0${fs.statSync(resolved).mtimeMs}\0${enc}`;
      const cache = options.compressionCache ?? compressedAssetCache;
      let compressed = cache.entries.get(key);
      if (!compressed) {
        compressed = (options.compress ?? compressBuffer)(enc, fs.readFileSync(resolved));
        const maxEntries = options.compressionCacheMaxEntries ?? DEFAULT_COMPRESSED_ASSET_CACHE_MAX_ENTRIES;
        const maxBytes = options.compressionCacheMaxBytes ?? DEFAULT_COMPRESSED_ASSET_CACHE_MAX_BYTES;
        if (maxEntries > 0 && compressed.byteLength <= maxBytes) {
          while (
            cache.entries.size >= maxEntries
            || cache.totalBytes + compressed.byteLength > maxBytes
          ) {
            const oldestKey = cache.entries.keys().next().value;
            if (oldestKey === undefined) break;
            const oldest = cache.entries.get(oldestKey);
            cache.entries.delete(oldestKey);
            cache.totalBytes -= oldest?.byteLength ?? 0;
          }
          cache.entries.set(key, compressed);
          cache.totalBytes += compressed.byteLength;
        }
      }
      res.end(compressed);
      return true;
    }
    fs.createReadStream(resolved).pipe(compressStream(enc)).pipe(res);
    return true;
  }
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
  return true;
}

/** A connector declaration with its id resolved — the one runtime shape. */
export interface NormalizedConnector {
  id: string;
  type: string;
  employee?: string;
  /** Config handed to the connector constructor (always carries `id`). */
  config: Record<string, unknown>;
}

/** When a legacy top-level connector counts as configured. */
const LEGACY_ENABLED: Record<string, (config: any) => boolean> = {
  slack: (config) => Boolean(config.appToken && config.botToken),
  discord: (config) => Boolean(config.botToken),
  telegram: (config) => Boolean(config.botToken),
  whatsapp: () => true,
};

/**
 * Flatten both config forms into one list: the legacy top-level connectors
 * (`connectors.slack`, …) become instances whose id defaults to their type,
 * followed by the explicitly named `connectors.instances[]`.
 */
export function connectorInstancesFromConfig(config: JinnConfig): NormalizedConnector[] {
  const declared = (config.connectors ?? {}) as Record<string, any>;
  const instances: NormalizedConnector[] = [];
  const seen = new Set<string>();

  const add = (id: unknown, type: string, raw: Record<string, unknown>): void => {
    if (!isValidConnectorId(id)) {
      throw new Error(`Invalid connector instance id ${JSON.stringify(id)}: ${CONNECTOR_ID_REQUIREMENTS}`);
    }
    if (seen.has(id)) {
      logger.warn(`Duplicate connector instance id "${id}", skipping`);
      return;
    }
    seen.add(id);
    const connectorConfig: Record<string, unknown> = { ...raw, id };
    // Speech-to-text is global: this block is only the fallback if stt.json is unusable.
    if (type === "telegram") connectorConfig.stt = config.stt;
    instances.push({ id, type, employee: raw.employee as string | undefined, config: connectorConfig });
  };

  for (const [type, enabled] of Object.entries(LEGACY_ENABLED)) {
    const raw = declared[type];
    if (raw && enabled(raw)) add(type, type, raw);
  }

  for (const instance of declared.instances ?? []) {
    const { id, type, ...rest } = instance;
    if (id === undefined || id === null || !type) {
      logger.warn(`Skipping connector instance without id or type`);
      continue;
    }
    add(id, type, rest);
  }

  return instances;
}

/** The only place a connector is constructed. Throws on an unknown type. */
export function createConnector(instance: NormalizedConnector): Connector {
  const config = instance.config;
  switch (instance.type) {
    case "slack":
      return new SlackConnector(config as unknown as SlackConnectorConfig);
    case "discord":
      return new DiscordConnector(config as unknown as DiscordConnectorConfig);
    case "telegram":
      return new TelegramConnector(config as unknown as TelegramConnectorConfig);
    case "whatsapp":
      return new WhatsAppConnector(config as unknown as WhatsAppConnectorConfig);
    default:
      throw new Error(`Unknown connector type "${instance.type}" for instance "${instance.id}"`);
  }
}

interface ReloadConnectorRegistryOptions {
  connectorMap: Map<string, Connector>;
  loadInstances: () => NormalizedConnector[];
  initConnector: (instance: NormalizedConnector) => Promise<void>;
  describeConnector: (instance: NormalizedConnector) => string;
}

/** Reload a live connector registry from freshly normalized declarations. */
export async function reloadConnectorRegistry({
  connectorMap,
  loadInstances,
  initConnector,
  describeConnector,
}: ReloadConnectorRegistryOptions): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
  const instances = loadInstances();
  const started: string[] = [];
  const stopped: string[] = [];
  const errors: string[] = [];

  for (const [id, connector] of [...connectorMap.entries()]) {
    try {
      await connector.stop();
      connectorMap.delete(id);
      stopped.push(id);
      logger.info(`Stopped connector "${id}" for reload`);
    } catch (err) {
      errors.push(`Failed to stop ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const instance of instances) {
    // A connector that refused to stop is still live — leave it alone.
    if (connectorMap.has(instance.id)) continue;
    try {
      await initConnector(instance);
      started.push(instance.id);
      logger.info(`Started ${describeConnector(instance)}`);
    } catch (err) {
      errors.push(`Failed to start "${instance.id}": ${err instanceof Error ? err.message : err}`);
      logger.error(`Failed to start ${describeConnector(instance)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { started, stopped, errors };
}

/** Boot-time startup. Returns without awaiting any `start()`, so a hung handshake cannot delay the HTTP listen. */
export function startConnectorInstances(instances: NormalizedConnector[], initConnector: (instance: NormalizedConnector) => Promise<void>, describeConnector: (instance: NormalizedConnector) => string): void {
  for (const instance of instances) {
    try {
      initConnector(instance).catch((err) => logger.error(`Failed to start ${describeConnector(instance)}: ${err instanceof Error ? err.message : err}`));
      logger.info(`Starting ${describeConnector(instance)}`);
    } catch (err) {
      logger.error(`Failed to initialize ${describeConnector(instance)}: ${err instanceof Error ? err.message : err}`);
    }
  }
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
  // Retention: sweep per-session Codex CODEX_HOME overlays on boot, then daily. An
  // overlay goes once its config.toml (rewritten every turn) is 14 days stale, or —
  // when that stamp is missing — once no session row claims it. The keep-list is
  // EVERY session row: archived and workflow-phase sessions resume too, and
  // listSessions() hides both.
  startCodexSessionHomeSweeps({ listSessionIds: listAllSessionIds });
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
  const recoveredWorkflowAttempts = recoverStaleWorkflowAttemptSessions();
  if (recoveredWorkflowAttempts > 0) {
    logger.info(`Recovered ${recoveredWorkflowAttempts} stale workflow attempt session(s) after gateway restart`);
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
  //
  // Deliberately BEFORE ensureGatewayAuthToken below: on a pre-existing 0755 home
  // the other order materializes the token while the directory is still
  // group-readable, then tightens it.
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

  // Reap any orphaned PTYs from a prior crashed run before writing the fresh gateway.json.
  const oldInfo = readGatewayInfo(GATEWAY_INFO_FILE);
  if (oldInfo) {
    for (const pid of startupGatewayPids(oldInfo)) {
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
    seedTrust(claudeJsonPath(), JINN_HOME);
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
  const interactiveClaudeEngine = new InteractiveClaudeEngine(claudeLifecycle, hookRegistry, {
    autoApproveSafetyPrompts: claudeCfg.autoApproveSafetyPrompts,
  });

  // Codex has two modes: headless `codex exec --json` for chat/default work
  // turns, and real `codex` TUI PTYs for the dashboard CLI view.
  codexLifecycle = createPtyLifecycle({
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const codexInteractiveEngine = new CodexInteractiveEngine(codexLifecycle);

  // Antigravity mirrors Codex/Grok: supported stream-JSON print mode owns queued
  // work turns, while a separate PTY instance backs the dashboard terminal.
  antigravityLifecycle = createPtyLifecycle({
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const { work: antigravityEngine, pty: antigravityInteractiveEngine } = createAntigravityEnginePair(antigravityLifecycle);
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
  logger.info("Engines initialized: claude (interactive PTY), codex (headless + interactive PTY), antigravity (headless + interactive PTY), grok (headless + interactive PTY), hermes (headless + interactive PTY), pi");

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
  const ptyViewEngines: Record<PtyViewEngineName, Engine & PtyViewEngine> = {
    claude: interactiveClaudeEngine,
    codex: codexInteractiveEngine,
    antigravity: antigravityInteractiveEngine,
    grok: grokInteractiveEngine,
    hermes: hermesInteractiveEngine,
  };

  // Build employee registry
  let employeeRegistry = orgRegistry(config);
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);
  const sessionManager = new SessionManager(config, engines, bootId, (id) => employeeRegistry.get(id));

  // Start connectors — one normalized list covers both config forms.
  const connectorMap = new Map<string, Connector>();

  /**
   * Create one connector, wire its message routing, and register it. Registration
   * happens before start so shutdown can clean up even while a handshake is in
   * flight. Returns the start() promise so each caller picks its own wait policy.
   */
  const initConnector = (instance: NormalizedConnector): Promise<void> => {
    const connector = createConnector(instance);
    connector.onMessage((msg) => {
      const routeOpts: RouteOptions = {};
      if (instance.employee) {
        const emp = employeeRegistry.get(instance.employee);
        if (emp) routeOpts.employee = emp;
      }
      sessionManager.route(msg, connector, routeOpts).catch((err) => {
        logger.error(`${instance.id} route error: ${err instanceof Error ? err.message : err}`);
      });
    });
    connectorMap.set(instance.id, connector);
    return connector.start();
  };

  const describeConnector = (instance: NormalizedConnector): string =>
    `connector "${instance.id}" (type: ${instance.type}, employee: ${instance.employee || "default"})`;

  // Session context reads connector ids off this map, so publish it before the
  // first connector can deliver a message.
  sessionManager.setConnectorProvider(() => connectorMap);

  startConnectorInstances(connectorInstancesFromConfig(config), initConnector, describeConnector);

  /** Stop every running connector and restart from fresh config (POST /api/connectors/reload). */
  async function reloadConnectorInstances(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    return reloadConnectorRegistry({
      connectorMap,
      loadInstances: () => connectorInstancesFromConfig(loadConfig()),
      initConnector,
      describeConnector,
    });
  }

  // Mutable config reference for hot-reload
  let currentConfig = config;

  const startTime = Date.now();
  const wsClients = new Set<import("ws").WebSocket>();
  const broadcast: GatewayEmit = (event, payload): void => {
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
  const emit = createTalkProactiveGatewayEmit(initDb(), broadcast);
  sessionManager.setGatewayEmitter(emit);
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
    // A parked gate on a Todo-bound run is mirrored onto that Todo; whichever
    // door decides it settles both. Employee-routed gates wake that employee.
    todoApprovals: workflowTodoApprovals(({ todoId, request, ref, options, approver }) => {
      requestApproval(todoId, { request, ref, ...(options ? { options } : {}), ...(approver ? { target: approver } : {}), actor: "workflow" });
    }),
    todoSessions: workflowTodoSessions(), todoDispatch: workflowTodoDispatch(), engineFallback: { chainFor: (engine: string) => currentConfig.engines[engine as EngineName]?.fallback ?? [] },
    // A parked Wait node listens for the operator's reply on the bound Todo.
    todoComments: { firstOperatorCommentAfter },
    sessionSpend: getSessionSpend, activeEngineSessions: () => sessionsHoldingEngineCapacity(listSessions(), apiContext).length,
    // A Todo-bound run reflects its own lifecycle onto that Todo — no phase
    // prompt has to say so, and a dead run leaves its reason behind.
    todoLifecycle: workflowTodoLifecycle,
    readTranscript: (id) => getMessages(id).map(({ id: messageId, role, content, timestamp }) => ({ id: messageId, role, content, timestamp })),
    onChange: workflowRunOnChange({ workflowRepository, emit }),
    onDefinitionChange: ({ workflowId, revision }) => emit("company:changed", { entity: "workflow-definition", id: workflowId, revision }) });

  const backgroundRefreshes = startBackgroundRefreshes(() => currentConfig, emit);

  // Synchronously re-scan org/ into the in-memory registry. Shared by the API
  // employee-update handler (immediate refresh, no watcher lag) and the chokidar
  // onOrgChange watcher.
  const reloadOrg = () => {
    employeeRegistry = refreshOrg(currentConfig).registry;
    logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
    // GRS-017e-fix (finding 1): an employee YAML gaining/losing `jinnMcp: true`
    // changes whether the jinn-attachment smoke gate must be armed — re-arm on
    // every org reload. Fail-closed while the probe is in flight (finding 2),
    // so fire-and-forget cannot widen attachment through a stale verdict.
    void armJinnAttachGate(currentConfig.mcp, { gatewayUrl: process.env.JINN_GATEWAY_URL!, log: logger, employees: employeeRegistry.values() }).catch(() => {}); // footgun: ok pre-existing read, in scope only because this file changed for an unrelated split — threading env through startGateway is its own change
    // Keep warm PTYs alive on org reload. Native CLI schedulers can sleep inside
    // an otherwise idle PTY for days; recycling "idle" PTYs here would silently
    // delete those loops. New sessions and cold respawns pick up the fresh org.
    emit("org:changed", {});
  };

  // Runtime activity after the foreground turn has settled (in-memory only).
  // Native CLI schedulers such as /loop wake inside the PTY without entering
  // Jinn's queue; engines can expose onRuntimeActivity so the UI stops showing
  // those sessions as transport-idle while the native work is awake.
  const backgroundActivity = new Map<string, RuntimeActivityInfo>();
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
        ? {
            activeStreams: info.activeStreams,
            ...(info.activeAgents !== undefined ? { activeAgents: info.activeAgents } : {}),
            ...(info.activeMonitors !== undefined ? { activeMonitors: info.activeMonitors } : {}),
            lastActivityAt: new Date(info.lastActivityAt).toISOString(),
          }
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
  await workflowService.recover(new Date().toISOString()); // never above apiContext: a recovered fan-out reads its ceiling through it

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
      backgroundRefreshes.refreshModels(); // engine bins/auth may have changed
      // GRS-017e: re-arm (or disarm) the jinn-attachment smoke gate for the new
      // config, so the operator's one-line `mcp.gateway.enabled: true` flip in
      // config.yaml gets its authed smoke check without a gateway restart.
      // Fire-and-forget is SAFE (GRS-017e-fix, codex finding 2): armJinnAttachGate
      // replaces any stale verdict with a denying probe-in-flight state before
      // its first await, so the reload window fails closed, never stale-open.
      // Employees threaded so a jinnMcp pilot arms the gate too (finding 1).
      void armJinnAttachGate(currentConfig.mcp, { gatewayUrl: process.env.JINN_GATEWAY_URL!, log: logger, employees: employeeRegistry.values() }).catch(() => {}); // footgun: ok pre-existing read, in scope only because this file changed for an unrelated split — threading env through startGateway is its own change
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

  // Unstick sessions whose completion event was lost (status:"running", no live turn): a 15s sweep, settling through the one completion path.
  const stopStatusReconciler = startStatusReconciler({ engines, surfaceFor: (id) => webTurnSurface(id, apiContext) });
  const stopHeartbeatScheduler = startHeartbeatScheduler();

  // Todos ledger truth-keeping: derive status from linked-session evidence so a mid-process settle lands without a boot (GRS-021a), and resume a Todo parked on a provider window that has since reopened (PLA-153).
  const stopWorkItemReconciler = startWorkItemReconciler();
  const stopTodoSweeps = startTodoSweeps(workflowRepository);

  // A todo-status trigger's label filter reads the Todo when its event DRAINS rather than when it moved, so a label landing after the move re-opens the drain too.
  const drainTodoTriggers = (): void => { void workflowService.recover(new Date().toISOString())
    .catch((error) => logger.warn(`Workflow Todo trigger recovery failed: ${error instanceof Error ? error.message : String(error)}`)); };
  setTodoStatusChangeListener(drainTodoTriggers);
  setTodoLabelsChangeListener(drainTodoTriggers);

  const stopReplyWatch = watchTodoReplies(() => workflowService.recover(new Date().toISOString()));

  // The other half of the Todo-first approval loop: a gate decided on the Todo resolves the workflow node that mirrored it, carrying the picked option and the authority the run's own reserved gates check.
  setTodoApprovalDecisionListener(({ approval, decision, decidedBy }) => {
    const origin = parseTodoApprovalRef(approval.ref);
    if (!origin) return;
    const run = workflowRepository.getRun(origin.workflowId, origin.runId);
    if (!run) return;
    void workflowService.decideApproval({ ...origin, decision, decidedBy, expectedRevision: run.revision,
      decidedByAuthority: deciderAuthority(decidedBy), ...(approval.choice ? { choice: approval.choice } : {}),
      ...(approval.note ? { reason: approval.note } : {}) }).catch((error) => {
      logger.warn(`Workflow approval mirror-back failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  const cronJobs = loadJobs();
  startScheduler(cronJobs, { sessionManager, getConfig: () => currentConfig, connectors: connectorMap, emit });
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

  // Resolve web UI directory — bundled into dist/web/ by postbuild script
  // At runtime __dirname is dist/src/gateway/, so ../../web resolves to dist/web/
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Create HTTP server
  const authRequiredNow = (): boolean => shouldRequireGatewayAuth(currentConfig);

  const server = http.createServer(createGatewayRequestHandler({
    authRequired: authRequiredNow,
    gatewayAuthToken,
    home: JINN_HOME,
    apiContext,
    webDir,
  }));

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
  const pluginEvents = createPluginEventsChannel(() => currentConfig);

  // Protocol-level ping/pong sweep across both WS servers. Terminates half-open
  // (dead but readyState===OPEN) sockets; terminating a PTY socket fires its
  // close handler -> onDisconnect -> viewerCount decrement, fixing the leak.
  const stopWsHeartbeat = startWsHeartbeat([wss, ptyWss, pluginEvents.wss], {
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
    // A plugin's own event stream. It reaches here having passed the same gate
    // `/ws` did above; plugin-events-ws.ts adds the enable gate and no auth of
    // its own.
    const pluginEventsId = matchPluginEventsPath(pathname);
    if (pluginEventsId) {
      pluginEvents.handleUpgrade(req, socket, head, pluginEventsId);
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
      const ptyEngine = ptySession ? ptyViewEngines[ptySession.engine as PtyViewEngineName] : undefined;
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

  // Initialize host-shared STT models and settings
  try {
    initStt(currentConfig.stt);
  } catch (err) {
    logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Start file watchers
  startWatchers(gatewayWatchCallbacks({ reloadConfig, getConfig: () => currentConfig, reloadOrg, emit }));

  // Start every enabled plugin: the typed host verbs get their gateway, then the
  // watchers start. Not awaited — boot does not wait on third-party code.
  void startPluginRuntime(apiContext, () => currentConfig);

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

  // Every session the previous process was mid-turn on is still sitting on a
  // half-finished turn. Nudge each one to carry on. Last of the recovery steps
  // on purpose: after the queue replay so a session already re-dispatched there
  // is not resumed twice, and after the delivery sweep above so the fresh claims
  // keep the stagger they were planned with instead of being flushed at once.
  resumeRestartInterruptedSessions(getPackageVersion());

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

    // Stop the periodic sweeps before we start marking sessions interrupted below — a mid-shutdown sweep must not race the teardown.
    stopStatusReconciler(); stopWorkItemReconciler(); stopTodoSweeps(); stopHeartbeatScheduler();
    backgroundRefreshes.stop();
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
    antigravityInteractiveEngine.killAll();
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
    setTodoStatusChangeListener(null); setTodoLabelsChangeListener(null);
    stopReplyWatch();
    setTodoApprovalDecisionListener(null);

    // Stop connectors
    for (const connector of connectorMap.values()) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Stop watchers
    await stopWatchers();

    // Plugin watchers each carry their own stop deadline, so one that refuses to
    // stop is abandoned rather than holding shutdown open.
    await stopPluginRuntime();

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
    for (const client of pluginEvents.wss.clients) {
      client.terminate();
    }

    // Close WebSocket servers
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => ptyWss.close(() => resolve()));
    await new Promise<void>((resolve) => pluginEvents.wss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}

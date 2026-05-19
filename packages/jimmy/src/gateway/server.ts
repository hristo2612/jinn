import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { JinnConfig, Connector, Employee } from "../shared/types.js";
import { loadConfig, normalizeClaudeEngineConfig } from "../shared/config.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb, recoverStaleSessions, recoverStaleQueueItems, getInterruptedSessions, listSessions, updateSession } from "../sessions/registry.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import { ClaudeEngine } from "../engines/claude.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { PtyLifecycleManager } from "../engines/pty-lifecycle.js";
import { CodexEngine } from "../engines/codex.js";
import { GeminiEngine } from "../engines/gemini.js";
import { HookRegistry } from "./hook-registry.js";
import { writeGatewayInfo, readGatewayInfo, updateGatewayPtyPids } from "./gateway-info.js";
import { seedTrust, cleanupSessionSettings } from "../shared/claude-settings.js";
import { GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, JINN_HOME, CLAUDE_SETTINGS_DIR } from "../shared/paths.js";
import { handleApiRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { pickEncoding, isCompressibleExt, compressStream } from "./compress.js";
import { attachPtyWebSocket } from "./pty-ws.js";
import { ensureFilesDir } from "./files.js";
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

function serveStatic(
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
  const recovered = recoverStaleSessions();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale session(s) — marked as "interrupted" for resume`);
  }

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

  // Normalize claude engine config (idempotent — loadConfig already normalized it)
  const claudeCfg = normalizeClaudeEngineConfig(config.engines.claude);

  // Reap any orphaned PTYs from a prior crashed run before writing the fresh gateway.json.
  const oldInfo = readGatewayInfo(GATEWAY_INFO_FILE);
  if (oldInfo) {
    const pidsToReap = [
      ...(oldInfo.ptyPids ?? []),
      // Also try to reap the prior gateway process itself (in case it is still lingering).
      oldInfo.pid,
    ];
    for (const pid of pidsToReap) {
      if (pid === process.pid) continue; // paranoia: never signal ourselves
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
  const gatewayInfo = writeGatewayInfo(GATEWAY_INFO_FILE, { port, pid: process.pid });

  // Hook registry — shared by the interactive engine and the internal hook route.
  const hookRegistry = new HookRegistry();

  // Claude engines — split by use case:
  //   • ClaudeEngine (headless `claude -p`): used by chat, connectors, cron — short-lived, one spawn per turn.
  //   • InteractiveClaudeEngine (PTY): used only by /ws/pty/:sessionId for the live xterm CLI view.
  const claudeEngine = new ClaudeEngine();

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

  const claudeLifecycle: PtyLifecycleManager = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: (_id) => {
      try { updateGatewayPtyPids(GATEWAY_INFO_FILE, claudeLifecycle.livePids()); } catch { /* best effort */ }
    },
    onCleanup: (id) => {
      cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
      hookRegistry.unregister(id);
      try { updateGatewayPtyPids(GATEWAY_INFO_FILE, claudeLifecycle.livePids()); } catch { /* best effort */ }
    },
  });
  const interactiveClaudeEngine = new InteractiveClaudeEngine(claudeLifecycle, hookRegistry);
  logger.info("Claude engines initialized: headless (chat/cron/connectors) + interactive PTY (CLI view)");

  const codexEngine = new CodexEngine();
  const geminiEngine = new GeminiEngine();
  const engines = new Map<string, ClaudeEngine | InstanceType<typeof CodexEngine> | InstanceType<typeof GeminiEngine>>();
  engines.set("claude", claudeEngine);
  engines.set("codex", codexEngine);
  engines.set("gemini", geminiEngine);

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

  // Session manager
  const sessionManager = new SessionManager(config, engines, connectorNames);

  // Build employee registry
  let employeeRegistry = scanOrg();
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);

  // Start connectors
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  /** IDs of connectors created from config.connectors.instances[] (vs legacy top-level connectors) */
  const instanceConnectorIds = new Set<string>();

  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    try {
      const slack = new SlackConnector({
        appToken: config.connectors.slack.appToken,
        botToken: config.connectors.slack.botToken,
        allowFrom: config.connectors.slack.allowFrom,
        ignoreOldMessagesOnBoot: config.connectors.slack.ignoreOldMessagesOnBoot,
      });
      slack.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        if (config.connectors.slack?.employee) {
          const emp = employeeRegistry.get(config.connectors.slack.employee);
          if (emp) routeOpts.employee = emp;
        }
        sessionManager.route(msg, slack, routeOpts).catch((err) => {
          logger.error(`Slack route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      // Push to registry before starting so shutdown can clean up even if start is in-flight.
      connectors.push(slack);
      connectorMap.set("slack", slack);
      // Fire-and-forget: don't block boot — a slow handshake must not delay HTTP listen.
      slack.start().catch((err) => {
        logger.error(`Failed to start Slack connector: ${err instanceof Error ? err.message : err}`);
      });
    } catch (err) {
      logger.error(`Failed to initialize Slack connector: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (config.connectors?.discord?.proxyVia) {
    // Remote mode: proxy all Discord operations through the primary instance
    try {
      const discord = new RemoteDiscordConnector({
        proxyVia: config.connectors.discord.proxyVia,
        channelId: config.connectors.discord.channelId,
      });
      discord.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        if (config.connectors.discord?.employee) {
          const emp = employeeRegistry.get(config.connectors.discord.employee);
          if (emp) routeOpts.employee = emp;
        }
        sessionManager.route(msg, discord, routeOpts).catch((err) => {
          logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      // Push to registry before starting so shutdown can clean up even if start is in-flight.
      connectors.push(discord);
      connectorMap.set("discord", discord);
      // Fire-and-forget: don't block boot — a slow handshake must not delay HTTP listen.
      discord.start().catch((err) => {
        logger.error(`Failed to start remote Discord connector: ${err instanceof Error ? err.message : err}`);
      });
      logger.info("Discord remote connector starting");
    } catch (err) {
      logger.error(`Failed to initialize remote Discord connector: ${err instanceof Error ? err.message : err}`);
    }
  } else if (config.connectors?.discord?.botToken) {
    // Primary mode: direct Discord bot connection
    try {
      const discord = new DiscordConnector(config.connectors.discord as DiscordConnectorConfig);
      discord.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        if (config.connectors.discord?.employee) {
          const emp = employeeRegistry.get(config.connectors.discord.employee);
          if (emp) routeOpts.employee = emp;
        }
        sessionManager.route(msg, discord, routeOpts).catch((err) => {
          logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      // Push to registry before starting so shutdown can clean up even if start is in-flight.
      connectors.push(discord);
      connectorMap.set("discord", discord);
      // Fire-and-forget: don't block boot — a slow handshake must not delay HTTP listen.
      discord.start().catch((err) => {
        logger.error(`Failed to start Discord connector: ${err instanceof Error ? err.message : err}`);
      });
      logger.info("Discord connector starting");
    } catch (err) {
      logger.error(`Failed to initialize Discord connector: ${err instanceof Error ? err.message : err}`);
    }
  } else if (config.connectors?.discord?.proxyVia) {
    try {
      const discord = new RemoteDiscordConnector({ proxyVia: config.connectors.discord.proxyVia });
      discord.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        if (config.connectors.discord?.employee) {
          const emp = employeeRegistry.get(config.connectors.discord.employee);
          if (emp) routeOpts.employee = emp;
        }
        sessionManager.route(msg, discord, routeOpts).catch((err) => {
          logger.error(`Discord (remote) route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      // Push to registry before starting so shutdown can clean up even if start is in-flight.
      connectors.push(discord);
      connectorMap.set("discord", discord);
      // Fire-and-forget: don't block boot — a slow handshake must not delay HTTP listen.
      discord.start().catch((err) => {
        logger.error(`Failed to start remote Discord connector: ${err instanceof Error ? err.message : err}`);
      });
      logger.info(`Discord connector starting in remote mode (via ${config.connectors.discord.proxyVia})`);
    } catch (err) {
      logger.error(`Failed to initialize remote Discord connector: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (config.connectors?.telegram?.botToken) {
    try {
      const telegram = new TelegramConnector({
        botToken: config.connectors.telegram.botToken,
        allowFrom: config.connectors.telegram.allowFrom,
        ignoreOldMessagesOnBoot: config.connectors.telegram.ignoreOldMessagesOnBoot,
      });
      telegram.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        if (config.connectors.telegram?.employee) {
          const emp = employeeRegistry.get(config.connectors.telegram.employee);
          if (emp) routeOpts.employee = emp;
        }
        sessionManager.route(msg, telegram, routeOpts).catch((err) => {
          logger.error(`Telegram route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      // Push to registry before starting so shutdown can clean up even if start is in-flight.
      connectors.push(telegram);
      connectorMap.set("telegram", telegram);
      // Fire-and-forget: don't block boot — a slow handshake must not delay HTTP listen.
      telegram.start().catch((err) => {
        logger.error(`Failed to start Telegram connector: ${err instanceof Error ? err.message : err}`);
      });
    } catch (err) {
      logger.error(`Failed to initialize Telegram connector: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (config.connectors?.whatsapp) {
    try {
      const whatsapp = new WhatsAppConnector(config.connectors.whatsapp ?? {});
      whatsapp.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        if (config.connectors.whatsapp?.employee) {
          const emp = employeeRegistry.get(config.connectors.whatsapp.employee);
          if (emp) routeOpts.employee = emp;
        }
        sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
          logger.error(`WhatsApp route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      // Push to registry before starting so shutdown can clean up even if start is in-flight.
      connectors.push(whatsapp);
      connectorMap.set("whatsapp", whatsapp);
      // Fire-and-forget: don't block boot — a slow handshake must not delay HTTP listen.
      whatsapp.start().catch((err) => {
        logger.error(`Failed to start WhatsApp connector: ${err instanceof Error ? err.message : err}`);
      });
      logger.info("WhatsApp connector starting (scan QR code if first run)");
    } catch (err) {
      logger.error(`Failed to initialize WhatsApp connector: ${err instanceof Error ? err.message : err}`);
    }
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
            const telegramConfig = { ...typeConfig, id } as any;
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
              const telegramConfig = { ...typeConfig, id } as any;
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

  // Start cron scheduler
  const cronJobs = loadJobs();
  startScheduler(cronJobs, sessionManager, config, connectorMap);
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

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

  // API context
  const apiContext: ApiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    getConfig: () => currentConfig,
    emit,
    connectors: connectorMap,
    reloadConnectorInstances,
    hookRegistry,
    hookSecret: gatewayInfo.secret,
    interactiveClaudeEngine,
  };

  // Replay any pending web queue items (e.g. gateway restart mid-run)
  resumePendingWebQueueItems(apiContext);

  // Resolve web UI directory — bundled into dist/web/ by postbuild script
  // At runtime __dirname is dist/src/gateway/, so ../../web resolves to dist/web/
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    // CORS headers for development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
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

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  // Dedicated WS server for per-session PTY streams (/ws/pty/:sessionId) — kept
  // separate from the global broadcast `wss` so its connections aren't added to
  // the broadcast client set.
  const ptyWss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    logger.info(`WebSocket client connected (${wsClients.size} total)`);

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
    if (reqUrl === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    // Dedicated per-session PTY channel for the live xterm CLI view.
    const ptyMatch = reqUrl.split("?")[0].match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      const sessionId = decodeURIComponent(ptyMatch[1]);
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        attachPtyWebSocket(ws, sessionId, interactiveClaudeEngine);
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
    onConfigReload: () => {
      try {
        currentConfig = loadConfig();
        apiContext.config = currentConfig;
        logger.info("Config reloaded successfully");
        emit("config:reloaded", {});
      } catch (err) {
        logger.error(
          `Failed to reload config: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: () => {
      employeeRegistry = scanOrg();
      logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
      // Org/persona changed — drop warm PTYs so the next turn respawns with fresh --append-system-prompt.
      interactiveClaudeEngine.killAll();
      emit("org:changed", {});
    },
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  // Start listening (port/host resolved earlier at boot)
  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const msg = `Port ${port} is already in use.`;
        logger.error(msg);
        console.error(`\nError: ${msg}`);
        console.error(`\nTry: jinn start -p ${port + 1}`);
        console.error(`Or update the port in config.yaml\n`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, host, () => {
      logger.info(`${gatewayName} gateway listening on http://${host}:${port} (boot ${bootId})`);
      resolve();
    });
  });

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

    // Stop caffeinate
    if (caffeinate && caffeinate.exitCode === null) {
      caffeinate.kill();
      logger.info("caffeinate stopped");
    }

    // Mark all running sessions as "interrupted" before killing engine processes.
    // This preserves their engine_session_id so they can be resumed on next startup.
    const runningSessions = listSessions({ status: "running" });
    for (const session of runningSessions) {
      updateSession(session.id, {
        status: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted: gateway shutting down gracefully",
      });
      logger.info(`Marked session ${session.id} as interrupted for resume`);
    }

    // Terminate live engine subprocesses after marking sessions.
    claudeEngine.killAll();
    interactiveClaudeEngine.killAll();
    codexEngine.killAll();

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

    // Close WebSocket connections
    for (const client of wsClients) {
      client.close(1001, "Server shutting down");
    }
    wsClients.clear();

    // Close WebSocket servers
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => ptyWss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}

import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { JinnConfig, Connector, Employee } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb, recoverStaleSessions, recoverStaleQueueItems, getInterruptedSessions, listSessions, updateSession } from "../sessions/registry.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import { ClaudeEngine } from "../engines/claude.js";
import { CodexEngine } from "../engines/codex.js";
import { handleApiRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { ensureFilesDir } from "./files.js";
import { initStt } from "../stt/stt.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import { SlackConnector } from "../connectors/slack/index.js";
import { DiscordConnector, type DiscordConnectorConfig } from "../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../connectors/discord/remote.js";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
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

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    // Next.js static export produces /chat.html, /sessions.html, etc.
    // Try appending .html before falling back to index.html
    const htmlPath = resolved.endsWith("/")
      ? path.join(resolved, "index.html")
      : resolved + ".html";
    if (fs.existsSync(htmlPath) && !fs.statSync(htmlPath).isDirectory()) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }

    // SPA fallback: serve index.html for non-API, non-WS routes
    const indexPath = path.join(webDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
    return false;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
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

  // Set up engines
  const claudeEngine = new ClaudeEngine();
  const codexEngine = new CodexEngine();
  const engines = new Map<string, InstanceType<typeof ClaudeEngine> | InstanceType<typeof CodexEngine>>();
  engines.set("claude", claudeEngine);
  engines.set("codex", codexEngine);

  // Derive connector names from config
  const connectorNames: string[] = [];
  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    connectorNames.push("slack");
  }
  if (config.connectors?.discord?.botToken || config.connectors?.discord?.proxyVia) {
    connectorNames.push("discord");
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
      await slack.start();
      connectors.push(slack);
      connectorMap.set("slack", slack);
    } catch (err) {
      logger.error(`Failed to start Slack connector: ${err instanceof Error ? err.message : err}`);
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
      await discord.start();
      connectors.push(discord);
      connectorMap.set("discord", discord);
      logger.info("Discord remote connector started");
    } catch (err) {
      logger.error(`Failed to start remote Discord connector: ${err instanceof Error ? err.message : err}`);
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
      await discord.start();
      connectors.push(discord);
      connectorMap.set("discord", discord);
      logger.info("Discord connector started");
    } catch (err) {
      logger.error(`Failed to start Discord connector: ${err instanceof Error ? err.message : err}`);
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
      await discord.start();
      connectors.push(discord);
      connectorMap.set("discord", discord);
      logger.info(`Discord connector started in remote mode (via ${config.connectors.discord.proxyVia})`);
    } catch (err) {
      logger.error(`Failed to start remote Discord connector: ${err instanceof Error ? err.message : err}`);
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
      await whatsapp.start();
      connectors.push(whatsapp);
      connectorMap.set("whatsapp", whatsapp);
      logger.info("WhatsApp connector started (scan QR code if first run)");
    } catch (err) {
      logger.error(`Failed to start WhatsApp connector: ${err instanceof Error ? err.message : err}`);
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
          default:
            logger.warn(`Unknown connector type "${type}" for instance "${id}"`);
            continue;
        }
        connectors.push(connector);
        connectorMap.set(id, connector);
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      } catch (err) {
        logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  sessionManager.setConnectorProvider(() => connectorMap);

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
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
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
      emit("org:changed", {});
    },
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  // Start listening
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";

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
    codexEngine.killAll();

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

    // Close WebSocket server
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}

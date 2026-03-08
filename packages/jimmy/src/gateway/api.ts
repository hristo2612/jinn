import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { JimmyConfig } from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  insertMessage,
  getMessages,
} from "../sessions/registry.js";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  LOGS_DIR,
} from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface ApiContext {
  config: JimmyConfig;
  sessionManager: SessionManager;
  startTime: number;
  getConfig: () => JimmyConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../shared/types.js").Connector>;
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
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
      });
    }

    // GET /api/sessions
    if (method === "GET" && pathname === "/api/sessions") {
      const sessions = listSessions();
      return json(res, sessions);
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

      return json(res, { ...session, messages });
    }

    // DELETE /api/sessions/:id
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);

      // Kill any live bidirectional process for this session
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine) {
        const { isBidirectionalEngine } = await import("../shared/types.js");
        if (isBidirectionalEngine(engine) && engine.isAlive(params.id)) {
          logger.info(`Killing bidirectional process for deleted session ${params.id}`);
          engine.kill(params.id);
        }
      }

      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // GET /api/sessions/:id/children
    params = matchRoute("/api/sessions/:id/children", pathname);
    if (method === "GET" && params) {
      const children = listSessions().filter((s) => s.parentSessionId === params!.id);
      return json(res, children);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const body = JSON.parse(await readBody(req));
      const prompt = body.prompt || body.message;
      if (!prompt) return badRequest(res, "prompt or message is required");
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: `web:${Date.now()}`,
        employee: body.employee,
        parentSessionId: body.parentSessionId,
        prompt,
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
        return json(res, { ...session, status: "error", lastError: `Engine "${engineName}" not available` }, 201);
      }

      context.emit("session:started", { sessionId: session.id });
      runWebSession(session, prompt, engine, config, context).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Web session ${session.id} error: ${errMsg}`);
        updateSession(session.id, {
          status: "error",
          lastError: errMsg,
        });
        context.emit("session:completed", {
          sessionId: session.id,
          result: null,
          error: errMsg,
        });
      }).finally(() => {
        // Safety net: if session is still "running" after everything, force to error
        const current = getSession(session.id);
        if (current && current.status === "running") {
          logger.warn(`Session ${session.id} still "running" after completion — forcing to error`);
          updateSession(session.id, { status: "error", lastError: "Session failed to complete (status stuck)" });
          context.emit("session:completed", { sessionId: session.id, result: null, error: "Session failed to complete" });
        }
      });

      return json(res, session, 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const body = JSON.parse(await readBody(req));
      const prompt = body.message || body.prompt;
      if (!prompt) return badRequest(res, "message is required");
      const interrupt = !!body.interrupt;

      const config = context.getConfig();
      const engine = context.sessionManager.getEngine(session.engine);
      if (!engine) return serverError(res, `Engine "${session.engine}" not available`);

      // Persist the user message immediately
      insertMessage(session.id, "user", prompt);

      // If session is currently running, handle mid-turn
      if (session.status === "running") {
        const queue = context.sessionManager.getQueue();
        const midTurnResult = queue.handleMidTurn(
          session.sourceRef,
          engine,
          session.id,
          prompt,
          interrupt,
        );

        if (midTurnResult === "steered") {
          context.emit("session:steered", { sessionId: session.id, message: prompt });
          return json(res, { status: "steered", sessionId: session.id });
        }

        if (midTurnResult === "interrupted") {
          // Kill happened — start a new turn with --resume after a brief delay
          context.emit("session:interrupted", { sessionId: session.id });
          setTimeout(() => {
            context.emit("session:started", { sessionId: session.id });
            runWebSession(session, prompt, engine, config, context).catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              logger.error(`Web session ${session.id} error after interrupt: ${errMsg}`);
              updateSession(session.id, { status: "error", lastError: errMsg });
              context.emit("session:completed", { sessionId: session.id, result: null, error: errMsg });
            }).finally(() => {
              const current = getSession(session.id);
              if (current && current.status === "running") {
                logger.warn(`Session ${session.id} still "running" after interrupt completion — forcing to error`);
                updateSession(session.id, { status: "error", lastError: "Session failed to complete (status stuck)" });
                context.emit("session:completed", { sessionId: session.id, result: null, error: "Session failed to complete" });
              }
            });
          }, 500);
          return json(res, { status: "interrupted", sessionId: session.id });
        }

        // midTurnResult === "queued" — fall through to normal queue behavior
        context.emit("session:queued", { sessionId: session.id, message: prompt });
      }

      context.emit("session:started", { sessionId: session.id });
      runWebSession(session, prompt, engine, config, context).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Web session ${session.id} error: ${errMsg}`);
        updateSession(session.id, {
          status: "error",
          lastError: errMsg,
        });
        context.emit("session:completed", {
          sessionId: session.id,
          result: null,
          error: errMsg,
        });
      }).finally(() => {
        const current = getSession(session.id);
        if (current && current.status === "running") {
          logger.warn(`Session ${session.id} still "running" after message completion — forcing to error`);
          updateSession(session.id, { status: "error", lastError: "Session failed to complete (status stuck)" });
          context.emit("session:completed", { sessionId: session.id, result: null, error: "Session failed to complete" });
        }
      });

      return json(res, { status: "queued", sessionId: session.id });
    }

    // GET /api/cron
    if (method === "GET" && pathname === "/api/cron") {
      if (!fs.existsSync(CRON_JOBS)) return json(res, []);
      const jobs = JSON.parse(fs.readFileSync(CRON_JOBS, "utf-8"));
      return json(res, jobs);
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

    // PUT /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "PUT" && params) {
      if (!fs.existsSync(CRON_JOBS)) return notFound(res);
      const jobs = JSON.parse(fs.readFileSync(CRON_JOBS, "utf-8")) as Array<{
        id: string;
        [key: string]: unknown;
      }>;
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const body = JSON.parse(await readBody(req));
      jobs[idx] = { ...jobs[idx], ...body, id: params.id };
      fs.writeFileSync(CRON_JOBS, JSON.stringify(jobs, null, 2));
      return json(res, jobs[idx]);
    }

    // GET /api/org
    if (method === "GET" && pathname === "/api/org") {
      if (!fs.existsSync(ORG_DIR)) return json(res, { departments: [], employees: [] });
      const entries = fs.readdirSync(ORG_DIR, { withFileTypes: true });
      const departments = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const employees: string[] = [];
      // Scan root-level YAML files
      for (const e of entries) {
        if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml"))) {
          employees.push(e.name.replace(/\.ya?ml$/, ""));
        }
      }
      // Scan employees/ subdirectory
      const employeesDir = path.join(ORG_DIR, "employees");
      if (fs.existsSync(employeesDir)) {
        const empEntries = fs.readdirSync(employeesDir, { withFileTypes: true });
        for (const e of empEntries) {
          if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml"))) {
            employees.push(e.name.replace(/\.ya?ml$/, ""));
          }
        }
      }
      // Scan inside each department directory for YAML files (excluding department.yaml)
      for (const dept of departments) {
        const deptDir = path.join(ORG_DIR, dept);
        const deptEntries = fs.readdirSync(deptDir, { withFileTypes: true });
        for (const e of deptEntries) {
          if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")) && e.name !== "department.yaml") {
            employees.push(e.name.replace(/\.ya?ml$/, ""));
          }
        }
      }
      return json(res, { departments, employees });
    }

    // GET /api/org/employees/:name
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "GET" && params) {
      const candidates = [
        path.join(ORG_DIR, "employees", `${params.name}.yaml`),
        path.join(ORG_DIR, "employees", `${params.name}.yml`),
        path.join(ORG_DIR, `${params.name}.yaml`),
        path.join(ORG_DIR, `${params.name}.yml`),
      ];
      // Also search inside each department directory
      if (fs.existsSync(ORG_DIR)) {
        const dirs = fs.readdirSync(ORG_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
        for (const dir of dirs) {
          candidates.push(path.join(ORG_DIR, dir.name, `${params.name}.yaml`));
          candidates.push(path.join(ORG_DIR, dir.name, `${params.name}.yml`));
        }
      }
      const filePath = candidates.find((c) => fs.existsSync(c));
      if (!filePath) return notFound(res);
      const content = yaml.load(fs.readFileSync(filePath, "utf-8"));
      return json(res, content);
    }

    // GET /api/org/departments/:name/board
    params = matchRoute("/api/org/departments/:name/board", pathname);
    if (method === "GET" && params) {
      const boardPath = path.join(ORG_DIR, params.name, "board.json");
      if (!fs.existsSync(boardPath)) return notFound(res);
      const board = JSON.parse(fs.readFileSync(boardPath, "utf-8"));
      return json(res, board);
    }

    // PUT /api/org/departments/:name/board
    if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) {
      const p = matchRoute("/api/org/departments/:name/board", pathname)!;
      const boardPath = path.join(ORG_DIR, p.name, "board.json");
      const deptDir = path.join(ORG_DIR, p.name);
      if (!fs.existsSync(deptDir)) return notFound(res);
      const body = JSON.parse(await readBody(req));
      fs.writeFileSync(boardPath, JSON.stringify(body, null, 2));
      context.emit("board:updated", { department: p.name });
      return json(res, { status: "ok" });
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
          // Extract description from ## Trigger section or first paragraph after title
          const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
          if (triggerMatch) {
            description = triggerMatch[1].trim();
          } else {
            // Use first non-heading, non-empty line
            const lines = content.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith("#")) {
                description = trimmed;
                break;
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

    // GET /api/config
    if (method === "GET" && pathname === "/api/config") {
      const config = context.getConfig();
      // Sanitize: remove any secrets/tokens from connectors
      const sanitized = {
        ...config,
        connectors: Object.fromEntries(
          Object.entries(config.connectors || {}).map(([k, v]) => [
            k,
            { ...v, token: v?.token ? "***" : undefined, signingSecret: v?.signingSecret ? "***" : undefined },
          ]),
        ),
      };
      return json(res, sanitized);
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const body = JSON.parse(await readBody(req));
      const yamlStr = yaml.dump(body);
      fs.writeFileSync(CONFIG_PATH, yamlStr);
      logger.info("Config updated via API");
      return json(res, { status: "ok" });
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      const logFile = path.join(LOGS_DIR, "gateway.log");
      if (!fs.existsSync(logFile)) return json(res, { lines: [] });
      const n = parseInt(url.searchParams.get("n") || "100", 10);
      const content = fs.readFileSync(logFile, "utf-8");
      const allLines = content.trim().split("\n");
      const lines = allLines.slice(-n);
      return json(res, { lines });
    }

    // POST /api/connectors/:name/send — send a message via a connector
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const body = JSON.parse(await readBody(req));
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      await connector.sendMessage(
        { channel: body.channel, thread: body.thread },
        body.text,
      );
      return json(res, { status: "sent" });
    }

    // GET /api/connectors — list available connectors
    if (method === "GET" && pathname === "/api/connectors") {
      const names = Array.from(context.connectors.keys());
      return json(res, names);
    }

    // GET /api/activity — recent activity derived from sessions
    if (method === "GET" && pathname === "/api/activity") {
      const sessions = listSessions();
      const events: Array<{ event: string; payload: unknown; ts: number }> = [];
      for (const s of sessions) {
        const ts = new Date(s.lastActivity || s.createdAt).getTime();
        if (s.status === "running") {
          events.push({ event: "session:started", payload: { sessionId: s.id, employee: s.employee, engine: s.engine }, ts });
        } else if (s.status === "idle") {
          events.push({ event: "session:completed", payload: { sessionId: s.id, employee: s.employee, engine: s.engine }, ts });
        } else if (s.status === "error") {
          events.push({ event: "session:error", payload: { sessionId: s.id, employee: s.employee, error: s.lastError }, ts });
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
      return json(res, {
        needed: sessions.length === 0 && !hasEmployees,
        sessionsCount: sessions.length,
        hasEmployees,
      });
    }

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    return serverError(res, msg);
  }
}

/**
 * Load messages from a Claude Code JSONL transcript file.
 * Used as a fallback when the messages DB is empty (pre-existing sessions).
 */
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

/**
 * Run an engine for a web session and emit results via WebSocket.
 */
import { buildContext } from "../sessions/context.js";
import { JIMMY_HOME } from "../shared/paths.js";
import type { Engine, Session } from "../shared/types.js";

async function runWebSession(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JimmyConfig,
  context: ApiContext,
): Promise<void> {
  logger.info(`Web session ${session.id} running engine "${session.engine}" (model: ${session.model || "default"})`);

  updateSession(session.id, {
    status: "running",
    lastActivity: new Date().toISOString(),
  });

  try {
    // If this session has an assigned employee, load their persona
    let employee: import("../shared/types.js").Employee | undefined;
    if (session.employee) {
      const { findEmployee } = await import("./org.js");
      const { scanOrg } = await import("./org.js");
      const registry = scanOrg();
      employee = findEmployee(session.employee, registry);
    }

    const systemPrompt = buildContext({
      source: "web",
      channel: session.sourceRef,
      user: "web-user",
      employee,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: session.id,
    });

    const engineConfig = session.engine === "codex"
      ? config.engines.codex
      : config.engines.claude;

    const result = await engine.run({
      prompt,
      resumeSessionId: session.engineSessionId ?? undefined,
      systemPrompt,
      cwd: JIMMY_HOME,
      bin: engineConfig.bin,
      model: session.model ?? engineConfig.model,
      cliFlags: employee?.cliFlags,
      interactive: session.engine === "claude" && (config.connectors?.web?.bidirectional !== false),
      sessionId: session.id,
      onStream: (delta) => {
        try {
          context.emit("session:delta", {
            sessionId: session.id,
            type: delta.type,
            content: delta.content,
            toolName: delta.toolName,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${session.id}: ${err instanceof Error ? err.message : err}`);
        }
      },
    });

    // Persist the assistant response
    if (result.result) {
      insertMessage(session.id, "assistant", result.result);
    }

    updateSession(session.id, {
      engineSessionId: result.sessionId,
      status: "idle",
      lastActivity: new Date().toISOString(),
      lastError: result.error ?? null,
    });

    context.emit("session:completed", {
      sessionId: session.id,
      employee: session.employee || "Jimmy",
      title: session.title,
      result: result.result,
      error: result.error || null,
      cost: result.cost,
      durationMs: result.durationMs,
    });

    logger.info(
      `Web session ${session.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
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
    logger.error(`Web session ${session.id} error: ${errMsg}`);
  }
}

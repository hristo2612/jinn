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
      return json(res, session);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const body = JSON.parse(await readBody(req));
      if (!body.prompt) return badRequest(res, "prompt is required");
      const config = context.getConfig();
      const engine = body.engine || config.engines.default;
      const session = createSession({
        engine,
        source: "web",
        sourceRef: `web:${Date.now()}`,
        employee: body.employee,
      });
      // TODO: actually run the session via the session manager
      // For now just create and return it
      logger.info(`Web session created: ${session.id}`);
      return json(res, session, 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const body = JSON.parse(await readBody(req));
      if (!body.message) return badRequest(res, "message is required");
      updateSession(params.id, {
        lastActivity: new Date().toISOString(),
      });
      // TODO: route message through session manager
      logger.info(`Message sent to session ${params.id}`);
      return json(res, { status: "queued", sessionId: params.id });
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
      const employees = entries
        .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
        .map((e) => e.name.replace(/\.ya?ml$/, ""));
      // Also scan employee subdirectory
      const employeesDir = path.join(ORG_DIR, "employees");
      if (fs.existsSync(employeesDir)) {
        const empEntries = fs.readdirSync(employeesDir, { withFileTypes: true });
        for (const e of empEntries) {
          if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml"))) {
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

    // GET /api/skills
    if (method === "GET" && pathname === "/api/skills") {
      if (!fs.existsSync(SKILLS_DIR)) return json(res, []);
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      const skills = entries.filter((e) => e.isDirectory()).map((e) => e.name);
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

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    return serverError(res, msg);
  }
}

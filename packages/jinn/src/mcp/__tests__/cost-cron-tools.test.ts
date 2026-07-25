import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { ensureSessionCapability } from "../identity.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-cost-cron-home-"));

type Api = typeof import("../../gateway/api.js");
type Registry = typeof import("../../sessions/registry.js");
type CostTools = typeof import("../cost-tools.js");
type CronTools = typeof import("../cron-tools.js");
type Server = typeof import("../server.js");
let api: Api;
let registry: Registry;
let costTools: CostTools;
let cronTools: CronTools;
let server: Server;
let integrationCallerId: string;

interface SeenCall {
  url: string;
  headers: Record<string, string>;
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  callerSessionId: string | null = "session-test",
  sessionCapability = callerSessionId ? "cap-test" : undefined,
) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = {
    gatewayUrl: "http://127.0.0.1:7777",
    fetchFn,
    ...(callerSessionId ? { callerSessionId } : {}),
    ...(sessionCapability ? { sessionCapability } : {}),
  };
  return { calls, ctx };
}

function costTool(): JinnMcpTool {
  const t = costTools.buildCostTools().find((tool) => tool.name === "cost_report");
  if (!t) throw new Error("missing cost_report");
  return t;
}

function cronTool(name: string): JinnMcpTool {
  const t = cronTools.buildCronTools().find((tool) => tool.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t;
}

describe("cost + cron tools — schemas and belt registration", () => {
  it("exposes the cost-only 020c tool and the two cron read tools", () => {
    expect(costTools.buildCostTools().map((t) => t.name)).toEqual(["cost_report"]);
    expect(cronTools.buildCronTools().map((t) => t.name)).toEqual(["list_cron_jobs", "get_cron_run_history"]);
    expect(costTool().inputSchema.properties).not.toHaveProperty("workItemId");
    expect(cronTool("get_cron_run_history").inputSchema.required).toEqual(["id"]);
  });

  it("registers the read-tier tools on the belt without adding work-item duplicates", () => {
    const names = server.buildTools().map((t) => t.name);
    expect(names).toContain("cost_report");
    expect(names).toContain("list_cron_jobs");
    expect(names).toContain("get_cron_run_history");
    expect(names).toContain("cancel_workflow_run");
    expect(names.filter((name) => name === "list_work_items")).toHaveLength(1);
    expect(names).toHaveLength(63);
  });
});

describe("cost + cron tools — unit", () => {
  it("cost_report validates groupBy and sends a capped read query", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { rows: [], total: { cost: 0, turns: 0, sessions: 0 } } }));
    await expect(costTool().handler({ groupBy: "workItem" }, ctx)).rejects.toThrow(/groupBy must be/);
    await costTool().handler({ groupBy: "employee", employee: "alpha-dev", limit: 999 }, ctx);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/cost/report");
    expect(url.searchParams.get("groupBy")).toBe("employee");
    expect(url.searchParams.get("employee")).toBe("alpha-dev");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("read tier: cost and cron require a bound caller capability and work when bound", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(costTool().handler({}, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    await expect(cronTool("list_cron_jobs").handler({}, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(anon.calls).toHaveLength(0);

    const { ctx } = stub((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/api/cost/report") return { status: 200, body: { rows: [], total: { cost: 0, turns: 0, sessions: 0 } } };
      if (url.pathname === "/api/cron") return { status: 200, body: [] };
      return { status: 404, body: { error: "unexpected" } };
    });
    await expect(costTool().handler({}, ctx)).resolves.toMatchObject({ hint: expect.stringMatching(/engine-reported/i) });
    await expect(cronTool("list_cron_jobs").handler({}, ctx)).resolves.toMatchObject({ cronJobs: [] });
  });

  it("list_cron_jobs removes prompt bodies and get_cron_run_history caps at 10", async () => {
    const { calls, ctx } = stub((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/api/cron") {
        return { status: 200, body: [{ id: "daily", name: "Daily", schedule: "0 8 * * *", enabled: true, prompt: "secret prompt", employee: "ops", lastRun: { status: "success" } }] };
      }
      if (url.pathname === "/api/cron/daily/runs") {
        return { status: 200, body: [{ id: "run-1", timestamp: "2026-07-06T08:00:00.000Z", status: "success", result: "x".repeat(2500), prompt: "secret prompt" }] };
      }
      return { status: 404, body: { error: "unexpected" } };
    });
    const listed = (await cronTool("list_cron_jobs").handler({}, ctx)) as { cronJobs: Array<Record<string, unknown>> };
    expect(listed.cronJobs[0]).not.toHaveProperty("prompt");
    expect(listed.cronJobs[0]).toMatchObject({ id: "daily", name: "Daily", schedule: "0 8 * * *", enabled: true, employee: "ops" });
    const history = (await cronTool("get_cron_run_history").handler({ id: "daily", limit: 500 }, ctx)) as { runs: Array<Record<string, unknown>> };
    expect(new URL(calls.at(-1)!.url).searchParams.get("limit")).toBe("10");
    expect(history.runs[0]).toEqual({ id: "run-1", timestamp: "2026-07-06T08:00:00.000Z", status: "success" });
  });
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const req = Object.assign(Readable.from([]), { method: init?.method ?? "GET", url: url.pathname + url.search, headers });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  costTools = await import("../cost-tools.js");
  cronTools = await import("../cron-tools.js");
  server = await import("../server.js");
  const { appendRunLog } = await import("../../cron/jobs.js");
  fs.mkdirSync(path.join(process.env.JINN_HOME!, "cron"), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.JINN_HOME!, "cron", "jobs.json"),
    JSON.stringify([
      { id: "daily-check", name: "Daily Check", schedule: "0 8 * * *", prompt: "long private prompt", enabled: true, employee: "ops-dev" },
      { id: "allowed-key-check", name: "Allowed Key Check", schedule: "0 9 * * *", enabled: true, employee: "ops-dev" },
    ], null, 2),
  );
  appendRunLog("daily-check", {
    id: "run-secret",
    jobId: "daily-check",
    timestamp: "2026-07-05T08:00:00.000Z",
    sessionKey: "cron:daily-check:2026-07-05T08:00:00.000Z",
    status: "success",
    durationMs: 25,
    prompt: "CANARY-REQA-CRON-RUN-PROMPT",
    env: { API_KEY: "CANARY-REQA-CRON-RUN-ENV" },
    command: "command CANARY-REQA-CRON-RUN-PROMPT",
    result: "result CANARY-REQA-CRON-RUN-PROMPT",
    resultPreview: "preview CANARY-REQA-CRON-RUN-PROMPT",
    error: "error CANARY-REQA-CRON-RUN-ENV",
    message: "message CANARY-REQA-CRON-RUN-PROMPT",
  });
  appendRunLog("allowed-key-check", {
    id: "run-secret",
    jobId: "allowed-key-check",
    timestamp: "not-a-timestamp CANARY-REQA-ALLOWED-TIMESTAMP",
    startedAt: { secret: "CANARY-REQA-ALLOWED-TIMESTAMP" },
    finishedAt: ["2026-07-06T09:00:00.000Z", "CANARY-REQA-ALLOWED-TIMESTAMP"],
    sessionKey: `cron:allowed-key-check:${"x".repeat(260)}CANARY-REQA-ALLOWED-SESSION:2026-07-06T09:00:00.000Z`,
    status: "success CANARY-REQA-ALLOWED-STATUS",
    exitCode: { secret: "CANARY-REQA-ALLOWED-DURATION" },
    durationMs: { value: 25, secret: "CANARY-REQA-ALLOWED-DURATION" },
    duration: ["CANARY-REQA-ALLOWED-DURATION"],
  });
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  integrationCallerId = registry.createSession({ engine: "codex", source: "web", sourceRef: "cost-cron-caller", employee: "cost-cron-caller" }).id;
  const db = registry.initDb();
  db.prepare(
    `INSERT INTO sessions (id, engine, employee, source, source_ref, status, title, total_cost, total_turns, created_at, last_activity)
     VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)`,
  ).run("cost-a", "codex", "alpha-dev", "web", "web:cost-a", "Alpha", 1.25, 3, "2026-07-01T10:00:00.000Z", "2026-07-01T10:00:00.000Z");
  db.prepare(
    `INSERT INTO sessions (id, engine, employee, source, source_ref, status, title, total_cost, total_turns, created_at, last_activity)
     VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)`,
  ).run("cost-b", "claude", "beta-dev", "web", "web:cost-b", "Beta", 2.5, 4, "2026-07-02T10:00:00.000Z", "2026-07-02T10:00:00.000Z");
});

describe("cost + cron tools — integration through real gateway routes", () => {
  const ctx = (): JinnMcpContext => ({
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId: integrationCallerId,
    sessionCapability: ensureSessionCapability(integrationCallerId),
  });

  it("reports deterministic employee cost from existing session accounting", async () => {
    const report = (await costTool().handler({ groupBy: "employee", since: "2026-07-01T00:00:00.000Z", until: "2026-07-03T00:00:00.000Z" }, ctx())) as {
      rows: Array<{ key: string; cost: number; turns: number; sessions: number }>;
      total: { cost: number; turns: number; sessions: number };
    };
    expect(report.rows).toEqual([
      { key: "beta-dev", cost: 2.5, turns: 4, sessions: 1 },
      { key: "alpha-dev", cost: 1.25, turns: 3, sessions: 1 },
    ]);
    expect(report.total).toEqual({ cost: 3.75, turns: 7, sessions: 2 });
  });

  it("lists cron jobs and reads last-10 run history without prompt bodies", async () => {
    const listed = (await cronTool("list_cron_jobs").handler({}, ctx())) as { cronJobs: Array<Record<string, unknown>> };
    expect(listed.cronJobs[0]).toMatchObject({ id: "daily-check", name: "Daily Check", schedule: "0 8 * * *", enabled: true, employee: "ops-dev" });
    expect(listed.cronJobs[0]).not.toHaveProperty("prompt");
    const history = (await cronTool("get_cron_run_history").handler({ id: "daily-check" }, ctx())) as { runs: Array<Record<string, unknown>> };
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]).toEqual({
      id: "run-secret",
      jobId: "daily-check",
      timestamp: "2026-07-05T08:00:00.000Z",
      sessionKey: "cron:daily-check:2026-07-05T08:00:00.000Z",
      status: "success",
      durationMs: 25,
    });
    const serialized = JSON.stringify({ listed, history });
    expect(serialized).not.toContain("CANARY-REQA-CRON-RUN-PROMPT");
    expect(serialized).not.toContain("CANARY-REQA-CRON-RUN-ENV");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("env");
    expect(serialized).not.toContain("command");
    expect(serialized).not.toContain("result CANARY");
    expect(serialized).not.toContain("preview CANARY");
    expect(serialized).not.toContain("error CANARY");
    expect(serialized).not.toContain("message CANARY");
  });

  it("coerces allowed run-log keys before exposing them through MCP", async () => {
    const listed = (await cronTool("list_cron_jobs").handler({}, ctx())) as { cronJobs: Array<Record<string, unknown>> };
    const listedJob = listed.cronJobs.find((job) => job.id === "allowed-key-check");
    expect(listedJob?.lastRun).toEqual({ id: "run-secret", jobId: "allowed-key-check" });

    const history = (await cronTool("get_cron_run_history").handler({ id: "allowed-key-check" }, ctx())) as { runs: Array<Record<string, unknown>> };
    expect(history.runs).toEqual([{ id: "run-secret", jobId: "allowed-key-check" }]);

    const serialized = JSON.stringify({ listedJob, history });
    expect(serialized).not.toContain("CANARY-REQA-ALLOWED-STATUS");
    expect(serialized).not.toContain("CANARY-REQA-ALLOWED-SESSION");
    expect(serialized).not.toContain("CANARY-REQA-ALLOWED-DURATION");
    expect(serialized).not.toContain("CANARY-REQA-ALLOWED-TIMESTAMP");
    expect(serialized).not.toContain("success CANARY");
    expect(serialized).not.toContain("not-a-timestamp");
    expect(serialized).not.toContain("duration");
  });
});

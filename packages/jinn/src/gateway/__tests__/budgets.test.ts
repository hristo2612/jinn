import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/** PLA-54 — the calendar-month per-employee spend cap was enforced only on the connector path, so
 *  dashboard chats, delegations, workflow node runs and MCP-spawned sessions (all of which dispatch
 *  through runWebSession) ran uncapped. Pins the evaluator boundary and the web/API block. */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-budgets-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
for (const n of ["over-cap", "under-cap"]) fs.writeFileSync(path.join(tmpHome, "org", `${n}.yaml`), `name: ${n}\nengine: codex\nmodel: gpt-5.5\npersona: Budget fixture\n`);
const engineRuns: string[] = [];
const engineStub = { name: "stub", run: async (o: { sessionId?: string }) => { engineRuns.push(String(o.sessionId)); return { result: "ok" }; }, isAlive: () => false, kill: () => {}, killAll: () => {} };
const queueStub = { enqueue: async (_k: string, fn: () => Promise<void>) => { await fn(); }, clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {}, getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s };
const apiCtx = {
  getConfig: () => ({ gateway: {}, sessions: {}, engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } }, budgets: { employees: { "over-cap": 10, "under-cap": 10 } } }),
  connectors: new Map(), startTime: Date.now(), gatewayAuthToken: "test-token", emit: () => {},
  sessionManager: { getEngines: () => new Map(), getEngine: () => engineStub, getQueue: () => queueStub },
} as unknown as import("../api.js").ApiContext;
let api: typeof import("../api.js"), reg: typeof import("../../sessions/registry.js"), budgets: typeof import("../budgets.js");
beforeAll(async () => {
  [api, reg, budgets] = await Promise.all([import("../api.js"), import("../../sessions/registry.js"), import("../budgets.js")]);
  reg.initDb();
});
/** Bank prior spend for `employee` inside the current calendar month. */
function seedSpend(employee: string, cost: number) {
  const now = new Date().toISOString();
  reg.initDb().prepare("INSERT INTO sessions (id, engine, source, source_ref, employee, total_cost, created_at, last_activity) VALUES (?, 'codex', 'web', 'seed', ?, ?, ?, ?)").run(`seed-${employee}`, employee, cost, now, now);
}
/** The blocked-turn surface: an ⛔ assistant message on the session. */
const blocked = (id: string) => reg.getMessages(id).some((m) => m.content.startsWith("⛔"));
/** POST /api/sessions, then wait for the fire-and-forget turn to settle either way. */
async function spawn(employee: string): Promise<string> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ prompt: "probe", employee }))]),
    { method: "POST", url: "/api/sessions", headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token" } });
  let body = "";
  const res = { writeHead() { return this; }, setHeader() { return this; }, end(b?: Buffer | string) { if (b) body += b.toString(); } } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, apiCtx);
  const id = JSON.parse(body).id as string;
  for (let i = 0; i < 300 && !engineRuns.includes(id) && !blocked(id); i++) await new Promise((r) => setTimeout(r, 10));
  return id;
}

describe("employee spend caps", () => {
  it("isBudgetExhausted blocks at the limit, allows under it, ignores uncapped employees", () => {
    seedSpend("boundary", 10);
    expect(budgets.isBudgetExhausted("boundary", { boundary: 10 })).toBe(true);
    expect(budgets.isBudgetExhausted("boundary", { boundary: 10.01 })).toBe(false);
    expect(budgets.isBudgetExhausted("boundary", undefined)).toBe(false);
  });

  it("runWebSession blocks an over-budget employee before the engine runs", async () => {
    seedSpend("over-cap", 12);
    const id = await spawn("over-cap");
    expect(engineRuns).not.toContain(id);
    expect(blocked(id)).toBe(true);
    expect(reg.getSession(id)?.status).toBe("error");
  });

  it("runWebSession runs an under-budget employee", async () => {
    seedSpend("under-cap", 1);
    const id = await spawn("under-cap");
    expect(engineRuns).toContain(id);
  });
});

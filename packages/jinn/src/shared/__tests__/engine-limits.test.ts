/**
 * Engine-limits collector guards (server side of the Limits-page freshness fix).
 *
 * The collector is stateless: it reads the freshest CLI-written snapshot off
 * disk on every call. These tests prove the properties the honest UI depends
 * on — the fetched-at timestamp is the provider *capture* time (never
 * fabricated to "now"), staleness tracks the snapshot's real age, malformed or
 * unavailable providers degrade without leaking raw diagnostics, and a restart
 * (a fresh process re-reading the same disk) recovers identical data. Nothing
 * here drives a live provider: fake snapshot files + fs.utimes are the clock.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig, EngineLimitsResponse } from "../types.js";

let JINN_HOME_TMP: string;
let CODEX_HOME_TMP: string;
let CLAUDE_DIR: string;
let collectEngineLimits: (c: JinnConfig, o?: { engine?: string }) => Promise<EngineLimitsResponse>;
let invalidateModelRegistry: () => void;

const NODE = process.execPath; // always an executable absolute path → engineAvailable=true

function cfg(engineOverrides: Record<string, unknown> = {}): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: NODE, model: "opus" },
      codex: { bin: NODE, model: "gpt-5.5" },
      ...engineOverrides,
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: ["low"] }] },
      codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5", supportsEffort: true, effortLevels: ["low"] }] },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

const MISSING_BIN = path.join(os.tmpdir(), "definitely-not-a-real-cli-xyz");

function writeClaudeSnapshot(name: string, body: string, ageMs: number): string {
  const file = path.join(CLAUDE_DIR, name);
  fs.writeFileSync(file, body);
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return file;
}

function writeCodexRollout(timestampIso: string, usedPercent: number): void {
  const day = path.join(CODEX_HOME_TMP, "sessions", "2026", "07", "13");
  fs.mkdirSync(day, { recursive: true });
  const line = JSON.stringify({
    timestamp: timestampIso,
    payload: { rate_limits: { primary: { used_percent: usedPercent, window_minutes: 300 } } },
  });
  fs.writeFileSync(path.join(day, "rollout-2026-07-13T00-00-00.jsonl"), `${line}\n`);
}

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-limits-"));
  JINN_HOME_TMP = path.join(root, "home");
  CODEX_HOME_TMP = path.join(root, "codex");
  CLAUDE_DIR = path.join(JINN_HOME_TMP, "tmp", "engine-limits", "claude");
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  process.env.JINN_HOME = JINN_HOME_TMP; // frozen into paths.ts at first import below
  process.env.CODEX_HOME = CODEX_HOME_TMP; // read per-call by the collector
  // Keep the collector off the live OAuth usage API (keychain + network) so
  // these tests stay deterministic and exercise the statusline-snapshot path.
  process.env.JINN_CLAUDE_USAGE_API = "off";
  ({ collectEngineLimits } = await import("../engine-limits.js"));
  ({ invalidateModelRegistry } = await import("../models.js"));
});

afterAll(() => {
  delete process.env.JINN_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.JINN_CLAUDE_USAGE_API;
});

beforeEach(() => {
  for (const f of fs.readdirSync(CLAUDE_DIR)) fs.rmSync(path.join(CLAUDE_DIR, f));
  invalidateModelRegistry();
});

describe("collectEngineLimits — claude statusline snapshot", () => {
  it("uses the snapshot capture time as fetched-at, not now", async () => {
    const capturedAt = new Date(Date.now() - 19 * 60 * 60_000).toISOString();
    writeClaudeSnapshot(
      "s.json",
      JSON.stringify({ captured_at: capturedAt, rate_limits: { five_hour: { used_percentage: 33, resets_at: 0 } } }),
      19 * 60 * 60_000,
    );
    const out = await collectEngineLimits(cfg(), { engine: "claude" });
    const claude = out.engines.claude;
    expect(claude.status).toBe("snapshot");
    expect(claude.refreshedAt).toBe(capturedAt);
    expect(claude.windows?.[0]?.usedPercent).toBe(33);
  });

  it("marks a >30min-old snapshot stale and a fresh one not stale", async () => {
    writeClaudeSnapshot(
      "old.json",
      JSON.stringify({ captured_at: new Date().toISOString(), rate_limits: { five_hour: { used_percentage: 10 } } }),
      45 * 60_000,
    );
    let out = await collectEngineLimits(cfg(), { engine: "claude" });
    expect(out.engines.claude.stale).toBe(true);

    fs.rmSync(path.join(CLAUDE_DIR, "old.json"));
    writeClaudeSnapshot(
      "new.json",
      JSON.stringify({ captured_at: new Date().toISOString(), rate_limits: { five_hour: { used_percentage: 10 } } }),
      60_000,
    );
    out = await collectEngineLimits(cfg(), { engine: "claude" });
    expect(out.engines.claude.stale).toBeFalsy();
  });

  it("degrades a malformed snapshot to fixed copy, leaking neither payload nor parser detail", async () => {
    // Content BEGINS with a sensitive marker and is invalid JSON — the projection
    // must expose neither the marker nor any parser diagnostic (position, token…).
    const marker = "SENSITIVE-SNAPSHOT-MARKER-a1b2c3";
    writeClaudeSnapshot("bad.json", `${marker} {"rate_limits": broken}`, 60_000);
    const out = await collectEngineLimits(cfg(), { engine: "claude" });
    const claude = out.engines.claude;
    expect(claude.status).toBe("error");
    expect(claude.error).toBeTruthy(); // fixed operator-safe copy is present…

    const projected = JSON.stringify(claude);
    expect(projected).not.toContain(marker); // …but no payload fragment…
    for (const diag of ["position", "Unexpected", "Expected", "in JSON", "SyntaxError"]) {
      expect(projected).not.toContain(diag); // …and no raw parser diagnostic.
    }
  });
});

describe("collectEngineLimits — codex session rollout", () => {
  it("reads the rollout snapshot off disk with its capture timestamp", async () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    writeCodexRollout(ts, 72);
    const out = await collectEngineLimits(cfg(), { engine: "codex" });
    const codex = out.engines.codex;
    expect(codex.status).toBe("snapshot");
    expect(codex.refreshedAt).toBe(ts);
    expect(codex.windows?.[0]?.usedPercent).toBe(72);
  });
});

describe("collectEngineLimits — recovery + unsupported", () => {
  it("recovers identical data across a simulated restart (stateless re-read)", async () => {
    const capturedAt = new Date().toISOString();
    writeClaudeSnapshot(
      "s.json",
      JSON.stringify({ captured_at: capturedAt, rate_limits: { five_hour: { used_percentage: 55 } } }),
      60_000,
    );
    const a = await collectEngineLimits(cfg(), { engine: "claude" });
    invalidateModelRegistry(); // fresh process would rebuild the registry
    const b = await collectEngineLimits(cfg(), { engine: "claude" });
    expect(b.engines.claude.refreshedAt).toBe(a.engines.claude.refreshedAt);
    expect(b.engines.claude.windows?.[0]?.usedPercent).toBe(55);
  });

  it("reports an installed engine with no local quota endpoint as unsupported", async () => {
    const out = await collectEngineLimits(cfg({ grok: { bin: NODE } }), { engine: "grok" });
    expect(out.engines.grok.status).toBe("unsupported");
    expect(out.engines.grok.unsupportedReason).toBeTruthy();
  });

  it("distinguishes a not-installed CLI (unavailable) from an unsupported one", async () => {
    // Grok CLI missing → temporarily unavailable, not durably unsupported.
    const grok = await collectEngineLimits(cfg({ grok: { bin: MISSING_BIN } }), { engine: "grok" });
    expect(grok.engines.grok.status).toBe("unavailable");
    expect(grok.engines.grok.unsupportedReason).toBeTruthy();

    // A first-class engine whose CLI is missing is unavailable, not unsupported.
    invalidateModelRegistry(); // each config change rebuilds the registry (as a fresh process would)
    const claude = await collectEngineLimits(cfg({ claude: { bin: MISSING_BIN } }), { engine: "claude" });
    expect(claude.engines.claude.status).toBe("unavailable");
  });
});

describe("windowsFromClaudeUsage — OAuth usage-API bucket mapping", () => {
  let windowsFromClaudeUsage: (usage: Record<string, unknown>) => Array<{
    name: string; usedPercent?: number; windowDurationMins?: number; resetsAt?: number; resetsAtIso?: string;
  }>;
  beforeAll(async () => {
    ({ windowsFromClaudeUsage } = await import("../engine-limits.js"));
  });

  it("maps every limits[] entry generically, including per-model scoped buckets (Fable)", () => {
    const windows = windowsFromClaudeUsage({
      five_hour: { utilization: 9, resets_at: "2026-07-19T05:00:00Z" },
      seven_day: { utilization: 25, resets_at: "2026-07-25T08:00:00Z" },
      limits: [
        { kind: "session", group: "session", percent: 9, resets_at: "2026-07-19T05:00:00Z", scope: null },
        { kind: "weekly_all", group: "weekly", percent: 25, resets_at: "2026-07-25T08:00:00Z", scope: null },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 50,
          resets_at: "2026-07-25T08:00:00Z",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: true,
        },
      ],
    });
    expect(windows.map((w) => w.name)).toEqual(["5h", "7d", "7d Fable"]);
    expect(windows[0]).toMatchObject({ usedPercent: 9, windowDurationMins: 300 });
    expect(windows[1]).toMatchObject({ usedPercent: 25, windowDurationMins: 10_080 });
    // Scoped bucket: no duration (the UI must label it by name, not "7d") and
    // a real epoch-seconds reset time derived from the ISO string.
    expect(windows[2].windowDurationMins).toBeUndefined();
    expect(windows[2].usedPercent).toBe(50);
    expect(windows[2].resetsAt).toBe(Math.floor(Date.parse("2026-07-25T08:00:00Z") / 1000));
  });

  it("keeps unknown future bucket kinds instead of dropping them", () => {
    const windows = windowsFromClaudeUsage({
      limits: [
        { kind: "session", percent: 1, resets_at: "2026-07-19T05:00:00Z" },
        { kind: "monthly_mystery", percent: 42, resets_at: "2026-08-01T00:00:00Z" },
      ],
    });
    expect(windows.map((w) => w.name)).toEqual(["5h", "monthly_mystery"]);
    expect(windows[1].usedPercent).toBe(42);
  });

  it("falls back to top-level named buckets when limits[] is absent", () => {
    const windows = windowsFromClaudeUsage({
      five_hour: { utilization: 12.4, resets_at: "2026-07-19T05:00:00Z" },
      seven_day: { utilization: 80, resets_at: "2026-07-25T08:00:00Z" },
      seven_day_opus: { utilization: 5, resets_at: "2026-07-25T08:00:00Z" },
      seven_day_sonnet: null,
      extra_usage: { is_enabled: false, utilization: null },
    });
    expect(windows.map((w) => w.name)).toEqual(["5h", "7d", "7d opus"]);
    expect(windows[0].usedPercent).toBe(12); // rounded
  });

  it("tolerates malformed entries and bad reset timestamps", () => {
    const windows = windowsFromClaudeUsage({
      limits: [
        null,
        "junk",
        { kind: "session" }, // no percent → dropped
        { kind: "weekly_all", percent: 30, resets_at: "not-a-date" },
      ],
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ name: "7d", usedPercent: 30 });
    expect(windows[0].resetsAt).toBeUndefined();
    expect(windows[0].resetsAtIso).toBeUndefined();
  });
});

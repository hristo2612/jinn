/**
 * Engine-limits collector guards (server side of the Limits-page freshness fix).
 *
 * The collector is stateless: it reads the freshest CLI-written snapshot off
 * disk on every call. These tests prove the properties the honest UI depends
 * on — the fetched-at timestamp is the provider *capture* time (never
 * fabricated to "now"), staleness tracks the snapshot's real age, malformed or
 * unavailable providers degrade without leaking raw diagnostics, and a restart
 * (a fresh process re-reading the same disk) recovers identical data. Codex
 * precedence tests drive a local app-server protocol stub; all other
 * provider state comes from fake snapshot files + fs.utimes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig, EngineLimitsResponse } from "../types.js";

let JINN_HOME_TMP: string;
let CODEX_HOME_TMP: string;
let CLAUDE_DIR: string;
let TEST_ROOT_TMP: string;
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

function writeCodexAppServerStub(
  name: string,
  result?: Record<string, unknown>,
): { bin: string; startedFile: string } {
  const bin = path.join(path.dirname(CODEX_HOME_TMP), name);
  const startedFile = `${bin}.started`;
  const behavior = result
    ? [
        'process.stdin.setEncoding("utf8");',
        'let input = "";',
        "let responded = false;",
        'process.stdin.on("data", (chunk) => {',
        "  input += chunk;",
        '  if (!responded && input.includes(\'"id":2\')) {',
        "    responded = true;",
        `    process.stdout.write(JSON.stringify(${JSON.stringify({ id: 2, result })}) + "\\n");`,
        "  }",
        "});",
      ].join("\n")
    : "process.exit(1);";
  const body = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(startedFile)}, "started");\n${behavior}\n`;

  // Windows has neither a shebang nor an executable bit, so the POSIX stub is
  // inert there and these cases used to be skipped. A .cmd is not merely a
  // workaround: it is exactly the shape npm installs a CLI in on Windows, so
  // this now exercises the .cmd spawn path in engine-limits rather than
  // pretending the platform cannot be tested.
  if (process.platform === "win32") {
    const script = `${bin}.mjs`;
    fs.writeFileSync(script, body);
    const shim = `${bin}.cmd`;
    fs.writeFileSync(shim, `@echo off\r\nnode "%~dp0${path.basename(script)}" %*\r\n`);
    return { bin: shim, startedFile };
  }

  fs.writeFileSync(bin, `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(bin, 0o755);
  return { bin, startedFile };
}

beforeAll(async () => {
  TEST_ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-limits-"));
  JINN_HOME_TMP = path.join(TEST_ROOT_TMP, "home");
  CODEX_HOME_TMP = path.join(TEST_ROOT_TMP, "codex");
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
  fs.rmSync(TEST_ROOT_TMP, { recursive: true, force: true });
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

// The stubs below are `#!/usr/bin/env node` files made executable with chmod.
// Windows has neither a shebang nor an executable bit, so `spawn(bin, …)` never
// starts them and all three cases fail on what the fixture cannot express rather
// than on what they test.
//
// Not merely a fixture limitation: production spawns the engine binary the same
// way, and an npm-installed `codex` on Windows is a `.cmd` shim that Node has
// refused to spawn without a shell since 18.20.2. That is issue #103, and the
// fix for it is what makes a `.cmd` stub — and therefore real coverage here —
// possible. Re-enable these with that change rather than by relaxing them.
describe.skipIf(process.platform === "win32")("collectEngineLimits — codex session rollout", () => {
  it("prefers a successful live app-server response over an older rollout snapshot", async () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    writeCodexRollout(ts, 72);
    const live = writeCodexAppServerStub("codex-live-stub", {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "pro",
          primary: { usedPercent: 33, windowDurationMins: 300 },
        },
      },
    });

    const out = await collectEngineLimits(
      cfg({ codex: { bin: live.bin, model: "gpt-5.5" } }),
      { engine: "codex" },
    );
    const codex = out.engines.codex;
    expect(codex.status).toBe("live");
    expect(codex.windows?.[0]?.usedPercent).toBe(33);
    expect(fs.existsSync(live.startedFile)).toBe(true);
  });

  it("falls back to the rollout snapshot with its original timestamp when the live app-server fails", async () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    writeCodexRollout(ts, 72);
    const failed = writeCodexAppServerStub("codex-failed-stub");

    const out = await collectEngineLimits(
      cfg({ codex: { bin: failed.bin, model: "gpt-5.5" } }),
      { engine: "codex" },
    );
    const codex = out.engines.codex;
    expect(fs.existsSync(failed.startedFile)).toBe(true);
    expect(codex.status).toBe("snapshot");
    expect(codex.refreshedAt).toBe(ts);
    expect(codex.windows?.[0]?.usedPercent).toBe(72);
  });

  it("falls back to the rollout snapshot when the live app-server returns no buckets", async () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    writeCodexRollout(ts, 72);
    const empty = writeCodexAppServerStub("codex-empty-stub", { rateLimitsByLimitId: {} });

    const out = await collectEngineLimits(
      cfg({ codex: { bin: empty.bin, model: "gpt-5.5" } }),
      { engine: "codex" },
    );
    const codex = out.engines.codex;
    expect(fs.existsSync(empty.startedFile)).toBe(true);
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

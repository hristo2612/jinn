import { spawn } from "node:child_process";
import { killProcessTree, spawnableCommand } from "./windows-spawn.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineLimitBucket,
  EngineLimitCredits,
  EngineLimitEngineSnapshot,
  EngineLimitWindow,
  EngineLimitsResponse,
  JinnConfig,
} from "./types.js";
import { recordExhaustedWindows } from "./engine-health.js";
import { getModelRegistry } from "./models.js";
import { resolveBin } from "./resolve-bin.js";
import { collectClaudeLimits } from "./engine-limits-claude.js";
import {
  baseSnapshot,
  isoFromSeconds,
  isRecord,
  limitWindowName,
  nowIso,
  num,
  str,
  type JsonRecord,
} from "./engine-limits-util.js";

export interface CollectEngineLimitsOptions {
  engine?: string;
}

const LIVE_LIMIT_ENGINES = new Set(["codex", "claude"]);

function windowFromCodex(name: string, value: unknown): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const durationMins = num(value.windowDurationMins);
  const resetsAt = num(value.resetsAt);
  return {
    name: limitWindowName(name, durationMins),
    usedPercent: num(value.usedPercent),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

function creditsFromCodex(value: unknown): EngineLimitCredits | undefined {
  if (!isRecord(value)) return undefined;
  const resetsAt = num(value.resetsAt);
  return {
    hasCredits: typeof value.hasCredits === "boolean" ? value.hasCredits : undefined,
    unlimited: typeof value.unlimited === "boolean" ? value.unlimited : undefined,
    balance: str(value.balance),
    limit: num(value.limit),
    used: num(value.used),
    remainingPercent: num(value.remainingPercent),
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

async function readCodexRateLimits(config: JinnConfig): Promise<JsonRecord> {
  const bin = resolveBin("codex", config.engines.codex?.bin);
  const initialize = {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "jinn", version: "0" },
      capabilities: { experimentalApi: true },
    },
  };
  const request = { id: 2, method: "account/rateLimits/read", params: null };

  return new Promise((resolve, reject) => {
    // Same .cmd constraint as above. Codex usage limits were unavailable on
    // Windows entirely because this threw EINVAL and the error was swallowed.
    const appServer = spawnableCommand(bin, ["app-server", "--stdio"]);
    const child = spawn(appServer.command, appServer.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...appServer.options });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(new Error(stderr.trim() || "Timed out reading Codex rate limits"));
    }, 5000);

    function settle(value: JsonRecord): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      resolve(value);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (msg?.id === 2) {
            if (msg.error) throw new Error(JSON.stringify(msg.error));
            if (isRecord(msg.result)) settle(msg.result);
          }
        } catch {
          // Ignore partial/non-JSON lines until more data arrives.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(stderr.trim() || "Codex app-server exited before returning rate limits"));
    });
    // Writing to a child that has already exited (a real codex that died on
    // startup, or a stubbed/immediately-exiting binary) surfaces EPIPE /
    // ERR_STREAM_DESTROYED on stdin. That is an emitter separate from the child
    // and, left unhandled, becomes an uncaughtException that crashes the whole
    // process. The child's `close`/`error` handlers and the timeout already
    // reject this read, so a failed stdin write is safe to swallow here.
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(request)}\n`);
    } catch {
      // Synchronous write failure — handled by close/error/timeout above.
    }
    // Keep stdin OPEN until we settle or time out. `codex app-server --stdio`
    // exits as soon as stdin closes, so the previous fixed 1s close timer raced
    // the async rate-limit fetch and made the server exit before replying
    // ("exited before returning rate limits"). settle()/the timeout kill the
    // child for us, so there is no need to close stdin ourselves.
  });
}

function bucketsFromCodex(result: JsonRecord): EngineLimitBucket[] {
  const byId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : undefined;
  const snapshots: Array<[string, unknown]> = byId
    ? Object.entries(byId)
    : Array.isArray(result.rateLimits)
      ? result.rateLimits.map((item, idx) => [String(idx), item] as [string, unknown])
      : [];

  return snapshots.flatMap(([id, value]) => {
    if (!isRecord(value)) return [];
    const bucketId = str(value.limitId) ?? id;
    return [{
      id: bucketId,
      name: str(value.limitName),
      planType: str(value.planType),
      primary: windowFromCodex("5h", value.primary),
      secondary: windowFromCodex("7d", value.secondary),
      credits: creditsFromCodex(value.credits),
    }];
  });
}

function planWindow(name: string, windowDurationMins: number): EngineLimitWindow {
  return { name, windowDurationMins };
}

// Codex writes the same rate-limit snapshot into every `token_count` event of its
// session rollout JSONL (snake_case), so we can read it from disk exactly like the
// Claude statusline snapshot — no app-server spawn, no JSON-RPC race.
export function windowFromCodexRollout(name: string, value: unknown): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const durationMins = num(value.window_minutes);
  const resetsAt = num(value.resets_at);
  return {
    name: limitWindowName(name, durationMins),
    usedPercent: num(value.used_percent),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// Walk the date-structured sessions/YYYY/MM/DD tree newest-first to the most
// recent rollout file without listing every session.
function newestCodexRollout(sessionsDir: string): string | null {
  try {
    let dir = sessionsDir;
    for (let depth = 0; depth < 3; depth++) {
      const subdirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      if (subdirs.length === 0) return null;
      dir = path.join(dir, subdirs[0]);
    }
    const files = fs.readdirSync(dir)
      .filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))
      .map((n) => path.join(dir, n))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.file ?? null;
  } catch {
    return null;
  }
}

interface CodexRollup { rateLimits: JsonRecord; capturedAtIso?: string; mtimeMs: number }

function readCodexRollupSnapshot(): CodexRollup | null {
  const file = newestCodexRollout(path.join(codexHome(), "sessions"));
  if (!file) return null;
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t || !t.includes('"rate_limits"')) continue;
      try {
        const parsed = JSON.parse(t);
        const rl = isRecord(parsed.payload) ? parsed.payload.rate_limits : undefined;
        if (isRecord(rl)) return { rateLimits: rl, capturedAtIso: str(parsed.timestamp), mtimeMs };
      } catch { /* skip non-JSON / partial line */ }
    }
    return null;
  } catch {
    return null;
  }
}

async function collectCodexLimits(config: JinnConfig): Promise<EngineLimitEngineSnapshot> {
  const snap = baseSnapshot(config, "codex");
  if (!snap.available) {
    return { ...snap, status: "unavailable", unsupportedReason: "Codex CLI is not installed." };
  }

  // Primary: live app-server query so Limits reflects the current account state.
  try {
    const result = await readCodexRateLimits(config);
    const buckets = bucketsFromCodex(result);
    if (buckets.length > 0) {
      const main = buckets.find((b) => b.id === "codex") ?? buckets[0];
      return {
        ...snap,
        status: "live",
        source: "codex app-server account/rateLimits/read",
        windows: [main?.primary, main?.secondary].filter(Boolean) as EngineLimitWindow[],
        buckets,
        credits: main?.credits,
        accountPlan: main?.planType,
      };
    }
  } catch { /* fall back to the latest rollout snapshot */ }

  // Fallback: latest session rollout snapshot on disk.
  const rollup = readCodexRollupSnapshot();
  if (rollup) {
    const rl = rollup.rateLimits;
    const windows = [
      windowFromCodexRollout("5h", rl.primary),
      windowFromCodexRollout("7d", rl.secondary),
    ].filter(Boolean) as EngineLimitWindow[];
    if (windows.length > 0) {
      return {
        ...snap,
        status: "snapshot",
        source: "codex session rollout",
        refreshedAt: rollup.capturedAtIso ?? new Date(rollup.mtimeMs).toISOString(),
        windows,
        accountPlan: str(rl.plan_type),
        stale: Date.now() - rollup.mtimeMs > 30 * 60_000,
      };
    }
  }

  return {
    ...snap,
    status: "static",
    source: "codex session rollout",
    unsupportedReason: "No Codex session rollout with rate limits yet. Run a Codex session to populate live limits.",
  };
}

function collectUnsupported(config: JinnConfig, engine: string, reason: string): EngineLimitEngineSnapshot {
  const snap = baseSnapshot(config, engine);
  // An installed CLI with no quota endpoint is durably unsupported; a missing
  // CLI is only temporarily unavailable (install it and it works).
  return {
    ...snap,
    status: snap.available ? "unsupported" : "unavailable",
    source: "model-registry",
    unsupportedReason: snap.available ? reason : `${engine} CLI is not installed.`,
  };
}

export async function collectEngineLimits(
  config: JinnConfig,
  opts: CollectEngineLimitsOptions = {},
): Promise<EngineLimitsResponse> {
  const registry = getModelRegistry(config);
  const names = opts.engine ? [opts.engine] : Object.keys(registry);
  const generatedAt = nowIso();
  const engines: Record<string, EngineLimitEngineSnapshot> = {};

  for (const name of names) {
    if (!registry[name]) {
      engines[name] = {
        name,
        available: false,
        status: "unsupported",
        source: "model-registry",
        refreshedAt: generatedAt,
        models: [],
        unsupportedReason: "Unknown engine.",
      };
      continue;
    }

    if (name === "claude") {
      engines[name] = await collectClaudeLimits(config);
    } else if (name === "codex") {
      engines[name] = await collectCodexLimits(config);
    } else if (name === "antigravity") {
      const snap = baseSnapshot(config, name);
      engines[name] = {
        ...snap,
        status: snap.available ? "static" : "unavailable",
        source: "agy models + interactive /credits",
        windows: [planWindow("5h", 300), planWindow("7d", 10_080)],
        unsupportedReason: "Antigravity exposes plan windows and G1 credit controls through the interactive `/credits` and `/settings` UI, but no stable non-interactive JSON quota endpoint was found.",
      };
    } else if (name === "pi") {
      engines[name] = collectUnsupported(
        config,
        name,
        "Pi exposes model capabilities and per-session usage, but no aggregate account quota endpoint.",
      );
    } else if (name === "grok") {
      engines[name] = collectUnsupported(
        config,
        name,
        "Grok currently exposes model/session behavior through its CLI, but no stable local quota endpoint is registered.",
      );
    } else if (name === "hermes") {
      engines[name] = collectUnsupported(
        config,
        name,
        "Hermes currently exposes model/session behavior through its CLI, but no stable local quota endpoint is registered.",
      );
    } else {
      engines[name] = collectUnsupported(config, name, "No limit collector is registered for this engine.");
    }

    if (!LIVE_LIMIT_ENGINES.has(name) && engines[name].status === "live") engines[name].status = "snapshot";
    recordExhaustedWindows(name, engines[name].windows);
  }

  return { generatedAt, default: config.engines.default, engines };
}

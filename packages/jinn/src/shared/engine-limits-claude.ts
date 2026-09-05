/**
 * The Claude limits collector. Two sources disagree about the same account:
 * the OAuth usage API (every bucket, including per-model ones) and the CLI's
 * own statusline snapshot (the rate-limit headers of real requests). This
 * module owns both readers and the tie-break between them.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { spawnableCommand } from "./windows-spawn.js";
import type {
  EngineLimitEngineSnapshot,
  EngineLimitWindow,
  JinnConfig,
} from "./types.js";
import { CLAUDE_LIMITS_DIR } from "./paths.js";
import { readClaudeOAuthToken } from "./claude-models.js";
import { resolveBin } from "./resolve-bin.js";
import { windowsFromClaudeUsage } from "./engine-limits-claude-usage.js";
export { windowsFromClaudeUsage } from "./engine-limits-claude-usage.js";
import {
  baseSnapshot,
  isoFromSeconds,
  isRecord,
  nowIso,
  num,
  str,
  type JsonRecord,
} from "./engine-limits-util.js";

export function windowFromClaude(name: string, value: unknown, durationMins: number): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const resetsAt = num(value.resets_at);
  return {
    name,
    usedPercent: num(value.used_percentage),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

export function claudeSnapshotFile(dir: string): string | null {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
      .map((file) => {
        let hasRateLimits = false;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
          hasRateLimits = !!parsed?.rate_limits?.five_hour || !!parsed?.rate_limits?.seven_day;
        } catch { /* ignore corrupt snapshots here; collector handles selected file */ }
        return { file, hasRateLimits, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.find((f) => f.hasRateLimits)?.file ?? files[0]?.file ?? null;
  } catch {
    return null;
  }
}

/**
 * The Claude statusline payload only ever carries the `five_hour` and
 * `seven_day` buckets — the CLI filters everything else out before invoking
 * the statusline command. Per-model buckets (e.g. the Fable weekly bucket) are
 * only available from the OAuth usage API that powers the CLI's `/usage`
 * screen. This block reads the CLI's own OAuth token locally (macOS Keychain,
 * falling back to ~/.claude/.credentials.json) and queries that API. The token
 * is never logged or included in any response.
 */
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_TIMEOUT_MS = 3500;

// The token reader lives in claude-models.ts and is shared. This file used to
// keep a private copy; the two drifted (only this one learned to read the macOS
// Keychain), which broke Claude model discovery. One reader, no drift.

export async function fetchClaudeOAuthUsage(env: NodeJS.ProcessEnv = process.env): Promise<JsonRecord | undefined> {
  if (env.JINN_CLAUDE_USAGE_API === "off") return undefined;
  const token = await readClaudeOAuthToken();
  if (!token) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_OAUTH_TIMEOUT_MS);
  try {
    const res = await fetch(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function claudeAuthPlan(config: JinnConfig): Promise<string | undefined> {
  const bin = resolveBin("claude", config.engines.claude?.bin);
  return new Promise((resolve) => {
    // An npm-installed CLI on Windows is a .cmd shim, which Node refuses to
    // spawn without a shell; without this the call fails against a working
    // install and the plan silently reads as unknown.
    const auth = spawnableCommand(bin, ["auth", "status"]);
    execFile(auth.command, auth.args, { timeout: 3000, windowsHide: true, ...auth.options }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        const parsed = JSON.parse(stdout);
        resolve(str(parsed.subscriptionType) ?? str(parsed.authMethod));
      } catch {
        resolve(undefined);
      }
    });
  });
}

interface ClaudeStatuslineSnapshot {
  windows: EngineLimitWindow[];
  context?: EngineLimitEngineSnapshot["context"];
  costUsd?: number;
  refreshedAt: string;
  stale: boolean;
}

/**
 * Read one CLI-written statusline snapshot. This is the CLI's own view of the
 * rate-limit headers it received on real requests, so it is the authoritative
 * reading whenever it disagrees with the usage API. Returns `null` when the
 * file cannot be parsed; callers degrade without leaking the parse error.
 */
function readClaudeStatusline(file: string): ClaudeStatuslineSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!isRecord(parsed)) return null;
    const rateLimits = isRecord(parsed.rate_limits) ? parsed.rate_limits : {};
    const windows = [
      windowFromClaude("5h", rateLimits.five_hour, 300),
      windowFromClaude("7d", rateLimits.seven_day, 10_080),
    ].filter(Boolean) as EngineLimitWindow[];
    const ctx = isRecord(parsed.context_window) ? parsed.context_window : undefined;
    const stat = fs.statSync(file);
    return {
      windows,
      context: ctx
        ? {
            usedPercent: num(ctx.used_percentage),
            remainingPercent: num(ctx.remaining_percentage),
            contextWindowSize: num(ctx.context_window_size),
            totalInputTokens: num(ctx.total_input_tokens),
            totalOutputTokens: num(ctx.total_output_tokens),
          }
        : undefined,
      costUsd: isRecord(parsed.cost) ? num(parsed.cost.total_cost_usd) : undefined,
      refreshedAt: str(parsed.captured_at) ?? new Date(stat.mtimeMs).toISOString(),
      stale: Date.now() - stat.mtimeMs > 30 * 60_000,
    };
  } catch {
    return null;
  }
}

/**
 * True when a set of windows carries no usage signal at all — every bucket
 * reads 0 (or has no percentage). The usage API can answer 200 with a
 * well-formed but entirely zeroed payload for an account it has no reading
 * for, which is indistinguishable from "you have used nothing" unless another
 * source says otherwise.
 */
export function windowsAreAllZero(windows: EngineLimitWindow[]): boolean {
  return windows.every((w) => !w.usedPercent);
}

/**
 * True when the usage API's zeros are contradicted by the CLI's own reading.
 * The CLI takes its percentages off the rate-limit headers of real requests,
 * so a disagreeing zero means the API holds no reading for this account, not
 * that the account is idle. With no snapshot to contradict it a zeroed payload
 * still stands — a genuine post-reset zero looks exactly the same.
 */
function usageApiIsBlind(
  liveWindows: EngineLimitWindow[],
  statusline: ClaudeStatuslineSnapshot | null,
): boolean {
  return windowsAreAllZero(liveWindows) && !!statusline && !windowsAreAllZero(statusline.windows);
}

function claudeFromStatusline(
  snap: EngineLimitEngineSnapshot,
  accountPlan: string | undefined,
  hasSnapshotFile: boolean,
  statusline: ClaudeStatuslineSnapshot | null,
): EngineLimitEngineSnapshot {
  if (!hasSnapshotFile) {
    return {
      ...snap,
      status: "static",
      source: "claude-statusline",
      accountPlan,
      unsupportedReason: "No Claude statusline snapshot has been captured yet. Run a Claude session to populate live limits.",
    };
  }
  if (!statusline) {
    // Never surface the raw parse/exception text: it can echo snapshot payload
    // fragments or parser positions into the public projection. Fixed copy only.
    return {
      ...snap,
      status: "error",
      source: "claude-statusline",
      accountPlan,
      error: "The latest Claude usage snapshot could not be read.",
    };
  }
  return {
    ...snap,
    status: statusline.windows.length > 0 ? "snapshot" : "static",
    source: "claude-statusline",
    refreshedAt: statusline.refreshedAt,
    accountPlan,
    windows: statusline.windows,
    context: statusline.context,
    costUsd: statusline.costUsd,
    stale: statusline.stale,
  };
}

export async function collectClaudeLimits(config: JinnConfig): Promise<EngineLimitEngineSnapshot> {
  const snap = baseSnapshot(config, "claude");
  if (!snap.available) {
    return { ...snap, status: "unavailable", unsupportedReason: "Claude CLI is not installed." };
  }

  const latest = claudeSnapshotFile(CLAUDE_LIMITS_DIR);
  const [accountPlan, oauthUsage] = await Promise.all([
    claudeAuthPlan(config),
    fetchClaudeOAuthUsage(),
  ]);
  const liveWindows = oauthUsage ? windowsFromClaudeUsage(oauthUsage) : [];
  const statusline = latest ? readClaudeStatusline(latest) : null;

  // Live path: the OAuth usage API carries every bucket (including per-model
  // ones like the Fable weekly bucket) that the statusline payload never sees.
  if (liveWindows.length > 0 && !usageApiIsBlind(liveWindows, statusline)) {
    return {
      ...snap,
      status: "live",
      source: "claude oauth usage api",
      refreshedAt: nowIso(),
      accountPlan,
      windows: liveWindows,
      // Context/cost only ever come from the statusline snapshot (best effort).
      context: statusline?.context,
      costUsd: statusline?.costUsd,
    };
  }

  return claudeFromStatusline(snap, accountPlan, !!latest, statusline);
}

import { extractCodexContextTokens, extractCodexTokenUsage, codexUsageDelta, lastCodexTranscriptContextTokens, type CodexTokenUsage } from './codex-usage.js';
export { extractCodexContextTokens, extractCodexTokenUsage, codexUsageDelta, lastCodexTranscriptContextTokens, type CodexTokenUsage } from './codex-usage.js';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta, ResolvedMcpConfig, McpServerStdioConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { CODEX_HOMES_DIR } from "../shared/paths.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { costOfUsage } from "../shared/model-pricing.js";
import { buildPromptWithPlatformContext } from "./platform-context.js";
import { CodexNativeAgents } from "./codex-native-agents.js";
import {
  CODEX_SESSIONS_DIR,
  codexRateLimitFor,
} from "./codex-transcript.js";


// Hard backstop so a genuinely stuck turn (no terminal event ever) can't hang
// forever. This is not a normal turn limit; long-running work can span days.
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export interface CodexEngineOpts {
  codexSessionsDir?: string;
  /** Base dir for per-session CODEX_HOME overlays. Defaults to CODEX_HOMES_DIR;
   *  overridable so tests never write under the real ~/.jinn. */
  codexHomesBaseDir?: string;
}

export function codexCliFlags(flags: string[] | undefined): string[] {
  // `--chrome` is a Claude Code flag. Older shared employee/config paths can
  // still provide it via cliFlags; Codex rejects it before a session starts.
  return (flags ?? []).filter((flag) => flag !== "--chrome");
}

/**
 * GRS-012b — translate the resolved MCP server set into Codex `-c` config
 * overrides so a spawned `codex exec` session attaches the same servers other
 * MCP-capable engines get (the wave-30 `resolvedMcp` payload's first non-Claude
 * consumer). Codex reads `[mcp_servers.<name>]` TOML; per-invocation `-c
 * dotted.key=value` overrides let us attach per session WITHOUT editing the
 * operator's global `~/.codex/config.toml`.
 *
 * Only stdio servers (those with a `command`) are emitted; URL-based servers are
 * skipped for this slice. Values are JSON-encoded, which is a valid TOML basic
 * string for the plain command/path/URL values involved.
 *
 * SECURITY: `-c` values land in the process argv, which is world-readable (e.g.
 * `ps`). So this NEVER serializes an arbitrary `server.env` — only env keys on an
 * explicit non-secret allowlist are emitted. Any secret-bearing env (a
 * `${SECRET}`-expanded API key on the `search` server or a custom server) is
 * deliberately dropped from argv; such servers must receive their secrets via the
 * engine's inherited process env instead — wiring that up for non-`jinn` servers
 * is a later slice.
 *
 * GRS-018 unified builtin-env model: codex spawns MCP servers with a CLEAN env
 * (probe-verified, ~8 baseline keys — nothing inherits), so the BUILTIN `jinn`
 * server's whole required env must ride this allowlisted argv channel:
 *   - JINN_GATEWAY_URL — reach the (possibly sandbox-port) gateway;
 *   - JINN_SESSION_ID  — the GRS-017 caller-identity seam;
 *   - JINN_HOME        — lets the server read its bearer from the 0600
 *     <JINN_HOME>/gateway.json (mcp/server.ts fallback), since the token itself
 *     must never ride argv.
 *
 * GRS-021c hygiene: the per-session capability is not on that allowlist. When a
 * bound capability is present, CodexEngine writes the full builtin-jinn server
 * stanza to a 0600 Codex profile file and passes only `--profile <name>` on argv.
 * Third-party servers stay on the URL-only base list — identity, capability,
 * and the token path are builtin-jinn privileges, not a general grant.
 */
const CODEX_ARGV_SAFE_ENV_KEYS: ReadonlySet<string> = new Set(["JINN_GATEWAY_URL"]);
const CODEX_ARGV_JINN_SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
  "JINN_GATEWAY_URL",
  "JINN_SESSION_ID",
  "JINN_HOME",
]);

export function codexMcpConfigArgs(
  resolvedMcp: ResolvedMcpConfig | undefined,
  opts: { skipJinn?: boolean } = {},
): string[] {
  const servers = resolvedMcp?.mcpServers;
  if (!servers) return [];
  const args: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    const command = (spec as McpServerStdioConfig).command;
    if (!command) continue; // stdio servers only (URL servers skipped this slice)
    const stdio = spec as McpServerStdioConfig;
    // When a per-session CODEX_HOME is active, the builtin jinn server rides its
    // config.toml (token off argv) — don't also re-emit it on argv.
    if (opts.skipJinn && name === "jinn" && stdio.env?.JINN_SESSION_CAPABILITY) continue;
    args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(command)}`);
    const cmdArgs = stdio.args ?? [];
    args.push("-c", `mcp_servers.${name}.args=[${cmdArgs.map((a) => JSON.stringify(a)).join(",")}]`);
    if (stdio.env) {
      // Only emit allowlisted non-secret env keys into argv; drop everything else
      // (potential secrets) so nothing sensitive is exposed via the process table.
      // The builtin jinn server gets its (wider, still non-secret) required set.
      const allowlist = name === "jinn" ? CODEX_ARGV_JINN_SAFE_ENV_KEYS : CODEX_ARGV_SAFE_ENV_KEYS;
      const safe = Object.entries(stdio.env).filter(([k]) => allowlist.has(k));
      if (safe.length > 0) {
        const inline = safe.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",");
        args.push("-c", `mcp_servers.${name}.env={${inline}}`);
      }
    }
  }
  return args;
}

/**
 * A per-session Codex `CODEX_HOME` overlay. Codex 0.141 dropped the legacy
 * `profile` config key, so `codex exec resume` cannot layer a `--profile` file —
 * the old profile mechanism lost the jinn MCP server after the first resume. The
 * fix unifies fresh + resume onto ONE mechanism: both point `CODEX_HOME` at this
 * stable per-session dir, whose auto-loaded `config.toml` carries the builtin-jinn
 * stanza (capability in the 0600 file, NEVER on argv). Because the codex thread
 * rollout lives under `CODEX_HOME`, fresh and every resume of the same jinn
 * session MUST share this dir — that's a correctness requirement, not cosmetics.
 */
export interface CodexSessionHome {
  /** Absolute path to point `CODEX_HOME` at for this session's turns. */
  home: string;
  /** Remove the whole per-session dir. Call on SESSION end, never per-turn. */
  cleanup: () => void;
}

function pathIsInsideOrEqual(child: string, parent: string): boolean {
  const childPath = path.resolve(child);
  const parentPath = path.resolve(parent);
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The operator's real codex home — source of `auth.json` + base `config.toml`. */
export function realCodexHome(codexHomesBaseDir: string = CODEX_HOMES_DIR): string {
  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome && !pathIsInsideOrEqual(envHome, codexHomesBaseDir)) return envHome;
  return path.join(os.homedir(), ".codex");
}

// Codex normally lets all concurrent CLI processes share these directories in
// ~/.codex. Keeping private copies inside every Jinn session home only multiplies
// remote plugin checkouts and caches; none of them is required to locate or
// resume a session thread. Session rollouts and SQLite state remain private.
const SHARED_CODEX_HOME_DIRS = ["plugins", "cache", "skills", "vendor_imports", ".tmp"] as const;

// Same idea, for shared assets that are FILES. They cannot ride
// SHARED_CODEX_HOME_DIRS: that path mkdir's its target, which would plant a bogus
// directory of this name inside the operator's real codex home.
const SHARED_CODEX_HOME_FILES = ["models_cache.json"] as const;

function linkSharedCodexHomeDirs(sessionHome: string, realHome: string): void {
  for (const name of SHARED_CODEX_HOME_DIRS) {
    const shared = path.join(realHome, name);
    const link = path.join(sessionHome, name);
    try {
      fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
      let alreadyLinked = false;
      try {
        const stat = fs.lstatSync(link);
        alreadyLinked =
          stat.isSymbolicLink() &&
          path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.resolve(shared);
      } catch { /* missing link — create it below */ }
      if (alreadyLinked) continue;

      // Safe for legacy overlays: rmSync removes a symlink itself rather than
      // following it, and this runs before the session's next Codex process starts.
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(shared, link, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      logger.warn(`Codex per-session home: could not share ${name} (${err instanceof Error ? err.message : err})`);
    }
  }
}

function linkSharedCodexHomeFiles(sessionHome: string, realHome: string): void {
  for (const name of SHARED_CODEX_HOME_FILES) {
    const shared = path.join(realHome, name);
    const link = path.join(sessionHome, name);
    try {
      // Never create the target: codex writes these caches itself, and an empty
      // placeholder would be worse than no link at all.
      if (!fs.existsSync(shared)) continue;
      let alreadyLinked = false;
      try {
        const stat = fs.lstatSync(link);
        alreadyLinked =
          stat.isSymbolicLink() &&
          path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.resolve(shared);
      } catch { /* missing link — create it below */ }
      if (alreadyLinked) continue;

      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(shared, link);
    } catch (err) {
      logger.warn(`Codex per-session home: could not share ${name} (${err instanceof Error ? err.message : err})`);
    }
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A `[mcp_servers.<name>]` TOML stanza (command/args + full env, incl. capability). */
function buildJinnMcpStanza(name: string, spec: McpServerStdioConfig): string {
  const lines = [`[mcp_servers.${name}]`, `command = ${tomlString(spec.command)}`];
  lines.push(`args = [${(spec.args ?? []).map(tomlString).join(", ")}]`);
  const env = spec.env ?? {};
  if (Object.keys(env).length > 0) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(env)) lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function tomlTableName(line: string): string | undefined {
  const match = line.trim().match(/^\[{1,2}\s*([^\[\]]+?)\s*\]{1,2}$/);
  return match?.[1]?.trim();
}

function isJinnMcpTable(name: string): boolean {
  return name === "mcp_servers.jinn" || name.startsWith("mcp_servers.jinn.");
}

function stripJinnMcpStanzas(configText: string): string {
  const lines = configText.split(/\r?\n/);
  const kept: string[] = [];
  let skippingJinnTable = false;

  for (const line of lines) {
    const table = tomlTableName(line);
    if (table) {
      skippingJinnTable = isJinnMcpTable(table);
      if (skippingJinnTable) continue;
    }
    if (!skippingJinnTable) kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** Filesystem-safe per-session dir name derived from the jinn session id. */
function safeSessionDirName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "session";
}

export function codexSessionHomeDir(sessionId: string, baseDir: string = CODEX_HOMES_DIR): string {
  return path.join(baseDir, safeSessionDirName(sessionId));
}

/**
 * Ensure the per-session CODEX_HOME overlay exists and its `config.toml` carries
 * the builtin-jinn MCP stanza. Idempotent across turns; the `config.toml` is
 * REWRITTEN each turn so a rotated capability takes effect. Returns `undefined`
 * (→ default ~/.codex home, jinn MCP via argv) when there is no builtin-jinn
 * server carrying a capability token — third-party / no-capability behaviour is
 * unchanged.
 */
export function prepareCodexSessionHome(
  resolvedMcp: ResolvedMcpConfig | undefined,
  sessionId: string,
  opts: { baseDir?: string } = {},
): CodexSessionHome | undefined {
  const spec = resolvedMcp?.mcpServers?.jinn as (McpServerStdioConfig & { url?: unknown }) | undefined;
  if (!spec || typeof spec.command !== "string" || spec.url !== undefined || !spec.env?.JINN_SESSION_CAPABILITY) {
    return undefined;
  }

  const baseDir = opts.baseDir ?? CODEX_HOMES_DIR;
  const home = codexSessionHomeDir(sessionId, baseDir);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(home, 0o700); } catch { /* best effort on filesystems without POSIX modes */ }

  // Symlink auth.json back to the real codex home so login (and token refreshes)
  // propagate — the overlay never owns credentials.
  const realHome = realCodexHome(baseDir);
  linkSharedCodexHomeDirs(home, realHome);
  linkSharedCodexHomeFiles(home, realHome);
  const realAuth = path.join(realHome, "auth.json");
  const linkAuth = path.join(home, "auth.json");
  try {
    if (fs.existsSync(realAuth)) {
      const already =
        fs.existsSync(linkAuth) &&
        fs.lstatSync(linkAuth).isSymbolicLink() &&
        fs.readlinkSync(linkAuth) === realAuth;
      if (!already) {
        try { fs.rmSync(linkAuth, { force: true }); } catch { /* ignore */ }
        fs.symlinkSync(realAuth, linkAuth);
      }
    }
  } catch (err) {
    logger.warn(`Codex per-session home: could not link auth.json (${err instanceof Error ? err.message : err}); codex may fail to authenticate`);
  }

  // Merge the operator's base config.toml, then append the jinn MCP stanza so the
  // user's own settings (model, providers, other servers) survive the CODEX_HOME
  // swap. Rewritten each turn (capability rotation). 0600 — it holds the token.
  let baseConfig = "";
  try {
    const realConfig = path.join(realHome, "config.toml");
    if (fs.existsSync(realConfig)) baseConfig = fs.readFileSync(realConfig, "utf8");
  } catch { /* no base config — fine, start empty */ }
  const cleanBaseConfig = stripJinnMcpStanzas(baseConfig);
  const merged = (cleanBaseConfig.trimEnd() + "\n\n" + buildJinnMcpStanza("jinn", spec)).replace(/^\n+/, "");
  const cfgPath = path.join(home, "config.toml");
  fs.writeFileSync(cfgPath, merged, { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* best effort */ }

  return { home, cleanup: () => removeCodexSessionHome(sessionId, baseDir) };
}

/**
 * Remove a session's CODEX_HOME overlay. Idempotent and safe on non-codex /
 * already-removed sessions — call it from the session-teardown path (not per
 * turn: the dir must persist across a session's turns so resume finds the thread).
 */
export function removeCodexSessionHome(sessionId: string, baseDir: string = CODEX_HOMES_DIR): void {
  try {
    fs.rmSync(codexSessionHomeDir(sessionId, baseDir), { recursive: true, force: true });
  } catch { /* ignore cleanup errors */ }
}

/** How long an overlay may sit without a turn before it is worth nothing. */
const CODEX_HOME_MAX_IDLE_DAYS = 14;
const CODEX_HOME_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Retention sweep for per-session CODEX_HOME overlays. Homes are removed on
 * session teardown, but a session whose record is gone (crash, hard delete,
 * pre-fix accumulation) leaves its overlay behind forever — that leak grew to
 * 276 dirs / 2.4GB.
 *
 * Age decides, not the session row: `config.toml` is rewritten on every turn, so
 * its mtime is an exact last-activity stamp needing no DB read, and a thread that
 * has not taken a turn in `maxAgeDays` is not worth resuming. `knownSessionIds`
 * only breaks the tie for an overlay with no stamp at all (a crash between the
 * mkdir and the first write) — pass EVERY session id, archived and
 * workflow-phase included, since those resume too. Never touches the shared
 * caches (dot-entries / SHARED_CODEX_HOME_DIRS / SHARED_CODEX_HOME_FILES live
 * alongside overlays), at any age. Returns the number of overlays removed.
 */
export function sweepOrphanCodexSessionHomes(
  knownSessionIds: Iterable<string>,
  baseDir: string = CODEX_HOMES_DIR,
  maxAgeDays: number = CODEX_HOME_MAX_IDLE_DAYS,
): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return 0; // no codex-homes dir yet — nothing to sweep
  }
  const keep = new Set<string>();
  for (const id of knownSessionIds) keep.add(safeSessionDirName(id));
  const shared = new Set<string>([...SHARED_CODEX_HOME_DIRS, ...SHARED_CODEX_HOME_FILES]);
  const idleCutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (entry.startsWith(".") || shared.has(entry)) continue;
    let lastTurnAt: number | undefined;
    try {
      lastTurnAt = fs.statSync(path.join(baseDir, entry, "config.toml")).mtimeMs;
    } catch { /* no stamp — the keep-list decides below */ }
    const stale = lastTurnAt === undefined ? !keep.has(entry) : lastTurnAt < idleCutoff;
    if (!stale) continue;
    try {
      fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

/**
 * Run the overlay sweep now and every 24h thereafter. Session rows outlive their
 * overlays' usefulness and nothing else reaps them, so a boot-only sweep leaves a
 * long-running gateway accumulating dead homes indefinitely. `listSessionIds` is
 * re-read on every run so sessions created since the last one are honoured.
 * Returns the interval timer (already `unref`'d — this must never hold the
 * process open) so a caller can stop it.
 */
export function startCodexSessionHomeSweeps(opts: {
  listSessionIds: () => Iterable<string>;
  baseDir?: string;
  maxAgeDays?: number;
  intervalMs?: number;
}): NodeJS.Timeout {
  const sweep = () => {
    try {
      const removed = sweepOrphanCodexSessionHomes(opts.listSessionIds(), opts.baseDir, opts.maxAgeDays);
      if (removed > 0) logger.info(`Swept ${removed} stale Codex session home(s)`);
    } catch (err) {
      logger.warn(`Codex session home sweep failed (${err instanceof Error ? err.message : err})`);
    }
  };
  sweep();
  const timer = setInterval(sweep, opts.intervalMs ?? CODEX_HOME_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

/**
 * Build `codex exec` argv for a FRESH turn. When `homeActive` is true the builtin
 * jinn server rides the per-session CODEX_HOME config.toml, so it is skipped from
 * the argv `-c` overrides (its capability must never touch argv). No `--profile`:
 * codex 0.141 dropped it, and fresh/resume are unified on the CODEX_HOME overlay.
 *
 * The prompt is user text, so it goes behind `--`. Without the separator codex's
 * parser reads a leading dash as a flag and exits 2 (`unexpected argument '- '`),
 * and a prompt of "resume" or "review" would dispatch a subcommand instead.
 */
export function buildCodexFreshArgs(opts: EngineRunOpts, prompt: string, homeActive: boolean): string[] {
  const args = ["exec"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
  args.push("--json", "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
  if (opts.cwd) args.push("-C", opts.cwd);
  args.push(...codexMcpConfigArgs(opts.resolvedMcp, { skipJinn: homeActive }));
  args.push(...codexCliFlags(opts.cliFlags));
  args.push("--", prompt);
  return args;
}

/**
 * Build `codex exec resume` argv. `codex exec resume` accepts neither `--profile`
 * nor `-C`; the per-session CODEX_HOME (shared with the fresh turn) carries the
 * jinn MCP config and locates the thread rollout. Both positionals sit behind `--`
 * for the same reason the fresh turn's prompt does.
 */
export function buildCodexResumeArgs(opts: EngineRunOpts, prompt: string, homeActive: boolean): string[] {
  const args = ["exec", "resume"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
  args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
  args.push(...codexMcpConfigArgs(opts.resolvedMcp, { skipJinn: homeActive }));
  args.push(...codexCliFlags(opts.cliFlags));
  args.push("--", opts.resumeSessionId!, prompt);
  return args;
}

function missingRolloutThreadId(message: string, resumeSessionId: string | undefined): string | undefined {
  if (!resumeSessionId) return undefined;
  if (!/no rollout found|code -32600|thread\/resume failed/i.test(message)) return undefined;
  const match = message.match(/thread id\s+"?([A-Za-z0-9_.:-]+)"?/i);
  return match?.[1] || resumeSessionId;
}

/**
 * The child-process env for a codex spawn: strip inherited CLAUDE_ and CODEX_
 * env (a clean baseline — see GRS-018), then set JINN_SESSION_ID and, when a per-session
 * overlay is active, point CODEX_HOME at it. CODEX_HOME is set AFTER the strip so
 * it survives.
 */
export function codexChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  sessionId?: string,
  codexHome?: string,
): Record<string, string> {
  const env = buildEngineChildEnv(baseEnv, { scrubClaudeCode: true, scrubCodex: true });
  if (sessionId) env.JINN_SESSION_ID = sessionId;
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}


export class CodexEngine implements InterruptibleEngine {
  name = "codex" as const;
  private liveProcesses = new Map<string, LiveProcess>();
  private totalUsage = new Map<string, CodexTokenUsage>();

  constructor(private readonly opts: CodexEngineOpts = {}) {}

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Codex process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) {
        this.signalProcess(live.proc, "SIGKILL");
      }
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  /** Batch engine: no warm-PTY reuse, every live process is an in-flight turn.
   *  Nothing idle to recycle on org-reload — no-op. */
  killIdle(): void {
    /* no-op */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    let prompt = buildPromptWithPlatformContext(opts, "\n\n---\n\n");
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = resolveBin("codex", opts.bin);
    const sessionId = opts.sessionId || `codex-${Date.now()}`;
    // Per-session CODEX_HOME overlay carries the builtin-jinn MCP stanza (token in
    // its 0600 config.toml, off argv) and hosts the thread rollout. Ensured every
    // turn (idempotent); NOT cleaned up per-turn — the dir must persist so resume
    // finds the rollout. Session-end teardown removes it (manager.resetSession).
    const sessionHome = prepareCodexSessionHome(opts.resolvedMcp, sessionId, { baseDir: this.opts.codexHomesBaseDir });
    const homeActive = !!sessionHome;
    const transcriptSessionsDir = sessionHome
      ? path.join(sessionHome.home, "sessions")
      : this.opts.codexSessionsDir ?? CODEX_SESSIONS_DIR;
    const isResume = !!opts.resumeSessionId;
    const args = isResume
      ? this.buildResumeArgs(opts, prompt, homeActive)
      : this.buildFreshArgs(opts, prompt, homeActive);

    logger.info(
      `Codex engine starting: ${bin} ${args[0]}${isResume ? " resume" : ""} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"}, codexHome: ${sessionHome ? "per-session" : "default"})`,
    );

    const cleanEnv = this.buildCleanEnv(sessionId, sessionHome?.home);
    const nativeAgents = new CodexNativeAgents(transcriptSessionsDir, opts.resumeSessionId);

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      this.liveProcesses.set(sessionId, {
        proc,
        terminationReason: null,
      });

      let stderr = "";
      let settled = false;
      let threadId = "";
      let resultText = "";
      let numTurns = 0;
      let terminalSeen = false;
      let turnError: string | null = null;
      let lastContextTokens: number | undefined;
      const usageAtTurnStart = this.totalUsage.get(sessionId)
        ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      let latestTotalUsage: CodexTokenUsage | undefined;
      let lineBuf = "";
      let hardTimeout: NodeJS.Timeout | undefined;
      let terminalSettleTimer: NodeJS.Timeout | undefined;
      let nativeAgentTimer: NodeJS.Timeout | undefined;
      let nativeInterrupted = false;
      const onStream = opts.onStream || null;
      let lastStreamedTextBlock: string | null = null;
      const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting

      const clearTimers = () => {
        if (hardTimeout) { clearTimeout(hardTimeout); hardTimeout = undefined; }
        if (terminalSettleTimer) { clearTimeout(terminalSettleTimer); terminalSettleTimer = undefined; }
        if (nativeAgentTimer) { clearInterval(nativeAgentTimer); nativeAgentTimer = undefined; }
      };
      const resetTextBlockRun = () => { lastStreamedTextBlock = null; };
      const turnCost = (): number | undefined => {
        if (!latestTotalUsage) return undefined;
        this.totalUsage.set(sessionId, latestTotalUsage);
        return costOfUsage(opts.model, codexUsageDelta(usageAtTurnStart, latestTotalUsage));
      };
      const streamTextBlock = (delta: StreamDelta) => {
        if (!onStream) return;
        const needsBoundary =
          lastStreamedTextBlock !== null &&
          !lastStreamedTextBlock.endsWith("\n") &&
          !delta.content.startsWith("\n");
        onStream(needsBoundary ? { ...delta, content: `\n\n${delta.content}` } : delta);
        lastStreamedTextBlock = delta.content;
      };

      // Settle the turn on codex's parsed terminal event (`turn.completed` →
      // "usage" / `turn.failed` → "turn_failed"), decoupled from proc.on("close").
      // `close` only fires once every fd onto the child's stdout pipe is gone, but a
      // bash/shell tool call can leave a grandchild that inherits and holds that pipe
      // after codex itself exits, hanging the turn forever (the same freeze class
      // fixed for grok in 94a50cc). Mirrors GrokEngine.settleOnTerminal / PiEngine.
      const settleOnTerminal = () => {
        if (settled) return;
        flushNativeAgents();
        if (nativeAgents.active) {
          onStream?.({ type: "status", content: `Waiting for ${nativeAgents.active} native Codex agent(s)` });
          return;
        }
        settled = true;
        clearTimers();
        const terminationReason = this.liveProcesses.get(sessionId)?.terminationReason;
        this.liveProcesses.delete(sessionId);
        // Detached child has signalled turn end and will exit; don't let its (or a
        // lingering grandchild's) open stdout pipe keep the event loop busy.
        try { proc.unref?.(); } catch { /* not detached / already gone */ }

        const resolvedThreadId = threadId || opts.resumeSessionId || "";
        if (resolvedThreadId) {
          const transcriptCtx = lastCodexTranscriptContextTokens(
            resolvedThreadId,
            transcriptSessionsDir,
          );
          if (transcriptCtx) lastContextTokens = transcriptCtx;
        }

        logger.info(`Codex turn settled on terminal event (thread: ${threadId || "none"}, turns: ${numTurns})`);
        const cost = turnCost();
        const settledError = terminationReason || (nativeInterrupted ? "Native agent work stopped before completion" : resultText.trim() ? undefined : (turnError ?? undefined));
        resolve({
          sessionId: resolvedThreadId,
          result: resultText,
          error: settledError,
          numTurns: numTurns || undefined,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          ...(cost === undefined ? {} : { cost }),
          ...codexRateLimitFor(settledError, resolvedThreadId, transcriptSessionsDir),
        });
      };

      // Defer the terminal settle one tick: lets the rest of the current stdout
      // chunk finish parsing (so multiple `turn.completed` events accumulate) and a
      // promptly-firing `close` win with its own accounting, while still resolving
      // the turn when `close` never comes (held-pipe hang).
      const scheduleTerminalSettle = () => {
        if (settled || terminalSettleTimer) return;
        terminalSettleTimer = setTimeout(() => { terminalSettleTimer = undefined; settleOnTerminal(); }, 0);
        terminalSettleTimer.unref?.();
      };

      const flushNativeAgents = () => {
        const delta = nativeAgents.read();
        if (delta) onStream?.(delta);
      };
      const stopNativeAgents = () => {
        flushNativeAgents();
        const delta = nativeAgents.stop();
        if (delta) { nativeInterrupted = true; onStream?.(delta); }
      };
      nativeAgentTimer = setInterval(() => {
        flushNativeAgents();
        if (terminalSeen && !nativeAgents.active) scheduleTerminalSettle();
      }, 500);
      nativeAgentTimer.unref?.();

      hardTimeout = setTimeout(() => {
        if (settled) return;
        const live = this.liveProcesses.get(sessionId);
        if (live) live.terminationReason = "Codex turn timed out";
        logger.warn(`Codex turn timed out after ${TURN_TIMEOUT_MS}ms for session ${sessionId}; terminating process`);
        // Group-kill (signalProcess uses process.kill(-pid)) tears down any lingering
        // grandchild too, so close fires and settle() reports the termination reason.
        this.signalProcess(proc, "SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) this.signalProcess(proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      hardTimeout.unref?.();

      proc.stdout.on("data", (d: Buffer) => {
        lineBuf += d.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) {
          const parsed = this.processJsonlLine(line);
          if (!parsed) continue;

          switch (parsed.type) {
            case "thread_id":
              threadId = parsed.threadId;
              nativeAgents.bind(threadId);
              flushNativeAgents();
              logger.info(`Codex session got thread ID: ${threadId}`);
              break;
            case "tool_start":
              resetTextBlockRun();
              if (onStream) onStream(parsed.delta);
              break;
            case "tool_end":
              resetTextBlockRun();
              if (onStream) onStream(parsed.delta);
              break;
            case "text":
              // Each agent_message item is a COMPLETE assistant message; codex emits
              // several per turn (preamble + final). The result must be the FINAL
              // message, not all of them concatenated — so replace, don't append.
              // Adjacent live blocks need a paragraph boundary because the web UI
              // appends text deltas like chunks.
              resultText = parsed.delta.content;
              streamTextBlock(parsed.delta);
              break;
            case "error":
              resetTextBlockRun();
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
            case "usage":
              terminalSeen = true;
              resetTextBlockRun();
              numTurns++;
              if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
              if (parsed.totalUsage) latestTotalUsage = parsed.totalUsage;
              scheduleTerminalSettle(); // turn.completed = end of turn
              break;
            case "turn_failed":
              terminalSeen = true;
              resetTextBlockRun();
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              scheduleTerminalSettle(); // turn.failed = end of turn
              break;
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        // Keep only the last 10KB of stderr to bound memory usage
        if (stderr.length > STDERR_MAX) {
          stderr = stderr.slice(stderr.length - STDERR_MAX);
        }
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[codex stderr] ${line}`);
        }
      });

      proc.stdin.end();

      // exit does not wait for inherited stdout pipes. It is also the end of
      // the native runtime, even if an agent never produced a completion item.
      proc.on("exit", () => {
        if (settled) return;
        stopNativeAgents();
        if (terminalSeen) scheduleTerminalSettle();
      });

      proc.on("close", (code) => {
        if (settled) return;
        stopNativeAgents();
        settled = true;
        clearTimers();

        const terminationReason = this.liveProcesses.get(sessionId)?.terminationReason ?? null;
        this.liveProcesses.delete(sessionId);

        if (lineBuf.trim()) {
          const parsed = this.processJsonlLine(lineBuf);
          if (parsed) {
            switch (parsed.type) {
              case "thread_id":
                threadId = parsed.threadId;
                break;
              case "text":
                resultText = parsed.delta.content; // final message wins (see above)
                break;
              case "usage":
                numTurns++;
                if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
                if (parsed.totalUsage) latestTotalUsage = parsed.totalUsage;
                break;
              case "error":
                turnError = parsed.message;
                break;
              case "turn_failed":
                turnError = parsed.message;
                break;
            }
          }
        }

        const resolvedThreadId = threadId || opts.resumeSessionId || "";
        if (resolvedThreadId) {
          const transcriptCtx = lastCodexTranscriptContextTokens(
            resolvedThreadId,
            transcriptSessionsDir,
          );
          if (transcriptCtx) lastContextTokens = transcriptCtx;
        }

        logger.info(`Codex engine exited with code ${code} (thread: ${threadId || "none"}, turns: ${numTurns})`);

        if (terminationReason) {
          resolve({
            sessionId: resolvedThreadId,
            result: resultText,
            error: terminationReason,
            numTurns: numTurns || undefined,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        if (code === 0 || (code !== null && threadId)) {
          // A non-empty agent message means the turn genuinely succeeded — don't
          // surface a transient/benign error item (e.g. the `web_search_request`
          // deprecation notice that codex emits before the answer) as a failure.
          const cost = turnCost();
          const settledError = nativeInterrupted ? "Native agent work stopped before completion" : resultText.trim() ? undefined : (turnError ?? undefined);
          resolve({
            sessionId: resolvedThreadId,
            result: resultText,
            error: settledError,
            numTurns: numTurns || undefined,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
            ...(cost === undefined ? {} : { cost }),
            ...codexRateLimitFor(settledError, resolvedThreadId, transcriptSessionsDir),
          });
          return;
        }

        const errMsg = turnError || `Codex exited with code ${code}: ${stderr.slice(0, 500)}`;
        const missingThreadId = missingRolloutThreadId(errMsg, opts.resumeSessionId);
        if (missingThreadId) {
          logger.warn(
            `Codex resume failed: no rollout found for thread ${missingThreadId}; starting a fresh thread for Jinn session ${sessionId}`,
          );
          this.run({ ...opts, resumeSessionId: undefined }).then(resolve, reject);
          return;
        }
        logger.error(errMsg);
        resolve({
          sessionId: resolvedThreadId,
          result: resultText,
          error: errMsg,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          ...codexRateLimitFor(errMsg, resolvedThreadId, transcriptSessionsDir),
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.liveProcesses.delete(sessionId);
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }

  private buildFreshArgs(opts: EngineRunOpts, prompt: string, homeActive: boolean): string[] {
    return buildCodexFreshArgs(opts, prompt, homeActive);
  }

  private buildResumeArgs(opts: EngineRunOpts, prompt: string, homeActive: boolean): string[] {
    return buildCodexResumeArgs(opts, prompt, homeActive);
  }

  private processJsonlLine(
    line: string,
  ):
    | { type: "thread_id"; threadId: string }
    | { type: "tool_start"; delta: StreamDelta }
    | { type: "tool_end"; delta: StreamDelta }
    | { type: "text"; delta: StreamDelta }
    | { type: "error"; message: string }
    | { type: "usage"; contextTokens?: number; totalUsage?: CodexTokenUsage }
    | { type: "turn_failed"; message: string }
    | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.debug(`[codex stream] unparseable line: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const eventType = String(msg.type || "");

    if (eventType === "thread.started") {
      return { type: "thread_id", threadId: String(msg.thread_id || "") };
    }

    if (eventType === "item.started") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "command_execution") {
        const command = String(item.command || "shell");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Running: ${command}`,
            toolName: "command_execution",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Editing: ${filePath}`,
            toolName: "file_edit",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Reading: ${filePath}`,
            toolName: "file_read",
            toolId: String(item.id || ""),
          },
        };
      }

      return null;
    }

    if (eventType === "item.completed") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "agent_message") {
        const text = String(item.text || "");
        if (text) {
          return { type: "text", delta: { type: "text", content: text } };
        }
      }

      if (itemType === "command_execution") {
        const output = String(item.aggregated_output || "");
        const exitCode = item.exit_code;
        const command = String(item.command || "shell");
        return {
          type: "tool_end",
          delta: {
            type: "tool_result",
            content: output
              ? `${command} (exit ${exitCode}): ${output.slice(0, 500)}`
              : `${command} (exit ${exitCode})`,
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return { type: "tool_end", delta: { type: "tool_result", content: `Edited: ${filePath}` } };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return { type: "tool_end", delta: { type: "tool_result", content: `Read: ${filePath}` } };
      }

      if (itemType === "error") {
        const message = String(item.message || "Unknown error");
        // Benign notices codex emits as `error` items but that don't fail the turn.
        if (
          message.includes("Under-development features") ||
          message.includes("Model metadata") ||
          message.includes("deprecated") ||
          message.includes("web_search_request")
        ) {
          logger.debug(`[codex] suppressed warning: ${message.slice(0, 200)}`);
          return null;
        }
        return { type: "error", message };
      }

      return null;
    }

    if (eventType === "turn.completed") {
      const usage = msg.usage as Record<string, unknown> | undefined;
      const contextTokens = extractCodexContextTokens(usage?.last_token_usage);
      const totalUsage = extractCodexTokenUsage(usage);
      return {
        type: "usage",
        ...(contextTokens ? { contextTokens } : {}),
        ...(totalUsage ? { totalUsage } : {}),
      };
    }

    if (eventType === "turn.failed") {
      const error = msg.error as Record<string, unknown> | undefined;
      return { type: "turn_failed", message: String(error?.message || "Turn failed") };
    }

    if (eventType === "error") {
      return { type: "error", message: String(msg.message || "Unknown error") };
    }

    return null;
  }

  private buildCleanEnv(sessionId?: string, codexHome?: string): Record<string, string> {
    return codexChildEnv(process.env, sessionId, codexHome);
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Codex process: ${err instanceof Error ? err.message : err}`);
    }
  }
}

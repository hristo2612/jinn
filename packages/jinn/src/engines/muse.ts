import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { JINN_HOME } from "../shared/paths.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { buildMuseMcpArgs, museJinnSessionEnv } from "./muse-mcp.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";

interface LiveProcess {
  proc: ChildProcess;
  rl: readline.Interface;
  terminationReason: string | null;
  resultText: string;
  turnError: string | null;
  stderr: string;
  settled: boolean;
  resolve: (res: EngineResult) => void;
  sessionIdOut: string;
  hardTimeout?: NodeJS.Timeout;
  promptDir?: string;
}

const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Muse (`muse` CLI) run headlessly, one process per turn (lab fork).
 *
 * Invocation: `muse exec --json --prompt-file <file> --session-id <uuid> \
 *   --workspace <cwd> --trust-workspace --approval-mode never --disable-sandbox \
 *   [--model <id>] [--reasoning-effort <lvl>] [-c mcpServers.<n>=<json> …]`.
 *
 * `--json` emits MSP session-event envelopes, one JSON object per stdout
 * line. Assistant text arrives as `run.output.delta` payloads; the turn's
 * result is their concatenation, settled when the process exits (mirrors
 * Pi's close semantics — there is no single terminal event to trust).
 * Lifecycle chatter (task/run bookkeeping, reminder subagents) is ignored;
 * tool activity is mapped tolerantly by payload shape, since the envelope
 * vocabulary for tools is only observable against the live provider.
 *
 * Resume: the adapter owns a stable Muse session UUID per Jinn session
 * (returned as EngineResult.sessionId, persisted by the gateway as the
 * engine-native id). Re-running `exec` with the same `--session-id`
 * continues that conversation (probe-verified). A non-UUID resume id (e.g.
 * a session created before this adapter existed) starts fresh rather than
 * failing argv validation.
 *
 * Posture: `--approval-mode never --disable-sandbox` is the muse equivalent
 * of Claude's `--dangerously-skip-permissions` in this gateway — engines run
 * ungated and the container/mount list is the boundary. Muse's own OS
 * sandbox also cannot be assumed inside the slim runtime image.
 *
 * Auth is the operator's `muse login` (or META_API_KEY in the gateway
 * env); the adapter never touches credentials.
 */
export class MuseEngine implements InterruptibleEngine {
  name = "muse" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Muse process for session ${sessionId}`);
    try {
      live.rl.close();
    } catch {
      /* ignore */
    }
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
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
    const trackingId = opts.sessionId || `muse-${Date.now()}`;
    // Resume continues the same Muse conversation; anything that is not a
    // UUID cannot be a native id this adapter minted, so start fresh.
    const museSessionId = opts.resumeSessionId && UUID_RE.test(opts.resumeSessionId)
      ? opts.resumeSessionId
      : crypto.randomUUID();

    let staged: { promptDir: string; promptFile: string };
    try {
      staged = stagePromptFile(trackingId, prepareTurnPrompt(opts));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`MuseEngine failed to stage the prompt for session ${trackingId}: ${message}`);
      return { sessionId: museSessionId, result: "", error: `Muse engine could not stage the prompt: ${message}` };
    }

    const mcp = buildMuseMcpArgs(opts.resolvedMcp, trackingId);
    const bin = resolveBin("muse", opts.bin);
    const args = buildExecArgs(opts, staged.promptFile, museSessionId, mcp.args);
    logger.info(startLogLine(bin, opts, mcp.attachedNames));

    const env = { ...this.buildCleanEnv(trackingId), ...museJinnSessionEnv(opts.resolvedMcp) };
    return this.spawnTurn({
      bin,
      args,
      cwd: opts.cwd,
      env,
      trackingId,
      museSessionId,
      promptDir: staged.promptDir,
      onStream: opts.onStream || null,
    });
  }

  private spawnTurn(turn: {
    bin: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    trackingId: string;
    museSessionId: string;
    promptDir: string;
    onStream: EngineRunOpts["onStream"] | null;
  }): Promise<EngineResult> {
    const { bin, args, cwd, env, trackingId, museSessionId, promptDir, onStream } = turn;
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      // No stdin protocol: close it so a muse build that probes stdin cannot wedge.
      proc.stdin.end();
      const live: LiveProcess = {
        proc,
        rl: readline.createInterface({ input: proc.stdout, terminal: false }),
        terminationReason: null,
        resultText: "",
        turnError: null,
        stderr: "",
        settled: false,
        resolve,
        sessionIdOut: museSessionId,
        promptDir,
      };
      this.liveProcesses.set(trackingId, live);
      this.armHardTimeout(trackingId, live);
      this.wireProcess(live, trackingId, onStream, reject);
    });
  }

  private wireProcess(
    live: LiveProcess,
    trackingId: string,
    onStream: EngineRunOpts["onStream"] | null,
    reject: (err: Error) => void,
  ): void {
    live.rl.on("line", (line) => {
      const envelope = parseEnvelope(line);
      if (envelope) this.handleEnvelope(live, envelope, onStream);
    });
    live.proc.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      live.stderr = (live.stderr + chunk).slice(-STDERR_MAX);
      for (const l of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[muse stderr] ${l}`);
    });
    live.proc.on("close", (code) => this.settle(trackingId, code));
    live.proc.on("error", (err) => {
      if (live.settled) return;
      live.settled = true;
      this.cleanup(live);
      this.liveProcesses.delete(trackingId);
      reject(new Error(`Failed to spawn Muse CLI: ${err.message}`));
    });
  }

  private armHardTimeout(trackingId: string, live: LiveProcess): void {
    live.hardTimeout = setTimeout(() => {
      if (live.settled) return;
      live.terminationReason = "Muse turn timed out";
      logger.warn(`Muse turn timed out for session ${trackingId}; terminating process`);
      this.signalProcess(live.proc, "SIGTERM");
      setTimeout(() => {
        if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
      }, 2000).unref?.();
    }, TURN_TIMEOUT_MS);
    live.hardTimeout.unref?.();
  }

  /**
   * Map one MSP session-event envelope onto accumulated text / stream deltas.
   * Text (`run.output.delta`) is the only load-bearing mapping; everything
   * else is best-effort UI. Unknown envelopes are ignored, never fatal.
   */
  private handleEnvelope(
    live: LiveProcess,
    envelope: Record<string, unknown>,
    onStream: EngineRunOpts["onStream"] | null,
  ): void {
    const payloadType = typeof envelope.payload_type === "string" ? envelope.payload_type : "";
    const payload = payloadOf(envelope);
    const kind = typeof payload.kind === "string" ? payload.kind : "";

    if (payloadType === "run.output.delta") {
      applyOutputDelta(live, payload, onStream);
      return;
    }
    if (payloadType.includes("tool") || kind.includes("tool")) {
      if (onStream) onStream(toolDelta(payload, payloadType, kind));
      return;
    }
    // Failure bookkeeping: capture the message, but settle() still prefers a
    // non-empty answer — a failed reminder subagent must not fail the turn.
    if (isFailureEnvelope(payloadType, kind)) noteFailure(live, payload);
  }

  /** Resolve a live run exactly once, mirroring Pi's close semantics. */
  private settle(trackingId: string, code: number | null): void {
    const live = this.liveProcesses.get(trackingId);
    if (!live || live.settled) return;
    live.settled = true;
    this.cleanup(live);
    try {
      live.rl.close();
    } catch {
      /* ignore */
    }
    if (live.proc.exitCode === null) {
      try {
        live.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.liveProcesses.delete(trackingId);
    live.resolve(settledResult(live, code));
  }

  private cleanup(live: LiveProcess): void {
    if (live.hardTimeout) clearTimeout(live.hardTimeout);
    live.hardTimeout = undefined;
    if (!live.promptDir) return;
    try {
      fs.rmSync(live.promptDir, { recursive: true, force: true });
    } catch {
      /* best effort temp cleanup */
    }
    live.promptDir = undefined;
  }

  private buildCleanEnv(sessionId?: string): Record<string, string> {
    const cleanEnv = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    if (sessionId) cleanEnv.JINN_SESSION_ID = sessionId;
    return cleanEnv;
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
      logger.debug(`Failed to send ${signal} to Muse process: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function prepareTurnPrompt(opts: EngineRunOpts): string {
  let prompt = opts.prompt;
  if (opts.systemPrompt && !opts.resumeSessionId) {
    prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
  }
  if (opts.attachments?.length) {
    prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
  }
  return prompt;
}

/** The prompt rides a file, never argv: no size/dash/quoting hazards, and the
 *  platform-context preamble stays out of the process table. */
function stagePromptFile(trackingId: string, prompt: string): { promptDir: string; promptFile: string } {
  const promptDir = path.join(JINN_HOME, "tmp", "muse", trackingId.replace(/[^A-Za-z0-9_.-]/g, "_"));
  const promptFile = path.join(promptDir, "prompt.txt");
  fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  try {
    fs.chmodSync(promptFile, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return { promptDir, promptFile };
}

function buildExecArgs(opts: EngineRunOpts, promptFile: string, museSessionId: string, mcpArgs: string[]): string[] {
  const args: string[] = [
    "exec",
    "--json",
    "--prompt-file", promptFile,
    "--session-id", museSessionId,
    "--workspace", opts.cwd,
    "--trust-workspace",
    "--approval-mode", "never",
    "--disable-sandbox",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effortLevel && opts.effortLevel !== "default") args.push("--reasoning-effort", opts.effortLevel);
  args.push(...mcpArgs);
  if (opts.cliFlags?.length) args.push(...opts.cliFlags);
  return args;
}

function startLogLine(bin: string, opts: EngineRunOpts, attachedNames: string[]): string {
  const effort = opts.effortLevel && opts.effortLevel !== "default" ? ` --reasoning-effort ${opts.effortLevel}` : "";
  const mcp = attachedNames.length ? ` (mcp: ${attachedNames.join(",")})` : "";
  return `Muse engine starting: ${bin} exec --model ${opts.model ?? "(default)"}${effort}${mcp} (resume: ${opts.resumeSessionId || "none"})`;
}

function parseEnvelope(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    logger.debug(`[muse stream] unparseable line: ${trimmed.slice(0, 100)}`);
    return null;
  }
}

function payloadOf(envelope: Record<string, unknown>): Record<string, unknown> {
  const payload = envelope.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function applyOutputDelta(live: LiveProcess, payload: Record<string, unknown>, onStream: EngineRunOpts["onStream"] | null): void {
  if (typeof payload.text !== "string" || !payload.text) return;
  live.resultText += payload.text;
  if (onStream) onStream({ type: "text", content: payload.text });
}

function noteFailure(live: LiveProcess, payload: Record<string, unknown>): void {
  const message = firstString(payload, ["message", "error", "text"]);
  if (message) live.turnError = message;
}

function isFailureEnvelope(payloadType: string, kind: string): boolean {
  return payloadType.includes("error") || payloadType.includes("failed") || kind.endsWith("_failed") || kind === "failed";
}

/** Pi's settle precedence: interruption > non-empty answer > captured error. */
function settledResult(live: LiveProcess, code: number | null): EngineResult {
  if (live.terminationReason) {
    return { sessionId: live.sessionIdOut, result: "", error: live.terminationReason };
  }
  if (live.resultText.trim()) {
    return { sessionId: live.sessionIdOut, result: live.resultText, error: undefined };
  }
  const error = live.turnError
    || (code === 0
      ? "Muse process exited successfully without a final assistant response"
      : `Muse process exited with code ${code}: ${live.stderr.slice(0, 500)}`);
  logger.error(error);
  return { sessionId: live.sessionIdOut, result: live.resultText, error };
}

function toolDelta(payload: Record<string, unknown>, payloadType: string, kind: string): StreamDelta {
  return isToolResult(payload, payloadType, kind) ? toolResultDelta(payload, kind) : toolUseDelta(payload);
}

function isToolResult(payload: Record<string, unknown>, payloadType: string, kind: string): boolean {
  if (payloadType.includes("result") || payloadType.includes("receipt")) return true;
  if (kind.includes("result") || kind.includes("completed")) return true;
  return firstString(payload, ["output", "result_text", "text"]) !== undefined;
}

function toolResultDelta(payload: Record<string, unknown>, kind: string): StreamDelta {
  const rawResult = payload.result ?? payload.output ?? firstString(payload, ["result_text", "text"]) ?? "";
  const text = typeof rawResult === "string" ? rawResult : safeStringify(rawResult);
  const isError = payload.is_error === true || payload.isError === true || kind.includes("failed");
  const activityReceiptId = extractActivityReceiptId(text, { isError });
  const toolId = firstString(payload, ["tool_id", "toolId", "call_id", "id", "task_id"]);
  return {
    type: "tool_result",
    content: text.slice(0, 500),
    toolName: toolNameOf(payload),
    ...(toolId ? { toolId } : {}),
    ...(activityReceiptId ? { activityReceiptId } : {}),
  };
}

function toolUseDelta(payload: Record<string, unknown>): StreamDelta {
  const toolName = toolNameOf(payload);
  const input = payload.input ?? payload.arguments ?? payload.args;
  const detail = input && typeof input === "object"
    ? firstString(input as Record<string, unknown>, ["command", "path", "file_path", "description"])
    : undefined;
  const toolId = firstString(payload, ["tool_id", "toolId", "call_id", "id", "task_id"]);
  return {
    type: "tool_use",
    content: detail ? `${toolName}: ${detail}` : `Running ${toolName}`,
    toolName,
    ...(toolId ? { toolId } : {}),
  };
}

function toolNameOf(payload: Record<string, unknown>): string {
  return firstString(payload, ["tool_name", "toolName", "name", "operation"]) || "tool";
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

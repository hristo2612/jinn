import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
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
    const trackingId = opts.sessionId || `muse-${Date.now()}`;
    // Resume continues the same Muse conversation; anything that is not a
    // UUID cannot be a native id this adapter minted, so start fresh.
    const museSessionId = opts.resumeSessionId && UUID_RE.test(opts.resumeSessionId)
      ? opts.resumeSessionId
      : crypto.randomUUID();

    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = resolveBin("muse", opts.bin);

    // The prompt rides a file, never argv: no size/dash/quoting hazards, and
    // the platform-context preamble stays out of the process table.
    const promptDir = path.join(JINN_HOME, "tmp", "muse", trackingId.replace(/[^A-Za-z0-9_.-]/g, "_"));
    const promptFile = path.join(promptDir, "prompt.txt");
    try {
      fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
      try {
        fs.chmodSync(promptFile, 0o600);
      } catch {
        /* best effort on platforms without chmod */
      }
    } catch (err) {
      logger.error(`MuseEngine failed to write prompt file ${promptFile}: ${err instanceof Error ? err.message : err}`);
      return { sessionId: museSessionId, result: "", error: `Muse engine could not stage the prompt: ${err instanceof Error ? err.message : String(err)}` };
    }

    const mcp = buildMuseMcpArgs(opts.resolvedMcp, trackingId);
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
    if (opts.effortLevel && opts.effortLevel !== "default") {
      args.push("--reasoning-effort", opts.effortLevel);
    }
    args.push(...mcp.args);
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);

    logger.info(
      `Muse engine starting: ${bin} exec --model ${opts.model ?? "(default)"}` +
        `${opts.effortLevel && opts.effortLevel !== "default" ? ` --reasoning-effort ${opts.effortLevel}` : ""}` +
        `${mcp.attachedNames.length ? ` (mcp: ${mcp.attachedNames.join(",")})` : ""}` +
        ` (resume: ${opts.resumeSessionId || "none"})`,
    );

    const cleanEnv = { ...this.buildCleanEnv(trackingId), ...museJinnSessionEnv(opts.resolvedMcp) };

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      // No stdin protocol: close it so a muse build that probes stdin cannot wedge.
      proc.stdin.end();

      const rl = readline.createInterface({ input: proc.stdout, terminal: false });

      const live: LiveProcess = {
        proc,
        rl,
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
      live.hardTimeout = setTimeout(() => {
        const l = this.liveProcesses.get(trackingId);
        if (!l || l.settled) return;
        l.terminationReason = "Muse turn timed out";
        logger.warn(`Muse turn timed out for session ${trackingId}; terminating process`);
        this.signalProcess(l.proc, "SIGTERM");
        setTimeout(() => {
          if (l.proc.exitCode === null) this.signalProcess(l.proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      live.hardTimeout.unref?.();

      const onStream = opts.onStream || null;

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          logger.debug(`[muse stream] unparseable line: ${trimmed.slice(0, 100)}`);
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        this.handleEnvelope(live, parsed, onStream);
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        live.stderr = (live.stderr + chunk).slice(-STDERR_MAX);
        for (const l of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[muse stderr] ${l}`);
      });

      proc.on("close", (code) => this.settle(trackingId, code));

      proc.on("error", (err) => {
        const l = this.liveProcesses.get(trackingId);
        if (!l || l.settled) return;
        l.settled = true;
        this.cleanup(l);
        this.liveProcesses.delete(trackingId);
        reject(new Error(`Failed to spawn Muse CLI: ${err.message}`));
      });
    });
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
    const payload = envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
      ? envelope.payload as Record<string, unknown>
      : {};
    const kind = typeof payload.kind === "string" ? payload.kind : "";

    if (payloadType === "run.output.delta") {
      const text = payload.text;
      if (typeof text === "string" && text) {
        live.resultText += text;
        if (onStream) onStream({ type: "text", content: text });
      }
      return;
    }

    if (payloadType.includes("tool") || kind.includes("tool")) {
      this.handleToolEnvelope(payload, payloadType, kind, onStream);
      return;
    }

    // Failure bookkeeping: capture the message, but settle() still prefers a
    // non-empty answer — a failed reminder subagent must not fail the turn.
    if (payloadType.includes("error") || payloadType.includes("failed") || kind.endsWith("_failed") || kind === "failed") {
      const message = firstString(payload, ["message", "error", "text"]);
      if (message) live.turnError = message;
    }
  }

  private handleToolEnvelope(
    payload: Record<string, unknown>,
    payloadType: string,
    kind: string,
    onStream: EngineRunOpts["onStream"] | null,
  ): void {
    if (!onStream) return;
    const toolName = firstString(payload, ["tool_name", "toolName", "name", "operation"]) || "tool";
    const toolId = firstString(payload, ["tool_id", "toolId", "call_id", "id", "task_id"]);
    const output = firstString(payload, ["output", "result_text", "text"]);
    const isResult = payloadType.includes("result") || payloadType.includes("receipt")
      || kind.includes("result") || kind.includes("completed") || output !== undefined;

    if (isResult) {
      const rawResult = payload.result ?? payload.output ?? output ?? "";
      const text = typeof rawResult === "string" ? rawResult : safeStringify(rawResult);
      const isError = payload.is_error === true || payload.isError === true || kind.includes("failed");
      const activityReceiptId = extractActivityReceiptId(text, { isError });
      onStream({
        type: "tool_result",
        content: text.slice(0, 500),
        toolName,
        ...(toolId ? { toolId } : {}),
        ...(activityReceiptId ? { activityReceiptId } : {}),
      });
      return;
    }

    const input = payload.input ?? payload.arguments ?? payload.args;
    const detail = input && typeof input === "object"
      ? firstString(input as Record<string, unknown>, ["command", "path", "file_path", "description"])
      : undefined;
    onStream({
      type: "tool_use",
      content: detail ? `${toolName}: ${detail}` : `Running ${toolName}`,
      toolName,
      ...(toolId ? { toolId } : {}),
    });
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

    const result = live.resultText;

    if (live.terminationReason) {
      live.resolve({ sessionId: live.sessionIdOut, result: "", error: live.terminationReason });
      return;
    }
    // A non-empty answer means the turn succeeded even if a benign error
    // event also appeared — don't surface it as a failure.
    if (result.trim()) {
      live.resolve({ sessionId: live.sessionIdOut, result, error: undefined });
      return;
    }

    const errMsg = live.turnError
      || (code === 0
        ? "Muse process exited successfully without a final assistant response"
        : `Muse process exited with code ${code}: ${live.stderr.slice(0, 500)}`);
    logger.error(errMsg);
    live.resolve({ sessionId: live.sessionIdOut, result, error: errMsg });
  }

  private cleanup(live: LiveProcess): void {
    if (live.hardTimeout) clearTimeout(live.hardTimeout);
    live.hardTimeout = undefined;
    if (live.promptDir) {
      try {
        fs.rmSync(live.promptDir, { recursive: true, force: true });
      } catch {
        /* best effort temp cleanup */
      }
      live.promptDir = undefined;
    }
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

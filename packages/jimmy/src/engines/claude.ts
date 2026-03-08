import { spawn, type ChildProcess } from "node:child_process";
import type { BidirectionalEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/** Timeout configuration for bidirectional processes */
export interface BidirectionalTimeouts {
  idleTimeoutMinutes: number;
  hardTimeoutHours: number;
}

/** State for a live bidirectional process */
interface LiveProcess {
  proc: ChildProcess;
  /** Resolves when the current turn completes */
  turnPromise: Promise<EngineResult> | null;
  /** Resolve the current turn */
  resolveTurn: ((result: EngineResult) => void) | null;
  /** Last known engine session ID */
  engineSessionId: string;
  /** Accumulated result text for current turn */
  resultText: string;
  /** Last result message from stream */
  lastResultMsg: Record<string, unknown> | null;
  /** Whether we're inside a tool call */
  inTool: boolean;
  /** Stream callback for current turn */
  onStream: ((delta: StreamDelta) => void) | null;
  /** Clean environment used to spawn */
  cleanEnv: Record<string, string>;
  /** CLI binary path */
  bin: string;
  /** Working directory */
  cwd: string;
  /** Model */
  model?: string;
  /** When the process was spawned */
  spawnedAt: number;
  /** When the last turn completed (null if mid-turn) */
  lastTurnCompletedAt: number | null;
}

export class ClaudeEngine implements BidirectionalEngine {
  name = "claude" as const;
  private liveProcesses = new Map<string, LiveProcess>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private timeouts: BidirectionalTimeouts = { idleTimeoutMinutes: 60, hardTimeoutHours: 24 };

  /**
   * Set timeout configuration and start the sweep loop.
   */
  setTimeouts(timeouts: BidirectionalTimeouts): void {
    this.timeouts = timeouts;
    this.startSweep();
  }

  /**
   * Start the global sweep interval (every 60s) that cleans up idle/expired processes.
   */
  private startSweep(): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
  }

  /**
   * Check all live processes for idle/hard timeout expiry.
   */
  private sweep(): void {
    const now = Date.now();
    const idleMs = this.timeouts.idleTimeoutMinutes * 60 * 1000;
    const hardMs = this.timeouts.hardTimeoutHours * 60 * 60 * 1000;

    for (const [sessionId, live] of this.liveProcesses) {
      if (live.proc.killed || live.proc.exitCode !== null) continue;

      const age = now - live.spawnedAt;
      const isMidTurn = live.resolveTurn !== null;

      // Hard timeout — kills even mid-turn
      if (hardMs > 0 && age >= hardMs) {
        logger.info(`Hard timeout (${this.timeouts.hardTimeoutHours}h) reached for session ${sessionId}, killing process`);
        this.kill(sessionId);
        continue;
      }

      // Idle timeout — only kills when not mid-turn
      if (!isMidTurn && idleMs > 0 && live.lastTurnCompletedAt) {
        const idleTime = now - live.lastTurnCompletedAt;
        if (idleTime >= idleMs) {
          logger.info(`Idle timeout (${this.timeouts.idleTimeoutMinutes}m) reached for session ${sessionId}, killing process`);
          this.kill(sessionId);
        }
      }
    }
  }

  /**
   * Stop the sweep loop (for graceful shutdown).
   */
  stopSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /**
   * Send a follow-up message to a running bidirectional session.
   */
  steer(sessionId: string, message: string): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live || !live.proc.stdin || live.proc.killed) {
      logger.warn(`Cannot steer session ${sessionId}: no live process`);
      return;
    }

    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
      session_id: live.engineSessionId || "default",
      parent_tool_use_id: null,
    });
    live.proc.stdin.write(msg + "\n");
    logger.info(`Steered session ${sessionId} with new message`);
  }

  /**
   * Kill a running engine process (for interrupt).
   */
  kill(sessionId: string): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    logger.info(`Killing bidirectional process for session ${sessionId}`);
    live.proc.kill("SIGTERM");
    // Give it a moment, then force kill
    setTimeout(() => {
      if (!live.proc.killed) {
        live.proc.kill("SIGKILL");
      }
    }, 2000);
  }

  /**
   * Check if a bidirectional process is alive for this session.
   */
  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    if (opts.interactive && opts.sessionId) {
      return this.runBidirectional(opts);
    }
    return this.runOneShot(opts);
  }

  /**
   * Mode A: One-shot — spawns claude -p, waits for result, process exits.
   * Used for cron jobs, child sessions, non-interactive contexts.
   */
  private async runOneShot(opts: EngineRunOpts): Promise<EngineResult> {
    const streaming = !!opts.onStream;
    const args = ["-p", "--output-format", streaming ? "stream-json" : "json", "--verbose"];

    if (streaming) args.push("--include-partial-messages");
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);

    let prompt = opts.prompt;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
    }
    args.push(prompt);

    const bin = opts.bin || "claude";
    logger.info(`Claude engine (one-shot) starting: ${bin} -p --output-format ${streaming ? "stream-json" : "json"} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`);

    const cleanEnv = this.buildCleanEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let lastResultMsg: Record<string, unknown> | null = null;
      let lineCount = 0;
      let inTool = false;

      if (streaming && opts.onStream) {
        const onStream = opts.onStream;
        let lineBuf = "";

        proc.stdout.on("data", (d: Buffer) => {
          const chunk = d.toString();
          stdout += chunk;
          lineBuf += chunk;
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() || "";
          for (const line of lines) {
            const parsed = this.processStreamLine(line, lineCount++, inTool);
            if (parsed) {
              if (parsed.type === "__result") {
                lastResultMsg = parsed.msg;
              } else if (parsed.type === "__tool_start") {
                inTool = true;
                onStream(parsed.delta);
              } else if (parsed.type === "__tool_end") {
                inTool = false;
                onStream(parsed.delta);
              } else {
                onStream(parsed.delta);
              }
            }
          }
        });
      } else {
        proc.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
      }

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[claude stderr] ${line}`);
        }
      });

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        logger.info(`Claude engine (one-shot) exited with code ${code}`);

        if (code === 0) {
          if (streaming && lastResultMsg) {
            resolve(this.extractResult(lastResultMsg, opts.resumeSessionId));
            return;
          }
          try {
            const result = JSON.parse(stdout);
            resolve({
              sessionId: result.session_id,
              result: result.result,
              cost: result.total_cost_usd,
              durationMs: result.duration_ms,
              numTurns: result.num_turns,
            });
          } catch (e) {
            logger.error(`Failed to parse Claude output: ${e}\nstdout: ${stdout.slice(0, 500)}`);
            resolve({
              sessionId: opts.resumeSessionId || "",
              result: stdout || "(unparseable output)",
              error: `Failed to parse Claude output: ${e}`,
            });
          }
        } else {
          const errMsg = `Claude exited with code ${code}: ${stderr.slice(0, 500)}`;
          logger.error(errMsg);
          resolve({
            sessionId: opts.resumeSessionId || "",
            result: "",
            error: errMsg,
          });
        }
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      });
    });
  }

  /**
   * Mode B: Bidirectional — spawns claude with stdin/stdout JSON streams.
   * Process stays alive across turns. Subsequent messages use steer().
   */
  private async runBidirectional(opts: EngineRunOpts): Promise<EngineResult> {
    const sessionId = opts.sessionId!;
    let live = this.liveProcesses.get(sessionId);

    // If we have a live process, send the message as a new turn
    if (live && !live.proc.killed && live.proc.exitCode === null) {
      return this.sendBidirectionalTurn(live, opts);
    }

    // Spawn a new bidirectional process
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);

    const bin = opts.bin || "claude";
    const cleanEnv = this.buildCleanEnv();

    logger.info(`Claude engine (bidirectional) starting: ${bin} --input-format stream-json --output-format stream-json --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`);

    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    live = {
      proc,
      turnPromise: null,
      resolveTurn: null,
      engineSessionId: opts.resumeSessionId || "",
      resultText: "",
      lastResultMsg: null,
      inTool: false,
      onStream: opts.onStream || null,
      cleanEnv,
      bin,
      cwd: opts.cwd,
      model: opts.model,
      spawnedAt: Date.now(),
      lastTurnCompletedAt: null,
    };
    this.liveProcesses.set(sessionId, live);

    // Ensure sweep loop is running
    this.startSweep();

    // Set up stdout parsing
    let lineBuf = "";
    let lineCount = 0;

    proc.stdout!.on("data", (d: Buffer) => {
      const chunk = d.toString();
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() || "";
      for (const line of lines) {
        this.handleBidirectionalLine(sessionId, line, lineCount++);
      }
    });

    proc.stderr!.on("data", (d: Buffer) => {
      for (const line of d.toString().trim().split("\n").filter(Boolean)) {
        logger.debug(`[claude bidir stderr] ${line}`);
      }
    });

    proc.on("close", (code) => {
      logger.info(`Claude engine (bidirectional) exited with code ${code} for session ${sessionId}`);
      const lp = this.liveProcesses.get(sessionId);
      if (lp?.resolveTurn) {
        // Resolve the pending turn with whatever we have
        lp.resolveTurn({
          sessionId: lp.engineSessionId,
          result: lp.resultText || "",
          error: code !== 0 ? `Claude exited with code ${code}` : undefined,
        });
        lp.resolveTurn = null;
      }
      this.liveProcesses.delete(sessionId);
    });

    proc.on("error", (err) => {
      logger.error(`Claude bidirectional process error: ${err.message}`);
      const lp = this.liveProcesses.get(sessionId);
      if (lp?.resolveTurn) {
        lp.resolveTurn({
          sessionId: lp.engineSessionId,
          result: "",
          error: `Failed to spawn Claude CLI: ${err.message}`,
        });
        lp.resolveTurn = null;
      }
      this.liveProcesses.delete(sessionId);
    });

    // Send the first message
    return this.sendBidirectionalTurn(live, opts);
  }

  /**
   * Send a message to a live bidirectional process and wait for the turn to complete.
   */
  private sendBidirectionalTurn(live: LiveProcess, opts: EngineRunOpts): Promise<EngineResult> {
    // Reset turn state
    live.resultText = "";
    live.lastResultMsg = null;
    live.onStream = opts.onStream || null;

    let prompt = opts.prompt;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
    }

    // Write the message to stdin (stream-json format)
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
      session_id: live.engineSessionId || "default",
      parent_tool_use_id: null,
    });
    live.proc.stdin!.write(msg + "\n");

    // Create a promise that resolves when the turn completes
    // No per-turn timeout — the sweep loop handles idle/hard timeouts
    return new Promise<EngineResult>((resolve) => {
      live.resolveTurn = (result) => {
        live.lastTurnCompletedAt = Date.now();
        resolve(result);
      };
    });
  }

  /**
   * Handle a line of output from a bidirectional process.
   */
  private handleBidirectionalLine(sessionId: string, line: string, lineCount: number): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    // Check for system init message to capture engine session ID
    try {
      const raw = JSON.parse(line.trim());
      if (raw.type === "system" && raw.subtype === "init" && raw.session_id) {
        live.engineSessionId = String(raw.session_id);
        logger.info(`Bidirectional session ${sessionId} got engine session ID: ${live.engineSessionId}`);
      }
    } catch { /* ignore parse errors, processStreamLine handles them */ }

    const parsed = this.processStreamLine(line, lineCount, live.inTool);
    if (!parsed) return;

    if (parsed.type === "__result") {
      live.lastResultMsg = parsed.msg;
      live.engineSessionId = String(parsed.msg.session_id || live.engineSessionId);

      // A result message means the turn is complete
      if (live.resolveTurn) {
        const result = this.extractResult(parsed.msg, live.engineSessionId);
        live.resolveTurn(result);
        live.resolveTurn = null;
      }
    } else if (parsed.type === "__tool_start") {
      live.inTool = true;
      if (live.onStream) live.onStream(parsed.delta);
    } else if (parsed.type === "__tool_end") {
      live.inTool = false;
      if (live.onStream) live.onStream(parsed.delta);
    } else {
      if (parsed.delta.type === "text") {
        live.resultText += parsed.delta.content;
      }
      if (live.onStream) live.onStream(parsed.delta);
    }
  }

  /**
   * Parse a single line of stream-json output.
   * Returns null for unparseable or irrelevant lines.
   */
  private processStreamLine(
    line: string,
    lineCount: number,
    inTool: boolean,
  ): { type: "__result"; msg: Record<string, unknown> }
    | { type: "__tool_start"; delta: StreamDelta }
    | { type: "__tool_end"; delta: StreamDelta }
    | { type: "delta"; delta: StreamDelta }
    | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (lineCount <= 5) {
      logger.debug(`[claude stream] line ${lineCount}: ${trimmed.slice(0, 300)}`);
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.debug(`[claude stream] unparseable line: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const msgType = String(msg.type || "");

    if (msgType === "result") {
      return { type: "__result", msg };
    }

    if (msgType === "stream_event") {
      const event = msg.event as Record<string, unknown> | undefined;
      if (!event) return null;
      const eventType = String(event.type || "");

      if (eventType === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const toolName = String(block.name || "unknown");
          const toolId = String(block.id || "");
          return {
            type: "__tool_start",
            delta: { type: "tool_use", content: `Using ${toolName}`, toolName, toolId },
          };
        }
      } else if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!delta) return null;
        if (delta.type === "text_delta" && !inTool) {
          const text = String(delta.text || "");
          if (text) {
            return { type: "delta", delta: { type: "text", content: text } };
          }
        }
      } else if (eventType === "content_block_stop") {
        if (inTool) {
          return { type: "__tool_end", delta: { type: "tool_result", content: "" } };
        }
      }
      return null;
    }

    // System init message — extract session_id (handled by caller)
    if (msgType === "system") return null;

    // AssistantMessage — ignore (text already streamed via stream_event deltas)
    if (msgType === "assistant") return null;

    // Rate limit events and other unknown types — ignore
    return null;
  }

  /**
   * Extract an EngineResult from a result message.
   */
  private extractResult(r: Record<string, unknown>, fallbackSessionId?: string): EngineResult {
    return {
      sessionId: String(r.session_id || fallbackSessionId || ""),
      result: String(r.result || ""),
      cost: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
      numTurns: typeof r.num_turns === "number" ? r.num_turns : undefined,
    };
  }

  /**
   * Build a clean environment without Claude Code nesting vars.
   */
  private buildCleanEnv(): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }
    return cleanEnv;
  }
}

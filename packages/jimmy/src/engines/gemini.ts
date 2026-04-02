import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export class GeminiEngine implements InterruptibleEngine {
  name = "gemini" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Gemini process for session ${sessionId}`);
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

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = opts.bin || "gemini";
    const streaming = !!opts.onStream;
    const args = this.buildArgs(opts, prompt, streaming);

    logger.info(
      `Gemini engine starting: ${bin} --output-format ${streaming ? "stream-json" : "json"} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`,
    );

    const cleanEnv = this.buildCleanEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const sessionId = opts.sessionId || `gemini-${Date.now()}`;
      this.liveProcesses.set(sessionId, {
        proc,
        terminationReason: null,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let geminiSessionId = "";
      let resultText = "";
      let numTurns = 0;
      let lineBuf = "";
      const onStream = opts.onStream || null;
      const STDERR_MAX = 10 * 1024;

      proc.stdout.on("data", (d: Buffer) => {
        const chunk = d.toString();

        if (streaming) {
          lineBuf += chunk;
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() || "";
          for (const line of lines) {
            const parsed = this.processStreamLine(line);
            if (!parsed) continue;

            switch (parsed.type) {
              case "session_id":
                geminiSessionId = parsed.sessionId;
                logger.info(`Gemini session got session ID: ${geminiSessionId}`);
                break;
              case "text":
                resultText += parsed.delta.content;
                if (onStream) onStream(parsed.delta);
                break;
              case "tool_start":
                if (onStream) onStream(parsed.delta);
                break;
              case "tool_end":
                if (onStream) onStream(parsed.delta);
                break;
              case "error":
                if (onStream) onStream({ type: "error", content: parsed.message });
                break;
              case "turn_complete":
                numTurns++;
                break;
            }
          }
        } else {
          stdout += chunk;
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        if (stderr.length > STDERR_MAX) {
          stderr = stderr.slice(stderr.length - STDERR_MAX);
        }
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[gemini stderr] ${line}`);
        }
      });

      proc.stdin.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;

        const terminationReason = this.liveProcesses.get(sessionId)?.terminationReason ?? null;
        this.liveProcesses.delete(sessionId);

        // Finalize any remaining buffered line
        if (streaming && lineBuf.trim()) {
          const parsed = this.processStreamLine(lineBuf);
          if (parsed) {
            switch (parsed.type) {
              case "session_id":
                geminiSessionId = parsed.sessionId;
                break;
              case "text":
                resultText += parsed.delta.content;
                break;
              case "turn_complete":
                numTurns++;
                break;
            }
          }
        }

        logger.info(`Gemini engine exited with code ${code} (session: ${geminiSessionId || "none"}, turns: ${numTurns})`);

        if (terminationReason) {
          resolve({
            sessionId: geminiSessionId || opts.resumeSessionId || "",
            result: resultText,
            error: terminationReason,
            numTurns: numTurns || undefined,
          });
          return;
        }

        if (!streaming && code === 0) {
          try {
            const parsed = this.parseJsonOutput(stdout, opts.resumeSessionId);
            resolve(parsed);
            return;
          } catch (err) {
            logger.error(`Failed to parse Gemini JSON output: ${err}\nstdout: ${stdout.slice(0, 500)}`);
            resolve({
              sessionId: opts.resumeSessionId || "",
              result: stdout || "(unparseable output)",
              error: `Failed to parse Gemini output: ${err}`,
            });
            return;
          }
        }

        if (code === 0 || geminiSessionId) {
          resolve({
            sessionId: geminiSessionId || opts.resumeSessionId || "",
            result: resultText,
            error: undefined,
            numTurns: numTurns || undefined,
          });
          return;
        }

        const errMsg = `Gemini exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        if (onStream) onStream({ type: "error", content: errMsg });
        resolve({
          sessionId: geminiSessionId || opts.resumeSessionId || "",
          result: resultText,
          error: errMsg,
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        this.liveProcesses.delete(sessionId);
        const errMsg = `Failed to spawn Gemini CLI: ${err.message}`;
        logger.error(errMsg);
        opts.onStream?.({ type: "error", content: errMsg });
        reject(new Error(errMsg));
      });
    });
  }

  buildArgs(opts: EngineRunOpts, prompt: string, streaming: boolean): string[] {
    const args = ["--output-format", streaming ? "stream-json" : "json", "--yolo"];

    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);
    args.push(prompt);

    return args;
  }

  processStreamLine(
    line: string,
  ):
    | { type: "session_id"; sessionId: string }
    | { type: "text"; delta: StreamDelta }
    | { type: "tool_start"; delta: StreamDelta }
    | { type: "tool_end"; delta: StreamDelta }
    | { type: "error"; message: string }
    | { type: "turn_complete" }
    | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.debug(`[gemini stream] unparseable line: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const msgType = String(msg.type || "");

    // Session started — extract session ID
    if (msgType === "session.start" || msgType === "session.started") {
      const sid = String(msg.session_id || msg.sessionId || "");
      if (sid) return { type: "session_id", sessionId: sid };
      return null;
    }

    // Text output
    if (msgType === "text" || msgType === "content.text" || msgType === "text_delta") {
      const text = String(msg.text || msg.content || msg.delta || "");
      if (text) return { type: "text", delta: { type: "text", content: text } };
      return null;
    }

    // Message output
    if (msgType === "message" && msg.delta === true && msg.role === "assistant") {
      const text = String(msg.content || "");
      if (text) return { type: "text", delta: { type: "text", content: text } };
      return null;
    }

    // Tool use start
    if (msgType === "tool.start" || msgType === "tool_use" || msgType === "function_call") {
      const toolName = String(msg.name || msg.tool_name || msg.toolName || "unknown");
      const toolId = String(msg.id || msg.tool_id || msg.toolId || "");
      return {
        type: "tool_start",
        delta: { type: "tool_use", content: `Using ${toolName}`, toolName, toolId },
      };
    }

    // Tool use end / result
    if (msgType === "tool.end" || msgType === "tool_result" || msgType === "function_response") {
      const content = String(msg.output || msg.result || msg.content || "");
      return { type: "tool_end", delta: { type: "tool_result", content } };
    }

    // Turn completed
    if (msgType === "turn.complete" || msgType === "turn.completed") {
      return { type: "turn_complete" };
    }

    // Error
    if (msgType === "error") {
      return { type: "error", message: String(msg.message || msg.error || "Unknown error") };
    }

    // Result event (final output)
    if (msgType === "result") {
      const text = String(msg.result || msg.text || msg.content || "");
      if (text) return { type: "text", delta: { type: "text", content: text } };
      return null;
    }

    logger.debug(`[gemini stream] unhandled event type: ${msgType}`);
    return null;
  }

  private parseJsonOutput(stdout: string, fallbackSessionId?: string): EngineResult {
    const parsed = JSON.parse(stdout) as unknown;

    if (Array.isArray(parsed)) {
      // Look for a result event in the array
      const resultEvent = [...parsed].reverse().find(
        (e): e is Record<string, unknown> => !!e && typeof e === "object" && (e as Record<string, unknown>).type === "result",
      );
      if (resultEvent) {
        return {
          sessionId: String(resultEvent.session_id || resultEvent.sessionId || fallbackSessionId || ""),
          result: String(resultEvent.result || resultEvent.text || ""),
          cost: typeof resultEvent.cost === "number" ? resultEvent.cost : undefined,
          durationMs: typeof resultEvent.duration_ms === "number" ? resultEvent.duration_ms : undefined,
          numTurns: typeof resultEvent.num_turns === "number" ? resultEvent.num_turns : undefined,
        };
      }
      // Fall back to last text event
      const lastText = [...parsed].reverse().find(
        (e): e is Record<string, unknown> =>
          !!e && typeof e === "object" &&
          ((e as Record<string, unknown>).type === "text" || (e as Record<string, unknown>).type === "content.text"),
      );
      return {
        sessionId: fallbackSessionId || "",
        result: lastText ? String(lastText.text || lastText.content || "") : "",
      };
    }

    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        sessionId: String(obj.session_id || obj.sessionId || fallbackSessionId || ""),
        result: String(obj.result || obj.text || obj.content || ""),
        cost: typeof obj.cost === "number" ? obj.cost : undefined,
        durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : undefined,
        numTurns: typeof obj.num_turns === "number" ? obj.num_turns : undefined,
      };
    }

    return {
      sessionId: fallbackSessionId || "",
      result: String(parsed),
    };
  }

  private buildCleanEnv(): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }
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
      logger.debug(`Failed to send ${signal} to Gemini process: ${err instanceof Error ? err.message : err}`);
    }
  }
}

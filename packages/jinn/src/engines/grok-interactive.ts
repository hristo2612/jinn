import fs from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import { tailTranscriptLines, type TranscriptTailer } from "./transcript-tailer.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtySnapshotSubscription, PtyViewEngine } from "./pty-view-engine.js";
import {
  GROK_SESSIONS_DIR,
  grokCliFlags,
  parseGrokJsonLine,
  type GrokParsedLine,
} from "./grok.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const DONE_DEBOUNCE_MS = 60_000;
const TAIL_POLL_MS = 250;
const DISCOVER_POLL_MS = 200;
const DISCOVER_TIMEOUT_MS = 90 * 1000;
const PROMPT_READY_SUBMIT_DELAY_MS = 100;
const PROMPT_SUBMIT_FALLBACK_MS = 2500;
const CURSOR_POSITION_RESPONSE = "\x1b[1;1R";

interface ActiveTurn {
  interrupt: (reason: string) => void;
  tailer?: TranscriptTailer;
  discover?: { stop: () => void };
  tuiOutput?: { dispose: () => void };
  doneTimer?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  boundProc?: pty.IPty;
}

function pasteAndSubmit(proc: pty.IPty, text: string): void {
  const payload = neutralizeForPaste(text);
  // Grok's TUI line editor does not currently accept Codex/Claude-style
  // bracketed-paste submission from node-pty; write a normal terminal line.
  proc.write(`${payload}\r`);
}

function isGrokTuiReady(output: string): boolean {
  return (output.includes("GrokBuild") || output.includes("Grok Build") || output.includes("always-approve")) &&
    output.includes("❯");
}

function isGrokProjectPicker(output: string): boolean {
  return output.includes("Run Grok Build in a project directory");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    // path.join, not `${dir}/${name}`: the latter produced mixed separators on
    // Windows ("C:\...\root/session-x/updates.jsonl"). Windows opens such a path
    // fine, so reads worked, but the string never equalled a path.join-built one
    // — so equality checks, dedupe by path, and path.relative all misbehaved.
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** Transcript file names Grok writes, most authoritative first. Matched on the
 *  basename so the separator never enters the comparison. */
const GROK_TRANSCRIPT_NAMES = ["updates.jsonl", "chat_history.jsonl", "events.jsonl"];

function isGrokTranscriptFile(file: string): boolean {
  return GROK_TRANSCRIPT_NAMES.includes(path.basename(file));
}

function sortGrokTranscriptFiles(files: string[]): string[] {
  const rank = (file: string) => {
    const index = GROK_TRANSCRIPT_NAMES.indexOf(path.basename(file));
    return index === -1 ? GROK_TRANSCRIPT_NAMES.length : index;
  };
  return files.filter(isGrokTranscriptFile).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function listTranscriptFiles(root = GROK_SESSIONS_DIR): Map<string, number> {
  const files = new Map<string, number>();
  for (const file of sortGrokTranscriptFiles(walkFiles(root))) {
    try { files.set(file, fs.statSync(file).mtimeMs); } catch { /* gone */ }
  }
  return files;
}

function parseSessionIdFromFile(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString("utf-8").split("\n")) {
        const parsed = parseGrokJsonLine(line);
        if (parsed?.sessionId) return parsed.sessionId;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseSessionIdFromPath(filePath: string): string | undefined {
  const parent = path.basename(path.dirname(filePath));
  return parent && parent !== "." && parent !== ".." ? parent : undefined;
}

export function findGrokTranscriptById(sessionId: string, root = GROK_SESSIONS_DIR): string | undefined {
  const files = sortGrokTranscriptFiles(walkFiles(root));
  const byName = files.find((file) => file.includes(sessionId));
  if (byName) return byName;
  return files.find((file) => parseSessionIdFromFile(file) === sessionId);
}

export function buildGrokInteractiveArgs(
  opts: EngineRunOpts | PtyIdleSpawnOpts,
  sessionId?: string,
  systemPromptOverride?: string,
): string[] {
  const args = ["--no-auto-update", "--no-alt-screen", "--always-approve"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effortLevel && opts.effortLevel !== "default") args.push("--effort", opts.effortLevel);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (sessionId) args.push("--resume", sessionId);
  if (systemPromptOverride) args.push("--system-prompt-override", systemPromptOverride);
  args.push(...grokCliFlags((opts as EngineRunOpts).cliFlags));
  return args;
}

export function grokTranscriptLineToDeltas(line: string): GrokParsedLine {
  return parseGrokJsonLine(line) ?? { deltas: [] };
}

export class GrokInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "grok" as const;
  private active = new Map<string, ActiveTurn>();
  private streams: PtyStreamManager;
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private spawnParams = new Map<string, { model?: string; effortLevel?: string; sessionId?: string }>();

  constructor(private lifecycle: PtyLifecycleManager) {
    this.streams = new PtyStreamManager("Grok PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    this.lifecycle.onRelease((id) => this.spawnParams.delete(id));
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("GrokInteractiveEngine.run requires opts.sessionId");
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Grok interactive engine: a turn is already running for this session" };
    }

    let grokSessionId = opts.resumeSessionId || undefined;
    let prompt = opts.prompt;
    const systemPromptOverride = opts.systemPrompt && !opts.resumeSessionId ? opts.systemPrompt : undefined;
    if (opts.attachments?.length) prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");

    let latestAnswer = "";
    let lastContextTokens: number | undefined;
    let settled = false;
    let promptSubmitted = false;
    let promptSubmitTimer: NodeJS.Timeout | undefined;
    let resolveFn!: (r: EngineResult) => void;
    const promise = new Promise<EngineResult>((res) => { resolveFn = res; });
    const turn: ActiveTurn = { interrupt: () => {} };

    const cleanup = () => {
      if (promptSubmitTimer) clearTimeout(promptSubmitTimer);
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      if (turn.hardTimeout) clearTimeout(turn.hardTimeout);
      turn.tailer?.stop();
      turn.discover?.stop();
      turn.tuiOutput?.dispose();
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId);
    };
    const schedulePromptSubmit = (delayMs: number) => {
      if (promptSubmitted || settled) return;
      if (promptSubmitTimer) clearTimeout(promptSubmitTimer);
      promptSubmitTimer = setTimeout(() => {
        promptSubmitTimer = undefined;
        if (promptSubmitted || settled) return;
        if (!turn.boundProc) {
          schedulePromptSubmit(250);
          return;
        }
        pasteAndSubmit(turn.boundProc, prompt);
        promptSubmitted = true;
      }, delayMs);
      promptSubmitTimer.unref?.();
    };
    const watchTuiOutput = (proc: pty.IPty) => {
      let buffer = "";
      let acceptedProjectPicker = false;
      turn.tuiOutput = proc.onData((data) => {
        buffer = (buffer + data).slice(-5000);
        if (!promptSubmitted && isGrokTuiReady(buffer)) schedulePromptSubmit(PROMPT_READY_SUBMIT_DELAY_MS);
        if (!acceptedProjectPicker && isGrokProjectPicker(buffer)) {
          acceptedProjectPicker = true;
          const t = setTimeout(() => proc.write("\r"), 100);
          t.unref?.();
        }
      });
    };
    const finish = (r: EngineResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn(r);
    };
    turn.interrupt = (reason: string) =>
      finish({ sessionId: grokSessionId ?? opts.resumeSessionId ?? "", result: latestAnswer, error: reason });

    let warm = this.lifecycle.getWarm(jinnSessionId);
    if (warm && this.spawnParamsChanged(jinnSessionId, opts, grokSessionId)) {
      this.lifecycle.releaseSession(jinnSessionId);
      warm = undefined;
    }

    const scheduleDone = () => {
      if (!latestAnswer.trim()) return;
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      turn.doneTimer = setTimeout(
        () => finish({ sessionId: grokSessionId ?? opts.resumeSessionId ?? "", result: latestAnswer, numTurns: 1, contextTokens: lastContextTokens }),
        DONE_DEBOUNCE_MS,
      );
      turn.doneTimer.unref?.();
    };

    const onParsed = (parsed: GrokParsedLine) => {
      if (settled) return;
      if (parsed.sessionId && !grokSessionId) {
        grokSessionId = parsed.sessionId;
        this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel, sessionId: grokSessionId });
      }
      if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
      for (const delta of parsed.deltas) {
        opts.onStream?.(delta);
        if (delta.type === "text") latestAnswer += delta.content;
        if (delta.type === "text_snapshot") latestAnswer = delta.content;
      }
      if (parsed.doneText) latestAnswer = parsed.doneText;
      if (parsed.error && !latestAnswer.trim()) {
        finish({ sessionId: grokSessionId ?? opts.resumeSessionId ?? "", result: "", error: parsed.error, contextTokens: lastContextTokens });
        return;
      }
      if (parsed.terminal && latestAnswer.trim()) {
        finish({ sessionId: grokSessionId ?? opts.resumeSessionId ?? "", result: latestAnswer, numTurns: 1, contextTokens: lastContextTokens });
      } else if (latestAnswer.trim()) {
        scheduleDone();
      }
    };

    const attachTail = (filePath: string, fromBeginning = false) => {
      if (turn.tailer) return;
      grokSessionId ||= parseSessionIdFromFile(filePath) ?? parseSessionIdFromPath(filePath);
      if (grokSessionId) this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel, sessionId: grokSessionId });
      let offset = 0;
      if (!fromBeginning) {
        try { offset = fs.statSync(filePath).size; } catch { /* not created yet */ }
      }
      turn.tailer = tailTranscriptLines(
        filePath,
        offset,
        (line) => onParsed(grokTranscriptLineToDeltas(line)),
        { pollMs: TAIL_POLL_MS, label: "Grok" },
      );
    };

    this.active.set(jinnSessionId, turn);
    turn.hardTimeout = setTimeout(() => {
      finish({
        sessionId: grokSessionId ?? opts.resumeSessionId ?? "",
        result: latestAnswer,
        error: "Grok interactive turn timed out",
        contextTokens: lastContextTokens,
      });
      this.lifecycle.releaseSession(jinnSessionId);
    }, TURN_TIMEOUT_MS);
    turn.hardTimeout.unref?.();

    const existingTranscript = grokSessionId ? findGrokTranscriptById(grokSessionId) : undefined;
    if (existingTranscript) {
      attachTail(existingTranscript);
    } else {
      const before = listTranscriptFiles();
      const startedAt = Date.now();
      const discover = setInterval(() => {
        const byId = grokSessionId ? findGrokTranscriptById(grokSessionId) : undefined;
        if (byId) {
          clearInterval(discover);
          attachTail(byId, true);
          return;
        }
        const fresh = sortGrokTranscriptFiles([...listTranscriptFiles().keys()]
          .filter((file) => !before.has(file)));
        if (fresh.length === 1) {
          clearInterval(discover);
          attachTail(fresh[0], true);
        } else if (fresh.length > 1) {
          logger.warn(`GrokInteractiveEngine: ambiguous fresh transcripts for ${jinnSessionId}; waiting for a unique candidate`);
          if (Date.now() - startedAt > DISCOVER_TIMEOUT_MS) {
            clearInterval(discover);
            this.lifecycle.releaseSession(jinnSessionId);
            finish({ sessionId: grokSessionId ?? opts.resumeSessionId ?? "", result: "", error: "Grok interactive: multiple fresh transcripts appeared; refusing ambiguous attach" });
          }
        } else if (Date.now() - startedAt > DISCOVER_TIMEOUT_MS) {
          clearInterval(discover);
          this.lifecycle.releaseSession(jinnSessionId);
          finish({ sessionId: grokSessionId ?? opts.resumeSessionId ?? "", result: "", error: "Grok interactive: no session transcript appeared" });
        }
      }, DISCOVER_POLL_MS);
      discover.unref?.();
      turn.discover = { stop: () => clearInterval(discover) };
    }

    if (warm) {
      turn.boundProc = (warm as any)._proc as pty.IPty | undefined;
      this.lifecycle.turnStarted(jinnSessionId);
      if (turn.boundProc) schedulePromptSubmit(0);
      else turn.interrupt("Interrupted: grok PTY unavailable");
    } else {
      const handle = this.spawn(jinnSessionId, opts, grokSessionId, systemPromptOverride);
      turn.boundProc = (handle as any)._proc as pty.IPty | undefined;
      if (turn.boundProc) watchTuiOutput(turn.boundProc);
      this.lifecycle.adopt(jinnSessionId, handle, { turnRunning: true });
      this.lifecycle.turnStarted(jinnSessionId);
      schedulePromptSubmit(PROMPT_SUBMIT_FALLBACK_MS);
    }

    return promise;
  }

  private buildEnv(sessionId?: string): Record<string, string> {
    const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    env.TERM = "xterm-256color";
    if (sessionId) env.JINN_SESSION_ID = sessionId;
    // The TUI blocks prompt execution while inherited MCP compatibility servers
    // initialize. Jinn exposes its own MCP/connectors; keep the Grok PTY clean
    // and deterministic unless the operator explicitly opts back in.
    env.GROK_CLAUDE_MCPS_ENABLED = "false";
    env.GROK_CURSOR_MCPS_ENABLED = "false";
    return env;
  }

  private spawnParamsChanged(jinnSessionId: string, opts: EngineRunOpts | PtyIdleSpawnOpts, sessionId?: string): boolean {
    const prev = this.spawnParams.get(jinnSessionId);
    if (!prev) return false;
    const norm = (v: string | undefined) => v && v !== "default" ? v : undefined;
    return norm(prev.model) !== norm(opts.model) || norm(prev.effortLevel) !== norm(opts.effortLevel) || prev.sessionId !== sessionId;
  }

  private spawn(
    jinnSessionId: string,
    opts: EngineRunOpts | PtyIdleSpawnOpts,
    grokSessionId?: string,
    systemPromptOverride?: string,
  ): PtyHandle {
    const bin = resolveBin("grok", opts.bin);
    const args = buildGrokInteractiveArgs(opts, grokSessionId, systemPromptOverride);
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`GrokInteractiveEngine spawning ${bin} (session: ${grokSessionId ?? "new"}, geom: ${geom ? `${geom.cols}x${geom.rows}` : "default"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || JINN_HOME,
      env: this.buildEnv(jinnSessionId),
    });
    this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel, sessionId: grokSessionId });
    return this.wireProcToStream(jinnSessionId, proc);
  }

  private wireProcToStream(jinnSessionId: string, proc: pty.IPty): PtyHandle {
    const handle = createPtyHandle(proc);
    proc.onData((data) => {
      if (data.includes("\x1b[6n")) proc.write(CURSOR_POSITION_RESPONSE);
    });
    this.streams.attach(jinnSessionId, proc);
    proc.onExit((event) => {
      const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(jinnSessionId, event ?? { exitCode: 0, signal: 0 });
        this.lifecycle.releaseSession(jinnSessionId);
      }
      const e = this.active.get(jinnSessionId);
      if (e && e.boundProc === proc) e.interrupt("Interrupted: grok process exited");
    });
    return handle;
  }

  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.active.has(jinnSessionId)) return;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, jinnSessionId, { cols: opts.cols, rows: opts.rows });
    const grokSessionId = opts.engineSessionId || undefined;
    if (this.lifecycle.getWarm(jinnSessionId) && !this.spawnParamsChanged(jinnSessionId, opts, grokSessionId)) return;
    if (this.lifecycle.getWarm(jinnSessionId)) this.lifecycle.releaseSession(jinnSessionId);
    const handle = this.spawn(jinnSessionId, opts, grokSessionId);
    this.lifecycle.adopt(jinnSessionId, handle);
  }

  subscribeWithSnapshot(sessionId: string, cb: (data: Buffer) => void, onControl?: (event: PtyControlEvent) => void): PtySnapshotSubscription {
    return this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.kill(sessionId, "Interrupted: terminal restart requested");
    this.ensureIdleSpawn(sessionId, opts);
  }

  writeStdin(sessionId: string, text: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    this.streams.resize(sessionId, cols, rows);
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    try { proc?.resize(cols, rows); } catch { /* gone */ }
  }

  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    this.active.get(sessionId)?.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload). Sessions with an in-flight turn
   *  (`this.active`) are skipped so the active turn is never interrupted. */
  killIdle(): void {
    this.lifecycle.releaseIdle((id) => this.active.has(id));
  }

  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}

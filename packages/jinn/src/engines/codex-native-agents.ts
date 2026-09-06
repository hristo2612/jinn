import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { StreamDelta } from "../shared/types.js";
import { findCodexSessionFile } from "./codex-rollout.js";

type Agent = { name: string; status: "running" | "completed" | "error"; detail: string };

function nativeItem(line: string, threadId: string) {
  let record;
  try { record = JSON.parse(line); } catch { return undefined; }
  if (record?.type !== "event_msg") return undefined;
  const payload = record.payload;
  if (payload?.type !== "item_completed" || payload.thread_id !== threadId) return undefined;
  const item = payload.item;
  if (item?.type !== "SubAgentActivity" || typeof item.agent_thread_id !== "string") return undefined;
  return item as { agent_thread_id: string; agent_path?: string; kind: string };
}

/** Codex's SubAgentActivity rollout items are omitted from some exec JSON
 * streams. Read only newly appended records from this exact parent thread;
 * inherited transcript history and agent prose cannot declare live work. */
export class CodexNativeAgents {
  private threadId = "";
  private file: string | null = null;
  private offset = 0;
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private agents = new Map<string, Agent>();
  private version = 0;

  constructor(private root: string, resumeId?: string) {
    if (!resumeId) return;
    this.threadId = resumeId;
    this.file = findCodexSessionFile(root, resumeId);
    if (this.file) this.offset = fs.statSync(this.file).size;
  }

  get active(): number {
    return [...this.agents.values()].filter((agent) => agent.status === "running").length;
  }

  bind(threadId: string): void {
    if (this.threadId === threadId) return;
    this.threadId = threadId;
    this.file = null;
    this.offset = 0;
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
  }

  read(): StreamDelta | undefined {
    if (!this.threadId) return;
    this.file ??= findCodexSessionFile(this.root, this.threadId);
    if (!this.file) return;
    return this.readFile(this.file);
  }

  private readFile(file: string): StreamDelta | undefined {
    let fd: number | undefined;
    let changed = false;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (!count) break;
        this.offset += count;
        this.pending += this.decoder.write(buffer.subarray(0, count));
        let newline: number;
        while ((newline = this.pending.indexOf("\n")) >= 0) {
          const line = this.pending.slice(0, newline);
          this.pending = this.pending.slice(newline + 1);
          changed = this.accept(line) || changed;
        }
      }
    } catch { /* A missing or incompletely flushed rollout is not lifecycle evidence. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return changed ? this.delta() : undefined;
  }

  stop(): StreamDelta | undefined {
    if (!this.active) return;
    for (const agent of this.agents.values()) {
      if (agent.status === "running") {
        agent.status = "error";
        agent.detail = "Stopped when the native process exited";
      }
    }
    return this.delta();
  }

  private accept(line: string): boolean {
    const item = nativeItem(line, this.threadId);
    if (!item) return false;
    const id = item.agent_thread_id;
    const name = typeof item.agent_path === "string" ? item.agent_path.split("/").filter(Boolean).at(-1) : "Agent";
    if (item.kind === "started") this.agents.set(id, { name: name || "Agent", status: "running", detail: "Running" });
    else if (item.kind === "completed") this.agents.set(id, { name: name || "Agent", status: "completed", detail: "Completed" });
    // Sending a message to a finished agent does not restart it.
    else return false;
    return true;
  }

  private delta(): StreamDelta {
    return { type: "block", content: "Native Codex agents", block: { op: "put", block: {
      id: "codex-native-agents",
      type: "task-list",
      version: ++this.version,
      sourceEngine: "codex",
      title: "Native Codex agents",
      status: this.active ? "running" : this.agents.size && [...this.agents.values()].some((agent) => agent.status === "error") ? "error" : "completed",
      payload: { kind: "native-agents", items: [...this.agents].map(([id, agent]) => ({
        id, text: `${agent.name}: ${agent.detail}`, status: agent.status,
      })) },
    } } };
  }
}

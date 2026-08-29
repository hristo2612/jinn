/**
 * Shared contract for engines that expose a live PTY to the web dashboard's
 * xterm view (`/ws/pty/:sessionId`). Both the interactive Claude engine and the
 * Antigravity engine implement this, so the WebSocket handler can route by
 * `session.engine` instead of being hardwired to one engine.
 */
import type { RemoteTarget } from "../shared/types.js";

import type { SerializedPtySnapshot } from "./pty-snapshot.js";

/** Structured lifecycle events carried separately from binary PTY deltas. */
export type PtyControlEvent =
  | { type: "restoring" }
  | { type: "reset" }
  | { type: "snapshot"; snapshot: SerializedPtySnapshot }
  | { type: "ready" }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "exited"; exitCode: number; signal: number };

export interface PtyInitialSnapshot {
  snapshot?: SerializedPtySnapshot;
  /** True only when this snapshot represents the currently warm PTY. */
  ready: boolean;
}

export interface PtySnapshotSubscription {
  /** State captured through the exact synchronous subscription boundary. */
  snapshot: Promise<PtyInitialSnapshot>;
  /** Release events produced after the boundary. Call after framing snapshot/ready. */
  start(): void;
  unsubscribe(): void;
}

export interface PtyIdleSpawnOpts extends RemoteTarget {
  /** Engine-side conversation/session id to resume into the idle PTY, if any. */
  engineSessionId?: string;
  cwd?: string;
  model?: string;
  effortLevel?: string;
  bin?: string;
  cols?: number;
  rows?: number;
}

export interface PtyViewEngine {
  hasWarmPty(sessionId: string): boolean;
  ensureIdleSpawn(sessionId: string, opts: PtyIdleSpawnOpts): void;
  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void;
  subscribeWithSnapshot(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription;
  setViewing(sessionId: string, viewing: boolean): void;
  writeStdin(sessionId: string, text: string): void;
  writeRaw(sessionId: string, data: string): void;
  resizePty(sessionId: string, cols: number, rows: number): void;
}

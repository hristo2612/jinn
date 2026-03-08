import type { Engine } from "../shared/types.js";
import { isBidirectionalEngine } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export type QueuedStatus = "queued" | "steered" | "interrupted";

export class SessionQueue {
  private queues = new Map<string, Promise<void>>();
  /** Track which sessions are currently running */
  private running = new Set<string>();

  /**
   * Check if a session is currently running.
   */
  isRunning(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  /**
   * Enqueue a task for a session. Tasks are serialized per session key.
   */
  async enqueue(sessionKey: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const next = prev.then(
      async () => {
        this.running.add(sessionKey);
        try {
          await fn();
        } finally {
          this.running.delete(sessionKey);
        }
      },
      async () => {
        this.running.add(sessionKey);
        try {
          await fn();
        } finally {
          this.running.delete(sessionKey);
        }
      },
    );
    this.queues.set(sessionKey, next);
    return next;
  }

  /**
   * Determine what to do with a mid-turn message:
   * - "steered" if the engine supports bidirectional and the session is alive
   * - "interrupted" if interrupt flag is set
   * - "queued" if one-shot mode (will process after current turn)
   */
  handleMidTurn(
    sessionKey: string,
    engine: Engine,
    sessionId: string,
    message: string,
    interrupt: boolean,
  ): QueuedStatus {
    if (interrupt && isBidirectionalEngine(engine)) {
      engine.kill(sessionId);
      logger.info(`Interrupted session ${sessionId}`);
      return "interrupted";
    }

    if (isBidirectionalEngine(engine) && engine.isAlive(sessionId)) {
      engine.steer(sessionId, message);
      return "steered";
    }

    // One-shot mode — message will be queued
    return "queued";
  }
}

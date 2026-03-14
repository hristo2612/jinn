export class SessionQueue {
  private queues = new Map<string, Promise<void>>();
  /** Track which sessions are currently running */
  private running = new Set<string>();
  /** Track how many tasks exist per session key, including the active one. */
  private pending = new Map<string, number>();
  /** Track which session keys have been cancelled — queued tasks are skipped. */
  private cancelled = new Set<string>();

  /**
   * Check if a session is currently running.
   */
  isRunning(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  getPendingCount(sessionKey: string): number {
    const total = this.pending.get(sessionKey) || 0;
    return this.running.has(sessionKey) ? Math.max(0, total - 1) : total;
  }

  getTransportState(sessionKey: string, status?: "idle" | "running" | "error"): "idle" | "queued" | "running" | "error" {
    if (status === "error") return "error";
    if (this.running.has(sessionKey)) return "running";
    if (this.getPendingCount(sessionKey) > 0) return "queued";
    return status === "running" ? "running" : "idle";
  }

  /**
   * Add a session key to the cancelled set and remove it from pending.
   * Any queued tasks for this key will be skipped when they next execute.
   */
  clearQueue(sessionKey: string): void {
    this.cancelled.add(sessionKey);
    this.pending.delete(sessionKey);
  }

  /**
   * Remove a session key from the cancelled set.
   * Call this before dispatching a new message so subsequent tasks run normally.
   */
  clearCancelled(sessionKey: string): void {
    this.cancelled.delete(sessionKey);
  }

  /**
   * Enqueue a task for a session. Tasks are serialized per session key.
   */
  async enqueue(sessionKey: string, fn: () => Promise<void>): Promise<void> {
    this.pending.set(sessionKey, (this.pending.get(sessionKey) || 0) + 1);
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const next = prev.then(
      async () => {
        this.running.add(sessionKey);
        try {
          if (!this.cancelled.has(sessionKey)) {
            await fn();
          }
        } finally {
          this.running.delete(sessionKey);
          this.decrementPending(sessionKey);
        }
      },
      async () => {
        this.running.add(sessionKey);
        try {
          if (!this.cancelled.has(sessionKey)) {
            await fn();
          }
        } finally {
          this.running.delete(sessionKey);
          this.decrementPending(sessionKey);
        }
      },
    );
    this.queues.set(sessionKey, next);
    void next.finally(() => {
      if (this.queues.get(sessionKey) === next) {
        this.queues.delete(sessionKey);
      }
    });
    return next;
  }

  private decrementPending(sessionKey: string): void {
    const remaining = (this.pending.get(sessionKey) || 1) - 1;
    if (remaining <= 0) {
      this.pending.delete(sessionKey);
      return;
    }
    this.pending.set(sessionKey, remaining);
  }
}

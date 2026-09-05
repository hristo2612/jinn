import { getQueueItem, markQueueItemRunning, markQueueItemCompleted } from "./registry.js";

export class SessionQueue {
  private queues = new Map<string, Promise<void>>();
  /** Track which sessions are currently running */
  private running = new Set<string>();
  /** Track how many tasks exist per session key, including the active one. */
  private pending = new Map<string, number>();
  /** Track which session keys have been cancelled - queued tasks are skipped. */
  private cancelled = new Set<string>();
  /** Track which session keys are paused - queued tasks wait until resumed. */
  private paused = new Set<string>();
  /** Internal causal hold: a callback row owns the head, but waits for its
   * source session's completion backlog to reach a drain boundary. */
  private callbackDrainHeld = new Map<string, Set<string>>();
  /** Resolvers for tasks blocked on a paused session key, woken on resume. */
  private pauseWaiters = new Map<string, Array<() => void>>();
  /** Queue rows this process has already taken responsibility for. */
  private inFlightItems = new Set<string>();

  /**
   * Check if a session is currently running.
   */
  isRunning(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  /**
   * Has this process already accepted `queueItemId` for execution? A row only
   * flips to `running` in the DB when its task actually starts, so one parked
   * behind a long turn still reads `pending` and is indistinguishable from an
   * orphan to a recovery sweep. This is what tells the two apart.
   */
  hasInFlightItem(queueItemId: string): boolean {
    return this.inFlightItems.has(queueItemId);
  }

  getPendingCount(sessionKey: string): number {
    const total = this.pending.get(sessionKey) || 0;
    return this.running.has(sessionKey) ? Math.max(0, total - 1) : total;
  }

  getTransportState(sessionKey: string, status?: "idle" | "running" | "error" | "waiting" | "interrupted"): "idle" | "queued" | "running" | "error" | "interrupted" {
    if (status === "error") return "error";
    if (status === "interrupted") return "interrupted";
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
    this.callbackDrainHeld.delete(sessionKey);
    this.wakePauseWaiters(sessionKey);
  }

  /**
   * Remove a session key from the cancelled set.
   * Call this before dispatching a new message so subsequent tasks run normally.
   */
  clearCancelled(sessionKey: string): void {
    this.cancelled.delete(sessionKey);
  }

  pauseQueue(sessionKey: string): void {
    this.paused.add(sessionKey);
  }

  resumeQueue(sessionKey: string): void {
    this.paused.delete(sessionKey);
    this.wakePauseWaiters(sessionKey);
  }

  private wakePauseWaiters(sessionKey: string): void {
    const waiters = this.pauseWaiters.get(sessionKey);
    if (!waiters) return;
    this.pauseWaiters.delete(sessionKey);
    for (const wake of waiters) wake();
  }

  isPaused(sessionKey: string): boolean {
    return this.paused.has(sessionKey);
  }

  holdForCallbackDrain(sessionKey: string, queueItemId: string): void {
    const held = this.callbackDrainHeld.get(sessionKey) ?? new Set<string>();
    held.add(queueItemId);
    this.callbackDrainHeld.set(sessionKey, held);
  }

  releaseCallbackDrain(sessionKey: string, queueItemId: string): void {
    const held = this.callbackDrainHeld.get(sessionKey);
    held?.delete(queueItemId);
    if (held?.size === 0) this.callbackDrainHeld.delete(sessionKey);
    this.wakePauseWaiters(sessionKey);
  }

  isCallbackDrainHeld(sessionKey: string, queueItemId?: string): boolean {
    const held = this.callbackDrainHeld.get(sessionKey);
    return queueItemId ? held?.has(queueItemId) === true : Boolean(held?.size);
  }

  private async waitUntilRunnable(sessionKey: string, queueItemId?: string): Promise<void> {
    while (this.paused.has(sessionKey) || (
      queueItemId !== undefined && this.isCallbackDrainHeld(sessionKey, queueItemId)
    )) {
      await new Promise<void>(resolve => {
        const waiters = this.pauseWaiters.get(sessionKey) ?? [];
        waiters.push(resolve);
        this.pauseWaiters.set(sessionKey, waiters);
      });
    }
  }

  /**
   * Enqueue a task for a session. Tasks are serialized per session key.
   */
  async enqueue(sessionKey: string, fn: () => Promise<void>, queueItemId?: string, claimed = false): Promise<void> {
    if (queueItemId) this.inFlightItems.add(queueItemId);
    this.pending.set(sessionKey, (this.pending.get(sessionKey) || 0) + 1);
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const runTask = async () => {
      this.running.add(sessionKey);
      let queueItemStarted = false;
      try {
        // Wait while paused — blocks until resumeQueue() wakes us (no polling)
        await this.waitUntilRunnable(sessionKey, queueItemId);
        if (queueItemId) {
          const item = getQueueItem(queueItemId);
          if (!item || (claimed ? item.status !== "running"
            : item.status !== "pending" || !markQueueItemRunning(queueItemId))) return;
          queueItemStarted = true;
        }
        if (!this.cancelled.has(sessionKey)) {
          await fn();
        }
      } finally {
        // Mark the DB row done in finally so an errored/cancelled task can't
        // leave the item stuck as 'running' (getQueueItems returns 'running'
        // rows, so a stuck row would keep the UI badge from draining).
        if (queueItemId) {
          if (queueItemStarted) markQueueItemCompleted(queueItemId);
          this.inFlightItems.delete(queueItemId);
        }
        this.running.delete(sessionKey);
        this.decrementPending(sessionKey);
      }
    };
    const next = prev.then(runTask, runTask);
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

import { randomUUID } from 'node:crypto';
import type { AssistRecord } from '../shared/types.js';

export class AssistRegistry {
  private records = new Map<string, AssistRecord>();
  private resolveHooks: Array<(r: AssistRecord) => void> = [];

  /** Returns an unsubscribe fn — callers MUST call it to avoid hook accumulation. */
  onResolve(hook: (r: AssistRecord) => void): () => void {
    this.resolveHooks.push(hook);
    return () => {
      const i = this.resolveHooks.indexOf(hook);
      if (i >= 0) this.resolveHooks.splice(i, 1);
    };
  }

  create(input: { sessionId: string; reason: string; url?: string }): AssistRecord {
    const rec: AssistRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      reason: input.reason,
      url: input.url,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  get(reqId: string): AssistRecord | undefined {
    return this.records.get(reqId);
  }

  resolve(reqId: string): boolean {
    const rec = this.records.get(reqId);
    if (!rec || rec.status !== 'pending') return false;
    rec.status = 'resolved';
    rec.resolvedAt = Date.now();
    for (const hook of this.resolveHooks) {
      try { hook(rec); } catch { /* teardown best-effort */ }
    }
    return true;
  }

  markTimedOut(reqId: string): boolean {
    const rec = this.records.get(reqId);
    if (!rec || rec.status !== 'pending') return false;
    rec.status = 'timed_out';
    rec.resolvedAt = Date.now();
    for (const hook of this.resolveHooks) {
      try { hook(rec); } catch { /* teardown best-effort */ }
    }
    return true;
  }

  hasActivePending(sessionId: string, reqId: string): boolean {
    const rec = this.records.get(reqId);
    return !!rec && rec.status === 'pending' && rec.sessionId === sessionId;
  }

  /** Flip pending → timed_out for records older than maxAgeMs. Returns the flipped reqIds. */
  sweepTimeouts(now: number, maxAgeMs: number): string[] {
    const flipped: string[] = [];
    for (const rec of this.records.values()) {
      if (rec.status === 'pending' && now - rec.createdAt > maxAgeMs) {
        this.markTimedOut(rec.id);
        flipped.push(rec.id);
      }
    }
    return flipped;
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { AssistRegistry } from '../assist.js';

describe('AssistRegistry', () => {
  let reg: AssistRegistry;
  beforeEach(() => { reg = new AssistRegistry(); });

  it('creates a pending record with a unique id', () => {
    const r = reg.create({ sessionId: 's1', reason: 'captcha', url: 'http://x' });
    expect(r.status).toBe('pending');
    expect(r.sessionId).toBe('s1');
    expect(r.id).toMatch(/.+/);
    expect(reg.get(r.id)).toEqual(r);
  });

  it('resolves a pending record and fires the teardown hook', () => {
    let torndown = '';
    reg.onResolve((rec) => { torndown = rec.id; });
    const r = reg.create({ sessionId: 's1', reason: 'login' });
    const ok = reg.resolve(r.id);
    expect(ok).toBe(true);
    expect(reg.get(r.id)!.status).toBe('resolved');
    expect(torndown).toBe(r.id);
  });

  it('onResolve returns an unsubscribe that removes the hook (no leak)', () => {
    let calls = 0;
    const off = reg.onResolve(() => { calls++; });
    off();
    reg.resolve(reg.create({ sessionId: 's1', reason: 'x' }).id);
    expect(calls).toBe(0);
  });

  it('does not double-resolve', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    expect(reg.resolve(r.id)).toBe(true);
    expect(reg.resolve(r.id)).toBe(false);
  });

  it('marks timed_out only when still pending', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    expect(reg.markTimedOut(r.id)).toBe(true);
    expect(reg.get(r.id)!.status).toBe('timed_out');
    expect(reg.markTimedOut(r.id)).toBe(false);
  });

  it('sweepTimeouts flips stale pending records', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    (reg.get(r.id) as any).createdAt = Date.now() - 11 * 60 * 1000;
    expect(reg.sweepTimeouts(Date.now(), 10 * 60 * 1000)).toContain(r.id);
    expect(reg.get(r.id)!.status).toBe('timed_out');
  });

  it('hasActivePending matches only pending reqId for that session', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    expect(reg.hasActivePending('s1', r.id)).toBe(true);
    expect(reg.hasActivePending('s2', r.id)).toBe(false);
    reg.resolve(r.id);
    expect(reg.hasActivePending('s1', r.id)).toBe(false);
  });
});

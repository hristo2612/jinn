import { describe, expect, it, vi } from 'vitest';

import { routeMemoryTrialHook } from '../hook-adapter.js';
import { MEMORY_TRIAL_POLICY, type MemoryTrialClaims } from '../guardrails.js';

const baseSession = Object.freeze({
  id: 'session-1',
  employee: 'jarvis-fullstack-builder',
  createdAt: '2026-09-01T10:00:00.000Z',
});

function route(overrides: Partial<Parameters<typeof routeMemoryTrialHook>[0]> = {}) {
  return routeMemoryTrialHook({
    enabled: true,
    circuitOpen: false,
    triggers: MEMORY_TRIAL_POLICY.triggers,
    jinnSessionId: baseSession.id,
    hook: { hook_event_name: 'SessionStart' },
    getSession: () => baseSession,
    ...overrides,
  });
}

describe('routeMemoryTrialHook', () => {
  it('allows only hooks whose cwd is inside the configured Jarvis project root', async () => {
    const dispatch = vi.fn(async () => undefined);
    const operationStore = new Set<string>();

    await expect(route({
      hook: { hook_event_name: 'SessionStart', cwd: '/projects/jarvis/packages/app' },
      projectRoot: '/projects/jarvis',
      operationStore,
      dispatch,
    })).resolves.toMatchObject({ routed: true });
    operationStore.clear();
    await expect(route({
      hook: { hook_event_name: 'SessionStart', cwd: '/projects/jinn' },
      projectRoot: '/projects/jarvis',
      operationStore,
      dispatch,
    })).resolves.toMatchObject({ routed: false, reason: 'identity-denied' });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps the runtime default inert without explicit injection', async () => {
    const dispatch = vi.fn(async (_claims: MemoryTrialClaims) => undefined);

    await expect(routeMemoryTrialHook({
      jinnSessionId: baseSession.id,
      hook: { hook_event_name: 'Stop' },
      getSession: () => baseSession,
      dispatch,
    })).resolves.toMatchObject({ routed: false, reason: 'flag-disabled' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('commits operation idempotence only after dispatch succeeds', async () => {
    const operationStore = new Set<string>();
    const dispatched: MemoryTrialClaims[] = [];
    const dispatch = vi.fn(async (claims: MemoryTrialClaims) => {
      dispatched.push(claims);
      if (dispatch.mock.calls.length === 1) throw new Error('transient-dispatch-failure');
    });

    await expect(route({ operationStore, dispatch })).rejects.toThrow('transient-dispatch-failure');
    await expect(route({ operationStore, dispatch })).resolves.toMatchObject({ routed: true });
    await expect(route({ operationStore, dispatch })).resolves.toMatchObject({ routed: false, reason: 'duplicate' });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([
      {
        createdAt: Date.parse(baseSession.createdAt),
        projectId: 'jarvis',
        agentId: 'jarvis-fullstack-builder',
        sessionId: baseSession.id,
        trigger: 'authorized-session-start',
      },
      {
        createdAt: Date.parse(baseSession.createdAt),
        projectId: 'jarvis',
        agentId: 'jarvis-fullstack-builder',
        sessionId: baseSession.id,
        trigger: 'authorized-session-start',
      },
    ]);
  });
});

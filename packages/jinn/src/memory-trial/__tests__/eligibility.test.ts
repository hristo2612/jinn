import { describe, expect, it } from 'vitest';

import { MEMORY_TRIAL_POLICY } from '../guardrails.js';
import { isMemoryTrialEligible } from '../eligibility.js';

const eligible = Object.freeze({
  createdAt: 101,
  projectId: 'jarvis',
  agentId: 'jarvis-director',
  sessionId: 'session-1',
  trigger: 'session-finalized',
});

describe('JAR-31 centralized memory-trial eligibility', () => {
  it('fails closed unless every exact eligibility claim is verifiable', () => {
    expect(isMemoryTrialEligible(eligible)).toBe(true);
    expect(isMemoryTrialEligible({ ...eligible, createdAt: MEMORY_TRIAL_POLICY.activationEpoch })).toBe(false);
    expect(isMemoryTrialEligible({ ...eligible, createdAt: 99 })).toBe(false);
    expect(isMemoryTrialEligible({ ...eligible, projectId: 'other-project' })).toBe(false);

    for (const agentId of [
      'jarvis-director',
      'jarvis-fullstack-builder',
      'jarvis-quality-engineer',
      'jarvis-security-reviewer',
      'knowledge-curator',
    ]) {
      expect(isMemoryTrialEligible({ ...eligible, agentId })).toBe(true);
    }
    expect(isMemoryTrialEligible({ ...eligible, agentId: 'jarvis-product-auditor' })).toBe(false);

    expect(isMemoryTrialEligible({ ...eligible, trigger: 'authorized-session-start' })).toBe(true);
    expect(isMemoryTrialEligible({ ...eligible, trigger: 'session-start' })).toBe(false);

    for (const field of ['projectId', 'agentId', 'sessionId', 'trigger'] as const) {
      expect(isMemoryTrialEligible({ ...eligible, [field]: undefined })).toBe(false);
      expect(isMemoryTrialEligible({ ...eligible, [field]: [eligible[field]] })).toBe(false);
      expect(isMemoryTrialEligible({ ...eligible, [field]: ` ${eligible[field]} ` })).toBe(false);
    }
    expect(isMemoryTrialEligible({ ...eligible, createdAt: undefined })).toBe(false);
  });
});

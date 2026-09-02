/**
 * The pure predicates behind the memory trial: whether a claim is eligible,
 * what its operation id is, and whether it fits the budget.
 *
 * Split out of guardrails.ts, which keeps the policy, the durable control state,
 * the exclusion reasons and MemoryTrialGuard. Nothing here touches disk.
 */
import { MEMORY_TRIAL_POLICY, type MemoryTrialBudgetUsage, type MemoryTrialClaims, type MemoryTrialTrigger } from './guardrails.js';

const FIELD_SEPARATOR = '\u001f';

function isCanonicalClaim(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && value === value.normalize('NFC');
}

function isEligibleCreationTime(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > MEMORY_TRIAL_POLICY.activationEpoch;
}

function isAllowedAgentId(value: unknown): value is MemoryTrialClaims['agentId'] {
  return isCanonicalClaim(value)
    && MEMORY_TRIAL_POLICY.allowedAgentIds.some((agentId) => agentId === value);
}

function isAllowedTrigger(value: unknown): value is MemoryTrialTrigger {
  return MEMORY_TRIAL_POLICY.triggers.some((trigger) => trigger === value);
}

function isClaimsObject(claims: unknown): claims is Partial<MemoryTrialClaims> {
  return Boolean(claims) && typeof claims === 'object' && !Array.isArray(claims);
}

export function isEligibleForMemoryTrial(claims: unknown): claims is MemoryTrialClaims {
  if (!isClaimsObject(claims)) return false;
  return isEligibleCreationTime(claims.createdAt)
    && claims.projectId === MEMORY_TRIAL_POLICY.projectId
    && isAllowedAgentId(claims.agentId)
    && isCanonicalClaim(claims.sessionId)
    && isAllowedTrigger(claims.trigger);
}

export function memoryTrialOperationId(claims: MemoryTrialClaims): string {
  return [
    claims.projectId,
    claims.agentId,
    claims.sessionId,
    claims.trigger,
    MEMORY_TRIAL_POLICY.policyVersion,
  ].join(FIELD_SEPARATOR);
}

export function isWithinMemoryTrialBudget(usage: MemoryTrialBudgetUsage): boolean {
  const limits = MEMORY_TRIAL_POLICY.budgets;
  return Object.values(usage).every((value) => Number.isInteger(value) && value >= 0)
    && usage.sessions <= limits.maxSessions
    && usage.agents <= limits.maxAgents
    && usage.pairs <= limits.maxPairs
    && usage.injectedBytes <= limits.maxInjectedBytesPerSession
    && usage.items <= limits.maxItemsPerSession
    && usage.elapsedMilliseconds <= limits.maxSessionMilliseconds
    && usage.retries <= limits.maxRetries
    && usage.concurrency <= limits.concurrency;
}

export const isWithinMemoryTrialBudgets = isWithinMemoryTrialBudget;

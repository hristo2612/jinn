import type { HookPayload } from '../gateway/hook-registry.js';
import { relative, resolve, sep } from 'node:path';
import { isMemoryTrialEligible } from './eligibility.js';
import {
  MEMORY_TRIAL_POLICY,
  memoryTrialOperationId,
  type MemoryTrialClaims,
  type MemoryTrialTrigger,
} from './guardrails.js';
import { MEMORY_TRIAL_ENABLED } from './preparation.js';

type SessionLookupResult = Readonly<{
  id: string;
  employee: string | null;
  createdAt: string;
}>;

export interface MemoryTrialHookRouteOptions {
  readonly jinnSessionId?: string;
  readonly hook?: HookPayload;
  readonly getSession: (sessionId: string) => SessionLookupResult | undefined;
  readonly dispatch?: (claims: MemoryTrialClaims) => void | string | Promise<void | string | undefined>;
  readonly enabled?: boolean;
  readonly circuitOpen?: boolean;
  readonly activationEpoch?: number;
  readonly triggers?: readonly MemoryTrialTrigger[];
  readonly projectRoot?: string;
  readonly operationStore?: Set<string>;
}

export type MemoryTrialHookRouteResult = Readonly<{
  routed: boolean;
  reason?: string;
  additionalContext?: string;
}>;

const routedOperations = new Set<string>();

function skipped(reason: string): MemoryTrialHookRouteResult {
  return { routed: false, reason };
}

function triggerForHook(hook: HookPayload | undefined): MemoryTrialTrigger | undefined {
  if (hook?.hook_event_name === 'SessionStart') return 'authorized-session-start';
  if (hook?.hook_event_name === 'Stop') return 'session-finalized';
  return undefined;
}

function gateRejection(options: MemoryTrialHookRouteOptions): MemoryTrialHookRouteResult | undefined {
  const enabled = options.enabled ?? MEMORY_TRIAL_ENABLED;
  if (!enabled) return skipped('flag-disabled');
  if (options.circuitOpen ?? true) return skipped('circuit-open');
  if (!options.jinnSessionId) return skipped('session-denied');
  return undefined;
}

function triggerRejection(
  options: MemoryTrialHookRouteOptions,
  trigger: MemoryTrialTrigger | undefined,
): MemoryTrialHookRouteResult | undefined {
  if (trigger === undefined) return skipped('trigger-denied');
  if (!(options.triggers ?? []).includes(trigger)) return skipped('trigger-denied');
  return undefined;
}

function activationEpochRejection(
  options: MemoryTrialHookRouteOptions,
  claims: MemoryTrialClaims,
): MemoryTrialHookRouteResult | undefined {
  const activationEpoch = options.activationEpoch ?? MEMORY_TRIAL_POLICY.activationEpoch;
  if (!Number.isFinite(activationEpoch)) return skipped('epoch-denied');
  if (claims.createdAt <= activationEpoch) return skipped('epoch-denied');
  return undefined;
}

function isHookInsideProjectRoot(hook: HookPayload | undefined, projectRoot: string | undefined): boolean {
  if (!projectRoot) return true;
  if (typeof hook?.cwd !== 'string' || !hook.cwd.trim()) return false;
  const root = resolve(projectRoot);
  const cwd = resolve(hook.cwd);
  const fromRoot = relative(root, cwd);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && resolve(root, fromRoot) === cwd;
}

function claimsForSession(
  jinnSessionId: string,
  session: SessionLookupResult | undefined,
  trigger: MemoryTrialTrigger,
  hook: HookPayload | undefined,
  projectRoot: string | undefined,
): MemoryTrialClaims | undefined {
  if (!session || session.id !== jinnSessionId) return undefined;
  if (!isHookInsideProjectRoot(hook, projectRoot)) return undefined;
  const claims = {
    createdAt: Date.parse(session.createdAt),
    projectId: MEMORY_TRIAL_POLICY.projectId,
    agentId: session.employee,
    sessionId: session.id,
    trigger,
  };
  return isMemoryTrialEligible(claims) ? claims : undefined;
}

export async function routeMemoryTrialHook(
  options: MemoryTrialHookRouteOptions,
): Promise<MemoryTrialHookRouteResult> {
  const gate = gateRejection(options);
  if (gate) return gate;

  const trigger = triggerForHook(options.hook);
  const deniedTrigger = triggerRejection(options, trigger);
  if (deniedTrigger) return deniedTrigger;

  const claims = claimsForSession(
    options.jinnSessionId!, options.getSession(options.jinnSessionId!), trigger!, options.hook, options.projectRoot,
  );
  if (!claims) return skipped('identity-denied');
  const deniedEpoch = activationEpochRejection(options, claims);
  if (deniedEpoch) return deniedEpoch;

  const operationId = memoryTrialOperationId(claims);
  const store = options.operationStore ?? routedOperations;
  if (store.has(operationId)) return skipped('duplicate');

  const additionalContext = await options.dispatch?.(claims);
  store.add(operationId);
  return { routed: true, ...(additionalContext ? { additionalContext } : {}) };
}

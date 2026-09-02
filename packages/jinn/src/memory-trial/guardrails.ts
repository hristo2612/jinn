import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isSourceEligible, type CanonicalSource } from './preparation.js';
import { writeJsonAtomically } from './trial-harness.js';

export const MEMORY_TRIAL_POLICY = Object.freeze({
  projectId: 'jarvis',
  activationEpoch: 100,
  policyVersion: 'jar-31-v1',
  allowedAgentIds: Object.freeze([
    'jarvis-director',
    'jarvis-fullstack-builder',
    'jarvis-quality-engineer',
    'jarvis-security-reviewer',
    'knowledge-curator',
  ] as const),
  triggers: Object.freeze(['session-finalized', 'authorized-session-start'] as const),
  budgets: Object.freeze({
    // ponytail: the JAR-31 trial cap was 3 sessions; operational archiving needs
    // a large ceiling (checkpoints accumulate for the life of the policy version).
    maxSessions: 1000,
    maxAgents: 5,
    maxPairs: 15,
    maxInjectedBytesPerSession: 16 * 1024,
    maxItemsPerSession: 25,
    maxSessionMilliseconds: 30_000,
    maxRetries: 0,
    concurrency: 1,
  }),
});

export type MemoryTrialTrigger = typeof MEMORY_TRIAL_POLICY.triggers[number];

export interface MemoryTrialClaims {
  readonly createdAt: number;
  readonly projectId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly trigger: MemoryTrialTrigger;
}

export interface MemoryTrialBudgetUsage {
  readonly sessions: number;
  readonly agents: number;
  readonly pairs: number;
  readonly injectedBytes: number;
  readonly items: number;
  readonly elapsedMilliseconds: number;
  readonly retries: number;
  readonly concurrency: number;
}

export type ExclusionReason = 'private' | 'sensitive' | 'temporary' | 'secret' | 'hostile';

interface ControlState {
  readonly enabled: boolean;
  readonly circuitOpen: boolean;
  readonly triggers: readonly MemoryTrialTrigger[];
  readonly queue: readonly string[];
  readonly derivedCanary: readonly string[];
  readonly checkpoints: readonly string[];
  readonly pending: readonly string[];
}

type MemoryTrialAuthorizedState = Readonly<Pick<ControlState, 'enabled' | 'circuitOpen' | 'triggers'>>;

const CONTROL_FILE = 'control.json';
const FIELD_SEPARATOR = '\u001f';
const DEFAULT_STATE: ControlState = Object.freeze({
  enabled: false,
  circuitOpen: true,
  triggers: Object.freeze([]),
  queue: Object.freeze([]),
  derivedCanary: Object.freeze([]),
  checkpoints: Object.freeze([]),
  pending: Object.freeze([]),
});

function stringArray(value: unknown): readonly string[] {
  return Object.freeze(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
}

function operationalState(state: Partial<ControlState>): ControlState {
  return Object.freeze({
    enabled: false,
    circuitOpen: true,
    triggers: Object.freeze([]),
    queue: stringArray(state.queue),
    derivedCanary: stringArray(state.derivedCanary),
    checkpoints: stringArray(state.checkpoints),
    pending: stringArray(state.pending),
  });
}

function authorizedEffectState(
  state: ControlState,
  authorizedState: MemoryTrialAuthorizedState | undefined,
): ControlState {
  return authorizedState ? { ...state, ...authorizedState } : state;
}

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

function identityParts(operationId: string): readonly string[] {
  return operationId.split(FIELD_SEPARATOR);
}

function isOperationBudgetAvailable(state: ControlState, operationId: string): boolean {
  const operations = [...state.checkpoints, ...state.pending, operationId];
  const parts = operations.map(identityParts);
  return isWithinMemoryTrialBudget({
    sessions: new Set(parts.map(([projectId, agentId, sessionId]) =>
      [projectId, agentId, sessionId].join(FIELD_SEPARATOR))).size,
    agents: new Set(parts.map(([, agentId]) => agentId)).size,
    pairs: new Set(parts.map(([projectId, agentId]) =>
      [projectId, agentId].join(FIELD_SEPARATOR))).size,
    injectedBytes: 0,
    items: 0,
    elapsedMilliseconds: 0,
    retries: 0,
    concurrency: state.pending.length + 1,
  });
}

export function exclusionReason(
  source: Readonly<{ corpus: string; content: string }>,
  logReason: (reason: ExclusionReason) => void,
): ExclusionReason | undefined {
  const reason = source.corpus === 'private'
    || source.corpus === 'sensitive'
    || source.corpus === 'temporary'
    || source.corpus === 'secret'
    ? source.corpus
    : !isSourceEligible(source as CanonicalSource) ? 'hostile' : undefined;
  if (reason !== undefined) logReason(reason);
  return reason;
}

async function readState(path: string): Promise<ControlState> {
  try {
    return operationalState(JSON.parse(await readFile(path, 'utf8')) as Partial<ControlState>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_STATE;
    throw error;
  }
}

async function writeState(directory: string, state: ControlState): Promise<void> {
  await writeJsonAtomically(directory, CONTROL_FILE, operationalState(state));
}

function assertInitialEffectState(state: ControlState, trigger: MemoryTrialTrigger): void {
  if (!state.enabled) throw new Error('trial-disabled');
  if (state.circuitOpen || !state.triggers.includes(trigger)) throw new Error('circuit-open');
}

function assertImmediateEffectState(state: ControlState, trigger: MemoryTrialTrigger): void {
  if (!state.enabled || state.circuitOpen || !state.triggers.includes(trigger)) {
    throw new Error('circuit-open');
  }
}

export class MemoryTrialGuard {
  private isRunning = false;

  private constructor(
    private readonly directory: string,
    private readonly controlPath: string,
  ) {}

  public static async create(directory: string): Promise<MemoryTrialGuard> {
    await mkdir(directory, { recursive: true });
    const guard = new MemoryTrialGuard(directory, join(directory, CONTROL_FILE));
    const state = await readState(guard.controlPath);
    await writeState(directory, state);
    return guard;
  }

  /** Isolated harness helper; it has no runtime caller while MEMORY_TRIAL_ENABLED is false. */
  public armForTest(): MemoryTrialAuthorizedState {
    return Object.freeze({
      enabled: true,
      circuitOpen: false,
      triggers: MEMORY_TRIAL_POLICY.triggers,
    });
  }

  public async openCircuit(): Promise<void> {
    const state = await readState(this.controlPath);
    await writeState(this.directory, { ...state, circuitOpen: true, triggers: Object.freeze([]), queue: Object.freeze([]) });
  }

  private async resolveExistingOperation(
    state: ControlState,
    operationId: string,
  ): Promise<'resumed' | 'replay' | undefined> {
    if (state.checkpoints.includes(operationId)) return 'replay';
    if (!state.pending.includes(operationId)) return undefined;
    await writeState(this.directory, {
      ...state,
      checkpoints: Object.freeze([...state.checkpoints, operationId]),
      pending: Object.freeze(state.pending.filter((id) => id !== operationId)),
    });
    return 'resumed';
  }

  private async executeEffect(
    claims: MemoryTrialClaims,
    effect: (operationId: string) => Promise<void>,
    options: Readonly<{ crashAfterEffect?: boolean; authorizedState?: MemoryTrialAuthorizedState }>,
  ): Promise<'completed' | 'resumed' | 'replay'> {
    if (!isEligibleForMemoryTrial(claims)) throw new Error('eligibility-denied');
    const operationId = memoryTrialOperationId(claims);
    const persistedState = await readState(this.controlPath);
    const state = authorizedEffectState(persistedState, options.authorizedState);
    assertInitialEffectState(state, claims.trigger);
    const existingResult = await this.resolveExistingOperation(state, operationId);
    if (existingResult !== undefined) return existingResult;
    if (!isOperationBudgetAvailable(state, operationId)) throw new Error('budget-violation');

    await writeState(this.directory, { ...state, pending: Object.freeze([...state.pending, operationId]) });
    const immediateState = authorizedEffectState(await readState(this.controlPath), options.authorizedState);
    assertImmediateEffectState(immediateState, claims.trigger);
    await effect(operationId);
    if (options.crashAfterEffect === true) throw new Error('simulated-crash-after-effect');
    const commitState = await readState(this.controlPath);
    await writeState(this.directory, {
      ...commitState,
      checkpoints: Object.freeze([...commitState.checkpoints, operationId]),
      pending: Object.freeze(commitState.pending.filter((id) => id !== operationId)),
    });
    return 'completed';
  }

  public async runEffect(
    claims: MemoryTrialClaims,
    effect: (operationId: string) => Promise<void>,
    options: Readonly<{ crashAfterEffect?: boolean; authorizedState?: MemoryTrialAuthorizedState }> = Object.freeze({}),
  ): Promise<'completed' | 'resumed' | 'replay'> {
    if (this.isRunning) throw new Error('concurrency-violation');
    this.isRunning = true;
    try {
      return await this.executeEffect(claims, effect, options);
    } finally {
      this.isRunning = false;
    }
  }

  public async seedForTest(seed: {
    readonly queued: readonly string[];
    readonly derivedCanary: readonly string[];
    readonly checkpoint: readonly string[];
  }): Promise<void> {
    const state = await readState(this.controlPath);
    await writeState(this.directory, {
      ...state,
      queue: Object.freeze([...seed.queued]),
      derivedCanary: Object.freeze([...seed.derivedCanary]),
      checkpoints: Object.freeze([...seed.checkpoint]),
    });
  }

  public async rollback(): Promise<void> {
    const state = await readState(this.controlPath);
    await writeState(this.directory, {
      ...state,
      enabled: false,
      circuitOpen: true,
      triggers: Object.freeze([]),
      queue: Object.freeze([]),
      derivedCanary: Object.freeze([]),
      pending: Object.freeze([]),
    });
  }
}

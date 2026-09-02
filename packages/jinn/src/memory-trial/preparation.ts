/**
 * JAR-29 technical groundwork. This module must not be wired to any startup
 * path until the TRIAL has received a separate authorisation.
 */

export const MEMORY_TRIAL_ENABLED = false as const;

export type MemoryTrialFlow = 'session-end' | 'session-start';

export interface MemoryTrialRequest {
  readonly flow: MemoryTrialFlow;
  readonly projectId: string;
  readonly agentId: string;
  readonly sourceVersion: string;
}

export interface MemoryTrialPreparation {
  readonly enabled: false;
  readonly registeredTriggers: readonly [];
  readonly allowedCorpus: readonly ['synthetic', 'public'];
  readonly flows: Readonly<Record<MemoryTrialFlow, 'designed-not-active'>>;
}

export type CorpusKind = 'synthetic' | 'public';

export interface CanonicalSource {
  readonly id: string;
  readonly corpus: CorpusKind;
  readonly canonicalUri: string;
  readonly version: string;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly content: string;
}

export interface MemoryPrincipal {
  readonly agentId: string;
  readonly projectId: string;
}

export interface DerivedMemoryEntry {
  readonly sourceId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly citation: string;
  readonly text: string;
}

export interface MemoryCheckpoint {
  readonly operationId: string;
  readonly sourceVersion: string;
  readonly completedSourceIds: readonly string[];
}

export interface ReinjectionBudget {
  readonly maxEntries: number;
  readonly maxCharacters: number;
}

export interface ReinjectionResult {
  readonly entries: readonly DerivedMemoryEntry[];
  readonly characters: number;
  readonly isTruncated: boolean;
}

export interface TrialMetrics {
  readonly accepted: number;
  readonly excluded: number;
  readonly denied: number;
  readonly resumed: number;
}

export const EMPTY_TRIAL_METRICS: TrialMetrics = Object.freeze({
  accepted: 0,
  excluded: 0,
  denied: 0,
  resumed: 0,
});

const HOSTILE_CONTENT_PATTERNS = Object.freeze([
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s*:/i,
  /<\/?(?:system|assistant|tool)(?:\s|>)/i,
  /(?:api[_ -]?key|password|secret)\s*[:=]/i,
  /authorization\s*:\s*(?:bearer\s+)?\S+/i,
  /bearer\s+[a-z0-9._~+/=-]{16,}/i,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/,
  /\b(?:api[_ -]?key|password|secret|token)(?:\s+|(?=[a-z0-9._~+/=-]{16,}\b))[a-z0-9._~+/=-]{16,}\b/i,
]);

const PRIVATE_URI_PATTERNS = Object.freeze([
  /^file:/i,
  /(?:^|\/)Users\//,
  /(?:^|\/)home\//,
  /localhost|127\.0\.0\.1/i,
]);

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
}

function isCanonicalClaim(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && value === value.normalize('NFC');
}

function assertCanonicalPrincipal(principal: unknown): asserts principal is MemoryPrincipal {
  if (typeof principal !== 'object' || principal === null) {
    throw new Error('principal must contain canonical agentId and projectId claims');
  }
  const candidate = principal as Partial<MemoryPrincipal>;
  if (!isCanonicalClaim(candidate.agentId) || !isCanonicalClaim(candidate.projectId)) {
    throw new Error('principal claims must be non-empty, trimmed NFC strings');
  }
}

export function canonicalizeSource(source: CanonicalSource): CanonicalSource {
  assertNonEmpty(source.id, 'source.id');
  assertNonEmpty(source.version, 'source.version');
  if (!/^[a-f0-9]{64}$/i.test(source.sha256)) throw new Error('source.sha256 must be canonical SHA-256');
  if (!/^https:\/\//i.test(source.canonicalUri) || PRIVATE_URI_PATTERNS.some((pattern) => pattern.test(source.canonicalUri))) {
    throw new Error('source.canonicalUri must be a public HTTPS URI');
  }
  if (Number.isNaN(Date.parse(source.capturedAt))) throw new Error('source.capturedAt must be ISO-compatible');
  return Object.freeze({ ...source });
}

export function isSourceEligible(source: CanonicalSource): boolean {
  return (source.corpus === 'synthetic' || source.corpus === 'public')
    && source.content.trim().length > 0
    && !HOSTILE_CONTENT_PATTERNS.some((pattern) => pattern.test(source.content));
}

/** AIR-12: content is data, never authority; rejection happens before derivation. */
export function deriveMemoryEntry(
  source: CanonicalSource,
  principal: MemoryPrincipal,
): DerivedMemoryEntry | undefined {
  assertCanonicalPrincipal(principal);
  const canonicalSource = canonicalizeSource(source);
  if (!isSourceEligible(canonicalSource)) return undefined;
  return Object.freeze({
    sourceId: canonicalSource.id,
    projectId: principal.projectId,
    agentId: principal.agentId,
    citation: `${canonicalSource.canonicalUri}@${canonicalSource.version}#sha256=${canonicalSource.sha256}`,
    text: canonicalSource.content.trim(),
  });
}

/** Deny by default: access exists only for the exact agent/project owner pair. */
export function canReadMemory(entry: DerivedMemoryEntry, principal?: MemoryPrincipal): boolean {
  if (!isCanonicalClaim(entry.agentId) || !isCanonicalClaim(entry.projectId)) return false;
  try {
    assertCanonicalPrincipal(principal);
  } catch {
    return false;
  }
  if (entry.agentId === 'knowledge-curator' && entry.projectId === 'agency-global') return true;
  return entry.agentId === principal.agentId && entry.projectId === principal.projectId;
}

export function rebuildDerivedIndex(
  sources: readonly CanonicalSource[],
  principal: MemoryPrincipal,
): readonly DerivedMemoryEntry[] {
  return Object.freeze(sources
    .map((source) => deriveMemoryEntry(source, principal))
    .filter((entry): entry is DerivedMemoryEntry => entry !== undefined)
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
}

export function advanceCheckpoint(
  checkpoint: MemoryCheckpoint,
  sourceId: string,
): MemoryCheckpoint {
  if (checkpoint.completedSourceIds.includes(sourceId)) return checkpoint;
  return Object.freeze({
    ...checkpoint,
    completedSourceIds: Object.freeze([...checkpoint.completedSourceIds, sourceId].sort()),
  });
}

export function pendingSources(
  sources: readonly CanonicalSource[],
  checkpoint: MemoryCheckpoint,
): readonly CanonicalSource[] {
  return Object.freeze(sources.filter((source) => !checkpoint.completedSourceIds.includes(source.id)));
}

export function prepareMinimalReinjection(
  index: readonly DerivedMemoryEntry[],
  principal: MemoryPrincipal,
  budget: ReinjectionBudget,
): ReinjectionResult {
  if (!Number.isInteger(budget.maxEntries) || budget.maxEntries < 0
    || !Number.isInteger(budget.maxCharacters) || budget.maxCharacters < 0) {
    throw new Error('reinjection budgets must be non-negative integers');
  }
  const readable = index.filter((entry) => canReadMemory(entry, principal));
  const entries: DerivedMemoryEntry[] = [];
  let characters = 0;
  for (const entry of readable) {
    if (entries.length >= budget.maxEntries || characters + entry.text.length > budget.maxCharacters) break;
    entries.push(entry);
    characters += entry.text.length;
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    characters,
    isTruncated: entries.length < readable.length,
  });
}

/** Session start must never block on optional memory preparation. */
export async function reinjectNonBlocking(
  prepare: () => Promise<ReinjectionResult>,
): Promise<ReinjectionResult> {
  try {
    return await prepare();
  } catch {
    return Object.freeze({ entries: Object.freeze([]), characters: 0, isTruncated: false });
  }
}

export function rollbackDerivedIndex(): readonly DerivedMemoryEntry[] {
  return Object.freeze([]);
}

export class MemoryTrialDisabledError extends Error {
  public constructor() {
    super('JAR-29 memory trial is disabled; explicit authorization is required');
    this.name = 'MemoryTrialDisabledError';
  }
}

export function describeMemoryTrialPreparation(): MemoryTrialPreparation {
  return Object.freeze({
    enabled: MEMORY_TRIAL_ENABLED,
    registeredTriggers: Object.freeze([]) as readonly [],
    allowedCorpus: Object.freeze(['synthetic', 'public'] as const),
    flows: Object.freeze({
      'session-end': 'designed-not-active',
      'session-start': 'designed-not-active',
    }),
  });
}

export function runMemoryTrial(_request: MemoryTrialRequest): never {
  throw new MemoryTrialDisabledError();
}

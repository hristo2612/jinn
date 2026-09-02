import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  advanceCheckpoint,
  canReadMemory,
  canonicalizeSource,
  isSourceEligible,
  prepareMinimalReinjection,
  rebuildDerivedIndex,
  reinjectNonBlocking,
  rollbackDerivedIndex,
  type CanonicalSource,
  type MemoryCheckpoint,
  type MemoryPrincipal,
  type ReinjectionBudget,
  type ReinjectionResult,
} from './preparation.js';

export interface TrialHarnessInput {
  readonly directory: string;
  readonly operationId: string;
  readonly principal: MemoryPrincipal;
  readonly sources: readonly CanonicalSource[];
  readonly budget: ReinjectionBudget;
  readonly interruptAfter?: number;
  readonly requester?: MemoryPrincipal;
}

export interface TrialHarnessMetrics {
  readonly supplied: number;
  readonly indexed: number;
  readonly excluded: number;
  readonly resumed: number;
  readonly injected: number;
  readonly injectedCharacters: number;
  readonly rollbackEntries: number;
}

export interface TrialHarnessResult {
  readonly status: 'completed' | 'interrupted' | 'stopped';
  readonly reason?: 'acl-denied' | 'budget-violation' | 'corpus-violation' | 'hostile-content';
  readonly reinjection: ReinjectionResult;
  readonly metrics: TrialHarnessMetrics;
  readonly fingerprints: readonly string[];
}

const INDEX_FILE = 'derived-index.json';
const CHECKPOINT_FILE = 'checkpoint.json';
const METRICS_FILE = 'metrics.json';

export async function writeJsonAtomically(
  directory: string,
  fileName: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = join(directory, `${fileName}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(value), 'utf8');
  await rename(temporaryPath, join(directory, fileName));
}

interface StoppedState {
  readonly indexed: number;
  readonly excluded: number;
  readonly resumed: number;
  readonly fingerprints: readonly string[];
}

function emptyReinjection(): ReinjectionResult {
  return Object.freeze({ entries: Object.freeze([]), characters: 0, isTruncated: false });
}

function classifyViolation(source: CanonicalSource): TrialHarnessResult['reason'] | undefined {
  if (source.corpus !== 'synthetic' && source.corpus !== 'public') return 'corpus-violation';
  if (!isSourceEligible(source)) return 'hostile-content';
  return undefined;
}

async function readCheckpoint(path: string, fallback: MemoryCheckpoint): Promise<MemoryCheckpoint> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as MemoryCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function removeDerivedArtifacts(directory: string): Promise<void> {
  await Promise.all([
    rm(join(directory, INDEX_FILE), { force: true }),
    rm(join(directory, CHECKPOINT_FILE), { force: true }),
    rm(join(directory, METRICS_FILE), { force: true }),
  ]);
}

function stoppedResult(
  input: TrialHarnessInput,
  reason: NonNullable<TrialHarnessResult['reason']>,
  state: StoppedState,
): TrialHarnessResult {
  return Object.freeze({
    status: 'stopped',
    reason,
    reinjection: emptyReinjection(),
    metrics: Object.freeze({
      supplied: input.sources.length,
      indexed: state.indexed,
      excluded: state.excluded,
      resumed: state.resumed,
      injected: 0,
      injectedCharacters: 0,
      rollbackEntries: state.indexed,
    }),
    fingerprints: Object.freeze([...state.fingerprints]),
  });
}

function validateSources(sources: readonly CanonicalSource[]): TrialHarnessResult['reason'] | undefined {
  for (const source of sources) {
    canonicalizeSource(source);
    const violation = classifyViolation(source);
    if (violation !== undefined) return violation;
  }
  return undefined;
}

async function advanceSessionEnd(
  input: TrialHarnessInput,
  checkpointPath: string,
  initial: MemoryCheckpoint,
): Promise<readonly [MemoryCheckpoint, boolean]> {
  let checkpoint = initial;
  for (const source of input.sources) {
    if (checkpoint.completedSourceIds.includes(source.id)) continue;
    checkpoint = advanceCheckpoint(checkpoint, source.id);
    await writeFile(checkpointPath, JSON.stringify(checkpoint), 'utf8');
    if (input.interruptAfter === checkpoint.completedSourceIds.length) {
      return Object.freeze([checkpoint, true]);
    }
  }
  return Object.freeze([checkpoint, false]);
}

function interruptedResult(
  input: TrialHarnessInput,
  indexed: number,
  resumed: number,
  fingerprints: readonly string[],
): TrialHarnessResult {
  return Object.freeze({
    status: 'interrupted',
    reinjection: emptyReinjection(),
    metrics: Object.freeze({
      supplied: input.sources.length,
      indexed,
      excluded: 0,
      resumed,
      injected: 0,
      injectedCharacters: 0,
      rollbackEntries: 0,
    }),
    fingerprints: Object.freeze([...fingerprints]),
  });
}

interface TrialContext {
  readonly checkpointPath: string;
  readonly checkpoint: MemoryCheckpoint;
  readonly resumed: number;
}

async function prepareTrialContext(input: TrialHarnessInput): Promise<TrialContext> {
  await mkdir(input.directory, { recursive: true });
  const checkpointPath = join(input.directory, CHECKPOINT_FILE);
  const initialCheckpoint: MemoryCheckpoint = Object.freeze({
    operationId: input.operationId,
    sourceVersion: input.sources.map((source) => source.version).join(','),
    completedSourceIds: Object.freeze([]),
  });
  const checkpoint = await readCheckpoint(checkpointPath, initialCheckpoint);
  return Object.freeze({ checkpointPath, checkpoint, resumed: checkpoint.completedSourceIds.length });
}

function validateTrial(
  input: TrialHarnessInput,
  resumed: number,
): TrialHarnessResult | undefined {
  const violation = validateSources(input.sources);
    if (violation !== undefined) {
      return stoppedResult(input, violation, { indexed: 0, excluded: 1, resumed, fingerprints: [] });
    }
  return undefined;
}

function validateAccessAndBudget(
  input: TrialHarnessInput,
  resumed: number,
  index: ReturnType<typeof rebuildDerivedIndex>,
  requester: MemoryPrincipal,
): TrialHarnessResult | undefined {
  const fingerprints = index.map((entry) => entry.citation);
  if (index.some((entry) => !canReadMemory(entry, requester))) {
      return stoppedResult(input, 'acl-denied', {
        indexed: index.length, excluded: 0, resumed, fingerprints,
      });
  }
  const reinjection = prepareMinimalReinjection(index, requester, input.budget);
  if (index.length > 0 && reinjection.entries.length === 0) {
      return stoppedResult(input, 'budget-violation', {
        indexed: index.length, excluded: 0, resumed, fingerprints,
      });
  }
  return undefined;
}

async function completeTrial(
  input: TrialHarnessInput,
  resumed: number,
  index: ReturnType<typeof rebuildDerivedIndex>,
  requester: MemoryPrincipal,
): Promise<TrialHarnessResult> {
  const reinjection = await reinjectNonBlocking(async () =>
    prepareMinimalReinjection(index, requester, input.budget));
  const metrics = Object.freeze({
    supplied: input.sources.length,
    indexed: index.length,
    excluded: 0,
    resumed,
    injected: reinjection.entries.length,
    injectedCharacters: reinjection.characters,
    rollbackEntries: index.length - rollbackDerivedIndex().length,
  });
  await writeFile(join(input.directory, METRICS_FILE), JSON.stringify(metrics), 'utf8');
  return Object.freeze({
    status: 'completed',
    reinjection,
    metrics,
    fingerprints: Object.freeze(index.map((entry) => entry.citation)),
  });
}

export async function runControlledMemoryTrial(input: TrialHarnessInput): Promise<TrialHarnessResult> {
  const context = await prepareTrialContext(input);

  try {
    const invalidTrial = validateTrial(input, context.resumed);
    if (invalidTrial !== undefined) return invalidTrial;
    const index = rebuildDerivedIndex(input.sources, input.principal);
    const requester = input.requester ?? input.principal;
    const fingerprints = index.map((entry) => entry.citation);
    const invalidAccess = validateAccessAndBudget(input, context.resumed, index, requester);
    if (invalidAccess !== undefined) return invalidAccess;

    await writeFile(join(input.directory, INDEX_FILE), JSON.stringify(index), 'utf8');
    const [, isInterrupted] = await advanceSessionEnd(input, context.checkpointPath, context.checkpoint);
    if (isInterrupted) return interruptedResult(input, index.length, context.resumed, fingerprints);
    return await completeTrial(input, context.resumed, index, requester);
  } finally {
    if (input.interruptAfter === undefined) await removeDerivedArtifacts(input.directory);
  }
}

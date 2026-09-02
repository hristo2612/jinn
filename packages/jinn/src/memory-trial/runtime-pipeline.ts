import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HookPayload } from '../gateway/hook-registry.js';
import {
  deriveMemoryEntry,
  prepareMinimalReinjection,
  type CanonicalSource,
  type DerivedMemoryEntry,
  type MemoryPrincipal,
} from './preparation.js';
import { exclusionReason, type MemoryTrialClaims } from './guardrails.js';
import { writeJsonAtomically } from './trial-harness.js';

const ARCHIVE_FILE = 'archive.json';
const INDEX_FILE = 'derived-index.json';
const EXCLUSIONS_FILE = 'exclusions.json';
const REINJECTION_BUDGET = Object.freeze({ maxEntries: 8, maxCharacters: 4_000 });

interface RuntimeArchive {
  readonly sources: readonly CanonicalSource[];
}

interface RuntimeIndex {
  readonly entries: readonly DerivedMemoryEntry[];
}

interface ExclusionRecord {
  readonly sessionId: string;
  readonly reason: string;
  readonly recordedAt: string;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

function principal(claims: MemoryTrialClaims): MemoryPrincipal {
  return { agentId: claims.agentId, projectId: claims.projectId };
}

function sourceFromStop(
  claims: MemoryTrialClaims,
  hook: HookPayload,
  autoArchiveProjectContent: boolean,
): CanonicalSource | undefined {
  const content = typeof hook.last_assistant_message === 'string' ? hook.last_assistant_message.trim() : '';
  if (!content) return undefined;
  const corpus = hook.memory_trial_corpus ?? (autoArchiveProjectContent ? 'public' : undefined);
  if (corpus !== 'synthetic' && corpus !== 'public') return undefined;
  const version = typeof hook.session_id === 'string' && hook.session_id.trim()
    ? hook.session_id.trim()
    : String(claims.createdAt);
  return {
    id: `${claims.sessionId}:${version}`,
    corpus,
    canonicalUri: `https://jinn.invalid/sessions/${encodeURIComponent(claims.sessionId)}`,
    version,
    sha256: createHash('sha256').update(content).digest('hex'),
    capturedAt: new Date().toISOString(),
    content,
  };
}

async function recordExclusion(directory: string, claims: MemoryTrialClaims, reason: string): Promise<void> {
  const path = join(directory, EXCLUSIONS_FILE);
  const records = await readJson<readonly ExclusionRecord[]>(path, []);
  await writeJsonAtomically(directory, EXCLUSIONS_FILE, [...records, {
    sessionId: claims.sessionId,
    reason,
    recordedAt: new Date().toISOString(),
  }]);
}

async function archiveFinalizedSession(
  directory: string,
  claims: MemoryTrialClaims,
  hook: HookPayload,
  autoArchiveProjectContent: boolean,
): Promise<void> {
  const source = sourceFromStop(claims, hook, autoArchiveProjectContent);
  if (!source) {
    await recordExclusion(directory, claims, hook.last_assistant_message ? 'private' : 'temporary');
    return;
  }
  let denied: string | undefined;
  const reason = exclusionReason(source, (value) => { denied = value; });
  if (reason || denied) {
    await recordExclusion(directory, claims, reason ?? denied!);
    return;
  }
  const entry = deriveMemoryEntry(source, principal(claims));
  if (!entry) {
    await recordExclusion(directory, claims, 'hostile');
    return;
  }

  const archivePath = join(directory, ARCHIVE_FILE);
  const indexPath = join(directory, INDEX_FILE);
  const archive = await readJson<RuntimeArchive>(archivePath, { sources: [] });
  const index = await readJson<RuntimeIndex>(indexPath, { entries: [] });
  if (!archive.sources.some((item) => item.id === source.id)) {
    await writeJsonAtomically(directory, ARCHIVE_FILE, { sources: [...archive.sources, source] });
  }
  if (!index.entries.some((item) => item.sourceId === entry.sourceId
    && item.agentId === entry.agentId && item.projectId === entry.projectId)) {
    await writeJsonAtomically(directory, INDEX_FILE, { entries: [...index.entries, entry] });
  }
}

async function prepareSessionContext(directory: string, claims: MemoryTrialClaims): Promise<string | undefined> {
  const index = await readJson<RuntimeIndex>(join(directory, INDEX_FILE), { entries: [] });
  const result = prepareMinimalReinjection(index.entries, principal(claims), REINJECTION_BUDGET);
  if (result.entries.length === 0) return undefined;
  const lines = result.entries.map((entry) => `- ${entry.text}\n  Source: ${entry.citation}`);
  return `[Jinn memory — bounded, cited context]\n${lines.join('\n')}`;
}

export async function runMemoryRuntimeEffect(input: {
  readonly directory: string;
  readonly claims: MemoryTrialClaims;
  readonly hook: HookPayload;
  readonly autoArchiveProjectContent?: boolean;
}): Promise<string | undefined> {
  await mkdir(input.directory, { recursive: true });
  if (input.claims.trigger === 'session-finalized') {
    await archiveFinalizedSession(
      input.directory, input.claims, input.hook, input.autoArchiveProjectContent === true,
    );
    return undefined;
  }
  return prepareSessionContext(input.directory, input.claims);
}

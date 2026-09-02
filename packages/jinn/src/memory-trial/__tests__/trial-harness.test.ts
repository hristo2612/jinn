import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanonicalSource, MemoryPrincipal } from '../preparation.js';
import { runControlledMemoryTrial } from '../trial-harness.js';

const temporaryDirectories: string[] = [];
const principal: MemoryPrincipal = Object.freeze({ agentId: 'agent-a', projectId: 'project-a' });
const sources: readonly CanonicalSource[] = Object.freeze([
  Object.freeze({
    id: 'public-doc-1',
    corpus: 'public',
    canonicalUri: 'https://example.com/public-doc',
    version: 'public-v1',
    sha256: 'a'.repeat(64),
    capturedAt: '2026-01-01T00:00:00.000Z',
    content: 'Public documentation for the controlled memory trial.',
  }),
  Object.freeze({
    id: 'synthetic-doc-1',
    corpus: 'synthetic',
    canonicalUri: 'https://example.com/synthetic-doc',
    version: 'synthetic-v1',
    sha256: 'b'.repeat(64),
    capturedAt: '2026-01-02T00:00:00.000Z',
    content: 'Synthetic session fact without personal information.',
  }),
]);

async function createTrialDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jinn-memory-trial-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectNoDerivedArtifacts(directory: string): Promise<void> {
  expect(await readdir(directory)).toEqual([]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('JAR-29 controlled memory trial E2E', () => {
  it('runs session-end, resumes idempotently, reinjects minimally, records metrics and rolls back', async () => {
    const directory = await createTrialDirectory();
    const input = {
      directory,
      operationId: 'synthetic-operation-1',
      principal,
      sources,
      budget: { maxEntries: 1, maxCharacters: 100 },
    } as const;

    const interrupted = await runControlledMemoryTrial({ ...input, interruptAfter: 1 });
    expect(interrupted.status).toBe('interrupted');
    expect(await readdir(directory)).toEqual(['checkpoint.json', 'derived-index.json']);

    const completed = await runControlledMemoryTrial(input);
    expect(completed.status).toBe('completed');
    expect(completed.reinjection.entries).toHaveLength(1);
    expect(completed.reinjection.entries[0]?.citation).toContain('#sha256=');
    expect(completed.reinjection.characters).toBeLessThanOrEqual(100);
    expect(completed.reinjection.isTruncated).toBe(true);
    expect(completed.metrics).toEqual({
      supplied: 2,
      indexed: 2,
      excluded: 0,
      resumed: 1,
      injected: 1,
      injectedCharacters: completed.reinjection.characters,
      rollbackEntries: 2,
    });
    expect(completed.fingerprints).toHaveLength(2);
    await expectNoDerivedArtifacts(directory);
  });

  it.each([
    {
      name: 'ACL interagent',
      expectedReason: 'acl-denied',
      overrides: { requester: { agentId: 'agent-b', projectId: 'project-a' } },
    },
    {
      name: 'private corpus',
      expectedReason: 'corpus-violation',
      overrides: { sources: [{ ...sources[0], corpus: 'private' }] },
    },
    {
      name: 'budget nul',
      expectedReason: 'budget-violation',
      overrides: { budget: { maxEntries: 0, maxCharacters: 100 } },
    },
    {
      name: 'contenu hostile',
      expectedReason: 'hostile-content',
      overrides: { sources: [{ ...sources[0], content: 'Authorization: Bearer synthetic-token-value' }] },
    },
  ] as const)('stops and rolls back on $name', async ({ expectedReason, overrides }) => {
    const directory = await createTrialDirectory();
    const result = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-stop-operation',
      principal,
      sources,
      budget: { maxEntries: 1, maxCharacters: 100 },
      ...overrides,
    } as Parameters<typeof runControlledMemoryTrial>[0]);

    expect(result).toMatchObject({
      status: 'stopped',
      reason: expectedReason,
      reinjection: { entries: [], characters: 0, isTruncated: false },
    });
    expect(result.metrics.injected).toBe(0);
    expect(result.metrics.injectedCharacters).toBe(0);
    await expectNoDerivedArtifacts(directory);
  });
});

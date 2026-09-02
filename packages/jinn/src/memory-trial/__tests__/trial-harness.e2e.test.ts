import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CanonicalSource, MemoryPrincipal } from '../preparation.js';
import { runControlledMemoryTrial } from '../trial-harness.js';

const owner: MemoryPrincipal = Object.freeze({ agentId: 'synthetic-agent-a', projectId: 'synthetic-project-a' });
const publicSource: CanonicalSource = Object.freeze({
  id: 'public-source-1',
  corpus: 'public',
  canonicalUri: 'https://example.com/jar-29/public-source-1',
  version: 'public-v1',
  sha256: 'a'.repeat(64),
  capturedAt: '2026-09-01T00:00:00.000Z',
  content: 'Public fixture describing a bounded memory workflow.',
});
const syntheticSource: CanonicalSource = Object.freeze({
  ...publicSource,
  id: 'synthetic-source-1',
  corpus: 'synthetic',
  canonicalUri: 'https://example.com/jar-29/synthetic-source-1',
  version: 'synthetic-v1',
  sha256: 'b'.repeat(64),
  content: 'Synthetic fixture describing an explicit session end.',
});

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jar-29-memory-trial-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectNoDerivedArtifacts(directory: string): Promise<void> {
  expect(await readdir(directory)).toEqual([]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('JAR-29 controlled memory trial E2E', () => {
  it('runs session-end through resumed checkpoint and bounded cited session-start, then rolls back', async () => {
    const directory = await makeWorkspace();
    const interrupted = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-operation-1',
      sources: [syntheticSource, publicSource],
      principal: owner,
      requester: owner,
      budget: { maxEntries: 1, maxCharacters: 80 },
      interruptAfter: 1,
    });

    expect(interrupted).toMatchObject({
      status: 'interrupted',
      metrics: { supplied: 2, indexed: 2, resumed: 0, rollbackEntries: 0 },
    });
    expect(await readdir(directory)).toEqual(['checkpoint.json', 'derived-index.json']);

    const result = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-operation-1',
      sources: [syntheticSource, publicSource],
      principal: owner,
      requester: owner,
      budget: { maxEntries: 1, maxCharacters: 80 },
    });

    expect(result.status).toBe('completed');
    expect(result.metrics).toEqual({
      supplied: 2,
      indexed: 2,
      excluded: 0,
      resumed: 1,
      injected: 1,
      injectedCharacters: publicSource.content.length,
      rollbackEntries: 2,
    });
    expect(result.reinjection.entries[0]?.citation).toContain('#sha256=');
    expect(result.reinjection.isTruncated).toBe(true);
    expect(result.fingerprints).toEqual([
      expect.stringContaining('#sha256='),
      expect.stringContaining('#sha256='),
    ]);
    await expectNoDerivedArtifacts(directory);
  });

  it('stops and rolls back on an interagent ACL violation', async () => {
    const directory = await makeWorkspace();
    const result = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-acl-violation',
      sources: [syntheticSource],
      principal: owner,
      requester: { ...owner, agentId: 'synthetic-agent-b' },
      budget: { maxEntries: 1, maxCharacters: 80 },
    });

    expect(result).toMatchObject({ status: 'stopped', reason: 'acl-denied' });
    await expectNoDerivedArtifacts(directory);
  });

  it('stops and rolls back on an interproject ACL violation', async () => {
    const directory = await makeWorkspace();
    const result = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-interproject-acl-violation',
      sources: [syntheticSource],
      principal: owner,
      requester: { ...owner, projectId: 'synthetic-project-b' },
      budget: { maxEntries: 1, maxCharacters: 80 },
    });

    expect(result).toMatchObject({ status: 'stopped', reason: 'acl-denied' });
    await expectNoDerivedArtifacts(directory);
  });

  it('stops and rolls back on a disallowed corpus', async () => {
    const directory = await makeWorkspace();
    const privateSource = { ...syntheticSource, corpus: 'private' } as unknown as CanonicalSource;
    const result = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-corpus-violation',
      sources: [privateSource],
      principal: owner,
      requester: owner,
      budget: { maxEntries: 1, maxCharacters: 80 },
    });

    expect(result).toMatchObject({ status: 'stopped', reason: 'corpus-violation' });
    await expectNoDerivedArtifacts(directory);
  });

  it('stops and rolls back when the reinjection budget cannot admit an entry', async () => {
    const directory = await makeWorkspace();
    const result = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-budget-violation',
      sources: [syntheticSource],
      principal: owner,
      requester: owner,
      budget: { maxEntries: 1, maxCharacters: 1 },
    });

    expect(result).toMatchObject({ status: 'stopped', reason: 'budget-violation' });
    await expectNoDerivedArtifacts(directory);
  });

  it('stops and rolls back when hostile content is present', async () => {
    const directory = await makeWorkspace();
    const hostileSource = Object.freeze({
      ...syntheticSource,
      content: 'Authorization: Bearer synthetic-token-value',
    });
    const result = await runControlledMemoryTrial({
      directory,
      operationId: 'synthetic-hostile-content',
      sources: [hostileSource],
      principal: owner,
      requester: owner,
      budget: { maxEntries: 1, maxCharacters: 80 },
    });

    expect(result).toMatchObject({ status: 'stopped', reason: 'hostile-content' });
    await expectNoDerivedArtifacts(directory);
  });
});

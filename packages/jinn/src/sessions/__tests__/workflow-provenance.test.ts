import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempDir } from '../../shared/test-support/temp-dir.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-provenance-'));
process.env.JINN_HOME = home;

type Registry = typeof import('../registry.js');
let registry: Registry;

beforeAll(async () => {
  registry = await import('../registry.js');
  registry.initDb();
});

afterAll(() => {
  // Close the database before removing its directory: Windows refuses to unlink
  // a file with an open handle, so the sqlite connection has to go first.
  registry.__closeDbForTest();
  removeTempDir(home);
});

describe('workflow session provenance', () => {
  it('groups a new phase attempt by workflowRunId without a conversational parent', () => {
    const phase = registry.createSession({
      engine: 'codex',
      source: 'web',
      sourceRef: 'workflow-run:run-reg-2:verify:1',
      sessionKey: 'workflow-run:run-reg-2:verify:1',
      title: '[Workflow] release-check / VERIFY',
      workflowProvenance: {
        kind: 'phase',
        workflowId: 'wf-release',
        workflowName: 'release-check',
        runId: 'run-reg-2',
        triggerSource: 'manual',
        phase: { nodeId: 'verify', name: 'VERIFY', index: 2, round: 1, attempt: 1 },
      },
    });

    expect(registry.getSession(phase.id)).toMatchObject({
      parentSessionId: null,
      workflowProvenance: { kind: 'phase', runId: 'run-reg-2' },
    });
    expect(registry.searchSessionsFiltered({ workflowRunId: 'run-reg-2' }).map((session) => session.id))
      .toEqual([phase.id]);
  });
});

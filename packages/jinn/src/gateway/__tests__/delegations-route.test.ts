import { describe, it, expect, vi, type Mock } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ACTIVITY_OPERATION_HEADER,
  ACTIVITY_TOOL_HEADER,
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

// linkSession is wrapped in a passthrough spy so the codex-review finding-1
// regression can inject a failure BETWEEN spawn and link (crash-window proof).
// All other tests hit the real implementation through the spy.
vi.mock("../../work-items/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../work-items/store.js")>();
  return { ...actual, linkSession: vi.fn(actual.linkSession) };
});

/**
 * GRS-017d — POST /api/delegations, the delegation transaction.
 *
 * Route-level suite driving the REAL handleApiRequest + registry + work-item
 * store (temp JINN_HOME; engine dispatch stubbed — GRS-015 pattern). What it
 * pins, mirroring the GRS-003b-2b cron-bridge suite:
 *
 *   1. THE TRANSACTION: one call mints the work item, spawns the child session,
 *      and links the two — in-process, never 3 composed HTTP calls, so there is
 *      no client-side partial-failure window.
 *   2. MINT-BEFORE-SPAWN: a spawn failure (engine unavailable) leaves the
 *      durable `open` intent with zero linked sessions and NO session row — a
 *      recoverable record, never an orphaned session without intent.
 *   3. VALIDATION-BEFORE-MINT: a 400 (bad params, unknown employee, bad model)
 *      mints nothing — garbage requests must not litter the work-item table.
 *   4. IDENTITY: caller-parented via x-jinn-caller-session; marker-without-
 *      identity fails CLOSED (403, codex finding 2); operator (no headers)
 *      delegates parentless; explicit body.parentSessionId wins.
 */

// Isolated home for registry DB + org dir. Set BEFORE the dynamic api import.

import {
  tmpHome,
  reg,
  store,
  approvals,
  engine,
  engineRuns,
  emittedEvents,
  call,
  createOperatorSession,
  createEmployeeSession,
  managerVisibilityRequests,
  workItemCount,
} from "./delegations-route-fixtures.js";

describe("POST /api/delegations — the transaction (happy paths)", () => {
  it("preserves the implementer when dispatching an in-review Todo to its approval target", async () => {
    const item = store.createWorkItem({
      title: "Independent approval review",
      body: "Review the completed implementation without taking ownership.",
      status: "in_review",
      assignee: "qa-emp",
      department: "qa",
      createdBy: "operator",
    });
    approvals.requestApproval(item.id, {
      request: "Decide the independent quality gate",
      target: "qa-manager",
      actor: "operator",
    });

    const response = await call("POST", "/api/delegations", {
      workItemId: item.id,
      employee: "qa-manager",
      task: "Review the evidence and decide the pending approval.",
      title: "Independent quality review",
    });

    expect(response.status).toBe(201);
    expect(response.body.employee).toBe("qa-manager");
    expect(store.getWorkItem(item.id)).toMatchObject({
      assignee: "qa-emp",
      approvalTarget: "qa-manager",
      status: "in_review",
    });
    expect(reg.getSession(response.body.sessionId)).toMatchObject({
      employee: "qa-manager",
      workItemId: item.id,
    });
  });

  it("notifies the IC manager exactly once for a skip-level delegation and still dispatches to the IC", async () => {
    const managerSessionId = createEmployeeSession("qa-manager", "visibility");
    reg.updateSession(managerSessionId, { status: "running" });
    const rootSessionId = createEmployeeSession("org-root", "skip-level");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const beforeRuns = engineRuns.length;

    try {
      const request = {
        employee: "qa-emp",
        task: "Inspect a bounded incident and report the evidence.",
        title: "Bounded incident inspection",
        idempotencyKey: "skip-level-visibility-once",
      };
      const headers = {
        [CALLER_SESSION_HEADER]: rootSessionId,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(rootSessionId),
      };

      const first = await call("POST", "/api/delegations", request, headers);
      const replay = await call("POST", "/api/delegations", request, headers);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, sessionId: first.body.sessionId });
      expect(first.body.employee).toBe("qa-emp");
      expect(reg.getSession(first.body.sessionId)).toMatchObject({
        employee: "qa-emp",
        parentSessionId: rootSessionId,
      });
      // Todos v2 slice 5 (decision 7): a session delegator stamps its RESOLVED
      // employee slug, not session:<uuid>.
      expect(store.getWorkItem(first.body.workItemId)!.createdBy).toBe("org-root");
      expect(engineRuns.slice(beforeRuns)).toContainEqual(expect.objectContaining({
        sessionId: first.body.sessionId,
      }));
      expect(managerVisibilityRequests(fetchSpy, managerSessionId)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records a fallback note instead of reviving a completed manager conversation", async () => {
    const managerSessionId = createEmployeeSession("qa-manager", "completed-visibility");
    for (const managerSession of reg.searchSessionsFiltered({ employee: "qa-manager" }, 20)) {
      reg.updateSession(managerSession.id, { status: "idle", attemptOutcome: "succeeded" });
    }
    const rootSessionId = createEmployeeSession("org-root", "completed-skip-level");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const response = await call(
        "POST",
        "/api/delegations",
        {
          employee: "qa-emp",
          task: "Inspect a bounded lifecycle incident.",
          title: "Lifecycle incident inspection",
          idempotencyKey: "completed-manager-fallback",
        },
        {
          [CALLER_SESSION_HEADER]: rootSessionId,
          [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(rootSessionId),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(response.status).toBe(201);
      expect(managerVisibilityRequests(fetchSpy, managerSessionId)).toHaveLength(0);
      expect(store.listWorkItemEvents(response.body.workItemId)).toContainEqual(expect.objectContaining({
        kind: "note",
        detail: {
          managerVisibility: expect.objectContaining({
            manager: "qa-manager",
            employee: "qa-emp",
            childSessionId: response.body.sessionId,
          }),
        },
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not generate manager visibility for a direct-report delegation", async () => {
    const managerSessionId = createEmployeeSession("qa-manager", "direct-report");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const response = await call(
        "POST",
        "/api/delegations",
        { employee: "qa-emp", task: "Run a direct-report check.", title: "Direct-report check" },
        {
          [CALLER_SESSION_HEADER]: managerSessionId,
          [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(managerSessionId),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(response.status).toBe(201);
      expect(response.body.employee).toBe("qa-emp");
      expect(reg.getSession(response.body.sessionId)?.employee).toBe("qa-emp");
      expect(managerVisibilityRequests(fetchSpy, managerSessionId)).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("one call mints + spawns + links: employee delegation, operator caller (parentless)", async () => {
    const resp = await call("POST", "/api/delegations", {
      employee: "qa-emp",
      task: "Audit the QA fixtures and report gaps.",
      title: "QA fixture audit",
    });
    expect(resp.status).toBe(201);
    const { workItemId, sessionId } = resp.body as { workItemId: string; sessionId: string };
    // Todos v2: the delegation lands in qa-emp's department, so it mints under
    // the department's own prefix ("qa" → QAX), not the company namespace.
    expect(workItemId).toMatch(/^QAX-/);
    expect(sessionId).toBeTruthy();

    // The durable intent record, shaped from the delegation.
    const item = store.getWorkItem(workItemId)!;
    expect(item.title).toBe("QA fixture audit");
    expect(item.body).toBe("Audit the QA fixtures and report gaps.");
    expect(item.source).toBe("delegation");
    expect(item.sourceRef).toMatch(/^delegate:operator:/);
    expect(item.assignee).toBe("qa-emp");
    expect(item.department).toBe("qa");
    // Todos v2 slice 5 (decision 7): the DELEGATING caller is the creator.
    expect(item.createdBy).toBe("operator");
    // Reconciled AFTER the link: the running linked session derives `active`.
    expect(item.status).toBe("executing");

    // The execution attempt, linked + employee-resolved.
    const session = reg.getSession(sessionId)!;
    expect(session.employee).toBe("qa-emp");
    expect(session.engine).toBe("codex");
    expect(session.model).toBe("gpt-5.5");
    expect(session.parentSessionId).toBeFalsy(); // operator caller → parentless
    expect(session.status).toBe("running");

    // Link is queryable through the existing surface.
    const linked = await call("GET", `/api/work-items/${workItemId}/sessions`);
    expect(linked.status).toBe(200);
    expect((linked.body as Array<{ id: string }>).map((s) => s.id)).toContain(sessionId);

    const companyEvent = emittedEvents.find((entry) =>
      entry.event === "company:changed" && entry.payload.id === workItemId,
    );
    expect(companyEvent?.payload).not.toHaveProperty("sessionId");
    expect(resp.body).not.toHaveProperty("activityReceiptId");
    expect(reg.getMessages(sessionId).flatMap((message) => message.blocks ?? []))
      .not.toContainEqual(expect.objectContaining({ id: `todo:${workItemId}` }));
  });

  it("a session caller is auto-parent-linked and stamped into the sourceRef", async () => {
    const parentId = await createOperatorSession("I am the delegating COO");
    const resp = await call(
      "POST",
      "/api/delegations",
      { employee: "qa-emp", task: "child chore", title: "child chore" },
      { [CALLER_SESSION_HEADER]: parentId, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(parentId) },
    );
    expect(resp.status).toBe(201);
    const session = reg.getSession(resp.body.sessionId)!;
    expect(session.parentSessionId).toBe(parentId);
    const item = store.getWorkItem(resp.body.workItemId)!;
    expect(item.sourceRef).toMatch(new RegExp(`^delegate:${parentId}:`));

    const parentMessages = reg.getMessages(parentId);
    const handoff = parentMessages.flatMap((message) => message.blocks ?? []).find((block) => block.id === `dg-${resp.body.workItemId}`);
    expect(handoff).toMatchObject({
      type: "delegation",
      status: "running",
      payload: {
        employee: "qa-emp",
        employeeDisplay: "QA Employee",
        title: "child chore",
        childSessionId: resp.body.sessionId,
        workItemId: resp.body.workItemId,
      },
    });
    expect(typeof handoff?.payload.dispatchedAt).toBe("number");
    expect(parentMessages.flatMap((message) => message.blocks ?? []).filter((block) => block.id === `todo:${resp.body.workItemId}`)).toEqual([]);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "session:delta",
      payload: expect.objectContaining({
        sessionId: parentId,
        type: "block",
        block: expect.objectContaining({ op: "put" }),
      }),
    }));
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({
        entity: "todo",
        action: "delegated",
        id: resp.body.workItemId,
        sessionId: parentId,
      }),
    }));
    expect(resp.body).not.toHaveProperty("activityReceiptId");
  });

  it("keeps delegate_task receipt correlation separate from authenticated event provenance", async () => {
    const parentId = await createOperatorSession("I am delegating through the built-in tool");
    const resp = await call(
      "POST",
      "/api/delegations",
      { employee: "qa-emp", task: "correlated child chore", title: "correlated child chore" },
      {
        [CALLER_SESSION_HEADER]: parentId,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(parentId),
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [ACTIVITY_OPERATION_HEADER]: "123e4567-e89b-42d3-a456-426614174000",
        [ACTIVITY_TOOL_HEADER]: "delegate_task",
      },
    );

    expect(resp.status).toBe(201);
    const parentBlocks = reg.getMessages(parentId).flatMap((message) => message.blocks ?? []);
    expect(parentBlocks).toContainEqual(expect.objectContaining({
      id: `dg-${resp.body.workItemId}`,
      type: "delegation",
    }));
    expect(parentBlocks).not.toContainEqual(expect.objectContaining({ id: `todo:${resp.body.workItemId}` }));
    expect(resp.body).not.toHaveProperty("activityReceiptId");
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({
        entity: "todo",
        action: "delegated",
        id: resp.body.workItemId,
        sessionId: parentId,
      }),
    }));
  });

  it("rejects an unverified caller header before delegation or event provenance", async () => {
    const claimedParentId = await createOperatorSession("This identity must be verified");
    const itemsBefore = workItemCount();
    const eventsBefore = emittedEvents.length;
    const resp = await call(
      "POST",
      "/api/delegations",
      { employee: "qa-emp", task: "operator-owned child chore", title: "operator-owned child chore" },
      { [CALLER_SESSION_HEADER]: claimedParentId },
    );

    expect(resp.status).toBe(403);
    expect(resp.body.error).toMatch(/caller identity unavailable/i);
    expect(workItemCount()).toBe(itemsBefore);
    expect(emittedEvents).toHaveLength(eventsBefore);
  });

  it("records a parent follow-up as a dispatch block with exact fallback parity", async () => {
    const parentId = await createOperatorSession("delegate, then follow up");
    const delegated = await call(
      "POST",
      "/api/delegations",
      { employee: "qa-emp", task: "Check the responsive layout", title: "Responsive layout" },
      { [CALLER_SESSION_HEADER]: parentId, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(parentId) },
    );
    const message = "x".repeat(230);
    const preview = `${"x".repeat(220)}…`;

    const followUp = await call(
      "POST",
      `/api/sessions/${delegated.body.sessionId}/message`,
      { message },
      { [CALLER_SESSION_HEADER]: parentId, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(parentId) },
    );

    expect(followUp.status).toBe(200);
    const dispatchMessage = reg.getMessages(parentId).find((candidate) =>
      candidate.blocks?.some((block) => block.type === "dispatch"),
    );
    const dispatch = dispatchMessage?.blocks?.find((block) => block.type === "dispatch");
    const targetMessage = reg.getMessages(delegated.body.sessionId).find((candidate) =>
      candidate.role === "notification" && candidate.content.includes(preview),
    );
    expect(dispatchMessage?.content).toBe(`Followed up: ${preview}`);
    expect(dispatch).toMatchObject({
      type: "dispatch",
      version: 1,
      status: "done",
      payload: {
        targetSessionId: delegated.body.sessionId,
        employee: "qa-emp",
        employeeDisplay: "QA Employee",
        preview,
      },
    });
    expect(targetMessage?.id).toBeTruthy();
    expect(dispatch?.id).toBe(`dp-${targetMessage?.id}`);
    expect(typeof dispatch?.payload.sentAt).toBe("number");
    expect(emittedEvents).toContainEqual({
      event: "session:delta",
      payload: {
        sessionId: parentId,
        type: "block",
        content: `Followed up: ${preview}`,
        block: { op: "put", block: dispatch },
      },
    });
  });

  it("does not record dispatch blocks for lateral sends outside a parent-child pair", async () => {
    const callerId = createEmployeeSession("qa-manager", "lateral-caller");
    const targetId = createEmployeeSession("qa-emp", "lateral-target");

    const sent = await call(
      "POST",
      `/api/sessions/${targetId}/message`,
      { message: "Review this unrelated thread." },
      { [CALLER_SESSION_HEADER]: callerId, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerId) },
    );

    expect(sent.status).toBe(200);
    expect(reg.getMessages(callerId).flatMap((message) => message.blocks ?? []))
      .not.toContainEqual(expect.objectContaining({ type: "dispatch" }));
    expect(reg.getMessages(targetId).find((message) => message.role === "notification")).toMatchObject({
      content: "📨 From qa-manager: Review this unrelated thread.",
      meta: {
        kind: "agent-relay",
        fromSessionId: callerId,
        fromLabel: "qa-manager",
        fromEmployee: "qa-manager",
        hops: 1,
        maxHops: 12,
        fullMessage: "Review this unrelated thread.",
      },
    });
  });

  it("persists callback metadata and patches the durable handoff block", async () => {
    const parentId = await createOperatorSession("delegate and receive a callback");
    const delegated = await call(
      "POST",
      "/api/delegations",
      { employee: "qa-emp", task: "Review the release", title: "Release review" },
      { [CALLER_SESSION_HEADER]: parentId, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(parentId) },
    );
    const repliedAt = Date.now();
    const block = {
      op: "patch",
      block: {
        id: `dg-${delegated.body.workItemId}`,
        type: "delegation",
        version: 1,
        status: "done",
        payload: { repliedAt },
      },
    };
    const meta = {
      kind: "child-reply",
      employee: "qa-emp",
      employeeDisplay: "QA Employee",
      childSessionId: delegated.body.sessionId,
      fullMessage: "Release is ready with durable details.",
    };

    const callback = await call("POST", `/api/sessions/${parentId}/message`, {
      message: "engine-facing callback",
      role: "notification",
      displayMessage: "📩 QA Employee replied\nRelease is ready.",
      meta,
      block,
    });
    expect(callback.status).toBe(200);

    const messages = reg.getMessages(parentId);
    expect(messages.find((message) => message.role === "notification")).toMatchObject({ meta });
    expect(messages.flatMap((message) => message.blocks ?? []).find((candidate) => candidate.id === block.block.id)).toMatchObject({
      status: "done",
      payload: expect.objectContaining({ repliedAt }),
    });
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "session:notification",
      payload: expect.objectContaining({ message: "📩 QA Employee replied\nRelease is ready.", meta }),
    }));
  });

  it("an explicit body parentSessionId wins over the header (internal callers unchanged)", async () => {
    const a = await createOperatorSession("a");
    const b = await createOperatorSession("b");
    const resp = await call(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "t", parentSessionId: b },
      { [CALLER_SESSION_HEADER]: a, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(a) },
    );
    expect(resp.status).toBe(201);
    expect(reg.getSession(resp.body.sessionId)!.parentSessionId).toBe(b);
  });

  it("a tool-marked delegation with an unknown caller id is refused fail-closed", async () => {
    const resp = await call(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "t" },
      { "x-jinn-caller-session": "no-such-session", "x-jinn-tool-call": "jinn-mcp" },
    );
    expect(resp.status).toBe(403);
    expect(resp.body.error).toMatch(/caller identity unavailable/i);
  });

  it("a bare-engine delegation works without an employee, and the title defaults from the task", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "One specific chore\nwith detail lines" });
    expect(resp.status).toBe(201);
    const item = store.getWorkItem(resp.body.workItemId)!;
    expect(item.assignee).toBeNull();
    expect(item.title).toContain("One specific chore");
  });

  it("re-running linkSession for the same pair is idempotent — no updated_at churn", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "idem", title: "idem" });
    expect(resp.status).toBe(201);
    const before = store.getWorkItem(resp.body.workItemId)!.updatedAt;
    store.linkSession(resp.body.workItemId, resp.body.sessionId); // the re-link
    expect(store.getWorkItem(resp.body.workItemId)!.updatedAt).toBe(before);
  });

  it("links an existing caller-owned Todo instead of minting a duplicate", async () => {
    const parentId = await createOperatorSession("canonical Todo owner");
    const item = store.createWorkItem({
      title: "Canonical objective",
      body: "Preserve this brief",
      source: "session",
      sourceRef: `session:${parentId}:canonical`,
    });
    const before = workItemCount();

    const resp = await call(
      "POST",
      "/api/delegations",
      { workItemId: item.id, engine: "codex", task: "Execute the canonical objective" },
      { [CALLER_SESSION_HEADER]: parentId, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(parentId) },
    );

    expect(resp.status).toBe(201);
    expect(resp.body.workItemId).toBe(item.id);
    expect(workItemCount()).toBe(before);
    expect(reg.getSession(resp.body.sessionId)?.workItemId).toBe(item.id);
    expect(reg.getSession(resp.body.sessionId)?.transportMeta).toMatchObject({
      delegationCompletionTracked: true,
    });
    let delegatedRun: Record<string, unknown> | undefined;
    for (let i = 0; i < 1000 && !delegatedRun; i++) {
      delegatedRun = engineRuns.find((run) => run.sessionId === resp.body.sessionId);
      if (!delegatedRun) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const dispatchedPrompt = String(delegatedRun?.prompt ?? "");
    expect(dispatchedPrompt).toContain("Execute the canonical objective");
    expect(dispatchedPrompt).toContain(`ID: ${item.id}`);
    expect(dispatchedPrompt).toContain("Title: Canonical objective");
    expect(dispatchedPrompt).toContain("Objective and evidence:\nPreserve this brief");
    expect(store.getWorkItem(item.id)).toMatchObject({
      title: "Canonical objective",
      body: "Preserve this brief",
      status: "executing",
    });
  });

  it("replays the original Todo/session for the same caller idempotency key", async () => {
    const beforeItems = workItemCount();
    const beforeSessions = reg.listSessions().length;
    const request = { engine: "codex", task: "Exactly once", idempotencyKey: "delegate-once-42" };

    const first = await call("POST", "/api/delegations", request);
    const second = await call("POST", "/api/delegations", request);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      workItemId: first.body.workItemId,
      sessionId: first.body.sessionId,
      replayed: true,
    });
    expect(workItemCount()).toBe(beforeItems + 1);
    expect(reg.listSessions().length).toBe(beforeSessions + 1);
  });

  it("passes managed attachments through to the delegated child engine turn", async () => {
    const filePath = path.join(tmpHome, "delegation-context.txt");
    fs.writeFileSync(filePath, "delegated context");
    reg.insertFile({
      id: "delegation-file",
      filename: "delegation-context.txt",
      size: fs.statSync(filePath).size,
      mimetype: "text/plain",
      path: filePath,
    });

    const resp = await call("POST", "/api/delegations", {
      engine: "codex",
      task: "Read the attachment",
      attachments: ["delegation-file"],
    });
    expect(resp.status).toBe(201);

    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 1000 && !run; i++) {
      run = engineRuns.find((candidate) => candidate.sessionId === resp.body.sessionId);
      if (!run) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(run?.attachments).toEqual([filePath]);
    expect(reg.getMessages(resp.body.sessionId)[0]?.media).toMatchObject([
      { name: "delegation-context.txt", mimeType: "text/plain" },
    ]);
  });

  it("rejects missing or stale managed attachments before creating a Todo or session", async () => {
    const stalePath = path.join(tmpHome, "deleted-delegation-context.txt");
    reg.insertFile({
      id: "stale-delegation-file",
      filename: "deleted-delegation-context.txt",
      size: 19,
      mimetype: "text/plain",
      path: stalePath,
    });
    const beforeItems = workItemCount();
    const beforeSessions = reg.listSessions().length;

    const resp = await call("POST", "/api/delegations", {
      engine: "codex",
      task: "Do not run without every attachment",
      attachments: ["missing-delegation-file", "stale-delegation-file"],
    });

    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/could not be resolved/i);
    expect(resp.body.unresolvedAttachments).toEqual([
      "missing-delegation-file",
      "stale-delegation-file",
    ]);
    expect(workItemCount()).toBe(beforeItems);
    expect(reg.listSessions().length).toBe(beforeSessions);
  });
});

describe("web dispatch path — the GRS-017a identity seam reaches the engine (QA catch)", () => {
  it("engine.run receives resolvedMcp with JINN_SESSION_ID stamped on the jinn server for the DELEGATED session", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "identity seam check", title: "seam" });
    expect(resp.status).toBe(201);
    const sessionId = resp.body.sessionId as string;
    // dispatchWebSessionRun is fire-and-forget; wait for the stub engine turn.
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 1000 && !run; i++) {
      run = engineRuns.find((r) => r.sessionId === sessionId);
      if (!run) await new Promise((r) => setTimeout(r, 10));
    }
    expect(run).toBeDefined();
    const resolved = run!.resolvedMcp as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(resolved).toBeDefined();
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_ID).toBe(sessionId);
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_CAPABILITY).toEqual(expect.any(String));
  });

  it("engine.run receives the stamped identity for plain POST /api/sessions spawns too (same missed block)", async () => {
    const id = await createOperatorSession("seam check for plain spawns");
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 1000 && !run; i++) {
      run = engineRuns.find((r) => r.sessionId === id);
      if (!run) await new Promise((r) => setTimeout(r, 10));
    }
    expect(run).toBeDefined();
    const resolved = run!.resolvedMcp as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_ID).toBe(id);
    expect(resolved.mcpServers.jinn.env?.JINN_SESSION_CAPABILITY).toEqual(expect.any(String));
  });
});

describe("POST /api/delegations — link-before-dispatch (codex review finding 1)", () => {
  it("the engine turn only starts AFTER the work item ↔ session link is durable", async () => {
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "ordering pin", title: "ordering pin" });
    expect(resp.status).toBe(201);
    const { workItemId, sessionId } = resp.body as { workItemId: string; sessionId: string };
    let run: Record<string, unknown> | undefined;
    for (let i = 0; i < 1000 && !run; i++) {
      run = engineRuns.find((r) => r.sessionId === sessionId);
      if (!run) await new Promise((r) => setTimeout(r, 10));
    }
    expect(run).toBeDefined();
    expect(run!.workItemIdAtRunStart).toBe(workItemId);
  });

  it("a failure injected BETWEEN spawn and link halts the transaction: nothing dispatched, no orphan, intent preserved", async () => {
    (store.linkSession as Mock).mockImplementationOnce(() => {
      throw new Error("injected crash between spawn and link");
    });
    const resp = await call("POST", "/api/delegations", { engine: "codex", task: "crash window", title: "crash window" });

    // The route reports the partial failure with BOTH preserved ids.
    expect(resp.status).toBe(500);
    const { workItemId, sessionId } = resp.body as { workItemId: string; sessionId: string };
    expect(workItemId).toMatch(/^JIN-/);
    expect(sessionId).toBeTruthy();
    expect(String(resp.body.error)).toMatch(/link/i);

    // No orphan: the work item survives as recoverable `backlog` intent…
    expect(store.getWorkItem(workItemId)!.status).toBe("backlog");
    // …the session row exists but was NEVER marked running or dispatched…
    expect(reg.getSession(sessionId)!.status).toBe("idle");
    await new Promise((r) => setTimeout(r, 50)); // give any (wrong) dispatch a chance to surface
    expect(engineRuns.find((r) => r.sessionId === sessionId)).toBeUndefined();
    // …and it is re-linkable (linkSession is idempotent-in-writes and the rows are intact).
    store.linkSession(workItemId, sessionId);
    expect(reg.listSessionsByWorkItem(workItemId).map((s) => s.id)).toContain(sessionId);
  });
});

describe("POST /api/delegations — body shape guard (codex review finding 2)", () => {
  it("a JSON null body is a structured 400, not a 500 TypeError, and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", null);
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/JSON object/i);
    expect(workItemCount()).toBe(before);
  });

  it("a JSON array body is a structured 400 too", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", []);
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/JSON object/i);
    expect(workItemCount()).toBe(before);
  });
});

describe("POST /api/delegations — mint-before-spawn ordering (the GRS-003b-2b contract)", () => {
  it("a spawn failure preserves the minted OPEN intent: no session row, no orphan, recoverable item", async () => {
    engine.available = false;
    try {
      const sessionsBefore = reg.listSessions().length;
      const resp = await call("POST", "/api/delegations", { engine: "codex", task: "doomed chore", title: "doomed" });
      // The spawn failed, but the response still carries the preserved intent.
      expect(resp.status).toBe(502);
      expect(resp.body.workItemId).toMatch(/^JIN-/);
      expect(String(resp.body.error)).toMatch(/engine/i);

      const item = store.getWorkItem(resp.body.workItemId)!;
      expect(item.status).toBe("backlog"); // durable intent, reconciler-visible
      expect(reg.listSessionsByWorkItem(item.id)).toHaveLength(0); // zero linked attempts
      expect(reg.listSessions().length).toBe(sessionsBefore); // no orphaned session row
    } finally {
      engine.available = true;
    }
  });
});

describe("POST /api/delegations — validation BEFORE mint (400s never litter the table)", () => {
  it.each([
    ["session spawn", "/api/sessions", { employee: "codex-model-emp", model: "gpt-5.6-sol", prompt: "run the platform check" }],
    ["delegation", "/api/delegations", { employee: "codex-model-emp", model: "gpt-5.6-sol", task: "run the platform check" }],
  ])("resolves the employee engine before validating an explicit model for %s", async (_label, route, body) => {
    const resp = await call("POST", route, body);
    expect(resp.status).toBe(201);
    expect(resp.body).toMatchObject({ employee: "codex-model-emp", engine: "codex", model: "gpt-5.6-sol" });
  });

  it.each([
    ["session spawn", "/api/sessions", { employee: "codex-model-emp", model: "not-a-codex-model", prompt: "run the platform check" }],
    ["delegation", "/api/delegations", { employee: "codex-model-emp", model: "not-a-codex-model", task: "run the platform check" }],
  ])("names the resolved employee engine in model validation errors for %s", async (_label, route, body) => {
    const resp = await call("POST", route, body);
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/unknown model "not-a-codex-model" for engine "codex"/i);
    expect(String(resp.body.error)).not.toMatch(/engine "claude"/i);
  });

  it("fails closed when a requested spawn employee cannot be resolved instead of validating against the gateway default", async () => {
    const resp = await call("POST", "/api/sessions", {
      employee: "temporarily-missing",
      model: "opus",
      prompt: "do not silently become a Claude session",
    });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/unknown employee "temporarily-missing"/i);
  });

  it("missing task mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { employee: "qa-emp" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/task/i);
    expect(workItemCount()).toBe(before);
  });

  it("neither employee nor engine mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { task: "t" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/employee or engine/i);
    expect(workItemCount()).toBe(before);
  });

  it("an unknown employee is a readable 400 naming the discovery surface, and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { employee: "nobody-here", task: "t" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/unknown employee "nobody-here"/i);
    expect(String(resp.body.error)).toMatch(/\/api\/org/);
    expect(workItemCount()).toBe(before);
  });

  it("an invalid model is the structured selection 400 passed through, and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { engine: "codex", model: "not-a-model", task: "t" });
    expect(resp.status).toBe(400);
    expect(String(resp.body.error)).toMatch(/unknown model/i);
    expect(workItemCount()).toBe(before);
  });

  it("an employee whose CONFIGURED model isn't registered yields the clear employee-named error, and mints nothing (GRS-017f)", async () => {
    const before = workItemCount();
    const resp = await call("POST", "/api/delegations", { employee: "stale-emp", task: "t" });
    expect(resp.status).toBe(400);
    const err = String(resp.body.error);
    expect(err).toMatch(/stale-emp/); // names the employee
    expect(err).toMatch(/legacy-sonnet/); // names its configured model
    expect(err).toMatch(/gpt-5\.5/); // names the known-model set
    expect(err).toMatch(/config\.yaml/); // names the register-in-config fix
    expect(err).toMatch(/stale-emp\.yaml/); // points at the employee YAML fix
    expect(err).not.toMatch(/^unknown model/); // NOT the cryptic bare-engine string
    expect(workItemCount()).toBe(before);
  });

  it("POST /api/sessions surfaces the SAME employee-named error for the same misconfigured employee — spawn/delegate consistency (GRS-017f)", async () => {
    const resp = await call("POST", "/api/sessions", { employee: "stale-emp", prompt: "hi" });
    expect(resp.status).toBe(400);
    const err = String(resp.body.error);
    expect(err).toMatch(/stale-emp/);
    expect(err).toMatch(/legacy-sonnet/);
    expect(err).toMatch(/gpt-5\.5/);
  });
});

describe("POST /api/delegations — fail-closed tool identity (codex finding 2)", () => {
  it("the tool-origin marker WITHOUT an identity is refused (403) and mints nothing", async () => {
    const before = workItemCount();
    const resp = await call(
      "POST",
      "/api/delegations",
      { engine: "codex", task: "t" },
      { "x-jinn-tool-call": "jinn-mcp" },
    );
    expect(resp.status).toBe(403);
    expect(String(resp.body.error)).toMatch(/caller identity unavailable/i);
    expect(workItemCount()).toBe(before);
  });
});

/* A session that can mint a child whose employee IS the org root holds that
 * root's operator-delegated authority in two hops. Both routes that mint a
 * session refuse it; the operator surface, which already holds that authority,
 * does not change. */
describe("spawn/delegate as the employee-hierarchy root", () => {
  const rootYaml = path.join(tmpHome, "org", "org-root.yaml");

  function sessionHeaders(sessionId: string): Record<string, string> {
    return {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: sessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
    };
  }

  it.each([
    ["POST", "/api/sessions", { prompt: "arm it", employee: "org-root" }],
    ["POST", "/api/delegations", { employee: "org-root", task: "arm it", title: "arm it" }],
  ] as const)("refuses an employee session %s %s and names what to do instead", async (method, route, body) => {
    const caller = createEmployeeSession("qa-emp", `as-root-${route.replace(/\W/g, "")}`);
    const before = workItemCount();

    const resp = await call(method, route, body, sessionHeaders(caller));

    expect(resp.status).toBe(403);
    expect(String(resp.body.error)).toMatch(/cannot run work as "org-root", the employee-hierarchy root/);
    expect(String(resp.body.error)).toMatch(/request an approval or escalate the Todo/);
    expect(workItemCount()).toBe(before);
  });

  it("still lets the operator surface spawn as the root", async () => {
    const resp = await call("POST", "/api/sessions", { prompt: "operator arms it", employee: "org-root" });

    expect(resp.status).toBe(201);
    expect(reg.getSession(resp.body.id)).toMatchObject({ employee: "org-root" });
  });

  it("leaves an employee session's spawn as any non-root employee alone", async () => {
    const caller = createEmployeeSession("qa-manager", "as-nonroot");

    const resp = await call("POST", "/api/sessions", { prompt: "ordinary", employee: "qa-emp" }, sessionHeaders(caller));

    expect(resp.status).toBe(201);
    expect(reg.getSession(resp.body.id)).toMatchObject({ employee: "qa-emp", parentSessionId: caller });
  });

  // With no executive in the org the root resolves VIRTUAL — a name no employee
  // holds — so there is nothing to impersonate and the guard refuses nothing.
  it("refuses nothing when the org has no employee at its top", async () => {
    const saved = fs.readFileSync(rootYaml, "utf-8");
    fs.rmSync(rootYaml);
    try {
      const caller = createEmployeeSession("qa-emp", "virtual-root");

      const employee = await call("POST", "/api/sessions", { prompt: "ordinary", employee: "qa-emp" }, sessionHeaders(caller));
      expect(employee.status).toBe(201);

      // "Jinn" is the virtual root here. It stays refused for the ordinary
      // reason — no employee holds that name — and never through the root guard,
      // which would otherwise turn every unknown name into an authority error.
      const portal = await call("POST", "/api/sessions", { prompt: "portal", employee: "Jinn" }, sessionHeaders(caller));
      expect(portal.status).toBe(400);
      expect(String(portal.body.error)).toMatch(/unknown employee "Jinn"/);
    } finally {
      fs.writeFileSync(rootYaml, saved);
    }
  });
});

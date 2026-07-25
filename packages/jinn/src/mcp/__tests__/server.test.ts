import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTools,
  gatewayGet,
  handleMcpRequest,
  JinnMcpToolError,
  type JinnMcpContext,
  type JinnMcpTool,
} from "../server.js";

/**
 * GRS-012b — the jinn MCP stdio server.
 *
 * The stdio loop (runJinnMcpServer) is a thin wrapper; the protocol logic lives in
 * the pure `handleMcpRequest` + the tool handlers, which is what these tests pin:
 * the JSON-RPC handshake, tool discovery, a real tool call (via a stub fetch), and
 * the error surfaces. No network, no subprocess.
 */

/** Build a context whose fetch returns a canned response for one URL. */
function stubCtx(
  responder: (url: string) => { status: number; body: unknown },
): JinnMcpContext {
  const fetchFn = (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = responder(url);
    return {
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    gatewayUrl: "http://127.0.0.1:7777",
    token: "t0ken",
    callerSessionId: "session-test",
    sessionCapability: "cap-test",
    fetchFn,
  };
}

describe("gatewayGet", () => {
  it("joins base + path, sends bearer auth, and parses JSON", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const ctx: JinnMcpContext = {
      gatewayUrl: "http://127.0.0.1:7788/",
      token: "abc",
      fetchFn: (async (input: string | URL, init?: RequestInit) => {
        seenUrl = typeof input === "string" ? input : input.toString();
        seenAuth = (init?.headers as Record<string, string>)?.authorization;
        return { status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
      }) as unknown as typeof fetch,
    };
    const { status, body } = await gatewayGet(ctx, "/api/org");
    // Trailing slash on base is normalized (no `//api`).
    expect(seenUrl).toBe("http://127.0.0.1:7788/api/org");
    expect(seenAuth).toBe("Bearer abc");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("omits the auth header when no token (sandbox auth-disabled)", async () => {
    let seenAuth: string | undefined = "unset";
    const ctx: JinnMcpContext = {
      gatewayUrl: "http://127.0.0.1:7799",
      fetchFn: (async (_input: string | URL, init?: RequestInit) => {
        seenAuth = (init?.headers as Record<string, string>)?.authorization;
        return { status: 200, text: async () => "[]" } as unknown as Response;
      }) as unknown as typeof fetch,
    };
    await gatewayGet(ctx, "/api/org");
    expect(seenAuth).toBeUndefined();
  });

  it("returns the raw text body when the response is not JSON", async () => {
    const ctx = stubCtx(() => ({ status: 500, body: "boom" }));
    const { status, body } = await gatewayGet(ctx, "/api/org");
    expect(status).toBe(500);
    expect(body).toBe("boom");
  });
});

describe("buildTools", () => {
  it("exposes exactly the admitted org/session/reference/knowledge/delegation/Todo/workflow groups (scope discipline; NO gate-resolve, NO session-delete, NO cancel Todo tool)", () => {
    const names = buildTools().map((t) => t.name).sort();
    expect(names).toEqual([
      "archive_work_item",
      "assign_work_item",
      "attach_to_work_item",
      "cancel_workflow_run",
      "comment_work_item",
      "cost_report",
      "create_note",
      "create_work_item",
      "create_workflow",
      "decide_work_item_approval",
      "decide_workflow_approval",
      "delegate_task",
      "disable_workflow",
      "duplicate_workflow",
      "edit_work_item",
      "enable_workflow",
      "escalate_work_item_approval",
      "find_employees",
      "fire_workflow_event",
      "get_cron_run_history",
      "get_employee",
      "get_message_context",
      "get_work_item",
      "get_work_item_tree",
      "get_workflow",
      "get_workflow_run",
      "label_work_item",
      "link_work_items",
      "list_cron_jobs",
      "list_departments",
      "list_employees",
      "list_files",
      "list_labels",
      "list_notes",
      "list_sessions",
      "list_work_item_attachments",
      "list_work_item_comments",
      "list_work_items",
      "list_workflow_runs",
      "list_workflows",
      "publish_attachment",
      "read_file",
      "read_knowledge",
      "read_note",
      "read_session",
      "request_work_item_approval",
      "rerun_workflow_run",
      "retire_workflow",
      "retry_workflow_node",
      "review_verdict",
      "search_knowledge",
      "search_messages",
      "search_sessions",
      "search_work_items",
      "send_connector_message",
      "send_to_session",
      "spawn_session",
      "start_workflow_run",
      "stop_session",
      "unlink_work_items",
      "update_note",
      "update_work_item",
      "update_workflow",
    ]);
    expect(names.some((name) => name.startsWith("jinn_"))).toBe(false);
  });

  it("adds attempt completion controls only to the workflow-attempt belt", () => {
    const names = buildTools({ workflowAttempt: true }).map((tool) => tool.name);
    expect(names).toContain("workflow_submit_output");
    expect(names).toContain("workflow_extend_deadline");
    expect(buildTools().map((tool) => tool.name)).not.toContain("workflow_submit_output");
  });

  it("get_workflow declares workflowId as required", () => {
    const wf = buildTools().find((t) => t.name === "get_workflow")!;
    expect(wf.inputSchema.required).toEqual(["workflowId"]);
  });
});

describe("handleMcpRequest — protocol", () => {
  const tools = buildTools();
  const ctx = stubCtx(() => ({ status: 200, body: {} }));

  it("initialize echoes the client protocol version + advertises tools + serverInfo", async () => {
    const resp = await handleMcpRequest(
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      tools,
      ctx,
    );
    expect(resp).not.toBeNull();
    const result = resp!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} });
    expect((result.serverInfo as Record<string, unknown>).name).toBe("jinn");
  });

  it("initialize falls back to a default protocol version when the client omits one", async () => {
    const resp = await handleMcpRequest({ id: 1, method: "initialize", params: {} }, tools, ctx);
    expect((resp!.result as Record<string, unknown>).protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("notifications/initialized produces no response", async () => {
    const resp = await handleMcpRequest({ method: "notifications/initialized" }, tools, ctx);
    expect(resp).toBeNull();
  });

  it("a no-id message (notification) gets NO response even for a normal method", async () => {
    // JSON-RPC: absent id ⇒ notification ⇒ must never be answered, whatever the method.
    expect(await handleMcpRequest({ method: "ping" }, tools, ctx)).toBeNull();
    expect(await handleMcpRequest({ method: "tools/list" }, tools, ctx)).toBeNull();
  });

  it("ping replies with an empty result", async () => {
    const resp = await handleMcpRequest({ id: 7, method: "ping" }, tools, ctx);
    expect(resp).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("tools/list returns every tool with name/description/inputSchema", async () => {
    const resp = await handleMcpRequest({ id: 2, method: "tools/list" }, tools, ctx);
    const list = (resp!.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(list.map((t) => t.name)).toEqual(buildTools().map((t) => t.name));
    for (const t of list) expect(t).toHaveProperty("inputSchema");
  });

  it("unknown method (with id) yields a -32601 protocol error", async () => {
    const resp = await handleMcpRequest({ id: 9, method: "does/notExist" }, tools, ctx);
    expect(resp!.error?.code).toBe(-32601);
  });
});

describe("handleMcpRequest — tools/call", () => {
  it("assigns one deterministic activity operation identity to each tools/call", async () => {
    const seen: Array<{ id: string; toolName: string } | undefined> = [];
    const tool: JinnMcpTool = {
      name: "mutate_thing",
      description: "mutation fixture",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, callCtx) => {
        seen.push(callCtx.activityOperation);
        return { activityReceiptId: "todo:wi_release" };
      },
    };

    const [first, second] = await Promise.all([
      handleMcpRequest({ id: 41, method: "tools/call", params: { name: tool.name, arguments: {} } }, [tool], stubCtx(() => ({ status: 200, body: {} }))),
      handleMcpRequest({ id: 42, method: "tools/call", params: { name: tool.name, arguments: {} } }, [tool], stubCtx(() => ({ status: 200, body: {} }))),
    ]);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.toolName).toBe("mutate_thing");
    expect(seen[1]?.toolName).toBe("mutate_thing");
    expect(seen[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(seen[1]?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(seen[0]?.id).not.toBe(seen[1]?.id);
    expect(JSON.parse((((first!.result as any).content[0].text) as string))).toEqual({ activityReceiptId: "todo:wi_release" });
    expect(JSON.parse((((second!.result as any).content[0].text) as string))).toEqual({ activityReceiptId: "todo:wi_release" });
  });

  it("compiles every advertised registry schema or supplies its shared runtime schema", () => {
    const tools = buildTools();
    expect(tools).toHaveLength(63);
    for (const tool of tools) {
      expect(() => tool.runtimeSchema ?? z.fromJSONSchema({ ...tool.inputSchema, additionalProperties: false } as Parameters<typeof z.fromJSONSchema>[0]), tool.name).not.toThrow();
    }
  });
  it.each([
    ["missing required", {}],
    ["wrong type", { count: "one" }],
    ["unknown field", { count: 1, mysteryMode: true }],
  ])("rejects %s arguments before invoking the handler", async (_label, args) => {
    let calls = 0;
    const tool: JinnMcpTool = {
      name: "strict-tool",
      description: "strict input",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { count: { type: "number" } },
        required: ["count"],
      },
      handler: async () => {
        calls += 1;
        return { ok: true };
      },
    };

    const response = await handleMcpRequest(
      { id: 30, method: "tools/call", params: { name: tool.name, arguments: args } },
      [tool],
      stubCtx(() => ({ status: 200, body: {} })),
    );
    const result = response!.result as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid arguments/i);
    expect(calls).toBe(0);
  });

  it("list_employees returns real gateway data as text content", async () => {
    const org = { employees: [{ name: "chief-of-staff", rank: "manager" }] };
    const ctx = stubCtx((url) => {
      expect(url).toBe("http://127.0.0.1:7777/api/org");
      return { status: 200, body: org };
    });
    const resp = await handleMcpRequest(
      { id: 3, method: "tools/call", params: { name: "list_employees", arguments: {} } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual(org);
  });

  it("get_workflow encodes the id into the canonical v2 path", async () => {
    const def = { id: "sample-autonomy", title: "Sample Autonomy", version: 3, nodes: [], edges: [] };
    const ctx = stubCtx((url) => {
      expect(url).toBe("http://127.0.0.1:7777/api/workflows/sample-autonomy");
      return { status: 200, body: def };
    });
    const resp = await handleMcpRequest(
      { id: 4, method: "tools/call", params: { name: "get_workflow", arguments: { workflowId: "sample-autonomy" } } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(def);
  });

  it("serializes structured tool results as compact JSON text", async () => {
    const tool: JinnMcpTool = {
      name: "structured",
      description: "returns an object",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: true, nested: { value: 1 } }),
    };
    const ctx = stubCtx(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 4, method: "tools/call", params: { name: "structured", arguments: {} } },
      [tool],
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('{"ok":true,"nested":{"value":1}}');
  });

  it("get_workflow with a missing id returns an isError tool result (not a crash)", async () => {
    const ctx = stubCtx(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 5, method: "tools/call", params: { name: "get_workflow", arguments: {} } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/workflowId is required/);
  });

  it("a gateway 404 becomes a readable isError tool result", async () => {
    const ctx = stubCtx(() => ({ status: 404, body: { code: "not-found", message: "not found" } }));
    const resp = await handleMcpRequest(
      { id: 6, method: "tools/call", params: { name: "get_workflow", arguments: { workflowId: "nope" } } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it("a workflow idempotency 409 is an isError result with typed safe guidance", async () => {
    const ctx = stubCtx(() => ({
      status: 409,
      body: {
        code: "workflow-run-idempotency-conflict",
        message: "This idempotency key is already bound to a different workflow run request.",
      },
    }));
    const resp = await handleMcpRequest(
      { id: 61, method: "tools/call", params: { name: "start_workflow_run", arguments: {
        workflowId: "wf", input: { secret: "must-not-leak" }, idempotencyKey: "secret-key",
      } } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("workflow-run-idempotency-conflict");
    expect(result.content[0].text).not.toContain("must-not-leak");
    expect(result.content[0].text).not.toContain("secret-key");
  });

  it("an unknown tool name is an isError result, not a protocol error", async () => {
    const ctx = stubCtx(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 8, method: "tools/call", params: { name: "delete_everything", arguments: {} } },
      buildTools(),
      ctx,
    );
    expect(resp!.error).toBeUndefined();
    const result = resp!.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("JinnMcpToolError from a handler is surfaced as isError text", async () => {
    const throwing: JinnMcpTool = {
      name: "boom",
      description: "always throws",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        throw new JinnMcpToolError("kaboom");
      },
    };
    const ctx = stubCtx(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 10, method: "tools/call", params: { name: "boom", arguments: {} } },
      [throwing],
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: kaboom");
  });
});

/**
 * GRS-018 (§3b) — resolveServerToken: explicit → env → 0600 gateway.json.
 * The fallback is what makes an AUTHED codex→jinn call possible at all (codex
 * gives MCP servers a clean env, so inheritance never delivers the token).
 */
describe("resolveServerToken (gateway.json fallback)", () => {
  const ENV_KEYS = ["JINN_GATEWAY_TOKEN", "JINN_HOME"] as const;
  let backup: Record<string, string | undefined>;
  beforeEach(() => {
    backup = {};
    for (const k of ENV_KEYS) { backup[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  });

  it("explicit token wins over everything", async () => {
    const { resolveServerToken } = await import("../server.js");
    process.env.JINN_GATEWAY_TOKEN = "env-token-000000000000000000000000000000";
    expect(resolveServerToken("explicit-tok")).toBe("explicit-tok");
  });

  it("inherited env token wins over the file", async () => {
    const { resolveServerToken } = await import("../server.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "srvtok-"));
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: "file-token-00000000000000000000000000" }));
    process.env.JINN_HOME = home;
    process.env.JINN_GATEWAY_TOKEN = "env-token";
    expect(resolveServerToken()).toBe("env-token");
  });

  it("falls back to <JINN_HOME>/gateway.json when the env is clean (the codex case)", async () => {
    const { resolveServerToken } = await import("../server.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "srvtok-"));
    const fileToken = "file-token-0000000000000000000000000000"; // >= 32 chars
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: fileToken }));
    process.env.JINN_HOME = home;
    expect(resolveServerToken()).toBe(fileToken);
  });

  it("rejects short/malformed file tokens and survives a missing file", async () => {
    const { resolveServerToken } = await import("../server.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "srvtok-"));
    process.env.JINN_HOME = home;
    expect(resolveServerToken()).toBeUndefined(); // no file
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: "short" }));
    expect(resolveServerToken()).toBeUndefined(); // too short (not a minted token)
    fs.writeFileSync(path.join(home, "gateway.json"), "not-json{");
    expect(resolveServerToken()).toBeUndefined(); // malformed
  });
});

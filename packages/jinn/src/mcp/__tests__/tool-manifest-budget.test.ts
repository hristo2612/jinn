import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildTools } from "../server.js";
import { projectPiToolManifest } from "../../engines/pi-mcp.js";

// Fixed provider budget. Rebased for Todos v2 slice 5 (attach_to_work_item,
// list_work_item_attachments, list_departments) with the same ~zero headroom
// discipline as before: new tool prose must stay concise rather than growing
// into this ceiling.
//
// 4911 → 5125 (review_verdict). The review-verdict surface is the only route
// that reaches `bounce`, and therefore the only route that makes a review
// rejection a COUNTED round. Without it `/status` sets `manual`, a manual move
// into `executing` is legal only from backlog/assigned, so the bounce edge —
// and with it the whole `effectiveMaxRounds` budget — is unreachable and review
// loops never terminate. Cost after trimming its prose: 181 tokens for the
// tool, 214 for the manifest delta. Ceiling is the new pi projection + 2.
const MAX_MANIFEST_TOKENS = 5125;
// Exact gate: js-tiktoken 1.0.21 with its local o200k_base ranks. The provider
// projection is the OpenAI Responses API function-tool request shape pinned on 2026-07-12.
const ATTESTED = {
  rpc: { tokens: 4689, sha256: "724546fc5b59276aab0f2d37ac4450c828e8fe5352692b8aa339d47866b0f437" },
  pi: { tokens: 5123, sha256: "4a57c8528d2028d43dd3080f4fd0612f5936f6ba51ee155c013b4eef347ce6f3" },
  openai: { tokens: 4864, sha256: "688995cc898f98ed4678daa770ff51d6c1025ca47aaa9863eeb4b13523811af5" },
} as const;

type TokenizerLoader = () => Promise<[{ Tiktoken: typeof import("js-tiktoken/lite").Tiktoken }, { default: typeof import("js-tiktoken/ranks/o200k_base").default }]>;
const loadPinnedTokenizer: TokenizerLoader = () => Promise.all([
  import("js-tiktoken/lite"),
  import("js-tiktoken/ranks/o200k_base"),
]);

async function exactOrAttested(name: keyof typeof ATTESTED, payload: string, loadTokenizer: TokenizerLoader = loadPinnedTokenizer): Promise<number> {
  try {
    const [{ Tiktoken }, ranks] = await loadTokenizer();
    return new Tiktoken(ranks.default).encode(payload).length;
  } catch {
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    if (hash !== ATTESTED[name].sha256) throw new Error(`tokenizer unavailable and ${name} manifest is not the attested golden payload (${hash})`);
    return ATTESTED[name].tokens;
  }
}

const EXPECTED_TOOL_NAMES = [
  "archive_work_item",
  "assign_work_item",
  "attach_to_work_item",
  "cancel_workflow_run",
  "comment_work_item",
  "cost_report",
  "create_note",
  "create_work_item",
  "create_workflow",
  "decide_workflow_approval",
  "decide_work_item_approval",
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
  "retire_workflow",
  "review_verdict",
  "rerun_workflow_run",
  "retry_workflow_node",
  "search_knowledge",
  "search_messages",
  "search_sessions",
  "search_work_items",
  "send_to_session",
  "send_connector_message",
  "spawn_session",
  "start_workflow_run",
  "stop_session",
  "unlink_work_items",
  "update_note",
  "update_work_item",
  "update_workflow",
] as const;

const EXPECTED_REQUIRED = {
  archive_work_item: ["id"],
  assign_work_item: ["id", "assignee"],
  attach_to_work_item: ["id", "path"],
  cancel_workflow_run: ["workflowId", "runId"],
  comment_work_item: ["id", "body"],
  cost_report: [],
  create_note: ["title"],
  create_work_item: ["title"],
  create_workflow: ["id", "title"],
  decide_workflow_approval: ["workflowId", "runId", "nodeId", "decision", "expectedRevision"],
  decide_work_item_approval: ["id", "decision"],
  delegate_task: ["task"],
  disable_workflow: ["workflowId", "expectedRevision"],
  duplicate_workflow: ["sourceId", "id", "title"],
  edit_work_item: ["id"],
  enable_workflow: ["workflowId", "expectedRevision"],
  escalate_work_item_approval: ["id"],
  find_employees: [],
  fire_workflow_event: ["eventName", "fireId", "payload"],
  get_cron_run_history: ["id"],
  get_employee: ["name"],
  get_message_context: ["sessionId", "messageId"],
  get_work_item: ["id"],
  get_work_item_tree: ["id"],
  get_workflow: ["workflowId"],
  get_workflow_run: ["workflowId", "runId"],
  label_work_item: ["id", "labels"],
  link_work_items: ["srcId", "dstId", "kind"],
  list_cron_jobs: [],
  list_departments: [],
  list_employees: [],
  list_files: [],
  list_labels: [],
  list_notes: [],
  list_sessions: [],
  list_work_item_attachments: ["id"],
  list_work_item_comments: ["id"],
  list_work_items: [],
  list_workflow_runs: ["workflowId"],
  list_workflows: [],
  publish_attachment: ["path"],
  read_file: ["path"],
  read_knowledge: ["path"],
  read_note: ["path"],
  read_session: ["sessionId"],
  request_work_item_approval: ["id", "request"],
  retire_workflow: ["workflowId", "expectedRevision"],
  review_verdict: ["id", "verdict"],
  rerun_workflow_run: ["workflowId", "runId", "definition", "idempotencyKey"],
  retry_workflow_node: ["workflowId", "runId", "nodeId", "idempotencyKey"],
  search_knowledge: ["query"],
  search_messages: ["query"],
  search_sessions: [],
  search_work_items: [],
  send_to_session: ["sessionId", "message"],
  send_connector_message: ["connector", "channel", "text"],
  spawn_session: ["prompt"],
  start_workflow_run: ["workflowId"],
  stop_session: ["sessionId"],
  unlink_work_items: ["srcId", "dstId", "kind"],
  update_note: ["path", "expectedRevision"],
  update_work_item: ["id", "status"],
  update_workflow: ["workflowId", "definition", "expectedRevision"],
} as const;

const EXPECTED_ENUMS = {
  cost_report: [["properties.groupBy", ["employee", "day"]]],
  create_work_item: [["properties.priority", [0, 1, 2, 3]]],
  decide_workflow_approval: [["properties.decision", ["approve", "reject"]]],
  decide_work_item_approval: [["properties.decision", ["approve", "reject"]]],
  edit_work_item: [["properties.priority", [0, 1, 2, 3]]],
  link_work_items: [["properties.kind", ["blocks", "relates", "duplicates"]]],
  list_sessions: [["properties.scope", ["children", "employee", "recent"]]],
  list_work_items: [
    ["properties.status", ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]],
    ["properties.source", ["human", "delegation", "cron", "workflow", "session", "connector", "goal"]],
  ],
  search_messages: [["properties.role", ["user", "assistant"]]],
  search_sessions: [["properties.status", ["idle", "running", "error", "waiting", "interrupted"]]],
  rerun_workflow_run: [["properties.definition", ["original", "current"]]],
  search_work_items: [
    ["properties.status", ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"]],
    ["properties.source", ["human", "delegation", "cron", "workflow", "session", "connector", "goal"]],
  ],
  unlink_work_items: [["properties.kind", ["blocks", "relates", "duplicates"]]],
  review_verdict: [["properties.verdict", ["pass", "fail", "blocked"]]],
  update_work_item: [["properties.status", ["executing", "in_review", "blocked", "escalated", "done"]]],
} as const;

function collectEnums(value: unknown, path: string[] = []): Array<[string, string[]]> {
  if (!value || typeof value !== "object") return [];
  const schema = value as Record<string, unknown>;
  const own = Array.isArray(schema.enum) ? ([[path.join("."), schema.enum as string[]]] as Array<[string, string[]]>) : [];
  return [
    ...own,
    ...Object.entries(schema).flatMap(([key, child]) => collectEnums(child, [...path, key])),
  ];
}

describe("tool manifest budget", () => {
  it(`keeps exact JSON-RPC, owned Pi, and pinned OpenAI wrapper manifests under ${MAX_MANIFEST_TOKENS} o200k_base tokens`, async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const wrappers = {
      rpc: { jsonrpc: "2.0", id: 1, result: { tools } },
      pi: { tools: projectPiToolManifest(tools) },
      // Pinned provider fixture: OpenAI Responses API function tool shape (2026-07-12).
      openai: { tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", name, description, parameters: inputSchema })) },
    } as const;
    for (const [name, wrapper] of Object.entries(wrappers) as Array<[keyof typeof wrappers, unknown]>) {
      expect(await exactOrAttested(name, JSON.stringify(wrapper))).toBeLessThanOrEqual(MAX_MANIFEST_TOKENS);
    }
  }, 15_000);

  it("fails closed when a 350-character manifest mutation exceeds the cap", async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const prose = sentence.repeat(4).slice(0, 350);
    expect(prose).toHaveLength(350);
    const mutated = { tools: projectPiToolManifest(tools), mutation: prose };
    expect(await exactOrAttested("pi", JSON.stringify(mutated))).toBeGreaterThan(MAX_MANIFEST_TOKENS);
  });

  it("uses attestation only for the unchanged golden when the pinned tokenizer is unavailable", async () => {
    const unavailable: TokenizerLoader = async () => { throw new Error("simulated unavailable tokenizer"); };
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const golden = JSON.stringify({ tools: projectPiToolManifest(tools) });
    expect(await exactOrAttested("pi", golden, unavailable)).toBe(ATTESTED.pi.tokens);

    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const changed = JSON.stringify({ tools: projectPiToolManifest(tools), mutation: sentence.repeat(4).slice(0, 350) });
    await expect(exactOrAttested("pi", changed, unavailable)).rejects.toThrow(/not the attested golden payload/);
  });

  it("keeps tool names, required arrays, and enum arrays stable", () => {
    const tools = buildTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(tools).toHaveLength(63);

    const required = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required ?? []]));
    expect(required).toEqual(EXPECTED_REQUIRED);

    const enums = Object.fromEntries(
      tools
        .map((t) => [t.name, collectEnums(t.inputSchema)] as const)
        .filter(([, entries]) => entries.length > 0),
    );
    expect(enums).toEqual(EXPECTED_ENUMS);
  });
});

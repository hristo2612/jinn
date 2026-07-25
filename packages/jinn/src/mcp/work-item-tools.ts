import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import type { JinnMcpContext } from "./toolkit.js";
import { parseTodoId } from "../work-items/id.js";

export const WORK_ITEM_SEARCH_LIMIT_MAX = 100;
export const WORK_ITEM_SEARCH_LIMIT_DEFAULT = 25;
export const WORK_ITEM_QUERY_CHAR_CAP = 512;
const FILTER_CHAR_CAP = 256;
const WORK_ITEM_BODY_CHAR_CAP = 64_000;
const WORK_ITEM_NOTE_CHAR_CAP = 8_000;

const STATUSES = ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"] as const;
const SOURCES = ["human", "delegation", "cron", "workflow", "session", "connector", "goal"] as const;
const AGENT_UPDATE_STATUSES = ["executing", "in_review", "blocked", "escalated", "done"] as const;
/** Review outcomes. Mirrors REVIEW_VERDICTS in gateway/api.ts — the gateway is
 *  the authority; this copy is the tool-schema enum. */
const REVIEW_VERDICTS = ["pass", "fail", "blocked"] as const;
const VERIFY_MODES = ["trust", "verify", "thorough"] as const;
const ACTIVITY_RECEIPT_HINT = "Preview or Open the persisted activity receipt in this chat.";
const TODO_ID_SCHEMA = { type: "string", pattern: "^[A-Z]{3}-[1-9][0-9]*$" } as const;
const COMMENT_ID_SCHEMA = { type: "string", pattern: "^wic_[0-9a-f]{12}$" } as const;
const COMMENT_ID_PATTERN = /^wic_[0-9a-f]{12}$/;
const COMMENT_LIST_LIMIT_MAX = 500;
const RELATION_KINDS = ["blocks", "relates", "duplicates"] as const;
const WORK_ITEM_LABELS_MAX = 100;
const COMMENT_ATTACHMENTS_MAX = 10;
const ATTACHMENT_PATH_CHAR_CAP = 1024;

function mutationResult(body: unknown, hint: string): Record<string, unknown> {
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : { result: body };
  return { ...value, hint: `${hint} ${ACTIVITY_RECEIPT_HINT}` };
}

function assertIdentity(ctx: JinnMcpContext): void {
  assertBoundCaller(ctx);
}

function assertLength(name: string, value: string, max: number): void {
  if (value.length > max) {
    throw new JinnMcpToolError(`${name} is too long (${value.length} chars, max ${max}) — shorten it and try again`);
  }
}

function requireString(args: Record<string, unknown>, name: string, max = FILTER_CHAR_CAP): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  assertLength(name, s, max);
  return s;
}

function requireTodoId(args: Record<string, unknown>): string {
  try {
    return parseTodoId(args.id);
  } catch {
    throw new JinnMcpToolError("id must be a canonical Todo ID such as ACM-42");
  }
}

function requireTodoIdField(args: Record<string, unknown>, name: string): string {
  try {
    return parseTodoId(args[name]);
  } catch {
    throw new JinnMcpToolError(`${name} must be a canonical Todo ID such as ACM-42`);
  }
}

function requireRelationKind(args: Record<string, unknown>): (typeof RELATION_KINDS)[number] {
  const kind = typeof args.kind === "string" ? args.kind : "";
  if (!(RELATION_KINDS as readonly string[]).includes(kind)) {
    throw new JinnMcpToolError(`kind must be one of ${RELATION_KINDS.join(", ")}`);
  }
  return kind as (typeof RELATION_KINDS)[number];
}

function optionalString(args: Record<string, unknown>, name: string, max = FILTER_CHAR_CAP): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  const s = v.trim();
  assertLength(name, s, max);
  return s;
}

function optionalStringArray(args: Record<string, unknown>, name: string, max = FILTER_CHAR_CAP): string[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new JinnMcpToolError(`${name} must be an array of strings when provided`);
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new JinnMcpToolError(`${name} entries must be non-empty strings`);
    }
    const s = entry.trim();
    assertLength(`${name} entry`, s, max);
    out.push(s);
  }
  return out;
}

function optionalEnum<T extends readonly string[]>(args: Record<string, unknown>, name: string, values: T): T[number] | undefined {
  const s = optionalString(args, name);
  if (s === undefined) return undefined;
  if (!(values as readonly string[]).includes(s)) {
    throw new JinnMcpToolError(`${name} must be one of ${values.join(", ")}, got "${s}"`);
  }
  return s as T[number];
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function asText(body: unknown, max = 1200): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  if (status === 400) return new JinnMcpToolError(`${what} rejected (400): ${detail}`);
  if (status === 403) return new JinnMcpToolError(`${what} refused (403): ${detail}`);
  if (status === 404) return new JinnMcpToolError(`${what} failed (404): ${detail || "not found"}`);
  if (status === 409) return new JinnMcpToolError(`${what} conflicted (409): ${detail}`);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

function summarize(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    assignee: item.assignee ?? null,
    department: item.department ?? null,
    source: item.source,
    version: item.version,
    updatedAt: item.updatedAt ?? null,
  };
}

function workItemsFrom(body: unknown): Array<Record<string, unknown>> {
  const rec = (body ?? {}) as { workItems?: Array<Record<string, unknown>> };
  return Array.isArray(rec.workItems) ? rec.workItems.map(summarize) : [];
}

function findApprovalKeysDeep(value: unknown, path = "args", found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (/^approval/i.test(key)) found.push(childPath);
    findApprovalKeysDeep(child, childPath, found);
  }
  return found;
}

function rejectApprovalFields(args: Record<string, unknown>, toolName: string): void {
  const forbidden = findApprovalKeysDeep(args);
  if (forbidden.length > 0) {
    throw new JinnMcpToolError(
      `approval fields (${forbidden.join(", ")}) cannot be attached by ${toolName} — approvals are routed gates; request/decide them through the separate approval authority surface, not Todo creation/status updates.`,
    );
  }
}

function optionalObject(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new JinnMcpToolError(`${name} must be a JSON object when provided`);
  return v as Record<string, unknown>;
}

function validateVerifyPolicy(policy: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(["mode", "verifier", "maxRounds"]);
  const extras = Object.keys(policy).filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new JinnMcpToolError(`verifyPolicy has unknown key(s) ${extras.join(", ")}; only mode, verifier, and maxRounds are allowed`);
  if (!(VERIFY_MODES as readonly unknown[]).includes(policy.mode)) {
    throw new JinnMcpToolError(`verifyPolicy.mode must be one of ${VERIFY_MODES.join(", ")}`);
  }
  if (policy.maxRounds !== undefined && (typeof policy.maxRounds !== "number" || !Number.isInteger(policy.maxRounds) || policy.maxRounds < 1 || policy.maxRounds > 20)) {
    throw new JinnMcpToolError("verifyPolicy.maxRounds must be an integer from 1 to 20");
  }
  if (policy.verifier !== undefined) {
    if (!policy.verifier || typeof policy.verifier !== "object" || Array.isArray(policy.verifier)) {
      throw new JinnMcpToolError("verifyPolicy.verifier must be a JSON object when provided");
    }
    const verifier = policy.verifier as Record<string, unknown>;
    const verifierAllowed = new Set(["employee", "engine", "model"]);
    const verifierExtras = Object.keys(verifier).filter((key) => !verifierAllowed.has(key));
    if (verifierExtras.length > 0) {
      throw new JinnMcpToolError(`verifyPolicy.verifier has unknown key(s) ${verifierExtras.join(", ")}; only employee, engine, and model are allowed`);
    }
    for (const key of ["employee", "engine", "model"]) {
      if (verifier[key] !== undefined && (typeof verifier[key] !== "string" || !verifier[key].trim())) {
        throw new JinnMcpToolError(`verifyPolicy.verifier.${key} must be a non-empty string`);
      }
    }
  }
  return policy;
}

function rejectProvenance(args: Record<string, unknown>): void {
  if (args.provenance !== undefined) {
    throw new JinnMcpToolError(
      "provenance cannot be supplied by create_work_item — the server assigns source provenance: create_work_item uses source=session, while cron and delegation create their own records; source=workflow is historical audit provenance and is not currently minted",
    );
  }
}

export function buildWorkItemTools(): JinnMcpTool[] {
  const list: JinnMcpTool = {
    name: "list_work_items",
    description: "List recent or filtered Todos as compact summaries.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES] },
        source: { type: "string", enum: [...SOURCES] },
        assignee: { type: "string" },
        department: { type: "string" },
        needsAttentionFor: { type: "string" },
        createdBy: { type: "string" },
        rootsOnly: { type: "boolean" },
        label: { type: "string" },
        text: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const params = qs({
        status: optionalEnum(args, "status", STATUSES),
        source: optionalEnum(args, "source", SOURCES),
        assignee: optionalString(args, "assignee"),
        department: optionalString(args, "department"),
        needsAttentionFor: optionalString(args, "needsAttentionFor"),
        createdBy: optionalString(args, "createdBy"),
        rootsOnly: args.rootsOnly === true ? "true" : undefined,
        label: optionalString(args, "label"),
        text: optionalString(args, "text", WORK_ITEM_QUERY_CHAR_CAP),
        since: optionalString(args, "since", 64),
        until: optionalString(args, "until", 64),
        limit: clampInt(args.limit, WORK_ITEM_SEARCH_LIMIT_DEFAULT, 1, WORK_ITEM_SEARCH_LIMIT_MAX),
        offset: clampInt(args.offset, 0, 0, 1_000_000),
      });
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items?${params}`);
      if (status >= 400) throw gatewayFailure("listing work items", status, body);
      const workItems = workItemsFrom(body);
      return { workItems, hint: workItems.length ? "Next: get_work_item { id }." : "No matches. Next: search_work_items or create_work_item." };
    },
  };

  const get: JinnMcpTool = {
    name: "get_work_item",
    description: "Get one Todo full detail.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}`);
      if (status >= 400) throw gatewayFailure(`getting work item "${id}"`, status, body);
      return body;
    },
  };

  const search: JinnMcpTool = {
    name: "search_work_items",
    description: "Search Todos by text and structured filters; compact hits only.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        status: { type: "string", enum: [...STATUSES] },
        source: { type: "string", enum: [...SOURCES] },
        assignee: { type: "string" },
        department: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const params: Record<string, string | number | undefined> = {
        text: optionalString(args, "text", WORK_ITEM_QUERY_CHAR_CAP),
        status: optionalEnum(args, "status", STATUSES),
        source: optionalEnum(args, "source", SOURCES),
        assignee: optionalString(args, "assignee"),
        department: optionalString(args, "department"),
        limit: clampInt(args.limit, WORK_ITEM_SEARCH_LIMIT_DEFAULT, 1, WORK_ITEM_SEARCH_LIMIT_MAX),
      };
      const hasFilter = Object.entries(params).some(([k, v]) => k !== "limit" && v !== undefined);
      if (!hasFilter) throw new JinnMcpToolError("pass at least one filter (text, status, source, assignee, department) — for recent Todos use list_work_items.");
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/search/work-items?${qs(params)}`);
      if (status >= 400) throw gatewayFailure("searching work items", status, body);
      const workItems = workItemsFrom(body);
      return { workItems, hint: workItems.length ? "Next: get_work_item { id }." : "No matches. Try fewer words or filters." };
    },
  };

  const create: JinnMcpTool = {
    name: "create_work_item",
    description: "Create a Todo (optionally as a sub-task via parentId); approvals excluded.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        acceptance: { type: "string" },
        assignee: { type: "string" },
        department: { type: "string" },
        verifyPolicy: { type: "object" },
        parentId: TODO_ID_SCHEMA,
        priority: { type: "number", enum: [0, 1, 2, 3] },
        dueAt: { type: "string" },
      },
      required: ["title"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "create_work_item");
      rejectProvenance(args);
      const body: Record<string, unknown> = { title: requireString(args, "title") };
      for (const key of ["body", "acceptance", "assignee", "department"] as const) {
        const v = optionalString(args, key, key === "body" || key === "acceptance" ? WORK_ITEM_BODY_CHAR_CAP : FILTER_CHAR_CAP);
        if (v !== undefined) body[key] = v;
      }
      const verifyPolicy = optionalObject(args, "verifyPolicy");
      if (verifyPolicy) body.verifyPolicy = validateVerifyPolicy(verifyPolicy);
      if (args.parentId !== undefined) {
        try { body.parentId = parseTodoId(args.parentId); }
        catch { throw new JinnMcpToolError("parentId must be a canonical Todo ID such as ACM-42"); }
      }
      if (args.priority !== undefined) {
        if (typeof args.priority !== "number" || !Number.isInteger(args.priority) || args.priority < 0 || args.priority > 3) {
          throw new JinnMcpToolError("priority must be an integer 0..3");
        }
        body.priority = args.priority;
      }
      const dueAt = optionalString(args, "dueAt", 64);
      if (dueAt !== undefined) body.dueAt = dueAt;
      const { status, body: resp } = await gatewayRequest(ctx, "POST", "/api/work-items", body);
      if (status >= 400) throw gatewayFailure("creating work item", status, resp);
      return mutationResult(resp, "Next: assign_work_item or update_work_item.");
    },
  };

  const tree: JinnMcpTool = {
    name: "get_work_item_tree",
    description: "Get a Todo's sub-task tree with per-status totals and derived spend.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}/tree`);
      if (status >= 400) throw gatewayFailure(`getting work item tree "${id}"`, status, body);
      return { ...(body as Record<string, unknown>), hint: "Next: get_work_item { id } on a child, or update_work_item." };
    },
  };

  const update: JinnMcpTool = {
    name: "update_work_item",
    description: "Update status on your OWN Todo. Judging someone else's work is review_verdict; a rejection written here is uncounted and never terminates.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        status: { type: "string", enum: [...AGENT_UPDATE_STATUSES] },
        note: { type: "string" },
      },
      required: ["id", "status"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "update_work_item");
      const id = requireTodoId(args);
      const rawStatus = requireString(args, "status");
      if (rawStatus === "cancelled") {
        throw new JinnMcpToolError("cancelling a Todo is a human surface decision; agents do not have a cancel tool.");
      }
      if (!(AGENT_UPDATE_STATUSES as readonly string[]).includes(rawStatus)) {
        throw new JinnMcpToolError(`status must be one of ${AGENT_UPDATE_STATUSES.join(", ")}; cancellation/other lifecycle edits are human surface decisions.`);
      }
      const payload: Record<string, unknown> = { status: rawStatus };
      const note = optionalString(args, "note", WORK_ITEM_NOTE_CHAR_CAP);
      if (note !== undefined) payload.note = note;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/status`, payload);
      if (status >= 400) throw gatewayFailure(`updating work item "${id}"`, status, body);
      return mutationResult(body, "Todo status updated.");
    },
  };

  const edit: JinnMcpTool = {
    name: "edit_work_item",
    description: "Edit a Todo's body/acceptance/priority/dueAt (creator, assignee, or their manager).",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        body: { type: "string" },
        acceptance: { type: ["string", "null"] },
        priority: { type: "number", enum: [0, 1, 2, 3] },
        dueAt: { type: ["string", "null"] },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "edit_work_item");
      const id = requireTodoId(args);
      if (args.title !== undefined) {
        throw new JinnMcpToolError("title is a human-surface edit (the Todo's creator or the operator, over the web/HTTP surface) — edit_work_item cannot change it");
      }
      if (args.status !== undefined) {
        throw new JinnMcpToolError("status is not a metadata edit — use update_work_item for lifecycle changes");
      }
      // Refuse other non-editable fields LOUDLY too: silently dropping them
      // would report success without the edit the caller asked for.
      if (args.assignee !== undefined) {
        throw new JinnMcpToolError("assignee is not editable here — use assign_work_item");
      }
      if (args.department !== undefined || args.rank !== undefined) {
        throw new JinnMcpToolError("department and rank are operator-only edits (web/HTTP surface) — edit_work_item cannot change them");
      }
      const patch: Record<string, unknown> = {};
      {
        const v = optionalString(args, "body", WORK_ITEM_BODY_CHAR_CAP);
        if (v !== undefined) patch.body = v;
      }
      // Explicit null CLEARS acceptance/dueAt (slice-4 review F3), passing
      // through to the route's existing null support.
      if (args.acceptance === null) {
        patch.acceptance = null;
      } else {
        const v = optionalString(args, "acceptance", WORK_ITEM_BODY_CHAR_CAP);
        if (v !== undefined) patch.acceptance = v;
      }
      if (args.priority !== undefined) {
        if (typeof args.priority !== "number" || !Number.isInteger(args.priority) || args.priority < 0 || args.priority > 3) {
          throw new JinnMcpToolError("priority must be an integer 0..3");
        }
        patch.priority = args.priority;
      }
      if (args.dueAt === null) {
        patch.dueAt = null;
      } else {
        const dueAt = optionalString(args, "dueAt", 64);
        if (dueAt !== undefined) patch.dueAt = dueAt;
      }
      if (Object.keys(patch).length === 0) {
        throw new JinnMcpToolError("pass at least one editable field (body, acceptance, priority, dueAt)");
      }
      // Agents should not have to run the optimistic-concurrency loop for a
      // simple metadata edit: read a fresh version, PATCH with it, and retry
      // ONCE on a concurrent bump. A second conflict surfaces the 409.
      let conflict: JinnMcpToolError | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const read = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}`);
        if (read.status >= 400) throw gatewayFailure(`editing work item "${id}"`, read.status, read.body);
        const version = ((read.body ?? {}) as { workItem?: { version?: unknown } }).workItem?.version;
        if (typeof version !== "number") {
          throw new JinnMcpToolError(`editing work item "${id}" failed: the gateway detail payload carried no version`);
        }
        const { status, body } = await gatewayRequest(ctx, "PATCH", `/api/work-items/${encodeURIComponent(id)}`, {
          ...patch,
          expectedVersion: version,
        });
        if (status === 409 && ((body ?? {}) as { code?: unknown }).code === "todo_version_conflict") {
          conflict = gatewayFailure(`editing work item "${id}"`, status, body);
          continue;
        }
        if (status >= 400) throw gatewayFailure(`editing work item "${id}"`, status, body);
        return mutationResult(body, "Todo metadata edited.");
      }
      throw conflict!;
    },
  };

  const reviewVerdict: JinnMcpTool = {
    name: "review_verdict",
    description:
      "Verdict on a Todo you reviewed but did not execute. pass closes it. fail returns it to the producer as a counted round, escalating to the operator at the round cap. blocked is an external need.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
        note: { type: "string" },
        findings: {
          type: "array",
          items: { type: "string" },
          description: "Required for fail: every defect from this pass, worst first. All of them costs one round; the first one costs N.",
        },
        unblockCondition: { type: "string", description: "Required for blocked: the exact external need." },
      },
      required: ["id", "verdict"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "review_verdict");
      const id = requireTodoId(args);
      const verdict = requireString(args, "verdict");
      if (!(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
        throw new JinnMcpToolError(`verdict must be one of ${REVIEW_VERDICTS.join(", ")}`);
      }
      const payload: Record<string, unknown> = { verdict };
      const note = optionalString(args, "note", 4000);
      if (note !== undefined) payload.note = note;
      const findings = optionalStringArray(args, "findings", 4000);
      if (findings !== undefined) payload.findings = findings;
      if (verdict === "fail" && (findings === undefined || findings.length === 0)) {
        throw new JinnMcpToolError(
          "a fail verdict requires findings: the complete ranked list of defects from this pass. One exhaustive pass returning everything costs one round; returning the first defect found costs N rounds and N fresh sessions.",
        );
      }
      const unblockCondition = optionalString(args, "unblockCondition", 4000);
      if (unblockCondition !== undefined) payload.unblockCondition = unblockCondition;
      if (verdict === "blocked" && unblockCondition === undefined) {
        throw new JinnMcpToolError("a blocked verdict requires unblockCondition: the exact external need.");
      }
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/review`, payload);
      if (status >= 400) throw gatewayFailure(`recording review verdict on "${id}"`, status, body);
      const rec = (body ?? {}) as { escalated?: boolean; rounds?: number; maxRounds?: number };
      const hint = verdict === "pass"
        ? "Todo closed on your PASS."
        : rec.escalated === true
          ? "Round budget exhausted — Todo escalated to the operator instead of looping."
          : verdict === "fail"
            ? `Returned to the producer. Round ${rec.rounds ?? "?"} of ${rec.maxRounds ?? "?"}; at the cap it escalates to the operator.`
            : "Todo blocked on an external need; it stays blocked until the condition is satisfied.";
      return mutationResult(body, hint);
    },
  };

  const assign: JinnMcpTool = {
    name: "assign_work_item",
    description: "Assign a Todo.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        assignee: { type: "string" },
      },
      required: ["id", "assignee"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "assign_work_item");
      const id = requireTodoId(args);
      const assignee = requireString(args, "assignee");
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/assign`, { assignee });
      if (status >= 400) throw gatewayFailure(`assigning work item "${id}"`, status, body);
      return mutationResult(body, "Todo assigned.");
    },
  };

  const archive: JinnMcpTool = {
    name: "archive_work_item",
    description: "Archive a Todo; retain its audit.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        note: { type: "string" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "archive_work_item");
      const id = requireTodoId(args);
      const payload: Record<string, unknown> = {};
      const note = optionalString(args, "note", WORK_ITEM_NOTE_CHAR_CAP);
      if (note !== undefined) payload.note = note;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/archive`, payload);
      if (status >= 400) throw gatewayFailure(`archiving work item "${id}"`, status, body);
      return mutationResult(body, "Todo archived.");
    },
  };

  const comment: JinnMcpTool = {
    name: "comment_work_item",
    description: "Comment on a Todo; parentCommentId replies in its thread; attachments = local file paths to attach to the comment.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        body: { type: "string" },
        parentCommentId: COMMENT_ID_SCHEMA,
        attachments: { type: "array", items: { type: "string" } },
      },
      required: ["id", "body"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const body = requireString(args, "body", WORK_ITEM_BODY_CHAR_CAP);
      const payload: Record<string, unknown> = { body };
      if (args.parentCommentId !== undefined) {
        if (typeof args.parentCommentId !== "string" || !COMMENT_ID_PATTERN.test(args.parentCommentId)) {
          throw new JinnMcpToolError("parentCommentId must be a comment ID such as wic_0a1b2c3d4e5f");
        }
        payload.parentCommentId = args.parentCommentId;
      }
      let attachmentPaths: string[] = [];
      if (args.attachments !== undefined) {
        if (!Array.isArray(args.attachments) || args.attachments.length > COMMENT_ATTACHMENTS_MAX
          || args.attachments.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > ATTACHMENT_PATH_CHAR_CAP)) {
          throw new JinnMcpToolError(`attachments must be an array of up to ${COMMENT_ATTACHMENTS_MAX} local file paths (non-empty strings)`);
        }
        attachmentPaths = (args.attachments as string[]).map((entry) => entry.trim());
      }
      const { status, body: resp } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/comments`, payload);
      if (status >= 400) throw gatewayFailure(`commenting on work item "${id}"`, status, resp);
      const created = resp as Record<string, unknown>;
      if (attachmentPaths.length === 0) return { ...created, hint: "Next: get_work_item { id }." };
      const commentId = (created.comment as { id?: unknown } | undefined)?.id;
      if (typeof commentId !== "string") {
        throw new JinnMcpToolError(`the comment was created but the gateway response carried no comment id — attachments were NOT uploaded`);
      }
      const uploaded: unknown[] = [];
      for (const filePath of attachmentPaths) {
        const attach = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/attachments`, {
          path: filePath,
          commentId,
        });
        if (attach.status >= 400) {
          throw gatewayFailure(
            `comment ${commentId} was created, but attaching "${filePath}" (${uploaded.length}/${attachmentPaths.length} uploaded)`,
            attach.status,
            attach.body,
          );
        }
        uploaded.push((attach.body as { attachment?: unknown } | null)?.attachment ?? attach.body);
      }
      return { ...created, attachments: uploaded, hint: "Next: get_work_item { id }." };
    },
  };

  const listComments: JinnMcpTool = {
    name: "list_work_item_comments",
    description: "List a Todo's comment thread chronologically.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const params = qs({
        limit: args.limit !== undefined ? clampInt(args.limit, 50, 1, COMMENT_LIST_LIMIT_MAX) : undefined,
        offset: args.offset !== undefined ? clampInt(args.offset, 0, 0, 1_000_000) : undefined,
      });
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}/comments${params ? `?${params}` : ""}`);
      if (status >= 400) throw gatewayFailure(`listing comments on work item "${id}"`, status, body);
      return body;
    },
  };

  const attach: JinnMcpTool = {
    name: "attach_to_work_item",
    description: "Attach a LOCAL file (by path) to a Todo, or to one of its comments via commentId.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        path: { type: "string" },
        commentId: COMMENT_ID_SCHEMA,
        filename: { type: "string" },
      },
      required: ["id", "path"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const filePath = requireString(args, "path", ATTACHMENT_PATH_CHAR_CAP);
      const payload: Record<string, unknown> = { path: filePath };
      if (args.commentId !== undefined) {
        if (typeof args.commentId !== "string" || !COMMENT_ID_PATTERN.test(args.commentId)) {
          throw new JinnMcpToolError("commentId must be a comment ID such as wic_0a1b2c3d4e5f");
        }
        payload.commentId = args.commentId;
      }
      const filename = optionalString(args, "filename");
      if (filename !== undefined) payload.filename = filename;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/attachments`, payload);
      if (status >= 400) throw gatewayFailure(`attaching to work item "${id}"`, status, body);
      return { ...(body as Record<string, unknown>), hint: "Next: list_work_item_attachments { id }." };
    },
  };

  const listAttachments: JinnMcpTool = {
    name: "list_work_item_attachments",
    description: "List a Todo's attachments; Read each file directly from its storagePath.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}/attachments`);
      if (status >= 400) throw gatewayFailure(`listing attachments on work item "${id}"`, status, body);
      return body;
    },
  };

  const link: JinnMcpTool = {
    name: "link_work_items",
    description: "Link two Todos: src blocks/relates/duplicates dst; blocks is cycle-checked.",
    inputSchema: {
      type: "object",
      properties: {
        srcId: TODO_ID_SCHEMA,
        dstId: TODO_ID_SCHEMA,
        kind: { type: "string", enum: [...RELATION_KINDS] },
      },
      required: ["srcId", "dstId", "kind"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const srcId = requireTodoIdField(args, "srcId");
      const dstId = requireTodoIdField(args, "dstId");
      const kind = requireRelationKind(args);
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(srcId)}/relations`, { dstId, kind });
      if (status >= 400) throw gatewayFailure(`linking "${srcId}" ${kind} "${dstId}"`, status, body);
      return mutationResult(body, "Todos linked.");
    },
  };

  const unlink: JinnMcpTool = {
    name: "unlink_work_items",
    description: "Remove a Todo relation (its creator or the operator).",
    inputSchema: {
      type: "object",
      properties: {
        srcId: TODO_ID_SCHEMA,
        dstId: TODO_ID_SCHEMA,
        kind: { type: "string", enum: [...RELATION_KINDS] },
      },
      required: ["srcId", "dstId", "kind"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const srcId = requireTodoIdField(args, "srcId");
      const dstId = requireTodoIdField(args, "dstId");
      const kind = requireRelationKind(args);
      const { status, body } = await gatewayRequest(ctx, "DELETE", `/api/work-items/${encodeURIComponent(srcId)}/relations`, { dstId, kind });
      if (status >= 400) throw gatewayFailure(`unlinking "${srcId}" ${kind} "${dstId}"`, status, body);
      return mutationResult(body, "Relation removed.");
    },
  };

  const label: JinnMcpTool = {
    name: "label_work_item",
    description: "Replace a Todo's label set; existing label names/ids only.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["id", "labels"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      if (!Array.isArray(args.labels) || args.labels.length > WORK_ITEM_LABELS_MAX
        || args.labels.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > FILTER_CHAR_CAP)) {
        throw new JinnMcpToolError(`labels must be an array of up to ${WORK_ITEM_LABELS_MAX} label names or ids (non-empty strings) — list_labels shows valid labels`);
      }
      const labels = (args.labels as string[]).map((entry) => entry.trim());
      const { status, body } = await gatewayRequest(ctx, "PUT", `/api/work-items/${encodeURIComponent(id)}/labels`, { labels });
      if (status >= 400) throw gatewayFailure(`labelling work item "${id}"`, status, body);
      return mutationResult(body, "Todo labels replaced.");
    },
  };

  const labelsList: JinnMcpTool = {
    name: "list_labels",
    description: "List the valid Todo labels.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      assertIdentity(ctx);
      const { status, body } = await gatewayRequest(ctx, "GET", "/api/labels");
      if (status >= 400) throw gatewayFailure("listing labels", status, body);
      return body;
    },
  };

  const departments: JinnMcpTool = {
    name: "list_departments",
    description: "List departments: slug, Todo ID prefix, and Todo count.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      assertIdentity(ctx);
      const { status, body } = await gatewayRequest(ctx, "GET", "/api/departments");
      if (status >= 400) throw gatewayFailure("listing departments", status, body);
      return body;
    },
  };

  return [list, get, tree, search, create, update, edit, reviewVerdict, assign, archive, comment, listComments, attach, listAttachments, link, unlink, label, labelsList, departments];
}

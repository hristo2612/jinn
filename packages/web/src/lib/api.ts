import { authFetch, authUrl } from "@/lib/auth"
import type { TodoStopCauseWire } from "@/lib/parked"
// Type-only, and it has to stay that way: `workflows/model.ts` value-imports
// `node:util/types` and the web build carries no Node polyfills.
import type {
  Binding as WorkflowBindingWire,
  ConditionPredicate as WorkflowPredicateWire,
  JsonValue as JsonValueWire,
  WorkflowApprovalRecord as WorkflowApprovalWire,
  WorkflowAttemptStatus as WorkflowAttemptStatusWire,
  WorkflowAttemptWire,
  WorkflowChildRunSummary as WorkflowChildRunWire,
  WorkflowDefinition as WorkflowDefinitionWire,
  WorkflowDefinitionSummary as WorkflowDefinitionSummaryWire,
  WorkflowError as WorkflowRunErrorWire,
  WorkflowNode as WorkflowNodeWire,
  WorkflowNodeOutput as WorkflowNodeOutputWire,
  WorkflowNodeRunRecord as WorkflowNodeRunWire,
  WorkflowNodeRunStatus as WorkflowNodeRunStatusWire,
  WorkflowOutputSchema as WorkflowOutputSchemaWire,
  WorkflowRunDetailUnprojectedWire,
  WorkflowRunDetailWire,
  WorkflowRunLeanWire,
  WorkflowRunStatus as WorkflowRunStatusWire,
  WorkflowRunSummary as WorkflowRunSummaryWire,
  WorkflowTriggerKind as WorkflowTriggerKindWire,
  WorkflowValidationIssue as WorkflowIssueWire,
} from "@jinn/workflow-wire"
import type {
  CreateNoteInput,
  NoteDocumentResponse,
  NotesListResponse,
  UpdateNoteInput,
} from "@/routes/notes/types"
import { createConfigApi } from "@/lib/api-config"
import { createExperimentsApi } from "@/lib/api-experiments"
import { createSttApi } from "@/lib/api-stt"
import { createTodoCaptureApi } from "@/lib/api-todo-capture"
export type { TodoCaptureAction, TodoCaptureWire, TodoCaptureStageWire, TodoCaptureRouteWire } from "@/lib/api-todo-capture"
import { createWorkflowLifecycleApi } from "@/lib/api-workflow-lifecycle"
import type { StaleChatPolicy } from "@/lib/stale-chat"
import type { EnginesResponse, ModelInfo } from "@/lib/engine-registry"
import {
  isPositiveTodoVersion,
  requireWorkItemEditResult,
  type WorkItemEditRequest,
  type WorkItemEditResultWire,
} from "@/lib/work-item-edit-wire"
import type { WorkItemCommentPageWire, WorkItemCommentWire } from "@/lib/work-item-comment-wire"
import type { WorkItemRunWire } from "@/lib/work-item-runs-wire"
import type { ApprovalStateWire, WorkItemApprovalWire } from "@/lib/work-item-approval-wire"

export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  content: TranscriptContentBlock[]
}

export interface QueueItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'cancelled' | 'completed';
  position: number;
  createdAt: string;
  /** The transcript row this item will run, when the enqueuing path had one. */
  messageId: string | null;
}

export interface WorkspaceInfo {
  id: string
  name: string
  displayName: string
  port: number
  running: boolean
  current: boolean
  switchUrl: string
  warning?: string
}

export interface CreateWorkspaceResult {
  instance: WorkspaceInfo
  launchUrl: string
  warning?: string
}

export interface Employee {
  name: string;
  system?: boolean;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  emoji?: string;
  effortLevel?: string;
  cliFlags?: string[];
  alwaysNotify?: boolean;
  reportsTo?: string | string[];
  parentName?: string | null;
  directReports?: string[];
  depth?: number;
  chain?: string[];
}

/** Editable employee fields accepted by PATCH /api/org/employees/:name.
 *  `name` is immutable and is intentionally omitted. */
export interface EmployeeUpdate {
  displayName?: string;
  department?: string;
  rank?: "executive" | "manager" | "senior" | "employee";
  engine?: string;
  model?: string;
  effortLevel?: string;
  persona?: string;
  reportsTo?: string | string[];
  cliFlags?: string[];
  alwaysNotify?: boolean;
}

export interface OrgWarning {
  employee: string;
  type: string;
  message: string;
  ref?: string;
}

export interface OrgHierarchy {
  root: string | null;
  sorted: string[];
  warnings: OrgWarning[];
}

export interface OrgData {
  departments: string[];
  employees: Employee[];
  hierarchy: OrgHierarchy;
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly currentVersion?: number
  /** Operator-actionable guidance from the server, when the failure is one the
   *  operator can fix locally (e.g. a missing OS privilege). Shown verbatim. */
  readonly remedy?: string

  constructor(status: number, message: string, code?: string, currentVersion?: number, remedy?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.currentVersion = currentVersion
    this.remedy = remedy
  }
}

/** Structured conditional-edit failure for the Todos surface. */
export class TodoApiError extends ApiError {
  constructor(status: number, message: string, code?: string, currentVersion?: number) {
    super(status, message, code, currentVersion)
    this.name = "TodoApiError"
  }
}

async function responseError(res: Response): Promise<ApiError> {
  let message = `API error: ${res.status}`
  let code: string | undefined
  let currentVersion: number | undefined
  let remedy: string | undefined
  try {
    const body = await res.json();
    if (body.error) message = String(body.error)
    else if (body.message) message = String(body.message)
    if (typeof body.code === "string" && body.code.trim()) code = body.code
    if (typeof body.currentVersion === "number" && Number.isSafeInteger(body.currentVersion) && body.currentVersion >= 0) {
      currentVersion = body.currentVersion
    }
    if (typeof body.remedy === "string" && body.remedy.trim()) remedy = body.remedy.trim()
  } catch {
    // Response wasn't JSON; status remains the typed UI-safe discriminator.
  }
  return new ApiError(res.status, message, code, currentVersion, remedy)
}

export async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * The surface a write came from, when it is not this UI. The gateway allowlists
 * the values and drops anything else, so declaring one is audit colour and never
 * authority — it buys the caller a label on their own write, nothing more.
 */
export type WriteOriginWire = "talk"

function writeHeaders(origin?: WriteOriginWire): Record<string, string> {
  return origin
    ? { "Content-Type": "application/json", "X-Jinn-Origin": origin }
    : { "Content-Type": "application/json" };
}

async function post<T>(path: string, body?: unknown, origin?: WriteOriginWire): Promise<T> {
  const res = await authFetch(path, {
    method: "POST",
    headers: writeHeaders(origin),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

async function del<T>(path: string, origin?: WriteOriginWire): Promise<T> {
  const res = await authFetch(path, {
    method: "DELETE",
    ...(origin ? { headers: { "X-Jinn-Origin": origin } } : {}),
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

async function put<T>(path: string, body: unknown, origin?: WriteOriginWire): Promise<T> {
  const res = await authFetch(path, {
    method: "PUT",
    headers: writeHeaders(origin),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/** The `issues` array on a workflow error envelope is untrusted input, so the
 *  entries that lack the two fields every renderer reads are dropped rather than
 *  asserted into shape. Deliberately a local read and not an import of
 *  `parseWorkflowIssues()` from `workflows/issues.ts`: that module is runtime
 *  code, and nothing runtime crosses from the gateway package into the bundle. */
function workflowIssues(value: unknown[]): WorkflowIssueWire[] {
  return value.flatMap((entry): WorkflowIssueWire[] => {
    if (!entry || typeof entry !== "object") return [];
    const { code, message, nodeId, edgeId, path } = entry as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string") return [];
    return [{
      code,
      message,
      ...(typeof nodeId === "string" ? { nodeId } : {}),
      ...(typeof edgeId === "string" ? { edgeId } : {}),
      ...(typeof path === "string" ? { path } : {}),
    }];
  });
}

/** Workflow writes keep the server's structured validation issues intact. */
async function workflowWrite<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json();
  let payload: Record<string, unknown> = {};
  try { payload = await res.json() } catch { /* non-JSON error body */ }
  const message = typeof payload.message === "string" ? payload.message : `API error: ${res.status}`;
  const code = typeof payload.code === "string" ? payload.code : undefined;
  if (Array.isArray(payload.issues)) {
    throw new WorkflowValidationApiError(res.status, message, code, workflowIssues(payload.issues));
  }
  throw new ApiError(res.status, message, code);
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

interface UploadedFile {
  id: string
  filename: string
  size: number
  mimetype: string | null
}

/**
 * Background work still running after a session's turn officially ended
 * (agent API calls or tracked Bash monitors). Present on session rows (list +
 * detail) and pushed live via the `session:background` WS event.
 * null/absent = no background work.
 */
export interface BackgroundActivity {
  activeStreams: number
  activeAgents?: number
  activeMonitors?: number
  lastActivityAt: string
}

/** Active employee sessions anywhere below a parent session. Derived by the
 * gateway at read time; it is never part of the durable session status. */
export interface DelegatedActivity {
  activeSessions: number
  employees: string[]
}

export interface SessionsResponse {
  /** Top-N most-recent sessions per group (employee / direct / cron). */
  sessions: Record<string, unknown>[]
  /** Total session count per group key, so the UI can show accurate "+N more". */
  counts: Record<string, number>
  /** How many per group the server returned (the load-more threshold). */
  perGroup: number
}

export interface ChatPin {
  key: string
  kind: 'session' | 'employee'
  pinnedAt: string
}

export interface PinsResponse {
  pins: ChatPin[]
}

// --- Model + capability registry (GET /api/engines) ---
export type { EngineHealth, EngineRegistryEntry, EnginesResponse, ModelInfo } from "./engine-registry";

// --- Engine quota/limit snapshots (GET /api/engine-limits) ---
export interface EngineLimitWindow {
  name: string;
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitContext {
  usedPercent?: number;
  remainingPercent?: number;
  contextWindowSize?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface EngineLimitCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
  limit?: number;
  used?: number;
  remainingPercent?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitBucket {
  id: string;
  name?: string;
  planType?: string;
  primary?: EngineLimitWindow;
  secondary?: EngineLimitWindow;
  credits?: EngineLimitCredits;
}

export interface EngineLimitEngineSnapshot {
  name: string;
  available: boolean;
  // `unavailable` = engine CLI not installed (temporary); `unsupported` = CLI
  // installed but no local quota endpoint.
  status: "live" | "snapshot" | "static" | "unavailable" | "unsupported" | "error";
  source: string;
  refreshedAt: string;
  defaultModel?: string;
  models: ModelInfo[];
  accountPlan?: string;
  windows?: EngineLimitWindow[];
  buckets?: EngineLimitBucket[];
  credits?: EngineLimitCredits;
  context?: EngineLimitContext;
  costUsd?: number;
  unsupportedReason?: string;
  error?: string;
  stale?: boolean;
}

export interface EngineLimitsResponse {
  generatedAt: string;
  default: string;
  engines: Record<string, EngineLimitEngineSnapshot>;
}

/* ── Workflow wire types ──────────────────────────────────────────────────
 * Derived from the canonical schemas, never restated. The gateway has no
 * serializer — `json()` is a bare `JSON.stringify` of what the repository
 * returned — so those types ARE the wire contract, and a copy kept by hand here
 * is drift with a delay on it. Re-exported under this file's `*Wire` naming so
 * the workflow surfaces keep importing their types from one place. */
export type {
  JsonValueWire,
  WorkflowApprovalWire,
  WorkflowBindingWire,
  WorkflowPredicateWire,
  WorkflowAttemptStatusWire,
  WorkflowAttemptWire,
  WorkflowChildRunWire,
  WorkflowDefinitionWire,
  WorkflowDefinitionSummaryWire,
  WorkflowRunErrorWire,
  WorkflowNodeWire,
  WorkflowNodeOutputWire,
  WorkflowNodeRunWire,
  WorkflowNodeRunStatusWire,
  WorkflowOutputSchemaWire,
  WorkflowRunDetailUnprojectedWire,
  WorkflowRunDetailWire,
  WorkflowRunLeanWire,
  WorkflowRunStatusWire,
  WorkflowRunSummaryWire,
  WorkflowTriggerKindWire,
  WorkflowIssueWire,
}

/** A workflow API error carrying structured validation issues. Not only a 422:
 *  `failure()` in the gateway attaches `issues` to whatever status the error
 *  maps to, which is also 403, 404, 409 and 500. */
export class WorkflowValidationApiError extends ApiError {
  readonly issues: WorkflowIssueWire[]

  constructor(status: number, message: string, code: string | undefined, issues: WorkflowIssueWire[]) {
    super(status, message, code)
    this.name = "WorkflowValidationApiError"
    this.issues = issues
  }
}

export type WorkItemStatusWire =
  | "backlog" | "assigned" | "executing" | "in_review" | "done" | "blocked" | "escalated" | "cancelled"
export type WorkItemSourceWire =
  | "human" | "delegation" | "cron" | "workflow" | "session" | "connector" | "goal"
export type VerifyModeWire = "trust" | "verify" | "thorough"

/** The compact row's session provenance (gateway `sessionRef()`): the session
 *  id parsed from a `session:`/`delegate:` sourceRef, plus the optional
 *  human-readable ref suffix. */
export interface WorkItemSessionRefWire {
  sessionId: string
  ref?: string | null
}

/** The compact row GET /api/work-items returns (list/board/people). */
/** One label (Todos v2 slice 3). `department` null = company-wide. */
export interface WorkItemLabelWire {
  id: string
  name: string
  color: string | null
  department: string | null
  createdAt: string
}

export type WorkItemRelationKindWire = "blocks" | "relates" | "duplicates"

/** One relation as seen from a Todo: the other endpoint resolved to a compact
 *  ref. `relates` is symmetric and always reads as direction "out". */
export interface WorkItemRelationWire {
  kind: WorkItemRelationKindWire
  direction: "out" | "in"
  other: { id: string; title: string; status: WorkItemStatusWire }
  createdBy: string
  createdAt: string
}

export interface WorkItemCompactWire extends TodoStopCauseWire {
  id: string
  /** Positive monotonic whole-row revision on CAS-capable gateways. */
  version?: number
  title: string
  status: WorkItemStatusWire
  assignee: string | null
  department: string | null
  source: WorkItemSourceWire
  sourceRef: string | null
  approvalState: ApprovalStateWire | null
  approvalRequest: string | null
  approvalRef: string | null
  /** Offered variants when the pending gate asks for a PICK (older gateways omit). */
  approvalOptions?: string[] | null
  approvalChoice?: string | null
  /** Reserved for the operator: no employee decides it, not even by escalation (older gateways omit). */
  approvalOperatorOnly?: boolean
  approvalTarget: string | null
  approvalEscalatedAt: string | null
  sessionRef?: WorkItemSessionRefWire | null
  /** Todos v2 (optional: older gateways omit them). */
  createdBy?: string
  parentId?: string | null
  rootId?: string
  depth?: number
  dueAt?: string | null
  /** Board wire data (optional: older gateways omit them). `blocked` is true
   *  while an incoming `blocks` relation originates from an open Todo; `kept`
   *  is true while the Todo sits on the operator's Home board. */
  labels?: WorkItemLabelWire[]
  blocked?: boolean
  kept?: boolean
  updatedAt: string
  /** Manual sort rank (design-todos §7.3). Null until the operator reorders. */
  rank?: number | null
}

/** GET /api/work-items and /api/search/work-items page payload
 *  (`workItemPagePayload`): one page of rows plus the TRUE match counts for
 *  the whole filtered set and the offset to fetch next (null = exhausted). */
export interface WorkItemListWire {
  workItems: WorkItemCompactWire[]
  total?: number
  totals?: Partial<Record<WorkItemStatusWire, number>>
  limit?: number
  offset?: number
  nextOffset?: number | null
}

export interface VerifyPolicyWire {
  mode: VerifyModeWire
  verifier?: { employee?: string; engine?: string; model?: string }
  maxRounds?: number
}

/** The full row GET /api/work-items/:id returns under `workItem`. */
export interface WorkItemFullWire {
  id: string
  /** Positive monotonic whole-row revision on CAS-capable gateways. */
  version?: number
  title: string
  body: string | null
  status: WorkItemStatusWire
  department: string | null
  assignee: string | null
  priority: number
  /** Manual order is part of the whole-row CAS response and detail baseline. */
  rank: number | null
  source: WorkItemSourceWire
  sourceRef: string | null
  acceptance: string | null
  verifyPolicy: VerifyPolicyWire | null
  rounds: number
  budgetUsd: number | null
  approvalState: ApprovalStateWire | null
  approvalRequest: string | null
  approvalRef: string | null
  /** Offered variants when the pending gate asks for a PICK (older gateways omit). */
  approvalOptions?: string[] | null
  approvalChoice?: string | null
  /** The gate is reserved for the operator: no employee may decide it, not the
   *  COO and not through escalation (older gateways omit). */
  approvalOperatorOnly?: boolean
  approvalTarget: string | null
  approvalEscalatedAt: string | null
  approvalDecidedBy: string | null
  approvalDecidedAt: string | null
  /** Todos v2 (optional: older gateways omit them). */
  createdBy?: string
  parentId?: string | null
  rootId?: string
  depth?: number
  dueAt?: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

/** The version-fenced edit lane's shapes and version rule live in
 *  work-item-edit-wire.ts; re-exported so the client surface stays one import. */
export { isPositiveTodoVersion } from "./work-item-edit-wire"
export type { VersionedWorkItemFullWire, WorkItemEditPatch, WorkItemEditRequest, WorkItemEditResultWire } from "./work-item-edit-wire"

/** The run ledger's shapes and its open/settled pairing rule live in
 *  work-item-runs-wire.ts; re-exported so the client surface stays one import. */
export type { WorkItemRunHandoffWire, WorkItemRunOutcomeWire, WorkItemRunWire } from "./work-item-runs-wire"

/** The comment thread's shapes live in work-item-comment-wire.ts; re-exported
 *  so the client surface stays one import. */
export type { WorkItemCommentAuthorKindWire, WorkItemCommentPageWire, WorkItemCommentWire } from "./work-item-comment-wire"

export interface WorkItemEventWire {
  id: string
  workItemId: string
  kind: string
  fromStatus: WorkItemStatusWire | null
  toStatus: WorkItemStatusWire | null
  actor: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

/** The approval gate's shapes live in work-item-approval-wire.ts; re-exported
 *  so the client surface stays one import. */
export type { ApprovalStateWire, WorkItemApprovalWire } from "./work-item-approval-wire"

/** One node of GET /api/work-items/:id/tree — a full row plus nested children
 *  (rank-then-id ordered, depth-capped server-side). */
export interface WorkItemTreeNodeWire extends WorkItemFullWire {
  children: WorkItemTreeNodeWire[]
}

/** The tree payload: subtree + per-status totals + derived subtree spend. */
export interface WorkItemTreeWire {
  root: WorkItemTreeNodeWire
  totals: Partial<Record<WorkItemStatusWire, number>>
  spendUsd: number
}

/** One attachment row (Todos v2 slice 5) — content-addressed; `commentId`
 *  null = attached to the Todo, set = attached to that comment. */
export interface WorkItemAttachmentWire {
  id: string
  workItemId: string
  commentId: string | null
  filename: string
  mime: string
  bytes: number
  sha256: string
  storagePath: string
  uploadedBy: string
  createdAt: string
}

/** One department row from GET /api/departments (Todos v2 slice 5). */
export interface DepartmentSummaryWire {
  slug: string
  prefix: string
  createdAt: string
  todoCount: number
}

/** The GET /api/work-items/:id payload: full row + live-derived spend + audit. */
export interface WorkItemDetailWire {
  workItem: WorkItemFullWire
  kept?: boolean
  spendUsd: number
  events: WorkItemEventWire[]
  /** Last-10 comments tail + total (optional: older gateways omit it). */
  comments?: WorkItemCommentPageWire
  /** Both-direction relations (optional: older gateways omit it). */
  relations?: WorkItemRelationWire[]
  /** The Todo's labels, ordered by name (optional: older gateways omit it). */
  labels?: WorkItemLabelWire[]
  /** Approval history, oldest first (optional: older gateways omit it). */
  approvals?: WorkItemApprovalWire[]
  /** The run ledger, oldest first (optional: older gateways omit it). */
  runs?: WorkItemRunWire[]
}

/** Lightweight batch enrichment used by board/attention rows. */
export type WorkItemOpenDetailWire = Pick<WorkItemDetailWire, "workItem" | "events">

export interface ApprovalDecisionResultWire {
  workItem: WorkItemFullWire
  escalated: boolean
}

export interface ApprovalEscalationResultWire {
  workItem: WorkItemFullWire
}

/** A serialized session linked to a Todo (the sheet's "Executing session" link
 *  only needs the id + a status glance; the rest is passthrough). */
export interface LinkedSessionWire {
  id: string
  employee?: string | null
  status?: string
  title?: string | null
  lastActivity?: string | null
  [key: string]: unknown
}

/** Todo list params that pass straight through as a same-named query param. */
const TODO_LIST_PARAMS = ["status", "assignee", "department", "source", "needsAttentionFor", "since", "until", "q", "createdBy", "label", "offset"] as const

export const api = {
  listWorkspaces: () => get<WorkspaceInfo[]>('/api/instances'),
  createWorkspace: (input: { name: string }) => post<CreateWorkspaceResult>('/api/instances', input),
  startWorkspace: (id: string) => post<WorkspaceInfo>(`/api/instances/${encodeURIComponent(id)}/start`),
  listNotes: (query?: string) => {
    const params = new URLSearchParams()
    if (query?.trim()) params.set("q", query.trim())
    const suffix = params.toString()
    return get<NotesListResponse>(`/api/notes${suffix ? `?${suffix}` : ""}`)
  },
  readNote: (path: string) =>
    get<NoteDocumentResponse>(`/api/notes/read?path=${encodeURIComponent(path)}`),
  createNote: (input: CreateNoteInput) =>
    post<NoteDocumentResponse>("/api/notes", input),
  updateNote: (input: UpdateNoteInput) =>
    put<NoteDocumentResponse>("/api/notes", input),
  ...createExperimentsApi({ get, post }),
  getFeatures: () => get<{ notesEnabled: boolean; staleChat: StaleChatPolicy }>("/api/features"),
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  listWorkflowDefinitionsV2: (cursor?: string, retired?: boolean) =>
    get<{ items: WorkflowDefinitionSummaryWire[]; nextCursor: string | null }>(`/api/workflows?${new URLSearchParams({ ...(cursor ? { cursor } : {}), ...(retired ? { retired: "true" } : {}) })}`),
  getWorkflowDefinitionV2: (id: string) =>
    get<WorkflowDefinitionWire>(`/api/workflows/${encodeURIComponent(id)}`),
  listWorkflowRunsV2: (id: string, limit = 50) =>
    get<{ items: WorkflowRunSummaryWire[]; nextCursor: string | null }>(
      `/api/workflows/${encodeURIComponent(id)}/runs?limit=${limit}`,
    ),
  /** The polled shape: no definition snapshot, no attempt prompts. */
  getWorkflowRunV2: (id: string, runId: string) =>
    get<WorkflowRunLeanWire>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
    ),
  /** The snapshot the run canvas needs to draw the graph at the revision the run
   *  started on, plus the prompts the inspector shows. Fetched once per run, and
   *  again only when a node is opened whose prompt the snapshot predates. */
  getWorkflowRunFullV2: (id: string, runId: string) =>
    get<WorkflowRunDetailWire>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}?view=full`,
    ),
  createWorkflowV2: (input: { id: string; title: string; description?: string }) =>
    workflowWrite<WorkflowDefinitionWire>("/api/workflows", "POST", input),
  saveWorkflowDefinitionV2: (id: string, definition: WorkflowDefinitionWire, expectedRevision: number) =>
    workflowWrite<WorkflowDefinitionWire>(
      `/api/workflows/${encodeURIComponent(id)}`, "PUT", { definition, expectedRevision },
    ),
  ...createWorkflowLifecycleApi({ workflowWrite }),
  /** Unprojected, like every workflow write route: the body carries
   *  `attempts[].input` and no `spendUsd`. See ICI-1190. */
  startWorkflowRunV2: (id: string) =>
    post<WorkflowRunDetailUnprojectedWire>(`/api/workflows/${encodeURIComponent(id)}/runs`, { input: {} }),
  decideWorkflowApprovalV2: (
    id: string,
    runId: string,
    nodeId: string,
    body: { decision: "approve" | "reject"; expectedRevision: number; reason?: string; choice?: string },
  ) =>
    post<WorkflowRunDetailUnprojectedWire>(
      `/api/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
      body,
    ),
  /** Resolved model + capability registry (engines, their models, effort levels). */
  getEngines: () => get<EnginesResponse>("/api/engines"),
  /** Force re-discovery of dynamic (pi) models, returning the rebuilt registry. */
  refreshEngines: () => post<EnginesResponse>("/api/engines/refresh"),
  getEngineLimits: (engine?: string, init?: RequestInit) =>
    get<EngineLimitsResponse>(`/api/engine-limits${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`, init),
  refreshEngineLimits: (engine?: string) =>
    post<EngineLimitsResponse>(`/api/engine-limits/refresh${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`, {}),
  getSessions: () => get<SessionsResponse>("/api/sessions"),
  getPinnedSessions: async () => {
    const payload = await get<unknown>("/api/sessions?pinned=1")
    if (Array.isArray(payload)) return payload as Record<string, unknown>[]
    if (payload && typeof payload === "object" && Array.isArray((payload as SessionsResponse).sessions)) {
      return (payload as SessionsResponse).sessions
    }
    return []
  },
  getPins: () => get<PinsResponse>("/api/pins"),
  pinChat: (key: string) => post<{ status: string }>("/api/pins", { key }),
  unpinChat: (key: string) => del<{ status: string }>(`/api/pins/${encodeURIComponent(key)}`),
  /** One group's sessions, newest first — used by the sidebar "load more" button. */
  getSessionsForGroup: (group: string, offset: number, limit = 50) =>
    get<Record<string, unknown>[]>(
      `/api/sessions?group=${encodeURIComponent(group)}&offset=${offset}&limit=${limit}`,
    ),
  /** Search across ALL sessions (title / employee / id), newest first. */
  searchSessions: (query: string) =>
    get<Record<string, unknown>[]>(`/api/sessions?q=${encodeURIComponent(query)}`),
  getSession: (id: string, options?: { last?: number; messages?: boolean; signal?: AbortSignal }) => {
    const params = new URLSearchParams()
    if (options?.last) params.set("last", String(options.last))
    if (options?.messages === false) params.set("messages", "0")
    const query = params.toString()
    return get<Record<string, unknown>>(
      `/api/sessions/${id}${query ? `?${query}` : ""}`,
      options?.signal ? { signal: options.signal } : undefined,
    )
  },
  getSessionMessages: (id: string, options: { before?: string; limit?: number }) => {
    const params = new URLSearchParams()
    if (options.before) params.set("before", options.before)
    if (options.limit) params.set("limit", String(options.limit))
    const query = params.toString()
    return get<{ messages: Record<string, unknown>[]; hasOlder: boolean }>(
      `/api/sessions/${id}/messages${query ? `?${query}` : ""}`,
    )
  },
  getSessionChildren: (id: string) => get<Record<string, unknown>[]>(`/api/sessions/${id}/children`),
  updateSession: (id: string, data: { title?: string; engine?: string; model?: string; effortLevel?: string }) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, data),
  archiveSession: (id: string) => post<Record<string, unknown>>(`/api/sessions/${id}/archive`, {}),
  unarchiveSession: (id: string) => post<Record<string, unknown>>(`/api/sessions/${id}/unarchive`, {}),
  deleteSession: (id: string) => del<Record<string, unknown>>(`/api/sessions/${id}`),
  duplicateSession: (id: string) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/duplicate`, {}),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ status: string; count: number }>("/api/sessions/bulk-delete", { ids }),
  createSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions", data),
  sendMessage: (id: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/message`, data),
  stopSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/stop`, {}),
  resetSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/reset`, {}),
  getCronJobs: () => get<Record<string, unknown>[]>("/api/cron"),
  getCronRuns: (id: string) => get<Record<string, unknown>[]>(`/api/cron/${id}/runs`),
  updateCronJob: (id: string, data: Record<string, unknown>) =>
    put<Record<string, unknown>>(`/api/cron/${id}`, data),
  deleteCronJob: (id: string) => del<{ deleted: string; name: string }>(`/api/cron/${encodeURIComponent(id)}`),
  triggerCronJob: (id: string) => post<Record<string, unknown>>(`/api/cron/${id}/trigger`, {}),
  getOrg: () => get<OrgData>("/api/org"),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  /** PATCH an employee's editable fields. `name` is immutable and must not be sent.
   *  Returns the updated employee as re-scanned from disk. */
  updateEmployee: (name: string, data: EmployeeUpdate) =>
    patch<{ status: string; employee: Employee | null }>(
      `/api/org/employees/${name}`,
      data,
    ),
  getSkills: () => get<{ name: string; description?: string }[]>("/api/skills"),
  getSkill: (name: string) =>
    get<{ name: string; content: string }>(`/api/skills/${encodeURIComponent(name)}`),
  updateSkill: (name: string, content: string) =>
    put<{ status: string }>(`/api/skills/${encodeURIComponent(name)}`, { content }),
  ...createConfigApi({ responseError }),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; companyName: string | null; companyPrefix: string | null; todoPrefix: string | null; todoPrefixFrozen: boolean; portalName: string | null; operatorName: string | null; operatorEmoji: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { companyName?: string; companyPrefix?: string | null; portalName?: string; operatorName?: string; operatorEmoji?: string; language?: string; engine?: string; model?: string; effortLevel?: string }) =>
    post<{ status: string; portal: { companyName?: string; companyPrefix?: string; portalName?: string; operatorName?: string; operatorEmoji?: string; language?: string } }>("/api/onboarding", data),
  ...createSttApi({ get, post, put, authFetch }),
  ...createTodoCaptureApi({ get, post }),
  getSessionQueue: (id: string) => get<QueueItem[]>(`/api/sessions/${id}/queue`),
  cancelQueueItem: (sessionId: string, itemId: string) => del<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}`),
  editQueueItem: (sessionId: string, itemId: string, prompt: string) => patch<{ status: string; item: QueueItem }>(`/api/sessions/${sessionId}/queue/${itemId}`, { prompt }),
  sendQueueItemNow: (sessionId: string, itemId: string) => post<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}/send-now`, {}),
  clearSessionQueue: (sessionId: string) => del<{ status: string; cancelled: number }>(`/api/sessions/${sessionId}/queue`),
  pauseSessionQueue: (sessionId: string) => post<{ status: string }>(`/api/sessions/${sessionId}/queue/pause`, {}),
  resumeSessionQueue: (sessionId: string) => post<{ status: string }>(`/api/sessions/${sessionId}/queue/resume`, {}),
  getSessionTranscript: (id: string) =>
    get<TranscriptEntry[]>(`/api/sessions/${id}/transcript`),

  // ── Work items (Todos) ──────────────────────────────────────────────────
  /** GRS-021c: compact Todo list, optionally filtered by status. The gateway
   *  caps `limit` at 20, so the board fetches one call per display status.
   *  `source`, `since`/`until`, `q`, and `offset` follow design-todos §7.1–2;
   *  older gateways ignore them (the view applies a defensive client pass). */
  listWorkItems: (params?: {
    status?: WorkItemStatusWire
    assignee?: string
    department?: string
    source?: WorkItemSourceWire
    needsAttentionFor?: string
    since?: string
    until?: string
    q?: string
    offset?: number
    limit?: number
    createdBy?: string
    rootsOnly?: boolean
    label?: string
    kept?: boolean
    home?: boolean
  }, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    for (const key of TODO_LIST_PARAMS) if (params?.[key]) q.set(key, String(params[key]))
    for (const flag of ["rootsOnly", "kept", "home"] as const) if (params?.[flag]) q.set(flag, "true")
    q.set("limit", String(params?.limit ?? 20))
    return get<WorkItemListWire>(`/api/work-items?${q.toString()}`, signal ? { signal } : undefined)
  },
  /** GRS-021c: deterministic AND-composed Todo search (escaped-LIKE text over
   *  title + body). Same page params/payload as the list endpoint — the filter
   *  bar's search must carry the date window and page like any other query. */
  searchWorkItems: (params: {
    text: string
    status?: WorkItemStatusWire
    assignee?: string
    department?: string
    source?: WorkItemSourceWire
    since?: string
    until?: string
    offset?: number
    limit?: number
  }) => {
    const q = new URLSearchParams()
    q.set("text", params.text)
    if (params.status) q.set("status", params.status)
    if (params.assignee) q.set("assignee", params.assignee)
    if (params.department) q.set("department", params.department)
    if (params.source) q.set("source", params.source)
    if (params.since) q.set("since", params.since)
    if (params.until) q.set("until", params.until)
    if (params.offset) q.set("offset", String(params.offset))
    q.set("limit", String(params.limit ?? 20))
    return get<WorkItemListWire>(`/api/search/work-items?${q.toString()}`)
  },
  /** The operator's pen (design-todos §7.3–4): PATCH title/body/assignee/
   *  department/priority/rank. 404s on gateways that predate the endpoint —
   *  callers surface the failure quietly and keep the read view intact. */
  updateWorkItem: async (
    id: string,
    input: WorkItemEditRequest,
  ): Promise<WorkItemEditResultWire> => {
    if (!isPositiveTodoVersion(input.expectedVersion)) {
      throw new TypeError("Todo expectedVersion must be a positive safe integer")
    }
    try {
      const result = await patch<unknown>(`/api/work-items/${encodeURIComponent(id)}`, {
        ...input.patch,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      })
      return requireWorkItemEditResult(result)
    } catch (error) {
      if (error instanceof ApiError) {
        throw new TodoApiError(error.status, error.message, error.code, error.currentVersion)
      }
      throw error
    }
  },
  /** Guarded status transition (legal edges only — the gateway owns legality); `cascade` closes the open descendants with it, which the gateway allows for done alone. */
  setWorkItemStatus: (id: string, status: WorkItemStatusWire, note?: string, origin?: WriteOriginWire, options?: { cascade?: boolean }) =>
    put<{ workItem: WorkItemFullWire; escalated: boolean }>(
      `/api/work-items/${encodeURIComponent(id)}/status`,
      { ...(note ? { status, note } : { status }), ...(options?.cascade ? { cascade: true } : {}) },
      origin,
    ),
  /** GRS-021c: create a Todo (the "+ New Todo" affordance). The operator caller
   *  mints a `human`-source item; approvals structurally cannot be attached here. */
  createWorkItem: (input: {
    title: string
    body?: string
    /** Todos v2 slice 6: quick-adds carry the board scope / parent. */
    parentId?: string
    department?: string
    priority?: number
    dueAt?: string
    acceptance?: string
    labels?: string[]
  }, origin?: WriteOriginWire) =>
    post<{ workItem: WorkItemFullWire }>("/api/work-items", input, origin),
  /** Todos v2 slice 6: roster-validated assignment (backlog → assigned). */
  assignWorkItem: (id: string, assignee: string, origin?: WriteOriginWire) =>
    post<{ workItem: WorkItemFullWire }>(`/api/work-items/${encodeURIComponent(id)}/assign`, { assignee }, origin),
  /** Non-deleting archive: the row and its audit survive as `cancelled`. */
  archiveWorkItem: (id: string) =>
    post<{ workItem: WorkItemFullWire }>(`/api/work-items/${encodeURIComponent(id)}/archive`, {}),
  /** Todos v2 slice 6: the board's lazy tree expansion (roll-ups + spend). */
  getWorkItemTree: (id: string, signal?: AbortSignal) =>
    get<{ tree: WorkItemTreeWire }>(`/api/work-items/${encodeURIComponent(id)}/tree`, signal ? { signal } : undefined),
  /** ICI-648: all visible board trees in one request. */
  getWorkItemTrees: (ids: string[], signal?: AbortSignal) => {
    const q = new URLSearchParams({ ids: ids.join(",") })
    return get<{ trees: Record<string, WorkItemTreeWire> }>(
      `/api/work-items/trees?${q.toString()}`,
      signal ? { signal } : undefined,
    )
  },
  /** Todos v2 slice 6: the switcher's department boards. */
  getDepartments: () => get<{ departments: DepartmentSummaryWire[] }>("/api/departments"),
  /** GRS-021a: full Todo detail (property stack + live spend + audit). */
  getWorkItem: (id: string, signal?: AbortSignal) =>
    get<WorkItemDetailWire>(`/api/work-items/${encodeURIComponent(id)}`, signal ? { signal } : undefined),
  /** ICI-648: lightweight open-detail enrichment through the existing list route. */
  getWorkItems: (ids: string[], signal?: AbortSignal) => {
    const q = new URLSearchParams({ ids: ids.join(",") })
    return get<{ workItems: WorkItemOpenDetailWire[] }>(
      `/api/work-items?${q.toString()}`,
      signal ? { signal } : undefined,
    )
  },
  /** GRS-021b: the operator's approval DECISION. Human-only server-side; a
   *  tool-marked caller is refused 403. Send-back is `reject` (+ optional note). */
  decideWorkItemApproval: (id: string, decision: "approve" | "reject", note?: string, choice?: string) =>
    post<ApprovalDecisionResultWire>(`/api/work-items/${encodeURIComponent(id)}/approval`, {
      decision,
      ...(note !== undefined && note !== "" ? { note } : {}),
      ...(choice !== undefined ? { choice } : {}),
    }),
  escalateWorkItemApproval: (id: string) =>
    post<ApprovalEscalationResultWire>(`/api/work-items/${encodeURIComponent(id)}/approval/escalate`, {}),
  /** GRS-002: execution attempts linked to a Todo (the sheet's session link). */
  listWorkItemSessions: (id: string) =>
    get<LinkedSessionWire[]>(`/api/work-items/${encodeURIComponent(id)}/sessions`),
  dispatchTodo: (id: string) =>
    post<{ workItemId: string; sessionId: string; status: string; reused: boolean }>(
      `/api/work-items/${encodeURIComponent(id)}/dispatch`,
      {},
    ),
  /** Todos v2 slice 2: the comment thread, chronological with limit/offset. */
  listWorkItemComments: (id: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit))
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset))
    const query = params.toString()
    return get<WorkItemCommentPageWire>(`/api/work-items/${encodeURIComponent(id)}/comments${query ? `?${query}` : ""}`)
  },
  /** Add a comment (or a single-level reply via parentCommentId). Author
   *  identity is stamped server-side from the operator surface. */
  addWorkItemComment: (id: string, body: string, parentCommentId?: string, origin?: WriteOriginWire) =>
    post<{ comment: WorkItemCommentWire }>(
      `/api/work-items/${encodeURIComponent(id)}/comments`,
      parentCommentId ? { body, parentCommentId } : { body },
      origin,
    ),
  editWorkItemComment: (id: string, commentId: string, body: string) =>
    patch<{ comment: WorkItemCommentWire }>(
      `/api/work-items/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      { body },
    ),
  /** Tombstone: the row survives with an empty body; the UI renders [deleted]. */
  deleteWorkItemComment: (id: string, commentId: string, origin?: WriteOriginWire) =>
    del<{ comment: WorkItemCommentWire }>(
      `/api/work-items/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
      origin,
    ),
  /** Todos v2 slice 3: the shared label registry (existing labels only). */
  listLabels: () => get<{ labels: WorkItemLabelWire[] }>("/api/labels"),
  /** Todos v2 slice 5: attachment rows (item-level and per-comment). */
  listWorkItemAttachments: (id: string) =>
    get<{ attachments: WorkItemAttachmentWire[] }>(`/api/work-items/${encodeURIComponent(id)}/attachments`),
  /** Multipart upload; `commentId` attaches to that comment instead of the item. */
  uploadWorkItemAttachment: async (id: string, file: File, commentId?: string): Promise<WorkItemAttachmentWire> => {
    const form = new FormData()
    form.append("file", file)
    if (commentId) form.append("commentId", commentId)
    const res = await authFetch(`/api/work-items/${encodeURIComponent(id)}/attachments`, { method: "POST", body: form })
    if (!res.ok) throw await responseError(res)
    return (await res.json()).attachment as WorkItemAttachmentWire
  },
  deleteWorkItemAttachment: (id: string, attachmentId: string) =>
    del<{ removed: boolean }>(`/api/work-items/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`),
  /** Integrity-checked download path (cookie-authenticated, usable as img src). */
  workItemAttachmentUrl: (id: string, attachmentId: string): string =>
    authUrl(`/api/work-items/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`),
  /** Todos v2 slice 3: relations (blocks is cycle-checked server-side). */
  addWorkItemRelation: (id: string, kind: WorkItemRelationKindWire, dstId: string) =>
    post<{ relation: unknown }>(`/api/work-items/${encodeURIComponent(id)}/relations`, { kind, dstId }),
  removeWorkItemRelation: async (id: string, kind: WorkItemRelationKindWire, dstId: string): Promise<{ removed: boolean }> => {
    const res = await authFetch(`/api/work-items/${encodeURIComponent(id)}/relations`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, dstId }),
    })
    if (!res.ok) throw await responseError(res)
    return res.json()
  },
  /** Replace a Todo's label set (ids or names; nothing created implicitly). */
  setWorkItemLabels: (id: string, labels: string[], origin?: WriteOriginWire) =>
    put<{ labels: WorkItemLabelWire[] }>(`/api/work-items/${encodeURIComponent(id)}/labels`, { labels }, origin),
  /** Put a Todo on the operator's Home board, or take it off (ICI-1357). */
  setWorkItemKept: (id: string, kept: boolean) =>
    put<{ kept: boolean }>(`/api/work-items/${encodeURIComponent(id)}/kept`, { kept }),
  uploadFile: async (file: File, sessionId?: string): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    // When known, scope the upload to the session so it lands in the date-bucketed uploads dir.
    if (sessionId) form.append('sessionId', sessionId)
    const res = await authFetch("/api/files", { method: 'POST', body: form })
    if (!res.ok) throw await responseError(res)
    return res.json()
  },
};

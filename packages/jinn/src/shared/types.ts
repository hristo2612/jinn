export type StreamDeltaType = "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context" | "block";

type CompanyChangedBase = { action: string; id: string; sessionId?: string };
export type CompanyChangedEvent =
  | (CompanyChangedBase & { entity: "todo"; version: number; value?: JsonObject })
  | (CompanyChangedBase & { entity: "workflow-definition"; version: number })
  | (CompanyChangedBase & { entity: "workflow-run"; workflowId: string; runId: string; version: number })
  | (CompanyChangedBase & { entity: "workflow-trigger"; workflowId: string; revision: string });

export interface NoteSummary {
  /** Public path below JINN_HOME, for example knowledge/product/brief.md. */
  path: string;
  title: string;
  preview: string;
  /** Knowledge-relative directory; the root folder is an empty string. */
  folder: string;
  updatedAt: string;
  /** SHA-256 of the exact file bytes. */
  revision: string;
}

export interface NoteDocument extends NoteSummary {
  /** Editable content after the first Markdown heading. */
  body: string;
}

export interface NoteFolder {
  path: string;
  name: string;
  count: number;
}

export type NoteStoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: "invalid-path" | "forbidden" | "not-found" | "conflict" | "too-large" | "already-exists";
      detail: string;
      currentRevision?: string;
    };

/** Generous but bounded body size for durable communication-card metadata. */
export const STRUCTURED_MESSAGE_BODY_MAX_CHARS = 16_000;

export type ChatBlockType =
  | "task-list"
  | "delegation"
  | "dispatch"
  | "todo-activity"
  | "workflow-definition"
  | "workflow-run";
export type ChatBlockStatus = "queued" | "dispatched" | "running" | "waiting" | "done" | "completed" | "error";
export type ChatBlockOp = "put" | "patch" | "remove";

/** Correlation metadata authored only by verified server mutation paths. */
export type ActivityReceipt = JsonObject & {
  id: string;
  operationId: string;
  toolName: string;
};

export type TodoActivityPayload = JsonObject & {
  todoId: string;
  action: string;
  status: string;
  assignee?: string | null;
  actor?: string | null;
  approvalState?: string | null;
  updatedAt?: string;
  preview?: string;
  latestError?: string | null;
  activityReceipt?: ActivityReceipt;
};

export type WorkflowDefinitionActivityPayload = JsonObject & {
  workflowId: string;
  action: string;
  definitionStatus: string;
  updatedAt?: string;
  openPath?: string;
  preview?: string;
  latestError?: string | null;
  activityReceipt?: ActivityReceipt;
};

export type WorkflowRunActivityPayload = JsonObject & {
  workflowId: string;
  runId: string;
  action: string;
  runStatus: string;
  startedAt?: string;
  endedAt?: string | null;
  completedSteps?: number;
  totalSteps?: number;
  parkedDescription?: string;
  openPath?: string;
  preview?: string;
  latestError?: string | null;
  activityReceipt?: ActivityReceipt;
};

export interface ChatBlock {
  id: string;
  type: ChatBlockType;
  version: number;
  /** Monotonic server operation order for independent activity mutations that
   * may share the same domain version (for example Workflow trigger changes). */
  activityOrder?: number;
  status?: ChatBlockStatus;
  sourceEngine?: string;
  title?: string;
  summary?: string;
  payload: JsonObject;
}

export interface ChatBlockEnvelope {
  op: ChatBlockOp;
  block: ChatBlock;
}

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
  /** Stable server-authored activity block id carried only by a successful
   * matching tool result. Persisted onto that exact tool row for reload. */
  activityReceiptId?: string;
  /** First 200 chars of the stringified tool input. Present on PreToolUse-sourced
   *  `tool_use` deltas (fired just before the tool runs, full input assembled).
   *  Absent on the SSE-proxy `content_block_start` delta (input not yet known). */
  input?: string;
  /** Structured chat-view UI update. CLI and connector transports may ignore it. */
  block?: ChatBlockEnvelope;
}

export interface Engine {
  name: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

export interface InterruptibleEngine extends Engine {
  /** Kill a running engine process for a specific Jinn session. */
  kill(sessionId: string, reason?: string): void;
  /** Check if a live engine process is still running for this session. */
  isAlive(sessionId: string): boolean;
  /** Kill all live engine processes during gateway shutdown. */
  killAll(): void;
  /** Recycle only IDLE warm PTYs (no in-flight turn), leaving active turns
   *  untouched. Used on org-reload so the next turn cold-respawns with the fresh
   *  persona without interrupting a turn that is currently running. Engines with
   *  no warm-PTY reuse (batch engines spawn fresh per turn) implement this as a
   *  no-op — there is nothing idle to recycle and live processes are active turns. */
  killIdle(): void;
}

export function isInterruptibleEngine(engine: Engine): engine is InterruptibleEngine {
  return "kill" in engine && "isAlive" in engine && "killAll" in engine;
}

/** Observable progress of an in-flight engine turn. Reported by engines that can
 *  distinguish "a turn exists" from "a turn is getting somewhere" — the gateway's
 *  turn heartbeat cannot, because it ticks for exactly as long as run() is pending
 *  and so reads healthy for a permanently wedged turn. */
export interface TurnProgress {
  turnStartedAt: number;
  /** Newest of: turn start, last hook, last engine output. */
  lastProgressAt: number;
  /** The prompt was handed to the engine but never acknowledged as started. */
  awaitingSubmit: boolean;
  /** Local tool calls in flight. A long tool is real work, not a stall. */
  activeTools: number;
  /** Upstream API requests in flight (background subagents/tasks). */
  activeUpstream: boolean;
}

export interface TurnProgressEngine extends Engine {
  turnProgress(sessionId: string): TurnProgress | undefined;
}

export function reportsTurnProgress(engine: Engine): engine is TurnProgressEngine {
  return typeof (engine as Partial<TurnProgressEngine>).turnProgress === "function";
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  /** Canonical platform/session metadata refresh for a resumed native transcript.
   *  Presence is an explicit dispatch-layer decision; resumeSessionId alone must
   *  never imply that platform context is dirty. */
  platformContextRefresh?: string;
  cwd: string;
  bin?: string;
  model?: string;
  effortLevel?: string;
  attachments?: string[];
  /** Extra CLI flags to pass to the engine binary (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** Path to MCP config JSON file (passed as --mcp-config to Claude Code) */
  mcpConfigPath?: string;
  /** In-memory resolved MCP server set for this session's employee, threaded to
   *  ALL MCP-capable engines (Tier 1: claude/codex/hermes). Claude also consumes
   *  its servers via {@link mcpConfigPath} (the `--mcp-config` temp file) today;
   *  the other capable engines' adapters read this payload directly in a later
   *  slice (GRS-012b/012c). Unset when the session's engine is not MCP-capable or
   *  no servers resolve. Kept in-memory (never written to disk for non-Claude
   *  engines), so this does not extend the resolver's temp-file secret exposure. */
  resolvedMcp?: ResolvedMcpConfig;
  onStream?: (delta: StreamDelta) => void;
  /** Unique Jinn session ID for tracking the spawned process. */
  sessionId?: string;
  /** Session source ("cron", "web", "slack", …) — used by the interactive engine for lifecycle policy. */
  source?: string;
  /** Interactive engines only: called when a turn that already settled as
   *  failed (API-error StopFailure) later produces a real Stop — the CLI
   *  retried past the grace window and finished. The gateway should persist
   *  `result` as a follow-up assistant message and restore idle status.
   *  `sessionId` is the engine-native session id ("" if unknown). */
  onLateRecovery?: (info: { result: string; sessionId: string }) => void;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  /** Most recent turn's INPUT context size (input + cache-read + cache-creation
   *  tokens) — i.e. how full the context window currently is. Undefined when the
   *  engine doesn't surface usage. */
  contextTokens?: number;
  error?: string;
  /**
   * Optional rate limit metadata returned by an engine.
   * `resetsAt` is a Unix timestamp in seconds.
   */
  rateLimit?: EngineRateLimitInfo;
}

export interface EngineRateLimitInfo {
  status?: string;
  /** Unix timestamp in seconds */
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ConnectorCapabilities {
  threading: boolean;
  messageEdits: boolean;
  reactions: boolean;
  attachments: boolean;
}

export interface ConnectorHealth {
  status: "running" | "stopped" | "error" | "qr_pending";
  detail?: string;
  capabilities: ConnectorCapabilities;
}

export type ReplyContext = JsonObject;

export interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getCapabilities(): ConnectorCapabilities;
  getHealth(): ConnectorHealth;
  reconstructTarget(replyContext: ReplyContext): Target;
  sendMessage(target: Target, text: string): Promise<string | void>;
  replyMessage(target: Target, text: string): Promise<string | void>;
  addReaction(target: Target, emoji: string): Promise<void>;
  removeReaction(target: Target, emoji: string): Promise<void>;
  editMessage(target: Target, text: string): Promise<void>;
  setTypingStatus?(channelId: string, threadTs: string | undefined, status: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  /** Return the bound employee name, if any */
  getEmployee?(): string | undefined;
}

export interface IncomingMessage {
  connector: string;
  source: string;
  sessionKey: string;
  replyContext: ReplyContext;
  messageId?: string;
  channel: string;
  thread?: string;
  user: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  raw: unknown;
  transportMeta?: JsonObject;
}

export interface Attachment {
  name: string;
  url: string;
  mimeType: string;
  localPath?: string;
}

export interface Target {
  channel: string;
  thread?: string;
  messageTs?: string;
  replyContext?: ReplyContext;
}

export interface EngineSessionRef {
  id?: string;
  model?: string;
  effortLevel?: string;
  lastSyncedAt?: string;
  platformContextFingerprint?: string;
}

export type EngineSessionRefs = Record<string, EngineSessionRef>;
export type SessionAttemptOutcome = "succeeded" | "failed" | "interrupted";
export type WorkflowAttemptInterruptionCause = "user-message" | "attempt-stop";

export interface WorkflowAttemptCommand { owner: { workflowId: string; runId: string; nodeId: string; attempt: number }; employeeId: string; engine: string; model?: string; effort?: "low" | "medium" | "high" | "xhigh"; prompt: string }
export interface WorkflowAttemptCompletion { sessionId: string; owner: { workflowId: string; runId: string; nodeId: string; attempt: number }; turn: number; terminalVersion: number; outcome: "succeeded" | "failed" | "interrupted"; interruptionCause?: WorkflowAttemptInterruptionCause; finalText?: string; error?: string; completedAt: string }
export type WorkflowAttemptCompletionListener = (event: WorkflowAttemptCompletion) => void | Promise<void>;
export interface WorkflowSessionExecutor {
  startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }>;
  stopAttempt(input: { sessionId: string; reason: string }): Promise<void>;
  remind(input: { sessionId: string; text: string }): Promise<void>;
  attemptState(sessionId: string): { idle: boolean; runningChildren: number } | null;
}

/** Durable attribution for a workflow-owned employee attempt session. */
export interface WorkflowSessionProvenance {
  kind: "phase";
  workflowId: string;
  /** Canonical agent-facing workflow name (definition.name, falling back to id). */
  workflowName: string;
  runId: string;
  /** Uniform workflow trigger source: manual, schedule, event-webhook, etc. */
  triggerSource: string;
  phase: {
    nodeId: string;
    name: string;
    /** One-based position in the run's frozen execution order. */
    index: number;
    round: number;
    attempt: number;
  };
}

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  engineSessions?: EngineSessionRefs | null;
  source: string;
  sourceRef: string;
  connector: string | null;
  sessionKey: string;
  /** Durable execution-attempt link. Linked sessions are audit evidence and
   * cannot be hard-deleted. */
  workItemId?: string | null;
  replyContext: ReplyContext | null;
  messageId: string | null;
  transportMeta: JsonObject | null;
  employee: string | null;
  model: string | null;
  title: string | null;
  /** ≤140-char whitespace-flattened excerpt of the creation prompt — "what was asked". */
  promptExcerpt?: string | null;
  /** Set when the operator hides this chat from normal lists; the session and
   * transcript remain durable and searchable until explicitly unarchived. */
  archivedAt?: string | null;
  parentSessionId: string | null;
  /** Explicit workflow/run/phase attribution for grouping and filtered reads. */
  workflowProvenance?: WorkflowSessionProvenance | null;
  /** Forwarded SSO identity captured from an auth proxy (opt-in via
   *  `gateway.userHeader`). Null/undefined for single-user installs. */
  userId?: string | null;
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  /** Durable terminal receipt for the latest execution attempt. Conversational
   * `idle` alone is never proof that work completed successfully. */
  attemptOutcome?: SessionAttemptOutcome | null;
  /** Generation token for the currently/latest dispatched attempt. Terminal
   * writers compare this token so a stale engine result cannot overwrite a
   * stop/reset or a newer turn. */
  attemptToken?: string | null;
  /** Monotonic terminal-receipt version within the current attempt generation.
   * Reset to zero on dispatch and incremented for every accepted terminal state. */
  attemptTerminalVersion?: number;
  /** Monotonic count of completed turns in a workflow attempt session. Unlike
   * attemptTerminalVersion, this is not reset when the next turn begins. */
  attemptTurn?: number;
  /** Durable interruption classification recorded before an engine is killed.
   * The paired turn fence prevents an older cause from leaking into a later turn. */
  attemptInterruptionCause?: WorkflowAttemptInterruptionCause | null;
  attemptInterruptionTurn?: number | null;
  effortLevel: string | null;
  totalCost: number;
  totalTurns: number;
  /** Most recent turn's input-context token count (for the UI context meter). */
  lastContextTokens: number | null;
  queueDepth?: number;
  transportState?: "idle" | "queued" | "running" | "error" | "interrupted";
  /** Serialize-time only (in-memory, never persisted): post-settle background
   *  work — the CLI still has upstream API requests in flight (background
   *  subagents/tasks) after the turn settled. Null when none. */
  backgroundActivity?: { activeStreams: number; lastActivityAt: string } | null;
  /** Serialize-time only (derived, never persisted): the in-flight turn has made no
   *  observable progress for a while. Null when the turn is healthy or none runs.
   *  Lets the UI distinguish a wedged session from a hard-thinking one — they are
   *  otherwise identical, indefinitely. */
  turnStall?: {
    /** Epoch ms of the last observable progress — an INSTANT, not a duration.
     *  A duration computed server-side freezes at whatever the last serialize
     *  returned, so the label would stop ticking between refetches; the client
     *  derives the age from this instead. */
    lastProgressAt: number;
    awaitingSubmit: boolean;
  } | null;
  /** Serialize-time only (derived, never persisted): active employee sessions
   *  anywhere below this session in the parent/child tree. */
  delegatedActivity?: DelegatedActivity | null;
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

export interface DelegatedActivity {
  /** Number of active descendant sessions (employees may own more than one). */
  activeSessions: number;
  /** Stable, de-duplicated employee slugs represented by those sessions. */
  employees: string[];
}

export interface SessionDeliveryIdentity {
  targetSessionId: string;
  sourceKind: "session" | "workflow-run";
  sourceId: string;
  sourceAttempt: string;
  sourceOutcome: string;
  sourceVersion: number;
  deliveryKind: string;
}

export interface SessionDeliveryPayload {
  message: string;
  displayMessage: string;
  meta?: JsonObject;
  block?: ChatBlockEnvelope;
}

export interface SessionDelivery extends SessionDeliveryIdentity {
  id: string;
  payload: SessionDeliveryPayload;
  status: "pending" | "accepted" | "dead_letter";
  messageId: string | null;
  queueItemId: string | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: string;
  acceptedAt: string | null;
}

/** Operator-facing dead-letter diagnostics. Poison rows remain discoverable
 * even when their stored payload cannot be decoded safely. */
export interface SessionDeliveryDeadLetter extends Omit<SessionDelivery, "payload"> {
  payload: SessionDeliveryPayload | null;
  payloadError: string | null;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine?: string;
  model?: string;
  effortLevel?: string;
  employee?: string;
  /** The prompt a fire routes to an engine session. */
  prompt: string;
  delivery?: CronDelivery;
}

export interface CronDelivery {
  connector: string;
  channel: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  /** Emoji icon for this employee (shown in sidebar, org chart, etc.) */
  emoji?: string;
  /** Extra CLI flags passed to the engine (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** MCP servers this employee needs. true = all global, false = none, string[] = specific servers */
  mcp?: boolean | string[];
  /** Per-employee override for the built-in `jinn` company toolset (GRS-017e).
   *  true = force-attach even when `mcp.gateway.enabled` is absent (single-employee
   *  pilot; still requires an MCP-capable engine and a passing authed smoke gate);
   *  false = force-detach even when attachment is globally on. Unset = follow the
   *  global setting + the general `mcp` field. This jinn-specific field beats the
   *  general `mcp` field (specific-over-general); the global `enabled: false` kill
   *  switch and a per-engine opt-out beat it. */
  jinnMcp?: boolean;
  /** Max cost in USD for a single session. Overrides global config. */
  maxCostUsd?: number;
  /** Default effort level for sessions assigned to this employee */
  effortLevel?: string;
  /** Whether to notify the parent session when this employee's child session completes. Default: true */
  alwaysNotify?: boolean;
  /** Who this employee reports to. String = single parent. Array = primary + dotted-line (future). */
  reportsTo?: string | string[];
  /** Services this employee provides to the org */
  provides?: ServiceDeclaration[];
}

/** A service that an employee can provide to other employees/departments. */
export interface ServiceDeclaration {
  name: string;
  description: string;
}

/** A node in the resolved org tree. Wraps an Employee with computed hierarchy data. */
export interface OrgNode {
  employee: Employee;
  /** Resolved primary parent name (null = reports to root) */
  parentName: string | null;
  /** Names of direct reports */
  directReports: string[];
  /** Depth in tree (root = 0, root's reports = 1, etc.) */
  depth: number;
  /** Path from root to this node (excluding virtual root), e.g. ["content-lead", "content-writer"] */
  chain: string[];
}

/** Warning about a hierarchy issue. */
export interface OrgWarning {
  employee: string;
  type: "broken_ref" | "cycle" | "self_ref" | "cross_department" | "multiple_executives";
  message: string;
  /** The invalid reportsTo value that caused this warning */
  ref?: string;
}

/** The fully resolved org hierarchy. */
export interface OrgHierarchy {
  /** Root node name — executive employee name, or null if no executive YAML exists */
  root: string | null;
  /** All nodes keyed by employee name */
  nodes: Record<string, OrgNode>;
  /** Ordered list for flat iteration (topological/BFS order, root first) */
  sorted: string[];
  /** Any resolution warnings */
  warnings: OrgWarning[];
}

export interface Department {
  name: string;
  displayName: string;
  description: string;
}

/** Stdio-based MCP server (spawned as child process) */
export interface McpServerStdioConfig {
  /** Shell command to start the MCP server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the MCP server process */
  env?: Record<string, string>;
}

/** HTTP/SSE-based MCP server (remote URL) */
export interface McpServerUrlConfig {
  /** Transport type — Claude Code requires "sse" for URL-based servers */
  type?: "sse";
  /** URL of the MCP server (HTTP streamable or SSE transport) */
  url: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

/** MCP server config — either stdio (command) or URL-based */
export type McpServerConfig = McpServerStdioConfig | McpServerUrlConfig;

/** A fully-resolved MCP server set for one employee/session (env vars expanded,
 *  employee allow/deny applied). Produced by `resolveMcpServers`. Single source
 *  of truth for the payload shape so both the resolver and {@link EngineRunOpts}
 *  reference the same type. */
export interface ResolvedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpGlobalConfig {
  browser?: {
    enabled: boolean;
    provider?: "playwright" | "puppeteer";
  };
  search?: {
    enabled: boolean;
    provider?: "brave";
    apiKey?: string;
  };
  fetch?: {
    enabled: boolean;
  };
  /** The built-in `jinn` MCP server that exposes company primitives (org, work
   *  items, sessions, workflows, …) to engines. Attachment is decided in ONE
   *  place — `decideJinnAttachment` (mcp/attachment.ts) — composing this block
   *  with engine capability and the per-employee `jinnMcp` override. */
  gateway?: {
    /** Master switch for the built-in `jinn` company toolset. `true` = attach to
     *  every MCP-capable engine session (minus the opt-outs below); `false` =
     *  global kill switch (beats every override); absent = the shipped default
     *  (JINN_ATTACH_DEFAULT in mcp/attachment.ts — OFF until the GRS-017e
     *  merge-day flip). */
    enabled?: boolean;
    /** Per-engine opt-out (GRS-017e): `engines: { grok: false }` detaches one
     *  engine (e.g. a known-broken adapter) while the others keep the toolset.
     *  Beats per-employee force-on. `true` entries are redundant but harmless. */
    engines?: Record<string, boolean>;
  };
  /** Custom MCP servers defined by the user */
  custom?: Record<string, (McpServerStdioConfig | McpServerUrlConfig) & { enabled?: boolean }>;
}

export interface WebConnectorConfig {}

export interface SlackConnectorConfig {
  /** Unique instance identifier (e.g. "slack-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  appToken: string;
  botToken: string;
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface DiscordConnectorConfig {
  /** Unique instance identifier (e.g. "discord-vox") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken?: string;       // Make optional — not needed in proxy mode
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  guildId?: string;
  /** Only respond to messages in this channel */
  channelId?: string;
  /** Route messages from specific channels to remote Jinn instances */
  channelRouting?: Record<string, string>;
  /** URL of the primary Jinn instance to proxy Discord I/O through (secondary/remote mode) */
  proxyVia?: string;
}

export interface TelegramConnectorConfig {
  /** Unique instance identifier (e.g. "telegram-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken: string;
  allowFrom?: number[];
  ignoreOldMessagesOnBoot?: boolean;
  /** Speech-to-text settings forwarded from top-level `config.stt` */
  stt?: {
    enabled?: boolean;
    model?: string;
    language?: string;
    languages?: string[];
  };
}

export interface WhatsAppConnectorConfig {
  /** Unique instance identifier (e.g. "whatsapp-main") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  /** Where to store session credentials (default: JINN_HOME/.whatsapp-auth) */
  authDir?: string;
  /** Allowed phone numbers in JID format (e.g. "447700900000@s.whatsapp.net") — empty = allow all */
  allowFrom?: string[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface ConnectorInstance {
  /** Unique instance ID */
  id: string;
  /** Connector type */
  type: "discord" | "discord-remote" | "slack" | "whatsapp" | "telegram";
  /** Employee to bind to this connector */
  employee?: string;
  /** Type-specific configuration */
  [key: string]: unknown;
}

export interface PortalConfig {
  companyName?: string;
  companyPrefix?: string;
  portalName?: string;
  operatorName?: string;
  language?: string;
  onboarded?: boolean;
  setupComplete?: boolean;
}

/**
 * Model + capability registry.
 *
 * The resolved registry (see shared/models.ts) is the single source of truth for
 * which engines/models exist and what they support. A NEW model shipping is a
 * config edit (`models:` block in config.yaml), zero code change. When the block
 * is absent, the registry is synthesized from `engines.<name>.model` so existing
 * configs keep working.
 */

/** How an engine conveys reasoning-effort to its CLI. */
export type EffortMechanism = "claude-flag" | "codex-config" | "grok-flag" | "pi-flag" | "none";

/** A single model and its capabilities, as exposed to the UI / validation. */
export interface ModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  /** Valid effort levels for THIS model (empty when supportsEffort is false). */
  effortLevels: string[];
  /** Context window size in tokens (for the UI context meter). Omit if unknown. */
  contextWindow?: number;
  /** Model is in the engine's featured set — shown by default in the picker
   *  before the "More models…" expansion. Config-driven (engines.<name>.featuredModels). */
  featured?: boolean;
}

/** Resolved per-engine registry entry. */
export interface EngineRegistryEntry {
  name: string;
  /** Engine is registered/usable in this build. */
  available: boolean;
  /** Default model id for new sessions on this engine. */
  defaultModel: string;
  effortMechanism: EffortMechanism;
  models: ModelInfo[];
}

/** Resolved registry, keyed by engine name. */
export type ModelRegistry = Record<string, EngineRegistryEntry>;

// --- Engine quota/limit snapshots ---

export interface EngineLimitWindow {
  name: string;
  usedPercent?: number;
  windowDurationMins?: number;
  /** Unix timestamp in seconds. */
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
  // `unavailable` = the engine CLI is not installed (temporary — install it).
  // `unsupported` = the CLI is installed but exposes no local quota endpoint.
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

// --- config.yaml `models:` block shapes (all fields optional/forgiving) ---

export interface ModelConfigEntry {
  id: string;
  label?: string;
  supportsEffort?: boolean;
  effortLevels?: string[];
  contextWindow?: number;
}

export interface EngineModelsConfig {
  /** Default model id; falls back to the first listed model. */
  default?: string;
  effortMechanism?: EffortMechanism;
  /** Model ids hidden from the resolved registry while discovery stays active. */
  hidden?: string[];
  models: ModelConfigEntry[];
}

/** `models:` block keyed by engine name (claude | codex | antigravity | grok | pi). */
export type ModelsConfig = Record<string, EngineModelsConfig>;

export interface JinnConfig {
  jinn?: { version?: string };
  gateway: {
    port: number;
    host: string;
    streaming?: boolean;
    /** Expose the editable Notes feature. Defaults to false while the implementation stays dormant. */
    notesEnabled?: boolean;
    /** Opt-in unsafe local convenience: allow POST /api/files to write a custom managed path. Default false. */
    allowFileCustomPaths?: boolean;
    /** Opt-in unsafe local convenience: allow POST /api/files {open:true} to open uploaded files. Default false. */
    allowFileOpen?: boolean;
    /** Require token/cookie auth even on loopback. Network binds require auth by default. */
    authRequired?: boolean;
    /** Disable gateway auth. Refused on network binds unless insecureAllowUnauthenticatedNetwork is true. */
    authDisabled?: boolean;
    /** Explicit escape hatch for unauthenticated 0.0.0.0/LAN/Tailscale binds. */
    insecureAllowUnauthenticatedNetwork?: boolean;
    /** Opt-in: when set, POST /api/sessions reads the forwarded SSO identity
     *  from this request header (set by an auth proxy such as oauth2-proxy,
     *  Traefik forward-auth, or IAP) and persists it on the session. Accepts a
     *  single header name or a priority-ordered list. Unset = single-user
     *  no-op (sessions default to "web-user", header never read). */
    userHeader?: string | string[];
  };
  engines: {
    default: "claude" | "codex" | "antigravity" | "grok" | "pi" | "hermes";
    claude: {
      bin: string;
      model: string;
      effortLevel?: string;
      childEffortOverride?: string;
      /** Max concurrent live PTYs across all sessions (CLI/xterm view only). Default 8. */
      maxLivePtys?: number;
      /** Model ids shown by default in the picker (before "More models…"). Defaults
       *  to the three latest alias families (opus/sonnet/fable). Explicit [] = none. */
      featuredModels?: string[];
    };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
    /** Antigravity (`agy`) engine. `bin` is optional — resolved dynamically
     *  (PATH + common install dirs) when absent. agy ignores model/effort flags
     *  today, so those fields are forward-looking. */
    antigravity?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
    grok?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
    pi?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
    /** Hermes (`hermes` CLI) engine. `bin` optional — PATH-resolved. No effort. */
    hermes?: { bin?: string; model?: string };
  };
  /** Optional model + capability registry. When absent, synthesized from engines.<name>.model. */
  models?: ModelsConfig;
  connectors: Record<string, any> & {
    web?: WebConnectorConfig;
    slack?: SlackConnectorConfig;
    telegram?: TelegramConnectorConfig;
    discord?: DiscordConnectorConfig;
    whatsapp?: WhatsAppConnectorConfig;
    /** Named connector instances — allows multiple connectors of the same type */
    instances?: ConnectorInstance[];
  };
  logging: { file: boolean; stdout: boolean; level: string };
  mcp?: McpGlobalConfig;
  sessions?: {
    maxDurationMinutes?: number;
    maxCostUsd?: number;
    interruptOnNewMessage?: boolean;
    /** Max relay hops a lateral (agent-to-agent) send chain may traverse before
     *  the gateway refuses and tells the sender to escalate. Default 12; clamped
     *  to [1, 64] (still a runaway-loop bound, never unbounded). */
    lateralMaxHops?: number;
    /** What to do when Claude hits a usage/rate limit. Default: "wait" (no automatic engine switch). Set to "fallback" to opt in to switching to Codex while Claude resets. */
    rateLimitStrategy?: "wait" | "fallback";
    /** Engine to use when rateLimitStrategy="fallback". Default: "codex" */
    fallbackEngine?: "codex";
  };
  cron?: {
    defaultDelivery?: CronDelivery;
    alertChannel?: string;
    alertConnector?: string;
    /** If a cron job takes longer than this (ms), post a latency warning to the alert channel. Default: 300000 (5 min). */
    alertThresholdMs?: number;
  };
  notifications?: {
    connector?: string;  // defaults to "discord"
    channel?: string;    // Discord channel ID for admin notifications
  };
  portal?: PortalConfig;
  context?: {
    /** Max characters for the built system prompt. Defaults to 100000. */
    maxChars?: number;
  };
  stt?: {
    enabled?: boolean;
    model?: string;
    /** @deprecated Use `languages` instead. Kept for backwards compat. */
    language?: string;
    languages?: string[];
  };
  /** /talk voice loop — optional, off unless explicitly configured. */
  talk?: {
    enabled?: boolean;
    /** Engine for the hands-free voice orchestrator session. When unset (or
     *  unavailable) the talk session falls back to `engines.default`, then to the
     *  first available engine. */
    engine?: string;
    /** Model for the hands-free voice orchestrator session (default: "sonnet" — capable enough to orchestrate). */
    orchestratorModel?: string;
    kokoro?: {
      voice?: string;
      modelDir?: string;
      sidecarPort?: number;
    };
  };
  remotes?: Record<string, { url: string; label?: string; token?: string }>;
}

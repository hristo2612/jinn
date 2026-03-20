export type StreamDeltaType = "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error";

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
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
}

export function isInterruptibleEngine(engine: Engine): engine is InterruptibleEngine {
  return "kill" in engine && "isAlive" in engine && "killAll" in engine;
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  cwd: string;
  bin?: string;
  model?: string;
  effortLevel?: string;
  attachments?: string[];
  /** Extra CLI flags to pass to the engine binary (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** Path to MCP config JSON file (passed as --mcp-config to Claude Code) */
  mcpConfigPath?: string;
  onStream?: (delta: StreamDelta) => void;
  /** Unique Jinn session ID for tracking the spawned process. */
  sessionId?: string;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
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

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  connector: string | null;
  sessionKey: string;
  replyContext: ReplyContext | null;
  messageId: string | null;
  transportMeta: JsonObject | null;
  employee: string | null;
  model: string | null;
  title: string | null;
  parentSessionId: string | null;
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  effortLevel: string | null;
  totalCost: number;
  totalTurns: number;
  queueDepth?: number;
  transportState?: "idle" | "queued" | "running" | "error" | "interrupted";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: 'not_started' | 'in_progress' | 'at_risk' | 'completed';
  level: 'company' | 'department' | 'task';
  parentId: string | null;
  department: string | null;
  owner: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine?: string;
  model?: string;
  employee?: string;
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
  rank: "executive" | "director" | "manager" | "lead" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  /** Emoji icon for this employee (shown in sidebar, org chart, etc.) */
  emoji?: string;
  /** Extra CLI flags passed to the engine (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** MCP servers this employee needs. true = all global, false = none, string[] = specific servers */
  mcp?: boolean | string[];
  /** Max cost in USD for a single session. Overrides global config. */
  maxCostUsd?: number;
  /** Default effort level for sessions assigned to this employee */
  effortLevel?: string;
  /** Relative path in the org tree, e.g. "nexamon-studio/design" */
  orgPath?: string;
  /** Name of the employee's direct manager (deduced from parent department.yaml) */
  reportsTo?: string;
}

export interface Department {
  name: string;
  displayName: string;
  description?: string;
  /** Name of the department manager (employee name) */
  manager?: string;
  /** Relative path in the org tree, e.g. "nexamon-studio/design" */
  path: string;
  /** Parent department path, e.g. "nexamon-studio" */
  parent?: string;
  /** Sub-department paths */
  children: string[];
  /** Direct employee names in this department */
  employees: string[];
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
  gateway?: {
    enabled: boolean;
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
  /** Connector type: "discord" | "slack" | "whatsapp" */
  type: "discord" | "slack" | "whatsapp";
  /** Employee to bind to this connector */
  employee?: string;
  /** Type-specific configuration */
  [key: string]: unknown;
}

export interface PortalConfig {
  portalName?: string;
  operatorName?: string;
  language?: string;
  onboarded?: boolean;
}

export interface JinnConfig {
  jinn?: { version?: string };
  gateway: { port: number; host: string; streaming?: boolean };
  engines: {
    default: "claude" | "codex";
    claude: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
  };
  connectors: Record<string, any> & {
    web?: WebConnectorConfig;
    slack?: SlackConnectorConfig;
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
    /** What to do when Claude hits a usage/rate limit. Default: "fallback" */
    rateLimitStrategy?: "wait" | "fallback";
    /** Engine to use when rateLimitStrategy="fallback". Default: "codex" */
    fallbackEngine?: "codex";
  };
  cron?: {
    defaultDelivery?: CronDelivery;
    alertChannel?: string;
    alertConnector?: string;
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
  remotes?: Record<string, { url: string; label?: string }>;
}

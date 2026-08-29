/**
 * The `config.yaml` shape. It lives beside `types.ts` rather than inside it so
 * the config schema can grow without pushing the shared type surface past its
 * size budget; `types.ts` re-exports `JinnConfig` so every existing importer is
 * unaffected.
 */
import type { EngineName } from "./models.js";
import type { RealtimeConfig, SttConfig, TalkConfig } from "./voice.js";
import type {
  ConnectorInstance,
  CronDelivery,
  DiscordConnectorConfig,
  McpGlobalConfig,
  ModelsConfig,
  SlackConnectorConfig,
  TelegramConnectorConfig,
  WebConnectorConfig,
  WhatsAppConnectorConfig,
} from "./types.js";

export interface PortalConfig {
  companyName?: string;
  companyPrefix?: string;
  portalName?: string;
  operatorName?: string;
  operatorEmoji?: string;
  language?: string;
  onboarded?: boolean;
  setupComplete?: boolean;
}

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
    /** Nudge sessions this gateway's own restart interrupted to continue on the
     *  next boot. Default true; false leaves them interrupted for the operator. */
    resumeInterruptedSessions?: boolean;
    /** Bounded Todo recovery (PLA-240). Unset = classify-only: lanes and
     *  metrics, no automatic re-arm. `auto` is a reviewed production gate. */
    todoRecovery?: { mode?: "off" | "classify-only" | "auto" };
    /** Opt-in: when set, POST /api/sessions reads the forwarded SSO identity
     *  from this request header (set by an auth proxy such as oauth2-proxy,
     *  Traefik forward-auth, or IAP) and persists it on the session. Accepts a
     *  single header name or a priority-ordered list. Unset = single-user
     *  no-op (sessions default to "web-user", header never read). */
    userHeader?: string | string[];
  };
  engines: {
    default: EngineName;
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
      /** Auto-answer Claude Code's hardcoded safety prompts (dangerous rm on a
       *  possibly-empty variable path, the `&` background operator, suspicious
       *  Windows paths) — the ones --dangerously-skip-permissions does NOT
       *  suppress. Default true: a gateway PTY has no keyboard, so leaving them
       *  unanswered wedges the session. Set false to require a human in the
       *  CLI/xterm view; the turn then fails on the stall backstop instead. */
      autoApproveSafetyPrompts?: boolean;
      /** Engines to try instead, in order of preference, when this one cannot serve a
       *  turn. An engine may not name itself, but two engines may name each other:
       *  cycles are tolerated at runtime by the walker's visited set. Absent = no
       *  fallback, which is also what an explicit [] says. */
      fallback?: EngineName[];
      /** How this engine's pinned models translate onto whichever engine stands in
       *  for it, as `<model this engine serves>: <model the substitute serves>`. A
       *  model id belongs to one provider, so an unmapped pin is dropped and the
       *  substitute runs on its own default — this is only for keeping the tier a
       *  turn was sized for, e.g. a cheap model swapping to a cheap one. */
      fallbackModelMap?: Record<string, string>;
    };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string; fallback?: EngineName[] ; fallbackModelMap?: Record<string, string> };
    /** Antigravity (`agy`) engine. `bin` is optional — resolved dynamically
     *  (PATH + common install dirs) when absent. agy ignores model/effort flags
     *  today, so those fields are forward-looking. */
    antigravity?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string; fallback?: EngineName[] ; fallbackModelMap?: Record<string, string> };
    grok?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string; fallback?: EngineName[] ; fallbackModelMap?: Record<string, string> };
    pi?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string; fallback?: EngineName[] ; fallbackModelMap?: Record<string, string> };
    /** Hermes (`hermes` CLI) engine. `bin` optional — PATH-resolved. No effort. */
    hermes?: { bin?: string; model?: string; fallback?: EngineName[] ; fallbackModelMap?: Record<string, string> };
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
  /** Installed plugins the operator has explicitly decided on. Absence is not
   *  enabled and `disabled` wins over `enabled` (src/plugins/enablement.ts);
   *  `settings[<id>]` reaches that plugin as `ctx.settings` (plugins/backend.ts). */
  plugins?: { enabled?: string[]; disabled?: string[]; settings?: Record<string, Record<string, unknown>> };
  /** Spend caps keyed by employee name: a USD cap on that employee's total spend across the
   *  current calendar month — NOT a per-session cap. At or above it, their turns are blocked. */
  budgets?: { employees?: Record<string, number> };
  sessions?: {
    interruptOnNewMessage?: boolean;
    staleChat?: {
      enabled?: boolean;
      tokenThreshold?: number;
      staleAfterMinutes?: number;
    };
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
  workflows?: {
    /** Local Git branch a code Workflow must prove delivery to before its Todo
     * may close. Defaults to `main`. */
    delivery?: {
      /** @deprecated Remote publication is not part of Workflow delivery. */
      remote?: string;
      branch?: string;
    };
    /**
     * Employees whose OWN move of a Todo to `assigned` may satisfy a
     * `todo-status` trigger's `actor: operator` filter, so an autonomous
     * continuation can arm a pipeline without impersonating the operator.
     *
     * It grants arming and nothing else: the transition is still recorded
     * against the session that made it, `asOperator` stays refused, and
     * approvals, cancellation, and every other status are untouched. Absent or
     * empty is the default and behaves exactly as if the key did not exist.
     */
    armingDelegates?: string[];
  };
  portal?: PortalConfig;
  context?: {
    /** Max characters for the built system prompt. Defaults to 100000. */
    maxChars?: number;
  };
  stt?: SttConfig;
  /** Read-aloud TTS (`/api/tts` + Kokoro) — optional, off unless configured. */
  talk?: TalkConfig;
  /**
   * Speech-to-speech realtime provider — optional, off unless configured. A
   * sibling of `talk` rather than a child of it, because `talk`'s
   * enabled/engine/orchestratorModel fields are retired-orchestrator residue
   * slated for removal.
   */
  realtime?: RealtimeConfig;
  /**
   * Remote (SSH) execution for employees that declare `remoteHost`. Absent means
   * remote employees refuse to load at all — the fail-closed default, because
   * this ships to strangers and a remote session runs
   * `--dangerously-skip-permissions` on someone's real machine.
   */
  remote?: RemoteExecutionConfig;
}

/**
 * Remote (SSH) execution settings. One block for the whole instance: every
 * remote employee shares the sandbox root, the JINN_HOME mount point, and the
 * wake policy. Per-employee variation lives on the Employee record (host, user,
 * cwd) and nowhere else.
 */
export interface RemoteExecutionConfig {
  /** The one absolute prefix on the remote host that every `remoteCwd` must
   *  resolve under. The single most proportionate guardrail for running
   *  unattended with `--dangerously-skip-permissions` on a daily-driver box: it
   *  does not stop a determined prompt from `cd ..`-ing out, but it bounds the
   *  realistic accidental blast radius. */
  root: string;
  /** Where the gateway's own JINN_HOME is sshfs-mounted on the remote host. The
   *  remote session's `$JINN_HOME` is a symlink farm over this, so knowledge,
   *  docs, org and skills are the gateway's real files rather than copies. */
  mount: string;
  /** Run ON THE GATEWAY to wake a sleeping host (smart plug, jump box, …).
   *  Takes precedence over {@link wakeMac}. */
  wakeCommand?: string;
  /** MAC address for the built-in Wake-on-LAN magic packet, used when
   *  {@link wakeCommand} is unset. */
  wakeMac?: string;
  /** Run ON THE REMOTE once it is reachable, to re-establish the JINN_HOME
   *  mount. A reboot does not bring sshfs back, so a successful wake normally
   *  lands on a dead mount without this. */
  remountCommand?: string;
  /** Total bound on waiting for an unreachable host, in ms. Default 240000.
   *  Bounded on purpose: a box that is off for the weekend must fail the turn,
   *  not pin it at "waiting" forever. */
  waitMs?: number;
  /** Interval between reachability probes while waiting, in ms. Default 10000. */
  probeIntervalMs?: number;
}

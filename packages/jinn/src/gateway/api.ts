import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ChatBlock, ChatBlockEnvelope, CronJob, DelegatedActivity, Employee, Engine, IncomingMessage, JinnConfig, JsonObject, Session, StreamDelta, Target } from "../shared/types.js";
import { isInterruptibleEngine, reportsTurnProgress, STRUCTURED_MESSAGE_BODY_MAX_CHARS } from "../shared/types.js";
import { compactEmployeeRole } from "../shared/employee-role.js";
export { compactEmployeeRole } from "../shared/employee-role.js";
import {
  getModelRegistry,
  invalidateModelRegistry,
  effortLevelsForModel,
  refreshAntigravityModels,
  refreshClaudeModels,
  refreshCodexModels,
  refreshGrokModels,
  refreshHermesModels,
  refreshPiModels,
  engineAvailable,
  isKnownEngine,
  engineUnavailableMessage,
} from "../shared/models.js";
import { validateNewSessionSelection, validateSessionPatch } from "../sessions/session-patch.js";
import { buildDelegatedActivityIndex } from "../sessions/delegated-activity.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildContext, buildPlatformContextSnapshot, type BuildContextOptions } from "../sessions/context.js";
import { buildPlatformContextRefresh, fingerprintPlatformContext } from "../engines/platform-context.js";
import {
  listSessions,
  countSessions,
  listRecentPerGroup,
  listSessionsForGroup,
  getSessionGroupCounts,
  coercePortalEmployee,
  searchSessions,
  searchMessages,
  searchSessionsFiltered,
  getMessageContext,
  getCostReport,
  stripControlChars,
  hasControlBytes,
  MESSAGE_CONTEXT_MAX_RADIUS,
  type MessageSearchFilter,
  type SearchSessionsFilter,
  listChildSessions,
  listSessionsByWorkItem,
  getSession,
  getEngineSessionRef,
  createSession,
  updateSession,
  archiveSession,
  unarchiveSession,
  beginSessionAttempt,
  completeSessionAttempt,
  updateSessionForAttempt,
  recordEngineSessionId,
  switchSessionEngine,
  clearEngineSessionRefs,
  UpdateSessionFields,
  deleteSession,
  deleteSessions,
  duplicateSession,
  insertMessage,
  insertMessageAfter,
  applyBlockEnvelope,
  deletePartialMessages,
  settlePartialMessages,
  getMessages,
  getPartialMessages,
  getMessagePage,
  enqueueQueueItem,
  cancelQueueItem,
  markRunningQueueItemsCompletedForSession,
  getQueueItems,
  cancelAllPendingQueueItems,
  listAllPendingQueueItems,
  getSessionDelivery,
  getSessionDeliveryByQueueItemId,
  listDeadLetterSessionDeliveries,
  requeueDeadLetterSessionDelivery,
  acceptSessionDelivery,
  claimSessionDelivery,
  getFile,
  getSessionBySessionKey,
  initDb,
  recordChildReportedToParent,
  recordTurnAccounting,
  RESTART_ACK_META_KEY,
} from "../sessions/registry.js";
import { blockFallbackText, validateBlockEnvelope } from "../shared/blocks.js";
import {
  createPartialStreamWriter,
  normalizeBlockDeltaForTurn,
} from "../sessions/partial-stream.js";
import {
  isDurableWorkflowUserMessageInterruption,
  USER_MESSAGE_INTERRUPTION_REASON,
} from "../sessions/workflow-interruptions.js";
export {
  foldPartialText,
  normalizeBlockDeltaForTurn,
} from "../sessions/partial-stream.js";
import { forkEngineSession } from "../sessions/fork.js";
import { removeCodexSessionHome } from "../engines/codex.js";
import { ptySnapshotStore } from "../engines/pty-snapshot.js";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  LOGS_DIR,
  TMP_DIR,
  FILES_DIR,
  TEMPLATE_MIGRATIONS_DIR,
  resolveHomeIdentity,
} from "../shared/paths.js";
import { saveConfigAtomic } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { redactText } from "../shared/redact.js";
import { getSttStatus, downloadModel, transcribe as sttTranscribe, resolveLanguages, WHISPER_LANGUAGES } from "../stt/stt.js";
import { CODEX_HOMES_DIR, JINN_HOME } from "../shared/paths.js";
import { resolveEffort } from "../shared/effort.js";
import { selectClaudeModelFallback } from "../shared/model-fallback.js";
import { detectRateLimit, rateLimitEngineLabel } from "../shared/rateLimit.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { handleRateLimit } from "../sessions/rate-limit-handler.js";
import { resolveEngineRunMcp } from "../sessions/engine-run-mcp.js";
import { getPendingInstanceMigration, type PendingInstanceMigration } from "../migrations/service.js";
import { createMigrationSnapshot } from "../migrations/snapshot.js";
import { getPackageVersion } from "../shared/version.js";
import { pickEncoding, compressBuffer, MIN_COMPRESS_BYTES } from "./compress.js";
import { canonicalCronJobId, loadJobs, saveJobs } from "../cron/jobs.js";
import { summarizeCronRun } from "../cron/run-summary.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { validateCronSchedule } from "../cron/validation.js";
import { runCronJob } from "../cron/runner.js";
import { ActivityQueryError, getActivityStory, queryActivityPage } from "../activity/query.js";
import type { ActivityKind, ActivityOutcomeState } from "../activity/types.js";
import QRCode from "qrcode";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { handleFilesRequest, handleSessionAttachment, fileIdsToMedia, rehomeAttachmentsToSession, ensureFilesDir, mimeFromFilename, MultipartUploadError, readLocalFileForIngestion, readMultipartFile, sanitizeUploadFilename } from "./files.js";
import { readJsonBody, readBodyRaw } from "./http-helpers.js";
import { resolveMessageAudiences, speechContextApplies } from "./speech-context.js";
import { isJsonMediaType } from "./media-type.js";
import { readJsonlTail } from "./jsonl-tail.js";
import { completedStreamedBlockIds } from "./streamed-blocks.js";
import { deliverClaimedSessionDelivery, notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel, notifyAttachedTalkSessions, recoverPendingSessionDeliveries } from "../sessions/callbacks.js";
import { clearDelegationCompletionContract, DELEGATION_COMPLETION_TRACKED_META_KEY } from "../sessions/delegation-completion-contract.js";
import { clipSessionMessage, sessionCommGuards, prepareLateralSend, isDescendantOf, resolveCallerIdentity } from "./session-comm-guards.js";
import {
  ACTIVITY_OPERATION_HEADER,
  ACTIVITY_TOOL_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  UNIDENTIFIED_TOOL_CALL_ERROR,
  verifySessionCapability,
} from "../mcp/identity.js";
import {
  persistAndEmitActivityBlock,
  todoActivityBlock,
  type ActivityOperation,
  type ChatActivityContext,
} from "./chat-activity.js";
import {
  appendWorkItemEvent,
  createWorkItem,
  getWorkItem,
  getWorkItemBySourceRef,
  getWorkItemSpend,
  getWorkItemTree,
  linkSession,
  listWorkItemEvents,
  listWorkItems,
  queryWorkItems,
  STICKY_STATUSES,
  updateWorkItemConditional,
  WorkItemIdempotencyConflictError,
  WorkItemVersionConflictError,
  type CreateWorkItemInput,
  type SearchWorkItemsFilter,
  type UpdateWorkItemInput,
  type VerifyPolicy,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from "../work-items/store.js";
import { isTodoId, parseTodoId, resolveTodoIdPrefix } from "../work-items/id.js";
import {
  addComment,
  commentsTail,
  editComment,
  getComment,
  listComments,
  tombstoneComment,
  WorkItemCommentError,
  COMMENT_PAGE_DEFAULT_LIMIT,
  COMMENT_PAGE_MAX_LIMIT,
} from "../work-items/comments.js";
import {
  addRelation,
  blockedSet,
  isBlocked,
  listRelations,
  removeRelation,
  WorkItemRelationError,
  type RelationKind,
} from "../work-items/relations.js";
import {
  createLabel,
  getWorkItemLabels,
  labelSets,
  listLabels,
  normalizeLabelName,
  setWorkItemLabels,
  type Label,
} from "../work-items/labels.js";
import {
  addAttachment,
  ATTACHMENT_MAX_BYTES,
  getAttachment,
  listAttachments,
  removeAttachment,
  stageAttachmentBuffer,
  WorkItemAttachmentError,
  type AttachmentActor,
} from "../work-items/attachments.js";
import { listDepartmentsWithCounts } from "../work-items/departments.js";
import { assignWorkItem, transition, TransitionError } from "../work-items/transitions.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import {
  archiveWorkItem,
  decideWorkItemApproval,
  escalateApproval,
  listApprovals,
  requestApproval,
} from "../work-items/approvals.js";
import { resolveApprovalDecisionAuthority, resolveApprovalRouteTarget, resolveRootApprovalTarget } from "./approval-authority.js";
import { scanOrg } from "./org.js";
import { resolveOrgHierarchy } from "./org-hierarchy.js";
import { surfaceManagerVisibility } from "./manager-visibility.js";
import { searchKnowledge, readKnowledgeFile } from "../knowledge/store.js";
import {
  NOTE_FILE_MAX_BYTES,
  createNote,
  listNotes,
  readNote,
  updateNote,
  type NoteStoreResult,
} from "../notes/store.js";
import { loadInstances, saveInstances, type Instance, type InstanceInput } from "../instances/directory.js";
import { createInstance, type CreateInstanceInput, type CreateInstanceResult } from "../instances/create.js";
import { startInstance, type StartInstanceInput, type StartInstanceResult } from "../instances/start.js";
import {
  readTailscaleServeMappings,
  resolveInstanceSwitchUrl,
  type TailscaleServeMapping,
} from "../instances/access.js";
import { isLoopback, validateHookPost } from "./hook-endpoint.js";
import {
  authenticateGatewayRequest,
  authCookieHeaders,
  clearAuthCookieHeaders,
  consumeLocalBootstrapGrant,
  consumePairingCode,
  createAuthSession,
  createAuthState,
  createFilePairingCodeStore,
  currentAuthDeviceId,
  hasGatewayBearerAuth,
  issuePairingCode,
  isLoopbackHost,
  LOCAL_BOOTSTRAP_GRANT_HEADER,
  listAuthSessions,
  revokeAuthSession,
  shouldRequireGatewayAuth,
  touchAuthSession,
  verifyGatewayAuth,
} from "./auth.js";
import {
  consumePairingChallenge,
  issuePairingChallenge,
  PAIRING_CHALLENGE_TTL_MS,
} from "./pairing-challenge.js";
import { markTranscriptSyncedThrough, scheduleOnLoadTailSync, transcriptEntryText } from "./external-turns.js";
import { getOrchestratorPersona } from "../talk/orchestrator-persona.js";
import {
  feedTalkText,
  flushTalkSpeech,
  discardTalkSpeech,
  streamTtsSentences,
  ttsStatus,
  validateTtsText,
} from "../talk/tts-stream.js";
import { isTalkMuted } from "../talk/mute-state.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import { onboardingNeeded, applyEngineChoice } from "./onboarding-policy.js";
import { restartDetached, type RestartDetachedOptions } from "./lifecycle.js";
import { updateSkillContent } from "./skills.js";
import type { WorkflowService } from "../workflows/service.js";
import { handleWorkflowApi } from "./workflow-api.js";

/** Max bytes accepted on /api/internal/hook (loopback-only relay payloads are tiny). */
const HOOK_BODY_MAX_BYTES = 64 * 1024;
/** Max bytes accepted by public auth helpers. Codes/tokens are tiny. */
const AUTH_BODY_MAX_BYTES = 16 * 1024;
/** Operator Todo PATCH cap, measured as raw UTF-8 request bytes including JSON overhead. */
export const TODO_EDIT_BODY_MAX_BYTES = 64 * 1024;
/** HTTP parity with the MCP label_work_item cap (slice-3 review N1). */
export const TODO_LABELS_MAX = 100;
/** Cap for editable SKILL.md bodies. */
const SKILL_CONTENT_BODY_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_LIST_PER_GROUP = 50;
const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000;
const SUPERSEDED_TURN_META_KEY = "supersededRunningTurnAt";
function headerValue(req: HttpRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseMessageLimit(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(500, parsed);
}

export function shouldPersistFinalAssistantMessage(options: {
  resultText: string;
  quietPreempted: boolean;
}): boolean {
  if (options.quietPreempted) return false;
  return options.resultText.trim().length > 0;
}

export function formatEngineErrorAssistantMessage(error: string): string {
  return `Error: ${error}`;
}

export interface ApiContext {
  config: JinnConfig;
  sessionManager: SessionManager;
  startTime: number;
  /** Opaque process-generation id used only in platform-context fingerprints. */
  gatewayBootId?: string;
  getConfig: () => JinnConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../shared/types.js").Connector>;
  reloadConnectorInstances?: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  /** Re-read config.yaml into memory immediately (same as the file-watcher does,
   *  but synchronous). Call after a handler writes config.yaml so getConfig()
   *  reflects the change without waiting on the debounced watcher (~1s). */
  reloadConfig?: () => void;
  hookRegistry?: import("./hook-registry.js").HookRegistry;
  hookSecret?: string;
  /** PTY-backed Claude engine used by CLI-mode message sends so the user sees the
   *  prompt + response stream into the live xterm. Distinct from the headless
   *  "claude" engine in sessionManager (which chat/cron/connectors use). */
  interactiveClaudeEngine?: import("../engines/claude-interactive.js").InteractiveClaudeEngine;
  /** PTY-capable engines keyed by engine name. Used by CLI-mode web sends. */
  ptyViewEngines?: Record<string, Engine & import("../engines/pty-view-engine.js").PtyViewEngine>;
  /** Synchronously re-scan org/ into the gateway's in-memory employee registry
   *  (and drop warm PTYs). Called after an employee YAML write so the next session
   *  spawn sees the new persona/model immediately, rather than waiting ~800ms for
   *  the chokidar watcher. Wired in server.ts; same body as the watcher's onOrgChange. */
  reloadOrg?: () => void;
  /** In-memory (never persisted) post-settle background activity per session,
   *  maintained in server.ts from the interactive engine's onBackgroundActivity
   *  callback. lastActivityAt is epoch ms; serializeSession converts to ISO. */
  backgroundActivity?: Map<string, { activeStreams: number; lastActivityAt: number }>;
  /** Gateway auth token for seamless browser/CLI access when auth is required. */
  gatewayAuthToken?: string;
  /** Test-injectable Jinn home for auth device storage. Defaults to shared JINN_HOME. */
  jinnHome?: string;
  /** Test-injectable gateway restart primitive. Defaults to lifecycle.restartDetached(). */
  restartGateway?: (options: RestartDetachedOptions) => void;
  /** Immutable port actually bound by this gateway process, unaffected by config hot reload. */
  runtimePort?: number;
  /** Test/package-lab overrides for automatic instance migration discovery. */
  migrationMigrationsDir?: string;
  migrationPackageVersion?: string;
  /** Test seam; production uses the normal web-session dispatch machinery. */
  dispatchInstanceMigration?: (session: Session, prompt: string) => void;
  /** Test seams for the host-level workspace directory and creation service. */
  loadWorkspaceInstances?: () => Instance[];
  saveWorkspaceInstances?: (instances: InstanceInput[]) => void;
  checkWorkspaceRunning?: (instance: Instance, current: boolean) => Promise<boolean>;
  readWorkspaceAccessMappings?: () => Promise<TailscaleServeMapping[]>;
  createWorkspaceInstance?: (input: CreateInstanceInput) => Promise<CreateInstanceResult>;
  startWorkspaceInstance?: (input: StartInstanceInput) => Promise<StartInstanceResult>;
  issueWorkspacePairingCode?: (home: string) => string;
  workflowService?: WorkflowService;
}

function pendingInstanceMigration(context: ApiContext): PendingInstanceMigration {
  return getPendingInstanceMigration({
    instanceHome: context.jinnHome ?? JINN_HOME,
    packageVersion: context.migrationPackageVersion ?? getPackageVersion(),
    migrationsDir: context.migrationMigrationsDir ?? TEMPLATE_MIGRATIONS_DIR,
  });
}

const migrationOpenLocks = new Map<string, Promise<{ sessionId: string; migrationKey: string; reused: boolean }>>();

function acceptedInstanceMigrationSession(
  sessionKey: string,
  prompt: string,
): Session | undefined {
  const session = getSessionBySessionKey(sessionKey);
  if (!session) return undefined;
  const hasAcceptedQueueIntent = getQueueItems(sessionKey).some((item) => (
    item.sessionId === session.id && item.prompt === prompt
  ));
  return hasAcceptedQueueIntent || session.attemptOutcome === "succeeded" ? session : undefined;
}

function retireUnacceptedInstanceMigrationSession(sessionKey: string): void {
  const session = getSessionBySessionKey(sessionKey);
  if (!session) return;
  updateSession(session.id, {
    sessionKey: `retired:${sessionKey}:${session.id}`,
    status: session.status === "error" ? "error" : "interrupted",
    lastActivity: new Date().toISOString(),
    lastError: session.lastError ?? "Migration handoff was not durably accepted; retired before retry.",
  });
}

/** A snapshot failure caused by the platform refusing symlink creation. Windows
 *  needs SeCreateSymbolicLinkPrivilege (Developer Mode or elevation) and reports
 *  EPERM; the operator can fix it, but only if told which knob to turn. */
export function isSymlinkPrivilegeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  const syscall = (error as NodeJS.ErrnoException).syscall;
  if (syscall === "symlink" && (code === "EPERM" || code === "EACCES")) return true;
  return /symlink/i.test(error.message) && /EPERM|EACCES|operation not permitted|denied/i.test(error.message);
}

async function openInstanceMigration(
  pending: PendingInstanceMigration,
  req: HttpRequest,
  context: ApiContext,
): Promise<{ sessionId: string; migrationKey: string; reused: boolean }> {
  const migrationKey = pending.migrationKey!;
  const sessionKey = `instance-migration:${migrationKey}`;
  const inFlight = migrationOpenLocks.get(migrationKey);
  if (inFlight) return { ...(await inFlight), reused: true };
  const create = Promise.resolve().then(async () => {
    const prompt = pending.prompt!;
    const accepted = acceptedInstanceMigrationSession(sessionKey, prompt);
    if (accepted) return { sessionId: accepted.id, migrationKey, reused: true };
    retireUnacceptedInstanceMigrationSession(sessionKey);

    const config = context.getConfig();
    const selection = validateNewSessionSelection(config, {});
    if (!selection.ok) throw new Error(selection.error || "invalid default engine selection");
    const engineName = selection.engine || config.engines.default;
    const engine = context.sessionManager.getEngine(engineName);
    if (!engine) throw new Error(`Engine "${engineName}" not available`);

    createMigrationSnapshot({
      instanceHome: context.jinnHome ?? JINN_HOME,
      migrationKey,
      fromVersion: pending.fromVersion,
      toVersion: pending.toVersion,
      changedFiles: pending.changedFiles,
      materialization: pending.materialization,
    });
    const afterSnapshot = acceptedInstanceMigrationSession(sessionKey, prompt);
    if (afterSnapshot) return { sessionId: afterSnapshot.id, migrationKey, reused: true };
    retireUnacceptedInstanceMigrationSession(sessionKey);
    const session = createSession({
      engine: engineName,
      source: "web",
      sourceRef: sessionKey,
      connector: "web",
      sessionKey,
      replyContext: { source: "web" },
      userId: resolveUserHeader(req.headers, config.gateway.userHeader),
      employee: undefined,
      effortLevel: selection.effortLevel,
      model: selection.model,
      prompt,
      promptExcerpt: `Finish v${pending.toVersion} setup`,
      portalName: config.portal?.portalName,
    });
    insertMessage(session.id, "user", prompt);
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
    session.status = "running";
    const queueKey = session.sessionKey || session.sourceRef || session.id;
    const queueItemId = enqueueQueueItem(session.id, queueKey, prompt);
    context.emit("queue:updated", { sessionId: session.id, sessionKey: queueKey });
    try {
      if (context.dispatchInstanceMigration) context.dispatchInstanceMigration(session, prompt);
      else {
      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId });
      }
    } catch (error) {
      cancelQueueItem(queueItemId);
      updateSession(session.id, {
        status: "error",
        attemptOutcome: "failed",
        lastActivity: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });
    return { sessionId: session.id, migrationKey, reused: false };
  });
  migrationOpenLocks.set(migrationKey, create);
  try { return await create; }
  finally { migrationOpenLocks.delete(migrationKey); }
}

function killSessionEngines(context: ApiContext, session: Session, reason: string): void {
  const engines = new Set<Engine>();
  const primary = context.sessionManager.getEngine(session.engine);
  const pty = context.ptyViewEngines?.[session.engine];
  if (primary) engines.add(primary);
  if (pty) engines.add(pty);
  for (const engine of context.sessionManager.getEngines().values()) engines.add(engine);
  for (const engine of Object.values(context.ptyViewEngines ?? {})) engines.add(engine);

  for (const engine of engines) {
    if (isInterruptibleEngine(engine)) engine.kill(session.id, reason);
  }
}

/** Preserve a linked execution attempt as durable evidence when deletion is
 * requested. Unsettled work becomes explicitly interrupted; an existing
 * terminal receipt remains authoritative. The periodic reconciler is also a
 * crash-safe backstop if the process exits between these durable writes. */
function preserveLinkedAttempt(
  context: ApiContext,
  session: Session,
  reason: string,
): Session {
  killSessionEngines(context, session, reason);
  context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  const unresolved = !session.attemptOutcome || session.status === "running" || session.status === "waiting";
  const preserved = unresolved
    ? (updateSession(session.id, {
        status: "interrupted",
        attemptOutcome: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: reason,
      }) ?? session)
    : session;
  if (session.workItemId) reconcileWorkItem(session.workItemId);
  return preserved;
}

export function resumePendingWebQueueItems(context: ApiContext): void {
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  let resumed = 0;
  for (const item of pending) {
    let session = getSession(item.sessionId);
    if (!session) {
      cancelQueueItem(item.id);
      continue;
    }
    // Ordinary non-web queue ownership remains connector-specific. Callback
    // receipts are the exception: acceptance already committed this internal
    // turn, so startup replay must finish it regardless of the parent's source.
    const callbackDelivery = getSessionDeliveryByQueueItemId(item.id);
    if (session.source !== "web" && !callbackDelivery) continue;
    session = maybeRevertEngineOverride(session);

    const config = context.getConfig();
    const engine = context.sessionManager.getEngine(session.engine);
    if (!engine) {
      const diagnostic = `Engine "${session.engine}" not available`;
      if (callbackDelivery) {
        // Acceptance committed this exact queue row as part of the callback
        // outbox. Engine availability is transient operational state, not a
        // reason to destroy that accepted intent. Keep the row pending so a
        // later config/engine reload can replay the same durable ID.
        updateSession(session.id, { lastActivity: new Date().toISOString(), lastError: diagnostic });
        logger.warn(`Deferred accepted callback queue ${item.id}: ${diagnostic}`);
      } else {
        cancelQueueItem(item.id);
        updateSession(session.id, { status: "error", lastActivity: new Date().toISOString(), lastError: diagnostic });
      }
      continue;
    }

    // Ensure the session is in a runnable state
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });

    dispatchWebSessionRun(session, item.prompt, engine, config, context, { queueItemId: item.id });
    resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
}

function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[] },
): void {
  let dispatchedAttemptToken: string | undefined;
  const run = async () => {
    const sessionKey = session.sessionKey || session.sourceRef;
    try {
      await context.sessionManager.getQueue().enqueue(sessionKey, async () => {
        const startedAttempt = beginSessionAttempt(session.id, {
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        if (!startedAttempt?.attemptToken) {
          logger.info(`Skipping web session ${session.id}: attempt could not be started`);
          return;
        }
        dispatchedAttemptToken = startedAttempt.attemptToken;
        context.emit("session:started", { sessionId: session.id });
        // Item moved pending → running: refresh the queue panel.
        if (opts?.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey });
        await runWebSession(startedAttempt, prompt, engine, config, context, startedAttempt.attemptToken, opts?.attachments);
        if (startedAttempt.workflowProvenance?.kind === "phase") {
          context.sessionManager.emitWorkflowAttemptTurnCompletion(session.id);
        }
      }, opts?.queueItemId);
    } finally {
      // Item settled (completed/cancelled/errored): refresh so the "N queued"
      // panel drains. Without this the panel only refreshes on enqueue and the
      // badge sticks at its peak. (queue.ts marks the DB row done in its finally.)
      if (opts?.queueItemId) context.emit("queue:updated", { sessionId: session.id, sessionKey });
    }
  };

  const launch = () => {
    run().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
      const erroredOnDispatch = dispatchedAttemptToken
        ? completeSessionAttempt(session.id, dispatchedAttemptToken, {
            status: "error",
            lastActivity: new Date().toISOString(),
            lastError: errMsg,
          })
        : undefined;
      if (erroredOnDispatch) {
        if (erroredOnDispatch.workflowProvenance?.kind === "phase") {
          context.sessionManager.emitWorkflowAttemptTurnCompletion(session.id);
        }
        context.emit("session:completed", {
          sessionId: session.id,
          result: null,
          error: errMsg,
        });
      }
      // This outer dispatch-error path bypasses notifyParentSession (run() failed
      // before its own completion handling), so wake any attached talk sessions
      // here too — otherwise an attachment wake is silently lost on a hard failure.
      if (erroredOnDispatch) {
        notifyAttachedTalkSessions(erroredOnDispatch, { error: errMsg });
        maybeEmitTalkGraph(session.id, "completed", { getSession, emit: context.emit });
      }
    });
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(launch, opts.delayMs);
  } else {
    launch();
  }
}

/**
 * GET /api/skills description cache, keyed by skill dir name and invalidated
 * by SKILL.md mtime (statSync is far cheaper than re-reading + re-parsing ~70
 * files per request). Mirrors the mtime-cache in talk/orchestrator-persona.ts.
 */
const skillDescriptionCache = new Map<string, { mtimeMs: number; description: string }>();

/** Extract a skill description from YAML frontmatter, ## Trigger section, or first paragraph. */
function parseSkillDescription(content: string): string {
  let description = "";
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) {
      description = descMatch[1].trim();
    }
  }
  if (!description) {
    const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
    if (triggerMatch) {
      description = triggerMatch[1].trim();
    } else {
      // Use first non-heading, non-empty, non-frontmatter line
      const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
      const lines = bodyContent.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          description = trimmed;
          break;
        }
      }
    }
  }
  return description;
}

/** Resolve an array of file IDs to local filesystem paths for engine consumption. */
function resolveAttachmentPaths(fileIds: unknown): string[] {
  if (!Array.isArray(fileIds)) return [];
  const paths: string[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (!meta) {
      logger.warn(`Attachment file not found: ${id}`);
      continue;
    }
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (fs.existsSync(filePath)) {
      paths.push(filePath);
    } else if (meta.path && fs.existsSync(meta.path)) {
      paths.push(meta.path);
    } else {
      logger.warn(`Attachment file missing on disk: ${id} (${meta.filename})`);
    }
  }
  return paths;
}

/** Find managed attachment IDs that have no registry row or readable file. */
function findUnresolvedAttachmentIds(fileIds: string[]): string[] {
  return fileIds.filter((id) => {
    const meta = getFile(id);
    if (!meta) return true;
    const managedPath = path.join(FILES_DIR, meta.id, meta.filename);
    return !fs.existsSync(managedPath) && (!meta.path || !fs.existsSync(meta.path));
  });
}

/** Per-request Accept-Encoding, stashed by handleApiRequest so json() can compress. */
type ResWithEncoding = ServerResponse & { __acceptEncoding?: string };

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data));
  const enc =
    body.length >= MIN_COMPRESS_BYTES
      ? pickEncoding((res as ResWithEncoding).__acceptEncoding)
      : null;
  if (enc) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": enc,
      Vary: "Accept-Encoding",
    });
    res.end(compressBuffer(enc, body));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function noteStoreFailureResponse(
  res: ServerResponse,
  result: Extract<NoteStoreResult<unknown>, { ok: false }>,
): void {
  const status = {
    "invalid-path": 400,
    forbidden: 403,
    "not-found": 404,
    conflict: 409,
    "too-large": 413,
    "already-exists": 409,
  }[result.reason];
  json(res, {
    error: result.detail,
    ...(result.currentRevision ? { currentRevision: result.currentRevision } : {}),
  }, status);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

const REDACTED_SECRET = "***";

export function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized.includes("password") ||
    normalized === "authorization"
  );
}

/**
 * Replace any secret-bearing fields with the "***" sentinel before sending
 * config to the UI.
 * deepMerge round-trips the sentinel back to the original value on PUT.
 */
export function sanitizeConfigForApi<T>(value: T, key = ""): T {
  if (isSensitiveConfigKey(key) && value !== undefined && value !== null && value !== "") {
    return REDACTED_SECRET as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigForApi(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeConfigForApi(childValue, childKey);
    }
    return out as T;
  }
  return value;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    // Skip sanitized secret placeholders — keep original value
    if (isSensitiveConfigKey(key) && sv === REDACTED_SECRET) continue;
    if (Array.isArray(sv)) {
      // For arrays (e.g. instances), preserve secrets from matching items
      if (Array.isArray(tv)) {
        result[key] = sv.map((item: unknown) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const srcItem = item as Record<string, unknown>;
            // Find matching target item by id
            const matchTarget = (tv as unknown[]).find(
              (t) => t && typeof t === "object" && (t as Record<string, unknown>).id === srcItem.id
            ) as Record<string, unknown> | undefined;
            if (matchTarget) return deepMerge(matchTarget, srcItem);
          }
          return item;
        });
      } else {
        result[key] = sv;
      }
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

export function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      const raw = pathParts[i];
      if (/%2f|%5c/i.test(raw)) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
        return null;
      }
      params[patternParts[i].slice(1)] = decoded;
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function sessionHasRuntimeActivity(session: Session, context: ApiContext): boolean {
  const activity = context.backgroundActivity?.get(session.id);
  if (!activity) return false;
  const stale = activity.activeStreams <= 0 && Date.now() - activity.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
  if (stale) {
    context.backgroundActivity?.delete(session.id);
    return false;
  }
  return activity.activeStreams > 0;
}

function getSessionTransportState(session: Session, context: ApiContext): "idle" | "queued" | "running" | "error" | "interrupted" {
  const queue = context.sessionManager.getQueue();
  const base = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  if (sessionHasRuntimeActivity(session, context) && base !== "error" && base !== "interrupted") return "running";
  return base;
}

function blocksEngineSwitch(transportState: Session["transportState"]): boolean {
  return transportState === "running" || transportState === "queued";
}

/** Route-side cap for search query/text params (GRS-020a-fix finding 3). The
 *  MCP tools cap earlier with a friendlier error; this is the substrate
 *  backstop so a hostile curl gets a clean 400, never HTTP-parser noise. */
export const SEARCH_QUERY_ROUTE_CHAR_CAP = 1_024;

/** JSON escaping can expand one byte to six characters (for example NUL). */
const NOTES_BODY_ROUTE_MAX_BYTES = NOTE_FILE_MAX_BYTES * 6 + 64_000;

/** Read a query param with NUL/control bytes stripped (GRS-020a-fix finding 2)
 *  and whitespace trimmed; empty-after-cleaning collapses to null. */
function readCleanSearchParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const cleaned = stripControlChars(raw).trim();
  return cleaned || null;
}

/** The compact summary shape the GRS-020 reference-layer routes return
 *  (GRS-020a-fix finding 5): only the documented fields — never the full
 *  serialized session (sourceRef/replyContext/transportMeta/promptExcerpt/cost
 *  fields stay off the reference surface), never message bodies. Workflow-owned
 *  records retain their explicit provenance so compact search hits are attributable. */
function compactSessionSummary(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title ?? null,
    employee: session.employee ?? null,
    engine: session.engine,
    status: session.status,
    lastActivity: session.lastActivity ?? null,
    parentSessionId: session.parentSessionId ?? null,
    ...(session.workflowProvenance ? { workflowProvenance: session.workflowProvenance } : {}),
  };
}

function cronJobSummary(job: Record<string, unknown>, lastRun: unknown): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled !== false,
    employee: job.employee ?? null,
    engine: job.engine ?? null,
    timezone: job.timezone ?? null,
    lastRun: lastRun ? summarizeCronRun(lastRun) : null,
  };
}

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['backlog', 'assigned', 'executing', 'in_review', 'done', 'blocked', 'escalated', 'cancelled'];
const WORK_ITEM_SOURCES: readonly WorkItemSource[] = ['human', 'delegation', 'cron', 'workflow', 'session', 'connector', 'goal'];
const AGENT_WORK_ITEM_TARGETS: readonly WorkItemStatus[] = ['executing', 'in_review', 'blocked', 'escalated', 'done'];
const VERIFY_MODES = ['trust', 'verify', 'thorough'] as const;
const VERIFY_POLICY_KEYS = new Set(['mode', 'verifier', 'maxRounds']);

/** Compact wire summary (Todos v2 slice 3 adds `labels` + `blocked` — the
 *  board's chip/indicator data). List callers pass the pre-batched `extras`
 *  (ONE blockedSet + ONE labelSets query per page); single-item callers omit
 *  them and pay two per-item lookups. */
function compactWorkItem(
  item: WorkItem,
  extras?: { blocked: Set<string>; labels: Map<string, Label[]> },
): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    version: item.version,
    assignee: item.assignee,
    department: item.department,
    createdBy: item.createdBy,
    parentId: item.parentId,
    rootId: item.rootId,
    depth: item.depth,
    dueAt: item.dueAt,
    source: item.source,
    sourceRef: item.sourceRef,
    rank: item.rank,
    labels: extras ? extras.labels.get(item.id) ?? [] : getWorkItemLabels(item.id),
    blocked: extras ? extras.blocked.has(item.id) : isBlocked(item.id),
    approvalState: item.approvalState,
    approvalRequest: item.approvalRequest,
    approvalRef: item.approvalRef,
    approvalTarget: item.approvalTarget,
    approvalEscalatedAt: item.approvalEscalatedAt,
    sessionRef: sessionRef(item),
    updatedAt: item.updatedAt,
  };
}

function sessionRef(item: WorkItem): Record<string, string> | null {
  if (!item.sourceRef) return null;
  const m = /^session:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (m) return m[2] ? { sessionId: m[1], ref: m[2] } : { sessionId: m[1] };
  const delegated = /^delegate:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (delegated) return delegated[2] ? { sessionId: delegated[1], ref: delegated[2] } : { sessionId: delegated[1] };
  return null;
}

function fullWorkItemPayload(item: WorkItem): Record<string, unknown> {
  return {
    workItem: item,
    spendUsd: getWorkItemSpend(item.id),
    events: listWorkItemEvents(item.id),
    comments: commentsTail(item.id),
    relations: listRelations(item.id),
    labels: getWorkItemLabels(item.id),
    // Slice 4 (additive): the full approval history, oldest request first. The
    // legacy approval* fields on `workItem` remain the current row's values.
    approvals: listApprovals(item.id),
  };
}

type TodoEditPrecondition =
  | { ok: true; expectedVersion: number }
  | { ok: false; status: 400 | 428; body: { error: string; code: 'todo_precondition_required' | 'todo_invalid_version' } };

function positiveTodoVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function ifMatchTodoVersion(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:"([1-9]\d*)"|([1-9]\d*))$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readTodoEditPrecondition(req: HttpRequest, body: Record<string, unknown>): TodoEditPrecondition {
  const hasBodyVersion = Object.prototype.hasOwnProperty.call(body, 'expectedVersion');
  const hasIfMatch = req.headers['if-match'] !== undefined;
  if (!hasBodyVersion && !hasIfMatch) {
    return { ok: false, status: 428, body: { error: 'A current Todo version is required.', code: 'todo_precondition_required' } };
  }
  const bodyVersion = hasBodyVersion ? positiveTodoVersion(body.expectedVersion) : undefined;
  const headerVersion = hasIfMatch ? ifMatchTodoVersion(req.headers['if-match']) : undefined;
  if ((hasBodyVersion && bodyVersion === undefined) || (hasIfMatch && headerVersion === undefined)) {
    return { ok: false, status: 400, body: { error: 'Todo version must be a positive safe integer.', code: 'todo_invalid_version' } };
  }
  if (bodyVersion !== undefined && headerVersion !== undefined && bodyVersion !== headerVersion) {
    return { ok: false, status: 400, body: { error: 'Todo version preconditions do not match.', code: 'todo_invalid_version' } };
  }
  return { ok: true, expectedVersion: bodyVersion ?? headerVersion! };
}

type TodoEditValidationCode = 'todo_invalid_patch' | 'todo_invalid_assignee';

function todoEditValidationError(
  res: ServerResponse,
  error: string,
  code: TodoEditValidationCode = 'todo_invalid_patch',
): void {
  json(res, { error, code }, 400);
}

function todoEditContentLength(value: string | string[] | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function hasSupportedTodoEditContentEncoding(value: string | string[] | undefined): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().toLowerCase() === 'identity');
}

function readWorkItemStatusParam(url: URL): WorkItemStatus | undefined | null {
  const status = readCleanSearchParam(url, 'status');
  if (!status) return undefined;
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(status)) return null;
  return status as WorkItemStatus;
}

function readWorkItemSourceParam(url: URL): WorkItemSource | undefined | null {
  const source = readCleanSearchParam(url, 'source');
  if (!source) return undefined;
  if (!(WORK_ITEM_SOURCES as readonly string[]).includes(source)) return null;
  return source as WorkItemSource;
}

const WORK_ITEM_PAGE_DEFAULT_LIMIT = 20;
const WORK_ITEM_PAGE_MAX_LIMIT = 100;
const ISO_DATE_OR_INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

interface WorkItemQueryParams {
  filter: SearchWorkItemsFilter;
  limit: number;
  offset: number;
}

function readWorkItemIntegerParam(
  url: URL,
  name: 'limit' | 'offset',
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const raw = url.searchParams.get(name);
  if (raw === null) return { ok: true, value: fallback };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: `${name} must be a non-negative integer` };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${name} must be a safe integer` };
  if (name === 'limit') {
    if (value < 1) return { ok: false, error: 'limit must be at least 1' };
    return { ok: true, value: Math.min(value, WORK_ITEM_PAGE_MAX_LIMIT) };
  }
  return { ok: true, value };
}

function readWorkItemDateParam(
  url: URL,
  name: 'since' | 'until',
): { ok: true; value?: string } | { ok: false; error: string } {
  const raw = readCleanSearchParam(url, name);
  if (!raw) return { ok: true };
  if (!ISO_DATE_OR_INSTANT.test(raw)) {
    return { ok: false, error: `${name} must be an ISO date or timezone-qualified ISO timestamp` };
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const expanded = dateOnly
    ? `${raw}T${name === 'since' ? '00:00:00.000' : '23:59:59.999'}Z`
    : raw;
  const parsed = new Date(expanded);
  if (Number.isNaN(parsed.getTime()) || (dateOnly && parsed.toISOString().slice(0, 10) !== raw)) {
    return { ok: false, error: `${name} must be a valid ISO date or timestamp` };
  }
  return { ok: true, value: parsed.toISOString() };
}

function readWorkItemQueryParams(url: URL): { ok: true; value: WorkItemQueryParams } | { ok: false; error: string } {
  const filter: SearchWorkItemsFilter = {};
  const status = readWorkItemStatusParam(url);
  if (status === null) return { ok: false, error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` };
  if (status) filter.status = status;
  const source = readWorkItemSourceParam(url);
  if (source === null) return { ok: false, error: `source must be one of ${WORK_ITEM_SOURCES.join(', ')}` };
  if (source) filter.source = source;
  const assignee = readCleanSearchParam(url, 'assignee');
  if (assignee) filter.assignee = assignee;
  const department = readCleanSearchParam(url, 'department');
  if (department) filter.department = department;
  const text = readCleanSearchParam(url, 'q') ?? readCleanSearchParam(url, 'text');
  if (text) {
    if (text.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
      return { ok: false, error: `q is too long (${text.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query` };
    }
    filter.text = text;
  }
  const createdBy = readCleanSearchParam(url, 'createdBy');
  if (createdBy) filter.createdBy = createdBy;
  const parent = readCleanSearchParam(url, 'parent');
  if (parent) {
    try {
      filter.parentId = parseTodoId(parent);
    } catch {
      return { ok: false, error: 'parent must be a Todo ID' };
    }
  }
  const root = readCleanSearchParam(url, 'root');
  if (root) {
    try {
      filter.rootId = parseTodoId(root);
    } catch {
      return { ok: false, error: 'root must be a Todo ID' };
    }
  }
  if (readCleanSearchParam(url, 'rootsOnly') === 'true') filter.rootsOnly = true;
  const label = readCleanSearchParam(url, 'label');
  if (label) {
    // Ids pass through; display names are normalized to the stored kebab-case.
    if (/^lbl_[0-9a-f]{12}$/.test(label)) {
      filter.label = label;
    } else {
      try {
        filter.label = normalizeLabelName(label);
      } catch {
        return { ok: false, error: 'label must be a label ID (lbl_…) or a name with at least one letter or digit' };
      }
    }
  }
  const since = readWorkItemDateParam(url, 'since');
  if (!since.ok) return since;
  if (since.value) filter.since = since.value;
  const until = readWorkItemDateParam(url, 'until');
  if (!until.ok) return until;
  if (until.value) filter.until = until.value;
  if (filter.since && filter.until && filter.since > filter.until) {
    return { ok: false, error: 'since must be earlier than or equal to until' };
  }
  const limit = readWorkItemIntegerParam(url, 'limit', WORK_ITEM_PAGE_DEFAULT_LIMIT);
  if (!limit.ok) return limit;
  const offset = readWorkItemIntegerParam(url, 'offset', 0);
  if (!offset.ok) return offset;
  return { ok: true, value: { filter, limit: limit.value, offset: offset.value } };
}

function workItemPagePayload(page: ReturnType<typeof queryWorkItems>): Record<string, unknown> {
  // Batch the board wire data across the page — ONE query each, never per item.
  const ids = page.workItems.map((item) => item.id);
  const extras = { blocked: blockedSet(ids), labels: labelSets(ids) };
  return {
    workItems: page.workItems.map((item) => compactWorkItem(item, extras)),
    total: page.total,
    totals: page.totals,
    limit: page.limit,
    offset: page.offset,
    nextOffset: page.nextOffset,
  };
}

function requireTodoRouteId(res: ServerResponse, value: string): boolean {
  if (isTodoId(value)) return true;
  badRequest(res, "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix");
  return false;
}

type WorkItemCaller =
  | { kind: 'operator'; session?: undefined; callerId?: undefined }
  | { kind: 'session'; session: Session; callerId: string };

function resolveWorkItemCaller(req: HttpRequest, res: ServerResponse, context: ApiContext): WorkItemCaller | undefined {
  const identity = resolveScopedWriteCallerIdentity(req, context);
  if (identity.kind === "unidentified-tool" || identity.kind === "unauthenticated") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  if (identity.kind === "operator") return { kind: 'operator' };
  const session = getSession(identity.callerId);
  if (!session) {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  return { kind: 'session', callerId: identity.callerId, session };
}

function resolveNeedsAttentionTarget(req: HttpRequest, res: ServerResponse, requested: string, context: ApiContext): string | undefined {
  const identity = resolveScopedWriteCallerIdentity(req, context);
  if (identity.kind === "unidentified-tool" || identity.kind === "unauthenticated") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  if (identity.kind === "session") {
    const session = getSession(identity.callerId);
    if (!session?.employee) {
      json(res, { error: "needsAttentionFor=me requires a caller session with an employee identity" }, 403);
      return undefined;
    }
    if (requested !== "me" && requested !== session.employee) {
      json(res, { error: "capability-scoped callers can only read their own queue; use needsAttentionFor=me" }, 403);
      return undefined;
    }
    return session.employee;
  }
  if (requested === "me") {
    const root = resolveRootApprovalTarget()?.name;
    if (root) return root;
    json(res, { error: "needsAttentionFor=me could not resolve a COO/root approval target" }, 403);
    return undefined;
  }
  return requested;
}

function scopedCallerRequest(
  requestOrHeaders: HttpRequest | HttpRequest["headers"],
): HttpRequest | undefined {
  const possibleHeaders = (requestOrHeaders as { headers?: unknown }).headers;
  return possibleHeaders
    && typeof possibleHeaders === "object"
    && !Array.isArray(possibleHeaders)
    ? requestOrHeaders as HttpRequest
    : undefined;
}

function scopedCallerHeaders(
  requestOrHeaders: HttpRequest | HttpRequest["headers"],
): HttpRequest["headers"] {
  const request = scopedCallerRequest(requestOrHeaders);
  return request
    ? request.headers
    : requestOrHeaders as HttpRequest["headers"];
}

function resolveScopedWriteCallerIdentity(requestOrHeaders: HttpRequest | HttpRequest["headers"], context: ApiContext) {
  const request = scopedCallerRequest(requestOrHeaders);
  const headers = scopedCallerHeaders(requestOrHeaders);
  return resolveCallerIdentity(headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated:
      verifyGatewayAuth(headers, context.gatewayAuthToken, context.jinnHome ?? JINN_HOME)
      || (!shouldRequireGatewayAuth(context.getConfig()) && !!request && isSameOriginBrowserRequest(request, context.getConfig())),
  });
}

function scopedOperatorAuthenticated(
  requestOrHeaders: HttpRequest | HttpRequest["headers"],
  context: ApiContext,
): boolean {
  return resolveScopedWriteCallerIdentity(requestOrHeaders, context).kind === "operator";
}

function singleHeader(headers: HttpRequest["headers"], name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isActivityProjectionEligibleSession(sessionId: string): boolean {
  const session = getSession(sessionId);
  return Boolean(session);
}

function hasActivityBlock(sessionId: string, blockId: string): boolean {
  return getMessages(sessionId).some((message) => message.blocks?.some((block) => block.id === blockId));
}

let lastActivityOrder = 0;

function nextActivityOrder(sessionId: string, blockId: string): number {
  const existingOrder = getMessages(sessionId)
    .flatMap((message) => message.blocks ?? [])
    .find((block) => block.id === blockId)?.activityOrder ?? 0;
  lastActivityOrder = Math.max(lastActivityOrder + 1, existingOrder + 1, Date.now() * 100);
  return lastActivityOrder;
}

function chatActivityContext(context: ApiContext): ChatActivityContext {
  return {
    sessionExists: isActivityProjectionEligibleSession,
    hasBlock: hasActivityBlock,
    nextActivityOrder,
    applyBlock: (sessionId, envelope, fallback) => applyBlockEnvelope(sessionId, envelope, fallback),
    emit: (event, payload) => context.emit?.(event, payload),
    log: (message) => logger.warn(message),
  };
}

function verifiedActivityTarget(
  headers: HttpRequest["headers"],
  context: ApiContext,
  expectedTools: string | readonly string[],
): { sessionId?: string; operation?: ActivityOperation } {
  const identity = resolveScopedWriteCallerIdentity(headers, context);
  if (identity.kind !== "session") return {};
  if (!isActivityProjectionEligibleSession(identity.callerId)) return {};
  const operationId = singleHeader(headers, ACTIVITY_OPERATION_HEADER);
  const toolName = singleHeader(headers, ACTIVITY_TOOL_HEADER);
  const toolMarker = singleHeader(headers, TOOL_CALL_HEADER);
  const allowedTools = typeof expectedTools === "string" ? [expectedTools] : expectedTools;
  const operation = toolMarker === TOOL_CALL_HEADER_VALUE
    && operationId !== undefined
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)
    && toolName !== undefined
    && toolName.length <= 160
    && allowedTools.includes(toolName)
      ? { id: operationId, toolName }
      : undefined;
  return operation ? { sessionId: identity.callerId, operation } : {};
}

const TODO_ACTIVITY_TOOLS: Record<string, string> = {
  created: "create_work_item",
  "metadata-updated": "update_work_item",
  "status-transitioned": "update_work_item",
  assigned: "assign_work_item",
  archived: "archive_work_item",
  "approval-requested": "request_work_item_approval",
  "approval-decided": "decide_work_item_approval",
  "approval-escalated": "escalate_work_item_approval",
};

function persistTodoMutationActivity(
  req: HttpRequest,
  context: ApiContext,
  item: WorkItem,
  action: string,
  changed = true,
): string | undefined {
  const target = verifiedActivityTarget(req.headers, context, TODO_ACTIVITY_TOOLS[action] ?? []);
  return persistAndEmitActivityBlock({
    context: chatActivityContext(context),
    ...target,
    envelope: todoActivityBlock(item, action),
    ...(!changed ? { idempotentReplay: true } : {}),
    ...(changed ? {
      companyEvent: {
        entity: "todo" as const,
        action,
        id: item.id,
        version: item.version,
        value: item as unknown as JsonObject,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      },
    } : {}),
  });
}

/** ICI-570 — projection lanes (comments, attachments, relations, labels) don't
 * always rewrite the Todo row itself, but the web surfaces still need a change
 * signal to refetch live. One valueless event per affected item; the client
 * responds by invalidating that item's cached projections. */
function emitTodoProjectionEvent(context: ApiContext, id: string, action: string): void {
  const item = getWorkItem(id);
  if (!item) return;
  persistAndEmitActivityBlock({
    context: chatActivityContext(context),
    companyEvent: { entity: "todo", action, id, version: item.version },
  });
}

function withActivityReceipt<T extends Record<string, unknown>>(body: T, activityReceiptId: string | undefined): T & { activityReceiptId?: string } {
  return activityReceiptId ? { ...body, activityReceiptId } : body;
}

const FORWARDED_REQUEST_HEADERS = new Set([
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

export const PROXIED_OPERATOR_AUTH_ERROR =
  "operator authentication failed: this request reached the gateway through a proxy " +
  "(forwarded headers present) but the gateway has no auth configured, so it cannot be trusted as the operator. " +
  "Enable gateway auth (gateway.authRequired: true) and pair your device; same-origin operator trust does not apply to proxied requests.";

type RequestAuthority = { hostname: string; port: number };

function requestHeaderValues(req: Pick<HttpRequest, "headers" | "rawHeaders">, name: string): string[] {
  const lowerName = name.toLowerCase();
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    const values: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === lowerName) values.push(req.rawHeaders[index + 1] ?? "");
    }
    return values;
  }
  const raw = req.headers[lowerName];
  if (Array.isArray(raw)) return raw;
  return typeof raw === "string" ? [raw] : [];
}

function singleRequestHeader(req: Pick<HttpRequest, "headers" | "rawHeaders">, name: string): string | undefined {
  const values = requestHeaderValues(req, name);
  if (values.length !== 1) return undefined;
  const value = values[0];
  return value === value.trim() && value.length > 0 ? value : undefined;
}

function parseRequestAuthority(req: Pick<HttpRequest, "headers" | "rawHeaders">): RequestAuthority | undefined {
  const raw = singleRequestHeader(req, "host");
  if (!raw || raw.length > 255 || !/^[\x21-\x7e]+$/.test(raw) || /[%/@\\?#,]/.test(raw)) return undefined;

  let hostname: string;
  let rawPort: string | undefined;
  if (raw.startsWith("[")) {
    const match = /^\[([0-9a-f:.]+)\](?::([0-9]+))?$/i.exec(raw);
    if (!match) return undefined;
    hostname = match[1].toLowerCase();
    rawPort = match[2];
  } else {
    const match = /^([a-z0-9._-]+)(?::([0-9]+))?$/i.exec(raw);
    if (!match) return undefined;
    hostname = match[1].toLowerCase();
    rawPort = match[2];
  }
  if (!hostname || hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) return undefined;

  const port = rawPort === undefined ? 80 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
  } catch {
    return undefined;
  }
  return { hostname, port };
}

function isLoopbackAuthorityHost(hostname: string): boolean {
  return isLoopback(hostname)
    || hostname === "::1"
    || hostname === "localhost"
    || hostname.endsWith(".localhost");
}

function authorityMatchesListener(authority: RequestAuthority, localAddress: string, localPort: number): boolean {
  if (authority.port !== localPort) return false;
  if (authority.hostname === "localhost" || authority.hostname.endsWith(".localhost")) return true;
  const normalizedLocalAddress = localAddress.toLowerCase().replace(/^::ffff:/, "");
  return authority.hostname === normalizedLocalAddress;
}

function originMatchesAuthority(origin: string, authority: RequestAuthority): boolean {
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const port = parsed.port ? Number(parsed.port) : 80;
    return parsed.protocol === "http:"
      && !parsed.username
      && !parsed.password
      && parsed.origin !== "null"
      && hostname === authority.hostname
      && port === authority.port;
  } catch {
    return false;
  }
}

function originMatchesLoopbackViteProxy(
  req: Pick<HttpRequest, "headers" | "rawHeaders">,
  origin: string,
  authority: RequestAuthority,
): boolean {
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (parsed.protocol !== "http:"
      || parsed.username
      || parsed.password
      || parsed.origin === "null"
      || !isLoopbackAuthorityHost(hostname)
      || hostname !== authority.hostname) return false;

    // Vite's loopback changeOrigin proxy rewrites Host to the gateway listener
    // while preserving the browser-facing Origin and Referer ports. Require both
    // browser headers to agree on that exact loopback origin; forwarding headers,
    // external origins, non-loopback sockets, and auth-enabled gateways have
    // already failed closed above.
    const referer = singleRequestHeader(req, "referer");
    return !!referer && new URL(referer).origin === parsed.origin;
  } catch {
    return false;
  }
}

export function isSameOriginBrowserRequest(
  req: Pick<HttpRequest, "headers" | "rawHeaders" | "socket">,
  config: Pick<JinnConfig, "gateway">,
): boolean {
  if (shouldRequireGatewayAuth(config)) return false;
  const socket = req.socket;
  if (!socket || !isLoopback(socket.remoteAddress) || !isLoopback(socket.localAddress)) return false;
  if (typeof socket.localPort !== "number") return false;
  if ([...FORWARDED_REQUEST_HEADERS].some((name) => requestHeaderValues(req, name).length > 0)) return false;

  const authority = parseRequestAuthority(req);
  if (!authority
    || !isLoopbackAuthorityHost(authority.hostname)
    || !authorityMatchesListener(authority, socket.localAddress!, socket.localPort)) return false;

  const fetchSite = singleRequestHeader(req, "sec-fetch-site");
  const fetchMode = singleRequestHeader(req, "sec-fetch-mode");
  const fetchDest = singleRequestHeader(req, "sec-fetch-dest");
  const upgrade = singleRequestHeader(req, "upgrade")?.toLowerCase();
  const expectedMode = upgrade === "websocket" ? "websocket" : "cors";
  if (fetchSite !== "same-origin" || fetchMode !== expectedMode || fetchDest !== "empty") return false;

  const origins = requestHeaderValues(req, "origin");
  if (origins.length > 1 || (upgrade === "websocket" && origins.length !== 1)) return false;
  return origins.length === 0
    || originMatchesAuthority(origins[0], authority)
    || (upgrade !== "websocket" && originMatchesLoopbackViteProxy(req, origins[0], authority));
}

function isPublicIdentifiedCallerRoute(method: string, pathname: string): boolean {
  // Public liveness/bootstrap: safe summary used to discover whether the gateway is up.
  if (method === "GET" && pathname === "/api/status") return true;
  return false;
}

function allowsUnauthenticatedMutation(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return pathname === "/api/auth/bootstrap"
    || pathname === "/api/auth/pairing-challenges"
    || pathname === "/api/auth/pairing-codes"
    || pathname === "/api/auth/pair"
    || pathname === "/api/auth/logout"
    || pathname === "/api/internal/hook";
}

function rejectUnverifiedIdentifiedApiCaller(req: HttpRequest, res: ServerResponse, method: string, pathname: string, context: ApiContext): boolean {
  if (isPublicIdentifiedCallerRoute(method, pathname)) return false;
  const identity = resolveScopedWriteCallerIdentity(req, context);
  if (identity.kind === "unauthenticated") {
    const mutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    if (!mutating || allowsUnauthenticatedMutation(method, pathname)) return false;
  } else if (identity.kind !== "unidentified-tool") {
    return false;
  }
  const proxiedWithoutAuth = identity.kind === "unauthenticated"
    && !shouldRequireGatewayAuth(context.getConfig())
    && [...FORWARDED_REQUEST_HEADERS].some((name) => requestHeaderValues(req, name).length > 0);
  json(res, { error: proxiedWithoutAuth ? PROXIED_OPERATOR_AUTH_ERROR : UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
  return true;
}

function operatorOnlyControlPlaneRoute(method: string, pathname: string): string | null {
  if ((method === "PUT" || method === "PATCH") && pathname === "/api/config") return "config update";
  if (method === "POST" && pathname === "/api/onboarding") return "onboarding config update";
  if (method === "POST" && pathname === "/api/instances") return "workspace creation";
  if (method === "POST" && matchRoute("/api/instances/:id/start", pathname)) return "workspace start";
  if (method === "DELETE" && pathname.startsWith("/api/auth/devices/")) return "auth device revoke";
  if (method === "POST" && pathname === "/api/engines/refresh") return "engine registry refresh";
  if (method === "POST" && pathname === "/api/engine-limits/refresh") return "engine limits refresh";
  if (method === "POST" && pathname === "/api/connectors/reload") return "connector reload";
  if (method === "POST" && pathname === "/api/stt/download") return "STT model download/config enable";
  if (method === "PUT" && pathname === "/api/stt/config") return "STT config update";
  if (method === "DELETE" && matchRoute("/api/sessions/:id", pathname)) return "session delete";
  if ((method === "PUT" || method === "PATCH") && matchRoute("/api/sessions/:id", pathname)) return "session metadata/model update";
  if (method === "POST" && matchRoute("/api/sessions/:id/duplicate", pathname)) return "session duplicate";
  if (method === "POST" && matchRoute("/api/sessions/:id/archive", pathname)) return "session archive";
  if (method === "POST" && matchRoute("/api/sessions/:id/unarchive", pathname)) return "session unarchive";
  if (method === "POST" && matchRoute("/api/sessions/:id/reset", pathname)) return "session reset";
  if (method === "POST" && pathname === "/api/sessions/bulk-delete") return "session bulk delete";
  if (method === "DELETE" && matchRoute("/api/sessions/:id/queue/:itemId", pathname)) return "session queue item cancel";
  if (method === "DELETE" && matchRoute("/api/sessions/:id/queue", pathname)) return "session queue clear";
  if (method === "POST" && matchRoute("/api/sessions/:id/queue/pause", pathname)) return "session queue pause";
  if (method === "POST" && matchRoute("/api/sessions/:id/queue/resume", pathname)) return "session queue resume";
  if (method === "POST" && pathname === "/api/cron") return "cron create";
  if (method === "PUT" && matchRoute("/api/cron/:id", pathname)) return "cron update";
  if (method === "DELETE" && matchRoute("/api/cron/:id", pathname)) return "cron delete";
  if (method === "POST" && matchRoute("/api/cron/:id/trigger", pathname)) return "cron manual trigger";
  if (method === "PATCH" && matchRoute("/api/org/employees/:name", pathname)) return "org employee update";
  if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) return "legacy org board write";
  if (method === "DELETE" && matchRoute("/api/skills/:name", pathname)) return "skill removal";
  if (method === "PUT" && matchRoute("/api/skills/:name", pathname)) return "skill update";
  return null;
}

function requireOperatorControlPlaneAuthority(req: HttpRequest, res: ServerResponse, action: string, context: ApiContext): boolean {
  const identity = resolveScopedWriteCallerIdentity(req, context);
  if (identity.kind === "unidentified-tool" || identity.kind === "unauthenticated") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return false;
  }
  if (identity.kind === "session") {
    json(res, { error: `${action} is operator-only control-plane authority; capability-bound employee sessions cannot mutate gateway configuration, scheduling, org, auth, or settings` }, 403);
    return false;
  }
  return true;
}

function requireCallbackRecoveryAuthority(req: HttpRequest, res: ServerResponse, context: ApiContext): boolean {
  const identity = resolveScopedWriteCallerIdentity(req, context);
  if (identity.kind === "operator") return true;
  if (identity.kind === "session") {
    const session = getSession(identity.callerId);
    const employee = session?.employee ? scanOrg().get(session.employee) : undefined;
    if (employee?.rank === "manager" || employee?.rank === "executive") return true;
  }
  json(res, { error: "Callback recovery diagnostics require operator or manager authority" }, 403);
  return false;
}

function rejectScopedIdentityGrant(req: HttpRequest, res: ServerResponse, action: string, context: ApiContext): boolean {
  const identity = resolveScopedWriteCallerIdentity(req, context);
  if (identity.kind === "operator" || identity.kind === "unauthenticated") return false;
  if (identity.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return true;
  }
  json(res, { error: `${action} cannot mint broader browser/operator identity for a capability-bound employee session` }, 403);
  return true;
}

function workItemActor(caller: WorkItemCaller): string {
  return caller.kind === 'session' ? `session:${caller.callerId}` : 'operator';
}

/** Comment identity is stamped server-side, never taken from the request body:
 *  operator surface → 'operator'; a session with a resolved employee comments
 *  as that employee (stable across their sessions); a bare session keeps the
 *  `session:<uuid>` identity workItemActor established. */
function workItemCommentAuthor(caller: WorkItemCaller): { author: string; authorKind: 'operator' | 'employee' } {
  if (caller.kind === 'operator') return { author: 'operator', authorKind: 'operator' };
  return { author: caller.session.employee ?? workItemActor(caller), authorKind: 'employee' };
}

/** Attachment identity mirrors the comments model: server-stamped, pair-safe. */
function workItemAttachmentActor(caller: WorkItemCaller): AttachmentActor {
  return { ...workItemCommentAuthor(caller), operator: caller.kind === 'operator' };
}

function workItemAttachmentFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkItemAttachmentError) {
    if (err.code === 'comment-not-found' || err.code === 'attachment-not-found') return notFound(res);
    if (err.code === 'attachment-forbidden') return json(res, { error: err.message }, 403);
    if (err.code === 'comment-deleted') return json(res, { error: err.message }, 409);
    // attachment-too-large / attachment-item-budget
    return json(res, { error: err.message, code: 'attachment_too_large' }, 413);
  }
  if (err instanceof Error) return badRequest(res, err.message);
  return badRequest(res, String(err));
}

function workItemCommentFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkItemCommentError) {
    if (err.code === 'comment-not-found') return notFound(res);
    if (err.code === 'comment-forbidden') return json(res, { error: err.message }, 403);
    return json(res, { error: err.message }, 409); // comment-deleted
  }
  if (err instanceof Error) return badRequest(res, err.message);
  return badRequest(res, String(err));
}

function findApprovalKeysDeep(value: unknown, path = 'body', found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (/^approval/i.test(key)) found.push(childPath);
    findApprovalKeysDeep(child, childPath, found);
  }
  return found;
}

function objectKeys(value: unknown, name: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: `${name} must be a JSON object` };
  return { ok: true, value: value as Record<string, unknown> };
}

function validateVerifyPolicy(value: unknown): { ok: true; value: VerifyPolicy | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const rec = objectKeys(value, 'verifyPolicy');
  if (!rec.ok) return rec;
  const extras = Object.keys(rec.value).filter((key) => !VERIFY_POLICY_KEYS.has(key));
  if (extras.length > 0) return { ok: false, error: `verifyPolicy has unknown key(s) ${extras.join(', ')}; only mode, verifier, and maxRounds are allowed` };
  const mode = rec.value.mode;
  if (!(VERIFY_MODES as readonly unknown[]).includes(mode)) {
    return { ok: false, error: `verifyPolicy.mode must be one of ${VERIFY_MODES.join(', ')}` };
  }
  const policy: VerifyPolicy = { mode: mode as VerifyPolicy['mode'] };
  if (rec.value.maxRounds !== undefined) {
    if (typeof rec.value.maxRounds !== 'number' || !Number.isInteger(rec.value.maxRounds) || rec.value.maxRounds < 1 || rec.value.maxRounds > 20) {
      return { ok: false, error: 'verifyPolicy.maxRounds must be an integer from 1 to 20' };
    }
    policy.maxRounds = rec.value.maxRounds;
  }
  if (rec.value.verifier !== undefined) {
    const verifier = objectKeys(rec.value.verifier, 'verifyPolicy.verifier');
    if (!verifier.ok) return verifier;
    const allowed = new Set(['employee', 'engine', 'model']);
    const extraVerifier = Object.keys(verifier.value).filter((key) => !allowed.has(key));
    if (extraVerifier.length > 0) {
      return { ok: false, error: `verifyPolicy.verifier has unknown key(s) ${extraVerifier.join(', ')}; only employee, engine, and model are allowed` };
    }
    const out: NonNullable<VerifyPolicy['verifier']> = {};
    for (const key of ['employee', 'engine', 'model'] as const) {
      if (verifier.value[key] !== undefined) {
        if (typeof verifier.value[key] !== 'string' || !verifier.value[key].trim()) {
          return { ok: false, error: `verifyPolicy.verifier.${key} must be a non-empty string` };
        }
        out[key] = verifier.value[key].trim();
      }
    }
    policy.verifier = out;
  }
  return { ok: true, value: policy };
}

function ownsWorkItem(session: Session, item: WorkItem, linked: Session[]): boolean {
  if (linked.some((s) => s.id === session.id)) return true;
  if (item.assignee && session.employee && item.assignee === session.employee) return true;
  return item.source === 'session' && !!item.sourceRef?.startsWith(`session:${session.id}:`);
}

function authorizeWorkItemOwnerManagerOrRoot(
  caller: WorkItemCaller,
  item: WorkItem,
  action: string,
): { ok: true } | { ok: false; status: 403; error: string } {
  if (caller.kind === 'operator') return { ok: true };
  const employeeName = caller.session.employee;
  if (!employeeName) {
    return { ok: false, status: 403, error: `session ${caller.callerId} has no employee identity and cannot ${action} Todo ${item.id}` };
  }
  const roster = scanOrg();
  const employee = roster.get(employeeName);
  if (!employee) {
    return { ok: false, status: 403, error: `employee "${employeeName}" is not in the org roster and cannot ${action} Todo ${item.id}` };
  }
  const root = resolveRootApprovalTarget();
  if (root?.kind === 'employee' && root.name === employeeName) return { ok: true };

  const owner = resolveApprovalRouteTarget(item).owner;
  if (owner === employeeName) return { ok: true };
  if (owner && (employee.rank === 'manager' || employee.rank === 'executive')) {
    const hierarchy = resolveOrgHierarchy(roster);
    let ancestor = hierarchy.nodes[owner]?.parentName ?? null;
    while (ancestor) {
      if (ancestor === employeeName) return { ok: true };
      ancestor = hierarchy.nodes[ancestor]?.parentName ?? null;
    }
  }
  return {
    ok: false,
    status: 403,
    error: `employee "${employeeName}" does not own Todo ${item.id} and is not its authorized manager/root; cannot ${action}`,
  };
}

/** The metadata fields a non-operator relation may edit (spec §3.4). */
const TODO_EDIT_SHARED_FIELDS: ReadonlyArray<keyof UpdateWorkItemInput> = ['body', 'acceptance', 'priority', 'dueAt'];

type TodoEditAuthority =
  | { ok: true; fields: ReadonlySet<keyof UpdateWorkItemInput>; actor: string; who: string }
  | { ok: false; error: string };

/**
 * Resolve the per-field edit authority matrix (Todos v2 slice 4, spec §3.4).
 * Session identity resolves through the session's employee slug (the comments
 * author pattern); `created_by` matches either that slug or the caller's exact
 * `session:<uuid>` form — a session-form creator is only ever the one session
 * that created the item. The assignee's manager is the DIRECT reporting-line
 * parent (the same org resolution manager-visibility uses).
 */
function resolveTodoEditAuthority(caller: WorkItemCaller, item: WorkItem): TodoEditAuthority {
  if (caller.kind === 'operator') {
    return {
      ok: true,
      // verifyPolicy (slice 6) is deliberately operator-only: review policy is
      // a governance knob, not collaborative metadata.
      fields: new Set<keyof UpdateWorkItemInput>(['title', 'body', 'assignee', 'department', 'priority', 'rank', 'acceptance', 'dueAt', 'verifyPolicy']),
      actor: 'operator',
      who: 'the operator',
    };
  }
  const employee = caller.session.employee ?? null;
  const sessionActor = workItemActor(caller);
  const isCreator = item.createdBy === sessionActor || (employee !== null && item.createdBy === employee);
  const isAssignee = employee !== null && item.assignee !== null && item.assignee === employee;
  const isAssigneeManager =
    !isAssignee &&
    employee !== null &&
    item.assignee !== null &&
    resolveOrgHierarchy(scanOrg()).nodes[item.assignee]?.parentName === employee;
  if (!isCreator && !isAssignee && !isAssigneeManager) {
    return {
      ok: false,
      error: `${employee ? `employee "${employee}"` : `session ${caller.callerId}`} is neither the creator, the assignee, nor the assignee's manager of Todo ${item.id}; cannot edit its metadata`,
    };
  }
  const fields = new Set<keyof UpdateWorkItemInput>(TODO_EDIT_SHARED_FIELDS);
  if (isCreator) fields.add('title');
  return {
    ok: true,
    fields,
    actor: employee ?? sessionActor,
    who: isCreator ? 'the Todo creator' : isAssignee ? 'the assignee' : "the assignee's manager",
  };
}

function canReviewWorkItemDone(session: Session, item: WorkItem, linked: Session[]): { ok: true } | { ok: false; error: string } {
  if (item.status !== 'in_review') {
    return { ok: false, error: `marking a Todo done through MCP requires an authorized reviewer and an item already in_review; use the human review surface for ${item.status} → done` };
  }
  if (linked.some((s) => s.id === session.id)) {
    return { ok: false, error: `session ${session.id} executed work item ${item.id} and cannot mark it done — a reviewer does (self-review ban); use the human review surface / a reviewer session to mark done` };
  }
  if (linked.some((s) => s.parentSessionId === session.id)) return { ok: true };
  if (item.sourceRef?.startsWith(`delegate:${session.id}:`)) return { ok: true };
  if (item.source === 'session' && item.sourceRef?.startsWith(`session:${session.id}:`)) return { ok: true };
  return { ok: false, error: `session ${session.id} is not an authorized reviewer for Todo ${item.id}; use the human review surface or the parent reviewer session` };
}

function authorizeAgentWorkItemStatus(caller: WorkItemCaller, item: WorkItem, target: WorkItemStatus): { ok: true } | { ok: false; status: 403; error: string } {
  if (caller.kind === 'operator') return { ok: true };
  const linked = listSessionsByWorkItem(item.id);
  if (target === 'done') {
    const review = canReviewWorkItemDone(caller.session, item, linked);
    return review.ok ? { ok: true } : { ok: false, status: 403, error: review.error };
  }
  if (!ownsWorkItem(caller.session, item, linked)) {
    return {
      ok: false,
      status: 403,
      error: `session ${caller.callerId} does not own Todo ${item.id} and is not its authorized reviewer; agents may update only their own Todos, otherwise use the human surface`,
    };
  }
  return { ok: true };
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

function nearestEmployee(name: string, names: string[]): string | undefined {
  return names
    .map((n) => ({ n, d: levenshtein(name.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d <= 4 || x.n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.n.toLowerCase()))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))[0]?.n;
}

export function buildSessionDelegatedActivityIndex(
  sessions: readonly Session[],
  context: ApiContext,
): Map<string, DelegatedActivity> {
  const activeSessionIds = new Set<string>();
  for (const session of sessions) {
    const transport = getSessionTransportState(session, context);
    if (transport === "running" || transport === "queued" || session.status === "waiting") {
      activeSessionIds.add(session.id);
    }
  }
  return buildDelegatedActivityIndex(sessions, activeSessionIds);
}

/** The in-flight turn's progress instant, for the UI to age itself.
 *
 *  Deliberately carries no staleness verdict. A stalled session emits no events —
 *  that is what stalled means — so nothing invalidates the sessions query, and a
 *  server-side "is it stale yet?" would only reach the client if something else
 *  happened to trigger a refetch. The feature exists to surface a silent failure,
 *  so it must not depend on activity to be delivered.
 *
 *  Instead this reports the instant for any live turn. The client already receives
 *  a serialize at turn start, so it holds the value while the session is healthy
 *  and its own clock decides when the silence has gone on too long.
 *
 *  Null while a tool or upstream request explains the quiet — that is state rather
 *  than time, so the server is the right place to judge it — and both transitions
 *  emit hooks, hence events, hence a refetch. */
function computeLiveTurnProgress(session: Session, context: ApiContext): Session["turnProgress"] {
  if (session.status !== "running") return null;
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine || !reportsTurnProgress(engine)) return null;
  const progress = engine.turnProgress(session.id);
  if (!progress) return null;
  if (progress.activeTools > 0 || progress.activeUpstream) return null;
  return { lastProgressAt: progress.lastProgressAt, awaitingSubmit: progress.awaitingSubmit };
}

export function serializeSession(
  session: Session,
  context: ApiContext,
  delegatedActivityIndex?: ReadonlyMap<string, DelegatedActivity>,
): Session {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = getSessionTransportState(session, context);
  const bg = context.backgroundActivity?.get(session.id);
  const bgIsStale = bg && bg.activeStreams <= 0 && Date.now() - bg.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
  if (bgIsStale) context.backgroundActivity?.delete(session.id);
  return {
    ...session,
    queueDepth,
    transportState,
    turnProgress: computeLiveTurnProgress(session, context),
    backgroundActivity: bg && !bgIsStale
      ? { activeStreams: bg.activeStreams, lastActivityAt: new Date(bg.lastActivityAt).toISOString() }
      : null,
    delegatedActivity: delegatedActivityIndex?.get(session.id) ?? null,
  };
}

function serializeSessionList(sessions: readonly Session[], context: ApiContext): Session[] {
  const delegatedActivityIndex = buildSessionDelegatedActivityIndex(listSessions(), context);
  return sessions.map((session) => serializeSession(session, context, delegatedActivityIndex));
}

function serializeSessionResponse(session: Session, context: ApiContext): Session {
  const delegatedActivityIndex = buildSessionDelegatedActivityIndex(listSessions(), context);
  return serializeSession(session, context, delegatedActivityIndex);
}

function withTransportMeta(session: Session, updates: JsonObject): JsonObject {
  const base =
    session.transportMeta && typeof session.transportMeta === "object" && !Array.isArray(session.transportMeta)
      ? session.transportMeta
      : {};
  return { ...base, ...updates };
}

function supersedeRunningTurn(session: Session): void {
  updateSession(session.id, {
    transportMeta: withTransportMeta(session, {
      [SUPERSEDED_TURN_META_KEY]: new Date().toISOString(),
    }),
    ...(session.workflowProvenance?.kind === "phase" ? {
      attemptInterruptionCause: "user-message",
      attemptInterruptionTurn: (session.attemptTurn ?? 0) + 1,
    } : {}),
  });
}

function clearSupersededTurnMeta(sessionId: string): void {
  const session = getSession(sessionId);
  const meta = session?.transportMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !(SUPERSEDED_TURN_META_KEY in meta)) return;
  const next = { ...meta };
  delete next[SUPERSEDED_TURN_META_KEY];
  updateSession(sessionId, { transportMeta: next });
}

function isTurnSuperseded(sessionId: string, turnStartedAt: number): boolean {
  const marker = getSession(sessionId)?.transportMeta?.[SUPERSEDED_TURN_META_KEY];
  if (typeof marker !== "string") return false;
  const markedAt = new Date(marker).getTime();
  return Number.isFinite(markedAt) && markedAt >= turnStartedAt;
}

function isSessionLiveRunning(session: Session, context: ApiContext): boolean {
  if (session.status !== "running") return false;
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine || !isInterruptibleEngine(engine)) return true;
  if ("isTurnRunning" in engine) return Boolean((engine as any).isTurnRunning(session.id));
  return engine.isAlive(session.id);
}

function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port, path: "/api/status", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function requestWorkspaceOrigin(req: HttpRequest): string {
  for (const candidate of [headerValue(req, "origin"), headerValue(req, "referer")]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    } catch { /* try proxy/host headers */ }
  }
  const forwardedHost = headerValue(req, "x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headerValue(req, "host") || "127.0.0.1";
  const forwardedProto = headerValue(req, "x-forwarded-proto")?.split(",")[0]?.trim();
  const encrypted = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
  return new URL(`${forwardedProto === "https" || encrypted ? "https" : "http"}://${host}`).origin;
}

function workspaceDisplayName(instance: Instance): string {
  if (instance.displayName?.trim()) return instance.displayName.trim();
  try {
    const config = yaml.load(fs.readFileSync(path.join(instance.home, "config.yaml"), "utf8")) as {
      portal?: { companyName?: unknown };
    };
    if (typeof config?.portal?.companyName === "string" && config.portal.companyName.trim()) {
      return config.portal.companyName.trim();
    }
  } catch { /* registry name fallback */ }
  const slug = instance.name.replace(/^jinn-/, "");
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "Jinn";
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function defaultWorkspaceRunning(instance: Instance, current: boolean): Promise<boolean> {
  if (current) return true;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(instance.home, "gateway.json"), "utf8")) as { pid?: unknown; port?: unknown };
    if (info.port !== instance.port || typeof info.pid !== "number" || !processIsAlive(info.pid)) return false;
  } catch {
    try {
      const pid = Number.parseInt(fs.readFileSync(path.join(instance.home, "gateway.pid"), "utf8").trim(), 10);
      if (!processIsAlive(pid)) return false;
    } catch {
      return false;
    }
  }
  return checkInstanceHealth(instance.port);
}

function workspaceUrl(origin: string): string {
  return new URL("/", origin).toString();
}

function workspaceView(instance: Instance, options: {
  running: boolean;
  current: boolean;
  switchUrl: string;
}) {
  return {
    id: instance.id,
    name: instance.name,
    displayName: workspaceDisplayName(instance),
    port: instance.port,
    running: options.running,
    current: options.current,
    switchUrl: workspaceUrl(options.switchUrl),
  };
}

export async function handleApiRequest(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  if (!parseRequestAuthority(req)) {
    return json(res, { error: "Invalid request authority" }, 400);
  }
  const rawTarget = req.url || "/";
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//") || /[\x00-\x1f\\]/.test(rawTarget)) {
    return json(res, { error: "Invalid request target" }, 400);
  }
  let url: URL;
  try {
    url = new URL(rawTarget, "http://localhost");
  } catch {
    return json(res, { error: "Invalid request target" }, 400);
  }
  const pathname = url.pathname;
  const method = req.method || "GET";
  // Stash so json() can compress large responses without threading req everywhere.
  (res as ResWithEncoding).__acceptEncoding = req.headers["accept-encoding"];

  try {
    const jinnHome = context.jinnHome ?? JINN_HOME;

    const identifiedCaller = req.headers[TOOL_CALL_HEADER] !== undefined || req.headers[CALLER_SESSION_HEADER] !== undefined;
    if (identifiedCaller && rejectUnverifiedIdentifiedApiCaller(req, res, method, pathname, context)) {
      return;
    }
    if (context.workflowService && await handleWorkflowApi(req, res, { service: context.workflowService,
      authenticated: authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome).ok })) return;
    if (!identifiedCaller && rejectUnverifiedIdentifiedApiCaller(req, res, method, pathname, context)) return;

    if (method === "GET" && pathname === "/api/features") {
      return json(res, { notesEnabled: context.getConfig().gateway.notesEnabled === true });
    }

    if (pathname === "/api/notes" || pathname === "/api/notes/read") {
      if (context.getConfig().gateway.notesEnabled !== true) {
        return json(res, { error: "Notes are not enabled" }, 404);
      }
    }

    const controlPlaneAction = operatorOnlyControlPlaneRoute(method, pathname);
    if (controlPlaneAction && !requireOperatorControlPlaneAuthority(req, res, controlPlaneAction, context)) {
      return;
    }

    if (method === "GET" && pathname === "/api/callback-deliveries/dead-letter") {
      if (!requireCallbackRecoveryAuthority(req, res, context)) return;
      return json(res, { deliveries: listDeadLetterSessionDeliveries() });
    }

    const callbackRequeueParams = matchRoute("/api/callback-deliveries/:id/requeue", pathname);
    if (method === "POST" && callbackRequeueParams) {
      if (!requireCallbackRecoveryAuthority(req, res, context)) return;
      try {
        const existing = getSessionDelivery(callbackRequeueParams.id);
        const delivery = requeueDeadLetterSessionDelivery(callbackRequeueParams.id);
        void recoverPendingSessionDeliveries().catch((error) => {
          logger.error(`[callbacks] Requeued delivery ${delivery.id} could not start recovery: ${error instanceof Error ? error.message : String(error)}`);
        });
        return json(res, { delivery });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(res, { error: message }, /not found/i.test(message) ? 404 : 409);
      }
    }

    // GET /api/auth/state — safe browser boot metadata. Never includes the token.
    if (method === "GET" && pathname === "/api/auth/state") {
      const state = createAuthState(context.getConfig(), req, context.gatewayAuthToken, jinnHome);
      if (state.authenticated) touchAuthSession(jinnHome, req);
      return json(res, state);
    }

    // POST /api/auth/bootstrap — exchange the short-lived, single-use credential
    // embedded by the trusted CLI launch path for a revocable browser session.
    // Loopback alone is not identity: local agent sessions can issue raw HTTP.
    if (method === "POST" && pathname === "/api/auth/bootstrap") {
      if (!context.gatewayAuthToken) return json(res, { authRequired: false });
      if (rejectScopedIdentityGrant(req, res, "auth bootstrap", context)) return;
      if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host)) {
        return json(res, { error: "Bootstrap is loopback-only" }, 403);
      }
      const rawGrant = req.headers[LOCAL_BOOTSTRAP_GRANT_HEADER];
      const grant = Array.isArray(rawGrant) ? rawGrant[0] : rawGrant;
      if (!consumeLocalBootstrapGrant(grant)) {
        return json(res, { error: "Missing, invalid, or expired local bootstrap grant" }, 401);
      }
      const session = createAuthSession(jinnHome, req, { kind: "local" });
      res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.device.id, jinnHome));
      return json(res, { status: "ok", authRequired: true, device: { ...session.device, current: true } });
    }

    // POST /api/auth/pairing-challenges — begin proof that the caller controls
    // JINN_HOME as its owner. Loopback is required too, but is not itself identity.
    // This deliberately proves same-user filesystem control, not human presence:
    // a local agent with shell access can complete it. Such a process can already
    // rewrite the persisted browser-device store, so this does not weaken a real
    // boundary against that adversary.
    if (method === "POST" && pathname === "/api/auth/pairing-challenges") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      if (!context.gatewayAuthToken) return json(res, { error: "Gateway auth token is not configured" }, 503);
      if (rejectScopedIdentityGrant(req, res, "auth pairing challenge", context)) return;
      const localCaller = isLoopback(req.socket.remoteAddress)
        && isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
      if (!localCaller) return json(res, { error: "Pairing challenges can only be created locally" }, 403);

      const challenge = issuePairingChallenge(jinnHome);
      return json(res, {
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        path: challenge.path,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        ttlSeconds: Math.floor(PAIRING_CHALLENGE_TTL_MS / 1000),
      });
    }

    // POST /api/auth/pairing-codes — local helper for pairing a second browser.
    // Existing local browser sessions may mint directly. The CLI instead redeems
    // a single-use filesystem challenge; bearer possession alone stays forbidden.
    if (method === "POST" && pathname === "/api/auth/pairing-codes") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      if (!context.gatewayAuthToken) return json(res, { error: "Gateway auth token is not configured" }, 503);
      const bearer = hasGatewayBearerAuth(req.headers, context.gatewayAuthToken);
      if (bearer) {
        return json(res, { error: "Pairing codes require an authenticated browser session; bearer tokens cannot mint browser pairing material" }, 403);
      }
      if (rejectScopedIdentityGrant(req, res, "auth pairing-code mint", context)) return;
      const localCaller = isLoopback(req.socket.remoteAddress)
        && isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
      if (!localCaller) return json(res, { error: "Pairing codes can only be created locally" }, 403);

      const body = parsed.body && typeof parsed.body === "object" ? parsed.body as Record<string, unknown> : {};
      const challengeId = typeof body.challengeId === "string" ? body.challengeId : undefined;
      if (challengeId) {
        if (!consumePairingChallenge(jinnHome, challengeId)) {
          return json(res, { error: "Missing, invalid, expired, or already used pairing challenge" }, 403);
        }
      } else {
        const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
        if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 403);
      }
      const issued = issuePairingCode(createFilePairingCodeStore(jinnHome));
      return json(res, {
        status: "ok",
        code: issued.code,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        ttlSeconds: Math.floor((issued.expiresAt - Date.now()) / 1000),
      });
    }

    // POST /api/auth/pair — exchange a one-time pairing code for the HttpOnly
    // browser cookie used by APIs and WebSockets.
    if (method === "POST" && pathname === "/api/auth/pair") {
      if (rejectScopedIdentityGrant(req, res, "auth pair", context)) return;
      const parsed = await readJsonBody(req, res, { maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const body = parsed.body && typeof parsed.body === "object" ? parsed.body as Record<string, unknown> : {};
      const code = typeof body.code === "string" ? body.code : undefined;
      const ok = consumePairingCode(createFilePairingCodeStore(jinnHome), code);
      if (!ok || !context.gatewayAuthToken) return json(res, { error: "Invalid or expired pairing code" }, 401);
      const session = createAuthSession(jinnHome, req, { kind: "remote" });
      res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.device.id, jinnHome));
      return json(res, { status: "ok", authRequired: true, device: { ...session.device, current: true } });
    }

    // GET /api/auth/devices — authenticated browser list for Settings > Pairing.
    if (method === "GET" && pathname === "/api/auth/devices") {
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      touchAuthSession(jinnHome, req);
      return json(res, { devices: listAuthSessions(jinnHome, currentAuthDeviceId(req.headers, jinnHome)) });
    }

    // DELETE /api/auth/devices/:id — shared unpair primitive used by Settings
    // and the CLI. Deleting the current browser also clears its cookies.
    if (method === "DELETE" && pathname.startsWith("/api/auth/devices/")) {
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      const rawDeviceId = pathname.slice("/api/auth/devices/".length);
      let deviceId = "";
      try {
        deviceId = decodeURIComponent(rawDeviceId);
      } catch {
        return badRequest(res, "Invalid paired browser id");
      }
      if (!deviceId) return badRequest(res, "Missing paired browser id");
      const currentDevice = currentAuthDeviceId(req.headers, jinnHome);
      const removed = revokeAuthSession(jinnHome, deviceId);
      if (!removed) return json(res, { error: "Paired browser not found" }, 404);
      const current = Boolean(currentDevice && currentDevice === deviceId);
      if (current) res.setHeader("Set-Cookie", clearAuthCookieHeaders(jinnHome));
      return json(res, { status: "ok", current });
    }

    // POST /api/auth/logout — forget this browser by clearing the auth cookie.
    if (method === "POST" && pathname === "/api/auth/logout") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: AUTH_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const currentDevice = currentAuthDeviceId(req.headers, jinnHome);
      if (currentDevice) revokeAuthSession(jinnHome, currentDevice);
      res.setHeader("Set-Cookie", clearAuthCookieHeaders(jinnHome));
      return json(res, { status: "ok" });
    }

    // GET /api/instance-migration — canonical, validated migration contract.
    if (method === "GET" && pathname === "/api/instance-migration") {
      try {
        return json(res, pendingInstanceMigration(context));
      } catch (error) {
        logger.error(`Instance migration bundle validation failed: ${error instanceof Error ? error.message : String(error)}`);
        return json(res, { error: "Installed instance migration bundle is invalid", code: "MIGRATION_BUNDLE_INVALID" }, 500);
      }
    }

    // POST /api/instance-migration/open — snapshot first, then one durable COO session.
    if (method === "POST" && pathname === "/api/instance-migration/open") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      let pending: PendingInstanceMigration;
      try { pending = pendingInstanceMigration(context); }
      catch (error) {
        logger.error(`Instance migration open refused: ${error instanceof Error ? error.message : String(error)}`);
        return json(res, { error: "Installed instance migration bundle is invalid", code: "MIGRATION_BUNDLE_INVALID" }, 500);
      }
      if (!pending.required || !pending.migrationKey) {
        return json(res, { error: "Instance migration is not pending", code: "MIGRATION_NOT_PENDING" }, 409);
      }
      const body = parsed.body && typeof parsed.body === "object" ? parsed.body as Record<string, unknown> : {};
      if (body.migrationKey !== pending.migrationKey) {
        return json(res, { error: "Migration key no longer matches the pending bundle", code: "MIGRATION_KEY_MISMATCH" }, 409);
      }
      try {
        const opened = await openInstanceMigration(pending, req, context);
        return json(res, opened, opened.reused ? 200 : 201);
      } catch (error) {
        logger.error(`Instance migration session could not open: ${error instanceof Error ? error.message : String(error)}`);
        // Name the one cause the operator can actually act on. Collapsing every
        // failure into one opaque sentence turned a fixable local problem (a
        // missing Windows symlink privilege) into an apparent outage of the
        // migration service, with nothing in the UI pointing at the real fix.
        // The raw message stays in the log: it carries absolute instance paths.
        return json(res, {
          error: "Could not create the migration snapshot and COO handoff",
          code: "MIGRATION_OPEN_FAILED",
          ...(process.platform === "win32" && isSymlinkPrivilegeError(error)
            ? { remedy: "Creating the migration snapshot needs symlink permission. Enable Developer Mode (Settings > System > For developers) or run the gateway elevated, then restart Jinn and retry." }
            : {}),
        }, 500);
      }
    }

    // GET /api/status
    if (method === "GET" && pathname === "/api/status") {
      const config = context.getConfig();
      // Only running rows can be "live running" (isSessionLiveRunning short-circuits
      // on status!=='running'), so hydrate just those (~handful, idx_sessions_status)
      // instead of materializing + JSON-parsing every session to count them.
      const running = listSessions({ status: "running" }).filter((s) => isSessionLiveRunning(s, context)).length;
      const connectors = Object.fromEntries(
        Array.from(context.connectors.values()).map((connector) => [connector.name, connector.getHealth()]),
      );
      let migration: Pick<PendingInstanceMigration, "required" | "fromVersion" | "toVersion" | "versions"> & { error?: string };
      try {
        const pending = pendingInstanceMigration(context);
        migration = { required: pending.required, fromVersion: pending.fromVersion, toVersion: pending.toVersion, versions: pending.versions };
      } catch {
        migration = { required: false, fromVersion: "unknown", toVersion: context.migrationPackageVersion ?? getPackageVersion(), versions: [], error: "invalid_bundle" };
      }
      return json(res, {
        status: "ok",
        version: context.migrationPackageVersion ?? getPackageVersion(),
        migration,
        uptime: Math.floor((Date.now() - context.startTime) / 1000),
        port: config.gateway.port || 7777,
        // Derived from the model registry (single source of truth) so engine
        // availability stays consistent with /api/engines instead of drifting.
        engines: {
          default: config.engines.default,
          ...Object.fromEntries(
            Object.entries(getModelRegistry(config)).map(([name, entry]) => [
              name,
              { model: entry.defaultModel, available: entry.available },
            ]),
          ),
        },
        sessions: { total: countSessions(), running, active: running },
        connectors,
      });
    }

    // POST /api/system/restart — spawn the detached restart helper from the
    // gateway process itself, after the HTTP response has been flushed.
    if (method === "POST" && pathname === "/api/system/restart") {
      const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome);
      if (!auth.ok) return json(res, { error: auth.reason || "Unauthorized" }, 401);
      const requestingSessionId = headerValue(req, "x-jinn-session-id")?.trim();
      if (requestingSessionId) {
        const requestingSession = getSession(requestingSessionId);
        const completed = markRunningQueueItemsCompletedForSession(requestingSessionId);
        if (completed > 0) {
          logger.info(`Completed ${completed} active queue item(s) for restart-requesting session ${requestingSessionId}`);
        }
        const transportMeta = (requestingSession?.transportMeta && typeof requestingSession.transportMeta === "object" && !Array.isArray(requestingSession.transportMeta))
          ? { ...(requestingSession.transportMeta as JsonObject) }
          : {};
        transportMeta[RESTART_ACK_META_KEY] = new Date().toISOString();
        updateSession(requestingSessionId, {
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
          transportMeta,
        });
      }
      const restartGateway = context.restartGateway ?? restartDetached;
      logger.info("Gateway restart requested via API");
      const timer = setTimeout(() => {
        try {
          restartGateway({ port: context.runtimePort ?? context.config.gateway.port ?? 7777 });
        } catch (err) {
          logger.error(`Failed to spawn gateway restart helper: ${err instanceof Error ? err.stack : err}`);
        }
      }, 50);
      timer.unref?.();
      return json(res, { status: "restarting" });
    }

    // GET /api/instances — active/pinned host workspaces with server-resolved
    // launch URLs. The browser never guesses localhost or proxy/Tailscale ports.
    if (method === "GET" && pathname === "/api/instances") {
      let instances = (context.loadWorkspaceInstances ?? loadInstances)();
      const currentHome = resolveHomeIdentity(context.jinnHome ?? JINN_HOME);
      const currentOrigin = requestWorkspaceOrigin(req);
      const mappings = await (context.readWorkspaceAccessMappings ?? readTailscaleServeMappings)();
      const runningCheck = context.checkWorkspaceRunning ?? defaultWorkspaceRunning;
      const runtime = await Promise.all(instances.map(async (instance) => {
        const current = resolveHomeIdentity(instance.home) === currentHome;
        return { instance, current, running: await runningCheck(instance, current) };
      }));

      // Learn the current browser-facing origin for generic reverse proxies.
      // Keep separate local/remote observations so localhost never overwrites a
      // working remote URL, and prefer an exact provider mapping when present.
      const currentRow = runtime.find((row) => row.current);
      if (currentRow) {
        const parsedOrigin = new URL(currentOrigin);
        const local = isLoopbackHost(parsedOrigin.host);
        const providerOrigin = mappings.find((mapping) => mapping.internalPort === currentRow.instance.port)?.externalUrl;
        const observed = providerOrigin ?? currentOrigin;
        const accessUrls = { ...currentRow.instance.accessUrls, [local ? "local" : "remote"]: observed };
        if (currentRow.instance.accessUrls?.[local ? "local" : "remote"] !== observed) {
          instances = instances.map((instance) => instance.id === currentRow.instance.id ? { ...instance, accessUrls } : instance);
          (context.saveWorkspaceInstances ?? saveInstances)(instances);
          currentRow.instance = { ...currentRow.instance, accessUrls };
        }
      }

      return json(res, runtime
        .filter(({ instance, current, running }) => current || running || instance.pinned === true)
        .map(({ instance, current, running }) => workspaceView(instance, {
          current,
          running,
          switchUrl: resolveInstanceSwitchUrl({ instance, currentOrigin, tailscaleMappings: mappings }),
        })));
    }

    // POST /api/instances — create + start a clean workspace, clone safe local
    // access configuration, and return a one-use fragment credential so the
    // operator lands directly in the new instance's onboarding wizard.
    if (method === "POST" && pathname === "/api/instances") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      const body = parsed.body && typeof parsed.body === "object" ? parsed.body as Record<string, unknown> : {};
      if (typeof body.name !== "string" || !body.name.trim()) return badRequest(res, "Workspace name is required");
      if (body.port !== undefined && (typeof body.port !== "number" || !Number.isSafeInteger(body.port))) {
        return badRequest(res, "port must be an integer");
      }
      const currentConfig = context.getConfig();
      const currentPort = context.runtimePort ?? currentConfig.gateway.port ?? 7777;
      let created: CreateInstanceResult;
      try {
        created = await (context.createWorkspaceInstance ?? createInstance)({
          name: body.name,
          port: body.port as number | undefined,
          currentPort,
          gatewayHost: currentConfig.gateway.host,
          authRequired: shouldRequireGatewayAuth(currentConfig),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const conflict = /already exists|already in use/i.test(message);
        const invalid = /workspace name|port must/i.test(message);
        return json(res, { error: message }, conflict ? 409 : invalid ? 400 : 500);
      }
      const currentOrigin = requestWorkspaceOrigin(req);
      const mappings = await (context.readWorkspaceAccessMappings ?? readTailscaleServeMappings)();
      const switchOrigin = resolveInstanceSwitchUrl({
        instance: created.instance,
        currentOrigin,
        tailscaleMappings: mappings,
      });
      const code = context.issueWorkspacePairingCode
        ? context.issueWorkspacePairingCode(created.instance.home)
        : issuePairingCode(createFilePairingCodeStore(created.instance.home)).code;
      const launchUrl = new URL("/", switchOrigin);
      launchUrl.searchParams.set("onboarding", "1");
      launchUrl.hash = new URLSearchParams({ "jinn-pair": code }).toString();
      return json(res, {
        instance: workspaceView(created.instance, { running: true, current: false, switchUrl: switchOrigin }),
        launchUrl: launchUrl.toString(),
        ...(created.warning ? { warning: created.warning } : {}),
      }, 201);
    }

    // POST /api/instances/:id/start — start an existing offline workspace with
    // its registered home/port, provision matching remote access when possible,
    // and return a server-resolved URL for the browser to open.
    const workspaceStartParams = matchRoute("/api/instances/:id/start", pathname);
    if (method === "POST" && workspaceStartParams) {
      const instances = (context.loadWorkspaceInstances ?? loadInstances)();
      const instance = instances.find((candidate) => candidate.id === workspaceStartParams.id);
      if (!instance) return json(res, { error: "Workspace not found" }, 404);

      const currentHome = resolveHomeIdentity(context.jinnHome ?? JINN_HOME);
      const current = resolveHomeIdentity(instance.home) === currentHome;
      const runningCheck = context.checkWorkspaceRunning ?? defaultWorkspaceRunning;
      let started: StartInstanceResult = { instance };
      if (!await runningCheck(instance, current)) {
        try {
          started = await (context.startWorkspaceInstance ?? startInstance)({
            instance,
            currentPort: context.runtimePort ?? context.getConfig().gateway.port ?? 7777,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json(res, { error: message }, /already in use|already running/i.test(message) ? 409 : 500);
        }
      }

      const currentOrigin = requestWorkspaceOrigin(req);
      const mappings = await (context.readWorkspaceAccessMappings ?? readTailscaleServeMappings)();
      return json(res, {
        ...workspaceView(started.instance, {
          running: true,
          current,
          switchUrl: resolveInstanceSwitchUrl({ instance: started.instance, currentOrigin, tailscaleMappings: mappings }),
        }),
        ...(started.warning ? { warning: started.warning } : {}),
      });
    }

    // GET /api/search/messages — GRS-020a company-reference search: FTS5 over
    // user/assistant message bodies (injection-safe — the store sanitizes the
    // query into quoted phrases), AND-composed bound-param filters, newest-first.
    // GRS-020a-fix hardening: control bytes are stripped from every string param
    // (an embedded NUL made FTS5 throw — finding 2) and the query length is
    // capped route-side (finding 3; the MCP tools cap earlier and friendlier).
    if (method === "GET" && pathname === "/api/search/messages") {
      const readParam = (name: string): string | null => readCleanSearchParam(url, name);
      const q = readParam("q");
      if (!q) return badRequest(res, "q is required");
      if (q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
        return badRequest(res, `q is too long (${q.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
      }
      const filter: MessageSearchFilter = {};
      const sessionId = readParam("sessionId");
      if (sessionId) filter.sessionId = sessionId;
      const excludeSessionId = readParam("excludeSessionId");
      if (excludeSessionId) filter.excludeSessionId = excludeSessionId;
      const employee = readParam("employee");
      if (employee) filter.employee = employee;
      const engine = readParam("engine");
      if (engine) filter.engine = engine;
      const role = readParam("role");
      if (role) {
        if (role !== "user" && role !== "assistant") {
          return badRequest(res, `role must be "user" or "assistant" (only those rows are indexed), got "${role}"`);
        }
        filter.role = role;
      }
      for (const [param, key] of [["since", "since"], ["until", "until"]] as const) {
        const raw = readParam(param);
        if (raw) {
          const ms = Date.parse(raw);
          if (Number.isNaN(ms)) return badRequest(res, `${param} must be an ISO-8601 timestamp, got "${raw}"`);
          filter[key] = ms;
        }
      }
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 200));
      const results = searchMessages(q, limit, filter);
      return json(res, { query: q, results });
    }

    // GET /api/search/sessions — GRS-020a: deterministic AND-composed session
    // search (escaped-LIKE text over title/prompt_excerpt/id + structured
    // filters). At least one filter required — the unbounded list stays on
    // GET /api/sessions. Returns COMPACT summaries only (GRS-020a-fix finding
    // 5: the reference layer's route contract is summaries, not the full
    // serialized session); string params are control-stripped and the text
    // filter is length-capped (findings 2+3).
    if (method === "GET" && pathname === "/api/search/sessions") {
      const readParam = (name: string): string | null => readCleanSearchParam(url, name);
      const filter: SearchSessionsFilter = {};
      const text = readParam("text");
      if (text) {
        if (text.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
          return badRequest(res, `text is too long (${text.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
        }
        filter.text = text;
      }
      const employee = readParam("employee");
      if (employee) filter.employee = employee;
      const engine = readParam("engine");
      if (engine) filter.engine = engine;
      const status = readParam("status");
      if (status) {
        const valid: Session["status"][] = ["idle", "running", "error", "waiting", "interrupted"];
        if (!valid.includes(status as Session["status"])) {
          return badRequest(res, `status must be one of ${valid.join(", ")}, got "${status}"`);
        }
        filter.status = status as Session["status"];
      }
      const source = readParam("source");
      if (source) filter.source = source;
      const parentSessionId = readParam("parentSessionId");
      if (parentSessionId) filter.parentSessionId = parentSessionId;
      const workflowId = readParam("workflowId");
      if (workflowId) filter.workflowId = workflowId;
      const workflowRunId = readParam("workflowRunId");
      if (workflowRunId) filter.workflowRunId = workflowRunId;
      const workflowPhaseName = readParam("workflowPhaseName");
      if (workflowPhaseName) filter.workflowPhaseName = workflowPhaseName;
      for (const key of ["activeSince", "activeBefore"] as const) {
        const raw = readParam(key);
        if (raw) {
          if (Number.isNaN(Date.parse(raw))) return badRequest(res, `${key} must be an ISO-8601 timestamp, got "${raw}"`);
          filter[key] = new Date(raw).toISOString();
        }
      }
      if (url.searchParams.get("needsAttention") === "true") filter.needsAttention = true;
      if (Object.keys(filter).length === 0) {
        return badRequest(res, "at least one filter is required (text, employee, engine, status, source, parentSessionId, workflowId, workflowRunId, workflowPhaseName, activeSince, activeBefore, needsAttention)");
      }
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 50));
      const sessions = searchSessionsFiltered(filter, limit);
      return json(res, { sessions: sessions.map(compactSessionSummary) });
    }

    // GET /api/cost/report — GRS-020c cost-only read surface. Deterministic
    // aggregate over existing sessions.total_cost/total_turns; no budgets,
    // thresholds, work-item joins, or mutation.
    if (method === "GET" && pathname === "/api/cost/report") {
      const groupBy = readCleanSearchParam(url, "groupBy") || "employee";
      if (groupBy !== "employee" && groupBy !== "day") return badRequest(res, 'groupBy must be "employee" or "day"');
      const parseIso = (name: "since" | "until"): string | undefined => {
        const raw = readCleanSearchParam(url, name);
        if (!raw) return undefined;
        if (Number.isNaN(Date.parse(raw))) return "";
        return new Date(raw).toISOString();
      };
      const since = parseIso("since");
      if (since === "") return badRequest(res, "since must be an ISO-8601 timestamp");
      const until = parseIso("until");
      if (until === "") return badRequest(res, "until must be an ISO-8601 timestamp");
      const employee = readCleanSearchParam(url, "employee") || undefined;
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 100));
      const report = getCostReport({ groupBy, since, until, employee, limit });
      return json(res, {
        ...report,
        hint: "Costs are engine-reported per session; missing/zero rows mean the engine reported none.",
      });
    }

    // GET /api/search/work-items — GRS-021c: deterministic AND-composed Todo
    // search. Text is escaped-LIKE over title+body (%/_/backslash literal) and
    // structured filters are exact. Compact summaries only — body/acceptance
    // dumps stay behind GET /api/work-items/:id.
    if (method === "GET" && pathname === "/api/search/work-items") {
      const parsedQuery = readWorkItemQueryParams(url);
      if (!parsedQuery.ok) return badRequest(res, parsedQuery.error);
      const { filter, limit, offset } = parsedQuery.value;
      const needsAttentionFor = readCleanSearchParam(url, "needsAttentionFor");
      if (needsAttentionFor) {
        const target = resolveNeedsAttentionTarget(req, res, needsAttentionFor, context);
        if (!target) return;
        filter.needsAttentionFor = target;
      }
      if (Object.keys(filter).length === 0) {
        return badRequest(res, "at least one filter is required (q, text, status, source, assignee, department, since, until, needsAttentionFor)");
      }
      return json(res, workItemPagePayload(queryWorkItems({ ...filter, limit, offset })));
    }

    // Notes is the editable projection of knowledge/**/*.md. docs/ remains on
    // the legacy read-only knowledge surface and cannot enter these routes.
    if (method === "GET" && pathname === "/api/notes") {
      const q = readCleanSearchParam(url, "q") ?? undefined;
      if (q && q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
        return badRequest(res, `q is too long (${q.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
      }
      return json(res, listNotes({ home: jinnHome, ...(q ? { query: q } : {}) }));
    }

    if (method === "GET" && pathname === "/api/notes/read") {
      const rawPath = url.searchParams.get("path");
      if (rawPath !== null && hasControlBytes(rawPath)) {
        return badRequest(res, "path contains control bytes — pass a path returned by list_notes exactly");
      }
      if (!rawPath) return badRequest(res, "path is required");
      const result = readNote(rawPath, jinnHome);
      if (!result.ok) return noteStoreFailureResponse(res, result);
      return json(res, { note: result.value });
    }

    if (method === "POST" && pathname === "/api/notes") {
      const parsed = await readJsonBody(req, res, { maxBytes: NOTES_BODY_ROUTE_MAX_BYTES });
      if (!parsed.ok) return;
      const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
        ? parsed.body as Record<string, unknown>
        : {};
      if (typeof body.title !== "string") return badRequest(res, "title is required and must be a string");
      if (body.body !== undefined && typeof body.body !== "string") return badRequest(res, "body must be a string");
      if (body.folder !== undefined && typeof body.folder !== "string") return badRequest(res, "folder must be a string");
      const result = createNote({
        title: body.title,
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(typeof body.folder === "string" ? { folder: body.folder } : {}),
      }, jinnHome);
      if (!result.ok) return noteStoreFailureResponse(res, result);
      context.emit("notes:changed", { path: result.value.path, revision: result.value.revision, action: "created" });
      return json(res, { note: result.value }, 201);
    }

    if (method === "PUT" && pathname === "/api/notes") {
      const parsed = await readJsonBody(req, res, { maxBytes: NOTES_BODY_ROUTE_MAX_BYTES });
      if (!parsed.ok) return;
      const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
        ? parsed.body as Record<string, unknown>
        : {};
      if (typeof body.path !== "string") return badRequest(res, "path is required and must be a string");
      if (typeof body.expectedRevision !== "string") return badRequest(res, "expectedRevision is required and must be a string");
      for (const field of ["title", "body", "append"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") return badRequest(res, `${field} must be a string`);
      }
      if (body.body !== undefined && body.append !== undefined) return badRequest(res, "body and append are mutually exclusive");
      if (body.title === undefined && body.body === undefined && body.append === undefined) {
        return badRequest(res, "at least one of title, body, or append is required");
      }
      const result = updateNote({
        path: body.path,
        expectedRevision: body.expectedRevision,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(typeof body.append === "string" ? { append: body.append } : {}),
      }, jinnHome);
      if (!result.ok) return noteStoreFailureResponse(res, result);
      context.emit("notes:changed", { path: result.value.path, revision: result.value.revision, action: "updated" });
      return json(res, { note: result.value });
    }

    // GET /api/knowledge/search — GRS-020b: deterministic token-AND search over
    // the two allowlisted knowledge roots (knowledge/ + docs/, .md only).
    // Snippets only, never bodies; query is control-stripped + length-capped
    // (the GRS-020a hardening, reused).
    if (method === "GET" && pathname === "/api/knowledge/search") {
      const q = readCleanSearchParam(url, "q");
      if (!q) return badRequest(res, "q is required");
      if (q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
        return badRequest(res, `q is too long (${q.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
      }
      return json(res, { query: q, results: searchKnowledge(q, jinnHome) });
    }

    // GET /api/knowledge/read — read ONE file inside the active Jinn instance.
    // SECURITY-CRITICAL: the store enforces instance-root containment, so
    // `..`, absolute paths, and symlink escapes are refused (400/403). This route is
    // deliberately SEPARATE from the operator/UI GET /api/files/read.
    if (method === "GET" && pathname === "/api/knowledge/read") {
      // GRS-020b-fix: REJECT control bytes on the RAW path — never strip. The
      // shared readCleanSearchParam STRIPS control bytes (correct for free-text
      // search queries) which would silently REPAIR a `%00`-tampered path into a
      // valid one and read it (the claimed "%00 -> 400" contract failing). The
      // security-critical read surface rejects on the raw param first; the store
      // primitive mirrors the same reject as defense-in-depth.
      const rawPath = url.searchParams.get("path");
      if (rawPath !== null && hasControlBytes(rawPath)) {
        return badRequest(res, "path contains control bytes");
      }
      const rel = readCleanSearchParam(url, "path");
      if (!rel) return badRequest(res, 'path is required — use a relative path inside the Jinn instance, e.g. "knowledge/some-file.md"');
      const result = readKnowledgeFile(rel, jinnHome);
      if (!result.ok) {
        if (result.reason === "forbidden") return json(res, { error: result.detail }, 403);
        if (result.reason === "not-found") return json(res, { error: result.detail }, 404);
        return badRequest(res, result.detail);
      }
      const { ok: _ok, ...payload } = result;
      return json(res, payload);
    }

    // GET /api/sessions
    //   ?group=<employee|__direct__|__cron__>&offset=M&limit=N → one group's page (sidebar "load more")
    //   ?limit=0                                              → every session (power-user escape hatch)
    //   (default)                                             → top SESSION_LIST_PER_GROUP recent per group + counts
    if (method === "GET" && pathname === "/api/sessions") {
      const query = url.searchParams.get("q");
      if (query && query.trim()) {
        const matches = searchSessions(query.trim());
        return json(res, serializeSessionList(matches, context));
      }
      const group = url.searchParams.get("group");
      const rawLimit = url.searchParams.get("limit");
      // Portal-slug-tagged rows fold into the direct group (defensive +
      // retroactive backstop to the create-time coercion above).
      const portalSlug = context.getConfig().portal?.portalName;
      if (group) {
        const limit = Math.max(1, parseInt(rawLimit || "50", 10) || 50);
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        const page = listSessionsForGroup(group, limit, offset, portalSlug);
        return json(res, serializeSessionList(page, context));
      }
      if (rawLimit === "0") {
        const all = listSessions();
        return json(res, serializeSessionList(all, context));
      }
      const sessions = listRecentPerGroup(SESSION_LIST_PER_GROUP, portalSlug);
      return json(res, {
        sessions: serializeSessionList(sessions, context),
        counts: getSessionGroupCounts(portalSlug),
        perGroup: SESSION_LIST_PER_GROUP,
      });
    }

    // GET /api/sessions/interrupted — list sessions that can be resumed after a restart
    if (method === "GET" && pathname === "/api/sessions/interrupted") {
      const { getInterruptedSessions } = await import("../sessions/registry.js");
      const interrupted = getInterruptedSessions();
      return json(res, serializeSessionList(interrupted, context));
    }

    // GET /api/sessions/:id/messages?before=<messageId>&limit=N
    // Bounded older-history page for seamless transcript prepending in the web UI.
    let params = matchRoute("/api/sessions/:id/messages", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const limit = parseMessageLimit(url.searchParams.get("limit"), 100);
      const before = url.searchParams.get("before") || undefined;
      const page = getMessagePage(params.id, { before, limit });
      return json(res, page);
    }

    // GET /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const includeMessages = url.searchParams.get("messages") !== "0";
      const lastN = parseMessageLimit(url.searchParams.get("last"), 0);
      const page = includeMessages && lastN > 0
        ? getMessagePage(params.id, { limit: lastN })
        : null;
      const messages = includeMessages
        ? page ? page.messages : getMessages(params.id)
        : [];

      // Backfill from Claude Code's JSONL transcript if our DB has no messages.
      // Run async + transactional so the GET doesn't block on multi-MB JSONL
      // parsing + N individual INSERTs. Subsequent GETs will see the messages
      // once the backfill finishes; this one returns whatever is in DB now.
      const claudeSessionId = getEngineSessionRef(session, "claude").id;
      if (includeMessages && messages.length === 0 && session.engine === "claude" && claudeSessionId) {
        scheduleTranscriptBackfill(params.id, claudeSessionId, context);
      } else if (includeMessages && session.engine === "claude") {
        // On-load safety net for PTY-native (CLI-typed) turns whose unclaimed
        // Stop was missed entirely: fire-and-forget a transcript tail sync.
        // Cheap (one stat() in the common case) and never delays this GET —
        // the frontend refetches on `session:external-turn`.
        scheduleOnLoadTailSync(params.id, context.emit);
      }

      return json(res, {
        ...serializeSessionResponse(session, context),
        ...(includeMessages ? { messages } : {}),
        ...(page ? { messagesPage: { hasOlder: page.hasOlder } } : {}),
      });
    }

    // PUT|PATCH /api/sessions/:id — update title and/or mid-chat model/effort
    params = matchRoute("/api/sessions/:id", pathname);
    if ((method === "PUT" || method === "PATCH") && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const updates: UpdateSessionFields = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return badRequest(res, "title must be a string");
        const trimmed = body.title.trim();
        if (!trimmed) return badRequest(res, "title must not be empty");
        updates.title = trimmed.slice(0, 200);
      }
      const configForPatch = context.getConfig();
      let requestedEngine: string | undefined;
      if (body.engine !== undefined) {
        if (typeof body.engine !== "string" || !body.engine.trim()) {
          return badRequest(res, "engine must be a non-empty string");
        }
        requestedEngine = body.engine.trim();
      }

      const engineChanging = Boolean(requestedEngine && requestedEngine !== session.engine);
      if (engineChanging) {
        if (blocksEngineSwitch(getSessionTransportState(session, context))) {
          return badRequest(res, "Cannot switch engine while a turn is running, waiting, or queued");
        }
        const savedRef = getEngineSessionRef(session, requestedEngine);
        const selection = validateNewSessionSelection(configForPatch, {
          engine: requestedEngine,
          model: body.model ?? savedRef.model,
          effortLevel: body.effortLevel ?? savedRef.effortLevel,
        });
        if (!selection.ok) return badRequest(res, selection.error || "invalid engine/model/effort");
        let switched = switchSessionEngine(params.id, selection.engine!, {
          model: selection.model ?? null,
          effortLevel: selection.effortLevel ?? null,
        });
        if (!switched) return notFound(res);
        if (updates.title !== undefined) {
          switched = updateSession(params.id, { title: updates.title }) ?? switched;
        }
        context.emit("session:updated", { sessionId: params.id });
        return json(res, serializeSessionResponse(switched, context));
      }

      // Mid-chat model / effort switch (applies from the next turn). Validated
      // against the current engine unless this request intentionally switched
      // engines above.
      if (body.model !== undefined || body.effortLevel !== undefined) {
        const engineConfigForPatch =
          (configForPatch.engines as unknown as Record<string, { model?: string } | undefined>)[session.engine] ?? {};
        const patch = validateSessionPatch(configForPatch, session.engine, session.model, body, {
          engineSessionId: getEngineSessionRef(session, session.engine).id,
          defaultModel: engineConfigForPatch.model,
        });
        if (!patch.ok) return badRequest(res, patch.error || "invalid model/effort");
        if (patch.updates?.model !== undefined) updates.model = patch.updates.model;
        if (patch.updates?.effortLevel !== undefined) updates.effortLevel = patch.updates.effortLevel;
      }
      if (Object.keys(updates).length === 0) return badRequest(res, "no valid fields to update");
      const updated = updateSession(params.id, updates);
      if (!updated) return notFound(res);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, serializeSessionResponse(updated, context));
    }

    // DELETE /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);

      if (session.workItemId) {
        preserveLinkedAttempt(context, session, "Interrupted: deletion refused for linked execution attempt");
        return json(res, {
          error: "Linked execution attempts are durable Todo evidence and cannot be deleted",
          preserved: true,
          sessionId: session.id,
          workItemId: session.workItemId,
        }, 409);
      }

      // Tear down any live/warm engine processes for this session before deleting it.
      // kill() is safe to call unconditionally — it's a no-op when nothing is running.
      logger.info(`Killing engine process for deleted session ${params.id}`);
      killSessionEngines(context, session, "Interrupted: session deleted");
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);

      maybeEmitTalkGraph(params.id, "removed", { getSession, emit: context.emit });
      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      // Remove any per-session Codex CODEX_HOME overlay (holds a session-scoped
      // capability in its config.toml). No-op for non-codex sessions. Idempotent.
      removeCodexSessionHome(params.id);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // POST /api/sessions/:id/archive — reversible operator cleanup. The
    // session, transcript, engine snapshot, and Codex overlay remain intact;
    // normal list queries simply omit its archived_at row until unarchived.
    params = matchRoute("/api/sessions/:id/archive", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      if (session.status === "running" || session.status === "waiting") {
        return json(res, { error: "Cannot archive a chat while it is running or waiting" }, 409);
      }
      const archived = archiveSession(params.id);
      if (!archived) return notFound(res);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, serializeSessionResponse(archived, context));
    }

    // POST /api/sessions/:id/unarchive — restore a retained chat to normal
    // session lists without mutating its transcript or execution state.
    params = matchRoute("/api/sessions/:id/unarchive", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const restored = unarchiveSession(params.id);
      if (!restored) return notFound(res);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, serializeSessionResponse(restored, context));
    }

    // POST /api/sessions/:id/stop
    params = matchRoute("/api/sessions/:id/stop", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      // GRS-017a — an agent-initiated stop (declared caller identity) is scoped
      // to the caller's OWN DESCENDANTS: cross-tree stops are a lateral
      // authority grab, so peers and ancestors are refused. Operator/UI calls
      // carry neither identity nor tool marker and keep today's full access.
      // A TOOL call that LOST its identity (marker, no caller header) fails
      // CLOSED — it must never fall through to this unrestricted operator path
      // (codex finding 2). Honor-system caveat (design §5): with a shared
      // bearer token the scoping is best-effort — it refuses to TEACH the
      // pattern, it cannot police curl.
      const stopCaller = resolveScopedWriteCallerIdentity(req, context);
      if (stopCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      if (stopCaller.kind === "session" && !isDescendantOf(params.id, stopCaller.callerId, getSession)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: `session ${params.id} is not a descendant of your session — agents may only stop sessions they spawned (directly or transitively). Ask the operator or the session's parent instead.`,
        }));
        return;
      }
      killSessionEngines(context, session, "Interrupted by user");
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      updateSession(params.id, { status: "interrupted", attemptOutcome: "interrupted", lastActivity: new Date().toISOString(), lastError: "Interrupted by user" });
      context.emit("session:stopped", { sessionId: params.id });
      return json(res, { status: "stopped", sessionId: params.id });
    }

    // POST /api/sessions/:id/reset — clear stuck session state (stale engine IDs, errors)
    params = matchRoute("/api/sessions/:id/reset", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      killSessionEngines(context, session, "Interrupted: session reset");
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
      delete meta["engineSessions"];
      delete meta["engineOverride"];
      clearEngineSessionRefs(params.id);
      ptySnapshotStore.deleteSync(params.id);
      updateSession(params.id, {
        status: "interrupted",
        attemptOutcome: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted: session reset",
        transportMeta: meta as any,
      });
      logger.info(`Session ${params.id} reset via API (cleared engineSessions, engineOverride, engineSessionId, lastError)`);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, { status: "reset", sessionId: params.id });
    }

    // POST /api/sessions/:id/duplicate — duplicate a session (snapshot fork)
    params = matchRoute("/api/sessions/:id/duplicate", pathname);
    if (method === "POST" && params) {
      const source = getSession(params.id);
      if (!source) return notFound(res);
      if (!source.engineSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session has no engine session ID — cannot duplicate" }));
        return;
      }

      let newSessionId: string | null = null;
      try {
        // 1. Duplicate session + messages in the registry
        const { session: newSession, messageCount } = duplicateSession(params.id);
        newSessionId = newSession.id;

        // 2. Fork the engine session (Claude/Codex). For Claude, route through
        //    the interactive PTY fork (no `-p`) so the duplicate bills as
        //    cc_entrypoint=cli rather than the de-subsidized Agent-SDK headless
        //    pool. Codex ignores the interactive ctx (it just copies the JSONL).
        const interactive = source.engine === "claude" && context.interactiveClaudeEngine
          ? {
              sourceJinnSessionId: params.id,
              engine: context.interactiveClaudeEngine,
              bin: context.getConfig().engines.claude.bin,
            }
          : undefined;
        const codex = source.engine === "codex"
          ? {
              sourceSessionsRoot: path.join(CODEX_HOMES_DIR, params.id, "sessions"),
              destinationSessionsRoot: path.join(CODEX_HOMES_DIR, newSession.id, "sessions"),
            }
          : undefined;
        const forkResult = await forkEngineSession(source.engine, source.engineSessionId, JINN_HOME, { interactive, codex });

        // 3. Store the new engine session ID
        recordEngineSessionId(newSession.id, newSession.engine, forkResult.engineSessionId, {
          model: newSession.model ?? undefined,
          effortLevel: newSession.effortLevel ?? undefined,
        });

        const result = getSession(newSession.id)!;
        logger.info(`Session duplicated: ${params.id} → ${newSession.id} (engine: ${forkResult.engineSessionId}, ${messageCount} messages)`);
        context.emit("session:created", { sessionId: newSession.id });
        return json(res, serializeSessionResponse(result, context));
      } catch (err: any) {
        // Clean up orphaned session if the engine fork failed after DB insert
        if (newSessionId) {
          try { deleteSession(newSessionId); } catch { /* best effort */ }
        }
        logger.error(`Failed to duplicate session ${params.id}: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Duplicate failed: ${err.message}` }));
        return;
      }
    }

    // DELETE /api/sessions/:id/queue/:itemId — cancel specific item
    const queueItemParams = matchRoute("/api/sessions/:id/queue/:itemId", pathname);
    if (method === "DELETE" && queueItemParams) {
      const session = getSession(queueItemParams.id);
      if (!session) return notFound(res);
      const cancelled = cancelQueueItem(queueItemParams.itemId);
      if (!cancelled) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Item not found or already running" }));
        return;
      }
      context.emit("queue:updated", { sessionId: queueItemParams.id, sessionKey: session.sessionKey });
      return json(res, { status: "cancelled", itemId: queueItemParams.itemId });
    }

    // GET /api/sessions/:id/queue
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const items = getQueueItems(session.sessionKey || session.sourceRef || session.id);
      return json(res, items);
    }

    // DELETE /api/sessions/:id/queue — clear all pending
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      // Cancel only operator-visible rows. SessionQueue checks each durable row
      // before execution, so no coarse in-memory cancellation is needed here;
      // setting one would also discard protected internal callback rows.
      const cancelled = cancelAllPendingQueueItems(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
      return json(res, { status: "cleared", cancelled });
    }

    // POST /api/sessions/:id/queue/pause
    params = matchRoute("/api/sessions/:id/queue/pause", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().pauseQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
      return json(res, { status: "paused", sessionId: params.id });
    }

    // POST /api/sessions/:id/queue/resume
    params = matchRoute("/api/sessions/:id/queue/resume", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().resumeQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
      return json(res, { status: "resumed", sessionId: params.id });
    }

    // POST /api/sessions/bulk-delete
    if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const ids: string[] = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, "ids array is required");

      const sessions = ids.flatMap((id) => {
        const session = getSession(id);
        return session ? [session] : [];
      });
      const preserved = sessions.filter((session) => session.workItemId);
      const deletable = sessions.filter((session) => !session.workItemId);

      for (const session of preserved) {
        preserveLinkedAttempt(context, session, "Interrupted: bulk deletion refused for linked execution attempt");
      }
      // Tear down any live/warm engine processes before deleting. kill() is safe
      // to call unconditionally — it's a no-op when nothing is running.
      for (const session of deletable) {
        killSessionEngines(context, session, "Interrupted: session deleted");
        context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      }

      for (const session of deletable) {
        maybeEmitTalkGraph(session.id, "removed", { getSession, emit: context.emit });
      }
      const deletableIds = deletable.map((session) => session.id);
      const count = deleteSessions(deletableIds);
      for (const id of deletableIds) {
        // Remove any per-session Codex CODEX_HOME overlay for each deleted id
        // (session-scoped capability on disk). No-op for non-codex sessions.
        removeCodexSessionHome(id);
        context.emit("session:deleted", { sessionId: id });
      }
      logger.info(`Bulk deleted ${count} sessions`);
      return json(res, {
        status: "deleted",
        count,
        preserved: preserved.map((session) => ({ sessionId: session.id, workItemId: session.workItemId })),
      });
    }

    // GET /api/sessions/:id/children
    params = matchRoute("/api/sessions/:id/children", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      const children = listChildSessions(params.id);
      return json(res, serializeSessionList(children, context));
    }

    // GET /api/sessions/:id/context?message=<id>&radius=<n> — GRS-020a: the
    // bounded ±radius window around a message anchor (a search hit), so a hit
    // becomes readable in place without a full-transcript read. Content is
    // capped store-side (MESSAGE_CONTEXT_CHAR_CAP + intentional-cap marker);
    // the session field is the COMPACT summary (GRS-020a-fix finding 5).
    params = matchRoute("/api/sessions/:id/context", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const messageId = readCleanSearchParam(url, "message");
      if (!messageId) return badRequest(res, "message (the anchor message id, from a search hit) is required");
      const radius = Math.max(
        1,
        Math.min(parseInt(url.searchParams.get("radius") || "3", 10) || 3, MESSAGE_CONTEXT_MAX_RADIUS),
      );
      const context_ = getMessageContext(params.id, messageId, radius);
      if (!context_) {
        return json(res, { error: `message "${messageId}" not found in session "${params.id}" — anchors come from message-search results` }, 404);
      }
      return json(res, {
        session: compactSessionSummary(session),
        anchorMessageId: context_.anchorMessageId,
        messages: context_.messages,
      });
    }

    // GET /api/work-items — compact Todo list for MCP/web surfaces.
    if (method === "GET" && pathname === "/api/work-items") {
      const parsedQuery = readWorkItemQueryParams(url);
      if (!parsedQuery.ok) return badRequest(res, parsedQuery.error);
      const { filter, limit, offset } = parsedQuery.value;
      const needsAttentionFor = readCleanSearchParam(url, "needsAttentionFor");
      if (needsAttentionFor) {
        const target = resolveNeedsAttentionTarget(req, res, needsAttentionFor, context);
        if (!target) return;
        filter.needsAttentionFor = target;
      }
      return json(res, workItemPagePayload(queryWorkItems({ ...filter, limit, offset })));
    }

    // POST /api/work-items — GRS-021c create. Tool callers must carry identity;
    // create structurally cannot attach approvals (anti-bottleneck LAW).
    if (method === "POST" && pathname === "/api/work-items") {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached at Todo creation — approvals are requested/decided through the approval authority surface`);
      }
      if (body.provenance !== undefined) {
        return badRequest(res, "provenance cannot be supplied on public Todo creation — the server assigns source provenance: public creation uses source=human or source=session, while cron and delegation create their own records; source=workflow is historical audit provenance and is not currently minted");
      }
      const title = typeof body.title === "string" ? stripControlChars(body.title).trim() : "";
      if (!title) return badRequest(res, "title is required");
      const verifyPolicy = validateVerifyPolicy(body.verifyPolicy);
      if (!verifyPolicy.ok) return badRequest(res, verifyPolicy.error);
      const parentId = typeof body.parentId === 'string' && body.parentId.trim() ? body.parentId.trim() : null;
      let dueAt = typeof body.dueAt === 'string' && body.dueAt.trim() ? body.dueAt.trim() : null;
      if (dueAt !== null) {
        if (!ISO_DATE_OR_INSTANT.test(dueAt) || Number.isNaN(Date.parse(dueAt))) {
          return badRequest(res, 'dueAt must be an ISO 8601 timestamp');
        }
        dueAt = new Date(dueAt).toISOString();
      }
      let priority: number | undefined;
      if (body.priority !== undefined) {
        if (typeof body.priority !== 'number' || !Number.isInteger(body.priority) || body.priority < 0 || body.priority > 3) {
          return badRequest(res, 'priority must be an integer 0..3');
        }
        priority = body.priority;
      }
      const source: WorkItemSource = caller.kind === "session" ? "session" : "human";
      const input: CreateWorkItemInput = {
        title: title.slice(0, 200),
        body: typeof body.body === "string" ? body.body : null,
        acceptance: typeof body.acceptance === "string" ? body.acceptance : null,
        assignee: typeof body.assignee === "string" && body.assignee.trim() ? body.assignee.trim() : null,
        // The department key is included only when the request carries one, so a
        // sub-task with no department inherits the parent's at the store layer.
        ...(body.department !== undefined
          ? { department: typeof body.department === "string" && body.department.trim() ? body.department.trim() : null }
          : {}),
        source,
        sourceRef: source === "session" && caller.kind === "session" ? `session:${caller.callerId}:${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}` : null,
        verifyPolicy: verifyPolicy.value,
        parentId,
        dueAt,
        ...(priority !== undefined ? { priority } : {}),
        // Slice-5 decision 7: a session with a resolved employee creates AS
        // that employee (the comments identity model); `session:<uuid>` remains
        // only for employee-less raw sessions.
        createdBy: workItemCommentAuthor(caller).author,
      };
      try {
        const item = createWorkItem(input);
        const activityReceiptId = persistTodoMutationActivity(req, context, item, "created");
        return json(res, withActivityReceipt({ workItem: item }, activityReceiptId), 201);
      } catch (err) {
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    // GET /api/work-items/:id — full Todo detail.
    params = matchRoute("/api/work-items/:id", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      return json(res, fullWorkItemPayload(item));
    }

    // PATCH /api/work-items/:id — the metadata pen. Authority is per-field
    // (Todos v2 slice 4, spec §3.4): body/acceptance/priority/dueAt for the
    // operator, the item creator, the assignee, or the assignee's manager;
    // title for operator/creator only; assignee/department/rank stay
    // operator-only. Status is intentionally excluded: lifecycle changes
    // remain behind the guarded transition/archive/approval surfaces below.
    params = matchRoute("/api/work-items/:id", pathname);
    if (method === "PATCH" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const invalidJsonResponse = { error: "Todo edit request must be valid JSON.", code: "todo_invalid_patch" } as const;
      const tooLargeResponse = { error: "Todo edit request exceeds the 64 KiB limit.", code: "todo_edit_too_large" } as const;
      const contentLength = todoEditContentLength(req.headers["content-length"]);
      if (contentLength === null) return json(res, invalidJsonResponse, 400);
      if (contentLength !== undefined && contentLength > TODO_EDIT_BODY_MAX_BYTES) {
        return json(res, tooLargeResponse, 413);
      }
      if (!hasSupportedTodoEditContentEncoding(req.headers["content-encoding"])) {
        return json(res, invalidJsonResponse, 400);
      }
      if (!isJsonMediaType(req.headers["content-type"])) {
        return json(res, invalidJsonResponse, 400);
      }
      const parsed = await readJsonBody(req, res, {
        invalidJsonResponse,
        maxBytes: TODO_EDIT_BODY_MAX_BYTES,
        rejectDuplicateTopLevelKeys: true,
        tooLargeResponse,
      });
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return todoEditValidationError(res, "Todo edit request must be a JSON object.");
      }
      const body = parsed.body as Record<string, unknown>;
      const precondition = readTodoEditPrecondition(req, body);
      if (!precondition.ok) return json(res, precondition.body, precondition.status);
      if (Object.prototype.hasOwnProperty.call(body, "status")) {
        return todoEditValidationError(res, "Todo status must use the guarded status transition surface.");
      }
      const metadataFields = ["title", "body", "assignee", "department", "priority", "rank", "acceptance", "dueAt", "verifyPolicy"] as const;
      const allowed = new Set([...metadataFields, "expectedVersion", "idempotencyKey"]);
      const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
      if (unsupported.length > 0) {
        return todoEditValidationError(res, "Todo edit request contains unsupported fields.");
      }
      if (!metadataFields.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
        return todoEditValidationError(res, "Todo edit request must contain at least one editable field.");
      }

      let idempotencyKey: string | undefined;
      if (Object.prototype.hasOwnProperty.call(body, "idempotencyKey")) {
        if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()) {
          return todoEditValidationError(res, "Todo edit idempotency key must be a non-empty string.");
        }
        idempotencyKey = body.idempotencyKey.trim();
        if (idempotencyKey.length > 256) return todoEditValidationError(res, "Todo edit idempotency key is too long.");
        if (/[\x00-\x1f\x7f]/.test(idempotencyKey)) return todoEditValidationError(res, "Todo edit idempotency key contains invalid characters.");
      }

      const patch: UpdateWorkItemInput = {};
      if (Object.prototype.hasOwnProperty.call(body, "title")) {
        if (typeof body.title !== "string") return todoEditValidationError(res, "title must be a string");
        const title = stripControlChars(body.title).trim();
        if (!title) return todoEditValidationError(res, "title must not be empty");
        if (title.length > 200) return todoEditValidationError(res, "title must be at most 200 characters");
        patch.title = title;
      }
      if (Object.prototype.hasOwnProperty.call(body, "body")) {
        if (body.body !== null && typeof body.body !== "string") return todoEditValidationError(res, "body must be a string or null");
        patch.body = body.body as string | null;
      }
      if (Object.prototype.hasOwnProperty.call(body, "assignee")) {
        if (body.assignee !== null && typeof body.assignee !== "string") return todoEditValidationError(res, "assignee must be a non-empty string or null");
        if (typeof body.assignee === "string") {
          const assignee = body.assignee.trim();
          if (!assignee) return todoEditValidationError(res, "assignee must be a non-empty string or null");
          if (!scanOrg().has(assignee)) {
            return todoEditValidationError(res, "Unknown employee for Todo assignee. Check the organization directory.", "todo_invalid_assignee");
          }
          patch.assignee = assignee;
        } else {
          patch.assignee = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, "department")) {
        if (body.department !== null && typeof body.department !== "string") return todoEditValidationError(res, "department must be a non-empty string or null");
        if (typeof body.department === "string") {
          const department = body.department.trim();
          if (!department) return todoEditValidationError(res, "department must be a non-empty string or null");
          patch.department = department;
        } else {
          patch.department = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, "priority")) {
        if (typeof body.priority !== "number" || !Number.isInteger(body.priority) || body.priority < 0 || body.priority > 3) {
          return todoEditValidationError(res, "priority must be an integer from 0 through 3");
        }
        patch.priority = body.priority;
      }
      if (Object.prototype.hasOwnProperty.call(body, "rank")) {
        if (body.rank !== null && (typeof body.rank !== "number" || !Number.isFinite(body.rank))) {
          return todoEditValidationError(res, "rank must be a finite number or null");
        }
        patch.rank = body.rank as number | null;
      }
      if (Object.prototype.hasOwnProperty.call(body, "acceptance")) {
        if (body.acceptance !== null && typeof body.acceptance !== "string") {
          return todoEditValidationError(res, "acceptance must be a string or null");
        }
        patch.acceptance = body.acceptance as string | null;
      }
      if (Object.prototype.hasOwnProperty.call(body, "dueAt")) {
        if (body.dueAt !== null && typeof body.dueAt !== "string") {
          return todoEditValidationError(res, "dueAt must be an ISO 8601 timestamp or null");
        }
        if (typeof body.dueAt === "string") {
          const dueAt = body.dueAt.trim();
          if (!ISO_DATE_OR_INSTANT.test(dueAt) || Number.isNaN(Date.parse(dueAt))) {
            return todoEditValidationError(res, "dueAt must be an ISO 8601 timestamp or null");
          }
          patch.dueAt = new Date(dueAt).toISOString(); // normalized like the create route
        } else {
          patch.dueAt = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, "verifyPolicy")) {
        const verifyPolicy = validateVerifyPolicy(body.verifyPolicy);
        if (!verifyPolicy.ok) return todoEditValidationError(res, verifyPolicy.error);
        patch.verifyPolicy = verifyPolicy.value;
      }

      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authority = resolveTodoEditAuthority(caller, item);
      if (!authority.ok) return json(res, { error: authority.error }, 403);
      const patchedFields = (Object.keys(patch) as Array<keyof UpdateWorkItemInput>);
      for (const field of patchedFields) {
        if (!authority.fields.has(field)) {
          return json(res, {
            error: `field "${field}" is not editable by ${authority.who}: title belongs to the Todo's creator or the operator; assignee, department, and rank are operator-only`,
          }, 403);
        }
      }

      try {
        const result = updateWorkItemConditional(params.id, patch, {
          expectedVersion: precondition.expectedVersion,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          actor: authority.actor,
        });
        if (!result) return notFound(res);
        const activityReceiptId = persistTodoMutationActivity(req, context, result.item, "metadata-updated", !result.replayed);
        return json(res, withActivityReceipt({ workItem: result.item, replayed: result.replayed }, activityReceiptId));
      } catch (err) {
        if (err instanceof WorkItemVersionConflictError) {
          return json(res, {
            error: "Todo changed since it was loaded.",
            code: "todo_version_conflict",
            currentVersion: err.currentVersion,
          }, 409);
        }
        if (err instanceof WorkItemIdempotencyConflictError) {
          return json(res, {
            error: "This Todo edit key was already used for a different request.",
            code: "todo_idempotency_conflict",
            currentVersion: err.currentVersion,
          }, 409);
        }
        throw err;
      }
    }

    // POST|PUT /api/work-items/:id/status — GRS-021c guarded status update.
    // POST serves capability-scoped agent/MCP updates; PUT is the authenticated
    // operator surface. Both use the same manual-transition legality checks.
    params = matchRoute("/api/work-items/:id/status", pathname);
    if ((method === "POST" || method === "PUT") && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (method === "PUT" && caller.kind !== "operator") {
        return json(res, { error: "manual Todo status PUT requires the authenticated operator surface" }, 403);
      }
      if (!requireTodoRouteId(res, params.id)) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached through Todo status updates — approvals are requested/decided through the approval authority surface`);
      }
      const target = typeof body.status === "string" ? body.status : "";
      // The operator PUT lane IS the human surface (Todos v2 slice 6): it may
      // walk every declared edge — reopening closed work, unblocking, routing
      // escalated items — so it carries human authority into transition() and
      // is not confined to the agent target allowlist. Cancellation keeps its
      // dedicated archive path below.
      const isOperatorPut = method === "PUT" && caller.kind === "operator";
      const isOperatorPutCancellation = isOperatorPut && target === "cancelled";
      if (target === "cancelled" && !isOperatorPutCancellation) {
        return json(res, { error: "cancelling a Todo is a human surface decision; agents do not have a cancel tool" }, 403);
      }
      if (isOperatorPut && !(WORK_ITEM_STATUSES as readonly string[]).includes(target)) {
        return badRequest(res, `status must be one of ${WORK_ITEM_STATUSES.join(", ")}`);
      }
      if (!isOperatorPut && !(AGENT_WORK_ITEM_TARGETS as readonly string[]).includes(target)) {
        return badRequest(res, `status must be one of ${AGENT_WORK_ITEM_TARGETS.join(", ")} for agent updates; other lifecycle edits use the human surface`);
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";
      // Agents must say WHY up front; the operator surface asks for the reason
      // in the opened item's banner instead (design-doc §5) — never a modal.
      if ((target === "blocked" || target === "escalated") && !note && !isOperatorPut) {
        return badRequest(res, `note is required when moving a Todo to ${target}`);
      }
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authorized = authorizeAgentWorkItemStatus(caller, item, target as WorkItemStatus);
      if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      // The banner's asked-for-after reason (design-doc §5): a same-status
      // operator PUT with a note annotates the CURRENT exception state instead
      // of vanishing in transition()'s same-status no-op. The note event
      // carries toStatus so the reason surfaces read it like a transition note.
      if (isOperatorPut && note && target === item.status && (target === "blocked" || target === "escalated")) {
        appendWorkItemEvent({
          workItemId: params.id,
          kind: "note",
          toStatus: target as WorkItemStatus,
          actor: workItemActor(caller),
          detail: { note },
          versionEffect: "state",
        });
        const annotated = getWorkItem(params.id)!;
        const activityReceiptId = persistTodoMutationActivity(req, context, annotated, "status-transitioned", true);
        return json(res, withActivityReceipt({ workItem: annotated, escalated: false }, activityReceiptId));
      }
      try {
        const result = isOperatorPutCancellation
          ? {
              // The operator PUT lane is the human surface: the archive lane
              // carries the same human authority as every other sticky exit,
              // so escalated → cancelled (a declared edge) is reachable here.
              item: archiveWorkItem(params.id, workItemActor(caller), { human: true, ...(note ? { note } : {}) }),
              escalated: false,
            }
          : transition(params.id, target as WorkItemStatus, workItemActor(caller), {
              manual: true,
              human: isOperatorPut || undefined,
              callerSessionId: caller.kind === "session" ? caller.callerId : undefined,
              detail: note ? { note } : undefined,
            });
        const activityReceiptId = persistTodoMutationActivity(
          req,
          context,
          result.item,
          "status-transitioned",
          result.item.version !== item.version,
        );
        return json(res, withActivityReceipt({ workItem: result.item, escalated: result.escalated }, activityReceiptId));
      } catch (err) {
        if (err instanceof TransitionError) {
          if (err.code === "not-found") return notFound(res);
          const human = err.code === "self-review-banned"
            ? `${err.message} — use the human review surface / a reviewer session to mark done`
            : `${err.message} — use the human surface for this transition if it is intentional`;
          const statusCode = err.code === "illegal-edge" ? 400 : 403;
          return json(res, { error: human }, statusCode);
        }
        throw err;
      }
    }

    // POST /api/work-items/:id/assign — roster-validated collaborative write.
    params = matchRoute("/api/work-items/:id/assign", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached through Todo assignment — approvals are requested/decided through the approval authority surface`);
      }
      const assignee = typeof body.assignee === "string"
        ? (body.assignee as string).trim()
        : "";
      if (!assignee) return badRequest(res, "assignee is required");
      const { scanOrg } = await import("./org.js");
      const roster = scanOrg();
      const employee = roster.get(assignee);
      if (!employee) {
        const near = nearestEmployee(assignee, [...roster.keys()]);
        return badRequest(
          res,
          `unknown employee "${assignee}"${near ? `. Did you mean "${near}"?` : ""} Check find_employees or GET /api/org for valid employees`,
        );
      }
      const current = getWorkItem(params.id);
      if (!current) return notFound(res);
      if (STICKY_STATUSES.has(current.status)) {
        return json(res, { error: `cannot assign Todo ${current.id} while it is in terminal state ${current.status}` }, 409);
      }
      const explicitSelfClaim =
        caller.kind === "session" &&
        current.status === "backlog" &&
        current.assignee === null &&
        caller.session.employee === assignee;
      if (!explicitSelfClaim) {
        const authorized = authorizeWorkItemOwnerManagerOrRoot(caller, current, "assign");
        if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      }
      try {
        const item = assignWorkItem(params.id, assignee, employee.department ?? null, workItemActor(caller));
        if (!item) return notFound(res);
        const activityReceiptId = persistTodoMutationActivity(req, context, item, "assigned", item.version !== current.version);
        return json(res, withActivityReceipt({ workItem: item }, activityReceiptId));
      } catch (err) {
        if (err instanceof TransitionError) {
          const statusCode = err.code === "conflict" ? 409 : 400;
          return json(res, { error: err.message }, statusCode);
        }
        throw err;
      }
    }

    // POST /api/work-items/:id/archive — non-deleting Todo archive. This preserves
    // the work_items row and event log, using the existing closed `cancelled`
    // terminal internally while presenting the action as archive on tool surfaces.
    params = matchRoute("/api/work-items/:id/archive", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return;
      if (parsed.body !== undefined && (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body))) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = (parsed.body ?? {}) as Record<string, unknown>;
      const approvalKeys = findApprovalKeysDeep(body);
      if (approvalKeys.length > 0) {
        return badRequest(res, `approval fields (${approvalKeys.join(", ")}) cannot be attached through Todo archive — approvals are requested/decided through the approval authority surface`);
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";
      const cascade = body.cascade === true;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authorized = authorizeWorkItemOwnerManagerOrRoot(caller, item, "archive");
      if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      try {
        const archived = archiveWorkItem(params.id, workItemActor(caller), {
          ...(caller.kind === "operator" ? { human: true, ...(cascade ? { cascade: true } : {}) } : {}),
          ...(caller.kind === "session" ? { callerSessionId: caller.callerId } : {}),
          ...(note ? { note } : {}),
        });
        const activityReceiptId = persistTodoMutationActivity(req, context, archived, "archived");
        return json(res, withActivityReceipt({ workItem: archived, archived: true }, activityReceiptId));
      } catch (err) {
        if (err instanceof TransitionError) {
          if (err.code === "not-found") return notFound(res);
          const statusCode = err.code === "illegal-edge" ? 400 : 403;
          return json(res, { error: `${err.message} — archive preserves the Todo; use another lifecycle action first if needed` }, statusCode);
        }
        throw err;
      }
    }

    // GET /api/work-items/:id/sessions — execution attempts linked to a work item.
    // The read-back half of the GRS-002 work-item slice (cron mints+links an item).
    params = matchRoute("/api/work-items/:id/sessions", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      const linked = listSessionsByWorkItem(params.id);
      return json(res, serializeSessionList(linked, context));
    }

    // GET /api/work-items/:id/tree — subtree with status totals + derived spend.
    params = matchRoute("/api/work-items/:id/tree", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      const tree = getWorkItemTree(params.id);
      if (!tree) return notFound(res);
      return json(res, { tree });
    }

    // GET /api/work-items/:id/comments — chronological thread page (any caller).
    params = matchRoute("/api/work-items/:id/comments", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      if (!getWorkItem(params.id)) return notFound(res);
      let limit = COMMENT_PAGE_DEFAULT_LIMIT;
      let offset = 0;
      for (const name of ["limit", "offset"] as const) {
        const raw = url.searchParams.get(name);
        if (raw === null) continue;
        if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw.trim()))) {
          return badRequest(res, `${name} must be a non-negative integer`);
        }
        const value = Number(raw.trim());
        if (name === "limit") limit = Math.min(Math.max(value, 1), COMMENT_PAGE_MAX_LIMIT);
        else offset = value;
      }
      const page = listComments(params.id, { limit, offset });
      return json(res, { ...page, limit, offset });
    }

    // POST /api/work-items/:id/comments — add a comment (single-level threading).
    // Author identity is stamped server-side from the caller; the body cannot
    // carry author fields, and the whole request is byte-capped like Todo edits.
    params = matchRoute("/api/work-items/:id/comments", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const tooLargeResponse = { error: "Comment request exceeds the 64 KiB limit.", code: "comment_too_large" } as const;
      const contentLength = todoEditContentLength(req.headers["content-length"]);
      if (contentLength === null) return badRequest(res, "request body must be valid JSON");
      if (contentLength !== undefined && contentLength > TODO_EDIT_BODY_MAX_BYTES) {
        return json(res, tooLargeResponse, 413);
      }
      const parsed = await readJsonBody(req, res, { maxBytes: TODO_EDIT_BODY_MAX_BYTES, tooLargeResponse });
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      if (body.author !== undefined || body.authorKind !== undefined) {
        return badRequest(res, "author fields cannot be supplied — comment identity is stamped from the authenticated caller");
      }
      const text = typeof body.body === "string" ? body.body : "";
      if (!text.trim()) return badRequest(res, "body is required and must be a non-empty string");
      let parentCommentId: string | null = null;
      if (body.parentCommentId !== undefined && body.parentCommentId !== null) {
        if (typeof body.parentCommentId !== "string" || !/^wic_[0-9a-f]{12}$/.test(body.parentCommentId)) {
          return badRequest(res, "parentCommentId must be a comment ID such as wic_0a1b2c3d4e5f");
        }
        parentCommentId = body.parentCommentId;
      }
      if (!getWorkItem(params.id)) return notFound(res);
      try {
        const comment = addComment({
          workItemId: params.id,
          body: text,
          ...workItemCommentAuthor(caller),
          parentCommentId,
        });
        emitTodoProjectionEvent(context, params.id, "commented");
        return json(res, { comment }, 201);
      } catch (err) {
        return workItemCommentFailure(res, err);
      }
    }

    // PATCH /api/work-items/:id/comments/:cid — edit own comment (author or operator).
    params = matchRoute("/api/work-items/:id/comments/:cid", pathname);
    if (method === "PATCH" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const tooLargeResponse = { error: "Comment request exceeds the 64 KiB limit.", code: "comment_too_large" } as const;
      const parsed = await readJsonBody(req, res, { maxBytes: TODO_EDIT_BODY_MAX_BYTES, tooLargeResponse });
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const text = typeof body.body === "string" ? body.body : "";
      if (!text.trim()) return badRequest(res, "body is required and must be a non-empty string");
      // Resolve BEFORE mutating so a comment reached under the wrong Todo path
      // 404s without side effects.
      const existing = getComment(params.cid);
      if (!existing || existing.workItemId !== params.id) return notFound(res);
      try {
        const comment = editComment(params.cid, text, {
          ...workItemCommentAuthor(caller),
          operator: caller.kind === "operator",
        });
        emitTodoProjectionEvent(context, params.id, "comment-edited");
        return json(res, { comment });
      } catch (err) {
        return workItemCommentFailure(res, err);
      }
    }

    // DELETE /api/work-items/:id/comments/:cid — tombstone own comment (author or
    // operator): body cleared, row and thread shape retained.
    params = matchRoute("/api/work-items/:id/comments/:cid", pathname);
    if (method === "DELETE" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const existing = getComment(params.cid);
      if (!existing || existing.workItemId !== params.id) return notFound(res);
      try {
        const comment = tombstoneComment(params.cid, {
          ...workItemCommentAuthor(caller),
          operator: caller.kind === "operator",
        });
        emitTodoProjectionEvent(context, params.id, "comment-deleted");
        return json(res, { comment });
      } catch (err) {
        return workItemCommentFailure(res, err);
      }
    }

    // POST /api/work-items/:id/attachments — upload a file onto a Todo or one
    // of its live comments (any identified caller; comment targets are
    // author-or-operator). Accepts multipart form-data (field `file`, optional
    // `commentId`) — the shared upload machinery — OR JSON `{ path, commentId?,
    // filename? }` where the GATEWAY reads the local file (the MCP surface:
    // gateway and agents share a filesystem by architecture, decision 4).
    params = matchRoute("/api/work-items/:id/attachments", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      if (!getWorkItem(params.id)) return notFound(res);
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      let filename: string;
      let commentIdRaw: unknown;
      let stagedPath: string;
      if (contentType.includes("multipart/form-data")) {
        let uploadedFile: Awaited<ReturnType<typeof readMultipartFile>>;
        try {
          uploadedFile = await readMultipartFile(req, ATTACHMENT_MAX_BYTES);
        } catch (err) {
          if (err instanceof MultipartUploadError) {
            return json(res, { error: err.message, ...(err.status === 413 ? { code: "attachment_too_large" } : {}) }, err.status);
          }
          return badRequest(res, err instanceof Error ? err.message : String(err));
        }
        if (uploadedFile.truncated) {
          return json(res, { error: "attachment exceeds the 25 MB per-file limit", code: "attachment_too_large" }, 413);
        }
        if (!uploadedFile.filename || uploadedFile.buffer.length === 0) {
          return badRequest(res, "no file provided — send a multipart 'file' field with content");
        }
        filename = sanitizeUploadFilename(uploadedFile.filename);
        commentIdRaw = uploadedFile.fields.commentId || undefined;
        stagedPath = stageAttachmentBuffer(uploadedFile.buffer);
      } else {
        const tooLargeResponse = { error: "Attachment request exceeds the 64 KiB limit.", code: "attachment_request_too_large" } as const;
        const parsed = await readJsonBody(req, res, { maxBytes: TODO_EDIT_BODY_MAX_BYTES, tooLargeResponse });
        if (!parsed.ok) return;
        if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
          return badRequest(res, "request body must be a JSON object");
        }
        const body = parsed.body as Record<string, unknown>;
        if (typeof body.path !== "string" || !body.path.trim()) {
          return badRequest(res, "path is required — the local file to attach (or send multipart form-data)");
        }
        if (body.filename !== undefined && (typeof body.filename !== "string" || !body.filename.trim())) {
          return badRequest(res, "filename must be a non-empty string when provided");
        }
        // Review F1: the caller names an arbitrary local path, so the read is
        // gated by the standing file-read policy (assessFileRead) against the
        // canonical opened file, size-capped by fstat on the same descriptor,
        // and copied from that descriptor (symlink-swap-proof).
        const ingested = readLocalFileForIngestion(body.path.trim(), ATTACHMENT_MAX_BYTES);
        if (!ingested.ok) {
          return json(
            res,
            { error: ingested.error, ...(ingested.status === 413 ? { code: "attachment_too_large" } : {}) },
            ingested.status,
          );
        }
        filename = sanitizeUploadFilename(typeof body.filename === "string" ? body.filename : path.basename(ingested.realPath));
        commentIdRaw = body.commentId;
        // Copy (never move) the caller's file into staging.
        stagedPath = stageAttachmentBuffer(ingested.buffer);
      }
      let commentId: string | null = null;
      if (commentIdRaw !== undefined && commentIdRaw !== null && commentIdRaw !== "") {
        if (typeof commentIdRaw !== "string" || !/^wic_[0-9a-f]{12}$/.test(commentIdRaw)) {
          fs.rmSync(stagedPath, { force: true });
          return badRequest(res, "commentId must be a comment ID such as wic_0a1b2c3d4e5f");
        }
        commentId = commentIdRaw;
      }
      try {
        const attachment = addAttachment({
          workItemId: params.id,
          commentId,
          filename,
          mime: mimeFromFilename(filename),
          stagedPath,
          uploader: workItemAttachmentActor(caller),
        });
        emitTodoProjectionEvent(context, params.id, "attachment-added");
        return json(res, { attachment }, 201);
      } catch (err) {
        return workItemAttachmentFailure(res, err);
      }
    }

    // GET /api/work-items/:id/attachments — list rows (item-level and
    // per-comment) with ABSOLUTE storagePath: agents read the file directly
    // from disk; no content flows over this surface.
    params = matchRoute("/api/work-items/:id/attachments", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      if (!getWorkItem(params.id)) return notFound(res);
      return json(res, { attachments: listAttachments(params.id) });
    }

    // GET /api/work-items/:id/attachments/:aid — download. The stored bytes are
    // re-hashed before the response: a sha256 mismatch is data corruption and
    // fails loudly instead of serving tampered content (the integrity belt).
    params = matchRoute("/api/work-items/:id/attachments/:aid", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      const attachment = getAttachment(params.aid);
      if (!attachment || attachment.workItemId !== params.id) return notFound(res);
      let content: Buffer;
      try {
        content = fs.readFileSync(attachment.storagePath);
      } catch {
        logger.error(`Attachment ${attachment.id} content missing on disk: ${attachment.storagePath}`);
        return serverError(res, "attachment content is missing from storage");
      }
      const digest = crypto.createHash("sha256").update(content).digest("hex");
      if (digest !== attachment.sha256) {
        logger.error(
          `Attachment ${attachment.id} failed integrity verification: stored ${attachment.storagePath} hashes to ${digest}, row says ${attachment.sha256}`,
        );
        return serverError(res, "attachment content failed integrity verification — the stored file does not match its recorded hash");
      }
      res.writeHead(200, {
        "Content-Type": attachment.mime,
        "Content-Length": String(content.length),
        // The filename was sanitized at upload; strip quotes/control bytes anyway.
        "Content-Disposition": `attachment; filename="${attachment.filename.replace(/["\\\r\n]/g, "")}"`,
      });
      res.end(content);
      return;
    }

    // DELETE /api/work-items/:id/attachments/:aid — remove a row (uploader or
    // operator). The stored file survives while any other row shares its hash.
    params = matchRoute("/api/work-items/:id/attachments/:aid", pathname);
    if (method === "DELETE" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const attachment = getAttachment(params.aid);
      if (!attachment || attachment.workItemId !== params.id) return notFound(res);
      try {
        if (!removeAttachment(params.aid, workItemAttachmentActor(caller))) return notFound(res);
        emitTodoProjectionEvent(context, params.id, "attachment-removed");
        return json(res, { removed: true });
      } catch (err) {
        return workItemAttachmentFailure(res, err);
      }
    }

    // POST /api/work-items/:id/relations — link two Todos (any identified
    // caller; createdBy stamped server-side; blocks edges are cycle-checked).
    params = matchRoute("/api/work-items/:id/relations", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (!["blocks", "relates", "duplicates"].includes(kind)) {
        return badRequest(res, "kind must be one of blocks, relates, duplicates");
      }
      const dstId = typeof body.dstId === "string" ? body.dstId.trim() : "";
      if (!isTodoId(dstId)) {
        return badRequest(res, "dstId must be a canonical Todo ID such as ACM-42");
      }
      if (!getWorkItem(params.id)) return notFound(res);
      if (!getWorkItem(dstId)) return notFound(res);
      try {
        const relation = addRelation(params.id, dstId, kind as RelationKind, workItemActor(caller));
        emitTodoProjectionEvent(context, params.id, "relation-added");
        emitTodoProjectionEvent(context, dstId, "relation-added");
        return json(res, { relation }, 201);
      } catch (err) {
        // relation-cycle carries the offending path in its message → 400.
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    // DELETE /api/work-items/:id/relations — unlink (relation creator or the
    // operator). `relates` accepts either endpoint order.
    params = matchRoute("/api/work-items/:id/relations", pathname);
    if (method === "DELETE" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (!["blocks", "relates", "duplicates"].includes(kind)) {
        return badRequest(res, "kind must be one of blocks, relates, duplicates");
      }
      const dstId = typeof body.dstId === "string" ? body.dstId.trim() : "";
      if (!isTodoId(dstId)) {
        return badRequest(res, "dstId must be a canonical Todo ID such as ACM-42");
      }
      if (!getWorkItem(params.id)) return notFound(res);
      try {
        const removed = removeRelation(params.id, dstId, kind as RelationKind, {
          actor: workItemActor(caller),
          operator: caller.kind === "operator",
        });
        if (!removed) return notFound(res);
        emitTodoProjectionEvent(context, params.id, "relation-removed");
        emitTodoProjectionEvent(context, dstId, "relation-removed");
        return json(res, { removed: true });
      } catch (err) {
        if (err instanceof WorkItemRelationError && err.code === "relation-forbidden") {
          return json(res, { error: err.message }, 403);
        }
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    // PUT /api/work-items/:id/labels — replace the label set (operator, item
    // creator, or assignee — the pre-slice-4 subset of edit authority). Only
    // EXISTING labels are accepted; nothing is created implicitly.
    params = matchRoute("/api/work-items/:id/labels", pathname);
    if (method === "PUT" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const employee = caller.kind === "session" ? caller.session.employee ?? null : null;
      const allowed =
        caller.kind === "operator" ||
        item.createdBy === workItemActor(caller) ||
        (employee !== null && (item.assignee === employee || item.createdBy === employee));
      if (!allowed) {
        return json(res, { error: "replacing a Todo's labels requires the operator, the item creator, or the assignee" }, 403);
      }
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      if (!Array.isArray(body.labels) || body.labels.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 256)) {
        return badRequest(res, "labels must be an array of label ids or names (non-empty strings)");
      }
      if (body.labels.length > TODO_LABELS_MAX) {
        return badRequest(res, `labels accepts at most ${TODO_LABELS_MAX} entries per Todo (got ${body.labels.length})`);
      }
      try {
        const labels = setWorkItemLabels(params.id, (body.labels as string[]).map((entry) => entry.trim()), workItemActor(caller));
        emitTodoProjectionEvent(context, params.id, "labels-updated");
        return json(res, { labels });
      } catch (err) {
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    // GET /api/labels — the shared label registry (any caller; agents discover
    // valid labels here before label_work_item).
    if (method === "GET" && pathname === "/api/labels") {
      return json(res, { labels: listLabels() });
    }

    // GET /api/departments — the department registry (any caller): slug,
    // immutable ID prefix, and a live Todo count per department. Prefixes mint
    // lazily on first departmental create; there are no create/rename routes.
    if (method === "GET" && pathname === "/api/departments") {
      return json(res, { departments: listDepartmentsWithCounts(initDb()) });
    }

    // POST /api/labels — create a label (operator or a manager: an employee
    // with direct reports in the org hierarchy).
    if (method === "POST" && pathname === "/api/labels") {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (caller.kind !== "operator") {
        const employee = caller.session.employee;
        let manager = false;
        if (employee) {
          const { scanOrg } = await import("./org.js");
          const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
          const node = resolveOrgHierarchy(scanOrg()).nodes[employee];
          manager = (node?.directReports.length ?? 0) > 0;
        }
        if (!manager) {
          return json(res, { error: "creating labels requires the operator or a manager (an employee with direct reports)" }, 403);
        }
      }
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 256) {
        return badRequest(res, "name is required and must be a non-empty string");
      }
      if (body.color !== undefined && body.color !== null && typeof body.color !== "string") {
        return badRequest(res, "color must be a 6-digit hex string such as #22cc88");
      }
      if (body.department !== undefined && body.department !== null && (typeof body.department !== "string" || body.department.length > 256)) {
        return badRequest(res, "department must be a string");
      }
      try {
        const label = createLabel({
          name: body.name,
          color: (body.color as string | null | undefined) ?? null,
          department: (body.department as string | null | undefined) ?? null,
        });
        return json(res, { label }, 201);
      } catch (err) {
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    // POST /api/work-items/:id/approval/request — agent-legal request surface.
    // Persistence/default routing stays in requestApproval; this route only
    // validates identity, Todo ownership/execution authority, and explicit targets.
    params = matchRoute("/api/work-items/:id/approval/request", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      const request = typeof body.request === "string" ? body.request.trim() : "";
      if (!request) return badRequest(res, "request is required");
      if (body.target !== undefined && (typeof body.target !== "string" || !body.target.trim())) {
        return badRequest(res, "target must be a non-empty string when provided");
      }
      const target = typeof body.target === "string" ? body.target.trim() : undefined;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const linkedOwner = caller.kind === "session" && ownsWorkItem(caller.session, item, listSessionsByWorkItem(item.id));
      const authorized = linkedOwner
        ? { ok: true as const }
        : authorizeWorkItemOwnerManagerOrRoot(caller, item, "request approval on");
      if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      if (target) {
        const roster = scanOrg();
        const root = resolveRootApprovalTarget();
        if (!roster.has(target) && root?.name !== target) {
          return badRequest(res, `approval target "${target}" is not an org employee or the configured root approval target`);
        }
      }
      const updated = requestApproval(params.id, {
          request,
          ...(target ? { target } : {}),
          actor: workItemActor(caller),
        });
      const activityReceiptId = persistTodoMutationActivity(req, context, updated, "approval-requested", updated.version !== item.version);
      return json(res, withActivityReceipt({ workItem: updated }, activityReceiptId));
    }

    // POST /api/work-items/:id/approval — approval DECISION surface.
    // COO-default: routed manager or root/COO can decide through the same
    // identity/capability seam MCP uses; operator/aCEO HTTP can decide only after
    // explicit escalation persisted on the Todo.
    // {decision:"approve"|"reject", note?}. Native decisions apply the FIXED
    // consequence rules (approve+in_review → done; reject+in_review → bounce/escalate;
    // otherwise the decision is recorded, status untouched).
    params = matchRoute("/api/work-items/:id/approval", pathname);
    if (method === "POST" && params) {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const decision = (parsed.body as { decision?: unknown }).decision;
      if (decision !== "approve" && decision !== "reject") {
        return badRequest(res, 'decision must be "approve" or "reject"');
      }
      if (!requireTodoRouteId(res, params.id)) return;
      const noteRaw = (parsed.body as { note?: unknown }).note;
      const note = typeof noteRaw === "string" ? noteRaw : undefined;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authority = resolveApprovalDecisionAuthority(req.headers, item, {
        operatorCanActOnRootTarget: true,
        operatorAuthenticated: scopedOperatorAuthenticated(req, context),
      });
      if (!authority.ok) return json(res, { error: authority.error }, authority.status);

      const result = await decideWorkItemApproval(
        { id: params.id, decision, ...(note !== undefined ? { note } : {}), decidedBy: authority.authority.actor },
      );
      if (!result.ok) {
        switch (result.code) {
          case "not-found":
            return notFound(res);
          case "no-pending":
            return json(res, { error: result.message }, 409);
          default:
            return json(res, { error: result.message }, 400);
        }
      }
      const activityReceiptId = persistTodoMutationActivity(req, context, result.item, "approval-decided");
      return json(res, withActivityReceipt({
        workItem: result.item,
        escalated: result.escalated,
      }, activityReceiptId));
    }

    // POST /api/work-items/:id/approval/escalate — routed approval authority can
    // deliberately expose this pending approval to the operator/aCEO path.
    params = matchRoute("/api/work-items/:id/approval/escalate", pathname);
    if (method === "POST" && params) {
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authority = resolveApprovalDecisionAuthority(req.headers, item, {
        operatorCanActOnRootTarget: true,
        operatorAuthenticated: scopedOperatorAuthenticated(req, context),
      });
      if (!authority.ok) return json(res, { error: authority.error }, authority.status);
      const body = (parsed.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      try {
        const updated = escalateApproval(params.id, authority.authority.actor, reason);
        const activityReceiptId = persistTodoMutationActivity(
          req,
          context,
          updated,
          "approval-escalated",
          updated.version !== item.version,
        );
        return json(res, withActivityReceipt({ workItem: updated }, activityReceiptId));
      } catch (err) {
        if (err instanceof Error && /no pending approval/i.test(err.message)) {
          return json(res, { error: err.message }, 409);
        }
        throw err;
      }
    }

    // GET /api/sessions/:id/transcript — return raw Claude Code session transcript
    params = matchRoute("/api/sessions/:id/transcript", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const claudeSessionId = getEngineSessionRef(session, "claude").id;
      if (!claudeSessionId) return json(res, []);
      const entries = loadRawTranscript(claudeSessionId);
      return json(res, entries);
    }

    // POST /api/delegations — the delegation transaction (GRS-017d, design §4).
    // ONE atomic in-process handler: resolve or mint the work item (the durable
    // record of INTENT), spawn the delegate session, link the two, derive the
    // item's live status — all before responding. It lives HERE, where the store functions
    // live, because composing mint→spawn→link as three HTTP calls from a client
    // (the MCP tool) would re-create exactly the partial-failure windows
    // GRS-003b-2b spent a wave closing (crash after spawn, before link → orphan).
    //
    // MINT-BEFORE-SPAWN, LINK-BEFORE-DISPATCH (the cron bridge's proven
    // ordering, tightened per the 017d codex review): the work item (intent) is
    // minted first; the session ROW is created and LINKED before the engine
    // turn is dispatched. So a crash at any point leaves either a recoverable
    // `open` item with zero sessions, or a linked reconciler-derivable pair —
    // never a running-but-unlinked orphan. Status is `open` at mint, never
    // hardcoded `active`: reconcileWorkItem DERIVES the live status from the
    // linked session (the GRS-003a single-source-of-truth rule).
    //
    // Unlike the cron bridge (where the item is best-effort dogfood around a
    // job that must run regardless), here the work item IS the deliverable — a
    // delegation is "tracked work" by definition — so a mint failure aborts the
    // whole transaction with nothing spawned.
    if (method === "POST" && pathname === "/api/delegations") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;

      // Fail-closed tool identity (GRS-017 codex finding 2), same rule as spawn:
      // a delegation always acts on behalf of a session, so a tool call whose
      // identity got lost must never fall through to the operator path. Headers
      // only — the identity gate outranks body validation.
      const delegationCaller = resolveScopedWriteCallerIdentity(req, context);
      if (delegationCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }

      // Body shape guard (017d codex review finding 2): `null`, arrays, and
      // scalars are valid JSON but not a delegation — a structured 400, not a
      // property-access 500 TypeError.
      if (!_parsed.body || typeof _parsed.body !== "object" || Array.isArray(_parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      const callerRef = delegationCaller.kind === "session" ? delegationCaller.callerId : "operator";
      const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : undefined;
      if (body.idempotencyKey !== undefined && !idempotencyKey) {
        return badRequest(res, "idempotencyKey must be a non-empty string when provided");
      }
      if (idempotencyKey && idempotencyKey.length > 256) {
        return badRequest(res, "idempotencyKey must be at most 256 characters");
      }
      const idempotencyDigest = idempotencyKey
        ? crypto.createHash("sha256").update(`${callerRef}\0${idempotencyKey}`).digest("hex")
        : undefined;
      const idempotencySessionKey = idempotencyDigest
        ? `delegation-idempotency:${idempotencyDigest}`
        : undefined;

      // Parent resolution must outrank durable idempotency replay: a historical
      // Workflow run projection stays read-only even when the key already owns
      // an ordinary delegation receipt. Explicit body parent wins; otherwise
      // the authenticated caller is used best-effort (unknown → parentless).
      let parentSessionId: string | undefined =
        typeof body.parentSessionId === "string" ? (body.parentSessionId as string) : undefined;
      let delegatorSession = parentSessionId ? getSession(parentSessionId) : undefined;
      if (delegationCaller.kind === "session" && body.parentSessionId === undefined) {
        delegatorSession = getSession(delegationCaller.callerId);
        if (delegatorSession) {
          parentSessionId = delegationCaller.callerId;
        } else {
          logger.warn(`Ignoring unknown x-jinn-caller-session "${delegationCaller.callerId}" on delegation`);
        }
      }
      // A completed first call is the durable idempotency receipt. Resolve it
      // before re-validating the remaining mutable request context: the caller-
      // chosen key owns the result, and an ordinary retry returns the original
      // pair without effects.
      if (idempotencySessionKey) {
        const replay = getSessionBySessionKey(idempotencySessionKey);
        if (replay) {
          if (!replay.workItemId) {
            return json(res, { error: "delegation idempotency receipt exists without a linked Todo", sessionId: replay.id }, 409);
          }
          const replayItem = getWorkItem(replay.workItemId);
          return json(res, {
            workItemId: replay.workItemId,
            sessionId: replay.id,
            employee: replay.employee ?? null,
            engine: replay.engine,
            model: replay.model ?? null,
            effortLevel: replay.effortLevel ?? null,
            status: replay.status,
            title: replayItem?.title ?? replay.title ?? null,
            replayed: true,
          });
        }
      }

      // Validation — ALL of it before the mint, so a 400 never litters the
      // work-item table with garbage intent records.
      const task = typeof body.task === "string" && body.task.trim() ? (body.task as string) : undefined;
      if (!task) return badRequest(res, "task is required — the full brief for the delegate");
      const employeeName = typeof body.employee === "string" && body.employee.trim() ? (body.employee as string).trim() : undefined;
      const engineParam = typeof body.engine === "string" && body.engine.trim() ? (body.engine as string).trim() : undefined;
      if (!employeeName && !engineParam) {
        return badRequest(res, "employee or engine is required — delegate to a named employee (GET /api/org lists them) or to a bare engine");
      }
      let attachments: string[] | undefined;
      if (body.attachments !== undefined) {
        if (!Array.isArray(body.attachments) || body.attachments.length > 20) {
          return badRequest(res, "attachments must be an array of at most 20 managed file IDs");
        }
        if (body.attachments.some((entry: unknown) => typeof entry !== "string" || !entry.trim())) {
          return badRequest(res, "attachments must contain only non-empty managed file IDs");
        }
        const normalizedAttachments = body.attachments.map((entry: string) => entry.trim());
        attachments = normalizedAttachments;
        const unresolvedAttachments = findUnresolvedAttachmentIds(normalizedAttachments);
        if (unresolvedAttachments.length > 0) {
          return json(res, {
            error: "One or more managed attachments could not be resolved",
            unresolvedAttachments,
          }, 400);
        }
      }
      const config = context.getConfig();
      let orgRegistry: Map<string, Employee> | undefined;
      let delegateEmployee: Employee | undefined;
      if (employeeName) {
        orgRegistry = scanOrg();
        delegateEmployee = orgRegistry.get(employeeName);
        if (!delegateEmployee) {
          return badRequest(res, `unknown employee "${employeeName}" — GET /api/org lists valid employees`);
        }
      }
      const employeeDefaults = delegateEmployee
        ? {
            engine: delegateEmployee.engine,
            model: delegateEmployee.model,
            // GRS-017f: name the employee so an unregistered configured model
            // fails with an actionable, employee-named error, not a bare engine
            // string — the same clear signal spawn now surfaces.
            employee: employeeName,
            ...(delegateEmployee.effortLevel ? { effortLevel: delegateEmployee.effortLevel } : {}),
          }
        : undefined;
      const selection = validateNewSessionSelection(config, {
        engine: body.engine,
        model: body.model,
        effortLevel: body.effortLevel,
      }, employeeDefaults);
      if (!selection.ok) return badRequest(res, selection.error || "invalid engine/model/effort");
      const engineName = selection.engine || config.engines.default;

      const title = (
        typeof body.title === "string" && body.title.trim() ? (body.title as string).trim() : task.split("\n")[0].trim()
      ).slice(0, 200);

      const requestedWorkItemId = typeof body.workItemId === "string" && body.workItemId.trim()
        ? body.workItemId.trim()
        : undefined;
      if (body.workItemId !== undefined && !requestedWorkItemId) {
        return badRequest(res, "workItemId must be a non-empty string when provided");
      }

      // 1. RESOLVE/MINT — workItemId preserves the canonical Todo; otherwise
      //    mint as before. An idempotency key makes the minted sourceRef stable,
      //    so a retry after a pre-session failure reuses the same intent.
      let workItem: WorkItem;
      if (requestedWorkItemId) {
        const existingWorkItem = getWorkItem(requestedWorkItemId);
        if (!existingWorkItem) return json(res, { error: `Todo ${requestedWorkItemId} not found` }, 404);
        workItem = existingWorkItem;
        if (STICKY_STATUSES.has(workItem.status)) {
          return json(res, { error: `Todo ${requestedWorkItemId} is ${workItem.status} and cannot accept a new delegation` }, 409);
        }
        if (delegationCaller.kind === "session") {
          const callerSession = getSession(delegationCaller.callerId)!;
          const callerCreated = workItem.sourceRef?.startsWith(`session:${delegationCaller.callerId}:`)
            || workItem.sourceRef?.startsWith(`delegate:${delegationCaller.callerId}:`);
          const authorized = callerCreated
            ? { ok: true as const }
            : authorizeWorkItemOwnerManagerOrRoot(
                { kind: "session", callerId: delegationCaller.callerId, session: callerSession },
                workItem,
                "delegate",
              );
          if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
        }
        const liveAttempt = listSessionsByWorkItem(workItem.id).find((attempt) =>
          attempt.status === "running" || attempt.status === "waiting",
        );
        if (liveAttempt) {
          return json(res, {
            error: `Todo ${workItem.id} already has live execution session ${liveAttempt.id}`,
            workItemId: workItem.id,
            sessionId: liveAttempt.id,
          }, 409);
        }
      } else {
        try {
          workItem = createWorkItem({
            title,
            body: task,
            status: "backlog",
            source: "delegation",
            sourceRef: idempotencyDigest
              ? `delegate:${callerRef}:idempotency:${idempotencyDigest}`
              : `delegate:${callerRef}:${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
            assignee: employeeName ?? null,
            department: delegateEmployee?.department ?? null,
            // Slice-5 decision 7: the DELEGATING caller is the creator — the
            // operator, or the delegating session's resolved employee slug
            // (`session:<uuid>` only when that session carries no employee).
            createdBy: delegationCaller.kind === "session"
              ? getSession(delegationCaller.callerId)?.employee ?? `session:${delegationCaller.callerId}`
              : "operator",
          });
        } catch (mintErr) {
          logger.warn(`Delegation work-item mint failed: ${mintErr instanceof Error ? mintErr.message : mintErr}`);
          return json(res, { error: "delegation failed before any work started — the work item could not be minted; nothing was spawned" }, 500);
        }
      }

      // 2. SPAWN — the irreversible step. A failure here PRESERVES the minted
      //    `backlog` item (durable intent, recoverable) and reports its id.
      const engine = context.sessionManager.getEngine(engineName);
      if (!engine) {
        return json(res, {
          error: `engine "${engineName}" not available`,
          workItemId: workItem.id,
          hint: "the work item was minted before the spawn and is preserved as backlog — the delegation intent is durable, not lost",
        }, 502);
      }
      if (requestedWorkItemId && employeeName) {
        try {
          workItem = assignWorkItem(workItem.id, employeeName, delegateEmployee?.department ?? null, workItemActor(
            delegationCaller.kind === "session"
              ? { kind: "session", callerId: delegationCaller.callerId, session: getSession(delegationCaller.callerId)! }
              : { kind: "operator" },
          )) ?? workItem;
        } catch (assignmentErr) {
          return json(res, { error: assignmentErr instanceof Error ? assignmentErr.message : String(assignmentErr) }, 409);
        }
      }
      const sessionKey = idempotencySessionKey ?? `delegation:${workItem.id}`;
      let session: Session;
      try {
        session = createSession({
          engine: engineName,
          source: "web",
          sourceRef: sessionKey,
          connector: "web",
          sessionKey,
          replyContext: { source: "web" },
          employee: employeeName ?? null,
          parentSessionId,
          model: selection.model,
          effortLevel: selection.effortLevel,
          prompt: task,
          title,
          portalName: config.portal?.portalName,
          transportMeta: {
            [DELEGATION_COMPLETION_TRACKED_META_KEY]: true,
            ...(delegateEmployee?.displayName ? { delegationEmployeeDisplay: delegateEmployee.displayName } : {}),
          },
        });
      } catch (spawnErr) {
        const replay = idempotencySessionKey ? getSessionBySessionKey(idempotencySessionKey) : undefined;
        if (replay?.workItemId) {
          return json(res, {
            workItemId: replay.workItemId,
            sessionId: replay.id,
            employee: replay.employee ?? null,
            engine: replay.engine,
            model: replay.model ?? null,
            effortLevel: replay.effortLevel ?? null,
            status: replay.status,
            title: getWorkItem(replay.workItemId)?.title ?? replay.title ?? null,
            replayed: true,
          });
        }
        throw spawnErr;
      }
      rehomeAttachmentsToSession(attachments, session.id);
      const delegationMedia = fileIdsToMedia(attachments);
      insertMessage(session.id, "user", task, delegationMedia.length > 0 ? delegationMedia : undefined);

      // 3. LINK — BEFORE any dispatch step (017d codex review finding 1). The
      //    whole point of the in-process transaction is that the work item ↔
      //    session link is DURABLE before the worker can run: a crash from here
      //    on leaves a linked, reconciler-derivable pair, never a running-but-
      //    unlinked orphan next to a backlog item with zero sessions. The link is
      //    transactional and both rows were just created in-process, so a
      //    failure is a genuine anomaly — and because NOTHING has been
      //    dispatched yet, the honest response is to HALT: report both
      //    preserved ids (backlog item + idle, undispatched, re-linkable session)
      //    instead of dispatching an untracked turn.
      try {
        linkSession(workItem.id, session.id);
      } catch (linkErr) {
        logger.warn(`Delegation ${workItem.id} link failed before dispatch: ${linkErr instanceof Error ? linkErr.message : linkErr}`);
        return json(res, {
          error: "delegation halted before dispatch — linking the work item to the spawned session failed",
          workItemId: workItem.id,
          sessionId: session.id,
          hint: "nothing was dispatched: the backlog work item and the idle session row are both preserved and re-linkable",
        }, 500);
      }

      // 4. DERIVE + DISPATCH — mark the attempt running, let the reconciler
      //    derive the item's live status (`open`→`active`, the GRS-003a
      //    single-source-of-truth rule; best-effort — a derive hiccup never
      //    undoes a correctly linked delegation), then start the turn.
      updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
      session.status = "running";
      try {
        reconcileWorkItem(workItem.id);
      } catch (reconcileErr) {
        logger.warn(`Delegation ${workItem.id} reconcile failed: ${reconcileErr instanceof Error ? reconcileErr.message : reconcileErr}`);
      }
      if (parentSessionId && getSession(parentSessionId)) {
        const handoffEnvelope: ChatBlockEnvelope = {
          op: "put",
          block: {
            id: `dg-${workItem.id}`,
            type: "delegation",
            version: 1,
            status: "running",
            payload: {
              employee: employeeName ?? engineName,
              employeeDisplay: delegateEmployee?.displayName ?? employeeName ?? engineName,
              title,
              childSessionId: session.id,
              workItemId: workItem.id,
              dispatchedAt: Date.parse(session.createdAt) || Date.now(),
            },
          },
        };
        try {
          applyBlockEnvelope(parentSessionId, handoffEnvelope, title);
          context.emit("session:delta", {
            sessionId: parentSessionId,
            type: "block",
            content: title,
            block: handoffEnvelope,
          });
        } catch (blockErr) {
          logger.warn(`Delegation ${workItem.id} handoff block failed: ${blockErr instanceof Error ? blockErr.message : blockErr}`);
        }
      }
      logger.info(`Delegation ${workItem.id}: session ${session.id} linked + dispatching for ${employeeName ?? engineName}`);
      const delegationQueueKey = session.sessionKey || session.sourceRef || session.id;
      const delegationQueueItemId = enqueueQueueItem(session.id, delegationQueueKey, task);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: delegationQueueKey });
      const attachmentPaths = resolveAttachmentPaths(attachments);
      dispatchWebSessionRun(session, task, engine, config, context, {
        queueItemId: delegationQueueItemId,
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      });
      if (employeeName && orgRegistry) {
        surfaceManagerVisibility({
          roster: orgRegistry,
          employee: employeeName,
          delegatorSession,
          childSession: session,
          workItemId: workItem.id,
          title,
        });
      }
      maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });

      // The delegation card above is the atomic response's sole transcript row.
      // Publish the Todo cache invalidation through the shared boundary without
      // synthesizing a second Todo activity block for the same delegation.
      const delegatedItem = getWorkItem(workItem.id) ?? workItem;
      const eventSessionId = delegatorSession && isActivityProjectionEligibleSession(delegatorSession.id)
        ? delegatorSession.id
        : undefined;
      persistAndEmitActivityBlock({
        context: chatActivityContext(context),
        companyEvent: {
          entity: "todo",
          action: "delegated",
          id: delegatedItem.id,
          version: delegatedItem.version,
          value: delegatedItem as unknown as JsonObject,
          ...(eventSessionId ? { sessionId: eventSessionId } : {}),
        },
      });

      return json(res, {
        workItemId: workItem.id,
        sessionId: session.id,
        employee: employeeName ?? null,
        engine: engineName,
        model: selection.model ?? null,
        effortLevel: selection.effortLevel ?? null,
        status: session.status,
        title,
      }, 201);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = body.prompt || body.message;
      if (!prompt) return badRequest(res, "prompt or message is required");
      // GRS-017a identity seam: a spawn carrying x-jinn-caller-session (the jinn
      // MCP server run by another session) is auto-linked as that session's
      // child — the agent cannot forget the linkage and the child-completion
      // callback protocol works without it knowing the mechanic. An explicit
      // body.parentSessionId always wins (internal callers). Best-effort: an
      // unknown caller id is ignored with a warning, never a refusal.
      // A TOOL spawn that LOST its identity fails CLOSED (codex finding 2):
      // silently inheriting the operator's parentless spawn would orphan the
      // child and break the callback protocol without anyone noticing.
      const spawnCaller = resolveScopedWriteCallerIdentity(req, context);
      if (spawnCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      if (spawnCaller.kind === "session" && body.parentSessionId === undefined) {
        if (getSession(spawnCaller.callerId)) {
          body.parentSessionId = spawnCaller.callerId;
        } else {
          logger.warn(`Ignoring unknown x-jinn-caller-session "${spawnCaller.callerId}" on session spawn`);
        }
      }
      const parentSession = typeof body.parentSessionId === "string" ? getSession(body.parentSessionId) : undefined;
      const config = context.getConfig();
      const employeeName = coercePortalEmployee(body.employee, config.portal?.portalName);
      let employeeDefaults: { engine: string; model: string; effortLevel?: string; employee?: string } | undefined;
      if (employeeName) {
        const { scanOrg } = await import("./org.js");
        const emp = scanOrg().get(employeeName);
        // A transient org-registry/file-watcher miss must not silently turn an
        // employee spawn into a gateway-default session. Resolve the employee
        // first or fail closed, matching the delegation route.
        if (!emp) return badRequest(res, `unknown employee "${employeeName}" — GET /api/org lists valid employees`);
        // GRS-017f: carry the employee slug so an unregistered configured
        // model produces the same actionable, employee-named error the
        // delegation route surfaces (not a cryptic bare-engine string).
        employeeDefaults = { engine: emp.engine, model: emp.model, employee: employeeName };
        if (emp.effortLevel) employeeDefaults.effortLevel = emp.effortLevel;
      }
      const selection = validateNewSessionSelection(config, {
        engine: body.engine,
        model: body.model,
        effortLevel: body.effortLevel,
      }, employeeDefaults);
      if (!selection.ok) return badRequest(res, selection.error || "invalid engine/model/effort");
      const engineName = selection.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      // Opt-in SSO identity capture: when an auth proxy fronts the gateway and
      // `gateway.userHeader` is configured, persist the forwarded identity on the
      // session. Unset config → undefined → stored as NULL (single-user no-op).
      const userId = resolveUserHeader(req.headers, config.gateway.userHeader);
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        userId,
        // A session tagged with the portal name is a direct/COO session, not a
        // pseudo-employee (there is no org employee by the portal's name).
        // Coerce it to null so it buckets into the direct group rather than
        // spawning a phantom group that renders with the portal's own title.
        employee: employeeName,
        parentSessionId: body.parentSessionId,
        effortLevel: selection.effortLevel,
        // Honor body.model so API clients can pin per-employee models
        // (e.g. MCP servers that look up org/<employee>.yaml and pass the
        // employee's configured model). Without this, runWebSession falls
        // back to config.engines.claude.model, breaking per-employee routing.
        // Fixes #38.
        model: selection.model,
        prompt,
        // Optional excerpt override (talk delegation passes the operator's
        // verbatim ask so list UIs don't show the scaffolded prompt).
        promptExcerpt: typeof body.promptExcerpt === "string" ? body.promptExcerpt : undefined,
        portalName: config.portal?.portalName,
      });
      logger.info(`Web session created: ${session.id} (model=${selection.model || "default"})`);
      // Voice mode: when the hands-free orchestrator (source:"talk") spawns a COO
      // child, tell the Talk UI which channel to animate to. Auto-derived here so
      // the orchestrator persona carries zero focus-signalling burden.
      if (session.parentSessionId) {
        const talkParent = getSession(session.parentSessionId);
        if (talkParent?.source === "talk") {
          const label = String(body.employee || prompt || "task").replace(/\s+/g, " ").trim().slice(0, 48);
          context.emit("talk:focus", { cooId: session.id, label, parentId: talkParent.id });
        }
      }
      maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });
      // First-message attachments were uploaded before the session existed (FILES_DIR).
      // Re-home them under uploads/<date>/<sessionId>/ now that we have an id, then persist
      // the media on the user message so the bubble renders chips/thumbnails on reload.
      rehomeAttachmentsToSession(body.attachments, session.id);
      const newSessionMedia = fileIdsToMedia(body.attachments);
      insertMessage(session.id, "user", prompt, newSessionMedia.length > 0 ? newSessionMedia : undefined);

      // Run engine asynchronously — respond immediately, push result via WebSocket.
      // CLI-mode session creation uses the engine's PTY view when one exists
      // (Claude, Antigravity). Engines without a PTY view fall back to normal chat.
      const ptyEngine = body.mode === "interactive" ? context.ptyViewEngines?.[engineName] : undefined;
      const engine = ptyEngine ?? context.sessionManager.getEngine(engineName);
      if (!engine) {
        updateSession(session.id, {
          status: "error",
          lastError: `Engine "${engineName}" not available`,
        });
        return json(res, { ...serializeSessionResponse({ ...session, status: "error", lastError: `Engine "${engineName}" not available` }, context) }, 201);
      }

      // Set status to "running" synchronously BEFORE returning the response.
      // This prevents a race condition where the caller polls immediately and
      // sees "idle" status before runWebSession has a chance to set "running".
      updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
      session.status = "running";

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, queueSessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });

      // Speech-derived first messages carry a hidden context note to the engine
      // only; the persisted/queued `prompt` above stays the operator's exact text.
      // Interactive dispatch pastes the prompt into the visible PTY, so the note
      // is suppressed there (ptyEngine truthy) and only rides headless dispatch.
      const { engine: newSessionEnginePrompt } = resolveMessageAudiences(
        prompt,
        speechContextApplies({ speech: body.speech === true, isNotification: false, promptRendered: !!ptyEngine }),
      );
      dispatchWebSessionRun(session, newSessionEnginePrompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, serializeSessionResponse(session, context), 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      let session = getSession(params.id);
      if (!session) return notFound(res);
      session = maybeRevertEngineOverride(session);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // Child callbacks claim a durable outbox identity before entering this
      // route. The receipt is the source of truth; request payload fields are
      // ignored so an HTTP retry cannot mutate an already claimed delivery.
      const callbackDeliveryId = typeof body.callbackDeliveryId === "string"
        ? stripControlChars(body.callbackDeliveryId).trim()
        : "";
      const callbackDelivery = callbackDeliveryId ? getSessionDelivery(callbackDeliveryId) : undefined;
      if (callbackDeliveryId && !callbackDelivery) return notFound(res);
      if (callbackDelivery && callbackDelivery.targetSessionId !== session.id) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "callback parent mismatch" }));
        return;
      }
      if (callbackDelivery?.status === "accepted") {
        return json(res, {
          status: "duplicate",
          sessionId: session.id,
          callbackDeliveryId: callbackDelivery.id,
          messageId: callbackDelivery.messageId,
          queueItemId: callbackDelivery.queueItemId,
        });
      }
      if (callbackDelivery) {
        body.role = "notification";
        body.message = callbackDelivery.payload.message;
        body.displayMessage = callbackDelivery.payload.displayMessage;
        body.meta = callbackDelivery.payload.meta;
        body.block = callbackDelivery.payload.block;
      }

      // GRS-017a — agent-initiated (lateral / child follow-up) sends carry the
      // caller's session identity in x-jinn-caller-session (the jinn MCP server).
      // The substrate guards live HERE, route-side, so curl is equally guarded:
      // no self-messages, a per-sender rate cap, and a relay hop budget. A
      // guarded send is rewritten into a sender-tagged notification (wakes the
      // target; queues if mid-turn — the callbacks mechanic, generalized).
      // Internal parent callbacks (sessions/callbacks.ts) send no headers and
      // are untouched. A TOOL send that LOST its identity fails CLOSED (codex
      // finding 2): without a caller it would bypass every guard and land as an
      // unprefixed operator-grade user message.
      const msgCaller = resolveScopedWriteCallerIdentity(req, context);
      let parentFollowUp: { caller: Session; message: string } | undefined;
      if (msgCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      if (msgCaller.kind === "session") {
        const msgCallerId = msgCaller.callerId;
        const rawMessage = body.message || body.prompt;
        if (!rawMessage) return badRequest(res, "message is required");
        const caller = getSession(msgCallerId);
        if (!caller) {
          return badRequest(res, `unknown caller session "${msgCallerId}" — agent-initiated sends need a live caller session`);
        }
        const plan = prepareLateralSend({
          caller,
          targetSessionId: params.id,
          message: String(rawMessage),
          guards: sessionCommGuards,
        });
        if (!plan.ok) {
          res.writeHead(plan.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: plan.error }));
          return;
        }
        body.role = "notification";
        body.message = plan.prompt;
        body.displayMessage = plan.displayMessage;
        body.meta = plan.meta;
        if (session.parentSessionId === caller.id) {
          parentFollowUp = { caller, message: String(rawMessage) };
        } else if (caller.parentSessionId === session.id && caller.attemptToken) {
          // The child is reporting UP to its parent via send_to_session. The
          // automatic parent-completion callback fired at this child's settle
          // would be a SECOND injection of the same turn (the operator sees a
          // spurious "duplicate callback" wake). Mark the attempt so
          // notifyParentSession suppresses that redundant callback.
          recordChildReportedToParent(caller.id, caller.attemptToken);
        }
        // Conservative on later failure (e.g. engine unavailable): the hop tag
        // may be recorded for an undelivered message, which only ever tightens
        // the budget, never loosens it.
        sessionCommGuards.recordDelivery(params.id, plan.hops);
      } else if (
        msgCaller.kind === "operator" &&
        body.role === "notification" &&
        typeof body.from === "string" &&
        body.from.trim() &&
        (body.message || body.prompt)
      ) {
        // An operator-authenticated caller may post a LABELED inter-session relay
        // (e.g. a COO routing a message between sessions once the lateral hop
        // budget between them is spent). Without this it falls through as a bare
        // `user` message that masquerades as the operator typing. Stamp the same
        // 📨 relay framing + agent-relay meta a session-origin send_to_session
        // would, so it renders as a relay banner instead. Operator origin ⇒ a
        // fresh hop with no lateral cap; `fromSessionId` is optional (pass the
        // real source session to make the relay openable/linked).
        const fromLabel = stripControlChars(body.from).trim().slice(0, 160);
        const relayFromSessionId = typeof body.fromSessionId === "string" && body.fromSessionId.trim()
          ? stripControlChars(body.fromSessionId).trim().slice(0, 160)
          : undefined;
        const relayBody = String(body.message || body.prompt);
        body.message = relayFromSessionId
          ? `📨 Message relayed from session ${relayFromSessionId} (${fromLabel}) via the operator:\n\n${relayBody}\n\n` +
            `To reply: send_to_session { sessionId: "${relayFromSessionId}" }.`
          : `📨 Message relayed from ${fromLabel} via the operator:\n\n${relayBody}`;
        body.displayMessage = `📨 From ${fromLabel}: ${relayBody.slice(0, 200)}${relayBody.length > 200 ? "…" : ""}`;
        body.meta = {
          kind: "agent-relay",
          ...(relayFromSessionId ? { fromSessionId: relayFromSessionId } : {}),
          fromLabel,
          hops: 1,
          maxHops: sessionCommGuards.maxHops(),
          fullMessage: relayBody.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS),
        };
      } else if (body.role !== "notification") {
        // A genuine user/operator message resets the target's relay-hop chain —
        // an operator instruction is a fresh start, not hop N of a relay.
        sessionCommGuards.clearInboundHop(params.id);
        // It also starts a new delegation-completion cycle. Internal callbacks
        // and the contract's own system-style nudge intentionally retain the
        // persisted guard so a second idle settlement is surfaced, not looped.
        session = clearDelegationCompletionContract(session);
      }

      const prompt = body.message || body.prompt;
      if (!prompt) return badRequest(res, "message is required");

      // Voice mode: when the orchestrator CONTINUES an existing COO child (a
      // thread switch/reuse), re-signal focus so the Talk UI relights that
      // satellite + morphs the main orb to its channel — mirroring the
      // talk:focus emitted on new-session spawn in POST /api/sessions.
      if (session.parentSessionId) {
        const talkParent = getSession(session.parentSessionId);
        if (talkParent?.source === "talk") {
          context.emit("talk:focus", { cooId: session.id, label: session.title || "", parentId: talkParent.id });
        }
      }
      maybeEmitTalkGraph(session.id, "status", { getSession, emit: context.emit });

      // Allow internal callers (e.g. child session callbacks) to specify a non-user role
      const messageRole: string = body.role === "notification" ? "notification" : "user";
      const isNotification = messageRole === "notification";
      // Dual audience: the engine (e.g. the COO) runs on the full `prompt`, while the
      // web UI persists + shows a clean `displayMessage` banner. Falls back to `prompt`.
      const displayMessage: string =
        typeof body.displayMessage === "string" && body.displayMessage.trim()
          ? body.displayMessage
          : prompt;
      let notificationMeta: JsonObject | undefined;
      if (isNotification && body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
        const rawMeta = body.meta as Record<string, unknown>;
        const kind = rawMeta.kind === "child-reply" || rawMeta.kind === "child-error" ? rawMeta.kind : undefined;
        const employee = typeof rawMeta.employee === "string" ? stripControlChars(rawMeta.employee).trim().slice(0, 160) : "";
        const employeeDisplay = typeof rawMeta.employeeDisplay === "string" ? stripControlChars(rawMeta.employeeDisplay).trim().slice(0, 160) : "";
        const childSessionId = typeof rawMeta.childSessionId === "string" ? stripControlChars(rawMeta.childSessionId).trim().slice(0, 160) : "";
        const fullMessage = typeof rawMeta.fullMessage === "string"
          ? rawMeta.fullMessage.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS)
          : undefined;
        if (rawMeta.kind === "agent-relay") {
          const fromSessionId = typeof rawMeta.fromSessionId === "string" ? stripControlChars(rawMeta.fromSessionId).trim().slice(0, 160) : "";
          const fromLabel = typeof rawMeta.fromLabel === "string" ? stripControlChars(rawMeta.fromLabel).trim().slice(0, 160) : "";
          const fromEmployee = typeof rawMeta.fromEmployee === "string" ? stripControlChars(rawMeta.fromEmployee).trim().slice(0, 160) : "";
          const hops = typeof rawMeta.hops === "number" && Number.isFinite(rawMeta.hops) ? Math.floor(rawMeta.hops) : 0;
          const maxHops = typeof rawMeta.maxHops === "number" && Number.isFinite(rawMeta.maxHops) ? Math.floor(rawMeta.maxHops) : 0;
          // fromSessionId is OPTIONAL: a session-origin send always carries it,
          // but an operator-origin relay has no source session and is still a
          // valid, renderable relay (the web parser treats it as non-openable).
          if (fromLabel && hops > 0 && maxHops > 0 && fullMessage !== undefined) {
            notificationMeta = {
              kind: "agent-relay",
              ...(fromSessionId ? { fromSessionId } : {}),
              fromLabel,
              ...(fromEmployee ? { fromEmployee } : {}),
              hops,
              maxHops,
              fullMessage,
            };
          }
        } else if (kind && employee && childSessionId) {
          notificationMeta = {
            kind,
            employee,
            ...(employeeDisplay ? { employeeDisplay } : {}),
            childSessionId,
            ...(fullMessage !== undefined ? { fullMessage } : {}),
          };
        } else if (rawMeta.kind === "manager-visibility" && employee && childSessionId) {
          const manager = typeof rawMeta.manager === "string" ? stripControlChars(rawMeta.manager).trim().slice(0, 160) : "";
          const delegator = typeof rawMeta.delegator === "string" ? stripControlChars(rawMeta.delegator).trim().slice(0, 160) : "";
          const workItemId = typeof rawMeta.workItemId === "string" ? stripControlChars(rawMeta.workItemId).trim().slice(0, 160) : "";
          if (manager && delegator && workItemId) {
            notificationMeta = {
              kind: "manager-visibility",
              manager,
              delegator,
              employee,
              childSessionId,
              workItemId,
            };
          }
        }
      }

      let notificationBlock: ChatBlockEnvelope | undefined;
      if (isNotification && body.block !== undefined) {
        const validated = validateBlockEnvelope(body.block);
        if (!validated.ok) return badRequest(res, validated.error);
        notificationBlock = validated.envelope;
      }

      const config = context.getConfig();
      // CLI-mode sends route to the engine's PTY view when one exists so the
      // prompt/response are visible in xterm. Engines without a PTY view fall back.
      const ptyEngine = body.mode === "interactive" ? context.ptyViewEngines?.[session.engine] : undefined;
      const engine = ptyEngine ?? context.sessionManager.getEngine(session.engine);
      if (!engine) return serverError(res, `Engine "${session.engine}" not available`);

      // Only interrupt if a turn is actually in flight. With warm PTYs, isAlive is
      // also true for an idle-but-warm engine — isTurnRunning distinguishes them.
      // Headless engines lack isTurnRunning; their isAlive ≈ "turn running".
      const turnRunning = session.status === "running" && isInterruptibleEngine(engine)
        && ("isTurnRunning" in engine ? (engine as any).isTurnRunning(session.id) : engine.isAlive(session.id));
      const shouldInterruptRunningTurn =
        !isNotification &&
        (config.sessions?.interruptOnNewMessage ?? true) &&
        turnRunning;
      if (shouldInterruptRunningTurn) supersedeRunningTurn(session);

      // Persist the message immediately. For notifications, store the clean
      // human-facing `displayMessage` (what the UI banner renders) — the engine
      // still runs on the full `prompt` via the dispatch below.
      // For user messages, attach media (file IDs → descriptors) so the bubble
      // shows chips/thumbnails on reload — never the raw injected path text.
      const userMedia = isNotification ? [] : fileIdsToMedia(body.attachments);
      // Re-home any attachments uploaded without a sessionId (defensive; usually a no-op
      // since the web client now scopes uploads to the session).
      if (!isNotification) rehomeAttachmentsToSession(body.attachments, session.id);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      // Parent callbacks and agent-to-agent notifications must survive a crash
      // after this route accepts them but before their engine turn starts. Persist
      // the full engine-facing prompt before the display-only message below; the
      // internal flag keeps it out of operator queue controls while boot replay
      // still sees it. User messages retain their existing enqueue point below.
      let queueItemId: string | undefined;
      let incomingMessageId: string;
      if (callbackDelivery) {
        const acceptance = acceptSessionDelivery(callbackDelivery.id, session.id, sessionKey);
        if (!acceptance.accepted) {
          return json(res, {
            status: "duplicate",
            sessionId: session.id,
            callbackDeliveryId: acceptance.delivery.id,
            messageId: acceptance.delivery.messageId,
            queueItemId: acceptance.delivery.queueItemId,
          });
        }
        queueItemId = acceptance.delivery.queueItemId!;
        incomingMessageId = acceptance.delivery.messageId!;
      } else {
        queueItemId = isNotification
          ? enqueueQueueItem(session.id, sessionKey, prompt, { internal: true })
          : undefined;
        incomingMessageId = insertMessage(
          session.id,
          messageRole,
          isNotification ? displayMessage : prompt,
          userMedia.length > 0 ? userMedia : undefined,
          undefined,
          undefined,
          notificationMeta,
        );
      }
      if (parentFollowUp) {
        const preview = clipSessionMessage(parentFollowUp.message, 220);
        const employee = session.employee || session.engine;
        const storedDisplay = session.transportMeta?.delegationEmployeeDisplay;
        const employeeDisplay = typeof storedDisplay === "string" && storedDisplay.trim()
          ? storedDisplay.trim()
          : employee
              .split(/[-_\s]+/)
              .filter(Boolean)
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join(" ");
        const dispatchBlock: ChatBlockEnvelope = {
          op: "put",
          block: {
            id: `dp-${incomingMessageId}`,
            type: "dispatch",
            version: 1,
            status: "done",
            payload: {
              targetSessionId: session.id,
              employee,
              employeeDisplay,
              preview,
              sentAt: Date.now(),
            },
          },
        };
        const fallbackContent = blockFallbackText(dispatchBlock.block);
        applyBlockEnvelope(parentFollowUp.caller.id, dispatchBlock, fallbackContent);
        context.emit("session:delta", {
          sessionId: parentFollowUp.caller.id,
          type: "block",
          content: fallbackContent,
          block: dispatchBlock,
        });
      }
      if (notificationBlock) {
        // Callback acceptance persisted this block with its queue/message in one
        // transaction. Ordinary notifications still persist it here.
        if (!callbackDelivery) applyBlockEnvelope(session.id, notificationBlock);
        context.emit("session:delta", {
          sessionId: session.id,
          type: "block",
          content: displayMessage,
          block: notificationBlock,
        });
      }
      // Push the banner live to any connected web client viewing the parent.
      if (isNotification) {
        context.emit("session:notification", {
          sessionId: session.id,
          message: displayMessage,
          ...(notificationMeta ? { meta: notificationMeta } : {}),
        });
      }
      // Note: notification-role messages (e.g. child session callbacks) fall
      // through to enqueue + dispatch so the engine (e.g. the COO) actually
      // processes the notification and can respond — they do not return early.

      if (!isNotification && session.status === "waiting") {
        // A new user message on a rate-limit-paused session is an explicit
        // "retry now" — e.g. the user cleared the limit on the provider side.
        // handleRateLimit's wait-and-retry loop is sleeping until the engine's
        // OWN reported resetsAt while holding this session's serial queue slot,
        // so simply queueing this message would park it behind a now-stale reset
        // and the session keeps reporting "still limited" (the limit is stale
        // inside jinn, not on the provider). Flip out of `waiting` so that loop's
        // status guard unwinds it as cancelled and frees the queue; the message
        // enqueued below then runs immediately against the — now available —
        // engine. Notifications (child callbacks) never trigger this.
        updateSession(session.id, {
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        session = getSession(session.id) ?? session;
        context.emit("session:resumed", { sessionId: session.id });
      }

      // If a turn is already running, check whether we should interrupt or queue.
      // Notifications (child completion callbacks) should never interrupt — just queue.
      if (session.status === "running") {
        if (shouldInterruptRunningTurn) {
          logger.info(`Interrupting running session ${session.id} for new message`);
          engine.kill(session.id, USER_MESSAGE_INTERRUPTION_REASON);
          // SessionQueue serializes per-session; the new turn enqueued below will
          // wait for the killed run()'s promise to settle before starting.
          context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
        } else if (!isNotification) {
          context.emit("session:queued", { sessionId: session.id, message: prompt });
        }
      }

      // If session was interrupted by a restart, clear the error and resume
      if (session.status === "interrupted") {
        logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
        updateSession(session.id, {
          status: "running",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        context.emit("session:resumed", { sessionId: session.id });
      }

      // Clear any pending cancellation so the new message runs normally.
      context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      // Internal notification-role messages are already durably queued above;
      // only real user messages create a visible queue-panel item here.
      if (!isNotification) {
        queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
        context.emit("queue:updated", { sessionId: session.id, sessionKey });
      }

      // Speech-derived operator messages carry a hidden context note to the engine
      // only. Everything persisted/queued/emitted above uses the clean `prompt`;
      // notifications (callbacks, relays) never qualify, and interactive dispatch
      // (ptyEngine truthy) suppresses the note so the visible PTY paste stays the
      // operator's exact text. Recomputed per request → exactly one note, never
      // persisted, never rendered, never duplicated on retry/reload/reconnect.
      const { engine: enginePrompt } = resolveMessageAudiences(
        prompt,
        speechContextApplies({ speech: body.speech === true, isNotification, promptRendered: !!ptyEngine }),
      );
      dispatchWebSessionRun(session, enginePrompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, {
        status: "queued",
        sessionId: session.id,
        ...(callbackDelivery ? {
          callbackDeliveryId: callbackDelivery.id,
          messageId: incomingMessageId,
          queueItemId,
        } : {}),
      });
    }

    // POST /api/sessions/:id/attachments — running agent pushes a file/image into the chat.
    // Accepts multipart (file + optional text/caption) OR JSON ({path|content|url, filename?, text?}).
    // The file is stored under ~/.jinn/uploads/<date>/<sessionId>/ and surfaced as an assistant
    // message with rendered media (image/audio/file). Only the path/URL reaches the UI — never raw bytes in the prompt.
    params = matchRoute("/api/sessions/:id/attachments", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      await handleSessionAttachment(req, res, params.id, context);
      return;
    }

    // GET /api/cron
    if (method === "GET" && pathname === "/api/cron") {
      const jobs = loadJobs();
      // Enrich with last run status — tail-read only the newest entry, the
      // run logs are append-only JSONL that grows forever.
      const enriched = await Promise.all(jobs.map(async (job) => {
        const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
        const { entries } = await readJsonlTail(runFile, 1);
        return cronJobSummary(job as unknown as Record<string, unknown>, entries[0] ?? null);
      }));
      return json(res, enriched);
    }

    // GET /api/cron/:id/runs?limit=N — newest first (the UI shows "Recent Runs").
    // Run history is append-only JSONL that grows forever, so only the file's
    // tail is read; corrupt lines (crash mid-write) are skipped, not 500'd.
    params = matchRoute("/api/cron/:id/runs", pathname);
    if (method === "GET" && params) {
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "", 10) || 50));
      const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);
      const { entries: runs, skipped } = await readJsonlTail(runFile, limit);
      if (skipped) logger.warn(`GET /api/cron/${params.id}/runs: skipped ${skipped} corrupt line(s)`);
      return json(res, runs.map(summarizeCronRun));
    }

    // POST /api/cron — create new cron job
    if (method === "POST" && pathname === "/api/cron") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const jobs = loadJobs();
      // Job ids are identity (run-log files and PUT/DELETE routing) —
      // a duplicate would double-schedule one id and collide two run histories in
      // one jsonl (Codex GRS-014d finding 2). Identity is CANONICAL (trim+lowercase,
      // GRS-014d-fix2): run-log files `<id>.jsonl` collide case-insensitively on the
      // default macOS volume, so differently-cased ids share the same job history.
      // Stored ids stay as authored; only the collision check (and a
      // padded-id rejection — whitespace ids break addressing) canonicalizes.
      if (typeof body.id === "string" && body.id !== body.id.trim()) {
        return badRequest(res, "cron job id must not have leading/trailing whitespace");
      }
      if (body.id && jobs.some((j) => canonicalCronJobId(j.id) === canonicalCronJobId(body.id))) {
        return badRequest(res, `a cron job with id "${body.id}" already exists`);
      }
      const newJob: CronJob = {
        id: body.id || crypto.randomUUID(),
        name: body.name || "untitled",
        enabled: body.enabled ?? true,
        schedule: body.schedule || "0 * * * *",
        timezone: body.timezone,
        engine: body.engine,
        model: body.model,
        employee: body.employee,
        prompt: body.prompt || "",
        delivery: body.delivery,
      };
      const scheduleErrors = validateCronSchedule({ schedule: newJob.schedule, ...(newJob.timezone !== undefined ? { timezone: newJob.timezone } : {}) });
      if (scheduleErrors.length > 0) return badRequest(res, scheduleErrors.map((entry) => entry.message).join("; "));
      jobs.push(newJob);
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, newJob, 201);
    }

    // PUT /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "PUT" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const merged = { ...jobs[idx], ...body, id: params.id } as CronJob;
      const scheduleErrors = validateCronSchedule({ schedule: merged.schedule, ...(merged.timezone !== undefined ? { timezone: merged.timezone } : {}) });
      if (scheduleErrors.length > 0) return badRequest(res, scheduleErrors.map((entry) => entry.message).join("; "));
      jobs[idx] = merged;
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, jobs[idx]);
    }

    // DELETE /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "DELETE" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const removed = jobs.splice(idx, 1)[0];
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, { deleted: removed.id, name: removed.name });
    }

    // POST /api/cron/:id/trigger — manually run a cron job now
    params = matchRoute("/api/cron/:id/trigger", pathname);
    if (method === "POST" && params) {
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === params!.id);
      if (!job) return notFound(res);

      logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);

      // Fire and forget — respond immediately, run in background.
      runCronJob(job, context.sessionManager, context.getConfig(), context.connectors).catch(
        (err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`)
      );

      return json(res, {
        triggered: true,
        jobId: job.id,
        name: job.name,
        employee: job.employee,
        message: `Cron job "${job.name}" triggered manually`,
      });
    }

    // GET /api/org
    if (method === "GET" && pathname === "/api/org") {
      if (!fs.existsSync(ORG_DIR)) return json(res, { departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } });
      const entries = fs.readdirSync(ORG_DIR, { withFileTypes: true });
      const departments = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = scanOrg();
      const hierarchy = resolveOrgHierarchy(orgRegistry);

      const employees = hierarchy.sorted.map((name) => {
        const node = hierarchy.nodes[name];
        const emp = node.employee;
        const { persona, ...rest } = emp;
        const role = compactEmployeeRole(persona);
        return {
          ...rest,
          ...(role ? { role } : {}),
          parentName: node.parentName,
          directReports: node.directReports,
          depth: node.depth,
          chain: node.chain,
        };
      });

      return json(res, {
        departments,
        employees,
        hierarchy: {
          root: hierarchy.root,
          sorted: hierarchy.sorted,
          warnings: hierarchy.warnings,
        },
      });
    }

    // GET /api/org/employees/:name
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "GET" && params) {
      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = scanOrg();
      const emp = orgRegistry.get(params.name);
      if (!emp) return notFound(res);

      const hierarchy = resolveOrgHierarchy(orgRegistry);
      const node = hierarchy.nodes[params.name];

      return json(res, {
        ...emp,
        parentName: node?.parentName ?? null,
        directReports: node?.directReports ?? [],
        depth: node?.depth ?? 0,
        chain: node?.chain ?? [params.name],
      });
    }

    // PATCH /api/org/employees/:name — update employee fields (whitelisted, validated)
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "PATCH" && params) {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "update body must be a JSON object");
      }
      const { scanOrg, updateEmployeeYaml, validateEmployeeUpdate } = await import("./org.js");
      const current = scanOrg().get(params.name);
      if (!current) return notFound(res);

      const result = validateEmployeeUpdate(context.getConfig(), current, body);
      if (!result.ok) return badRequest(res, result.error || "invalid update");

      const wrote = updateEmployeeYaml(params.name, result.updates!);
      if (!wrote) return notFound(res);

      // G1: synchronously refresh the in-memory registry (and drop warm PTYs) so an
      // immediate session spawn sees the new persona/model — don't wait for the watcher.
      context.reloadOrg?.();
      context.emit("org:updated", { employee: params.name });

      const updated = scanOrg().get(params.name);
      return json(res, { status: "ok", employee: updated ?? null });
    }

    // GET /api/org/departments/:name/board
    params = matchRoute("/api/org/departments/:name/board", pathname);
    if (method === "GET" && params) {
      const boardPath = path.join(ORG_DIR, params.name, "board.json");
      if (!fs.existsSync(boardPath)) return notFound(res);
      let board: unknown;
      try { board = JSON.parse(fs.readFileSync(boardPath, "utf-8")); }
      catch (err) {
        logger.warn(`GET /api/org/departments/${params.name}/board: corrupt board.json — ${err instanceof Error ? err.message : String(err)}`);
        return serverError(res, "board.json is corrupt");
      }
      return json(res, board);
    }

    // PUT /api/org/departments/:name/board
    if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) {
      const p = matchRoute("/api/org/departments/:name/board", pathname)!;
      const boardPath = path.join(ORG_DIR, p.name, "board.json");
      const deptDir = path.join(ORG_DIR, p.name);
      if (!fs.existsSync(deptDir)) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      fs.writeFileSync(boardPath, JSON.stringify(body, null, 2));
      context.emit("board:updated", { department: p.name });
      return json(res, { status: "ok" });
    }

    // GET /api/skills
    if (method === "GET" && pathname === "/api/skills") {
      if (!fs.existsSync(SKILLS_DIR)) return json(res, []);
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      const skills = entries.filter((e) => e.isDirectory()).map((e) => {
        const skillMdPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
        const st = fs.statSync(skillMdPath, { throwIfNoEntry: false });
        if (!st) {
          skillDescriptionCache.delete(e.name);
          return { name: e.name, description: "" };
        }
        const hit = skillDescriptionCache.get(e.name);
        if (hit && hit.mtimeMs === st.mtimeMs) return { name: e.name, description: hit.description };
        const description = parseSkillDescription(fs.readFileSync(skillMdPath, "utf-8"));
        skillDescriptionCache.set(e.name, { mtimeMs: st.mtimeMs, description });
        return { name: e.name, description };
      });
      return json(res, skills);
    }

    // GET /api/skills/:name
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "GET" && params) {
      const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) return notFound(res);
      const content = fs.readFileSync(skillMd, "utf-8");
      return json(res, { name: params.name, content });
    }

    // PUT /api/skills/:name — replace an existing skill's SKILL.md
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "PUT" && params) {
      const parsed = await readJsonBody(req, res, { maxBytes: SKILL_CONTENT_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
        ? parsed.body as Record<string, unknown>
        : {};
      const result = updateSkillContent(params.name, body.content);
      if (!result.ok) return json(res, { error: result.error }, result.status);
      skillDescriptionCache.delete(params.name);
      context.emit("skills:updated", { name: params.name });
      logger.info(`Skill updated via API: ${params.name}`);
      return json(res, { status: "updated", name: params.name, content: result.content });
    }

    // DELETE /api/skills/:name — remove a skill
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "DELETE" && params) {
      const skillDir = path.join(SKILLS_DIR, params.name);
      if (!fs.existsSync(skillDir)) return notFound(res);
      fs.rmSync(skillDir, { recursive: true, force: true });
      const { removeFromManifest } = await import("../cli/skills.js");
      removeFromManifest(params.name);
      logger.info(`Skill removed via API: ${params.name}`);
      return json(res, { status: "removed", name: params.name });
    }

    // GET /api/engines — resolved model + capability registry (single source of truth
    // for the UI model/effort selectors). Synthesized from engines.<name>.model
    // when no `models:` block is configured.
    if (method === "GET" && pathname === "/api/engines") {
      const config = context.getConfig();
      const registry = getModelRegistry(config);
      return json(res, { default: config.engines.default, engines: registry });
    }

    // POST /api/engines/refresh — re-run dynamic model discovery and return the
    // rebuilt registry. Lets the UI pick up models added to dynamic CLIs without
    // restarting the gateway.
    if (method === "POST" && pathname === "/api/engines/refresh") {
      const config = context.getConfig();
      await Promise.all([
        refreshClaudeModels(config),
        refreshCodexModels(config),
        refreshAntigravityModels(config),
        refreshPiModels(config),
        refreshGrokModels(config),
        refreshHermesModels(config),
      ]);
      context.emit("engines:updated", {});
      return json(res, { default: config.engines.default, engines: getModelRegistry(config) });
    }

    // GET /api/engine-limits — live/snapshot quota windows and static capability
    // metadata for each engine. Some CLIs expose full quota buckets (Codex), some
    // only expose session snapshots (Claude), and some expose no aggregate quota.
    if (method === "GET" && pathname === "/api/engine-limits") {
      const engine = url.searchParams.get("engine") || undefined;
      return json(res, await collectEngineLimits(context.getConfig(), { engine }));
    }

    // POST /api/engine-limits/refresh — currently identical to GET for live
    // sources. Kept as a command-shaped endpoint so the UI/CLI can request a
    // deliberate refresh without changing the public contract later.
    if (method === "POST" && pathname === "/api/engine-limits/refresh") {
      const engine = url.searchParams.get("engine") || undefined;
      return json(res, await collectEngineLimits(context.getConfig(), { engine }));
    }

    // GET /api/config
    if (method === "GET" && pathname === "/api/config") {
      const config = context.getConfig();
      return json(res, sanitizeConfigForApi(config));
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      // Basic validation: must be a plain object
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "Config must be a JSON object");
      }
      // Validate known top-level keys
      // Keep this aligned with `JinnConfig` in src/shared/types.ts
      const KNOWN_KEYS = [
        "jinn",
        "gateway",
        "engines",
        "models",
        "connectors",
        "logging",
        "mcp",
        "sessions",
        "cron",
        "notifications",
        "portal",
        "context",
        "stt",
        "talk",
        "skills",
        "remotes",
      ];
      const unknownKeys = Object.keys(body).filter((k) => !KNOWN_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return badRequest(res, `Unknown config keys: ${unknownKeys.join(", ")}`);
      }
      // Validate critical field types
      if (body.gateway !== undefined) {
        if (typeof body.gateway !== "object" || Array.isArray(body.gateway)) {
          return badRequest(res, "gateway must be an object");
        }
        if (body.gateway.port !== undefined && typeof body.gateway.port !== "number") {
          return badRequest(res, "gateway.port must be a number");
        }
      }
      if (body.engines !== undefined && (typeof body.engines !== "object" || Array.isArray(body.engines))) {
        return badRequest(res, "engines must be an object");
      }
      // Deep-merge incoming config with existing config to preserve
      // fields not included in the update (e.g. connector tokens).
      let existing: Record<string, unknown> = {};
      try {
        existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
      } catch { /* start fresh if unreadable */ }
      const merged = deepMerge(existing, body);
      saveConfigAtomic(merged);
      context.reloadConfig?.(); // refresh in-memory config now (don't wait on the watcher)
      invalidateModelRegistry(); // models/engines may have changed — rebuild on next read
      logger.info("Config updated via API");
      return json(res, { status: "ok" });
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      const logFile = path.join(LOGS_DIR, "gateway.log");
      if (!fs.existsSync(logFile)) return json(res, { lines: [] });
      const n = parseInt(url.searchParams.get("n") || "100", 10);
      // Read only the last 64KB to avoid loading the entire file into memory
      const MAX_BYTES = 64 * 1024;
      const stat = fs.statSync(logFile);
      const readSize = Math.min(stat.size, MAX_BYTES);
      const fd = fs.openSync(logFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      const allLines = redactText(buf.toString("utf-8")).split("\n").filter(Boolean);
      const lines = allLines.slice(-n);
      return json(res, { lines });
    }

    // POST /api/connectors/reload — stop all instance connectors and restart from config
    if (method === "POST" && pathname === "/api/connectors/reload") {
      if (!context.reloadConnectorInstances) {
        return json(res, { error: "Connector reload not available" }, 501);
      }
      try {
        const result = await context.reloadConnectorInstances();
        context.emit("connectors:reloaded", result);
        return json(res, result);
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /api/connectors/:id/incoming — receive proxied Discord messages from primary instance
    // Supports both the legacy /api/connectors/discord/incoming and named instance ids
    params = matchRoute("/api/connectors/:id/incoming", pathname);
    if (method === "POST" && params && params.id) {
      // Try the exact instance id first, then fall back to "discord" for the legacy path
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);
      if (!("deliverMessage" in connector)) {
        return json(res, { error: "Discord connector is not in remote mode" }, 400);
      }

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // Download attachments from Discord CDN URLs to local temp
      const { downloadAttachment } = await import("../connectors/discord/format.js");
      const attachments = await Promise.all(
        (body.attachments || []).map(async (att: { name: string; url: string; mimeType: string }) => {
          if (att.url) {
            try {
              const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
              return { name: att.name, url: att.url, mimeType: att.mimeType, localPath };
            } catch {
              return { name: att.name, url: att.url, mimeType: att.mimeType };
            }
          }
          return att;
        }),
      );

      const incomingMsg: IncomingMessage = {
        connector: params.id,
        source: "discord",
        sessionKey: body.sessionKey,
        channel: body.channel,
        thread: body.thread,
        user: body.user,
        userId: body.userId,
        text: body.text,
        messageId: body.messageId,
        attachments,
        replyContext: body.replyContext || {},
        transportMeta: body.transportMeta,
        raw: body,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connector as any).deliverMessage(incomingMsg);
      return json(res, { status: "delivered" });
    }

    // POST /api/connectors/:id/proxy — proxy connector operations from remote instances
    // Supports both the legacy /api/connectors/discord/proxy and named instance ids
    params = matchRoute("/api/connectors/:id/proxy", pathname);
    if (method === "POST" && params && params.id) {
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      const action = body.action as string;
      const target = body.target as Target | undefined;
      let messageId: string | undefined;

      switch (action) {
        case "sendMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.sendMessage(target, redactText(String(body.text)))) as string | undefined;
          break;
        case "replyMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.replyMessage(target, redactText(String(body.text)))) as string | undefined;
          break;
        case "editMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          await connector.editMessage(target, redactText(String(body.text)));
          break;
        case "addReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.addReaction(target, body.emoji);
          break;
        case "removeReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.removeReaction(target, body.emoji);
          break;
        case "setTypingStatus":
          if (connector.setTypingStatus) {
            await connector.setTypingStatus(body.channelId ?? "", body.threadTs, body.status ?? "");
          }
          break;
        default:
          return badRequest(res, `Unknown proxy action: ${action}`);
      }

      return json(res, { status: "ok", messageId });
    }

    // POST /api/connectors/:name/send — send a message via a connector
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      await connector.sendMessage(
        { channel: body.channel, thread: body.thread },
        redactText(String(body.text)),
      );
      return json(res, { status: "sent" });
    }

    // GET /api/connectors/whatsapp/qr — return current QR code as PNG data URL
    if (method === "GET" && pathname === "/api/connectors/whatsapp/qr") {
      const waConnector = context.connectors.get("whatsapp");
      if (!waConnector) return notFound(res);
      const qrString = (waConnector as WhatsAppConnector).getQrCode();
      if (!qrString) return json(res, { qr: null });
      const dataUrl = await QRCode.toDataURL(qrString, { width: 256, margin: 2 });
      return json(res, { qr: dataUrl });
    }

    // GET /api/connectors — list available connectors
    if (method === "GET" && pathname === "/api/connectors") {
      const connectors = Array.from(context.connectors.entries()).map(([instanceId, connector]) => ({
        name: connector.name,
        instanceId,
        employee: connector.getEmployee?.() ?? undefined,
        ...connector.getHealth(),
      }));
      return json(res, connectors);
    }

    // GET /api/activity — normalized operational stories. Raw gateway text
    // remains available separately at /api/logs for Diagnostics.
    if (method === "GET" && pathname === "/api/activity") {
      try {
        const rawLimit = url.searchParams.get("limit");
        const kinds = url.searchParams.get("kinds")?.split(",").map((value) => value.trim()).filter(Boolean) as ActivityKind[] | undefined;
        const outcomes = url.searchParams.get("outcomes")?.split(",").map((value) => value.trim()).filter(Boolean) as ActivityOutcomeState[] | undefined;
        return json(res, queryActivityPage({
          ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
          ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
          ...(url.searchParams.get("q") ? { q: url.searchParams.get("q")! } : {}),
          ...(kinds?.length ? { kinds } : {}),
          ...(outcomes?.length ? { outcomes } : {}),
        }));
      } catch (err) {
        if (err instanceof ActivityQueryError) return badRequest(res, err.message);
        throw err;
      }
    }

    const activityStoryMatch = pathname.match(/^\/api\/activity\/(story_[a-f0-9]{24})$/);
    if (method === "GET" && activityStoryMatch) {
      try {
        const detail = getActivityStory(activityStoryMatch[1]);
        return detail ? json(res, detail) : notFound(res);
      } catch (err) {
        if (err instanceof ActivityQueryError) return badRequest(res, err.message);
        throw err;
      }
    }

    // GET /api/onboarding — check if onboarding is needed
    if (method === "GET" && pathname === "/api/onboarding") {
      // Only the count is surfaced — use a pure COUNT(*) instead of hydrating +
      // JSON-parsing every session row on this polled endpoint.
      const sessionsCount = countSessions();
      const hasEmployees = fs.existsSync(ORG_DIR) &&
        fs.readdirSync(ORG_DIR, { recursive: true }).some(
          (f) => String(f).endsWith(".yaml") && !String(f).endsWith("department.yaml")
        );
      const config = context.getConfig();
      let todoPrefix: string | null;
      try {
        todoPrefix = resolveTodoIdPrefix(
          config.portal?.companyName ?? "Jinn",
          config.portal?.companyPrefix,
        );
      } catch {
        todoPrefix = null;
      }
      const onboarded = config.portal?.onboarded === true;
      const setupComplete = config.portal?.setupComplete === true || onboarded;
      return json(res, {
        needed: onboardingNeeded(onboarded),
        onboarded,
        setupComplete,
        conversationNeeded: !setupComplete,
        sessionsCount,
        hasEmployees,
        companyName: config.portal?.companyName ?? null,
        companyPrefix: config.portal?.companyPrefix ?? null,
        todoPrefix,
        // Todos v2: allocation is per-prefix — a renamed company prefix simply
        // opens its own namespace, so the prefix is never frozen anymore.
        todoPrefixFrozen: false,
        portalName: config.portal?.portalName ?? null,
        operatorName: config.portal?.operatorName ?? null,
      });
    }

    // POST /api/onboarding — persist portal personalization
    if (method === "POST" && pathname === "/api/onboarding") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const { companyName, companyPrefix, portalName, operatorName, language, engine, model, effortLevel } = body;
      const config = context.getConfig();
      // Todos v2: prefixes are per-namespace and never freeze — a changed company
      // prefix mints future Todos under its own sequence. Only validity is checked.
      if (companyPrefix !== undefined && companyPrefix !== null) {
        try {
          resolveTodoIdPrefix(companyName ?? config.portal?.companyName ?? "Jinn", companyPrefix);
        } catch (error) {
          return badRequest(res, error instanceof Error ? error.message : "Invalid Todo prefix");
        }
      }
      if (companyName !== undefined || companyPrefix !== undefined) {
        try {
          resolveTodoIdPrefix(
            companyName ?? config.portal?.companyName ?? "Jinn",
            companyPrefix === null ? undefined : companyPrefix ?? config.portal?.companyPrefix,
          );
        } catch (error) {
          return badRequest(res, error instanceof Error ? error.message : "Invalid company name");
        }
      }

      // Read current config and merge engine choice + portal settings
      const updated = {
        ...applyEngineChoice(config, { engine, model, effortLevel }),
        portal: {
          ...config.portal,
          onboarded: true,
          setupComplete: true,
          ...(companyName !== undefined && { companyName }),
          ...(companyPrefix !== undefined && { companyPrefix: companyPrefix || undefined }),
          ...(portalName !== undefined && { portalName: portalName || undefined }),
          ...(operatorName !== undefined && { operatorName: operatorName || undefined }),
          ...(language !== undefined && { language: language || undefined }),
        },
      };

      // Write updated config, then refresh the in-memory copy synchronously so
      // GET /api/onboarding reflects onboarded:true immediately (not after the
      // debounced file-watcher fires ~1s later).
      saveConfigAtomic(updated, { lineWidth: -1 });
      context.reloadConfig?.();
      logger.info(`Onboarding: company configured=${companyName !== undefined}, portal name="${portalName}", operator="${operatorName}", language="${language}"`);

      const effectiveName = portalName || "Jinn";
      const languageSection = language && language !== "English"
        ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
        : "";

      // Personalize the operating manual with the chosen COO name + language.
      // The shipped identity line is bold, e.g.
      //   "You are **Jinn**, a personal AI assistant and COO of an AI organization."
      // (The previous CLAUDE.md regex expected unbolded "...the COO of the user's
      // AI organization." and never matched, so the rename silently no-op'd.)
      const personalizeManual = (filePath: string) => {
        let md = fs.readFileSync(filePath, "utf-8");
        // Replace just the bold name token; `[^*]+` supports multi-word names.
        md = md.replace(/^You are \*\*[^*]+\*\*/m, `You are **${effectiveName}**`);
        // Reset any prior language section, then append the new one if needed.
        md = md.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) md = md.trimEnd() + languageSection + "\n";
        fs.writeFileSync(filePath, md);
      };

      // CLAUDE.md is canonical. AGENTS.md is normally a symlink → CLAUDE.md, so we
      // edit CLAUDE.md directly and skip the symlink (avoids double-processing the
      // same file). Only the rare non-symlink fallback copy is personalized too.
      const claudeMdPath = path.join(JINN_HOME, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) personalizeManual(claudeMdPath);

      const agentsMdPath = path.join(JINN_HOME, "AGENTS.md");
      if (fs.existsSync(agentsMdPath) && !fs.lstatSync(agentsMdPath).isSymbolicLink()) {
        personalizeManual(agentsMdPath);
      }

      context.emit("config:updated", { portal: updated.portal });
      return json(res, { status: "ok", portal: updated.portal });
    }

    // ── STT (Speech-to-Text) ──────────────────────────────────
    if (method === "GET" && pathname === "/api/stt/status") {
      const config = context.getConfig();
      const languages = resolveLanguages(config.stt);
      const status = getSttStatus(config.stt?.model, languages);
      return json(res, status);
    }

    if (method === "POST" && pathname === "/api/stt/download") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";

      downloadModel(model, (progress) => {
        context.emit("stt:download:progress", { progress });
      }).then(() => {
        // Update config to mark STT as enabled
        try {
          const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
          const cfg = yaml.load(raw) as Record<string, unknown>;
          if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
          const sttCfg = cfg.stt as Record<string, unknown>;
          sttCfg.enabled = true;
          sttCfg.model = model;
          if (!sttCfg.languages) sttCfg.languages = ["en"];
          saveConfigAtomic(cfg, { lineWidth: -1 });
        } catch (err) {
          logger.error(`Failed to update config after STT download: ${err}`);
        }
        context.emit("stt:download:complete", { model });
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT download failed: ${msg}`);
        context.emit("stt:download:error", { error: msg });
      });

      return json(res, { status: "downloading", model });
    }

    if (method === "POST" && pathname === "/api/stt/transcribe") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";
      const languages = resolveLanguages(config.stt);
      // Accept language from query param, fall back to first configured language
      const requestedLang = url.searchParams.get("language");
      const language = requestedLang && languages.includes(requestedLang) ? requestedLang : languages[0];

      const audioBuffer = await readBodyRaw(req);
      if (audioBuffer.length === 0) return badRequest(res, "No audio data");
      if (audioBuffer.length > 100 * 1024 * 1024) return badRequest(res, "Audio too large (100MB max)");

      const contentType = req.headers["content-type"] || "audio/webm";
      const ext = contentType.includes("wav") ? ".wav"
        : contentType.includes("mp4") || contentType.includes("m4a") ? ".m4a"
        : contentType.includes("ogg") ? ".ogg"
        : ".webm";

      const tmpFile = path.join(TMP_DIR, `stt-${crypto.randomUUID()}${ext}`);
      fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(tmpFile, audioBuffer);

      try {
        const text = await sttTranscribe(tmpFile, model, language);
        return json(res, { text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT transcription failed: ${msg}`);
        return serverError(res, `Transcription failed: ${msg}`);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }

    if (method === "PUT" && pathname === "/api/stt/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const langs = body.languages;

      if (!Array.isArray(langs) || langs.length === 0) {
        return badRequest(res, "languages must be a non-empty array");
      }

      const invalid = langs.filter((l) => typeof l !== "string" || !WHISPER_LANGUAGES[l]);
      if (invalid.length > 0) {
        return badRequest(res, `Invalid language codes: ${invalid.join(", ")}`);
      }

      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = yaml.load(raw) as Record<string, unknown>;
        if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
        const sttCfg = cfg.stt as Record<string, unknown>;
        sttCfg.languages = langs;
        // Remove deprecated language field if present
        delete sttCfg.language;
        saveConfigAtomic(cfg, { lineWidth: -1 });
        return json(res, { status: "ok", languages: langs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, `Failed to update STT config: ${msg}`);
      }
    }

    // ── TTS (per-message read-aloud) ──────────────────────────
    // GET /api/tts — engine readiness so the client can pick Kokoro vs the
    // browser Web Speech fallback WITHOUT a failed POST. Reuses the shared Kokoro
    // engine (also driving the /talk voice loop); gated on weights + venv present.
    if (method === "GET" && pathname === "/api/tts") {
      const { available, voice } = ttsStatus(context.getConfig().talk?.kokoro);
      return json(res, { available, voice });
    }

    // POST /api/tts {text} — STREAM one length-prefixed WAV frame per sentence as
    // each is synthesized, so the client plays sentence 1 while 2..N are still
    // synthesizing (time-to-first-audio ≈ one sentence, not the whole message).
    // Frame = 4-byte big-endian length + WAV bytes. 503 {available:false} when
    // Kokoro can't run (client then falls back to browser Web Speech).
    if (method === "POST" && pathname === "/api/tts") {
      const kokoroOpts = context.getConfig().talk?.kokoro;
      if (!ttsStatus(kokoroOpts).available) {
        return json(res, { available: false }, 503);
      }
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      const valid = validateTtsText((parsed.body as { text?: unknown } | null)?.text);
      if (!valid.ok) return badRequest(res, valid.error);

      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
      });
      // A client abort (pause / navigate) closes the request → stop synthesizing
      // the rest of the message instead of wasting Kokoro on audio nobody hears.
      let cancelled = false;
      req.on("close", () => {
        cancelled = true;
      });
      try {
        await streamTtsSentences(
          valid.text,
          kokoroOpts,
          (wav) => {
            const header = Buffer.allocUnsafe(4);
            header.writeUInt32BE(wav.length, 0);
            res.write(header);
            res.write(wav);
          },
          () => cancelled || res.writableEnded,
        );
      } catch (err) {
        logger.warn(`TTS stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.writableEnded) res.end();
      return;
    }

    // /api/files — file upload/download/management
    if (pathname.startsWith("/api/files")) {
      const handled = await handleFilesRequest(req, res, pathname, method, context);
      if (handled) return;
    }

    // POST /api/internal/hook — receive Claude Code turn hooks from the relay script
    if (method === "POST" && pathname === "/api/internal/hook") {
      if (!context.hookRegistry || !context.hookSecret) {
        return json(res, { error: "Interactive mode not active" }, 503);
      }
      // Loopback check FIRST — before reading the body — so a non-loopback
      // caller can't force unbounded body buffering by sending a huge POST.
      const remote = req.socket.remoteAddress;
      if (!isLoopback(remote)) {
        return json(res, { message: "forbidden" }, 403);
      }
      // Reject oversized bodies up front via Content-Length, then enforce
      // the cap mid-stream too in case the header was missing or lies.
      const contentLength = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(contentLength) && contentLength > HOOK_BODY_MAX_BYTES) {
        return json(res, { error: "Payload too large" }, 413);
      }
      const _parsed = await readJsonBody(req, res, { maxBytes: HOOK_BODY_MAX_BYTES });
      if (!_parsed.ok) return;
      const hookBody = _parsed.body as { jinnSessionId?: string; hook?: import("./hook-registry.js").HookPayload };
      const rejected = validateHookPost(
        { reg: context.hookRegistry, secret: context.hookSecret, remoteAddress: remote },
        req.headers["x-jinn-hook-secret"] as string | undefined,
        hookBody,
      );
      if (rejected) return json(res, { message: rejected.body }, rejected.status);
      const jinnSessionId = hookBody.jinnSessionId!;
      const hook = hookBody.hook!;
      context.hookRegistry.deliver(jinnSessionId, hook);
      // Central engineSessionId capture: persist claude's OWN session id the moment
      // it reports one (SessionStart, or Stop as backup), independent of turn state.
      // Without this, an interrupted turn or an idle CLI-view spawn never persisted
      // the id, so the next cold respawn ran `claude` with resume:none → a fresh
      // conversation (the convo-wipe bug). Write-once guarded so it's not chatty.
      if (
        (hook.hook_event_name === "SessionStart" || hook.hook_event_name === "Stop") &&
        typeof hook.session_id === "string" &&
        hook.session_id
      ) {
        const existing = getSession(jinnSessionId);
        if (existing && getEngineSessionRef(existing, "claude").id !== hook.session_id) {
          recordEngineSessionId(jinnSessionId, "claude", hook.session_id);
        }
      }
      return json(res, { message: "ok" });
    }

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    return serverError(res, msg);
  }
}

/**
 * Load messages from a Claude Code JSONL transcript file.
 * Used as a fallback when the messages DB is empty (pre-existing sessions).
 */
interface TranscriptContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  id?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  content: TranscriptContentBlock[];
}

function loadRawTranscript(engineSessionId: string): TranscriptEntry[] {
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const entries: TranscriptEntry[] = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        const rawContent = msg.content;
        const blocks: TranscriptContentBlock[] = [];

        if (typeof rawContent === "string") {
          if (rawContent.trim()) blocks.push({ type: "text", text: rawContent });
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            const blockType = String(b.type || "");
            if (blockType === "text") {
              blocks.push({ type: "text", text: String(b.text || "") });
            } else if (blockType === "tool_use") {
              blocks.push({
                type: "tool_use",
                name: String(b.name || ""),
                input: (b.input as Record<string, unknown>) || {},
              });
            } else if (blockType === "tool_result") {
              const resultContent = b.content;
              let resultText: string;
              if (typeof resultContent === "string") {
                resultText = resultContent;
              } else if (Array.isArray(resultContent)) {
                resultText = (resultContent as Record<string, unknown>[])
                  .filter((rc) => rc.type === "text")
                  .map((rc) => String(rc.text || ""))
                  .join("");
              } else {
                resultText = "";
              }
              blocks.push({ type: "tool_result", text: resultText });
            } else if (blockType === "thinking") {
              blocks.push({ type: "thinking", text: String(b.thinking || b.text || "") });
            }
          }
        }

        if (blocks.length > 0) {
          entries.push({ role: type as "user" | "assistant", content: blocks });
        }
      } catch {
        continue;
      }
    }
    return entries;
  }
  return [];
}

/**
 * Track which sessions currently have an in-flight transcript backfill so
 * concurrent GETs don't kick off duplicate (expensive) parses. Once a backfill
 * finishes and inserts rows, subsequent GETs see messages.length > 0 and skip
 * scheduling entirely.
 */
const backfillInProgress = new Set<string>();

function scheduleTranscriptBackfill(sessionId: string, engineSessionId: string, context: ApiContext): void {
  if (backfillInProgress.has(sessionId)) return;
  backfillInProgress.add(sessionId);
  // Defer off the request-handling tick so the GET returns immediately.
  setImmediate(() => {
    try {
      // Re-check inside the deferred task: another concurrent GET may have
      // backfilled this session already (extremely unlikely given the Set
      // guard, but cheap insurance).
      const existing = getMessages(sessionId);
      if (existing.length > 0) return;
      const transcriptMessages = loadTranscriptMessages(engineSessionId);
      if (transcriptMessages.length === 0) return;
      // One transaction for the whole backfill — better-sqlite3 executes the
      // inner inserts synchronously inside a single BEGIN/COMMIT, which is
      // dramatically faster than autocommitting per row.
      const db = initDb();
      const txn = db.transaction((items: Array<{ role: string; content: string }>) => {
        for (const tm of items) {
          insertMessage(sessionId, tm.role, tm.content);
        }
      });
      txn(transcriptMessages);
      logger.info(`Backfilled ${transcriptMessages.length} transcript message(s) for session ${sessionId}`);
      // Notify subscribers (web client) so they re-fetch and display the
      // newly backfilled messages instead of waiting for another event.
      context.emit("session:updated", { sessionId });
    } catch (err) {
      logger.warn(`Transcript backfill failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
    } finally {
      backfillInProgress.delete(sessionId);
    }
  });
}

function loadTranscriptMessages(engineSessionId: string): Array<{ role: string; content: string }> {
  // Claude Code stores transcripts in ~/.claude/projects/<project-key>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  // Search all project dirs for the transcript
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const messages: Array<{ role: string; content: string }> = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const text = transcriptEntryText(obj);
        if (text) messages.push(text);
      } catch {
        continue;
      }
    }
    return messages;
  }
  return [];
}

/**
 * Sources that are NOT backed by an external chat connector. Anything else
 * (slack, telegram, discord, whatsapp, …) is connector-sourced and its turn
 * results must be relayed back to the originating channel.
 */
const NON_CONNECTOR_SOURCES = new Set(["web", "talk", "cron"]);

/**
 * Resolve the forwarded SSO identity from request headers, given the configured
 * `gateway.userHeader` (a single header name or a priority-ordered list). Node
 * lowercases incoming header keys, so we look up case-insensitively. Returns the
 * first present, non-empty, trimmed value; `undefined` when the config is unset
 * or no configured header is present. Unset config = single-user no-op: the
 * header is never read and the caller falls back to "web-user".
 */
export function resolveUserHeader(
  headers: Record<string, string | string[] | undefined>,
  userHeaderConfig: string | string[] | undefined,
): string | undefined {
  if (!userHeaderConfig) return undefined;
  const names = Array.isArray(userHeaderConfig) ? userHeaderConfig : [userHeaderConfig];
  for (const name of names) {
    if (!name) continue;
    const raw = headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * Relay a completed turn's assistant text back to the connector channel that
 * originated the session. Inbound connector messages reply via `manager.route`,
 * but turns completed through `runWebSession` (parent callbacks, cron
 * follow-ups, rate-limit resumes) otherwise never reach the channel. No-ops for
 * web/talk/cron sources, empty text, or a missing connector/replyContext; errors
 * are logged and swallowed so delivery failure never breaks completion.
 */
export async function deliverConnectorReply(
  session: Pick<Session, "source" | "connector" | "replyContext"> & { id?: string },
  text: string,
  connectors: Map<string, import("../shared/types.js").Connector>,
): Promise<void> {
  if (!text || NON_CONNECTOR_SOURCES.has(session.source)) return;
  if (!session.connector || !session.replyContext) return;
  const connector = connectors.get(session.connector);
  if (!connector) return;
  try {
    const target = connector.reconstructTarget(session.replyContext);
    await connector.replyMessage(target, text);
  } catch (err) {
    logger.warn(
      `Connector reply delivery failed for session ${session.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runWebSession(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  attemptToken: string,
  attachments?: string[],
): Promise<void> {
  const currentSession = getSession(session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${session.id} before run start`);
    return;
  }
  const engineAtTurnStart = currentSession.engine;
  const resumeRefAtTurnStart = getEngineSessionRef(currentSession, engineAtTurnStart);
  config = context.getConfig();
  const preferredPtyView = context.ptyViewEngines?.[session.engine] === engine;
  const runtimeEngine =
    (preferredPtyView ? context.ptyViewEngines?.[currentSession.engine] : undefined)
    ?? context.sessionManager.getEngine(currentSession.engine);
  if (!runtimeEngine) {
    const errMsg = `Engine "${currentSession.engine}" not available`;
    logger.error(`Web session ${currentSession.id} blocked: ${errMsg}`);
    insertMessage(currentSession.id, "assistant", `⛔ ${errMsg}`);
    const erroredSession = completeSessionAttempt(currentSession.id, attemptToken, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    context.emit("session:completed", { sessionId: currentSession.id, result: null, error: errMsg });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    if (erroredSession) notifyParentSession(erroredSession, { error: errMsg });
    return;
  }
  engine = runtimeEngine;
  logger.info(`Web session ${currentSession.id} running engine "${engineAtTurnStart}" (model: ${currentSession.model || "default"})`);

  // If this session has an assigned employee, load their persona
  let employee: import("../shared/types.js").Employee | undefined;
  if (currentSession.employee) {
    const { findEmployee } = await import("./org.js");
    const { scanOrg } = await import("./org.js");
    const registry = scanOrg();
    employee = findEmployee(currentSession.employee, registry);
  }

  // Pre-flight: fail fast with an actionable error if the engine's CLI binary
  // isn't installed. Otherwise the (interactive PTY) engine spawns a missing
  // command, exits silently, and the turn produces no output and no error.
  // We surface it the way runWebSession reports errors and return normally
  // (throwing here would escape the queue task as an unhandled rejection).
  if (isKnownEngine(currentSession.engine) && !engineAvailable(config, currentSession.engine)) {
    const errMsg = engineUnavailableMessage(config, currentSession.engine);
    logger.error(`Web session ${currentSession.id} blocked: ${errMsg}`);
    insertMessage(currentSession.id, "assistant", `⛔ ${errMsg}`);
    const erroredSession = completeSessionAttempt(currentSession.id, attemptToken, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    context.emit("session:completed", { sessionId: currentSession.id, result: null, error: errMsg });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    // Wake the parent COO if this was a delegated child session (parity with
    // the normal error path; no-op for top-level sessions).
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
    }
    return;
  }

  const { scanOrg: scanOrgForHierarchy } = await import("./org.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const orgHierarchy = resolveOrgHierarchy(scanOrgForHierarchy());

  // Declared in the function scope so the whole turn lifecycle — including any
  // rate-limit retry/fallback — reuses the same mcpConfigPath (parity with
  // manager.ts runSession). Deletion is owned by the PTY lifecycle, not this turn.
  let mcpConfigPath: string | undefined;
  let runHeartbeat: ReturnType<typeof setInterval> | undefined;

  try {

    let resolvedMcp: import("../shared/types.js").ResolvedMcpConfig | undefined;
    ({ mcpConfigPath, resolvedMcp } = resolveEngineRunMcp({
      config,
      employee,
      engine: currentSession.engine,
      sessionId: currentSession.id,
      workflowAttempt: currentSession.workflowProvenance?.kind === "phase",
    }));

    // Per-engine config is keyed by engine name; unconfigured optional engines
    // (antigravity/pi) resolve to {} so the engine falls back to dynamic bin/model
    // resolution. Adding an engine needs no change here.
    const engineConfig =
      (config.engines as unknown as Record<string, { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string } | undefined>)[
        currentSession.engine
      ] ?? {};
    const effortLevel = resolveEffort(
      engineConfig,
      currentSession,
      employee,
      effortLevelsForModel(config, currentSession.engine, currentSession.model ?? undefined),
    );
    let modelForTurn = currentSession.model ?? engineConfig.model;
    const baseContextOptions: Omit<BuildContextOptions, "model"> = {
      source: currentSession.source,
      channel: currentSession.sourceRef,
      user: currentSession.userId ?? "web-user",
      employee,
      engine: currentSession.engine,
      connectors: Array.from(context.connectors.keys()),
      config,
      gatewayBootId: context.gatewayBootId,
      sessionId: currentSession.id,
      effortLevel,
      hierarchy: orgHierarchy,
      // The diet keys off the built-in jinn server specifically — custom MCP
      // servers don't carry the company tools (same rule as manager.ts).
      jinnMcpAttached: Boolean(resolvedMcp?.mcpServers?.["jinn"]),
      // Hands-free voice orchestrator: layer its persona on top of the base
      // identity so it behaves as the thin voice layer above the COO.
      voicePersona: currentSession.source === "talk" ? getOrchestratorPersona() : undefined,
      talkThreads:
        currentSession.source === "talk"
          ? listChildSessions(currentSession.id).slice(0, 12).map((c) => ({
              id: c.id,
              label: c.title || "(untitled)",
              status: c.status,
              lastActivity: c.lastActivity,
            }))
          : undefined,
    };
    const preparePlatformContext = (model: string | undefined) => {
      const contextOptions: BuildContextOptions = { ...baseContextOptions, model };
      const snapshot = buildPlatformContextSnapshot(contextOptions);
      const fingerprint = fingerprintPlatformContext(snapshot);
      const refresh = resumeRefAtTurnStart.id
        && resumeRefAtTurnStart.platformContextFingerprint !== fingerprint
        ? buildPlatformContextRefresh(snapshot)
        : undefined;
      return { fingerprint, refresh, systemPrompt: buildContext(contextOptions) };
    };
    let platformContextFingerprint = "";
    let platformContextRefresh: string | undefined;
    let systemPrompt = "";

    let lastHeartbeatAt = 0;
    runHeartbeat = setInterval(() => {
      // If the session was deleted mid-turn, stop heartbeating immediately —
      // the engine.run promise may still take minutes to resolve, and we don't
      // want to keep writing status:"running" rows for a session the user
      // already removed (and risk re-creating registry state in some paths).
      if (!getSession(currentSession.id)) {
        if (runHeartbeat) clearInterval(runHeartbeat);
        runHeartbeat = undefined;
        return;
      }
      updateSessionForAttempt(currentSession.id, attemptToken, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
    }, 5000);

    // Mid-turn persistence: mirror the live stream into `partial` DB rows so a
    // refresh restores in-progress blocks. Coalesced — text grows ONE row
    // (debounced, never per-token, so SQLite isn't hammered); each tool call is
    // its own row. All wiped + replaced by the single final message at turn end
    // (deletePartialMessages below). Only the primary engine stream is mirrored;
    // the rate-limit fallback stream stays WS-only (rare path).
    const partialStream = createPartialStreamWriter(currentSession.id);

    const syncMeta = (currentSession.transportMeta || {}) as Record<string, unknown>;
    const switchSyncTarget = typeof syncMeta.engineSyncTarget === "string" ? syncMeta.engineSyncTarget : null;
    const switchSyncSinceIso = typeof syncMeta.engineSyncSince === "string" ? syncMeta.engineSyncSince : null;
    const switchSyncSinceMs = switchSyncSinceIso ? new Date(switchSyncSinceIso).getTime() : NaN;
    const engineSyncRequested =
      switchSyncTarget === engineAtTurnStart &&
      typeof switchSyncSinceIso === "string" &&
      Number.isFinite(switchSyncSinceMs);
    const claudeSyncSinceIso = typeof syncMeta.claudeSyncSince === "string" ? syncMeta.claudeSyncSince : null;
    const claudeSyncSinceMs = claudeSyncSinceIso ? new Date(claudeSyncSinceIso).getTime() : NaN;
    const claudeSyncRequested =
      engineAtTurnStart === "claude" &&
      typeof claudeSyncSinceIso === "string" &&
      Number.isFinite(claudeSyncSinceMs);
    const syncRequested = engineSyncRequested || claudeSyncRequested;
    const promptToRun = syncRequested
      ? (() => {
        const sinceMs = engineSyncRequested ? switchSyncSinceMs : claudeSyncSinceMs;
        const recentMessages = getMessages(currentSession.id).filter((m) => m.timestamp >= sinceMs);
        const sinceMessages = recentMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        const latestMessage = recentMessages.at(-1);
        const currentPromptWasIncluded =
          latestMessage &&
          (latestMessage.role === "user" || latestMessage.role === "assistant") &&
          latestMessage.content === prompt;
        const currentPrompt = currentPromptWasIncluded || !prompt.trim()
          ? ""
          : `CURRENT MESSAGE:\n${prompt}`;
        const intro = engineSyncRequested
          ? `We switched engines in this Jinn session. Sync your context with this transcript (most recent last), then respond to the current message.`
          : `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the current message.`;
        return [intro, transcript, currentPrompt].filter(Boolean).join("\n\n");
      })()
      : prompt;

    const turnStartedAt = Date.now();
    const runAttempt = (modelForAttempt: string | undefined) => {
      const prepared = preparePlatformContext(modelForAttempt);
      platformContextFingerprint = prepared.fingerprint;
      platformContextRefresh = prepared.refresh;
      systemPrompt = prepared.systemPrompt;
      return engine.run({
      prompt: promptToRun,
      resumeSessionId: resumeRefAtTurnStart.id ?? undefined,
      systemPrompt,
      platformContextRefresh,
      cwd: JINN_HOME,
      bin: engineConfig.bin,
      model: modelForAttempt,
      effortLevel,
      cliFlags: employee?.cliFlags,
      mcpConfigPath,
      resolvedMcp,
      attachments: attachments?.length ? attachments : undefined,
      sessionId: currentSession.id,
      source: currentSession.source,
      onStream: (delta) => {
        // Same guard as runHeartbeat: a delta may arrive after the user
        // deleted the session; don't resurrect registry state for it.
        if (!getSession(currentSession.id)) return;
        const normalized = normalizeBlockDeltaForTurn(delta, turnStartedAt);
        if (!normalized.ok) {
          logger.warn(`Dropped invalid block delta for session ${currentSession.id}: ${normalized.error}`);
          return;
        }
        const outgoingDelta = normalized.delta;
        // Live context-meter: message_start.usage arrives as a `context` delta
        // (once per assistant message — infrequent). Persist it immediately so the
        // meter ticks during the turn, not just at completion. The delta also flows
        // to the FE below for an instant in-pane update.
        if (outgoingDelta.type === "context") {
          // Only the MAIN agent's stream reaches here (the proxy suppresses
          // sub-agent/auxiliary streams), so its usage drives the session meter.
          const ctx = Number(outgoingDelta.content);
          if (Number.isFinite(ctx) && ctx > 0) {
            updateSessionForAttempt(currentSession.id, attemptToken, { lastContextTokens: ctx });
          }
        }
        const now = Date.now();
        if (now - lastHeartbeatAt >= 2000) {
          lastHeartbeatAt = now;
          updateSessionForAttempt(currentSession.id, attemptToken, {
            status: "running",
            lastActivity: new Date(now).toISOString(),
          });
        }
        try {
          context.emit("session:delta", {
            sessionId: currentSession.id,
            type: outgoingDelta.type,
            content: outgoingDelta.content,
            toolName: outgoingDelta.toolName,
            toolId: outgoingDelta.toolId,
            activityReceiptId: outgoingDelta.activityReceiptId,
            input: outgoingDelta.input,
            block: outgoingDelta.block,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
        // Mirror the block into a persisted partial row (refresh survival). Guarded
        // so a DB hiccup never breaks the live stream above.
        try {
          partialStream.persist(outgoingDelta);
        } catch (err) {
          logger.warn(`Failed to persist partial block for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
        // Voice mode: stream the orchestrator's spoken text — complete sentences
        // synthesize immediately (per-sentence streaming); the flush at completion
        // speaks the remainder. Only `text` deltas are spoken; tool_use/context
        // are not. Skip entirely when the client is muted (silent/read mode) —
        // there's no point buffering or synthesizing audio the browser will discard.
        if (
          currentSession.source === "talk" &&
          !isTalkMuted(currentSession.id) &&
          outgoingDelta.type === "text" &&
          typeof outgoingDelta.content === "string"
        ) {
          feedTalkText(currentSession.id, outgoingDelta.content, config.talk?.kokoro, context.emit);
        }
      },
      // A turn that settled as failed but whose CLI later finished delivers the
      // recovered text here. Append it and restore a clean idle status — unless
      // the session is gone or a NEW turn owns it (status back to "running").
      onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
        const recovered = updateSessionForAttempt(currentSession.id, attemptToken, {
          status: "idle",
          attemptOutcome: "succeeded",
          lastActivity: new Date().toISOString(),
          lastError: null,
        }, ["error"]);
        if (!recovered || recovered.engine !== engineAtTurnStart) return;
        insertMessage(currentSession.id, "assistant", lateText);
        if (engineSid.trim()) {
          recordEngineSessionId(currentSession.id, engineAtTurnStart, engineSid, {
            model: modelForAttempt,
            effortLevel,
            lastSyncedAt: new Date().toISOString(),
            platformContextFingerprint: prepared.fingerprint,
          });
        }
        // The parent/channel already saw this turn fail — label the late answer
        // so it reads as a supersede, not a fresh unprompted turn.
        const labelled = `(recovered — this supersedes the earlier reported failure)\n\n${lateText}`;
        if (recovered) {
          notifyParentSession(recovered, { result: labelled, error: null }, { alwaysNotify: employee?.alwaysNotify });
          void deliverConnectorReply(recovered, labelled, context.connectors);
        }
        context.emit("session:completed", {
          sessionId: currentSession.id,
          employee: currentSession.employee || config.portal?.portalName || "Jinn",
          title: currentSession.title,
          result: lateText,
          error: null,
        });
        logger.info(`Web session ${currentSession.id} recovered by late Stop after a failed turn`);
      },
      }).finally(() => {
      // Stop any pending debounced text flush so it can't re-insert a partial row
      // after the turn-end cleanup below deletes them.
      partialStream.finish();
      });
    };
    let result = await runAttempt(modelForTurn);

    if (
      currentSession.engine === "claude"
      && result.error
      && !result.result.trim()
      && getSession(currentSession.id)?.attemptToken === attemptToken
      && getSession(currentSession.id)?.status === "running"
    ) {
      await refreshClaudeModels(config);
      const refreshedRegistry = getModelRegistry(context.getConfig());
      const fallbackModel = selectClaudeModelFallback({
        engine: currentSession.engine,
        requestedModel: modelForTurn,
        error: result.error,
        models: refreshedRegistry.claude?.models ?? [],
      });
      if (fallbackModel) {
        logger.warn(`Claude model "${modelForTurn}" failed availability check; retrying session ${currentSession.id} with "${fallbackModel}"`);
        deletePartialMessages(currentSession.id);
        if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
        modelForTurn = fallbackModel;
        updateSession(currentSession.id, { model: fallbackModel, lastError: null });
        result = await runAttempt(modelForTurn);
      }
    }

    if (runHeartbeat) {
      clearInterval(runHeartbeat);
      runHeartbeat = undefined;
    }

    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    const liveAfterRun = getSession(currentSession.id);
    if (liveAfterRun?.engine !== engineAtTurnStart) {
      deletePartialMessages(currentSession.id);
      clearSupersededTurnMeta(currentSession.id);
      if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
      logger.info(
        `Dropping stale ${engineAtTurnStart} result for session ${currentSession.id}; session now uses ${liveAfterRun?.engine ?? "unknown"}`,
      );
      return;
    }

    const completionTurn = (liveAfterRun?.attemptTurn ?? currentSession.attemptTurn ?? 0) + 1;
    const wasInterrupted = Boolean(
      liveAfterRun
      && isDurableWorkflowUserMessageInterruption(liveAfterRun, completionTurn),
    ) || result.error?.startsWith("Interrupted");
    const wasSuperseded = !wasInterrupted && isTurnSuperseded(currentSession.id, turnStartedAt);
    const attemptStillRunning = liveAfterRun?.attemptToken === attemptToken && liveAfterRun.status === "running";
    const quietPreempted = wasInterrupted || wasSuperseded || !attemptStillRunning;

    // Turn settled. Preserve the same completed evidence the live React path
    // keeps: interim prose, tools, media, and delegation/dispatch blocks. Exact
    // streamed copies of the result and transient task-list blocks are dropped;
    // the canonical final assistant row is inserted below. Preempted, limited,
    // and result-less turns keep the old cleanup semantics.
    const streamedBlocks = getPartialMessages(currentSession.id);
    const rateLimit = !quietPreempted ? detectRateLimit(result) : { limited: false as const };
    const preservedMessageIds = completedStreamedBlockIds({
      quietPreempted,
      rateLimited: rateLimit.limited,
      result: result.result,
      error: result.error,
      streamedBlocks,
    });
    // Durable structured blocks remain on their evidence row. Transient blocks
    // are deliberately not copied onto the final answer (live completion drops
    // task-list/progress rows), so the final boundary stays plain and canonical.
    settlePartialMessages(currentSession.id, preservedMessageIds);
    const streamedThrough = streamedBlocks.reduce((latest, message) => Math.max(latest, message.timestamp), 0);

    if (rateLimit.limited) {
      // Drop any buffered voice text — we won't speak a rate-limited turn.
      if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
      const emitDelta = (delta: StreamDelta) => {
        const normalized = normalizeBlockDeltaForTurn(delta, turnStartedAt);
        if (!normalized.ok) {
          logger.warn(`Dropped invalid rate-limit block delta for session ${currentSession.id}: ${normalized.error}`);
          return;
        }
        const outgoingDelta = normalized.delta;
        context.emit("session:delta", {
          sessionId: currentSession.id,
          type: outgoingDelta.type,
          content: outgoingDelta.content,
          toolName: outgoingDelta.toolName,
          toolId: outgoingDelta.toolId,
          block: outgoingDelta.block,
        });
      };

      const outcome = await handleRateLimit({
        session: currentSession,
        attemptToken,
        prompt,
        systemPrompt,
        platformContextRefresh,
        engineConfig,
        effortLevel,
        cliFlags: employee?.cliFlags,
        // Carry the resolved MCP set into the rate-limit retry/fallback turn so a
        // web session that hits a usage limit keeps its MCP tools on recovery —
        // parity with the connector path (manager.ts runSession → handleRateLimit).
        mcpConfigPath,
        resolvedMcp,
        attachments: attachments?.length ? attachments : undefined,
        config,
        engines: context.sessionManager.getEngines(),
        employee,
        engine,
        rateLimit,
        originalResult: result,
        hooks: {
          onFallbackStart: ({ resumeAt }) => {
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;
            const notificationText =
              `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`;
            insertMessage(currentSession.id, "notification", notificationText);

            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} switching to GPT.`,
            );

            // Switching away from Claude — drop any warm Claude PTY AND its armed
            // late-recovery listener so the abandoned claude turn can't double-answer
            // after the GPT fallback delivers.
            const claudeEngine = context.sessionManager.getEngines().get("claude");
            if (claudeEngine && isInterruptibleEngine(claudeEngine)) {
              claudeEngine.kill(currentSession.id, "Interrupted: engine switched");
            }
          },
          onFallbackStream: emitDelta,
          onFallbackComplete: (fallbackResult) => {
            if (fallbackResult.result) {
              insertMessage(currentSession.id, "assistant", fallbackResult.result);
            }

            const fallbackCompletedAt = new Date().toISOString();
            if (fallbackResult.sessionId?.trim()) {
              const fallbackEngineName = getSession(currentSession.id)?.engine ?? currentSession.engine;
              recordEngineSessionId(currentSession.id, fallbackEngineName, fallbackResult.sessionId, {
                model: modelForTurn,
                effortLevel,
                lastSyncedAt: fallbackCompletedAt,
              });
            }
            // Same accounting as manager.ts — this runner used to skip it, so
            // every web/talk session recorded zero turns and zero cost.
            recordTurnAccounting(currentSession.id, fallbackResult);
            const completedFallback = completeSessionAttempt(currentSession.id, attemptToken, {
              status: fallbackResult.error ? "error" : "idle",
              attemptOutcome: fallbackResult.error ? "failed" : "succeeded",
              lastActivity: fallbackCompletedAt,
              lastError: fallbackResult.error ?? null,
            });
            if (completedFallback) {
              notifyParentSession(completedFallback, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
              // Relay the fallback turn to the originating connector channel (#51).
              if (fallbackResult.result) void deliverConnectorReply(completedFallback, fallbackResult.result, context.connectors);
            }

            if (completedFallback) {
              context.emit("session:completed", {
                sessionId: currentSession.id,
                employee: currentSession.employee || config.portal?.portalName || "Jinn",
                title: currentSession.title,
                result: fallbackResult.result,
                error: fallbackResult.error || null,
                cost: fallbackResult.cost,
                durationMs: fallbackResult.durationMs,
              });
              maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
            }
          },
          onWaitingStart: ({ resumeAt }) => {
            const engineLabel = rateLimitEngineLabel(currentSession.engine);
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;

            // Send hardcoded Discord notification — does not depend on the LLM
            notifyDiscordChannel(
              `⚠️ ${engineLabel} usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
            );

            const notificationText =
              `⏳ ${engineLabel} usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`;
            insertMessage(currentSession.id, "notification", notificationText);

            // Notify parent session about rate limit (fire-and-forget)
            const waitingSession = getSession(currentSession.id);
            notifyRateLimited(
              (waitingSession ?? { ...currentSession, status: "waiting" }) as Session,
              resumeAt
                ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                : undefined,
            );

            context.emit("session:rate-limited", {
              sessionId: currentSession.id,
              employee: currentSession.employee,
              error: result.error,
              resetsAt: rateLimit.resetsAt ?? null,
            });
          },
          onRetryStream: emitDelta,
          onRetrySuccess: (retryResult) => {
            const engineLabel = rateLimitEngineLabel(currentSession.engine);
            // Usage limit cleared — handle result
            if (retryResult.result) {
              insertMessage(currentSession.id, "assistant", retryResult.result);
            }

            const retryCompletedAt = new Date().toISOString();
            if (!retryResult.error && retryResult.sessionId?.trim()) {
              recordEngineSessionId(currentSession.id, engineAtTurnStart, retryResult.sessionId, {
                model: modelForTurn,
                effortLevel,
                lastSyncedAt: retryCompletedAt,
                platformContextFingerprint,
              });
            }
            recordTurnAccounting(currentSession.id, retryResult);
            const completedAfterRetry = completeSessionAttempt(currentSession.id, attemptToken, {
              status: retryResult.error ? "error" : "idle",
              attemptOutcome: retryResult.error ? "failed" : "succeeded",
              lastActivity: retryCompletedAt,
              lastError: retryResult.error ?? null,
            });

            if (completedAfterRetry) {
              notifyRateLimitResumed(completedAfterRetry);
              notifyDiscordChannel(
                `✅ ${engineLabel} usage limit cleared. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} resumed.`,
              );
              notifyParentSession(completedAfterRetry, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
              // Relay the resumed (rate-limit-cleared) turn to the originating connector channel (#51).
              if (retryResult.result) void deliverConnectorReply(completedAfterRetry, retryResult.result, context.connectors);
            }

            if (completedAfterRetry) {
              context.emit("session:completed", {
                sessionId: currentSession.id,
                employee: currentSession.employee || config.portal?.portalName || "Jinn",
                title: currentSession.title,
                result: retryResult.result,
                error: retryResult.error || null,
                cost: retryResult.cost,
                durationMs: retryResult.durationMs,
              });
              maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
            }
          },
          onTimeout: () => {
            const engineLabel = rateLimitEngineLabel(currentSession.engine);
            const timeoutError = `${engineLabel} usage limit did not clear in time`;
            notifyDiscordChannel(
              `❌ ${timeoutError}. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} has been stopped.`,
            );
            const erroredSession = updateSessionForAttempt(currentSession.id, attemptToken, {
              status: "error",
              lastActivity: new Date().toISOString(),
              lastError: timeoutError,
            }, ["waiting", "running"]);
            if (erroredSession) {
              notifyParentSession(erroredSession, { error: timeoutError }, { alwaysNotify: employee?.alwaysNotify });
            }
            if (erroredSession) {
              context.emit("session:completed", {
                sessionId: currentSession.id,
                result: null,
                error: timeoutError,
              });
              maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
            }
          },
        },
      });

      void outcome; // outcome handled entirely via hooks
      return;
    }

    // Persist the assistant response
    if (shouldPersistFinalAssistantMessage({
      resultText: result.result,
      quietPreempted,
    })) {
      insertMessageAfter(
        currentSession.id,
        "assistant",
        result.result,
        streamedThrough,
      );
    } else if (!quietPreempted && result.error && !result.result.trim()) {
      insertMessageAfter(
        currentSession.id,
        "assistant",
        formatEngineErrorAssistantMessage(result.error),
        streamedThrough,
      );
    }

    // Voice mode: flush the remainder of the turn's spoken text (final chunk,
    // carries last:true). Fire-and-forget so completion isn't blocked on audio.
    // Discard (don't synthesize) on a half-finished interrupt OR when the client
    // is muted — the browser plays nothing in silent mode.
    if (currentSession.source === "talk") {
      if (quietPreempted || isTalkMuted(currentSession.id)) discardTalkSpeech(currentSession.id);
      else void flushTalkSpeech(currentSession.id, config.talk?.kokoro, context.emit);
    }

    const completedAt = new Date().toISOString();
    const acceptedNativeId = result.sessionId?.trim() || resumeRefAtTurnStart.id;
    if (!quietPreempted && !result.error && acceptedNativeId) {
      recordEngineSessionId(currentSession.id, engineAtTurnStart, acceptedNativeId, {
        model: modelForTurn,
        effortLevel,
        lastSyncedAt: completedAt,
        platformContextFingerprint,
      });
    }
    recordTurnAccounting(currentSession.id, result);
    const completedSession = completeSessionAttempt(currentSession.id, attemptToken, {
      ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
      // Preserve interruption as an explicit terminal receipt. Conversational
      // idleness is not proof that an execution attempt succeeded.
      status: quietPreempted ? "interrupted" : (result.error ? "error" : "idle"),
      attemptOutcome: quietPreempted ? "interrupted" : (result.error ? "failed" : "succeeded"),
      lastActivity: completedAt,
      lastError: quietPreempted ? (result.error ?? "Interrupted") : (result.error ?? null),
    });
    if (!quietPreempted && engineAtTurnStart === "claude") {
      markTranscriptSyncedThrough(currentSession.id, result.sessionId);
    }
    if (syncRequested && !rateLimit.limited && !quietPreempted) {
      const meta = (getSession(currentSession.id)?.transportMeta || currentSession.transportMeta || {}) as Record<string, unknown>;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const nextMeta = { ...meta } as Record<string, unknown>;
        delete nextMeta["claudeSyncSince"];
        delete nextMeta["engineSyncTarget"];
        delete nextMeta["engineSyncSince"];
        updateSession(currentSession.id, { transportMeta: nextMeta as any });
      }
    }
    clearSupersededTurnMeta(currentSession.id);
    const reportedError = quietPreempted ? null : (result.error ?? null);
    if (completedSession && !quietPreempted) {
      notifyParentSession(completedSession, { result: result.result, error: reportedError, cost: result.cost, durationMs: result.durationMs }, { alwaysNotify: employee?.alwaysNotify });
    }

    // Relay the turn back to the originating connector channel (#51). Only
    // connector-sourced sessions reaching this path (parent callbacks, cron
    // follow-ups) deliver; web/talk/cron + interrupted turns no-op.
    if (completedSession && !quietPreempted && result.result) {
      await deliverConnectorReply(completedSession, result.result, context.connectors);
    }

    if (completedSession) {
      context.emit("session:completed", {
        sessionId: currentSession.id,
        employee: currentSession.employee || config.portal?.portalName || "Jinn",
        title: currentSession.title,
        result: quietPreempted ? null : result.result,
        error: reportedError,
        cost: result.cost,
        durationMs: result.durationMs,
      });
      maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    }

    logger.info(
      `Web session ${currentSession.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const live = getSession(currentSession.id);
    if (!live) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
      return;
    }
    if (live.engine !== engineAtTurnStart) {
      if (runHeartbeat) {
        clearInterval(runHeartbeat);
        runHeartbeat = undefined;
      }
      deletePartialMessages(currentSession.id);
      clearSupersededTurnMeta(currentSession.id);
      if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
      logger.info(
        `Dropping stale ${engineAtTurnStart} error for session ${currentSession.id}; session now uses ${live.engine}`,
      );
      return;
    }
    // The run threw — drop any orphaned mid-turn partial blocks.
    deletePartialMessages(currentSession.id);
    const erroredSession = completeSessionAttempt(currentSession.id, attemptToken, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
    }
    if (erroredSession) {
      context.emit("session:completed", {
        sessionId: currentSession.id,
        result: null,
        error: errMsg,
      });
      maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    }
    logger.error(`Web session ${currentSession.id} error: ${errMsg}`);
  } finally {
    if (runHeartbeat) {
      clearInterval(runHeartbeat);
      runHeartbeat = undefined;
    }
    // NOTE: the per-session Claude --mcp-config file is deliberately NOT deleted
    // here. Only the interactive (PTY) engine writes one, and a warm PTY keeps that
    // path on its command line across turns — a cold respawn (model/effort change)
    // re-reads it, so deleting it per turn silently strips the jinn MCP server and
    // every tool call fails with "caller identity unavailable". Its lifetime is owned
    // by PtyLifecycleManager (onCleanup → cleanupMcpConfigFile), mirroring the
    // per-session --settings file.
  }
}

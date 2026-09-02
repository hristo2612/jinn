import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { ChatBlockEnvelope, DelegatedActivity, Employee, Engine, JinnConfig, JsonObject, Session } from "../shared/types.js";
import { isInterruptibleEngine, reportsTurnProgress, STRUCTURED_MESSAGE_BODY_MAX_CHARS } from "../shared/types.js";
import { resolveStaleChatPolicy } from "../shared/stale-chat.js";
export { compactEmployeeRole } from "../shared/employee-role.js";
import {
  getModelRegistry,
  invalidateModelRegistry,
  refreshAntigravityModels,
  refreshClaudeModels,
  refreshCodexModels,
  refreshGrokModels,
  refreshHermesModels,
  refreshPiModels,
} from "../shared/models.js";
import { withEngineHealth } from "../shared/engine-health.js";
import { validateNewSessionSelection, validateSessionPatch } from "../sessions/session-patch.js";
import { buildDelegatedActivityIndex } from "../sessions/delegated-activity.js";
import { maybeRevertEngineOverride, type SessionManager } from "../sessions/manager.js";
import { runtimeSessionSource } from "../sessions/context.js";
import { stripControlChars, hasControlBytes } from "../shared/sanitize.js";
import { CONNECTOR_ID_REQUIREMENTS, isValidConnectorId } from "../shared/connector-id.js";
import { initDb } from "../shared/db.js";
import {
  listSessions,
  listPinnedSessions,
  listChatPins,
  pinChat,
  unpinChat,
  countSessions,
  listRecentPerGroup,
  listSessionsForGroup,
  getSessionGroupCounts,
  coercePortalEmployee,
  searchSessions,
  getMessageContext,
  getCostReport,
  MESSAGE_CONTEXT_MAX_RADIUS,
  listChildSessions,
  listSessionsByWorkItem,
  getSession,
  getEngineSessionRef,
  createSession,
  updateSession,
  archiveSession,
  unarchiveSession,
  recordEngineSessionId,
  switchSessionEngine,
  clearEngineSessionRefs,
  UpdateSessionFields,
  deleteSession,
  deleteSessions,
  duplicateSession,
  insertMessage,
  applyBlockEnvelope,
  getMessages,
  getMessagePage,
  enqueueQueueItem,
  cancelQueueItem,
  markRunningQueueItemsCompletedForSession,
  listAllPendingQueueItems,
  getSessionDelivery,
  getSessionDeliveryByQueueItemId,
  listDeadLetterSessionDeliveries,
  requeueDeadLetterSessionDelivery,
  acceptSessionDelivery,
  getFile,
  getSessionBySessionKey,
  recordChildReportedToParent,
  RESTART_ACK_META_KEY,
  RESTART_RESUME_META_KEY,
} from "../sessions/registry.js";
import { claimIncomingTurn, lateralSendDedupeKey } from "../sessions/incoming-turn.js";
import { blockFallbackText, validateBlockEnvelope } from "../shared/blocks.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../sessions/workflow-interruptions.js";
export {
  foldPartialText,
  normalizeBlockDeltaForTurn,
} from "../sessions/partial-stream.js";
import { forkEngineSession } from "../sessions/fork.js";
import { cleanUpDeletedSession } from "./session-cleanup.js";
import { ptySnapshotStore } from "../engines/pty-snapshot.js";
import { configDocumentForApi, deepMerge } from "./config-payload.js";
export { isSensitiveConfigKey, sanitizeConfigForApi } from "./config-payload.js";
import {
  CONFIG_CONFLICT_BODY,
  CONFIG_REVISION_HEADER,
  currentConfigRevision,
  isStaleConfigRevision,
} from "./config-revision.js";
import {
  CONFIG_PATH,
  ORG_DIR,
  LOGS_DIR,
  TMP_DIR,
  FILES_DIR,
  STT_SETTINGS_FILE,
  resolveHomeIdentity,
} from "../shared/paths.js";
import { CONFIG_TOP_LEVEL_KEYS, saveConfigAtomic, gatewayEnvOverrides, validateConfigShape } from "../shared/config.js";
import { messageBodyError } from "../shared/message-body.js";
import { logger } from "../shared/logger.js";
import { redactText } from "../shared/redact.js";
import { getSttStatus, downloadModel, transcribe as sttTranscribe, WHISPER_LANGUAGES } from "../stt/stt.js";
import {
  getEffectiveSttSettings,
  writeSharedSttSettings,
} from "../stt/settings-store.js";
import { CODEX_HOMES_DIR, JINN_HOME } from "../shared/paths.js";
import { resolveClaudeConfigDir } from "../shared/home.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { supersedeRunningTurn } from "../sessions/turn/superseded.js";
import { dispatchWebSessionRun, resolveAttachmentPaths } from "./web-session-dispatch.js";
import { spawnSession } from "./spawn-session.js";
export { deliverConnectorReply } from "./connector-reply.js";
export {
  formatEngineErrorAssistantMessage,
  shouldPersistFinalAssistantMessage,
} from "../sessions/turn/text.js";
import { preflightSystemEmployee } from "./system-employee-spawn.js";
import { getPackageVersion } from "../shared/version.js";
import { badRequest, json, matchRoute, notFound, serverError, type ResWithEncoding } from "./route-helpers.js";
import { handleSessionQueueRoute } from "./queue-routes.js";
export { matchRoute } from "./route-helpers.js";
import { handleCronApi } from "./cron-api.js";
import { handleOrgApi } from "./org-api.js";
import { handleTodoCaptureApi } from "./todo-capture-api.js";
import { handleSkillsApi } from "./skills-api.js";
import { handleSearchApi } from "./search-api.js";
import { pluginAdminAction } from "./plugins-admin-api.js";
import { handlePluginsApi } from "./plugins-api.js";
import { handleExperimentsApi } from "./experiments-api.js";
import QRCode from "qrcode";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { handleFilesRequest, handleSessionAttachment, fileIdsToMedia, rehomeAttachmentsToSession, mimeFromFilename, MultipartUploadError, readLocalFileForIngestion, readMultipartFile, sanitizeUploadFilename, isFileNotModified } from "./files.js";
import { streamFile } from "./byte-range.js";
import { selectAttachmentVariant } from "./attachment-variants.js";
import { readJsonBody, readBodyRaw } from "./http-helpers.js";
import { applyLabelChange, parseLabelChange } from "./work-item-label-change.js";
import { resolveMessageAudiences, speechContextApplies } from "./speech-context.js";
import { isJsonMediaType } from "./media-type.js";
import { forwardWorkflowTodoComment } from "./workflow-todo-surface.js";
import { recoverPendingSessionDeliveries } from "../sessions/callbacks.js";
import { clearDelegationCompletionContract, DELEGATION_COMPLETION_TRACKED_META_KEY } from "../sessions/delegation-completion-contract.js";
import { clipSessionMessage, sessionCommGuards, prepareLateralSend, isDescendantOf, resolveCallerIdentity, type CallerIdentity } from "./session-comm-guards.js";
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
  getWorkItems,
  getWorkItemTree,
  getWorkItemTrees,
  linkSession,
  listWorkItemEventsForItems,
  queryWorkItems,
  STICKY_STATUSES,
  updateWorkItemConditional,
  WorkItemIdempotencyConflictError,
  WorkItemVersionConflictError,
  type CreateWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from "../work-items/store.js";
import { validateVerifyPolicy } from "../work-items/verify-policy.js";
import { resolveTodoEditAuthority, todoEditRefusal } from "./todo-edit-authority.js";
import { isTodoId, resolveTodoIdPrefix } from "../work-items/id.js";
import {
  addComment,
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
  removeRelation,
  WorkItemRelationError,
  type RelationKind,
} from "../work-items/relations.js";
import {
  createLabel,
  listLabels,
  setWorkItemLabels,
  TODO_LABELS_MAX,
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
import { readWriteOrigin, writeDetail, WRITE_ORIGIN_HEADER } from "../work-items/origin.js";
import { authorizeActingAsOperator, resolveArmingDelegate, workItemActor, type WorkItemCaller } from "./work-item-arming.js";
import { authorizeAgentWorkItemStatus, authorizeWorkItemOwnerManagerOrRoot, ownsWorkItem } from "./work-item-authority.js";
import { fullWorkItemPayload, openWorkItemPayload, workItemPagePayload } from "./work-item-payload.js";
import { listDepartmentsWithCounts } from "../work-items/departments.js";
import { parseStatusUpdateFields } from "./work-item-status-fields.js";
import { assignWorkItem, transition, TransitionError } from "../work-items/transitions.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import { openWorkItemRun } from "../work-items/runs.js";
import {
  archiveWorkItem,
  ApprovalChoiceError,
  currentApproval,
  decideWorkItemApproval,
  escalateApproval,
  requestApproval,
} from "../work-items/approvals.js";
import { resolveApprovalDecisionAuthority, resolveRootApprovalTarget, type ApprovalDecisionAuthorityOptions } from "./approval-authority.js";
import { approvalGateClass } from "./workflow-todo-binding.js";
import { orgRegistry } from "./org-registry.js";
import { TODO_DISPATCHER_NAME } from "./system-employees.js";
import { claimTodoForDelegation, claimTodoForDispatch } from "./todo-claim.js";
import {
  hasSupportedTodoEditContentEncoding,
  readTodoEditPrecondition,
  todoEditContentLength,
  todoEditValidationError,
} from "./todo-edit-precondition.js";
import { createWorkItemIdempotent, WorkItemCreateIdempotencyConflictError } from "../work-items/create-idempotency.js";
import { resolveTodoDispatch, setTodoDispatchConfig } from "../work-items/dispatch-config.js";
import {
  ISO_DATE_OR_INSTANT,
  readCleanSearchParam,
  readWorkItemQueryParams,
  SEARCH_QUERY_ROUTE_CHAR_CAP,
} from "./work-item-query.js";
import { surfaceManagerVisibility } from "./manager-visibility.js";
import { NOTE_FILE_MAX_BYTES, createNote, listNotes, readKnowledgeFile, readNote, searchKnowledge, updateNote, type NoteStoreResult } from "../notes/store.js";
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
import { scheduleOnLoadTailSync, transcriptEntryText } from "./external-turns.js";
import { handleTalkApi } from "./talk-api.js";
import { onboardingNeeded, applyEngineChoice, personalizeOperatingManual } from "./onboarding-policy.js";
import {
  CONTAINER_RESTART_UNSUPPORTED_MESSAGE,
  restartDetached,
  type RestartDetachedOptions,
} from "./lifecycle.js";
import type { WorkflowService } from "../workflows/service.js";
import { handleWorkflowApi } from "./workflow-api.js";
import { handleHeartbeatApi } from "./heartbeat-api.js";
import { handleWorkItemKeptApi } from "./work-item-kept-api.js";

/** Max bytes accepted on /api/internal/hook (loopback-only relay payloads are tiny). */
const HOOK_BODY_MAX_BYTES = 64 * 1024;
/** Max bytes accepted by public auth helpers. Codes/tokens are tiny. */
const AUTH_BODY_MAX_BYTES = 16 * 1024;
/** Operator Todo PATCH cap, measured as raw UTF-8 request bytes including JSON overhead. */
export const TODO_EDIT_BODY_MAX_BYTES = 64 * 1024;
const SESSION_LIST_PER_GROUP = 50;
const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000;
function headerValue(req: HttpRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseMessageLimit(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(500, parsed);
}

export interface ApiContext {
  config: JinnConfig;
  sessionManager: SessionManager;
  startTime: number;
  /** Opaque process-generation id used only in platform-context fingerprints. */
  gatewayBootId?: string;
  getConfig: () => JinnConfig;
  emit: GatewayEmit;
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
  backgroundActivity?: Map<string, {
    activeStreams: number;
    activeAgents?: number;
    activeMonitors?: number;
    lastActivityAt: number;
  }>;
  /** Gateway auth token for seamless browser/CLI access when auth is required. */
  gatewayAuthToken?: string;
  /** Test-injectable Jinn home for auth device storage. Defaults to shared JINN_HOME. */
  jinnHome?: string;
  /** Test-injectable gateway restart primitive. Defaults to lifecycle.restartDetached(). */
  restartGateway?: (options: RestartDetachedOptions) => void;
  /** Immutable port actually bound by this gateway process, unaffected by config hot reload. */
  runtimePort?: number;
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

type MemoryTrialHookRouteInjection = Pick<
  import("../memory-trial/hook-adapter.js").MemoryTrialHookRouteOptions,
  "enabled" | "circuitOpen" | "activationEpoch" | "triggers" | "projectRoot" | "dispatch" | "operationStore"
>;

const memoryTrialGuards = new Map<string, Promise<import("../memory-trial/guardrails.js").MemoryTrialGuard>>();

function memoryTrialHookRouteOptions(context: ApiContext, hook: import("./hook-registry.js").HookPayload): MemoryTrialHookRouteInjection {
  const config = context.getConfig().memoryTrial;
  const directory = path.join(context.jinnHome ?? JINN_HOME, "state", "memory-trial");
  const enabled = config?.enabled === true;
  const circuitOpen = config?.circuitOpen !== false;
  const triggers = config?.triggers ?? [];
  return {
    enabled,
    circuitOpen,
    activationEpoch: config?.activationEpoch,
    triggers,
    projectRoot: config?.projectRoot,
    dispatch: async (claims) => {
      let guard = memoryTrialGuards.get(directory);
      if (!guard) {
        guard = import("../memory-trial/guardrails.js")
          .then(({ MemoryTrialGuard }) => MemoryTrialGuard.create(directory));
        memoryTrialGuards.set(directory, guard);
      }
      let additionalContext: string | undefined;
      await (await guard).runEffect(claims, async () => {
        const { runMemoryRuntimeEffect } = await import("../memory-trial/runtime-pipeline.js");
        additionalContext = await runMemoryRuntimeEffect({
          directory,
          claims,
          hook,
          autoArchiveProjectContent: config?.autoArchiveProjectContent === true,
        });
      }, {
        authorizedState: { enabled, circuitOpen, triggers },
      });
      return additionalContext;
    },
  };
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
    if (runtimeSessionSource(session.source) !== "web" && !callbackDelivery) continue;
    // Hot-reload calls this too: a row waiting its turn here is owned, not orphaned.
    if (context.sessionManager.getQueue().hasInFlightItem(item.id)) continue;
    session = maybeRevertEngineOverride(session);

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

    dispatchWebSessionRun(session, item.prompt, engine, context, { queueItemId: item.id });
    resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
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

function sessionHasRuntimeActivity(session: Session, context: ApiContext): boolean {
  const activity = context.backgroundActivity?.get(session.id);
  if (!activity) return false;
  const stale = activity.activeStreams <= 0
    && (activity.activeMonitors ?? 0) <= 0
    && Date.now() - activity.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
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

/** JSON escaping can expand one byte to six characters (for example NUL). */
const NOTES_BODY_ROUTE_MAX_BYTES = NOTE_FILE_MAX_BYTES * 6 + 64_000;

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

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['backlog', 'assigned', 'executing', 'in_review', 'done', 'blocked', 'escalated', 'cancelled'];
/** `backlog` is here because "not now" is a legitimate move: an agent that
 *  picked a Todo up and found it premature can put it back down. The sticky
 *  terminals are unreachable from here anyway — leaving `done`, `cancelled` or
 *  `escalated` still needs the human surface. */
const AGENT_WORK_ITEM_TARGETS: readonly WorkItemStatus[] = ['backlog', 'assigned', 'executing', 'in_review', 'blocked', 'escalated', 'done'];

function requireTodoRouteId(res: ServerResponse, value: string): boolean {
  if (isTodoId(value)) return true;
  badRequest(res, "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix");
  return false;
}

function resolveWorkItemCaller(req: HttpRequest, res: ServerResponse, context: ApiContext): WorkItemCaller | undefined {
  const identity = resolveScopedWriteCallerIdentity(req, context);
  if (identity.kind === "unidentified-tool" || identity.kind === "unauthenticated") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  if (identity.kind === "operator") return { kind: 'operator', origin: readWriteOrigin(req.headers[WRITE_ORIGIN_HEADER]) };
  const session = getSession(identity.callerId);
  if (!session) {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return undefined;
  }
  return { kind: 'session', callerId: identity.callerId, session, origin: readWriteOrigin(req.headers[WRITE_ORIGIN_HEADER]) };
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
  /** The row's status before this write, for the routes whose write can reach
   *  `transition()`. A status that moved was already announced live from there
   *  (ICI-749) — the seam every non-HTTP writer commits through — so emitting
   *  again here would double it. Assignment writes its own status change outside
   *  `transition()`, so that lane still announces itself here. */
  previousStatus?: WorkItemStatus,
): string | undefined {
  const target = verifiedActivityTarget(req.headers, context, TODO_ACTIVITY_TOOLS[action] ?? []);
  const announced = previousStatus !== undefined && previousStatus !== item.status;
  return persistAndEmitActivityBlock({
    context: chatActivityContext(context),
    ...target,
    envelope: todoActivityBlock(item, action),
    ...(!changed ? { idempotentReplay: true } : {}),
    ...(changed && !announced ? {
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

/** Who this Todo's pending gate is reserved for: the human operator (the Todo asked for it, or the
 *  workflow node it mirrors declared it), or the COO's own lane. Both decision surfaces read this
 *  one answer, so escalating cannot open a path that deciding refuses. */
function approvalReservation(item: WorkItem, service: WorkflowService | undefined): Pick<ApprovalDecisionAuthorityOptions, "operatorOnly" | "cooDecidable"> {
  const gate = approvalGateClass(item, service);
  return { operatorOnly: currentApproval(item.id)?.operatorOnly === true || gate === "operator", cooDecidable: gate === "coo" };
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
  if (method === "POST" && pathname === "/api/todo-captures") return "quick capture";
  if (method === "POST" && pathname === "/api/pins") return "chat pin update";
  if (method === "DELETE" && matchRoute("/api/pins/:key", pathname)) return "chat pin update";
  if (method === "DELETE" && matchRoute("/api/sessions/:id/queue/:itemId", pathname)) return "session queue item cancel";
  if (method === "PATCH" && matchRoute("/api/sessions/:id/queue/:itemId", pathname)) return "session queue item edit";
  if (method === "POST" && matchRoute("/api/sessions/:id/queue/:itemId/send-now", pathname)) return "session queue item send now";
  if (method === "DELETE" && matchRoute("/api/sessions/:id/queue", pathname)) return "session queue clear";
  if (method === "POST" && matchRoute("/api/sessions/:id/queue/pause", pathname)) return "session queue pause";
  if (method === "POST" && matchRoute("/api/sessions/:id/queue/resume", pathname)) return "session queue resume";
  if (method === "POST" && pathname === "/api/cron") return "cron create";
  if (method === "PUT" && matchRoute("/api/cron/:id", pathname)) return "cron update";
  if (method === "DELETE" && matchRoute("/api/cron/:id", pathname)) return "cron delete";
  if (method === "POST" && matchRoute("/api/cron/:id/trigger", pathname)) return "cron manual trigger";
  if (method === "PATCH" && matchRoute("/api/org/employees/:name", pathname)) return "org employee update";
  if (method === "DELETE" && matchRoute("/api/skills/:name", pathname)) return "skill removal";
  if (method === "PUT" && matchRoute("/api/skills/:name", pathname)) return "skill update";
  return pluginAdminAction(method, pathname);
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
    const employee = session?.employee ? orgRegistry(context.getConfig()).get(session.employee) : undefined;
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

/**
 * The parent a spawn or delegation is recorded under.
 *
 * A session caller is ALWAYS a parent. It may name another session it already
 * knows, but it can never mint a PARENTLESS child, because parentlessness is
 * the shape of the gateway's own top-level agent session
 * (`isPortalAgentSession`) and that shape carries operator-delegated authority.
 * An explicit `null` in the body used to slip through the "was it omitted?"
 * check and produce exactly that; it now collapses to the caller, as does an
 * id naming no session. The operator surface is unrestricted — it already holds
 * the authority a forged parentless child would be reaching for.
 */
function resolveSpawnParentSessionId(caller: CallerIdentity, requested: unknown, action: string): string | undefined {
  const requestedId = typeof requested === "string" ? requested : undefined;
  if (caller.kind !== "session") return requestedId;
  if (requestedId && getSession(requestedId)) return requestedId;
  if (getSession(caller.callerId)) return caller.callerId;
  logger.warn(`Ignoring unknown x-jinn-caller-session "${caller.callerId}" on ${action}`);
  return undefined;
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



/**
 * The refusal for a session trying to mint a child that IS the employee-
 * hierarchy root, or undefined when the spawn is fine.
 *
 * Root identity decides approvals the rest of the org cannot: it can approve any
 * Todo routed anywhere beneath it. A session that can obtain a root-identity
 * child holds that authority in two hops, so every route that mints a session
 * refuses it. Which route it takes does not matter, hence one helper for both.
 * The operator surface is unrestricted: it already holds the authority the
 * impersonation would be reaching for.
 *
 * Only an `employee` root can be impersonated. With no executive at the top,
 * `resolveRootApprovalTarget()` answers with a virtual root whose name belongs to
 * no employee — the spawn route already collapses that name to a plain session —
 * so there is nothing to claim and nothing is refused.
 */
function spawnAsRootRefusal(caller: CallerIdentity, employeeName: string | null | undefined): string | undefined {
  if (!employeeName || caller.kind !== "session") return undefined;
  const root = resolveRootApprovalTarget();
  if (root?.kind !== "employee" || employeeName !== root.name) return undefined;
  return `a session cannot run work as "${root.name}", the employee-hierarchy root, because that identity carries operator-delegated authority; request an approval or escalate the Todo to the root instead of running as it`;
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

/** Sessions already holding engine capacity: mid-turn, queued behind one, or parked on a gate.
 *  The delegated-activity index and a Workflow fan-out's ceiling both count exactly these. */
export function sessionsHoldingEngineCapacity(sessions: readonly Session[], context: ApiContext): Session[] {
  return sessions.filter((session) => session.status === "waiting" || ["running", "queued"].includes(getSessionTransportState(session, context)));
}

export function buildSessionDelegatedActivityIndex(
  sessions: readonly Session[],
  context: ApiContext,
): Map<string, DelegatedActivity> {
  return buildDelegatedActivityIndex(sessions, new Set(sessionsHoldingEngineCapacity(sessions, context).map((session) => session.id)));
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
  const bgIsStale = bg
    && bg.activeStreams <= 0
    && (bg.activeMonitors ?? 0) <= 0
    && Date.now() - bg.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
  if (bgIsStale) context.backgroundActivity?.delete(session.id);
  return {
    ...session,
    queueDepth,
    transportState,
    turnProgress: computeLiveTurnProgress(session, context),
    backgroundActivity: bg && !bgIsStale
      ? {
          activeStreams: bg.activeStreams,
          ...(bg.activeAgents !== undefined ? { activeAgents: bg.activeAgents } : {}),
          ...(bg.activeMonitors !== undefined ? { activeMonitors: bg.activeMonitors } : {}),
          lastActivityAt: new Date(bg.lastActivityAt).toISOString(),
        }
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
  // Stashed on `res` because that is what json() holds: ParsedRoute carries the target, not the headers.
  (res as ResWithEncoding).__acceptEncoding = req.headers["accept-encoding"];

  try {
    const jinnHome = context.jinnHome ?? JINN_HOME;

    const identifiedCaller = req.headers[TOOL_CALL_HEADER] !== undefined || req.headers[CALLER_SESSION_HEADER] !== undefined;
    if (identifiedCaller && rejectUnverifiedIdentifiedApiCaller(req, res, method, pathname, context)) {
      return;
    }
    if (context.workflowService && await handleWorkflowApi(req, res, { method, pathname, url }, { service: context.workflowService,
      authenticated: authenticateGatewayRequest(req, context.gatewayAuthToken, jinnHome).ok })) return;
    if (await handleTalkApi(req, res, { method, pathname, url }, {
      getConfig: context.getConfig, caller: resolveScopedWriteCallerIdentity(req, context),
      context,
      runHandoff: (session, prompt) => {
        const engine = context.sessionManager.getEngine(session.engine);
        if (engine) dispatchWebSessionRun(session, prompt, engine, context);
      },
    })) return;
    if (!identifiedCaller && rejectUnverifiedIdentifiedApiCaller(req, res, method, pathname, context)) return;
    if (await handleHeartbeatApi(req, res, { method, pathname, url }, { resolveCaller: () => resolveScopedWriteCallerIdentity(req, context) })) return;

    if (method === "GET" && pathname === "/api/features") {
      const config = context.getConfig();
      return json(res, {
        notesEnabled: config.gateway.notesEnabled === true,
        staleChat: resolveStaleChatPolicy(config),
      });
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
      return json(res, {
        status: "ok",
        version: getPackageVersion(),
        uptime: Math.floor((Date.now() - context.startTime) / 1000),
        port: config.gateway.port || 7777,
        // Derived from the model registry (single source of truth) so engine
        // availability stays consistent with /api/engines instead of drifting.
        engines: {
          default: config.engines.default,
          ...Object.fromEntries(Object.entries(withEngineHealth(getModelRegistry(config))).map(([name, entry]) => [
            name, { model: entry.defaultModel, available: entry.available, health: entry.health },
          ])),
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
      if (process.env.JINN_CONTAINER === "1") {
        return json(res, {
          code: "container_restart_unsupported",
          error: CONTAINER_RESTART_UNSUPPORTED_MESSAGE,
        }, 409);
      }
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
        const restartRequestedAt = new Date().toISOString();
        transportMeta[RESTART_ACK_META_KEY] = restartRequestedAt;
        transportMeta[RESTART_RESUME_META_KEY] = restartRequestedAt;
        updateSession(requestingSessionId, {
          status: "idle",
          lastActivity: restartRequestedAt,
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
      // The configured host, not the one JINN_HOST resolved: this goes into the NEW
      // workspace's config.yaml, and the variable describes this container, not that
      // home. Undefined leaves the new config's own loopback default alone.
      const envHost = gatewayEnvOverrides().host;
      const configuredHost = currentConfig.gateway.host;
      let created: CreateInstanceResult;
      try {
        created = await (context.createWorkspaceInstance ?? createInstance)({
          name: body.name,
          port: body.port as number | undefined,
          currentPort,
          gatewayHost: configuredHost === envHost ? undefined : configuredHost,
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

    // `/api/search/*` — moved to search-api.ts when the global route was added:
    // api.ts is at its size budget and cannot hold a fifth search route.
    if (await handleSearchApi(req, res, { method, pathname, url }, {
      context,
      compactSessionSummary,
      resolveNeedsAttentionTarget: (requested) => resolveNeedsAttentionTarget(req, res, requested, context),
    })) return;

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

    if (await handleExperimentsApi(req, res, { method, pathname, url }, context)) return;

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
    // `..`, absolute paths, symlink escapes and bad offsets are refused (400/403). This route is
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
      const result = readKnowledgeFile(rel, jinnHome, Number(url.searchParams.get("offset") ?? 0));
      if (!result.ok) {
        if (result.reason === "forbidden") return json(res, { error: result.detail }, 403);
        if (result.reason === "not-found") return json(res, { error: result.detail }, 404);
        return badRequest(res, result.detail);
      }
      const { ok: _ok, ...payload } = result;
      return json(res, payload);
    }

    if (method === "GET" && pathname === "/api/pins") {
      return json(res, { pins: listChatPins() });
    }

    if (method === "POST" && pathname === "/api/pins") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      const key = (parsed.body as { key?: unknown }).key;
      if (typeof key !== "string" || !key.trim()) return badRequest(res, "key must be a non-empty string");
      pinChat(key.trim());
      context.emit("pins:changed", {});
      return json(res, { status: "pinned" });
    }

    const pinParams = matchRoute("/api/pins/:key", pathname);
    if (method === "DELETE" && pinParams) {
      unpinChat(pinParams.key);
      context.emit("pins:changed", {});
      return json(res, { status: "unpinned" });
    }

    // GET /api/sessions
    //   ?group=<employee|__direct__|__cron__>&offset=M&limit=N → one group's page (sidebar "load more")
    //   ?pinned=1                                           → pinned, non-archived sessions
    //   ?limit=0                                              → every session (power-user escape hatch)
    //   (default)                                             → top SESSION_LIST_PER_GROUP recent per group + counts
    if (method === "GET" && pathname === "/api/sessions") {
      if (url.searchParams.get("pinned") === "1") {
        return json(res, serializeSessionList(listPinnedSessions(), context));
      }
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

      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      cleanUpDeletedSession(params.id);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      context.emit("pins:changed", {});
      return json(res, { status: "deleted" });
    }

    // POST /api/sessions/:id/archive — reversible operator cleanup. The
    // session, transcript, and engine snapshot remain intact; normal list
    // queries simply omit its archived_at row until unarchived. Archiving does
    // not delete the Codex overlay either, but it does not exempt it from the
    // 14-day idle retention sweep (see startCodexSessionHomeSweeps).
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
      logger.info(`Session ${params.id} reset via API (cleared engine session refs, engineOverride, engineSessionId, lastError)`);
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

    if (await handleSessionQueueRoute(method, pathname, req, res, context)) return;

    // POST /api/sessions/bulk-delete
    if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
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

      const deletableIds = deletable.map((session) => session.id);
      const count = deleteSessions(deletableIds);
      for (const id of deletableIds) {
        cleanUpDeletedSession(id);
        context.emit("session:deleted", { sessionId: id });
      }
      if (count > 0) context.emit("pins:changed", {});
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
      if (!session) return notFound(res);
      const children = listChildSessions(params.id);
      return json(res, serializeSessionList(children, context));
    }

    // GET /api/sessions/:id/context?message=<id>&radius=<n> — GRS-020a: the
    // bounded ±radius window around a message anchor (a search hit), so a hit
    // becomes readable in place. Message bodies are returned as stored; the
    // session field is the COMPACT summary (GRS-020a-fix finding 5).
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
      const rawIds = url.searchParams.get("ids");
      if (rawIds !== null) {
        if (!rawIds.trim()) return badRequest(res, "ids is required as a comma-separated list of Todo IDs");
        const ids = rawIds.split(",").map((id) => id.trim());
        if (ids.length > 100) return badRequest(res, "ids must contain at most 100 Todo IDs");
        if (ids.some((id) => !isTodoId(id))) {
          return badRequest(res, "ids must be a comma-separated list of Todo IDs in <AAA>-N format");
        }
        const workItems = getWorkItems(ids);
        const eventsById = listWorkItemEventsForItems(workItems.map((item) => item.id));
        return json(res, {
          workItems: workItems.map((item) => openWorkItemPayload(item, eventsById.get(item.id) ?? [])),
        });
      }
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
      if (body.assignee !== undefined) return badRequest(res, "assignee cannot be supplied at Todo creation — create first, then grant ownership through the assign flow (assign_work_item / POST /api/work-items/:id/assign), which is its own action: it validates the roster, derives the department, moves backlog→assigned, and notifies the assignee");
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
      // Labels at creation carry the same contract as PUT /api/work-items/:id/labels:
      // EXISTING labels only, by id or name. Nothing is created implicitly.
      if (body.labels !== undefined) {
        if (!Array.isArray(body.labels) || body.labels.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 256)) {
          return badRequest(res, "labels must be an array of label ids or names (non-empty strings)");
        }
        if (body.labels.length > TODO_LABELS_MAX) {
          return badRequest(res, `labels accepts at most ${TODO_LABELS_MAX} entries per Todo (got ${body.labels.length})`);
        }
      }
      const labelRefs = body.labels === undefined ? undefined : (body.labels as string[]).map((entry) => entry.trim());
      // ICI-733: a caller-supplied create key, same shape rules as the edit key.
      // Cron and connector retries create duplicate Todos without one.
      let idempotencyKey: string | undefined;
      if (body.idempotencyKey !== undefined) {
        if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()) {
          return badRequest(res, "idempotencyKey must be a non-empty string");
        }
        idempotencyKey = body.idempotencyKey.trim();
        if (idempotencyKey.length > 256) return badRequest(res, "idempotencyKey is too long (max 256 characters)");
        if (/[\x00-\x1f\x7f]/.test(idempotencyKey)) return badRequest(res, "idempotencyKey contains invalid characters");
      }
      const source: WorkItemSource = caller.kind === "session" ? "session" : "human";
      const input: CreateWorkItemInput = {
        title: title.slice(0, 200),
        body: typeof body.body === "string" ? body.body : null,
        acceptance: typeof body.acceptance === "string" ? body.acceptance : null,
        // The department key is included only when the request carries one, so a
        // sub-task with no department inherits the parent's at the store layer.
        ...(body.department !== undefined
          ? { department: typeof body.department === "string" && body.department.trim() ? body.department.trim() : null }
          : {}),
        source,
        // A random ref per create — EXCEPT under an idempotency key, where the
        // ref must be stable or the replay would look like a different create
        // (and the `(source, source_ref)` unique index would not catch it either).
        sourceRef: source === "session" && caller.kind === "session"
          ? `session:${caller.callerId}:${idempotencyKey
              ? `idempotency:${crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`
              : crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
          : null,
        verifyPolicy: verifyPolicy.value,
        parentId,
        dueAt,
        ...(priority !== undefined ? { priority } : {}),
        // Slice-5 decision 7: a session with a resolved employee creates AS
        // that employee (the comments identity model); `session:<uuid>` remains
        // only for employee-less raw sessions.
        createdBy: workItemCommentAuthor(caller).author,
        origin: caller.origin,
      };
      try {
        // Tagging runs inside the create transaction: an unknown label must fail
        // the whole request rather than leave an untagged Todo behind.
        let labels: Label[] | undefined;
        const create = () => idempotencyKey
          ? createWorkItemIdempotent(input, idempotencyKey, labelRefs)
          : { item: createWorkItem(input), replayed: false };
        const created = labelRefs === undefined
          ? create()
          : initDb().transaction(() => {
            const result = create();
            // A replay's labels were written by the create it replays. Setting
            // them again would rewrite a set the Todo may have had edited since.
            if (!result.replayed) labels = setWorkItemLabels(result.item.id, labelRefs, workItemActor(caller), caller.origin);
            return result;
          })();
        if (created.replayed) return json(res, { workItem: created.item, replayed: true }, 200);
        const activityReceiptId = persistTodoMutationActivity(req, context, created.item, "created");
        return json(res, withActivityReceipt({ workItem: created.item, ...(labels ? { labels } : {}) }, activityReceiptId), 201);
      } catch (err) {
        if (err instanceof WorkItemCreateIdempotencyConflictError) {
          return json(res, { error: err.message, code: "todo_create_idempotency_conflict", workItemId: err.workItemId }, 409);
        }
        return badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }

    // GET /api/work-items/trees?ids=a,b,c — batched subtrees for board
    // enrichment. Values have the same shape as the single-tree route's
    // `tree`; unknown IDs are omitted.
    if (method === "GET" && pathname === "/api/work-items/trees") {
      const rawIds = url.searchParams.get("ids");
      if (!rawIds?.trim()) return badRequest(res, "ids is required as a comma-separated list of Todo IDs");
      const ids = rawIds.split(",").map((id) => id.trim());
      if (ids.length > 100) return badRequest(res, "ids must contain at most 100 Todo IDs");
      if (ids.some((id) => !isTodoId(id))) {
        return badRequest(res, "ids must be a comma-separated list of Todo IDs in <AAA>-N format");
      }
      return json(res, { trees: getWorkItemTrees(ids) });
    }

    // GET /api/work-items/:id — full Todo detail.
    params = matchRoute("/api/work-items/:id", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      return json(res, fullWorkItemPayload(item));
    }

    // PATCH /api/work-items/:id — the metadata pen. Authority is per-field and
    // resolved in todo-edit-authority.ts: content is open to every authenticated
    // session, ownership and review are the operator's, and the Todo's own
    // assignee or creator may declare where its product lands. Status is
    // intentionally excluded: lifecycle changes remain behind the guarded
    // transition/archive/approval surfaces below.
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
          if (!orgRegistry(context.getConfig()).has(assignee)) {
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
      const authority = resolveTodoEditAuthority(caller, item, patch);
      const patchedFields = (Object.keys(patch) as Array<keyof UpdateWorkItemInput>);
      for (const field of patchedFields) {
        if (!authority.fields.has(field)) {
          return json(res, { error: todoEditRefusal(field, item, authority.who) }, 403);
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
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) return badRequest(res, "request body must be a JSON object");
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
      const fields = parseStatusUpdateFields(body, target, isOperatorPut);
      if (!fields.ok) return json(res, { error: fields.error }, fields.status);
      const { note, blockKind, cascade, acknowledgeEscalated, stopCause } = fields;
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authorized = authorizeAgentWorkItemStatus(caller, item, target as WorkItemStatus);
      if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      let actingAsOperator: string | undefined;
      if (fields.asOperator) {
        const permitted = authorizeActingAsOperator(caller);
        if (!permitted.ok) return json(res, { error: permitted.error }, 403);
        actingAsOperator = permitted.actingAs;
      }
      // A granted claim is the operator's authority arriving on the COO lane,
      // not just their name on the record: it releases a sticky terminal the
      // way the operator PUT does. The cascade is not part of it —
      // parseStatusUpdateFields keeps that on the operator's own surface.
      const humanAuthority = isOperatorPut || actingAsOperator !== undefined;
      const actor = fields.asOperator ? "operator" : workItemActor(caller);
      // Read the list per request, so adding or removing a delegate takes effect
      // on the next move rather than at the next restart.
      const armedAsDelegate = resolveArmingDelegate(caller, target, context.getConfig());
      const detail = writeDetail({
        ...(note ? { note } : {}),
        ...(actingAsOperator ? { asOperator: actingAsOperator } : {}),
        ...(armedAsDelegate ? { armedAsDelegate } : {}),
      }, caller.origin);
      // The banner's asked-for-after reason (design-doc §5): a same-status
      // operator PUT with a note annotates the CURRENT exception state instead
      // of vanishing in transition()'s same-status no-op. The note event
      // carries toStatus so the reason surfaces read it like a transition note.
      if (isOperatorPut && note && target === item.status && (target === "blocked" || target === "escalated")) {
        appendWorkItemEvent({
          workItemId: params.id,
          kind: "note",
          toStatus: target as WorkItemStatus,
          actor,
          detail: writeDetail({ note }, caller.origin),
          versionEffect: "state",
        });
        const annotated = getWorkItem(params.id)!;
        const activityReceiptId = persistTodoMutationActivity(req, context, annotated, "status-transitioned", true, item.status);
        return json(res, withActivityReceipt({ workItem: annotated, escalated: false }, activityReceiptId));
      }
      try {
        const result = isOperatorPutCancellation
          ? {
              // The operator PUT lane is the human surface: the archive lane
              // carries the same human authority as every other sticky exit,
              // so escalated → cancelled (a declared edge) is reachable here.
              item: archiveWorkItem(params.id, actor, { human: true, ...(note ? { note } : {}) }),
              escalated: false,
            }
          : transition(params.id, target as WorkItemStatus, actor, {
              manual: true,
              human: humanAuthority || undefined,
              // Agent lane: the target allowlist above is what bounds this
              // caller, so the edge map does not also govern it.
              agent: !isOperatorPut || undefined,
              callerSessionId: caller.kind === "session" ? caller.callerId : undefined, ...(blockKind ? { blockKind } : {}),
              ...(cascade ? { cascade: true } : {}),
              ...(acknowledgeEscalated ? { acknowledgeEscalated: true } : {}), ...(stopCause ? { stopCause } : {}),
              detail,
            });
        const activityReceiptId = persistTodoMutationActivity(
          req,
          context,
          result.item,
          "status-transitioned",
          result.item.version !== item.version,
          item.status,
        );
        return json(res, withActivityReceipt({ workItem: result.item, escalated: result.escalated }, activityReceiptId));
      } catch (err) {
        if (err instanceof TransitionError) {
          if (err.code === "not-found") return notFound(res);
          // A refused cascade leaves the tree intact and the caller a next move
          // (answer the escalation, or acknowledge it): a conflict with the
          // item's state, not a refusal of who asked.
          const human = err.code === "self-review-banned"
            ? `${err.message} — use the human review surface / a reviewer session to mark done`
            : err.code === "escalated-descendant" ? err.message
            : `${err.message} — use the human surface for this transition if it is intentional`;
          const statusCode = err.code === "illegal-edge" ? 400 : err.code === "escalated-descendant" ? 409 : 403;
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
      const roster = orgRegistry(context.getConfig());
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
        const item = assignWorkItem(params.id, assignee, employee.department ?? null, workItemActor(caller), caller.origin);
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
        const activityReceiptId = persistTodoMutationActivity(req, context, archived, "archived", true, item.status);
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

    // POST /api/work-items/:id/dispatch — start the built-in Todo Dispatcher.
    // The dispatcher is itself the durable thread for this Todo, so a live one
    // is the idempotency receipt: repeat clicks return it instead of spawning.
    params = matchRoute("/api/work-items/:id/dispatch", pathname);
    if (method === "POST" && params) {
      const caller = resolveWorkItemCaller(req, res, context);
      if (!caller) return;
      if (!requireTodoRouteId(res, params.id)) return;
      const item = getWorkItem(params.id);
      if (!item) return json(res, { error: `Todo ${params.id} not found` }, 404);
      if (STICKY_STATUSES.has(item.status)) {
        return json(res, { error: `Todo ${item.id} is ${item.status} and cannot be dispatched` }, 409);
      }
      if (caller.kind === "session") {
        const authorized = authorizeWorkItemOwnerManagerOrRoot(caller, item, "dispatch");
        if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
      }

      // The Todo's own dispatch preferences are resolved BEFORE the claim, so a
      // Todo whose skills have all been uninstalled fails without holding one.
      const dispatchPrefs = resolveTodoDispatch(item.id);
      if (!dispatchPrefs.ok) return json(res, { error: dispatchPrefs.error }, 409);

      const claim = claimTodoForDispatch(res, item.id);
      if (!claim) return;

      const config = context.getConfig();
      const dispatcher = orgRegistry(config).get(TODO_DISPATCHER_NAME);
      if (!dispatcher?.system) {
        claim.release();
        return serverError(res, "the built-in Todo Dispatcher is unavailable");
      }
      // The Todo's override beats the Dispatcher employee's own engine/model:
      // it exists to move a stuck Todo onto another engine, so it has to win.
      const dispatchEngineName = dispatchPrefs.preamble.engine ?? dispatcher.engine;
      const dispatchModel = dispatchPrefs.preamble.engine ? dispatchPrefs.preamble.model ?? undefined : dispatcher.model;
      const preflight = preflightSystemEmployee({
        employee: dispatcher, label: "Todo Dispatcher", settingLabel: "Dispatcher",
        engineName: dispatchEngineName, globalMcp: config.mcp,
        getEngine: (name) => context.sessionManager.getEngine(name),
      });
      if (!preflight.ok) {
        claim.release();
        return json(res, { error: preflight.error }, preflight.status);
      }
      const engine = preflight.engine;

      const prompt = dispatchPrefs.preamble.prefix + [
        `Dispatch Todo ${item.id}.`,
        `Title: ${item.title}`,
        item.body ? `Body:\n${item.body}` : "Body: (none)",
        item.acceptance ? `Acceptance criteria:\n${item.acceptance}` : "Acceptance criteria: (none)",
      ].join("\n\n");
      const sessionKey = `todo-dispatcher:${item.id}:${crypto.randomUUID()}`;
      const session = createSession({
        engine: dispatchEngineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: dispatcher.name,
        model: dispatchModel,
        effortLevel: dispatcher.effortLevel,
        prompt,
        title: `Dispatch ${item.id}`,
        portalName: config.portal?.portalName,
      });
      insertMessage(session.id, "user", prompt);
      try {
        linkSession(item.id, session.id);
        claim.bind(session.id);
      } catch (error) {
        claim.release();
        return serverError(
          res,
          `Todo Dispatcher was not started because its session could not be linked: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
      session.status = "running";
      try {
        reconcileWorkItem(item.id);
      } catch (error) {
        logger.warn(`Todo Dispatcher ${session.id} reconcile failed: ${error instanceof Error ? error.message : error}`);
      }
      const queueKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, queueKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: queueKey });
      dispatchWebSessionRun(session, prompt, engine, context, { queueItemId });
      emitTodoProjectionEvent(context, item.id, "dispatched");

      return json(res, {
        workItemId: item.id,
        sessionId: session.id,
        status: session.status,
        reused: false,
      }, 201);
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
          origin: caller.origin,
        });
        forwardWorkflowTodoComment(comment);
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
        }, caller.origin);
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

    // GET /api/work-items/:id/attachments/:aid — stream or download. Uploads are
    // hash-verified into content-addressed storage; reads keep the cheap size
    // guard so byte ranges never require loading and hashing the whole blob.
    params = matchRoute("/api/work-items/:id/attachments/:aid", pathname);
    if (method === "GET" && params) {
      if (!requireTodoRouteId(res, params.id)) return;
      const attachment = getAttachment(params.aid);
      if (!attachment || attachment.workItemId !== params.id) return notFound(res);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(attachment.storagePath);
      } catch {
        logger.error(`Attachment ${attachment.id} content missing on disk: ${attachment.storagePath}`);
        return serverError(res, "attachment content is missing from storage");
      }
      if (!stat.isFile() || stat.size !== attachment.bytes) {
        logger.error(
          `Attachment ${attachment.id} failed size verification: stored ${attachment.storagePath} is ${stat.size} bytes, row says ${attachment.bytes}`,
        );
        return serverError(res, "attachment content failed size verification — the stored file does not match its recorded size");
      }
      const reqUrl = new URL(req.url || pathname, `http://${req.headers.host || "localhost"}`);
      const download = reqUrl.searchParams.get("download") === "1";
      const selected = await selectAttachmentVariant(attachment, reqUrl.searchParams, download);
      if (!selected) return notFound(res);
      const etag = `"${attachment.sha256}-${selected.variant}-${selected.size}"`;
      if (!selected.isFallback && isFileNotModified(req.headers, etag, Number.NaN))
        return void res.writeHead(304, { "Cache-Control": "public, max-age=31536000, immutable", ETag: etag }).end();
      await streamFile(req, res, selected.path, {
        mime: selected.mime,
        filename: selected.filename,
        disposition: download || !attachment.mime.startsWith("video/") ? "attachment" : "inline",
        cacheHeaders: selected.isFallback
          ? { "Cache-Control": "no-store" }
          : { "Cache-Control": "public, max-age=31536000, immutable", ETag: etag },
      });
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

    if (await handleWorkItemKeptApi(req, res, { method, pathname, url }, {
      resolveCaller: () => resolveWorkItemCaller(req, res, context),
      emitProjection: (id) => emitTodoProjectionEvent(context, id, "kept-updated"),
    })) return;

    // PUT /api/work-items/:id/dispatch-config — how the NEXT attempt runs: the
    // skills it preloads and the engine/model it uses. Deliberately settable
    // while the Todo is `executing` (that is the point — it is the lever for
    // moving a stuck attempt onto another engine) and deliberately NOT part of
    // PATCH: these live in a side table, and the PATCH field order feeds the
    // canonical edit fingerprint that existing idempotency receipts were made
    // against. Same authority as labels: operator, creator, or assignee.
    params = matchRoute("/api/work-items/:id/dispatch-config", pathname);
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
        return json(res, { error: "setting a Todo's dispatch config requires the operator, the item creator, or the assignee" }, 403);
      }
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
        return badRequest(res, "request body must be a JSON object");
      }
      const body = parsed.body as Record<string, unknown>;
      for (const key of ["engine", "model"] as const) {
        if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== "string" || !(body[key] as string).trim())) {
          return badRequest(res, `${key} must be a non-empty string or null`);
        }
      }
      const result = setTodoDispatchConfig(params.id, {
        ...(body.skills !== undefined ? { skills: body.skills } : {}),
        ...(body.engine !== undefined ? { engine: body.engine === null ? null : (body.engine as string).trim() } : {}),
        ...(body.model !== undefined ? { model: body.model === null ? null : (body.model as string).trim() } : {}),
      }, context.getConfig());
      if (!result.ok) return badRequest(res, result.error);
      emitTodoProjectionEvent(context, params.id, "dispatch-config-updated");
      return json(res, { dispatchConfig: result.config });
    }

    // PUT /api/work-items/:id/labels — `labels` replaces the whole set, `add`/`remove`
    // touch only what they name (operator, item creator, or assignee — the pre-slice-4
    // subset of edit authority). Only EXISTING labels are accepted, none created implicitly.
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
        return json(res, { error: "changing a Todo's labels requires the operator, the item creator, or the assignee" }, 403);
      }
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      const change = parseLabelChange(parsed.body);
      if ("error" in change) return badRequest(res, change.error);
      try {
        const labels = applyLabelChange(params.id, change, workItemActor(caller), caller.origin);
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
          const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
          const node = resolveOrgHierarchy(orgRegistry(context.getConfig())).nodes[employee];
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
        const roster = orgRegistry(context.getConfig());
        const root = resolveRootApprovalTarget();
        if (!roster.has(target) && root?.name !== target) {
          return badRequest(res, `approval target "${target}" is not an org employee or the configured root approval target`);
        }
      }
      if (body.options !== undefined && !Array.isArray(body.options)) {
        return badRequest(res, "options must be an array of labels when provided");
      }
      if (body.operatorOnly !== undefined && typeof body.operatorOnly !== "boolean") {
        return badRequest(res, "operatorOnly must be a boolean when provided");
      }
      // Reserving a gate for the operator and routing it at an employee are
      // contradictory instructions; refuse rather than silently honour one.
      if (body.operatorOnly === true && target) {
        return badRequest(res, "an operator-only approval cannot also be routed to an employee target");
      }
      let updated: WorkItem;
      try {
        updated = requestApproval(params.id, {
          request,
          ...(body.options !== undefined ? { options: body.options as string[] } : {}),
          ...(target ? { target } : {}),
          ...(body.operatorOnly === true ? { operatorOnly: true } : {}),
          actor: workItemActor(caller),
        });
      } catch (err) {
        if (err instanceof ApprovalChoiceError) return badRequest(res, err.message);
        throw err;
      }
      const activityReceiptId = persistTodoMutationActivity(req, context, updated, "approval-requested", updated.version !== item.version);
      return json(res, withActivityReceipt({ workItem: updated }, activityReceiptId));
    }

    // POST /api/work-items/:id/approvals/decide — approval DECISION surface.
    // The singular /approval route remains as a compatibility alias.
    // COO-default: routed manager or root/COO can decide through the same
    // identity/capability seam MCP uses; operator/aCEO HTTP can decide only after
    // explicit escalation persisted on the Todo.
    // {decision:"approve"|"reject", note?}. Native decisions apply the FIXED
    // consequence rules (approve+in_review → done; reject+in_review → bounce/escalate;
    // otherwise the decision is recorded, status untouched).
    params = matchRoute("/api/work-items/:id/approvals/decide", pathname)
      ?? matchRoute("/api/work-items/:id/approval", pathname);
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
      const choiceRaw = (parsed.body as { choice?: unknown }).choice;
      if (choiceRaw !== undefined && typeof choiceRaw !== "string") {
        return badRequest(res, "choice must be a string when provided");
      }
      const item = getWorkItem(params.id);
      if (!item) return notFound(res);
      const authority = resolveApprovalDecisionAuthority(req.headers, item, {
        operatorCanActOnRootTarget: true,
        operatorAuthenticated: scopedOperatorAuthenticated(req, context),
        ...approvalReservation(item, context.workflowService),
      });
      if (!authority.ok) return json(res, { error: authority.error }, authority.status);

      const result = await decideWorkItemApproval(
        { id: params.id, decision, ...(note !== undefined ? { note } : {}),
          ...(choiceRaw !== undefined ? { choice: choiceRaw } : {}), decidedBy: authority.authority.actor },
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
      const activityReceiptId = persistTodoMutationActivity(req, context, result.item, "approval-decided", true, item.status);
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
      // Same reservation the decision surface reads: escalating an operator-only
      // gate must not open an employee path to it that deciding refuses.
      const authority = resolveApprovalDecisionAuthority(req.headers, item, {
        operatorCanActOnRootTarget: true,
        operatorAuthenticated: scopedOperatorAuthenticated(req, context),
        ...approvalReservation(item, context.workflowService),
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
      // an ordinary delegation receipt.
      const parentSessionId = resolveSpawnParentSessionId(delegationCaller, body.parentSessionId, "delegation");
      const delegatorSession = parentSessionId ? getSession(parentSessionId) : undefined;
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
      const delegateAsRoot = spawnAsRootRefusal(delegationCaller, employeeName);
      if (delegateAsRoot) return json(res, { error: delegateAsRoot }, 403);
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
      let roster: Map<string, Employee> | undefined;
      let delegateEmployee: Employee | undefined;
      if (employeeName) {
        roster = orgRegistry(config);
        delegateEmployee = roster.get(employeeName);
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
      // ICI-733: a Todo's own override outranks both the request and the
      // employee's YAML — it is the lever for retrying a Todo somewhere else,
      // and a caller repeating the engine that just failed would defeat it.
      // A named engine with no model resolves that engine's default, so the
      // previous engine's model is not carried across.
      const todoDispatch = typeof body.workItemId === "string" && isTodoId(body.workItemId.trim())
        ? resolveTodoDispatch(body.workItemId.trim())
        : { ok: true as const, preamble: { prefix: "", engine: null, model: null } };
      if (!todoDispatch.ok) return json(res, { error: todoDispatch.error }, 409);
      const todoOverride = todoDispatch.preamble;
      const selection = validateNewSessionSelection(config, {
        engine: todoOverride.engine ?? body.engine,
        model: todoOverride.engine ? todoOverride.model ?? undefined : body.model,
        effortLevel: body.effortLevel,
      }, todoOverride.engine ? { employee: employeeName } : employeeDefaults);
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
      let dispatcherHandoffFrom: string | undefined;
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
        dispatcherHandoffFrom = delegationCaller.kind === "session"
          && getSession(delegationCaller.callerId)?.employee === TODO_DISPATCHER_NAME
          ? delegationCaller.callerId
          : undefined;
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

      // An existing Todo is the canonical delegation dossier. Linking the
      // session without also putting that dossier in the first turn leaves the
      // delegate dependent on a later MCP read, which may be unavailable or
      // fail transiently. Keep the caller's task as the immediate instruction,
      // then attach the durable objective and acceptance criteria verbatim.
      // This also makes a delegated attempt self-contained and auditable.
      const canonicalTodoContext = requestedWorkItemId
        ? [
            "\n\n---\n## Canonical linked Todo",
            `ID: ${workItem.id}`,
            `Title: ${workItem.title}`,
            workItem.body ? `\nObjective and evidence:\n${workItem.body}` : "",
            workItem.acceptance ? `\nAcceptance criteria:\n${workItem.acceptance}` : "",
            "\nTreat this linked Todo dossier as the source of truth. Use the Jinn MCP to append progress and evidence when available; a transient Todo-read failure must not erase or block the dossier above.",
          ].filter(Boolean).join("\n")
        : "";
      // The Todo's skills are preloaded by prefixing the complete brief.
      const brief = todoOverride.prefix + task + canonicalTodoContext;
      const claim = claimTodoForDelegation(res, workItem.id, dispatcherHandoffFrom);
      if (!claim) return;

      // 2. SPAWN — the irreversible step. A failure here PRESERVES the minted
      //    `backlog` item (durable intent, recoverable) and reports its id.
      const engine = context.sessionManager.getEngine(engineName);
      if (!engine) {
        claim.release();
        return json(res, {
          error: `engine "${engineName}" not available`,
          workItemId: workItem.id,
          hint: "the work item was minted before the spawn and is preserved as backlog — the delegation intent is durable, not lost",
        }, 502);
      }
      // A reviewer must remain independent from the work they are reviewing.
      // Delegating an in-review Todo to its pending approval target is a review
      // dispatch, not an ownership transfer. Reassigning here would make the
      // reviewer the Todo owner and the approval authority would then correctly
      // refuse the decision as self-review, leaving the Todo permanently stuck.
      const isApprovalReviewDelegation = requestedWorkItemId
        && workItem.status === "in_review"
        && workItem.approvalTarget === employeeName;
      // Ordinary execution delegations still transfer assignment. Review
      // delegations preserve the implementer/owner and use the linked session as
      // the durable record that the reviewer was dispatched.
      const delegationActor = workItemActor(delegationCaller.kind === "session"
        ? { kind: "session", callerId: delegationCaller.callerId, session: getSession(delegationCaller.callerId)! }
        : { kind: "operator" });
      if (requestedWorkItemId && employeeName && !isApprovalReviewDelegation) {
        try {
          workItem = assignWorkItem(workItem.id, employeeName, delegateEmployee?.department ?? null, delegationActor) ?? workItem;
        } catch (assignmentErr) {
          claim.release();
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
          prompt: brief,
          title,
          portalName: config.portal?.portalName,
          transportMeta: {
            [DELEGATION_COMPLETION_TRACKED_META_KEY]: true,
            ...(delegateEmployee?.displayName ? { delegationEmployeeDisplay: delegateEmployee.displayName } : {}),
          },
        });
      } catch (spawnErr) {
        claim.release();
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
      insertMessage(session.id, "user", brief, delegationMedia.length > 0 ? delegationMedia : undefined);

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
        linkSession(workItem.id, session.id, delegationActor);
        claim.bind(session.id);
      } catch (linkErr) {
        claim.release();
        logger.warn(`Delegation ${workItem.id} link failed before dispatch: ${linkErr instanceof Error ? linkErr.message : linkErr}`);
        return json(res, {
          error: "delegation halted before dispatch — linking the work item to the spawned session failed",
          workItemId: workItem.id,
          sessionId: session.id,
          hint: "nothing was dispatched: the backlog work item and the idle session row are both preserved and re-linkable",
        }, 500);
      }
      // The ledger row for this attempt (ICI-728). Best-effort for the same
      // reason the derive below is: a run-ledger hiccup is a reporting gap, and
      // undoing a correctly linked delegation over one would be a worse trade.
      try {
        openWorkItemRun({ workItemId: workItem.id, sessionId: session.id });
      } catch (runErr) {
        logger.warn(`Delegation ${workItem.id} run ledger open failed: ${runErr instanceof Error ? runErr.message : runErr}`);
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
      const delegationQueueItemId = enqueueQueueItem(session.id, delegationQueueKey, brief);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: delegationQueueKey });
      const attachmentPaths = resolveAttachmentPaths(attachments);
      dispatchWebSessionRun(session, brief, engine, context, {
        queueItemId: delegationQueueItemId,
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      });
      if (employeeName && roster) {
        surfaceManagerVisibility({
          roster,
          employee: employeeName,
          delegatorSession,
          childSession: session,
          workItemId: workItem.id,
          title,
        });
      }

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
      const body = _parsed.body as any;
      const prompt = body.prompt || body.message;
      const promptError = messageBodyError(prompt, "prompt or message");
      if (promptError) return badRequest(res, promptError);
      // GRS-017a identity seam: a spawn carrying x-jinn-caller-session (the jinn
      // MCP server run by another session) is auto-linked as that session's
      // child — the agent cannot forget the linkage and the child-completion
      // callback protocol works without it knowing the mechanic.
      // A TOOL spawn that LOST its identity fails CLOSED (codex finding 2):
      // silently inheriting the operator's parentless spawn would orphan the
      // child and break the callback protocol without anyone noticing.
      const spawnCaller = resolveScopedWriteCallerIdentity(req, context);
      if (spawnCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      body.parentSessionId = resolveSpawnParentSessionId(spawnCaller, body.parentSessionId, "session spawn");
      // After the resolver, not before: a SESSION caller's unknown parent has
      // already collapsed to the caller, which is the documented fallback. What
      // survives to here is an operator-supplied id naming no row, which would
      // persist a child whose lineage dead-ends.
      if (typeof body.parentSessionId === "string" && !getSession(body.parentSessionId)) {
        return badRequest(res, `unknown parentSessionId "${body.parentSessionId}"`);
      }
      const config = context.getConfig();
      const employeeName = coercePortalEmployee(body.employee, config.portal?.portalName);
      const spawnAsRoot = spawnAsRootRefusal(spawnCaller, employeeName);
      if (spawnAsRoot) return json(res, { error: spawnAsRoot }, 403);
      // Opt-in SSO identity capture: when an auth proxy fronts the gateway and
      // `gateway.userHeader` is configured, persist the forwarded identity on the
      // session. Unset config → undefined → stored as NULL (single-user no-op).
      const userId = resolveUserHeader(req.headers, config.gateway.userHeader);
      const spawned = await spawnSession(context, {
        prompt,
        employee: employeeName,
        engine: body.engine,
        model: body.model,
        effortLevel: body.effortLevel,
        parentSessionId: body.parentSessionId,
        promptExcerpt: typeof body.promptExcerpt === "string" ? body.promptExcerpt : undefined,
        userId,
        attachments: body.attachments,
        interactive: body.mode === "interactive",
        speech: body.speech === true,
      });
      if (!spawned.ok) return badRequest(res, spawned.error);

      return json(res, serializeSessionResponse(spawned.session, context), 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      let session = getSession(params.id);
      if (!session) return notFound(res);
      session = maybeRevertEngineOverride(session);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
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
      let lateralDedupeKey: string | undefined;
      if (msgCaller.kind === "unidentified-tool") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: UNIDENTIFIED_TOOL_CALL_ERROR }));
        return;
      }
      if (msgCaller.kind === "session") {
        const msgCallerId = msgCaller.callerId;
        const rawMessage = body.message || body.prompt;
        const rawMessageError = messageBodyError(rawMessage);
        if (rawMessageError) return badRequest(res, rawMessageError);
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
        lateralDedupeKey = lateralSendDedupeKey(caller.id, params.id, String(rawMessage));
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
      const messageError = messageBodyError(prompt);
      if (messageError) return badRequest(res, messageError);

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
        const claim = claimIncomingTurn({
          sessionId: session.id, sessionKey, prompt, isNotification, role: messageRole, dedupeKey: lateralDedupeKey,
          content: isNotification ? displayMessage : prompt, media: userMedia, meta: notificationMeta,
        });
        if (claim.deduplicated) return json(res, { status: "duplicate", sessionId: session.id, queueItemId: claim.queueItemId });
        queueItemId = claim.queueItemId;
        incomingMessageId = claim.messageId;
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
      }

      // Clear any pending cancellation so the new message runs normally.
      context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      // Speech-derived operator messages carry a hidden context note to the engine
      // only. Everything persisted/queued/emitted above uses the clean `prompt`;
      // notifications (callbacks, relays) never qualify, and interactive dispatch
      // (ptyEngine truthy) suppresses the note so the visible PTY paste stays the
      // operator's exact text. Recomputed per request → exactly one note, never
      // persisted, never rendered, never duplicated on retry/reload/reconnect.
      const speechDerived = speechContextApplies({ speech: body.speech === true, isNotification, promptRendered: !!ptyEngine });
      const { engine: enginePrompt } = resolveMessageAudiences(prompt, speechDerived);

      // Internal notification-role messages are already durably queued above;
      // only real user messages create a visible queue-panel item here. The row
      // carries the whole payload so "send this one now" can move all of it.
      if (!isNotification) {
        queueItemId = enqueueQueueItem(session.id, sessionKey, prompt, { messageId: incomingMessageId, dispatch: { attachments: attachmentPaths, speechDerived } });
        context.emit("queue:updated", { sessionId: session.id, sessionKey });
      }

      dispatchWebSessionRun(session, enginePrompt, engine, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, {
        status: "queued",
        sessionId: session.id,
        messageId: incomingMessageId,
        queueItemId,
        ...(callbackDelivery ? { callbackDeliveryId: callbackDelivery.id } : {}),
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

    if (await handleCronApi(req, res, { method, pathname, url }, context)) return;
    if (await handleTodoCaptureApi(req, res, { method, pathname, url }, context)) return;
    if (await handleOrgApi(req, res, { method, pathname, url }, context)) return;
    if (await handleSkillsApi(req, res, { method, pathname, url }, context)) return;
    if (await handlePluginsApi(req, res, { method, pathname, url }, context)) return;

    // GET /api/engines — resolved model + capability registry (single source of truth
    // for the UI model/effort selectors). Synthesized from engines.<name>.model
    // when no `models:` block is configured.
    if (method === "GET" && pathname === "/api/engines") {
      const config = context.getConfig();
      return json(res, { default: config.engines.default, engines: withEngineHealth(getModelRegistry(config)) });
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
      return json(res, { default: config.engines.default, engines: withEngineHealth(getModelRegistry(config)) });
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
      // The revision comes off the FILE, not off this in-memory config: the file is
      // what a PUT deep-merges into, so the file is what a conflict is about.
      res.setHeader(CONFIG_REVISION_HEADER, currentConfigRevision());
      return json(res, configDocumentForApi(context.getConfig(), CONFIG_TOP_LEVEL_KEYS));
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as any;
      // Object.keys(null) throws, and an array would report index-named "unknown keys"
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "Config must be a JSON object");
      }
      // On the body, before the merge: a key we would not save back is the caller's mistake to hear about.
      const unknownKeys = Object.keys(body).filter((k) => !CONFIG_TOP_LEVEL_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return badRequest(res, `Unknown config keys: ${unknownKeys.join(", ")}`);
      }
      // Before the merge and before the write: a caller holding a revision older than
      // the file is about to overwrite an edit it never saw. A caller that sends no
      // revision is untouched — see isStaleConfigRevision for why that is deliberate.
      if (isStaleConfigRevision(req.headers, currentConfigRevision())) {
        return json(res, { ...CONFIG_CONFLICT_BODY }, 409);
      }
      // GET /api/config serves the EFFECTIVE binding, so the Settings page echoes
      // JINN_HOST/JINN_PORT back with every unrelated edit; saveConfigAtomic drops those.
      // A different value is a real edit, and refusing beats accepting a no-op.
      const envGateway = gatewayEnvOverrides();
      for (const key of ["host", "port"] as const) {
        const override = envGateway[key];
        if (override === undefined || body.gateway?.[key] === undefined) continue;
        if (body.gateway[key] !== override) {
          const variable = key === "host" ? "JINN_HOST" : "JINN_PORT";
          return badRequest(
            res,
            `gateway.${key} is set to ${JSON.stringify(override)} by ${variable} in this environment and cannot be ` +
            `changed here. Unset ${variable} to manage gateway.${key} from config.yaml.`,
          );
        }
      }
      // Deep-merge with the file to preserve fields the update omits (e.g. connector
      // tokens); the merge output is what gets validated, since a PUT body is partial.
      const unreadable = `${CONFIG_PATH} could not be read as a config object; refusing to rewrite it`;
      let existing: Record<string, unknown> = {};
      try {
        const loaded = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) ?? {};
        if (typeof loaded !== "object" || Array.isArray(loaded)) return serverError(res, unreadable);
        existing = loaded as Record<string, unknown>;
      } catch (err) {
        // ENOENT is the one honest "start fresh": any other failure means rewriting a file we could not read.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return serverError(res, unreadable);
      }
      const merged = deepMerge(existing, body);
      // A value the shape validator would reject must not reach the file: loadConfig() then throws and the gateway cannot restart.
      const problems = validateConfigShape(merged);
      if (problems.length > 0) return badRequest(res, `Invalid config: ${problems.join("; ")}`);
      saveConfigAtomic(merged);
      context.reloadConfig?.(); // refresh in-memory config now (don't wait on the watcher)
      invalidateModelRegistry(); // models/engines may have changed — rebuild on next read
      logger.info("Config updated via API");
      res.setHeader(CONFIG_REVISION_HEADER, currentConfigRevision());
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
        return json(res, result);
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /api/connectors/:name/send — send via the connector with that instance id
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      if (!isValidConnectorId(params.name)) return badRequest(res, `connector id ${CONNECTOR_ID_REQUIREMENTS}`);
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as any;
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      await connector.sendMessage(
        { channel: body.channel, thread: body.thread },
        redactText(String(body.text)),
      );
      return json(res, { status: "sent" });
    }

    // GET /api/connectors/:id/qr — return the selected WhatsApp instance QR as a PNG data URL
    params = matchRoute("/api/connectors/:id/qr", pathname);
    if (method === "GET" && params) {
      if (!isValidConnectorId(params.id)) return badRequest(res, `connector id ${CONNECTOR_ID_REQUIREMENTS}`);
      const waConnector = context.connectors.get(params.id);
      if (!waConnector || waConnector.name !== "whatsapp" || !("getQrCode" in waConnector)) return notFound(res);
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
        operatorEmoji: config.portal?.operatorEmoji ?? null,
      });
    }

    // POST /api/onboarding — persist portal personalization
    if (method === "POST" && pathname === "/api/onboarding") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as any;
      const { companyName, companyPrefix, portalName, operatorName, operatorEmoji, language, engine, model, effortLevel } = body;
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
          ...(operatorEmoji !== undefined && { operatorEmoji: operatorEmoji || undefined }),
          ...(language !== undefined && { language: language || undefined }),
        },
      };

      // Write updated config, then refresh the in-memory copy synchronously so
      // GET /api/onboarding reflects onboarded:true immediately (not after the
      // debounced file-watcher fires ~1s later).
      saveConfigAtomic(updated, { lineWidth: -1 });
      context.reloadConfig?.();
      logger.info(`Onboarding: company configured=${companyName !== undefined}, portal name="${portalName}", operator="${operatorName}", language="${language}"`);

      // Partial posts (e.g. just an operator emoji) must not rewrite the manual:
      // omitted fields would reset the name to "Jinn" and drop the language section.
      if (portalName !== undefined || language !== undefined) {
        personalizeOperatingManual(JINN_HOME, {
          portalName: updated.portal.portalName,
          language: updated.portal.language,
        });
      }
      return json(res, { status: "ok", portal: updated.portal });
    }

    // ── STT (Speech-to-Text) ──────────────────────────────────
    if (method === "GET" && pathname === "/api/stt/status") {
      const config = context.getConfig();
      const settings = getEffectiveSttSettings(config.stt, STT_SETTINGS_FILE, logger.warn);
      const status = getSttStatus(settings.model, settings.languages);
      return json(res, status);
    }

    if (method === "POST" && pathname === "/api/stt/download") {
      const config = context.getConfig();
      const settings = getEffectiveSttSettings(config.stt, STT_SETTINGS_FILE, logger.warn);
      const model = settings.model;

      downloadModel(model, (progress) => {
        context.emit("stt:download:progress", { progress });
      }).then(() => {
        try {
          writeSharedSttSettings(STT_SETTINGS_FILE, { ...settings, enabled: true, model });
        } catch (err) {
          logger.error(`Failed to update shared STT settings after download: ${err}`);
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
      const settings = getEffectiveSttSettings(config.stt, STT_SETTINGS_FILE, logger.warn);
      const model = settings.model;
      const languages = settings.languages;
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
        const config = context.getConfig();
        const settings = getEffectiveSttSettings(config.stt, STT_SETTINGS_FILE, logger.warn);
        writeSharedSttSettings(STT_SETTINGS_FILE, { ...settings, languages: langs });
        return json(res, { status: "ok", languages: langs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, `Failed to update STT config: ${msg}`);
      }
    }

    // /api/files — file upload/download/management
    if (pathname.startsWith("/api/files")) {
      const handled = await handleFilesRequest(req, res, { method, pathname, url }, context);
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
      const { routeMemoryTrialHook } = await import("../memory-trial/hook-adapter.js");
      // JAR-31 remains inert by default; tests may inject gates and dispatch to
      // prove this central hook path without enabling runtime effects.
      const injected = (context as { memoryTrialHookRouteOptions?: MemoryTrialHookRouteInjection })
        .memoryTrialHookRouteOptions;
      // Memory is optional and must never break the hook path: a guard refusal
      // (budget, circuit, eligibility) or a storage error is logged and the hook
      // still completes, so engineSessionId capture below always runs.
      const memoryTrial = await routeMemoryTrialHook({ ...(injected ?? memoryTrialHookRouteOptions(context, hook)), jinnSessionId, hook, getSession })
        .catch((error: unknown): import("../memory-trial/hook-adapter.js").MemoryTrialHookRouteResult => {
          logger.warn(`Memory trial hook ${hook.hook_event_name} skipped for ${jinnSessionId}: ${error instanceof Error ? error.message : String(error)}`);
          return { routed: false, reason: "dispatch-failed" };
        });
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
      return json(res, {
        message: "ok",
        ...(memoryTrial.additionalContext ? {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: memoryTrial.additionalContext,
          },
        } : {}),
      });
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
  const claudeProjectsDir = path.join(resolveClaudeConfigDir(), "projects");
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
  // Claude Code stores transcripts in <config dir>/projects/<project-key>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(resolveClaudeConfigDir(), "projects");
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

import path from "node:path";

import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { archiveSession, getSession } from "../sessions/registry.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { WorkflowRepository } from "../workflows/repository.js";


import { closeWorkItemRun, findOpenWorkItemRunBySession, openWorkItemRun } from "../work-items/runs.js";
import { linkSession } from "../work-items/store.js";
import { getTodoDispatchConfig } from "../work-items/dispatch-config.js";
import type { WorkflowTodoDispatchOverride, WorkflowTodoSessionLink } from "../workflows/todo-ports.js";

/**
 * The session half of what a Todo-bound Workflow run owes its Todo: each phase
 * session is linked to the Todo so the run's derived spend covers the whole
 * pipeline, and each phase ATTEMPT opens and settles a row in that Todo's run
 * ledger.
 *
 * The two are deliberately one port. A phase session and a phase attempt are
 * the same event seen from two sides, and splitting them invites a gateway that
 * wires one and forgets the other. Failures propagate: the runner already
 * treats every call here as best-effort, so swallowing anything a second time
 * would only hide it.
 */
export function workflowTodoSessions(): WorkflowTodoSessionLink {
  return {
    link: ({ todoId, sessionId }) => linkSession(todoId, sessionId),

    openRun: ({ todoId, sessionId, startedAt }) => {
      openWorkItemRun({ workItemId: todoId, sessionId, startedAt });
    },

    closeRun: ({ sessionId, outcome, endedAt, summary, handoff, error }) => {
      const open = findOpenWorkItemRunBySession(sessionId);
      // No open run means the attempt never dispatched, or the terminal path
      // that got here first already settled it. Nothing to close, nothing to
      // report — the ledger's one-close rule lives in `closeWorkItemRun`.
      if (!open) return;
      closeWorkItemRun(open.id, {
        outcome,
        endedAt,
        ...(summary ? { summary } : {}),
        ...(handoff ? { handoff } : {}),
        ...(error ? { error } : {}),
      });
    },
  };
}

/**
 * The other direction (ICI-733): what the Todo tells the run. Read fresh per
 * attempt, so an override set while an attempt was in flight lands on the next
 * one and never disturbs the one already running.
 */
export function workflowTodoDispatch(): WorkflowTodoDispatchOverride {
  return { read: (todoId) => getTodoDispatchConfig(todoId) };
}

/** The one workflow whose completion feeds the memory trial. */
const MEMORY_WORKFLOW_ID = "jarvis-memory-archiving";

/** The fields an `end` node of a completed memory-archiving run carries. */
type ArchiveFields = Record<string, unknown>;

/** The end-node fields of a completed run of the memory workflow, if any. */
function completedArchiveFields(run: ReturnType<WorkflowRepository["getRun"]>): ArchiveFields | undefined {
  if (!run || run.status !== "completed") return undefined;
  const end = run.nodeRuns.find((node) => node.nodeType === "end" && node.status === "completed");
  return end?.output?.fields as ArchiveFields | undefined;
}

/** Hand an accepted, agency-global summary to the memory runtime. */
async function keepAcceptedSummary(runId: string, startedAt: string, fields: ArchiveFields): Promise<void> {
  const summary = typeof fields.summary === "string" ? fields.summary : "";
  if (fields.accepted !== true || !summary.trim() || fields.project_key !== "agency-global") return;
  const { runMemoryRuntimeEffect } = await import("../memory-trial/runtime-pipeline.js");
  await runMemoryRuntimeEffect({
    directory: path.join(JINN_HOME, "state", "memory-trial"),
    claims: {
      createdAt: Date.parse(startedAt),
      projectId: fields.project_key,
      agentId: "knowledge-curator",
      sessionId: runId,
      trigger: "session-finalized",
    },
    hook: { hook_event_name: "Stop", session_id: runId, memory_trial_corpus: "public", last_assistant_message: summary },
  });
}

/** Archive the conversation the summary came from, unless it is still live. */
function archiveSourceConversation(fields: ArchiveFields, emit: GatewayEmit): void {
  const action = fields.conversation_action;
  const sourceSessionId = typeof fields.session_id === "string" ? fields.session_id.trim() : "";
  if (fields.critical === true || !sourceSessionId) return;
  if (action !== "archive" && action !== "delete_candidate") return;
  const source = getSession(sourceSessionId);
  if (!source || source.status === "running" || source.status === "waiting") return;
  archiveSession(sourceSessionId);
  emit("session:updated", { sessionId: sourceSessionId });
  logger.info(`Memory workflow ${action} archived source session ${sourceSessionId}`);
}

/**
 * The workflow-run `onChange` callback: announce the change, then react to a
 * completed memory-archiving run.
 *
 * The reaction is best-effort -- a failure is logged and the run id released so
 * a later run can try again -- and never holds up the event that triggered it.
 */
export function workflowRunOnChange(deps: {
  workflowRepository: WorkflowRepository;
  emit: GatewayEmit;
}): (change: { workflowId: string; runId: string }) => void {
  const { workflowRepository, emit } = deps;
  const seen = new Set<string>();
  const archive = async (workflowId: string, runId: string): Promise<void> => {
    if (workflowId !== MEMORY_WORKFLOW_ID || seen.has(runId)) return;
    const run = workflowRepository.getRun(workflowId, runId);
    const fields = completedArchiveFields(run);
    if (!run || !fields) return;
    seen.add(runId);
    try {
      await keepAcceptedSummary(run.id, run.startedAt, fields);
      archiveSourceConversation(fields, emit);
    } catch (error) {
      seen.delete(runId);
      logger.error(`Memory workflow archive failed for ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return ({ workflowId, runId }) => {
    emit("company:changed", { entity: "workflow-run", workflowId, runId });
    void archive(workflowId, runId);
  };
}

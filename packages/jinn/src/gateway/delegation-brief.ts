/**
 * The two rules that shape a delegation: what the delegate is told, and whether
 * the dispatch transfers ownership.
 *
 * Split out of api.ts, which is at its size budget and is a route table, not a
 * home for delegation policy.
 */
import type { WorkItem } from "../work-items/store.js";

/**
 * An existing Todo is the canonical delegation dossier. Linking the session
 * without also putting that dossier in the first turn leaves the delegate
 * dependent on a later MCP read, which may be unavailable or fail transiently.
 * The caller's task stays the immediate instruction; the durable objective and
 * acceptance criteria are attached verbatim after it, which also makes a
 * delegated attempt self-contained and auditable.
 */
export function canonicalTodoContext(requestedWorkItemId: unknown, workItem: WorkItem): string {
  if (!requestedWorkItemId) return "";
  return [
    "\n\n---\n## Canonical linked Todo",
    `ID: ${workItem.id}`,
    `Title: ${workItem.title}`,
    workItem.body ? `\nObjective and evidence:\n${workItem.body}` : "",
    workItem.acceptance ? `\nAcceptance criteria:\n${workItem.acceptance}` : "",
    "\nTreat this linked Todo dossier as the source of truth. Use the Jinn MCP to append progress and evidence when available; a transient Todo-read failure must not erase or block the dossier above.",
  ].filter(Boolean).join("\n");
}

/**
 * A reviewer must remain independent from the work they are reviewing.
 * Delegating an in-review Todo to its pending approval target is a review
 * dispatch, not an ownership transfer: reassigning would make the reviewer the
 * Todo owner, and the approval authority would then correctly refuse the
 * decision as self-review, leaving the Todo permanently stuck. Ordinary
 * execution delegations still transfer assignment.
 */
export function isReviewDispatch(requestedWorkItemId: unknown, workItem: WorkItem, employeeName: string | undefined): boolean {
  return Boolean(requestedWorkItemId)
    && workItem.status === "in_review"
    && workItem.approvalTarget === employeeName;
}

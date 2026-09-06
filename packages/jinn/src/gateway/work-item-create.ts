import { initDb } from "../shared/db.js";
import { createWorkItemIdempotent } from "../work-items/create-idempotency.js";
import { setWorkItemKept } from "../work-items/kept.js";
import { setWorkItemLabels, type Label } from "../work-items/labels.js";
import {
  appendWorkItemEvent,
  createWorkItem,
  type CreateWorkItemInput,
  type WorkItem,
} from "../work-items/store.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";
import { isTodoCaptureSession } from "./todo-capture-contract.js";

interface WorkItemCreateResult {
  item: WorkItem;
  replayed: boolean;
  labels?: Label[];
}

/** Create a Todo and apply creation-time companions in the same transaction. */
export function createWorkItemWithCompanions(
  input: CreateWorkItemInput,
  idempotencyKey: string | undefined,
  labelRefs: string[] | undefined,
  caller: WorkItemCaller,
): WorkItemCreateResult {
  const create = () => idempotencyKey
    ? createWorkItemIdempotent(input, idempotencyKey, labelRefs)
    : { item: createWorkItem(input), replayed: false };
  const captureDefault = caller.kind === "session" && isTodoCaptureSession(caller.session);
  if (labelRefs === undefined && !captureDefault) return create();

  return initDb().transaction(() => {
    const result = create();
    if (result.replayed) return result;
    const labels = labelRefs === undefined
      ? undefined
      : setWorkItemLabels(result.item.id, labelRefs, workItemActor(caller), caller.origin);
    if (captureDefault && setWorkItemKept(initDb(), result.item.id, true)) {
      appendWorkItemEvent({
        workItemId: result.item.id,
        kind: "kept_changed",
        actor: workItemActor(caller),
        detail: { kept: true, default: "quick-capture" },
        versionEffect: "audit",
      });
    }
    return { ...result, labels };
  })();
}

import type { Session } from "../shared/types.js";
import { TODO_SHAPER_NAME } from "./system-employees.js";

export const TODO_CAPTURE_ACTIONS = ["shape", "shape-and-dispatch"] as const;
export type TodoCaptureAction = (typeof TODO_CAPTURE_ACTIONS)[number];

export const TODO_CAPTURE_SESSION_KEY_PREFIX = "todo-shaper:";

/** A system Shaper is not enough: only sessions minted by the capture route
 * receive the capture defaults (notably pinning their newly created Todo). */
export function isTodoCaptureSession(
  session: Pick<Session, "employee" | "source" | "sourceRef" | "sessionKey">,
): boolean {
  const key = session.sessionKey || session.sourceRef;
  return session.employee === TODO_SHAPER_NAME
    && session.source === "web"
    && typeof key === "string"
    && key.startsWith(TODO_CAPTURE_SESSION_KEY_PREFIX);
}

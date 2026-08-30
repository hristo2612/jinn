import { startHeartbeatScheduler } from "../heartbeats/scheduler.js";
import { reapTalkSessions } from "./talk-api.js";

const TALK_SESSION_REAP_INTERVAL_MS = 30_000;

export type TalkSessionReaperSchedule = (run: () => void, intervalMs: number) => () => void;

function scheduleTalkSessionReaper(run: () => void, intervalMs: number): () => void {
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Start the idle-session reaper with the gateway lifecycle. Importing the
 * route module must not create a clock-driven process that mutates shared state
 * inside unit tests which never started a gateway. */
export function startTalkSessionReaper(
  schedule: TalkSessionReaperSchedule = scheduleTalkSessionReaper,
): () => void {
  return schedule(reapTalkSessions, TALK_SESSION_REAP_INTERVAL_MS);
}

/** Start the schedulers that enforce liveness for gateway-owned sessions. */
export function startSessionSchedulers(): () => void {
  const stopHeartbeatScheduler = startHeartbeatScheduler();
  const stopTalkSessionReaper = startTalkSessionReaper();
  return () => {
    stopHeartbeatScheduler();
    stopTalkSessionReaper();
  };
}

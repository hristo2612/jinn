import { logger } from "../../shared/logger.js";
import { employeeRemoteTarget } from "../../shared/remote-target.js";
import { ensureRemoteReady } from "../../engines/remote-stage.js";
import { getSession, updateSessionForAttempt } from "../registry.js";
import { notifyOperatorChannel } from "../callbacks.js";
import type { TurnInput } from "./types.js";

/**
 * Gate a turn on its employee's remote host being usable.
 *
 * Only remote employees are affected; for everyone else this is a synchronous
 * `{ ok: true }` and no state is touched.
 *
 * Why this lives on the turn path rather than inside the engine: a desktop that
 * has to be woken takes minutes, and the session should read as `waiting` — the
 * same status a rate-limited turn takes — rather than `running` against a
 * machine that is still POSTing. The engine's own pre-spawn check stays (it is
 * what re-verifies the mount at the last moment); this is the part that has an
 * operator to talk to.
 *
 * Deliberately NOT wired into the engine-health store. That store is keyed by
 * engine NAME and is consulted by the fallback walker for every session, so
 * recording "claude is unavailable" because one desktop is asleep would hold
 * back every local employee's turn too.
 */
/**
 * Only the interactive claude engine knows how to relocate a session over SSH.
 * Every other engine ignores `remoteHost` entirely and would run the turn on
 * the GATEWAY — with `--dangerously-skip-permissions`, against a checkout that
 * is not there — while the UI showed a remote employee working normally.
 */
function refuseNonRemoteEngine(
  input: TurnInput,
  remoteHost: string,
  engineName: string,
): { ok: false; error: string } | undefined {
  if (engineName === "claude") return undefined;
  return {
    ok: false,
    error: `Employee "${input.employee?.name ?? "?"}" is configured for remote execution on ${remoteHost}, `
      + `but the "${engineName}" engine has no remote support — the turn would run on the gateway instead. `
      + `Use the claude engine for remote employees.`,
  };
}

/** Hand the session back to the running path, or report that it is gone. */
function restoreAfterWait(
  input: TurnInput,
  announced: string,
): { ok: true } | { ok: false; error: string } {
  const sessionId = input.session.id;
  const restored = updateSessionForAttempt(sessionId, input.attemptToken, {
    status: "running",
    lastActivity: new Date().toISOString(),
    lastError: null,
  }, ["waiting"]);
  if (!restored) {
    // The fence refused: a stop (or a newer turn) took the session between the
    // last successful probe and here — a window `shouldAbort` cannot cover.
    // Ignoring the failed write would leave the caller believing the session is
    // `running` and spawn a remote PTY for a turn nobody wants.
    logger.info(`Session ${sessionId}: remote host became ready but the session is no longer waiting — not starting`);
    return { ok: false, error: "Session was stopped while waiting for the remote host" };
  }
  notifyOperatorChannel(`✅ ${announced} is up — ${input.employee?.displayName ?? "the employee"} is starting.`);
  logger.info(`Session ${sessionId}: ${announced} became ready`);
  return { ok: true };
}

export async function ensureRemoteHostReady(
  input: TurnInput,
  engineName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = employeeRemoteTarget(input.employee);
  if (!target) return { ok: true };

  const wrongEngine = refuseNonRemoteEngine(input, target.remoteHost!, engineName);
  if (wrongEngine) return wrongEngine;

  const sessionId = input.session.id;
  let announced: string | undefined;

  const readiness = await ensureRemoteReady(target, input.config.remote, {
    allowWake: true,
    onWaitStart: ({ destination, waking }) => {
      announced = destination;
      // Move to `waiting` BEFORE the wait, so the UI never shows a turn as
      // running against a host that is still booting.
      updateSessionForAttempt(sessionId, input.attemptToken, {
        status: "waiting",
        lastActivity: new Date().toISOString(),
        lastError: `${destination} is offline — ${waking ? "waking it" : "waiting for it"}`,
      });
      notifyOperatorChannel(
        `🔌 ${destination} is offline. ${waking ? "Waking it" : "Waiting for it"} before ${input.employee?.displayName ?? "the employee"} can start.`,
      );
    },
    // The operator stopping the session is the one thing that should end the
    // wait early. `waiting` is the status this gate set; anything else means
    // something took the session away from us.
    shouldAbort: () => getSession(sessionId)?.status !== "waiting",
  });

  if (!readiness.ready) {
    const error = `Remote host unavailable: ${readiness.reason}`;
    if (announced) notifyOperatorChannel(`❌ ${error}`);
    return { ok: false, error };
  }

  return announced ? restoreAfterWait(input, announced) : { ok: true };
}

import type { WebSocket } from "ws";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtyViewEngine } from "../engines/pty-view-engine.js";
import { getEngineSessionRef, getSession } from "../sessions/registry.js";
import { orgRegistry } from "./org-registry.js";
import { employeeRemoteTarget } from "../shared/remote-target.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

const RAW_KEY_INPUTS = new Set(["\r", "\x1b", "\t", "\x03", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]);
export const PTY_RESUME_DEADLINE_MS = 15_000;

interface AttachPtyWebSocketOptions {
  resumeDeadlineMs?: number;
}

/** Attach a snapshot-first, per-session PTY WebSocket. */
export function attachPtyWebSocket(
  ws: WebSocket,
  sessionId: string,
  engine: PtyViewEngine,
  options: AttachPtyWebSocketOptions = {},
): void {
  let disconnected = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalReady = false;
  let lastGeometry: { cols: number; rows: number } | undefined;
  const resumeDeadlineMs = options.resumeDeadlineMs ?? PTY_RESUME_DEADLINE_MS;

  const sendControl = (event: PtyControlEvent) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(event)); } catch { /* disconnected mid-send */ }
  };

  const clearResumeDeadline = () => {
    if (!resumeTimer) return;
    clearTimeout(resumeTimer);
    resumeTimer = undefined;
  };

  const armResumeDeadline = () => {
    clearResumeDeadline();
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (disconnected || terminalReady) return;
      sendControl({
        type: "error",
        message: "Terminal did not resume in time.",
        recoverable: true,
      });
    }, resumeDeadlineMs);
    resumeTimer.unref?.();
  };

  const handleControl = (event: PtyControlEvent) => {
    if (event.type === "ready") {
      terminalReady = true;
      clearResumeDeadline();
    } else if (event.type === "restoring") {
      terminalReady = false;
      const restoreViewing = didEnter || pendingViewing === true;
      didEnter = false;
      entryReady = false;
      pendingViewing = null;
      if (restoreViewing) queueMicrotask(() => applyViewingWhenReady(true));
      armResumeDeadline();
    } else if (event.type === "error" || event.type === "exited") {
      terminalReady = false;
      clearResumeDeadline();
    }
    sendControl(event);
  };

  // The manager synchronously registers a paused subscriber and captures an
  // exact sequence boundary. No live callback is released until start().
  const subscription = engine.subscribeWithSnapshot(
    sessionId,
    (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    handleControl,
  );

  void subscription.snapshot.then((initial) => {
    if (disconnected || ws.readyState !== ws.OPEN) return;
    sendControl({ type: "reset" });
    if (initial.snapshot) sendControl({ type: "snapshot", snapshot: initial.snapshot });
    if (initial.ready) {
      terminalReady = true;
      sendControl({ type: "ready" });
    } else {
      terminalReady = false;
      sendControl({ type: "restoring" });
    }
    // Events after the captured boundary can only flow after all framing above.
    subscription.start();
  }).catch((error) => {
    sendControl({
      type: "error",
      message: `failed to restore terminal snapshot: ${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
    });
    subscription.start();
  });

  const idleSpawnOpts = (cols: number, rows: number): PtyIdleSpawnOpts => {
    const session = getSession(sessionId);
    // The employee's remote target has to reach the idle spawn too. Without it
    // this path spawns claude on the GATEWAY and the engine adopts it as the
    // session's warm PTY, so the next real turn pastes into a local process —
    // a remote employee silently running here, looking entirely normal in the UI.
    const employee = session?.employee ? orgRegistry().get(session.employee) : undefined;
    const remote = employeeRemoteTarget(employee);
    return {
      engineSessionId: session ? getEngineSessionRef(session).id : undefined,
      model: session?.model ?? undefined,
      effortLevel: session?.effortLevel ?? undefined,
      cwd: JINN_HOME,
      ...remote,
      cols,
      rows,
    };
  };

  const spawnIfNeeded = (cols: number, rows: number): boolean => {
    try {
      engine.ensureIdleSpawn(sessionId, idleSpawnOpts(cols, rows));
      return true;
    } catch (error) {
      const message = `failed to start terminal: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn(`PTY websocket for ${sessionId}: ${message}`);
      sendControl({ type: "error", message, recoverable: true });
      return false;
    }
  };

  let didEnter = false;
  let pendingViewing: boolean | null = null;
  let entryReady = false;

  const applyViewing = (viewing: boolean) => {
    if (disconnected) return;
    if (viewing && !didEnter) {
      engine.setViewing(sessionId, true);
      didEnter = true;
    } else if (!viewing && didEnter) {
      engine.setViewing(sessionId, false);
      didEnter = false;
    }
  };

  const applyViewingWhenReady = (viewing: boolean, attempts = 20) => {
    if (disconnected) return;
    if (engine.hasWarmPty(sessionId)) {
      entryReady = true;
      applyViewing(viewing);
      return;
    }
    if (attempts <= 0) {
      pendingViewing = viewing;
      entryReady = false;
      return;
    }
    retryTimer = setTimeout(() => applyViewingWhenReady(viewing, attempts - 1), 100);
    retryTimer.unref?.();
  };

  ws.on("message", (raw) => {
    let message: any;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message?.type === "stdin" && typeof message.data === "string") {
      engine.writeStdin(sessionId, message.data);
    } else if (message?.type === "key" && typeof message.data === "string") {
      if (RAW_KEY_INPUTS.has(message.data)) engine.writeRaw(sessionId, message.data);
    } else if (message?.type === "resize" && validGeometry(message.cols, message.rows)) {
      const cols = Math.floor(message.cols);
      const rows = Math.floor(message.rows);
      lastGeometry = { cols, rows };
      const hadWarmPty = engine.hasWarmPty(sessionId);
      if (!spawnIfNeeded(cols, rows)) return;
      try {
        engine.resizePty(sessionId, cols, rows);
      } catch (error) {
        const detail = `failed to resize terminal: ${error instanceof Error ? error.message : String(error)}`;
        sendControl({ type: "error", message: detail, recoverable: true });
        return;
      }
      if (!terminalReady) armResumeDeadline();
      if (!entryReady && hadWarmPty) {
        entryReady = true;
        if (pendingViewing !== null) {
          applyViewing(pendingViewing);
          pendingViewing = null;
        }
      } else if (!entryReady && pendingViewing !== null) {
        const viewing = pendingViewing;
        pendingViewing = null;
        applyViewingWhenReady(viewing);
      }
    } else if (message?.type === "restart") {
      const geometry = lastGeometry;
      if (!geometry) {
        sendControl({ type: "error", message: "Terminal geometry is not ready yet.", recoverable: true });
        return;
      }
      terminalReady = false;
      sendControl({ type: "restoring" });
      const restoreViewing = didEnter || pendingViewing === true;
      didEnter = false;
      entryReady = false;
      pendingViewing = null;
      try {
        engine.restartPty(sessionId, idleSpawnOpts(geometry.cols, geometry.rows));
        armResumeDeadline();
        if (restoreViewing) applyViewingWhenReady(true);
      } catch (error) {
        sendControl({
          type: "error",
          message: `failed to restart terminal: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        });
      }
    } else if (message?.type === "viewing" && typeof message.viewing === "boolean") {
      if (!entryReady) pendingViewing = message.viewing;
      else applyViewing(message.viewing);
    }
  });

  const onDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    if (retryTimer) clearTimeout(retryTimer);
    clearResumeDeadline();
    pendingViewing = null;
    subscription.unsubscribe();
    if (didEnter) {
      engine.setViewing(sessionId, false);
      didEnter = false;
    }
  };
  ws.on("close", onDisconnect);
  ws.on("error", onDisconnect);
}

function validGeometry(cols: unknown, rows: unknown): cols is number {
  return typeof cols === "number"
    && typeof rows === "number"
    && Number.isFinite(cols)
    && Number.isFinite(rows)
    && cols > 0
    && rows > 0
    && cols <= 500
    && rows <= 250;
}

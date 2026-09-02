/**
 * What the hook endpoint injects into routeMemoryTrialHook for one request.
 *
 * Its own module so api.ts does not grow past its size budget: the guard is
 * cached per instance home, which needs a module-level map, and that map has no
 * business sitting among five thousand lines of routes.
 */
import path from "node:path";

import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { getEngineSessionRef, getSession, recordEngineSessionId } from "../sessions/registry.js";
import type { ApiContext } from "./api.js";

export type MemoryTrialHookRouteInjection = Pick<
  import("../memory-trial/hook-adapter.js").MemoryTrialHookRouteOptions,
  "enabled" | "circuitOpen" | "activationEpoch" | "triggers" | "projectRoot" | "dispatch" | "operationStore"
>;

const memoryTrialGuards = new Map<string, Promise<import("../memory-trial/guardrails.js").MemoryTrialGuard>>();

export function memoryTrialHookRouteOptions(context: ApiContext, hook: import("./hook-registry.js").HookPayload): MemoryTrialHookRouteInjection {
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

/**
 * Memory is optional and must never break the hook path: a guard refusal
 * (budget, circuit, eligibility) or a storage error is logged and the hook still
 * completes, so the caller's engineSessionId capture always runs.
 *
 * JAR-31 stays inert by default; a test may inject gates and dispatch on the
 * context to prove this path without enabling runtime effects.
 */
export async function routeHookThroughMemoryTrial(
  context: ApiContext,
  jinnSessionId: string,
  hook: import("./hook-registry.js").HookPayload,
  getSession: (id: string) => import("../shared/types.js").Session | undefined,
): Promise<import("../memory-trial/hook-adapter.js").MemoryTrialHookRouteResult> {
  const { routeMemoryTrialHook } = await import("../memory-trial/hook-adapter.js");
  const injected = (context as { memoryTrialHookRouteOptions?: MemoryTrialHookRouteInjection })
    .memoryTrialHookRouteOptions;
  return routeMemoryTrialHook({ ...(injected ?? memoryTrialHookRouteOptions(context, hook)), jinnSessionId, hook, getSession })
    .catch((error: unknown) => {
      logger.warn(`Memory trial hook ${hook.hook_event_name} skipped for ${jinnSessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return { routed: false as const, reason: "dispatch-failed" as const };
    });
}

/**
 * Persist claude's OWN session id the moment it reports one (SessionStart, or
 * Stop as backup), independent of turn state.
 *
 * Without this, an interrupted turn or an idle CLI-view spawn never persisted
 * the id, so the next cold respawn ran `claude` with resume:none -- a fresh
 * conversation, the convo-wipe bug. Write-once guarded so it is not chatty.
 */
export function captureEngineSessionId(jinnSessionId: string, hook: import("./hook-registry.js").HookPayload): void {
  const reports = hook.hook_event_name === "SessionStart" || hook.hook_event_name === "Stop";
  if (!reports || typeof hook.session_id !== "string" || !hook.session_id) return;
  const existing = getSession(jinnSessionId);
  if (existing && getEngineSessionRef(existing, "claude").id !== hook.session_id) {
    recordEngineSessionId(jinnSessionId, "claude", hook.session_id);
  }
}

/** The SessionStart extra a routed memory trial adds to the hook response. */
export function hookSpecificOutput(
  result: import("../memory-trial/hook-adapter.js").MemoryTrialHookRouteResult,
): Record<string, unknown> {
  if (!result.additionalContext) return {};
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: result.additionalContext } };
}

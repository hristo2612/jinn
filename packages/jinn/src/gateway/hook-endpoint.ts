import { timingSafeEqual } from "node:crypto";
import type { HookRegistry, HookPayload } from "./hook-registry.js";
import { evaluateCommandPolicy, evaluateWritePathPolicy } from "../shared/command-policy.js";

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
  /** `remote.mount` for a session running over SSH: the one place on the remote
   *  host where the gateway's JINN_HOME is really mounted. Undefined for every
   *  local session, which leaves the containment rule inert. The caller resolves
   *  it — this module deliberately knows nothing about org or session lookups so
   *  it stays unit-testable on its own. */
  remoteMountRoot?: string;
  /** The gateway's own JINN_HOME, for the same rule. */
  gatewayHome?: string;
}

/**
 * True if `addr` is a loopback address. Normalizes before comparing: lowercase,
 * strips the IPv4-mapped `::ffff:` prefix, and accepts `::1` plus the whole
 * 127.0.0.0/8 range (not just 127.0.0.1).
 */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  if (a === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

export function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): { status: number; body: string } {
  const rejected = validateHookPost(ctx, providedSecret, body);
  if (rejected) return rejected;
  ctx.reg.deliver(body.jinnSessionId!, body.hook!);
  return { status: 200, body: "ok" };
}

/** Authenticate and validate a hook without delivering it. The API route uses
 * this seam to classify an authenticated target before HookRegistry effects;
 * handleHookPost keeps its standalone validate-and-deliver contract. */
export function validateHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): { status: number; body: string } | undefined {
  // Loopback check first — defense-in-depth alongside any upstream check.
  if (!isLoopback(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  // Defense-in-depth: an empty server secret would allow any client (including one
  // sending no header) to pass timingSafeEqual against an empty buffer. The daemon
  // guards against this upstream in api.ts, but make the endpoint safe standalone.
  if (!ctx.secret || ctx.secret.length === 0) {
    return { status: 401, body: "unauthorized" };
  }
  const a = Buffer.from(providedSecret ?? "", "utf-8");
  const b = Buffer.from(ctx.secret, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 403, body: "forbidden" };
  }
  if (!body.jinnSessionId || !body.hook?.hook_event_name) {
    return { status: 400, body: "bad request" };
  }
  if (body.hook.hook_event_name === "PreToolUse") {
    const opts = { remoteMountRoot: ctx.remoteMountRoot, gatewayHome: ctx.gatewayHome };
    const input = body.hook.tool_input;
    const field = (name: string): string =>
      input && typeof input === "object" && name in input
        ? String((input as Record<string, unknown>)[name] ?? "")
        : "";
    if (body.hook.tool_name === "Bash") {
      const decision = evaluateCommandPolicy(field("command"), opts);
      if (decision.action === "block") {
        return { status: 451, body: decision.reason || "Command blocked by Jinn security policy" };
      }
    } else if (body.hook.tool_name === "Write" || body.hook.tool_name === "Edit" || body.hook.tool_name === "MultiEdit") {
      // Write/Edit carry a path, not a command line. Without this branch a
      // remote session could not `sh -c 'echo … > …'` its way past the mount
      // check but could still reach the same path with the file tools.
      const decision = evaluateWritePathPolicy(field("file_path"), opts);
      if (decision.action === "block") {
        return { status: 451, body: decision.reason || "Write blocked by Jinn security policy" };
      }
    }
  }
  return undefined;
}

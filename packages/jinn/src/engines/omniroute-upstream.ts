/**
 * Where a claude-omni binary sends its Anthropic traffic.
 *
 * OmniRoute fronts the API on a local port, so a PTY running `claude-omni` must
 * be proxied to that port and not to api.anthropic.com. Everything else keeps
 * the SsePtyProxy default.
 *
 * `env` is threaded in rather than read from process.env here: env handling
 * spread across modules is how JINN_HOME drifts between the gateway and the
 * children it spawns, and scripts/check-footguns.mjs fails a change that does it.
 */
import { SsePtyProxy, type SseDataEvent, type SsePtyProxyOpts, type UpstreamActivityInfo } from "./sse-pty-proxy.js";
import { logger } from "../shared/logger.js";

/** OmniRoute's default local listener, used when the variable is unset. */
const OMNIROUTE_DEFAULT_BASE_URL = "http://127.0.0.1:20128";

/** The `upstream` slice of SsePtyProxyOpts for this binary: present only for
 *  claude-omni, so a plain `claude` keeps the direct-to-Anthropic default. */
export function omniRouteUpstream(
  bin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Pick<SsePtyProxyOpts, "upstream"> {
  if (!(bin ?? "").includes("claude-omni")) return {};
  const url = new URL(env.JINN_OMNIROUTE_ANTHROPIC_BASE_URL || OMNIROUTE_DEFAULT_BASE_URL);
  const protocol = url.protocol as "http:" | "https:";
  return {
    upstream: {
      hostname: url.hostname,
      port: Number(url.port) || (protocol === "https:" ? 443 : 80),
      protocol,
    },
  };
}

/** Allocate and start a per-PTY SSE forward proxy. Returns the proxy and its
 *  port, or {port:0} if it failed to bind -- in which case the caller spawns the
 *  PTY WITHOUT ANTHROPIC_BASE_URL (direct to Anthropic): the turn still works,
 *  only live word-by-word streaming degrades. */
export async function startSseProxy(opts: {
  jinnSessionId: string;
  bin?: string;
  onEvent: (e: SseDataEvent) => void;
  /** ALL requests (main + subagent + background tasks) count here -- this is how
   *  the gateway knows the CLI is still working after the turn settled. */
  onUpstreamActivity: (info: UpstreamActivityInfo) => void;
}): Promise<{ proxy: SsePtyProxy; port: number }> {
  const proxy = new SsePtyProxy(opts.jinnSessionId, opts.onEvent, {
    ...omniRouteUpstream(opts.bin),
    onUpstreamActivity: opts.onUpstreamActivity,
  });
  try {
    return { proxy, port: await proxy.start() };
  } catch (err) {
    logger.warn(`SSE proxy failed to start for session ${opts.jinnSessionId} (streaming degraded): ${err instanceof Error ? err.message : String(err)}`);
    proxy.stop();
    return { proxy, port: 0 };
  }
}

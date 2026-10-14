import type { McpServerConfig, McpServerStdioConfig, ResolvedMcpConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";

const JINN_BUILTIN_SERVER = "jinn";

/**
 * Muse consumes MCP servers from `mcpServers` in its settings, and its
 * per-invocation lever is `-c mcpServers.<name>=<json>` — the CLI explicitly
 * refuses a whole-map `-c mcpServers=...` override ("address one server …
 * never the whole map", probe-verified against Muse 1.4.7). Both stdio
 * (`{command, args, env}`) and streamable-HTTP (`{url}`) entries are accepted
 * at config level; Muse treats every configured server as REQUIRED at
 * startup, so a server that cannot start fails the turn visibly instead of
 * silently degrading — which is what the attachment authed-smoke gate wants.
 *
 * The per-session capability rides inside the built-in server's `env` in the
 * `-c` JSON (and, mirrored, in the child env via {@link museJinnSessionEnv}).
 * That is the same same-uid trust boundary pi uses for env-carried identity;
 * the gateway bearer token itself is never serialized — the server reads it
 * from `<JINN_HOME>/gateway.json` per the resolver design.
 */

export interface MuseMcpArgs {
  args: string[];
  /** Names actually wired onto argv (empty when nothing resolved). */
  attachedNames: string[];
}

function isStdio(spec: McpServerConfig): spec is McpServerStdioConfig {
  return typeof (spec as McpServerStdioConfig).command === "string" && !!(spec as McpServerStdioConfig).command;
}

function jinnStdioSpec(resolvedMcp: ResolvedMcpConfig | undefined): McpServerStdioConfig | null {
  const spec = resolvedMcp?.mcpServers?.[JINN_BUILTIN_SERVER];
  return spec && isStdio(spec) ? spec : null;
}

/** Session identity for the muse child env (mirrors piJinnSessionEnv). */
export function museJinnSessionEnv(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, string> {
  const spec = jinnStdioSpec(resolvedMcp);
  const sessionId = spec?.env?.JINN_SESSION_ID;
  const capability = spec?.env?.JINN_SESSION_CAPABILITY;
  const workflowAttempt = spec?.env?.JINN_WORKFLOW_ATTEMPT;
  const gatewayUrl = spec?.env?.JINN_GATEWAY_URL;
  return sessionId && capability
    ? {
        JINN_SESSION_ID: sessionId,
        JINN_SESSION_CAPABILITY: capability,
        ...(gatewayUrl ? { JINN_GATEWAY_URL: gatewayUrl } : {}),
        ...(workflowAttempt === "1" ? { JINN_WORKFLOW_ATTEMPT: workflowAttempt } : {}),
      }
    : {};
}

const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Translate the resolved MCP set into muse `-c` argv pairs. A `jinn` server
 * the resolver attached but muse cannot wire is said out loud (mirrors pi):
 * the turn still runs, the model just improvises around the missing tools.
 */
export function buildMuseMcpArgs(resolvedMcp: ResolvedMcpConfig | undefined, sessionId: string): MuseMcpArgs {
  const servers = resolvedMcp?.mcpServers ?? {};
  const args: string[] = [];
  const attachedNames: string[] = [];

  const jinnSpec = servers[JINN_BUILTIN_SERVER] as (McpServerConfig & { url?: unknown }) | undefined;
  if (jinnSpec && !isStdio(jinnSpec)) {
    const shape = jinnSpec.url !== undefined ? "is URL-based" : "carries no command";
    logger.warn(`Muse engine is starting session ${sessionId} WITHOUT the jinn toolset: the resolved "jinn" server ${shape}, and the built-in server is stdio-only.`);
  }

  for (const [name, spec] of Object.entries(servers)) {
    if (!SAFE_SERVER_NAME.test(name)) {
      logger.warn(`Muse engine is skipping MCP server "${name}" for session ${sessionId}: the name cannot be addressed via -c mcpServers.<name>.`);
      continue;
    }
    let value: Record<string, unknown> | null = null;
    if (isStdio(spec)) {
      value = {
        command: spec.command,
        ...(spec.args?.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
      };
    } else {
      const url = (spec as { url?: unknown }).url;
      const headers = (spec as { headers?: unknown }).headers;
      if (typeof url === "string" && url) {
        value = { url, ...(headers && typeof headers === "object" ? { headers } : {}) };
      }
    }
    if (!value) {
      logger.warn(`Muse engine is skipping MCP server "${name}" for session ${sessionId}: unrecognized server shape (no command, no url).`);
      continue;
    }
    args.push("-c", `mcpServers.${name}=${JSON.stringify(value)}`);
    attachedNames.push(name);
  }

  return { args, attachedNames };
}

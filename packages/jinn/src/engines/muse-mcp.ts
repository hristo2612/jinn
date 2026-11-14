import type { McpServerConfig, McpServerStdioConfig, ResolvedMcpConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";

const JINN_BUILTIN_SERVER = "jinn";
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const SESSION_ENV_KEYS = ["JINN_SESSION_ID", "JINN_SESSION_CAPABILITY", "JINN_GATEWAY_URL"] as const;

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
 * Every `env` leaf under `mcpServers` is a *secret leaf* to the CLI: a
 * literal value refuses the run ("secret leaves need exactly one
 * whole-value `${VAR}` naming a set variable", probe-verified — even
 * JINN_HOME counts). So the `-c` JSON carries `${KEY}` references only and
 * the literal values ride the muse child env ({@link MuseMcpArgs.childEnv}),
 * which muse expands when spawning the server. The capability therefore
 * never reaches argv at all; the gateway bearer token is never serialized
 * either — the server reads it from `<JINN_HOME>/gateway.json` per the
 * resolver design.
 */

export interface MuseMcpArgs {
  args: string[];
  /** Names actually wired onto argv (empty when nothing resolved). */
  attachedNames: string[];
  /** Literal env for the muse child process, resolving the `${VAR}` refs in
   *  `args`. Merged across attached stdio servers in order; on a key
   *  collision the later server wins for every ref of that name (inherent
   *  to muse's whole-value expansion — the built-in's keys are unique). */
  childEnv: Record<string, string>;
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
  const specEnv = jinnStdioSpec(resolvedMcp)?.env;
  if (!specEnv?.JINN_SESSION_ID || !specEnv.JINN_SESSION_CAPABILITY) return {};
  const env: Record<string, string> = {};
  for (const key of SESSION_ENV_KEYS) {
    const value = specEnv[key];
    if (value) env[key] = value;
  }
  if (specEnv.JINN_WORKFLOW_ATTEMPT === "1") env.JINN_WORKFLOW_ATTEMPT = "1";
  return env;
}

/**
 * Translate the resolved MCP set into muse `-c` argv pairs. A `jinn` server
 * the resolver attached but muse cannot wire is said out loud (mirrors pi):
 * the turn still runs, the model just improvises around the missing tools.
 */
export function buildMuseMcpArgs(resolvedMcp: ResolvedMcpConfig | undefined, sessionId: string): MuseMcpArgs {
  warnUnattachableJinn(resolvedMcp, sessionId);
  const args: string[] = [];
  const attachedNames: string[] = [];
  const childEnv: Record<string, string> = {};
  for (const [name, spec] of Object.entries(resolvedMcp?.mcpServers ?? {})) {
    const wired = museServerValue(name, spec, sessionId);
    if (!wired) continue;
    args.push("-c", `mcpServers.${name}=${JSON.stringify(wired.value)}`);
    attachedNames.push(name);
    Object.assign(childEnv, wired.childEnv);
  }
  return { args, attachedNames, childEnv };
}

function warnUnattachableJinn(resolvedMcp: ResolvedMcpConfig | undefined, sessionId: string): void {
  const spec = resolvedMcp?.mcpServers?.[JINN_BUILTIN_SERVER] as (McpServerConfig & { url?: unknown }) | undefined;
  if (!spec || isStdio(spec)) return;
  const shape = spec.url !== undefined ? "is URL-based" : "carries no command";
  logger.warn(`Muse engine is starting session ${sessionId} WITHOUT the jinn toolset: the resolved "jinn" server ${shape}, and the built-in server is stdio-only.`);
}

type WiredServer = { value: Record<string, unknown>; childEnv: Record<string, string> };

function museServerValue(name: string, spec: McpServerConfig, sessionId: string): WiredServer | null {
  if (!SAFE_SERVER_NAME.test(name)) {
    logger.warn(`Muse engine is skipping MCP server "${name}" for session ${sessionId}: the name cannot be addressed via -c mcpServers.<name>.`);
    return null;
  }
  if (isStdio(spec)) return stdioValue(spec);
  const urlValue = urlServerValue(name, spec, sessionId);
  if (urlValue) return urlValue;
  logger.warn(`Muse engine is skipping MCP server "${name}" for session ${sessionId}: unrecognized server shape (no command, no url).`);
  return null;
}

function stdioValue(spec: McpServerStdioConfig): WiredServer {
  const childEnv = { ...(spec.env ?? {}) };
  const envRefs: Record<string, string> = {};
  for (const key of Object.keys(childEnv)) envRefs[key] = `\${${key}}`;
  return {
    value: {
      command: spec.command,
      ...(spec.args?.length ? { args: spec.args } : {}),
      ...(Object.keys(envRefs).length ? { env: envRefs } : {}),
    },
    childEnv,
  };
}

const WHOLE_VALUE_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function urlServerValue(name: string, spec: McpServerConfig, sessionId: string): WiredServer | null {
  const url = (spec as { url?: unknown }).url;
  if (typeof url !== "string" || !url) return null;
  const headers = refOnlyHeaders(name, (spec as { headers?: unknown }).headers, sessionId);
  return { value: { url, ...(headers ? { headers } : {}) }, childEnv: {} };
}

/** Header values are secret leaves too: only pre-formed `${VAR}` refs may
 *  pass (the operator then owns setting that var in the gateway env);
 *  literals are dropped loudly rather than refusing the whole turn. */
function refOnlyHeaders(name: string, raw: unknown, sessionId: string): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && WHOLE_VALUE_REF.test(value)) {
      headers[key] = value;
    } else {
      logger.warn(`Muse engine is dropping header "${key}" of MCP server "${name}" for session ${sessionId}: muse only accepts whole-value \${VAR} references for secret leaves.`);
    }
  }
  return Object.keys(headers).length ? headers : null;
}

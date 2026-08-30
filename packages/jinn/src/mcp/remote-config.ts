// packages/jinn/src/mcp/remote-config.ts
import path from "node:path";
import type { McpServerConfig, McpServerStdioConfig, ResolvedMcpConfig } from "../shared/types.js";
import { MCP_GATEWAY_URL_ARG, MCP_HOME_ARG } from "./identity.js";
import { SCRUB_ENTRY_BASENAME } from "./env-scrub.js";

/**
 * Rewrite a resolved MCP server set so it can be staged on a REMOTE host.
 *
 * A resolved set is built for the machine that resolved it, and three separate
 * producers bake the gateway's own filesystem into it:
 *   - `mcp/resolver.ts#buildJinnServerSpec` — `command: process.execPath` (the
 *     GATEWAY's node binary) and `args: [<gateway dist>/mcp/server-entry.js]`,
 *     plus `env.JINN_HOME` / `env.JINN_GATEWAY_URL`;
 *   - `mcp/env-scrub.ts#wrapServersWithScrub` — every third-party stdio server's
 *     command becomes `process.execPath` with `<gateway dist>/mcp/scrub-entry.js`
 *     prepended to its args;
 *   - `mcp/identity.ts#attachSessionIdentity` — appends `--jinn-session-id`,
 *     `--jinn-home <gateway home>` and `--jinn-gateway-url <url>`.
 *
 * Copied verbatim onto the remote box, every one of those points at a path that
 * does not exist there (or, worse, at a same-named path belonging to something
 * else), and the gateway URL names a port only the gateway can reach. This
 * module is the single place that re-points them at the staged remote copies and
 * at the reverse tunnel.
 *
 * The session id and its bound capability are deliberately NOT touched: they are
 * minted on the gateway by `ensureSessionCapability` and verified against the
 * gateway's own key, so the remote server must present exactly what it was given
 * (mcp/identity.ts).
 *
 * Pure: the input is never mutated (a resolved set may be shared or cached by
 * callers). Remote paths are built with `path.posix` — the remote is POSIX
 * regardless of whether the gateway runs on Windows.
 */

/** Basename of the built-in server's compiled entry; `buildJinnServerSpec`
 *  resolves it next to the compiled resolver, so only the basename is stable. */
const SERVER_ENTRY_BASENAME = "server-entry.js";

/** The two jinn-owned entry scripts that the staging step copies to the remote. */
const GATEWAY_ENTRY_BASENAMES: ReadonlySet<string> = new Set([SERVER_ENTRY_BASENAME, SCRUB_ENTRY_BASENAME]);

/** Env var naming the instance home a jinn MCP server reads its bearer from. */
const JINN_HOME_ENV = "JINN_HOME";

/** Env var naming the gateway a jinn MCP server calls. */
const JINN_GATEWAY_URL_ENV = "JINN_GATEWAY_URL";

export interface RemoteMcpRemapOpts {
  /** Absolute path to the node binary ON THE REMOTE host. */
  remoteNode: string;
  /** Absolute dir ON THE REMOTE holding the staged `server-entry.js` / `scrub-entry.js`. */
  remoteEntryDir: string;
  /** The remote `JINN_HOME` (the staging dir / symlink farm over the mount). */
  remoteHome: string;
  /** `http://127.0.0.1:<tunnelPort>` — the reverse tunnel back to the gateway. */
  gatewayUrl: string;
}

/**
 * Return a copy of `config` with every stdio server re-pointed at the remote
 * host. URL-transport servers are already host-independent and pass through by
 * reference.
 */
export function remapMcpConfigForRemote(config: ResolvedMcpConfig, opts: RemoteMcpRemapOpts): ResolvedMcpConfig {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(config.mcpServers)) {
    if (!("command" in spec) || typeof spec.command !== "string") {
      mcpServers[name] = spec;
      continue;
    }
    mcpServers[name] = remapStdioServer(spec, opts);
  }
  return { ...config, mcpServers };
}

function remapStdioServer(spec: McpServerStdioConfig, opts: RemoteMcpRemapOpts): McpServerStdioConfig {
  const out: McpServerStdioConfig = { ...spec };
  // Both producers above use the gateway's own interpreter; nothing else in a
  // resolved set legitimately names it, so the equality is the whole test.
  if (spec.command === process.execPath) out.command = opts.remoteNode;
  if (spec.args) out.args = remapArgs(spec.args, opts);
  if (spec.env) out.env = remapEnv(spec.env, opts);
  return out;
}

function remapArgs(args: readonly string[], opts: RemoteMcpRemapOpts): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const replacement = arg === MCP_HOME_ARG ? opts.remoteHome : arg === MCP_GATEWAY_URL_ARG ? opts.gatewayUrl : undefined;
    // A trailing flag with no value is left exactly as found: inventing a value
    // for it would change the argv the server is launched with.
    if (replacement !== undefined && index + 1 < args.length) {
      out.push(arg, replacement);
      index += 1;
      continue;
    }
    out.push(remapEntryArg(arg, opts.remoteEntryDir));
  }
  return out;
}

/**
 * Re-point an absolute path to one of jinn's own entry scripts at the staged
 * remote copy. A RELATIVE `server-entry.js` is left alone — it would be resolved
 * against the remote cwd, which is a third-party server's business, not ours.
 * Both separators are recognised because the gateway may be Windows while the
 * destination it is being rewritten for is always POSIX.
 */
function remapEntryArg(arg: string, remoteEntryDir: string): string {
  const basename = arg.slice(Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\")) + 1);
  if (!GATEWAY_ENTRY_BASENAMES.has(basename)) return arg;
  if (!path.posix.isAbsolute(arg) && !path.win32.isAbsolute(arg)) return arg;
  return path.posix.join(remoteEntryDir, basename);
}

function remapEnv(env: Record<string, string>, opts: RemoteMcpRemapOpts): Record<string, string> {
  const out = { ...env };
  // Only rewrite what is already there — adding JINN_HOME to a third-party
  // server that never asked for it would hand it an instance pointer.
  if (JINN_HOME_ENV in out) out[JINN_HOME_ENV] = opts.remoteHome;
  if (JINN_GATEWAY_URL_ENV in out) out[JINN_GATEWAY_URL_ENV] = opts.gatewayUrl;
  return out;
}

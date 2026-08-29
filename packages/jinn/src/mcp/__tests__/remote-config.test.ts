// packages/jinn/src/mcp/__tests__/remote-config.test.ts
/**
 * Remote (SSH) execution — the MCP set is resolved on the GATEWAY and consumed
 * on ANOTHER MACHINE.
 *
 * Three producers bake the gateway's filesystem into a resolved set:
 * `buildJinnServerSpec` (resolver.ts), `wrapServersWithScrub` (env-scrub.ts) and
 * `attachSessionIdentity` (identity.ts). The input here is built by running that
 * REAL pipeline rather than by hand, so a change to any of their shapes lands in
 * this file instead of silently shipping a config the remote cannot execute.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remapMcpConfigForRemote, type RemoteMcpRemapOpts } from "../remote-config.js";
import { resolveMcpServers } from "../resolver.js";
import { attachSessionIdentity, MCP_GATEWAY_URL_ARG, MCP_HOME_ARG, MCP_SESSION_ID_ARG } from "../identity.js";
import { setJinnAttachGate } from "../attachment.js";
import type { Employee, McpGlobalConfig, McpServerStdioConfig, ResolvedMcpConfig } from "../../shared/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/jinn — the gateway checkout the resolved set points into. */
const PKG_ROOT = path.resolve(HERE, "../../..");

/** JSON.stringify escapes Windows separators; compare against the escaped form
 *  so the end-to-end assertion means the same thing on both CI legs. */
const asJsonBody = (value: string): string => JSON.stringify(value).slice(1, -1);

const OPTS: RemoteMcpRemapOpts = {
  remoteNode: "/usr/local/lib/node/bin/node",
  remoteEntryDir: "/srv/jinn-work/.jinn-remote/mcp",
  remoteHome: "/srv/jinn-work/.jinn-remote/home",
  gatewayUrl: "http://127.0.0.1:45123",
};

const GATEWAY_URL = "http://127.0.0.1:7777";
const SESSION_ID = "sess-remote-1";

const globalMcp: McpGlobalConfig = {
  browser: { enabled: false },
  fetch: { enabled: true },
  custom: {
    docs: { url: "https://mcp.example.invalid/sse" },
  },
};

function buildResolved(): ResolvedMcpConfig {
  const resolved = resolveMcpServers(globalMcp, { name: "remote-employee" } as Employee, "claude");
  return attachSessionIdentity(resolved, SESSION_ID);
}

const stdio = (config: ResolvedMcpConfig, name: string): McpServerStdioConfig =>
  config.mcpServers[name] as McpServerStdioConfig;

describe("remapMcpConfigForRemote (real resolver → identity → scrub pipeline)", () => {
  let previousGatewayUrl: string | undefined;

  beforeEach(() => {
    setJinnAttachGate({ ok: true });
    previousGatewayUrl = process.env.JINN_GATEWAY_URL;
    process.env.JINN_GATEWAY_URL = GATEWAY_URL;
  });

  afterEach(() => {
    setJinnAttachGate(null);
    if (previousGatewayUrl === undefined) delete process.env.JINN_GATEWAY_URL;
    else process.env.JINN_GATEWAY_URL = previousGatewayUrl;
  });

  it("re-points the builtin jinn server at the remote node and the staged entry", () => {
    const input = buildResolved();
    // Premise: the resolver really did bake the gateway's own interpreter and
    // dist path in — otherwise the assertions below prove nothing.
    expect(stdio(input, "jinn").command).toBe(process.execPath);
    expect(stdio(input, "jinn").args?.[0]).toContain(PKG_ROOT);

    const jinn = stdio(remapMcpConfigForRemote(input, OPTS), "jinn");
    expect(jinn.command).toBe(OPTS.remoteNode);
    expect(jinn.args?.[0]).toBe("/srv/jinn-work/.jinn-remote/mcp/server-entry.js");
  });

  it("re-points a scrub-wrapped third-party server, keeping its real command and args", () => {
    const input = buildResolved();
    expect(stdio(input, "fetch").command).toBe(process.execPath);
    expect(stdio(input, "fetch").args?.[0]).toContain(PKG_ROOT);

    const fetchServer = stdio(remapMcpConfigForRemote(input, OPTS), "fetch");
    expect(fetchServer.command).toBe(OPTS.remoteNode);
    expect(fetchServer.args?.[0]).toBe("/srv/jinn-work/.jinn-remote/mcp/scrub-entry.js");
    // The wrapped-in command the launcher execs is the remote's business, not ours.
    expect(fetchServer.args?.slice(1)).toEqual(["uvx", "mcp-server-fetch"]);
  });

  it("leaves NO gateway path anywhere in the serialized config", () => {
    const input = buildResolved();
    const before = JSON.stringify(input);
    expect(before).toContain(asJsonBody(PKG_ROOT));
    expect(before).toContain(asJsonBody(process.execPath));

    const after = JSON.stringify(remapMcpConfigForRemote(input, OPTS));
    expect(after).not.toContain(asJsonBody(PKG_ROOT));
    expect(after).not.toContain(asJsonBody(process.execPath));
  });

  it("rewrites the bootstrap flag VALUES and the matching env, and nothing else", () => {
    const input = buildResolved();
    const inputJinn = stdio(input, "jinn");
    expect(inputJinn.args).toContain(MCP_HOME_ARG);
    expect(inputJinn.args).toContain(MCP_GATEWAY_URL_ARG);

    const jinn = stdio(remapMcpConfigForRemote(input, OPTS), "jinn");
    const args = jinn.args ?? [];
    expect(args[args.indexOf(MCP_HOME_ARG) + 1]).toBe(OPTS.remoteHome);
    expect(args[args.indexOf(MCP_GATEWAY_URL_ARG) + 1]).toBe(OPTS.gatewayUrl);
    expect(jinn.env?.JINN_HOME).toBe(OPTS.remoteHome);
    expect(jinn.env?.JINN_GATEWAY_URL).toBe(OPTS.gatewayUrl);

    // The session id and its bound capability are minted on the gateway and
    // verified there — a rewrite would make the remote server unauthorized.
    expect(args[args.indexOf(MCP_SESSION_ID_ARG) + 1]).toBe(SESSION_ID);
    expect(jinn.env?.JINN_SESSION_ID).toBe(SESSION_ID);
    expect(jinn.env?.JINN_SESSION_CAPABILITY).toBe(inputJinn.env?.JINN_SESSION_CAPABILITY);
  });

  it("passes URL-transport servers through and never mutates the input", () => {
    const input = buildResolved();
    const snapshot = structuredClone(input);

    const out = remapMcpConfigForRemote(input, OPTS);

    expect(out.mcpServers.docs).toBe(input.mcpServers.docs);
    expect(out.mcpServers.docs).toEqual({ type: "sse", url: "https://mcp.example.invalid/sse" });
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });
});

describe("remapMcpConfigForRemote (argument boundaries)", () => {
  it("fixes env JINN_GATEWAY_URL even when the flag is absent", () => {
    const input: ResolvedMcpConfig = {
      mcpServers: { jinn: { command: process.execPath, args: ["/gw/dist/mcp/server-entry.js"], env: { JINN_GATEWAY_URL: GATEWAY_URL, JINN_HOME: "/gw/home" } } },
    };
    const jinn = stdio(remapMcpConfigForRemote(input, OPTS), "jinn");
    expect(jinn.args).toEqual(["/srv/jinn-work/.jinn-remote/mcp/server-entry.js"]);
    expect(jinn.env).toEqual({ JINN_GATEWAY_URL: OPTS.gatewayUrl, JINN_HOME: OPTS.remoteHome });
  });

  it("leaves a trailing valueless flag and a non-absolute entry name alone", () => {
    const input: ResolvedMcpConfig = {
      mcpServers: { odd: { command: "npx", args: ["server-entry.js", MCP_HOME_ARG] } },
    };
    expect(stdio(remapMcpConfigForRemote(input, OPTS), "odd").args).toEqual(["server-entry.js", MCP_HOME_ARG]);
  });

  it("adds no instance env to a server that carries none", () => {
    const input: ResolvedMcpConfig = { mcpServers: { plain: { command: "npx", args: ["-y", "some-mcp"] } } };
    const plain = stdio(remapMcpConfigForRemote(input, OPTS), "plain");
    expect(plain).toEqual({ command: "npx", args: ["-y", "some-mcp"] });
    expect(plain.env).toBeUndefined();
  });
});

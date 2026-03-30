import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile } from "../resolver.js";

describe("resolveMcpServers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BRAVE_API_KEY: "test-key-123" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns empty mcpServers when globalMcp is undefined", () => {
    const result = resolveMcpServers(undefined);
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
  });

  it("resolves search server when enabled with env var API key", () => {
    const result = resolveMcpServers({
      search: { enabled: true, provider: "brave", apiKey: "${BRAVE_API_KEY}" },
    });
    expect(result.mcpServers.search).toBeDefined();
    expect(result.mcpServers.search.env?.BRAVE_API_KEY).toBe("test-key-123");
  });

  it("resolves fetch server when enabled", () => {
    const result = resolveMcpServers({
      fetch: { enabled: true },
    });
    expect(result.mcpServers.fetch).toBeDefined();
    expect(result.mcpServers.fetch.command).toBe("npx");
  });

  it("resolves gateway server by default (enabled !== false)", () => {
    const result = resolveMcpServers({});
    expect(result.mcpServers.gateway).toBeDefined();
  });

  it("excludes gateway server when explicitly disabled", () => {
    const result = resolveMcpServers({
      gateway: { enabled: false },
    });
    expect(result.mcpServers.gateway).toBeUndefined();
  });

  it("returns empty mcpServers when employee opts out with mcp: false", () => {
    const result = resolveMcpServers(
      { fetch: { enabled: true } },
      { mcp: false } as any,
    );
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
  });

  it("returns only requested servers when employee specifies an array", () => {
    const result = resolveMcpServers(
      {
        search: { enabled: true, provider: "brave", apiKey: "${BRAVE_API_KEY}" },
        fetch: { enabled: true },
      },
      { mcp: ["fetch"] } as any,
    );
    expect(result.mcpServers.fetch).toBeDefined();
    expect(result.mcpServers.search).toBeUndefined();
  });

  it("returns all enabled servers when employee has no mcp override", () => {
    const result = resolveMcpServers({
      search: { enabled: true, provider: "brave", apiKey: "${BRAVE_API_KEY}" },
      fetch: { enabled: true },
    });
    // search + fetch + browser (default) + gateway (default)
    expect(Object.keys(result.mcpServers).length).toBeGreaterThanOrEqual(3);
  });
});

describe("writeMcpConfigFile / cleanupMcpConfigFile", () => {
  const testSessionId = "test-session-mcp-write";
  let writtenPath: string;

  afterEach(() => {
    // Ensure cleanup
    cleanupMcpConfigFile(testSessionId);
  });

  it("writes a JSON config file and returns its path", () => {
    const config = { mcpServers: { test: { command: "echo", args: ["hi"] } } };
    writtenPath = writeMcpConfigFile(config, testSessionId);

    expect(fs.existsSync(writtenPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(writtenPath, "utf-8"));
    expect(content.mcpServers.test.command).toBe("echo");
  });

  it("cleanupMcpConfigFile removes the written file", () => {
    const config = { mcpServers: { test: { command: "echo", args: [] } } };
    writtenPath = writeMcpConfigFile(config, testSessionId);
    expect(fs.existsSync(writtenPath)).toBe(true);

    cleanupMcpConfigFile(testSessionId);
    expect(fs.existsSync(writtenPath)).toBe(false);
  });

  it("cleanupMcpConfigFile is safe to call when file does not exist", () => {
    expect(() => cleanupMcpConfigFile("nonexistent-session")).not.toThrow();
  });
});

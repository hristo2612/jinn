import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInstances, saveInstances } from "./directory.js";
import { expectPosixMode } from "../shared/test-support/posix-mode.js";
import {
  createInstance,
  normalizeWorkspaceName,
  resolveInstanceHome,
} from "./create.js";

const scratch: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-create-instance-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace naming", () => {
  it("derives a stable Jinn instance name and home suffix from a friendly name", () => {
    expect(normalizeWorkspaceName("John")).toEqual({
      displayName: "John",
      slug: "john",
      instanceName: "jinn-john",
      homeName: ".jinn-john",
    });
    expect(normalizeWorkspaceName("Acme Studio").instanceName).toBe("jinn-acme-studio");
  });

  it("rejects empty, traversal, numeric-only, and reserved names", () => {
    for (const name of ["", "../other", "123", "jinn"]) {
      expect(() => normalizeWorkspaceName(name)).toThrow(/workspace name/i);
    }
  });

  it("resolves legacy and prefixed selectors through registered homes", () => {
    const instances = [{ id: "id", name: "jinn-john", displayName: "John", port: 7788, home: "/custom/john", createdAt: "now" }];
    // A registered home is returned verbatim, so it stays exactly as stored.
    expect(resolveInstanceHome("john", instances, "/home/operator")).toBe("/custom/john");
    expect(resolveInstanceHome("jinn-john", instances, "/home/operator")).toBe("/custom/john");
    // An unregistered selector is derived with path.join, which correctly yields
    // native separators — backslashes on Windows. Build the expectation the same
    // way rather than hard-coding a POSIX path.
    expect(resolveInstanceHome("newco", [], "/home/operator")).toBe(path.join("/home/operator", ".jinn-newco"));
  });
});

describe("workspace creation", () => {
  it("sets up, configures, registers, starts, and provisions a fresh workspace", async () => {
    const root = tempDir();
    const registryPath = path.join(root, "host", "instances.json");
    const legacyRegistryPath = path.join(root, "missing.json");
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const execFile = vi.fn(async (_file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options?.env });
      if (args[1] === "setup") {
        const home = options?.env?.JINN_HOME as string;
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7777\nportal:\n  companyName: Jinn\n");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await createInstance({
      name: "John",
      currentPort: 7777,
      gatewayHost: "0.0.0.0",
      authRequired: true,
    }, {
      homeDir: root,
      registryPath,
      legacyRegistryPath,
      cliEntry: "/package/dist/bin/jinn.js",
      execFile,
      isPortAvailable: async () => true,
      waitForHealth: async () => true,
      provisionAccess: async () => ({ status: "configured", url: "https://machine.example.ts.net:7778" }),
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(result.instance).toMatchObject({
      name: "jinn-john",
      displayName: "John",
      port: 7778,
      home: path.join(root, ".jinn-john"),
      accessUrls: { remote: "https://machine.example.ts.net:7778" },
    });
    expect(result.warning).toBeUndefined();
    expect(calls.map((call) => call.args)).toEqual([
      ["/package/dist/bin/jinn.js", "setup"],
      ["/package/dist/bin/jinn.js", "start", "--daemon"],
    ]);
    expect(calls[0].env).toMatchObject({
      JINN_HOME: path.join(root, ".jinn-john"),
      JINN_INSTANCE: "jinn-john",
      JINN_SETUP_NAME: "John",
    });
    expect(fs.readFileSync(path.join(root, ".jinn-john", "config.yaml"), "utf8")).toContain("port: 7778");
    expect(fs.readFileSync(path.join(root, ".jinn-john", "config.yaml"), "utf8")).toContain("host: 0.0.0.0");
    expect(fs.readFileSync(path.join(root, ".jinn-john", "config.yaml"), "utf8")).toContain("authRequired: true");
    const gatewayPath = path.join(root, ".jinn-john", "gateway.json");
    const gateway = JSON.parse(fs.readFileSync(gatewayPath, "utf8")) as { token?: string };
    expect(gateway.token?.length).toBeGreaterThanOrEqual(32);
    expectPosixMode(fs.statSync(gatewayPath), 0o600);
    expect(loadInstances({ registryPath, legacyRegistryPath })).toHaveLength(1);
  });

  it("skips registered and occupied ports and removes a partial home when setup fails", async () => {
    const root = tempDir();
    const registryPath = path.join(root, "host", "instances.json");
    const legacyRegistryPath = path.join(root, "missing.json");
    saveInstances([{
      name: "jinn-main",
      port: 7777,
      home: path.join(root, ".jinn-main"),
      createdAt: "2026-01-01T00:00:00.000Z",
    }], { registryPath });
    const checked: number[] = [];
    const execFile = vi.fn(async (_file: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const home = options?.env?.JINN_HOME as string;
      fs.mkdirSync(home, { recursive: true });
      throw new Error("setup failed");
    });

    await expect(createInstance({ name: "John", currentPort: 7777 }, {
      homeDir: root,
      registryPath,
      legacyRegistryPath,
      cliEntry: "/package/dist/bin/jinn.js",
      execFile,
      isPortAvailable: async (port) => { checked.push(port); return port !== 7778; },
      waitForHealth: async () => false,
      provisionAccess: async () => ({ status: "not-detected" }),
    })).rejects.toThrow("setup failed");

    expect(checked).toEqual([7778, 7779]);
    expect(fs.existsSync(path.join(root, ".jinn-john"))).toBe(false);
    expect(loadInstances({ registryPath, legacyRegistryPath })).toHaveLength(1);
  });
});

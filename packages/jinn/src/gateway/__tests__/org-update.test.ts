import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import type { JinnConfig, Employee } from "../../shared/types.js";

let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { updateEmployeeYaml, validateEmployeeUpdate, scanOrg } from "../org.js";
import { invalidateModelRegistry } from "../../shared/models.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

function readYaml(subdir: string, filename: string): any {
  return yaml.load(fs.readFileSync(path.join(tmpDir, subdir, filename), "utf-8"));
}

// Minimal config with two claude models so we can exercise valid/invalid model changes.
const testConfig = {
  engines: { default: "claude" },
  models: {
    claude: {
      default: "opus",
      models: [
        { id: "opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
  },
} as unknown as JinnConfig;

function emp(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "dev",
    displayName: "Dev",
    department: "platform",
    rank: "senior",
    engine: "claude",
    model: "opus",
    persona: "A developer",
    ...overrides,
  };
}

describe("updateEmployeeYaml", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-update-test-"));
    invalidateModelRegistry();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates alwaysNotify field in existing YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
rank: senior
`);
    const result = updateEmployeeYaml("dev", { alwaysNotify: false });
    expect(result).toBe(true);

    const data = readYaml("platform", "dev.yaml");
    expect(data.alwaysNotify).toBe(false);
    expect(data.name).toBe("dev");
    expect(data.persona).toBe("A developer");
    expect(data.rank).toBe("senior");
  });

  it("sets alwaysNotify to true", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const result = updateEmployeeYaml("worker", { alwaysNotify: true });
    expect(result).toBe(true);

    const data = readYaml("platform", "worker.yaml");
    expect(data.alwaysNotify).toBe(true);
  });

  it("removes fields set to null", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
engine: claude
effortLevel: high
`);
    const result = updateEmployeeYaml("dev", { effortLevel: null });
    expect(result).toBe(true);

    const data = readYaml("platform", "dev.yaml");
    expect(data.effortLevel).toBeUndefined();
  });

  it("returns false for non-existent employee", () => {
    const result = updateEmployeeYaml("ghost", { alwaysNotify: false });
    expect(result).toBe(false);
  });

  it("preserves all other YAML fields when updating one field", () => {
    writeYaml("content", "lead.yaml", `
name: content-lead
displayName: Content Lead
department: content
rank: manager
engine: claude
model: opus
persona: The content lead
emoji: "🏠"
`);
    updateEmployeeYaml("content-lead", { alwaysNotify: false });

    const data = readYaml("content", "lead.yaml");
    expect(data.displayName).toBe("Content Lead");
    expect(data.department).toBe("content");
    expect(data.rank).toBe("manager");
    expect(data.engine).toBe("claude");
    expect(data.model).toBe("opus");
    expect(data.emoji).toBe("🏠");
    expect(data.alwaysNotify).toBe(false);
  });

  it("writes the wider field set (displayName, department, rank, engine, model, effortLevel, persona, reportsTo, cliFlags)", () => {
    writeYaml("platform", "wide.yaml", `
name: wide
persona: Original persona
rank: employee
`);
    const result = updateEmployeeYaml("wide", {
      displayName: "Wide Load",
      department: "ventures",
      rank: "manager",
      engine: "codex",
      model: "gpt-5.3-codex",
      effortLevel: "high",
      persona: "New persona",
      reportsTo: "boss",
      cliFlags: ["--chrome"],
      alwaysNotify: false,
    });
    expect(result).toBe(true);

    const data = readYaml("platform", "wide.yaml");
    expect(data.name).toBe("wide"); // immutable
    expect(data.displayName).toBe("Wide Load");
    expect(data.department).toBe("ventures");
    expect(data.rank).toBe("manager");
    expect(data.engine).toBe("codex");
    expect(data.model).toBe("gpt-5.3-codex");
    expect(data.effortLevel).toBe("high");
    expect(data.persona).toBe("New persona");
    expect(data.reportsTo).toBe("boss");
    expect(data.cliFlags).toEqual(["--chrome"]);
    expect(data.alwaysNotify).toBe(false);
  });

  it("never writes/renames the immutable name field", () => {
    writeYaml("platform", "safe.yaml", `
name: safe
persona: Original persona
rank: employee
`);
    // Even if a `name` sneaks into the updates object, it must be ignored.
    updateEmployeeYaml("safe", { name: "renamed", persona: "Changed" } as any);

    const data = readYaml("platform", "safe.yaml");
    expect(data.name).toBe("safe");
    expect(data.persona).toBe("Changed");
  });

  it("merges only provided keys, preserving untouched fields", () => {
    writeYaml("platform", "merge.yaml", `
name: merge
displayName: Merge Me
department: platform
rank: senior
engine: claude
model: opus
persona: Keep me
emoji: "🧩"
`);
    updateEmployeeYaml("merge", { rank: "manager" });

    const data = readYaml("platform", "merge.yaml");
    expect(data.rank).toBe("manager");
    expect(data.displayName).toBe("Merge Me");
    expect(data.persona).toBe("Keep me");
    expect(data.emoji).toBe("🧩");
    expect(data.engine).toBe("claude");
    expect(data.model).toBe("opus");
  });
});

describe("validateEmployeeUpdate", () => {
  beforeEach(() => {
    invalidateModelRegistry();
  });

  it("accepts a valid multi-field update and returns coerced updates", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), {
      displayName: "New Name",
      rank: "manager",
      model: "sonnet",
      effortLevel: "high",
      persona: "Fresh persona",
    });
    expect(r.ok).toBe(true);
    expect(r.updates).toMatchObject({
      displayName: "New Name",
      rank: "manager",
      model: "sonnet",
      effortLevel: "high",
      persona: "Fresh persona",
    });
  });

  it("rejects the immutable name field", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { name: "renamed" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name/i);
  });

  it("rejects unknown keys", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { bogusField: 1 } as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bogusField|unknown/i);
  });

  it("rejects an invalid rank enum", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { rank: "boss" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rank/i);
  });

  it("rejects an unknown model for the engine", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { model: "ultrabad" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/model/i);
  });

  it("rejects an invalid effort level", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { effortLevel: "ultra" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/effort/i);
  });

  it("rejects an unknown engine", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { engine: "wat" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/engine/i);
  });

  it("validates model against the NEW engine when engine changes", () => {
    // switching to codex with a valid codex model should pass
    const ok = validateEmployeeUpdate(testConfig, emp(), {
      engine: "codex",
      model: "gpt-5.5",
    });
    expect(ok.ok).toBe(true);
    // a claude model is invalid for codex
    const bad = validateEmployeeUpdate(testConfig, emp(), {
      engine: "codex",
      model: "opus",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/model/i);
  });

  it("clears stale effortLevel when switching to an engine/model with no effort support", () => {
    const config = {
      ...testConfig,
      models: {
        ...(testConfig as any).models,
        antigravity: {
          models: [{ id: "gemini-flash", supportsEffort: false, effortLevels: [] }],
        },
      },
    } as unknown as JinnConfig;

    const r = validateEmployeeUpdate(config, emp({ effortLevel: "high" }), {
      engine: "antigravity",
      model: "gemini-flash",
    });

    expect(r.ok).toBe(true);
    expect(r.updates).toMatchObject({ engine: "antigravity", model: "gemini-flash", effortLevel: null });
  });

  it("rejects an empty/whitespace persona (G3)", () => {
    const empty = validateEmployeeUpdate(testConfig, emp(), { persona: "" });
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/persona/i);
    const blank = validateEmployeeUpdate(testConfig, emp(), { persona: "   " });
    expect(blank.ok).toBe(false);
  });

  it("rejects an empty/whitespace displayName (G3)", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { displayName: "  " });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/displayName/i);
  });

  it("rejects wrong-typed cliFlags / alwaysNotify / reportsTo", () => {
    expect(validateEmployeeUpdate(testConfig, emp(), { cliFlags: "nope" as any }).ok).toBe(false);
    expect(validateEmployeeUpdate(testConfig, emp(), { alwaysNotify: "yes" as any }).ok).toBe(false);
    expect(validateEmployeeUpdate(testConfig, emp(), { reportsTo: 42 as any }).ok).toBe(false);
  });

  it("accepts reportsTo as a string or string array", () => {
    expect(validateEmployeeUpdate(testConfig, emp(), { reportsTo: "lead" }).ok).toBe(true);
    expect(validateEmployeeUpdate(testConfig, emp(), { reportsTo: ["a", "b"] }).ok).toBe(true);
  });

  it("rejects an empty update with no recognized fields", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), {});
    expect(r.ok).toBe(false);
  });
});

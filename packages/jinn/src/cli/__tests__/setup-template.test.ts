import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/** The default config is a template string, so a YAML mistake in it is invisible
 *  until a user runs `jinn setup` and their install is broken. Model ids
 *  containing "[" (the 1M-context variants) are the sharp edge: "[" is a YAML
 *  indicator, so an unquoted opus[1m] parses fine in block style and throws in
 *  flow style — which is what the template uses. */
const setupSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../setup.ts"),
  "utf8",
);

/** Pull DEFAULT_CONFIG out of the source and neutralise its one interpolation. */
function defaultConfigYaml(): string {
  const m = /const DEFAULT_CONFIG = `([\s\S]*?)`;/.exec(setupSrc);
  if (!m) throw new Error("DEFAULT_CONFIG template literal not found in setup.ts");
  return m[1].replace(/\$\{getPackageVersion\(\)\}/g, "0.0.0-test");
}

describe("setup.ts DEFAULT_CONFIG", () => {
  it("is valid YAML", () => {
    expect(() => YAML.parse(defaultConfigYaml())).not.toThrow();
  });

  it("parses every model id as a plain string", () => {
    const cfg = YAML.parse(defaultConfigYaml()) as {
      models: Record<string, { models: { id: unknown; label: unknown }[] }>;
    };
    for (const [engine, block] of Object.entries(cfg.models ?? {})) {
      for (const m of block.models ?? []) {
        expect(typeof m.id, `${engine} model id ${JSON.stringify(m.id)} must be a string`).toBe("string");
        expect(String(m.id).length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps bracketed ids intact — an unquoted [1m] would parse as a sequence", () => {
    const cfg = YAML.parse(defaultConfigYaml()) as {
      models: Record<string, { models: { id: string }[] }>;
    };
    const ids = cfg.models.claude.models.map((m) => m.id);
    for (const id of ["opus[1m]", "sonnet[1m]"]) {
      expect(ids, `${id} must survive parsing verbatim`).toContain(id);
    }
  });

  it("every engine default names a model present in that engine's roster", () => {
    const cfg = YAML.parse(defaultConfigYaml()) as {
      models: Record<string, { default: string; models: { id: string }[] }>;
    };
    for (const [engine, block] of Object.entries(cfg.models ?? {})) {
      if (!block?.default) continue;
      expect(block.models.map((m) => m.id), `${engine} default must exist in its roster`).toContain(block.default);
    }
  });
});

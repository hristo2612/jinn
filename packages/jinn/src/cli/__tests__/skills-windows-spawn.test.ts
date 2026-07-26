import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

import { runNpxSkills } from "../skills.js";

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  spawnSync.mockClear();
});

// Windows ships npx as npx.cmd, which Node refuses to spawn with shell:false
// (EINVAL since 18.20.2) — every `jinn skills` subcommand failed there (issue #87).
describe("runNpxSkills on Windows", () => {
  it("spawns through a shell with quoted args", () => {
    setPlatform("win32");

    const result = runNpxSkills(["find", "code review"], "pipe");

    expect(result.status).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ['"skills"', '"find"', '"code review"'],
      { stdio: "pipe", shell: true },
    );
  });

  it("refuses args containing shell metacharacters instead of spawning", () => {
    setPlatform("win32");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = runNpxSkills(["add", "owner/repo & calc.exe", "-g", "-y"], "pipe");

    expect(result.status).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
    err.mockRestore();
  });

  // Windows parses a command line with MSVCRT rules, where backslashes before a
  // quote escape it. A bare `"${arg}"` therefore let an argument ending in a
  // backslash consume its own closing quote: `dir\` reached the child as `dir"`,
  // taking the following argument with it. Directory arguments end in a
  // backslash routinely, so this is ordinary input, not a crafted one.
  it("doubles a trailing backslash run so the argument cannot swallow the next", () => {
    setPlatform("win32");

    const result = runNpxSkills(["add", "C:\\skills\\mine\\", "-g"], "pipe");

    expect(result.status).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ['"skills"', '"add"', '"C:\\skills\\mine\\\\"', '"-g"'],
      { stdio: "pipe", shell: true },
    );
  });

  it("leaves interior backslashes untouched so ordinary paths are unchanged", () => {
    setPlatform("win32");

    runNpxSkills(["add", "C:\\path\\to\\skill"], "pipe");

    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ['"skills"', '"add"', '"C:\\path\\to\\skill"'],
      { stdio: "pipe", shell: true },
    );
  });
});

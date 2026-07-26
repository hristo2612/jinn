import { describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

import { quoteWindowsArg, runNpxSkills } from "../skills.js";

describe("skills CLI process spawning", () => {
  // The POSIX contract. The Windows branch cannot pass argv with the shell
  // disabled — npx.cmd is unspawnable that way — and lives in
  // skills-windows-spawn.test.ts, which stubs process.platform so those cases
  // execute on CI instead of skipping on a non-Windows runner.
  it.skipIf(process.platform === "win32")("passes user-controlled skill args as argv with shell disabled", () => {
    runNpxSkills(["add", "owner/repo; touch /tmp/pwned", "-g", "-y"], "pipe");

    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "owner/repo; touch /tmp/pwned", "-g", "-y"],
      { stdio: "pipe", shell: false },
    );
  });
});

/**
 * Windows parses a command line with MSVCRT rules: a run of backslashes is
 * literal except immediately before a quote, where 2n backslashes yield n
 * literal backslashes and the quote still closes the string.
 *
 * Platform-independent, so these run everywhere.
 */
describe("quoteWindowsArg", () => {
  it("doubles an odd trailing backslash run so the closing quote survives", () => {
    expect(quoteWindowsArg("trailing\\")).toBe('"trailing\\\\"');
    expect(quoteWindowsArg("three\\\\\\")).toBe('"three\\\\\\\\\\\\"');
  });

  it("doubles an even trailing run too, which would otherwise be silently halved", () => {
    expect(quoteWindowsArg("two\\\\")).toBe('"two\\\\\\\\"');
    expect(quoteWindowsArg("four\\\\\\\\")).toBe('"four\\\\\\\\\\\\\\\\"');
  });

  it("handles a directory argument ending in a separator", () => {
    // The realistic input: `jinn skills add C:\skills\mine\`.
    expect(quoteWindowsArg("C:\\path\\")).toBe('"C:\\path\\\\"');
    expect(quoteWindowsArg("C:\\skills\\mine\\")).toBe('"C:\\skills\\mine\\\\"');
  });

  it("leaves interior backslashes alone so Windows paths stay intact", () => {
    expect(quoteWindowsArg("C:\\path\\to\\skill")).toBe('"C:\\path\\to\\skill"');
    expect(quoteWindowsArg("a\\b\\c")).toBe('"a\\b\\c"');
  });

  it("quotes ordinary arguments without altering them", () => {
    expect(quoteWindowsArg("owner/repo")).toBe('"owner/repo"');
    expect(quoteWindowsArg("owner/repo; touch /tmp/pwned")).toBe('"owner/repo; touch /tmp/pwned"');
    expect(quoteWindowsArg("")).toBe('""');
  });
});

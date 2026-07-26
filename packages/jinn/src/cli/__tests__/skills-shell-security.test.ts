import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

import { quoteWindowsArg, runNpxSkills } from "../skills.js";

// The two platforms defend this differently and the difference is the point:
// POSIX passes argv with no shell at all, while Windows cannot spawn npx.cmd
// without a shell (EINVAL since Node 18.20.2, the BatBadBut mitigation) and so
// relies on rejecting metacharacters plus correct quoting. Asserting the POSIX
// contract on both hid the Windows path from review entirely.
const onWindows = process.platform === "win32";

beforeEach(() => {
  spawnSync.mockClear();
});

describe("skills CLI process spawning", () => {
  it.skipIf(onWindows)("passes user-controlled skill args as argv with shell disabled", () => {
    runNpxSkills(["add", "owner/repo; touch /tmp/pwned", "-g", "-y"], "pipe");

    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "owner/repo; touch /tmp/pwned", "-g", "-y"],
      { stdio: "pipe", shell: false },
    );
  });

  it.skipIf(!onWindows)("quotes every argument and never reaches a shell unquoted", () => {
    const status = runNpxSkills(["add", "owner/repo; touch /tmp/pwned", "-g", "-y"], "pipe");

    expect(status).toEqual({ status: 0 });
    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ['"skills"', '"add"', '"owner/repo; touch /tmp/pwned"', '"-g"', '"-y"'],
      { stdio: "pipe", shell: true },
    );
  });

  it.skipIf(!onWindows)("refuses arguments carrying cmd.exe metacharacters instead of quoting them", () => {
    for (const payload of ['a" & calc & "b', "x | whoami", "x & calc", "x > out", "x ^ y", "%PATH%", "back`tick", "line\nbreak"]) {
      spawnSync.mockClear();
      expect(runNpxSkills(["add", payload], "pipe")).toEqual({ status: 1 });
      expect(spawnSync).not.toHaveBeenCalled();
    }
  });
});

describe("quoteWindowsArg", () => {
  // Windows parses a command line with MSVCRT rules: backslashes before a quote
  // escape it. Naive `"${arg}"` therefore let a trailing backslash consume the
  // closing quote and smuggle a literal " into the child's argv — the exact
  // character the metacharacter filter rejects.
  it("doubles a trailing backslash run so the closing quote survives", () => {
    expect(quoteWindowsArg("trailing\\")).toBe('"trailing\\\\"');
    expect(quoteWindowsArg("two\\\\")).toBe('"two\\\\\\\\"');
  });

  it("leaves interior backslashes alone so Windows paths stay intact", () => {
    expect(quoteWindowsArg("C:\\path\\to\\skill")).toBe('"C:\\path\\to\\skill"');
  });

  it("quotes ordinary arguments without altering them", () => {
    expect(quoteWindowsArg("owner/repo")).toBe('"owner/repo"');
    expect(quoteWindowsArg("owner/repo; touch /tmp/pwned")).toBe('"owner/repo; touch /tmp/pwned"');
  });
});

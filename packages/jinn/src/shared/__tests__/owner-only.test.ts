import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enforceOwnerOnlyDirectory, parseSddlTrustees, pathIsOwnerOnly } from "../owner-only.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-owner-only-"));
  roots.push(dir);
  return dir;
}

/**
 * Real `icacls /save` output. SDDL is the locale-independent form: trustees are
 * two-letter well-known aliases or raw SIDs, never names resolved into the system
 * locale. Matching on names meant a German Windows saw every path as shared.
 */
const OWNER_ONLY = String.raw`jinn
D:AI(A;OICIID;FA;;;S-1-5-21-111-222-333-1001)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`;

const SHARED_WITH_GROUP = String.raw`jinn
D:AI(A;OICI;0x1200a9;;;S-1-5-21-999-888-777-1005)(A;OICIID;FA;;;S-1-5-21-111-222-333-1001)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`;

describe("parseSddlTrustees", () => {
  it("extracts every granted trustee from the DACL", () => {
    expect(parseSddlTrustees(OWNER_ONLY)).toEqual([
      "S-1-5-21-111-222-333-1001",
      "SY",
      "BA",
    ]);
  });

  it("sees a group that an owner-only check must reject", () => {
    expect(parseSddlTrustees(SHARED_WITH_GROUP)).toContain("S-1-5-21-999-888-777-1005");
  });

  it("ignores Deny ACEs, which cannot make a path reachable", () => {
    const sddl = String.raw`x
D:(D;;FA;;;S-1-5-21-4-4-4-4)(A;;FA;;;SY)`;
    expect(parseSddlTrustees(sddl)).toEqual(["SY"]);
  });

  it("returns nothing when there is no DACL, so callers fail closed", () => {
    expect(parseSddlTrustees("Access is denied.")).toEqual([]);
    expect(parseSddlTrustees("")).toEqual([]);
  });

  it("skips malformed ACEs rather than guessing a trustee", () => {
    expect(parseSddlTrustees("x\nD:(A;;FA)(A;;FA;;;SY)")).toEqual(["SY"]);
  });
});

describe("pathIsOwnerOnly", () => {
  it.skipIf(process.platform === "win32")("reads POSIX bits: 0700 is owner-only, 0755 is not", () => {
    const dir = tempDir();
    fs.chmodSync(dir, 0o700);
    expect(pathIsOwnerOnly(dir)).toBe(true);
    fs.chmodSync(dir, 0o755);
    expect(pathIsOwnerOnly(dir)).toBe(false);
    fs.chmodSync(dir, 0o750);
    expect(pathIsOwnerOnly(dir)).toBe(false); // group read still counts as shared
  });

  it("fails closed for a path that does not exist", () => {
    // Must not throw: the gateway calls this unguarded at boot on every platform,
    // so a missing path has to answer "not owner only" rather than crash.
    expect(pathIsOwnerOnly(path.join(tempDir(), "definitely-absent"))).toBe(false);
  });

  it("answers for a real path on this platform without throwing", () => {
    expect(typeof pathIsOwnerOnly(tempDir())).toBe("boolean");
  });
});

describe("enforceOwnerOnlyDirectory", () => {
  it("reports the verified state, never a bare exit code", () => {
    // The caller prints this as an assurance ("Restricted ~/.jinn to your
    // account"), so the return value has to mean the directory IS owner-only
    // afterwards. On Windows /grant:r replaces permissions only for the trustees
    // it names, so a pre-existing explicit ACE for an unrelated group can survive
    // a successful invocation — returning true on exit code alone would be the
    // same "reports success, silently does nothing" bug this module removes.
    const dir = tempDir();
    const applied = enforceOwnerOnlyDirectory(dir);
    expect(applied).toBe(pathIsOwnerOnly(dir));
    if (applied) expect(pathIsOwnerOnly(dir)).toBe(true);
  });

  it("fails closed for a path that does not exist, without throwing", () => {
    // A hardening failure must not stop the gateway from starting.
    expect(enforceOwnerOnlyDirectory(path.join(tempDir(), "definitely-absent"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("tightens a group-readable directory", () => {
    const dir = tempDir();
    fs.chmodSync(dir, 0o755);
    expect(pathIsOwnerOnly(dir)).toBe(false);
    expect(enforceOwnerOnlyDirectory(dir)).toBe(true);
    expect(pathIsOwnerOnly(dir)).toBe(true);
  });
});

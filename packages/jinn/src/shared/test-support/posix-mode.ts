import fs from "node:fs";
import { expect } from "vitest";

/** Windows has no POSIX permission bits. fs.chmod there only toggles the
 *  read-only attribute, so a file written with mode 0o600 reports 0o666 and a
 *  directory reports 0o777 — every owner-only assertion fails for a reason the
 *  code cannot fix.
 *
 *  IMPORTANT: this is a gap in the platform, not only in the tests. Files Jinn
 *  intends to be owner-only (gateway tokens, pairing challenges, per-session MCP
 *  configs carrying capabilities, instance keys) are NOT restricted on Windows;
 *  achieving that needs ACLs, which Jinn does not set today. Skipping the
 *  assertion keeps the suite honest on Windows without implying the property
 *  holds there. */
export const POSIX_MODES_SUPPORTED = process.platform !== "win32";

/** Assert permission bits, where the platform can express them. Accepts a path
 *  or an already-taken Stats, so call sites read the way they did before. */
export function expectPosixMode(target: string | fs.Stats, expected: number): void {
  if (!POSIX_MODES_SUPPORTED) return;
  const stats = typeof target === "string" ? fs.statSync(target) : target;
  expect(stats.mode & 0o777).toBe(expected);
}

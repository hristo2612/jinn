import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveBin } from "../resolve-bin.js";

describe("resolveBin", () => {
  let tmpDir: string;
  let exePath: string;
  const NAME = "jinn-fake-engine-xyz";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolvebin-"));
    exePath = path.join(tmpDir, NAME);
    fs.writeFileSync(exePath, "#!/bin/sh\necho hi\n");
    fs.chmodSync(exePath, 0o755);
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("honors an absolute-path override verbatim", () => {
    expect(resolveBin("agy", exePath)).toBe(exePath);
  });

  it("honors an explicit path override even if it does not exist yet (so spawn surfaces a clear error)", () => {
    const missing = path.join(tmpDir, "does", "not", "exist");
    expect(resolveBin("agy", missing)).toBe(missing);
  });

  it("finds an executable on PATH", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prev ?? ""}`;
    try {
      expect(resolveBin(NAME)).toBe(exePath);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("treats a bare-name override as the name to resolve", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prev ?? ""}`;
    try {
      // resolve "agy" but override tells it to look for our fake name instead
      expect(resolveBin("agy", NAME)).toBe(exePath);
    } finally {
      process.env.PATH = prev;
    }
  });

  it("falls back to the bare name when nothing is found (spawn will try its own PATH)", () => {
    const prev = process.env.PATH;
    process.env.PATH = ""; // nothing on PATH
    try {
      // Use a name that won't exist in the hardcoded common dirs either.
      expect(resolveBin("definitely-not-a-real-binary-zzz")).toBe("definitely-not-a-real-binary-zzz");
    } finally {
      process.env.PATH = prev;
    }
  });

  it("ignores a blank override", () => {
    const prev = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prev ?? ""}`;
    try {
      expect(resolveBin(NAME, "   ")).toBe(exePath);
    } finally {
      process.env.PATH = prev;
    }
  });

  it.skipIf(process.platform !== "win32")("finds a .cmd shim, which is how npm installs a CLI on Windows", () => {
    // The bug behind #103's first half: dir + bare name matches nothing, because
    // an npm-installed `codex` on Windows is `codex.cmd`. Resolution then fell
    // through to the bare name, and CreateProcess cannot start that either — it
    // tries .exe and .com but never .cmd.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolvebin-cmd-"));
    const shim = path.join(shimDir, "jinn-fake-shim-xyz.cmd");
    fs.writeFileSync(shim, "@echo off\r\n");
    const prev = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${prev ?? ""}`;
    try {
      expect(resolveBin("jinn-fake-shim-xyz")).toBe(shim);
    } finally {
      process.env.PATH = prev;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("prefers PATHEXT order, so a real .exe wins over a .cmd shim", () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolvebin-order-"));
    const base = path.join(shimDir, "jinn-fake-order-xyz");
    fs.writeFileSync(`${base}.cmd`, "@echo off\r\n");
    fs.writeFileSync(`${base}.exe`, "");
    const prev = process.env.PATH;
    const prevExt = process.env.PATHEXT;
    process.env.PATH = `${shimDir}${path.delimiter}${prev ?? ""}`;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    try {
      // A native executable is spawnable directly and needs no interpreter, so
      // it must win when both exist.
      expect(resolveBin("jinn-fake-order-xyz")).toBe(`${base}.exe`);
    } finally {
      process.env.PATH = prev;
      if (prevExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = prevExt;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

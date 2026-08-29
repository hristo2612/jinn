import { describe, it, expect } from "vitest";
import {
  isRemoteTarget,
  isUnderRoot,
  validateRemoteTarget,
  assertRemoteTarget,
  sshDestination,
  employeeRemoteTarget,
} from "../remote-target.js";
import type { Employee, RemoteTarget } from "../types.js";
import type { RemoteExecutionConfig } from "../config-types.js";

const ROOT = "/srv/jinn-work";
const remote = (over: Partial<RemoteExecutionConfig> = {}): RemoteExecutionConfig => ({
  root: ROOT,
  mount: "/mnt/jinn-home",
  ...over,
});

describe("isRemoteTarget", () => {
  it("is true only for a non-blank remoteHost", () => {
    expect(isRemoteTarget({ remoteHost: "build-box" })).toBe(true);
    expect(isRemoteTarget({ remoteHost: "" })).toBe(false);
    expect(isRemoteTarget({ remoteHost: "   " })).toBe(false);
    expect(isRemoteTarget({})).toBe(false);
    expect(isRemoteTarget(undefined)).toBe(false);
  });

  it("a remoteCwd without a remoteHost is NOT remote (it is a config error, caught elsewhere)", () => {
    expect(isRemoteTarget({ remoteCwd: `${ROOT}/proj`, remoteUser: "builder" })).toBe(false);
  });
});

describe("isUnderRoot — containment", () => {
  it("accepts a path inside the root", () => {
    expect(isUnderRoot(`${ROOT}/proj`, ROOT)).toBe(true);
    expect(isUnderRoot(`${ROOT}/proj/packages/app`, ROOT)).toBe(true);
  });

  it("accepts the root itself", () => {
    expect(isUnderRoot(ROOT, ROOT)).toBe(true);
    expect(isUnderRoot(`${ROOT}/`, ROOT)).toBe(true);
    expect(isUnderRoot(ROOT, `${ROOT}/`)).toBe(true);
  });

  it("REFUSES a sibling whose name merely starts with the root's", () => {
    // The trap a bare `candidate.startsWith(root)` waves through: this directory
    // is a sibling of the sandbox, not a child of it.
    expect(isUnderRoot("/srv/jinn-work-evil", ROOT)).toBe(false);
    expect(isUnderRoot("/srv/jinn-work-evil/proj", ROOT)).toBe(false);
    expect(isUnderRoot("/srv/jinn-workshop", ROOT)).toBe(false);
  });

  it("REFUSES traversal that escapes after normalization", () => {
    expect(isUnderRoot(`${ROOT}/../../etc`, ROOT)).toBe(false);
    expect(isUnderRoot(`${ROOT}/proj/../../../etc/shadow`, ROOT)).toBe(false);
  });

  it("accepts traversal that stays inside after normalization", () => {
    expect(isUnderRoot(`${ROOT}/proj/../other`, ROOT)).toBe(true);
  });

  it("REFUSES a home-relative path — the gateway cannot resolve another host's ~", () => {
    expect(isUnderRoot("~/jinn-work/proj", ROOT)).toBe(false);
  });

  it("REFUSES a relative path", () => {
    expect(isUnderRoot("proj", ROOT)).toBe(false);
    expect(isUnderRoot("./proj", ROOT)).toBe(false);
    expect(isUnderRoot("../proj", ROOT)).toBe(false);
  });

  it("REFUSES anything when the root itself is not absolute", () => {
    expect(isUnderRoot(`${ROOT}/proj`, "srv/jinn-work")).toBe(false);
    expect(isUnderRoot(`${ROOT}/proj`, "~/jinn-work")).toBe(false);
  });

  it("treats a root of / as containing every absolute path", () => {
    expect(isUnderRoot("/etc/shadow", "/")).toBe(true);
    expect(isUnderRoot("/", "/")).toBe(true);
  });

  it("judges POSIX-style even for backslash-bearing input (the remote is not Windows)", () => {
    // A Windows gateway must not apply Windows semantics to a Linux box's path:
    // a backslash is an ordinary filename character there, not a separator.
    expect(isUnderRoot("/srv\\jinn-work\\proj", ROOT)).toBe(false);
  });
});

describe("validateRemoteTarget", () => {
  it("returns undefined for a purely local employee — unaffected", () => {
    expect(validateRemoteTarget({}, remote())).toBeUndefined();
    expect(validateRemoteTarget({}, undefined)).toBeUndefined();
  });

  it("returns undefined for a valid remote target", () => {
    expect(validateRemoteTarget(
      { remoteHost: "build-box", remoteUser: "builder", remoteCwd: `${ROOT}/proj` },
      remote(),
    )).toBeUndefined();
  });

  it("accepts remoteCwd equal to the root", () => {
    expect(validateRemoteTarget({ remoteHost: "build-box", remoteCwd: ROOT }, remote())).toBeUndefined();
  });

  it("reports remoteCwd/remoteUser set with NO remoteHost", () => {
    // A half-written remote employee: without this, it silently runs on the gateway.
    const cwdOnly = validateRemoteTarget({ remoteCwd: `${ROOT}/proj` }, remote());
    expect(cwdOnly?.error).toMatch(/remoteHost/);
    expect(cwdOnly?.error).toMatch(/silently run on the gateway/);
    const userOnly = validateRemoteTarget({ remoteUser: "builder" }, remote());
    expect(userOnly?.error).toMatch(/silently run on the gateway/);
    // And it still fires when the operator configured no remote block at all.
    expect(validateRemoteTarget({ remoteCwd: `${ROOT}/proj` }, undefined)?.error)
      .toMatch(/silently run on the gateway/);
  });

  it("fails closed when the instance has no `remote` config block at all", () => {
    const p = validateRemoteTarget({ remoteHost: "build-box", remoteCwd: `${ROOT}/proj` }, undefined);
    expect(p?.error).toMatch(/no `remote` config block/);
  });

  it("fails closed when remote.root is missing or not absolute", () => {
    for (const root of ["", "jinn-work", "~/jinn-work", "./jinn-work"]) {
      const p = validateRemoteTarget(
        { remoteHost: "build-box", remoteCwd: `${ROOT}/proj` },
        remote({ root }),
      );
      expect(p?.error, `root=${JSON.stringify(root)}`).toMatch(/remote\.root must be an absolute path/);
    }
  });

  it("fails closed when remote.mount is missing or not absolute", () => {
    for (const mount of ["", "mnt/jinn-home", "~/jinn-home"]) {
      const p = validateRemoteTarget(
        { remoteHost: "build-box", remoteCwd: `${ROOT}/proj` },
        remote({ mount }),
      );
      expect(p?.error, `mount=${JSON.stringify(mount)}`).toMatch(/remote\.mount must be an absolute path/);
    }
  });

  it("refuses a remoteHost with no remoteCwd", () => {
    expect(validateRemoteTarget({ remoteHost: "build-box" }, remote())?.error)
      .toMatch(/remoteCwd is not/);
    expect(validateRemoteTarget({ remoteHost: "build-box", remoteCwd: "   " }, remote())?.error)
      .toMatch(/remoteCwd is not/);
  });

  it("refuses a home-relative remoteCwd rather than expanding it", () => {
    const p = validateRemoteTarget(
      { remoteHost: "build-box", remoteCwd: "~/jinn-work/proj" },
      remote(),
    );
    expect(p?.error).toMatch(/must be an absolute path, not home-relative/);
  });

  it("refuses a relative remoteCwd", () => {
    const p = validateRemoteTarget({ remoteHost: "build-box", remoteCwd: "proj" }, remote());
    expect(p?.error).toMatch(/does not resolve under the configured remote\.root/);
  });

  it("refuses the sibling-prefix directory", () => {
    const p = validateRemoteTarget(
      { remoteHost: "build-box", remoteCwd: "/srv/jinn-work-evil/proj" },
      remote(),
    );
    expect(p?.error).toMatch(/does not resolve under the configured remote\.root/);
  });

  it("refuses a remoteCwd that traverses out of the root", () => {
    const p = validateRemoteTarget(
      { remoteHost: "build-box", remoteCwd: `${ROOT}/../../etc` },
      remote(),
    );
    expect(p?.error).toMatch(/does not resolve under the configured remote\.root/);
  });
});

describe("assertRemoteTarget", () => {
  it("does not throw for a valid target", () => {
    expect(() => assertRemoteTarget(
      { remoteHost: "build-box", remoteCwd: `${ROOT}/proj` },
      remote(),
    )).not.toThrow();
  });

  it("throws with the validation reason for a contained-path violation", () => {
    expect(() => assertRemoteTarget(
      { remoteHost: "build-box", remoteCwd: "/srv/jinn-work-evil/proj" },
      remote(),
    )).toThrow(/Refusing to spawn a remote session: .*does not resolve under/);
  });

  it("throws when the instance has no remote config", () => {
    expect(() => assertRemoteTarget(
      { remoteHost: "build-box", remoteCwd: `${ROOT}/proj` },
      undefined,
    )).toThrow(/Refusing to spawn a remote session/);
  });

  it("throws for a target with no host at all — a spawn must never fall back to local", () => {
    expect(() => assertRemoteTarget({}, remote())).toThrow(/no remoteHost\/remoteCwd/);
  });
});

describe("sshDestination", () => {
  it("is user@host when a user is configured", () => {
    expect(sshDestination({ remoteHost: "build-box", remoteUser: "builder" })).toBe("builder@build-box");
  });

  it("is the bare host when no user is configured, so ssh applies its own config", () => {
    expect(sshDestination({ remoteHost: "build-box" })).toBe("build-box");
    expect(sshDestination({ remoteHost: "build-box", remoteUser: "  " })).toBe("build-box");
  });

  it("trims surrounding whitespace on both halves", () => {
    expect(sshDestination({ remoteHost: " build-box ", remoteUser: " builder " })).toBe("builder@build-box");
  });
});

describe("employeeRemoteTarget", () => {
  const base = { name: "bee", displayName: "Bee", department: "eng", rank: "employee", engine: "claude", model: "m", persona: "p" } as unknown as Employee;

  it("is undefined for a purely local employee", () => {
    expect(employeeRemoteTarget({ ...base })).toBeUndefined();
    expect(employeeRemoteTarget(undefined)).toBeUndefined();
  });

  it("is undefined for an employee with remoteCwd but no remoteHost", () => {
    expect(employeeRemoteTarget({ ...base, remoteCwd: `${ROOT}/proj` })).toBeUndefined();
  });

  it("carries host, user and cwd through for a remote employee", () => {
    expect(employeeRemoteTarget({
      ...base,
      remoteHost: "build-box",
      remoteUser: "builder",
      remoteCwd: `${ROOT}/proj`,
    })).toEqual({ remoteHost: "build-box", remoteUser: "builder", remoteCwd: `${ROOT}/proj` });
  });

  it("omits absent optional fields rather than emitting undefined values", () => {
    const t = employeeRemoteTarget({ ...base, remoteHost: "build-box" }) as RemoteTarget;
    expect(t).toEqual({ remoteHost: "build-box" });
    expect(Object.keys(t)).toEqual(["remoteHost"]);
  });

  it("the produced target round-trips through validateRemoteTarget", () => {
    const t = employeeRemoteTarget({
      ...base,
      remoteHost: "build-box",
      remoteCwd: "/srv/jinn-work-evil/proj",
    })!;
    expect(validateRemoteTarget(t, remote())?.error).toMatch(/does not resolve under/);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `jinn remote status|wake` is a debugging affordance, so the one thing it must
 * never do is lie about the thing it exists to diagnose.
 *
 * It used to rebuild a target by splitting the rendered `user@host` on "@" and
 * keeping the tail — silently dropping `remoteUser`. Every probe then ran as
 * the GATEWAY's own username, so a perfectly healthy employee was reported
 * unreachable and the operator went looking for a network fault that was not
 * there.
 */

const hoisted = vi.hoisted(() => ({
  targets: [] as any[],
  ready: true,
}));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ remote: { root: "/srv/jinn-work", mount: "/mnt/jinn-home", wakeMac: "aa:bb:cc:dd:ee:ff" } })),
}));

vi.mock("../../gateway/org.js", () => ({
  scanOrg: vi.fn(() => new Map([["builder", {
    name: "builder",
    displayName: "Builder",
    remoteHost: "build-box",
    remoteUser: "builder",
    remoteCwd: "/srv/jinn-work/proj",
  }]])),
}));

vi.mock("../../engines/remote-stage.js", () => ({
  ensureRemoteReady: vi.fn(async (target: any) => {
    hoisted.targets.push(target);
    return hoisted.ready
      ? { ready: true, facts: { jinnVersion: "0.32.0", nodeBin: "/usr/bin/node", stageDir: "/home/builder/.jinn-remote-stage" } }
      : { ready: false, reason: "not reachable" };
  }),
  sendWakeOnLan: vi.fn(async () => {}),
  clearRemoteFactsCache: vi.fn(),
}));

import { remoteStatus, remoteWake } from "../remote.js";

beforeEach(() => {
  hoisted.targets.length = 0;
  hoisted.ready = true;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("jinn remote", () => {
  it("probes as the configured remoteUser, not the gateway's own account", async () => {
    await remoteStatus();
    expect(hoisted.targets).toHaveLength(1);
    expect(hoisted.targets[0].remoteUser).toBe("builder");
    expect(hoisted.targets[0].remoteHost).toBe("build-box");
    expect(hoisted.targets[0].remoteCwd).toBe("/srv/jinn-work/proj");
  });

  it("keeps the user on the wake path too", async () => {
    await remoteWake("builder");
    expect(hoisted.targets[0].remoteUser).toBe("builder");
  });

  it("never wakes from a status check", async () => {
    await remoteStatus();
    // "Is it up" must not have the side effect of turning it on.
    expect(hoisted.targets[0]).toBeDefined();
    const { ensureRemoteReady } = await import("../../engines/remote-stage.js");
    expect((ensureRemoteReady as any).mock.calls[0][2].allowWake).toBe(false);
  });
});

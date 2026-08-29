import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The remote-host gate, and the two ways it used to lose a turn.
 *
 * Both failures share one shape and it is the worst one this feature has: the
 * gateway believes a session is progressing when nothing is going to happen.
 * A walk-away employee has nobody watching the UI, so a turn that neither
 * completes nor reports is indistinguishable from one still working.
 */

const hoisted = vi.hoisted(() => ({
  readiness: { ready: true } as any,
  waitStart: undefined as undefined | ((info: { destination: string; waking: boolean }) => void),
  notifications: [] as string[],
  updates: [] as { fields: any; expected?: readonly string[] }[],
  /** Statuses `updateSessionForAttempt` will accept, i.e. the DB's fence. */
  status: "running" as string,
}));

vi.mock("../../../engines/remote-stage.js", () => ({
  ensureRemoteReady: vi.fn(async (_t: any, _r: any, opts: any) => {
    hoisted.waitStart = opts.onWaitStart;
    return hoisted.readiness;
  }),
}));

vi.mock("../../registry.js", () => ({
  getSession: vi.fn(() => ({ status: hoisted.status })),
  updateSessionForAttempt: vi.fn((_id: string, _tok: string, fields: any, expected?: readonly string[]) => {
    hoisted.updates.push({ fields, expected });
    // Model the real fence: the write only lands from an expected status.
    if (expected && !expected.includes(hoisted.status)) return undefined;
    if (fields.status) hoisted.status = fields.status;
    return { status: hoisted.status };
  }),
}));

vi.mock("../../callbacks.js", () => ({
  notifyOperatorChannel: vi.fn((m: string) => { hoisted.notifications.push(m); }),
}));

import { ensureRemoteHostReady } from "../remote-ready.js";

const EMPLOYEE = {
  name: "builder",
  displayName: "Builder",
  remoteHost: "build-box",
  remoteUser: "builder",
  remoteCwd: "/srv/jinn-work/proj",
} as any;

function input(employee: any = EMPLOYEE) {
  return {
    session: { id: "sess-1" },
    attemptToken: "tok-1",
    employee,
    config: { remote: { root: "/srv/jinn-work", mount: "/mnt/jinn-home" } },
  } as any;
}

beforeEach(() => {
  hoisted.readiness = { ready: true };
  hoisted.waitStart = undefined;
  hoisted.notifications = [];
  hoisted.updates = [];
  hoisted.status = "running";
});

describe("ensureRemoteHostReady", () => {
  it("is a no-op for a local employee", async () => {
    expect(await ensureRemoteHostReady(input(undefined), "claude")).toEqual({ ok: true });
    expect(hoisted.updates).toHaveLength(0);
  });

  it("refuses a remote employee on an engine that cannot go remote", async () => {
    // codex/grok simply ignore `remoteHost`. Without this the turn runs on the
    // GATEWAY with --dangerously-skip-permissions, against a checkout that is
    // not there, while the UI shows a remote employee working normally.
    const res = await ensureRemoteHostReady(input(), "codex") as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("codex");
    expect(res.error).toContain("no remote support");
  });

  it("does not start the turn when a stop lands between the last probe and the restore", async () => {
    // `shouldAbort` covers the wait itself but cannot cover this window. The
    // restore is fenced on `waiting`, so it simply fails — and ignoring that
    // failure left the caller believing the session was running, spawning a
    // remote PTY for a turn nobody wanted.
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    (ensureRemoteReady as any).mockImplementationOnce(async (_t: any, _r: any, opts: any) => {
      opts.onWaitStart?.({ destination: "builder@build-box", waking: true });
      hoisted.status = "interrupted"; // the operator stops it here
      return { ready: true };
    });
    const res = await ensureRemoteHostReady(input(), "claude") as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("stopped while waiting");
  });

  it("announces the wait and moves the session to waiting", async () => {
    const { ensureRemoteReady } = await import("../../../engines/remote-stage.js");
    (ensureRemoteReady as any).mockImplementationOnce(async (_t: any, _r: any, opts: any) => {
      opts.onWaitStart?.({ destination: "builder@build-box", waking: true });
      return { ready: true };
    });
    await ensureRemoteHostReady(input(), "claude");
    expect(hoisted.updates[0].fields.status).toBe("waiting");
    expect(hoisted.notifications[0]).toContain("offline");
    expect(hoisted.updates[1].fields.status).toBe("running");
  });

  it("reports an unreachable host as a refusal, not a silent stall", async () => {
    hoisted.readiness = { ready: false, reason: "build-box did not come up within 240s" };
    const res = await ensureRemoteHostReady(input(), "claude") as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("did not come up");
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JINN_ATTACH_DEFAULT,
  decideJinnAttachment,
  jinnAttachGloballyOn,
  anyEmployeeForcesJinn,
  getJinnAttachGate,
  setJinnAttachGate,
  runJinnAuthedSmokeTest,
  armJinnAttachGate,
  readGatewayJsonToken,
} from "../attachment.js";
import type { Employee, McpGlobalConfig } from "../../shared/types.js";

/**
 * GRS-017e — default-attachment MACHINERY (built; default NOT flipped), plus
 * the GRS-017e-fix hardening (codex adversarial review, 3 findings):
 *
 *   The authed smoke gate is a MANDATORY CONJUNCT of every positive attach
 *   decision — no arm (master on, employee pilot, future default-on) can
 *   route around it, and an UNARMED gate fails CLOSED (finding 1). Arming
 *   covers `jinnMcp: true` pilots via an org scan and fails closed while a
 *   probe is in flight, so hot-reload can never serve a stale-ok verdict
 *   (finding 2). The probe's token lookup uses the instance-aware JINN_HOME
 *   (finding 3).
 *
 * The shipped default is pinned OFF (JINN_ATTACH_DEFAULT === false): with
 * `mcp.gateway.enabled` absent/false and no per-employee force-on, the
 * decision is NO for every combination — today's behavior, byte-identical,
 * zero probes. Flipping default-on at merge time is the ONE-LINE constant
 * change; exactly one test below (named "THE FLIP LINE") pins it.
 */

const emp = (extra: Partial<Employee> = {}): Employee =>
  ({ name: "e", displayName: "E", department: "d", rank: "senior", engine: "codex", model: "m", persona: "p", ...extra }) as Employee;

/** A passed gate — required for ANY positive decision since the fix. */
const OK = { ok: true as const };

afterEach(() => setJinnAttachGate(null));

describe("JINN_ATTACH_DEFAULT — THE FLIP LINE", () => {
  it("is ON for upgraded instances that do not yet have an mcp block", () => {
    expect(JINN_ATTACH_DEFAULT).toBe(true);
  });
});

describe("decideJinnAttachment — default-on upgrade behavior", () => {
  it("attaches on capable engines when the mcp block is absent and the smoke gate passed", () => {
    for (const globalMcp of [undefined, {} as McpGlobalConfig, { gateway: {} } as McpGlobalConfig]) {
      for (const engine of [undefined, "claude", "codex", "hermes", "grok", "antigravity"]) {
        expect(decideJinnAttachment({ globalMcp, engine, gate: OK }).attach).toBe(true);
      }
    }
  });

  it("keeps explicit global and employee opt-outs as kill switches", () => {
    expect(decideJinnAttachment({ globalMcp: { gateway: { enabled: false } } as McpGlobalConfig, engine: "codex", gate: OK }).attach).toBe(false);
    expect(decideJinnAttachment({ globalMcp: undefined, employee: emp({ jinnMcp: false }), engine: "codex", gate: OK }).attach).toBe(false);
    expect(decideJinnAttachment({ globalMcp: undefined, employee: emp({ mcp: false }), engine: "codex", gate: OK }).attach).toBe(false);
    expect(decideJinnAttachment({ globalMcp: undefined, employee: emp({ mcp: ["search"] }), engine: "codex", gate: OK }).attach).toBe(false);
  });
});

describe("decideJinnAttachment — master switch (gate passed)", () => {
  const ON: McpGlobalConfig = { gateway: { enabled: true } } as McpGlobalConfig;

  it("enabled: true attaches for capable engines and engine-undefined (caller-gated) calls", () => {
    expect(decideJinnAttachment({ globalMcp: ON, gate: OK }).attach).toBe(true);
    for (const engine of ["antigravity", "claude", "codex", "hermes", "grok", "pi"]) {
      expect(decideJinnAttachment({ globalMcp: ON, engine, gate: OK }).attach).toBe(true);
    }
  });

  it("an MCP-incapable engine NEVER attaches, whatever the flags say (hard capability gate)", () => {
    for (const engine of ["unknown", ""]) {
      const d = decideJinnAttachment({ globalMcp: ON, engine, employee: emp({ jinnMcp: true }), gate: OK });
      expect(d.attach).toBe(false);
      expect(d.reason).toContain("MCP-capable");
    }
  });

  it("enabled: false is a GLOBAL KILL SWITCH — beats per-employee force-on", () => {
    const OFF: McpGlobalConfig = { gateway: { enabled: false } } as McpGlobalConfig;
    const d = decideJinnAttachment({ globalMcp: OFF, engine: "codex", employee: emp({ jinnMcp: true }), gate: OK });
    expect(d.attach).toBe(false);
    expect(d.reason).toContain("kill switch");
  });
});

describe("decideJinnAttachment — per-engine opt-out (mcp.gateway.engines)", () => {
  const cfg = (engines: Record<string, boolean>): McpGlobalConfig =>
    ({ gateway: { enabled: true, engines } }) as McpGlobalConfig;

  it("engines.<name>: false opts that engine out; others unaffected", () => {
    const c = cfg({ grok: false });
    expect(decideJinnAttachment({ globalMcp: c, engine: "grok", gate: OK }).attach).toBe(false);
    expect(decideJinnAttachment({ globalMcp: c, engine: "codex", gate: OK }).attach).toBe(true);
    expect(decideJinnAttachment({ globalMcp: c, engine: "claude", gate: OK }).attach).toBe(true);
  });

  it("a known-broken engine beats per-employee force-on (correctness over preference)", () => {
    const d = decideJinnAttachment({ globalMcp: cfg({ codex: false }), engine: "codex", employee: emp({ jinnMcp: true }), gate: OK });
    expect(d.attach).toBe(false);
    expect(d.reason).toContain("engine");
  });

  it("engines.<name>: true is redundant but harmless; engine-undefined calls skip per-engine checks", () => {
    expect(decideJinnAttachment({ globalMcp: cfg({ codex: true }), engine: "codex", gate: OK }).attach).toBe(true);
    // No engine named: the caller (manager/api) already gated capability; a
    // per-engine opt-out cannot apply without a name.
    expect(decideJinnAttachment({ globalMcp: cfg({ codex: false }), gate: OK }).attach).toBe(true);
  });
});

describe("decideJinnAttachment — per-employee override (gate passed)", () => {
  const ON: McpGlobalConfig = { gateway: { enabled: true } } as McpGlobalConfig;

  it("jinnMcp: false force-detaches even when the master is on", () => {
    const d = decideJinnAttachment({ globalMcp: ON, engine: "codex", employee: emp({ jinnMcp: false }), gate: OK });
    expect(d.attach).toBe(false);
  });

  it("jinnMcp: true explicitly force-attaches (single-employee override)", () => {
    expect(decideJinnAttachment({ globalMcp: {} as McpGlobalConfig, engine: "codex", employee: emp({ jinnMcp: true }), gate: OK }).attach).toBe(true);
    // Even with NO mcp: section at all — the pilot needs no other MCP config.
    expect(decideJinnAttachment({ globalMcp: undefined, engine: "codex", employee: emp({ jinnMcp: true }), gate: OK }).attach).toBe(true);
  });

  it("jinnMcp (specific) beats the general mcp field: force-on wins over mcp:false and a jinn-less allowlist", () => {
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex", employee: emp({ jinnMcp: true, mcp: false }), gate: OK }).attach).toBe(true);
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex", employee: emp({ jinnMcp: true, mcp: ["search"] }), gate: OK }).attach).toBe(true);
  });

  it("existing semantics unchanged: mcp:false and an allowlist without 'jinn' detach; allowlist WITH 'jinn' follows the master", () => {
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex", employee: emp({ mcp: false }), gate: OK }).attach).toBe(false);
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex", employee: emp({ mcp: ["search"] }), gate: OK }).attach).toBe(false);
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex", employee: emp({ mcp: ["jinn"] }), gate: OK }).attach).toBe(true);
    expect(decideJinnAttachment({ globalMcp: {} as McpGlobalConfig, engine: "codex", employee: emp({ mcp: ["jinn"] }), gate: OK }).attach).toBe(true);
  });
});

describe("decideJinnAttachment — the smoke gate is a MANDATORY CONJUNCT of every positive path (GRS-017e-fix finding 1)", () => {
  const ON: McpGlobalConfig = { gateway: { enabled: true } } as McpGlobalConfig;
  const FAILED = { ok: false as const, reason: "authed smoke test got 401 from /api/org" };

  it("a FAILED gate denies EVERY positive arm — master on, AND the jinnMcp pilot with the master absent (the finding-1 repro)", () => {
    const d = decideJinnAttachment({ globalMcp: ON, engine: "codex", gate: FAILED });
    expect(d.attach).toBe(false);
    expect(d.reason).toContain("401");
    // THE FINDING-1 REGRESSION: force-on pilot, global mcp ABSENT, failing
    // gate → NO attach (pre-fix this returned attach: true).
    const pilot = decideJinnAttachment({ globalMcp: undefined, engine: "codex", employee: emp({ jinnMcp: true }), gate: FAILED });
    expect(pilot.attach).toBe(false);
    expect(pilot.reason).toContain("401");
    // Same with the master on + force-on.
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex", employee: emp({ jinnMcp: true }), gate: FAILED }).attach).toBe(false);
  });

  it("an UNARMED gate (null) fails CLOSED for every positive arm — attach requires a verified probe, not the absence of one", () => {
    for (const opts of [
      { globalMcp: ON, engine: "codex" as const },
      { globalMcp: undefined, engine: "codex" as const, employee: emp({ jinnMcp: true }) },
      { globalMcp: ON, engine: "codex" as const, employee: emp({ mcp: ["jinn"] }) },
    ]) {
      const d = decideJinnAttachment({ ...opts, gate: null });
      expect(d.attach, JSON.stringify(opts)).toBe(false);
      expect(d.reason).toContain("not armed");
    }
  });

  it("a PASSED gate lets the positive verdict stand, with the verdict's own reason", () => {
    const d = decideJinnAttachment({ globalMcp: ON, engine: "codex", gate: OK });
    expect(d.attach).toBe(true);
    expect(d.reason).toContain("mcp.gateway.enabled: true");
  });

  it("defaults to the MODULE gate state when no gate is passed (the resolver's path)", () => {
    setJinnAttachGate({ ok: false, reason: "boot smoke failed" });
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex" }).attach).toBe(false);
    setJinnAttachGate(OK);
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex" }).attach).toBe(true);
    setJinnAttachGate(null);
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex" }).attach).toBe(false); // unarmed = closed
  });
});

describe("jinnAttachGloballyOn + anyEmployeeForcesJinn — when the smoke gate must be armed", () => {
  it("globallyOn: true only for enabled:true (until the default flips); false for absent/false", () => {
    expect(jinnAttachGloballyOn({ gateway: { enabled: true } } as McpGlobalConfig)).toBe(true);
    expect(jinnAttachGloballyOn({ gateway: { enabled: false } } as McpGlobalConfig)).toBe(false);
    expect(jinnAttachGloballyOn({ gateway: {} } as McpGlobalConfig)).toBe(JINN_ATTACH_DEFAULT);
    expect(jinnAttachGloballyOn({} as McpGlobalConfig)).toBe(JINN_ATTACH_DEFAULT);
    expect(jinnAttachGloballyOn(undefined)).toBe(JINN_ATTACH_DEFAULT);
  });

  it("anyEmployeeForcesJinn detects a jinnMcp:true pilot in the org registry", () => {
    expect(anyEmployeeForcesJinn([emp(), emp({ jinnMcp: false })])).toBe(false);
    expect(anyEmployeeForcesJinn([emp(), emp({ jinnMcp: true })])).toBe(true);
    expect(anyEmployeeForcesJinn([])).toBe(false);
    expect(anyEmployeeForcesJinn(undefined)).toBe(false);
  });
});

describe("runJinnAuthedSmokeTest — the child-context auth proof", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-attach-smoke-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const token = "t".repeat(40); // >= 32 chars, the auth.ts shape check
  const writeGatewayJson = (t?: string) =>
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: t ?? token }), { mode: 0o600 });

  it("reads the bearer from gateway.json (the codex clean-env channel, NOT the tautological in-process env) and passes on 200", async () => {
    writeGatewayJson();
    let sawAuth: string | null = null;
    let sawUrl = "";
    const fetchFn = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      sawUrl = String(url);
      sawAuth = init?.headers?.["Authorization"] ?? null;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const r = await runJinnAuthedSmokeTest({ gatewayUrl: "http://127.0.0.1:7811", home, fetchFn });
    expect(r).toEqual({ ok: true });
    expect(sawUrl).toBe("http://127.0.0.1:7811/api/org");
    expect(sawAuth).toBe(`Bearer ${token}`);
  });

  it("no gateway.json → probes UNAUTHENTICATED; still ok on 200 (auth-disabled gateway is a working config)", async () => {
    let sawAuth: string | null = "unset";
    const fetchFn = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sawAuth = init?.headers?.["Authorization"] ?? null;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const r = await runJinnAuthedSmokeTest({ gatewayUrl: "http://127.0.0.1:7811", home, fetchFn });
    expect(r).toEqual({ ok: true });
    expect(sawAuth).toBeNull();
  });

  it("401/403 → failed with a reason naming the status (stale/missing token on an auth-enabled gateway)", async () => {
    writeGatewayJson("short"); // < 32 chars — rejected by the same shape check the server uses
    const fetchFn = (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch;
    const r = await runJinnAuthedSmokeTest({ gatewayUrl: "http://127.0.0.1:7811", home, fetchFn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("401");
  });

  it("network failure → failed with the error message (wrong URL / gateway unreachable)", async () => {
    writeGatewayJson();
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:1");
    }) as unknown as typeof fetch;
    const r = await runJinnAuthedSmokeTest({ gatewayUrl: "http://127.0.0.1:1", home, fetchFn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ECONNREFUSED");
  });
});

describe("readGatewayJsonToken", () => {
  it("returns the token only when it passes the auth.ts shape check (>= 32 chars)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-attach-token-"));
    try {
      expect(readGatewayJsonToken(home)).toBeUndefined(); // no file
      fs.writeFileSync(path.join(home, "gateway.json"), "not json");
      expect(readGatewayJsonToken(home)).toBeUndefined(); // malformed
      fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: "short" }));
      expect(readGatewayJsonToken(home)).toBeUndefined(); // wrong shape
      const good = "g".repeat(48);
      fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: good }));
      expect(readGatewayJsonToken(home)).toBe(good);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("GRS-017e-fix finding 3: the default home is INSTANCE-AWARE — JINN_INSTANCE without JINN_HOME resolves ~/.<instance>, not ~/.jinn", async () => {
    // Env-isolated fresh import: shared/paths bakes JINN_HOME at import time,
    // so the regression must re-import the module graph under the target env.
    const fakeHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-instance-home-"));
    const instanceHome = path.join(fakeHomeRoot, ".qafoo");
    const wrongHome = path.join(fakeHomeRoot, ".jinn");
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(wrongHome, { recursive: true });
    const instanceToken = "i".repeat(40);
    const wrongToken = "w".repeat(40);
    fs.writeFileSync(path.join(instanceHome, "gateway.json"), JSON.stringify({ token: instanceToken }));
    fs.writeFileSync(path.join(wrongHome, "gateway.json"), JSON.stringify({ token: wrongToken }));

    const envBackup = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      JINN_HOME: process.env.JINN_HOME,
      JINN_INSTANCE: process.env.JINN_INSTANCE,
    };
    try {
      // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows. Setting
      // only HOME left the real home in play on Windows, so the probe read the
      // operator's actual ~/.jinn instead of the fixture. Redirect both.
      process.env.HOME = fakeHomeRoot;
      process.env.USERPROFILE = fakeHomeRoot;
      delete process.env.JINN_HOME;
      process.env.JINN_INSTANCE = "qafoo";
      vi.resetModules();
      const fresh = (await import("../attachment.js")) as typeof import("../attachment.js");
      // The probe's default read is the ACTIVE instance's file — pre-fix this
      // returned the ~/.jinn token.
      expect(fresh.readGatewayJsonToken()).toBe(instanceToken);
    } finally {
      for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
      fs.rmSync(fakeHomeRoot, { recursive: true, force: true });
    }
  });
});

describe("armJinnAttachGate — boot/reload/org-reload wiring semantics", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-attach-arm-"));
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ token: "a".repeat(40) }), { mode: 0o600 });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    setJinnAttachGate(null);
  });

  const okFetch = (counter?: { calls: number }) =>
    (async () => {
      if (counter) counter.calls++;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
  const failFetch = (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch;

  it("default-on probes when config is absent, while explicit false disarms without another probe", async () => {
    setJinnAttachGate({ ok: false, reason: "stale" });
    const counter = { calls: 0 };
    const r = await armJinnAttachGate(undefined, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: okFetch(counter) });
    expect(r).toEqual({ ok: true });
    expect(getJinnAttachGate()).toEqual({ ok: true });
    expect(counter.calls).toBe(1);
    await armJinnAttachGate({ gateway: { enabled: false } } as McpGlobalConfig, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: okFetch(counter), employees: [emp()] });
    expect(getJinnAttachGate()).toBeNull();
    expect(counter.calls).toBe(1);
  });

  it("kill switch beats a pilot: enabled:false + jinnMcp:true employee → disarm, no probe (nothing can attach anyway)", async () => {
    const counter = { calls: 0 };
    const r = await armJinnAttachGate({ gateway: { enabled: false } } as McpGlobalConfig, {
      gatewayUrl: "http://127.0.0.1:7811",
      home,
      fetchFn: okFetch(counter),
      employees: [emp({ jinnMcp: true })],
    });
    expect(r).toBeNull();
    expect(getJinnAttachGate()).toBeNull();
    expect(counter.calls).toBe(0);
  });

  it("GRS-017e-fix finding 1: a jinnMcp:true PILOT with the master ABSENT arms the probe — pilot attach is gate-guarded end to end", async () => {
    const counter = { calls: 0 };
    // Passing probe → pilot attaches.
    let r = await armJinnAttachGate(undefined, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: okFetch(counter), employees: [emp(), emp({ jinnMcp: true })] });
    expect(counter.calls).toBe(1);
    expect(r).toEqual({ ok: true });
    expect(decideJinnAttachment({ globalMcp: undefined, engine: "codex", employee: emp({ jinnMcp: true }) }).attach).toBe(true);
    // Failing probe → pilot denied (the finding-1 end-to-end regression).
    r = await armJinnAttachGate(undefined, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: failFetch, employees: [emp({ jinnMcp: true })] });
    expect(r && !r.ok).toBe(true);
    expect(decideJinnAttachment({ globalMcp: undefined, engine: "codex", employee: emp({ jinnMcp: true }) }).attach).toBe(false);
  });

  it("globally ON + passing probe → gate ok; attachment proceeds", async () => {
    const r = await armJinnAttachGate({ gateway: { enabled: true } } as McpGlobalConfig, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: okFetch() });
    expect(r).toEqual({ ok: true });
    expect(getJinnAttachGate()).toEqual({ ok: true });
  });

  it("globally ON + failing probe → gate failed; broad attach degrades to no-attach with the logged reason", async () => {
    const r = await armJinnAttachGate({ gateway: { enabled: true } } as McpGlobalConfig, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: failFetch });
    expect(r && !r.ok).toBe(true);
    const gate = getJinnAttachGate();
    expect(gate && !gate.ok).toBe(true);
    const d = decideJinnAttachment({ globalMcp: { gateway: { enabled: true } } as McpGlobalConfig, engine: "codex" });
    expect(d.attach).toBe(false);
  });

  it("GRS-017e-fix finding 2: re-arm fails CLOSED while the probe is in flight — a stale ok can never serve attach decisions", async () => {
    const ON = { gateway: { enabled: true } } as McpGlobalConfig;
    // Simulate an armed-ok gateway about to hot-reload into a failing config.
    setJinnAttachGate({ ok: true });
    let release!: () => void;
    const gatePending = new Promise<void>((res) => (release = res));
    const hangingThenFailFetch = (async () => {
      await gatePending;
      return { ok: false, status: 401 } as Response;
    }) as unknown as typeof fetch;

    // Fire-and-forget, exactly like reloadConfig does.
    const armPromise = armJinnAttachGate(ON, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: hangingThenFailFetch });

    // DURING the in-flight probe: the stale {ok:true} is already replaced by a
    // denying probe-in-flight state (set synchronously, before the first await).
    const during = getJinnAttachGate();
    expect(during && !during.ok).toBe(true);
    if (during && !during.ok) expect(during.reason).toContain("in flight");
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex" }).attach).toBe(false);

    // AFTER the probe lands: still deny (this config's probe fails).
    release();
    await armPromise;
    const after = getJinnAttachGate();
    expect(after && !after.ok).toBe(true);
    expect(decideJinnAttachment({ globalMcp: ON, engine: "codex" }).attach).toBe(false);
  });

  it("overlapping arms: a SLOW stale probe cannot overwrite a newer verdict (epoch guard)", async () => {
    const ON = { gateway: { enabled: true } } as McpGlobalConfig;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((res) => (releaseSlow = res));
    const slowOkFetch = (async () => {
      await slowGate;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    // Arm #1 (e.g. config reload) hangs; arm #2 (e.g. org reload) lands a FAIL.
    const arm1 = armJinnAttachGate(ON, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: slowOkFetch });
    const arm2 = await armJinnAttachGate(ON, { gatewayUrl: "http://127.0.0.1:7811", home, fetchFn: failFetch });
    expect(arm2 && !arm2.ok).toBe(true);
    // Now the stale slow probe resolves ok — it must NOT reopen the gate.
    releaseSlow();
    await arm1;
    const gate = getJinnAttachGate();
    expect(gate && !gate.ok).toBe(true);
  });
});

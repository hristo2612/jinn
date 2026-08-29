import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyIdleSpawnOpts, PtyViewEngine } from "../../engines/pty-view-engine.js";

/**
 * The dashboard's idle PTY must reach the employee's REMOTE target.
 *
 * `scanOrg` refuses to load an employee whose `remoteHost` has no `remote:`
 * config block behind it — deliberately, so a half-configured remote employee
 * fails loudly instead of quietly running on the gateway. That makes the config
 * argument load-bearing here: asking the registry WITHOUT it re-runs the scan
 * with no config, every remote employee is dropped, and the idle spawn sees a
 * plain local target. It then starts `claude` on the GATEWAY and the engine
 * adopts it as the session's warm PTY, so the next real turn pastes its prompt
 * into that local process — the employee runs here, looking entirely normal in
 * the terminal pane. That is the exact failure the remote idle branch exists to
 * prevent, arriving through the roster instead of through the spawn.
 */

const hoisted = vi.hoisted(() => ({
  /** Every config value `orgRegistry` was called with. */
  registryCalls: [] as unknown[],
}));

vi.mock("../../sessions/registry.js", () => ({
  getSession: vi.fn(() => ({ id: "session-1", employee: "builder", model: "opus" })),
  getEngineSessionRef: vi.fn(() => ({ id: "native-1" })),
}));

vi.mock("../org-registry.js", () => ({
  orgRegistry: vi.fn((config?: unknown) => {
    hoisted.registryCalls.push(config);
    // Model scanOrg's real behaviour: without the config the remote employee
    // fails validation and never makes it into the roster.
    if (!config) return new Map();
    return new Map([["builder", {
      name: "builder",
      displayName: "Builder",
      remoteHost: "build-box",
      remoteUser: "builder",
      remoteCwd: "/srv/jinn-work/proj",
    }]]);
  }),
}));

import { attachPtyWebSocket } from "../pty-ws.js";

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = this.OPEN;
  sent: Array<string | Buffer> = [];
  send(data: string | Buffer): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit("close"); }
  receive(message: unknown): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

class FakeEngine implements PtyViewEngine {
  spawnCalls: PtyIdleSpawnOpts[] = [];
  hasWarmPty(): boolean { return false; }
  ensureIdleSpawn(_id: string, opts: PtyIdleSpawnOpts): void { this.spawnCalls.push(opts); }
  restartPty(_id: string, opts: PtyIdleSpawnOpts): void { this.spawnCalls.push(opts); }
  subscribeWithSnapshot(): any {
    return { snapshot: Promise.resolve({ snapshot: undefined, ready: true }), start: () => {}, stop: () => {} };
  }
  writeStdin(): void {}
  writeRaw(): void {}
  resizePty(): void {}
  setViewing(): void {}
}

const CONFIG = { remote: { root: "/srv/jinn-work", mount: "/mnt/jinn-home" } } as any;

function attach(engine: FakeEngine, options: Record<string, unknown>): FakeWebSocket {
  const ws = new FakeWebSocket();
  attachPtyWebSocket(ws as any, "session-1", engine, options as any);
  ws.receive({ type: "resize", cols: 100, rows: 30 });
  return ws;
}

beforeEach(() => { hoisted.registryCalls.length = 0; });

describe("the dashboard PTY resolves the employee against the live config", () => {
  it("carries the remote target into the idle spawn", () => {
    const engine = new FakeEngine();
    attach(engine, { getConfig: () => CONFIG });
    expect(engine.spawnCalls.length).toBeGreaterThan(0);
    const opts = engine.spawnCalls[0] as any;
    expect(opts.remoteHost).toBe("build-box");
    expect(opts.remoteUser).toBe("builder");
    expect(opts.remoteCwd).toBe("/srv/jinn-work/proj");
  });

  it("passes the config through to the org registry rather than asking blind", () => {
    const engine = new FakeEngine();
    attach(engine, { getConfig: () => CONFIG });
    expect(hoisted.registryCalls).not.toHaveLength(0);
    for (const call of hoisted.registryCalls) expect(call).toBe(CONFIG);
  });

  it("reads the config through a getter, so a hot reload is seen", () => {
    const engine = new FakeEngine();
    let live = CONFIG;
    attach(engine, { getConfig: () => live });
    live = { ...CONFIG, remote: { ...CONFIG.remote, mount: "/mnt/other" } } as any;
    const ws2 = new FakeWebSocket();
    attachPtyWebSocket(ws2 as any, "session-1", engine, { getConfig: () => live } as any);
    ws2.receive({ type: "resize", cols: 100, rows: 30 });
    expect(hoisted.registryCalls[hoisted.registryCalls.length - 1]).toBe(live);
  });
});

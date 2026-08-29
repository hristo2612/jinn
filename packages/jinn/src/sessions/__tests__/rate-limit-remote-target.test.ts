import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A rate limit is the one moment a turn is respawned rather than resumed, which
 * makes it the one moment a remote session can quietly come back on the gateway.
 * Both of handleRateLimit's branches are covered here:
 *
 *   Branch B (wait-and-retry) must re-state the remote target on the retry spawn.
 *   Branch A (engine substitution) must not run at all — no substitute engine has
 *     any notion of a remote host, so substituting relocates the work.
 *
 * The third case is the regression guard: a local employee still substitutes.
 */

// ── Mocks (must be declared before importing the module under test) ──────────

const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>();
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
  getModelRegistry: vi.fn(() => ({})),
  // The chain walker's module reads both of these at load time.
  ENGINE_NAMES: ["claude", "codex", "antigravity", "grok", "pi", "hermes"],
  isKnownEngine: (name: string) => ["claude", "codex", "antigravity", "grok", "pi", "hermes"].includes(name),
}));

const getSessionMock = vi.fn<(...args: unknown[]) => Session | undefined>();
const updateSessionForAttemptMock = vi.fn(
  (_id: string, _token: string, updates: Partial<Session>) => makeSession(updates),
);
vi.mock("../registry.js", () => ({
  getSession: (...a: unknown[]) => getSessionMock(...a),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: (...a: Parameters<typeof updateSessionForAttemptMock>) => updateSessionForAttemptMock(...a),
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: (session: Session, engine: string, id: string) => ({
    engineSessions: { ...(session.engineSessions ?? {}), [engine]: { id } },
    ...(session.engine === engine ? { engineSessionId: id } : {}),
  }),
}));

vi.mock("../engine-run-mcp.js", () => ({ resolveEngineRunMcp: vi.fn(() => ({})) }));
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: vi.fn() }));
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  // Nothing is exhausted in these cases: the substitute is as healthy as a
  // substitute ever gets, which is what makes its absence meaningful below.
  readEngineHealth: () => ({}),
  recordEngineUnavailable: vi.fn(),
}));
vi.mock("../../shared/effort.js", () => ({ resolveEffort: vi.fn(() => "medium") }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Zero delay and a deadline well ahead, so Branch B reaches its retry spawn on
// the first pass without sleeping.
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() + 60_000),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine[0]!.toUpperCase() + engine.slice(1),
  nextUnstatedParkDelayMs: (ms: number) => ms,
  MAX_UNSTATED_PARK_ATTEMPTS: 5,
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Employee, EngineResult, Session } from "../../shared/types.js";

const REMOTE = { remoteHost: "build-box", remoteUser: "jinn", remoteCwd: "/srv/jinn-work/repo" };

function employee(overrides: Partial<Employee> = {}): Employee {
  return { name: "ada", ...overrides } as Employee;
}

/**
 * A claude-primary session whose chain names codex. `substituteRun` is the codex
 * engine's run; `retryRun` is the limited engine's own, used by Branch B.
 */
function makeOpts(args: {
  substituteRun: ReturnType<typeof vi.fn>;
  retryRun: ReturnType<typeof vi.fn>;
  employee?: Employee;
  remote?: Partial<typeof REMOTE>;
}): RateLimitHandlerOpts {
  return {
    session: makeSession(),
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      engines: {
        claude: { bin: "claude", model: "opus", fallback: ["codex"] },
        codex: { bin: "codex", model: "gpt-5.6-sol" },
      },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map([["codex", { run: args.substituteRun } as unknown as RateLimitHandlerOpts["engine"]]]),
    engine: { run: args.retryRun } as unknown as RateLimitHandlerOpts["engine"],
    ...(args.employee ? { employee: args.employee } : {}),
    ...(args.remote ?? {}),
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

const answered = (result: string) => vi.fn(async (_opts: Record<string, unknown>) => ({ result, sessionId: "claude-thread-1" }) as EngineResult);

describe("handleRateLimit — the retry spawn keeps the session on its remote host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
  });

  it("forwards the employee's remote target to the same-engine retry", async () => {
    // No substitute is installed, so Branch A is skipped for the ordinary reason
    // and this case measures the threading alone, not the suppression.
    engineAvailableMock.mockReturnValue(false);
    const retryRun = answered("retried");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun: vi.fn(),
      retryRun,
      employee: employee(REMOTE),
    }));

    expect(outcome.kind).toBe("resumed");
    expect(retryRun).toHaveBeenCalledWith(expect.objectContaining(REMOTE));
  });

  it("forwards a remote target passed on the opts when no employee record carries one", async () => {
    engineAvailableMock.mockReturnValue(false);
    const retryRun = answered("retried");

    await handleRateLimit(makeOpts({ substituteRun: vi.fn(), retryRun, remote: REMOTE }));

    expect(retryRun).toHaveBeenCalledWith(expect.objectContaining(REMOTE));
  });

  it("names no host on a local employee's retry, so it stays on the gateway", async () => {
    engineAvailableMock.mockReturnValue(false);
    const retryRun = answered("retried");

    await handleRateLimit(makeOpts({ substituteRun: vi.fn(), retryRun, employee: employee() }));

    const runOpts = retryRun.mock.calls[0]![0];
    expect(runOpts.remoteHost).toBeUndefined();
    expect(runOpts.cwd).toBe(JINN_HOME);
  });
});

describe("handleRateLimit — engine substitution is suppressed for a remote employee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
    // The substitute is configured, registered, installed and healthy — every
    // condition Branch A asks about is satisfied. Only remoteness stops it.
    engineAvailableMock.mockReturnValue(true);
  });

  it("never spawns the substitute, and waits the limit out on the remote host instead", async () => {
    const substituteRun = answered("from-codex");
    const retryRun = answered("retried-on-claude");

    const waitingStarts: unknown[] = [];
    const outcome = await handleRateLimit({
      ...makeOpts({ substituteRun, retryRun, employee: employee(REMOTE) }),
      hooks: { onWaitingStart: (info) => { waitingStarts.push(info); } },
    });

    // Branch A never ran: no substitute spawn, and no engine flip written.
    expect(substituteRun).not.toHaveBeenCalled();
    expect(updateSessionForAttemptMock).not.toHaveBeenCalledWith(
      "sess-1", "attempt-1", expect.objectContaining({ engine: "codex" }),
    );
    // Branch B did, on the original engine and still on the remote host.
    expect(waitingStarts).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "resumed", result: { result: "retried-on-claude" } });
    expect(retryRun).toHaveBeenCalledWith(expect.objectContaining(REMOTE));
  });

  it("suppresses substitution on remoteHost alone, without a user or a cwd", async () => {
    const substituteRun = answered("from-codex");
    const retryRun = answered("retried-on-claude");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun,
      employee: employee({ remoteHost: "build-box" }),
    }));

    expect(substituteRun).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("resumed");
  });

  it("still substitutes for a local employee — the fallback is not disabled for everyone", async () => {
    const substituteRun = answered("from-codex");
    const retryRun = answered("retried-on-claude");

    const outcome = await handleRateLimit(makeOpts({ substituteRun, retryRun, employee: employee() }));

    expect(substituteRun).toHaveBeenCalledTimes(1);
    expect(retryRun).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "from-codex" } });
  });

  it("still substitutes when no employee record is attached to the turn", async () => {
    const substituteRun = answered("from-codex");

    const outcome = await handleRateLimit(makeOpts({ substituteRun, retryRun: vi.fn() }));

    expect(substituteRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
  });

  it("treats a blank remoteHost as local, so a whitespace value cannot strand a turn", async () => {
    const substituteRun = answered("from-codex");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun: vi.fn(),
      employee: employee({ remoteHost: "   " }),
    }));

    expect(substituteRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
  });
});

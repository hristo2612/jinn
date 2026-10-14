import fs from "node:fs";
import path from "node:path";
import type { Employee, McpGlobalConfig } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";

/**
 * GRS-017e — the default-attachment machinery for the built-in `jinn` MCP
 * server (the company toolset).
 *
 * ONE decision point ({@link decideJinnAttachment}) answers "should this
 * session get the jinn toolset?" by composing, most-specific-last:
 *
 *   1. engine capability      — an engine without a proven per-session MCP
 *                               lever can NEVER attach (hard gate, nothing
 *                               overrides it);
 *   2. the master switch      — `mcp.gateway.enabled`: `false` is the global
 *                               KILL SWITCH (beats everything below), `true`
 *                               is on, absent falls through to the shipped
 *                               default ({@link JINN_ATTACH_DEFAULT});
 *   3. per-engine opt-out     — `mcp.gateway.engines.<engine>: false` detaches
 *                               one engine (a known-broken adapter shouldn't
 *                               attach) and beats per-employee force-on:
 *                               correctness over preference;
 *   4. per-employee override  — `employee.jinnMcp: true|false` force-attaches/
 *                               force-detaches ONE employee. The jinn-specific
 *                               field beats the general `mcp:` field
 *                               (specific-over-general); force-on works even
 *                               with no `mcp:` section at all, enabling a
 *                               single-employee pilot before the global flip.
 *                               The existing `mcp: false` / allowlist semantics
 *                               are unchanged when `jinnMcp` is unset;
 *   5. the default            — {@link JINN_ATTACH_DEFAULT}, ON since v0.26.
 *
 * …and then the AUTHED-SMOKE GATE is a MANDATORY CONJUNCT of every positive
 * result (GRS-017e-fix, codex finding 1): whatever arm said "attach" — master
 * on, employee override, or the shipped default — the decision only stands if the gate
 * is armed AND passed ({@link runJinnAuthedSmokeTest} verified the builtin
 * server can authenticate on THIS gateway). Failed gate → no attach (broken
 * tools are worse than no tools; the reason was logged at arm time). UNARMED
 * gate → no attach either: an attach path whose probe has not run yet is
 * uncertainty, and this module fails CLOSED under uncertainty. Negative
 * decisions never consult the gate.
 *
 * The resolver (mcp/resolver.ts) is the only production caller; jinn-server
 * membership in a resolved set is decided HERE and nowhere else.
 */

/**
 * Shipped default for `mcp.gateway.enabled: <absent>`. Since v0.26, employee
 * sessions on MCP-capable engines receive the built-in company toolset by
 * default. `mcp.gateway.enabled: false` remains the global kill switch.
 */
export const JINN_ATTACH_DEFAULT = true;

/**
 * Engines whose adapters can consume a resolved MCP server set (grounded in
 * reports/research/GRS-012-mcp-engine-support-matrix.md + the GRS-012c probe):
 *   - claude: consumes it via `--mcp-config` (temp file).
 *   - codex:  per-session `-c mcp_servers.*` argv overrides, with scoped
 *             capability carried by a 0600 profile file.
 *   - hermes: native ACP `mcpServers` param.
 *   - grok:   session-scoped `<cwd>/.grok/config.toml` written before spawn and
 *             torn down on settle (GRS-012c; grok has no per-invocation config
 *             flag, so the project-scoped file is its only per-session lever).
 *   - pi:     per-session generated `--extension` file; id/capability ride the
 *             Pi child env.
 *   - antigravity: guarded Gemini MCP config entry plus per-session child env.
 *   - muse: per-invocation `-c mcpServers.<name>=<json>` argv overrides (the CLI
 *             refuses a whole-map override), with session identity carried in the
 *             server env (lab fork; engines/muse-mcp.ts).
 * (Lives here, not in resolver.ts, so the attachment decision can consult it
 * without an import cycle; resolver.ts re-exports it.)
 */
export const MCP_CAPABLE_ENGINES: ReadonlySet<string> = new Set(["claude", "codex", "hermes", "grok", "pi", "antigravity", "muse"]);

/** Whether an engine's adapter can consume a resolved MCP server set. */
export function isMcpCapableEngine(engine: string | undefined): boolean {
  return engine !== undefined && MCP_CAPABLE_ENGINES.has(engine);
}

/** Result of the authed smoke probe — the gate's state when armed. */
export type JinnSmokeResult = { ok: true } | { ok: false; reason: string };

/** The attach decision plus a human-readable reason (logged/reported, never parsed). */
export interface JinnAttachDecision {
  attach: boolean;
  reason: string;
}

// Module gate state. `null` = unarmed (no probe ran — e.g. attachment is
// globally off, or a unit-test context); armed ok/failed otherwise. Kept
// module-level so the sync resolver can consult the async boot probe's result.
let attachGate: JinnSmokeResult | null = null;

/** Current gate state (null = unarmed). */
export function getJinnAttachGate(): JinnSmokeResult | null {
  return attachGate;
}

/** Set (or reset with null) the gate state. Production callers use
 *  {@link armJinnAttachGate}; direct set is for tests. */
export function setJinnAttachGate(result: JinnSmokeResult | null): void {
  attachGate = result;
}

/**
 * Should jinn attachment be ON gateway-wide (before engine/employee scoping)?
 * This is also the "must the smoke gate be armed?" predicate: the probe only
 * runs only when broad attachment would actually happen.
 */
export function jinnAttachGloballyOn(globalMcp: McpGlobalConfig | undefined): boolean {
  const enabled = globalMcp?.gateway?.enabled;
  if (enabled === false) return false;
  if (enabled === true) return true;
  return JINN_ATTACH_DEFAULT;
}

/**
 * The single "should this session get the jinn toolset?" decision.
 * Pure given its inputs; when `gate` is omitted it reads the module gate state
 * (the resolver's path — the one impurity, isolated to this default).
 *
 * Structure (GRS-017e-fix, codex finding 1): the precedence rules produce a
 * WOULD-ATTACH verdict; the authed-smoke gate is then applied as a MANDATORY
 * CONJUNCT of every positive verdict — no attach arm can route around it, and
 * an unarmed gate fails CLOSED. Negative verdicts return without consulting
 * the gate (default-off stays byte-identical, zero probes).
 */
export function decideJinnAttachment(opts: {
  globalMcp: McpGlobalConfig | undefined;
  employee?: Employee;
  engine?: string;
  /** Explicit gate for pure/unit use; omitted = module state. */
  gate?: JinnSmokeResult | null;
}): JinnAttachDecision {
  const verdict = decideWouldAttach(opts);
  if (!verdict.attach) return verdict;

  // THE MANDATORY CONJUNCT. Every positive path — master on, employee pilot,
  // the shipped default — must pass the authed smoke gate. Unarmed = the
  // probe for this attach path has not run = uncertainty = fail closed
  // ({@link armJinnAttachGate} arms whenever any path could attach, so a
  // production `null` here means an arming gap or a pre-arm instant, and
  // handing out possibly-401ing tools is the worse failure).
  const gate = opts.gate === undefined ? attachGate : opts.gate;
  if (gate === null) {
    return {
      attach: false,
      reason: `${verdict.reason}, but the authed smoke gate is not armed — failing closed until a probe verifies this gateway`,
    };
  }
  if (!gate.ok) {
    return { attach: false, reason: `${verdict.reason}, but the authed smoke test failed — ${gate.reason}` };
  }
  return verdict;
}

/** The gate-free precedence walk: would this session attach, flags-wise? */
function decideWouldAttach(opts: {
  globalMcp: McpGlobalConfig | undefined;
  employee?: Employee;
  engine?: string;
}): JinnAttachDecision {
  const { globalMcp, employee, engine } = opts;
  const enabled = globalMcp?.gateway?.enabled;

  // 1. Hard capability gate — an engine the adapters can't wire never attaches.
  //    (engine undefined = the caller vouches; both production call sites gate
  //    on isMcpCapableEngine before resolving.)
  if (engine !== undefined && !isMcpCapableEngine(engine)) {
    return { attach: false, reason: `engine "${engine}" is not MCP-capable` };
  }

  // 2. Global kill switch — beats per-employee force-on: the operator reaching
  //    for `enabled: false` wants NO attachment anywhere, period.
  if (enabled === false) {
    return { attach: false, reason: "mcp.gateway.enabled: false (global kill switch)" };
  }

  // 3. Per-engine opt-out — a known-broken engine shouldn't attach, whatever
  //    an employee YAML says (correctness over preference).
  if (engine !== undefined && globalMcp?.gateway?.engines?.[engine] === false) {
    return { attach: false, reason: `mcp.gateway.engines.${engine}: false (per-engine opt-out)` };
  }

  // 4. Per-employee override. The jinn-specific field decides first
  //    (specific-over-general); the general `mcp:` field keeps its exact
  //    existing semantics when jinnMcp is unset.
  if (employee?.jinnMcp === false) {
    return { attach: false, reason: `employee ${employee.name} sets jinnMcp: false` };
  }
  if (employee?.jinnMcp === true) {
    return { attach: true, reason: `employee ${employee.name} sets jinnMcp: true (force-on)` };
  }
  if (employee?.mcp === false) {
    return { attach: false, reason: `employee ${employee.name} opts out of all MCP servers (mcp: false)` };
  }
  if (Array.isArray(employee?.mcp) && !employee.mcp.includes("jinn")) {
    return { attach: false, reason: `employee ${employee.name}'s mcp allowlist omits "jinn"` };
  }

  // 5. Master on / shipped default.
  if (enabled === true) {
    return { attach: true, reason: "mcp.gateway.enabled: true" };
  }
  return JINN_ATTACH_DEFAULT
    ? { attach: true, reason: "default attachment is on in this build" }
    : { attach: false, reason: "mcp.gateway.enabled is not set and default attachment is off in this build" };
}

/**
 * Read the gateway bearer from the 0600 `<home>/gateway.json` — the SAME file,
 * shape check included, that the builtin server's `resolveServerToken`
 * (mcp/server.ts) falls back to when an engine (codex, probe-verified) gives
 * MCP subprocesses a clean env. Single-sourced here so the smoke probe and the
 * server can never drift apart on what "the child's token" means.
 *
 * Default home = the INSTANCE-AWARE `JINN_HOME` from shared/paths (GRS-017e-fix
 * finding 3): the same resolution the rest of the gateway uses (env JINN_HOME →
 * `~/.${JINN_INSTANCE}` → `~/.jinn`), and the same value `buildJinnServerSpec`
 * hands the child. A hardcoded `~/.jinn` fallback would probe the WRONG
 * instance's credential file on a multi-instance host.
 */
export function readGatewayJsonToken(home?: string): string | undefined {
  try {
    const dir = home || JINN_HOME;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "gateway.json"), "utf-8")) as { token?: unknown };
    // Same shape check as auth.ts ensureGatewayAuthToken (>= 32 chars).
    if (typeof raw.token === "string" && raw.token.length >= 32) return raw.token;
  } catch {
    /* no file / unreadable / malformed */
  }
  return undefined;
}

/**
 * The authed smoke test (GRS-017 design §6 step 2 — "the authed-token path has
 * never been exercised under real auth" hole, closed as a GATE).
 *
 * Form (argued): an in-process probe that authenticates the way the CHILD's
 * worst-case channel does — the bearer read from `<home>/gateway.json` (the
 * codex clean-env fallback GRS-018 §3b built), NOT the in-process
 * JINN_GATEWAY_TOKEN env, which the gateway boot itself exports and is
 * therefore tautologically valid — driven through one real HTTP GET against a
 * privileged read route (`/api/org`, the cheapest call the belt actually
 * makes). This verifies, in one loopback round-trip with no child-process
 * management: the URL the resolver hands out is reachable, the token file the
 * child will read resolves, and the gateway accepts it (or needs no auth —
 * an auth-disabled gateway probing 200 unauthenticated is a WORKING config).
 * A full spawn-the-server-over-stdio probe was rejected as the gate form:
 * spawn/argv/env mechanics are engine-side contracts already pinned per-engine
 * by engine-wiring.test.ts, and a boot-time child process + JSON-RPC handshake
 * buys no additional auth signal for its cost.
 */
export async function runJinnAuthedSmokeTest(opts: {
  gatewayUrl: string;
  home?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<JinnSmokeResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const token = readGatewayJsonToken(opts.home);
  const url = `${opts.gatewayUrl.replace(/\/$/, "")}/api/org`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (res.status === 200) return { ok: true };
    const tokenNote = token ? "gateway.json token was sent" : "no usable token in gateway.json (probed unauthenticated)";
    return { ok: false, reason: `GET ${url} returned ${res.status} (${tokenNote})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `GET ${url} failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** True when at least one employee force-attaches the belt (`jinnMcp: true`) —
 *  the pilot path must be smoke-probed exactly like broad attachment. */
export function anyEmployeeForcesJinn(employees?: Iterable<Employee>): boolean {
  for (const e of employees ?? []) if (e.jinnMcp === true) return true;
  return false;
}

// Monotonic arm epoch: overlapping arms (config reload racing an org reload)
// must not let a SLOW, STALE probe overwrite a newer verdict. Only the latest
// arm commits its result.
let armEpoch = 0;

/**
 * Arm (or disarm) the gate for the current config + org. Called at gateway
 * boot (right after listen — the probe is a loopback call to this very
 * server), on every config hot-reload, and on every ORG reload (an employee
 * YAML gaining `jinnMcp: true` must trigger the probe too — codex finding 1).
 *
 * Fail-closed re-arm (codex finding 2): when any attach path is possible, the
 * gate is set to a DENYING "probe in flight" state SYNCHRONOUSLY (before the
 * first await), so a stale `{ok:true}` can never serve attach decisions while
 * the new config's probe is pending. Callers may fire-and-forget: the window
 * between call and probe-landing denies, never widens.
 *
 * Nothing-can-attach (globally off AND no force-on employee) → gate reset to
 * null with ZERO probes — the default path makes no extra calls, and the
 * decision conjunct fails closed on null anyway. Probe failure logs loudly;
 * every attach decision degrades to no-attach until a later arm passes.
 */
export async function armJinnAttachGate(
  globalMcp: McpGlobalConfig | undefined,
  opts: {
    gatewayUrl: string;
    home?: string;
    fetchFn?: typeof fetch;
    log?: { info(msg: string): void; warn(msg: string): void };
    /** Org registry values — scanned for `jinnMcp: true` pilots. */
    employees?: Iterable<Employee>;
  },
): Promise<JinnSmokeResult | null> {
  const epoch = ++armEpoch;
  // Kill switch: NOTHING can attach (it beats force-on in the decision), so
  // there is no path to guard — disarm without probing.
  const killSwitch = globalMcp?.gateway?.enabled === false;
  if (killSwitch || (!jinnAttachGloballyOn(globalMcp) && !anyEmployeeForcesJinn(opts.employees))) {
    attachGate = null;
    return null;
  }
  // FAIL CLOSED while probing — replaces any stale verdict before the await.
  attachGate = { ok: false, reason: "authed smoke probe in flight — failing closed until it lands" };
  const result = await runJinnAuthedSmokeTest(opts);
  if (epoch !== armEpoch) {
    // A newer arm superseded this probe; its verdict owns the gate.
    return result;
  }
  attachGate = result;
  if (result.ok) {
    opts.log?.info("jinn MCP attachment armed: authed smoke test passed");
  } else {
    opts.log?.warn(
      `jinn MCP attachment DISABLED despite an active attach path (mcp.gateway on, or a jinnMcp pilot) — ` +
        `authed smoke test failed: ${result.reason}. Sessions will spawn WITHOUT the jinn toolset until this is fixed ` +
        `(config/org reload re-checks).`,
    );
  }
  return result;
}

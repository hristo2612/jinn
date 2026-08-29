import { spawn } from "node:child_process";
import dgram from "node:dgram";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { getPackageVersion } from "../shared/version.js";
import { buildSessionSettings } from "../shared/claude-settings.js";
import { readGatewayInfo } from "../gateway/gateway-info.js";
import { GATEWAY_INFO_FILE } from "../shared/paths.js";
import { assertRemoteTarget, resolveRemoteClaudeConfigDir, sshDestination, REMOTE_STAGE_DIR_NAME } from "../shared/remote-target.js";
import type { RemoteTarget, ResolvedMcpConfig } from "../shared/types.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { remapMcpConfigForRemote } from "../mcp/remote-config.js";

/**
 * Everything the gateway does to a remote host that is NOT the interactive
 * session itself.
 *
 * All of it runs through one-shot `ssh` control invocations — plain
 * `child_process.spawn`, never `pty.spawn`. These are control operations, not
 * a TUI: they want an exit code and clean stdout, and a pseudo-terminal would
 * only interleave the two.
 *
 * The interactive session is the caller's job; this module hands it a ready
 * argv (see {@link buildSshSpawnArgs}).
 */

/** Directory on the remote host that acts as the session's JINN_HOME.
 *  Deliberately NOT `~/.jinn`: if a real Jinn instance is ever installed on
 *  that machine, staging into its home would overwrite its gateway.json and
 *  point its hook relay at our tunnel. A distinct name makes that collision
 *  impossible rather than unlikely. */
const REMOTE_STAGE_DIR = REMOTE_STAGE_DIR_NAME;

/** Name of the file whose content proves the mount is live, on both ends. */
const MOUNT_SENTINEL = ".jinn-mount-sentinel";

/** Subdirectory of the per-host stage holding one `$JINN_HOME` per session. */
const SESSIONS_DIR = "sessions";

/** How long an untouched session stage survives before the next spawn reaps it.
 *  Every spawn rewrites its own session's gateway.json, so a live session is
 *  never older than its last turn; this only ever collects the dead. */
const SESSION_STAGE_TTL_DAYS = 7;

const DEFAULT_WAIT_MS = 240_000;
const DEFAULT_PROBE_INTERVAL_MS = 10_000;
/** Per-probe ssh timeout. Short: this question is "is the box up", and a host
 *  that needs longer than this to answer a TCP handshake is, for our purposes,
 *  not up yet — the caller is already in a polling loop. */
const PROBE_CONNECT_TIMEOUT_S = 5;
/** Longer budget for real control work (staging, the farm, the trust seed). */
const CONTROL_CONNECT_TIMEOUT_S = 15;
const CONTROL_TIMEOUT_MS = 60_000;

/** POSIX single-quote for embedding an arbitrary value in a remote shell
 *  command. The remote is POSIX by assumption (it runs `claude` in a PTY). */
export function shq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** ssh options shared by every control invocation.
 *  - BatchMode: never prompt for a password/passphrase. Key auth or failure.
 *  - StrictHostKeyChecking is deliberately NOT relaxed to `accept-new`: silently
 *    trusting a new host key on the operator's behalf is a security downgrade,
 *    and the failure it would paper over is one they should see once. */
function controlSshOpts(connectTimeoutSeconds: number): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o", "LogLevel=ERROR",
  ];
}

export interface SshRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one ssh control command. `stdin`, when given, is piped to the remote
 *  command — this is how file content is staged without a temp file on either
 *  side and without ever putting content on a command line. */
async function sshRun(
  destination: string,
  args: string[],
  opts: { stdin?: string | Buffer; timeoutMs?: number; connectTimeoutSeconds?: number } = {},
): Promise<SshRunResult> {
  const full = [
    ...controlSshOpts(opts.connectTimeoutSeconds ?? CONTROL_CONNECT_TIMEOUT_S),
    destination,
    "--",
    ...args,
  ];
  return await new Promise<SshRunResult>((resolve) => {
    const child = spawn("ssh", full, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      // A control op that outlives its budget is a hung connection, not a slow
      // one; kill it so a wake/poll loop cannot stall on a half-open socket.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null);
    }, opts.timeoutMs ?? CONTROL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => {
      stderr += String(err instanceof Error ? err.message : err);
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Run a POSIX script on the remote. The script travels on stdin to `sh -s`
 *  rather than inside argv: ssh flattens argv into one string for the remote
 *  shell, so a script embedded there gets a second round of word splitting and
 *  quote interpretation. Arguments are shell-quoted individually. */
async function sshScript(
  destination: string,
  script: string,
  args: string[] = [],
  opts: { timeoutMs?: number } = {},
): Promise<SshRunResult> {
  const command = ["sh", "-s", ...args.map(shq)].join(" ");
  return await sshRun(destination, [command], { stdin: script, timeoutMs: opts.timeoutMs });
}

/** Write `content` to `remotePath` at mode 0600, atomically.
 *  tmp-then-rename so a hook relay or MCP server reading concurrently can never
 *  observe a partial file — the same discipline the local writers use. */
export async function stageRemoteFile(
  destination: string,
  remotePath: string,
  content: string,
): Promise<void> {
  const dir = path.posix.dirname(remotePath);
  const tmp = `${remotePath}.tmp`;
  const command = [
    `mkdir -p ${shq(dir)}`,
    `chmod 700 ${shq(dir)}`,
    `cat > ${shq(tmp)}`,
    `chmod 600 ${shq(tmp)}`,
    `mv -f ${shq(tmp)} ${shq(remotePath)}`,
  ].join(" && ");
  const res = await sshRun(destination, [command], { stdin: content });
  if (res.code !== 0) {
    throw new Error(`failed to stage ${remotePath} on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
}

// ── Host facts ───────────────────────────────────────────────────────────────

export interface RemoteFacts {
  /** `$HOME` on the remote host. Everything else is resolved against it, because
   *  the gateway cannot expand `~` for another machine's user. */
  home: string;
  /** Per-HOST stage root. Holds the real hook-relay/trust-seed copies and the
   *  `sessions/` tree; it is NOT itself a session's JINN_HOME. */
  stageDir: string;
  nodeBin: string;
  claudeBin: string;
  jinnVersion: string;
  /** Directory holding the remote install's `server-entry.js` / `scrub-entry.js`. */
  entryDir: string;
}

/**
 * Probe the remote host for the absolute paths a session needs.
 *
 * The PATH dance at the top is load-bearing, not defensive clutter. A
 * non-interactive ssh command reads no shell rc file, so a host whose Node is
 * installed by a version manager reports no `node` at all — and nvm's own
 * `nvm.sh` cannot rescue that, because it is bash-only and `/bin/sh` is `dash`
 * on most Debian-family systems (a Raspberry Pi included). So nvm's layout is
 * read directly.
 *
 * Honouring nvm's `default` alias matters rather than taking the newest
 * version: a global `jinn-cli` lives under ONE version's tree, so a host with
 * both v22 (default, where jinn was installed) and v24 would otherwise resolve
 * to v24 and report jinn missing.
 */
export const FACTS_SCRIPT = `
set -u
# Common install dirs a login shell would add. Appended, so the system PATH wins.
PATH="$PATH:$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin"
if ! command -v node >/dev/null 2>&1; then
  nvmdir=\${NVM_DIR:-$HOME/.nvm}
  nodedir=""
  if [ -d "$nvmdir/versions/node" ]; then
    want=""
    [ -f "$nvmdir/alias/default" ] && want=$(cat "$nvmdir/alias/default" 2>/dev/null)
    if [ -n "$want" ]; then
      case "$want" in v*) pat="$want" ;; *) pat="v$want" ;; esac
      nodedir=$(ls -1d "$nvmdir/versions/node/$pat" "$nvmdir/versions/node/$pat".* 2>/dev/null | sort -V | tail -1)
    fi
    if [ -z "$nodedir" ]; then
      nodedir=$(ls -1d "$nvmdir"/versions/node/v* 2>/dev/null | sort -V | tail -1)
    fi
  fi
  if [ -n "$nodedir" ] && [ -x "$nodedir/bin/node" ]; then PATH="$nodedir/bin:$PATH"; fi
fi
export PATH
printf 'home=%s\\n' "$HOME"
printf 'node=%s\\n' "$(command -v node 2>/dev/null || true)"
printf 'claude=%s\\n' "$(command -v claude 2>/dev/null || true)"
jinnbin=$(command -v jinn 2>/dev/null || true)
if [ -n "$jinnbin" ]; then
  printf 'jinnversion=%s\\n' "$(jinn --version 2>/dev/null | tr -d '\\r' | head -n 1)"
  printf 'entrydir=%s\\n' "$(node -e 'const fs=require("fs"),path=require("path");try{const b=fs.realpathSync(process.argv[1]);process.stdout.write(path.resolve(path.dirname(b),"..","src","mcp"))}catch(e){}' "$jinnbin" 2>/dev/null || true)"
fi
`;

function parseKeyValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Facts are stable for the life of a host's install, so they are cached per
 *  gateway process. The mount sentinel is deliberately NOT cached — it is the
 *  one fact that can go stale while the gateway keeps running. */
const factsCache = new Map<string, RemoteFacts>();

/** Exported for tests: drop cached host facts. */
export function clearRemoteFactsCache(): void {
  factsCache.clear();
}

/** Facts already learned about a host this gateway boot, without asking again.
 *  For callers on a hot path that must never make an ssh round trip — the hook
 *  endpoint, which fires many times a turn. Undefined before the first spawn,
 *  which is fine: nothing can have hooked before it has spawned. */
export function cachedRemoteFacts(destination: string): RemoteFacts | undefined {
  return factsCache.get(destination);
}

/**
 * Reject a host missing the binaries a session needs, naming the PATH cause.
 *
 * A non-interactive ssh reads no rc file, so the overwhelmingly common reason a
 * binary "is missing" here is that it is installed but only reachable from an
 * interactive shell. Being told to install something already installed sends
 * the operator down entirely the wrong path, so each message says how to check.
 */
function assertRemoteToolchain(destination: string, kv: Record<string, string>): void {
  if (!kv.home) throw new Error(`${destination} reported no $HOME`);
  if (!kv.node) {
    throw new Error(
      `${destination} has no \`node\` on the non-interactive PATH. Check with `
      + `\`ssh ${destination} 'command -v node'\` — if that prints nothing but node works when you log in, `
      + `it is installed by a version manager this could not resolve; symlink it somewhere on the default PATH `
      + `(e.g. ~/.local/bin) or install Node.js system-wide`,
    );
  }
  if (!kv.claude) {
    throw new Error(
      `${destination} has no \`claude\` on the non-interactive PATH. Check with `
      + `\`ssh ${destination} 'command -v claude'\` — install Claude Code there and sign it in, `
      + `or symlink it onto the default PATH if it is already installed`,
    );
  }
}

async function gatherFacts(destination: string): Promise<RemoteFacts> {
  const cached = factsCache.get(destination);
  if (cached) return cached;

  const res = await sshScript(destination, FACTS_SCRIPT);
  if (res.code !== 0) {
    throw new Error(`could not read host facts from ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const kv = parseKeyValues(res.stdout);
  assertRemoteToolchain(destination, kv);
  if (!kv.jinnversion) {
    throw new Error(
      `${destination} has no \`jinn\` on PATH — run \`npm install -g jinn-cli@${getPackageVersion()}\` there `
      + `(the remote install supplies the MCP server entrypoints; the daemon is never started)`,
    );
  }
  // Version skew would otherwise surface as a confusing mid-turn MCP failure:
  // the remapped config points at entrypoints from a different build. Refuse
  // now, with the command that fixes it.
  const local = getPackageVersion();
  if (kv.jinnversion !== local) {
    throw new Error(
      `${destination} runs jinn-cli ${kv.jinnversion} but this gateway is ${local} — `
      + `run \`npm install -g jinn-cli@${local}\` there`,
    );
  }
  if (!kv.entrydir) {
    throw new Error(`could not locate the jinn MCP entrypoints on ${destination}`);
  }
  const facts: RemoteFacts = {
    home: kv.home,
    stageDir: path.posix.join(kv.home, REMOTE_STAGE_DIR),
    nodeBin: kv.node,
    claudeBin: kv.claude,
    jinnVersion: kv.jinnversion,
    entryDir: kv.entrydir,
  };
  factsCache.set(destination, facts);
  return facts;
}

// ── Mount liveness ───────────────────────────────────────────────────────────

/** Read (creating on first use) the gateway-side sentinel value.
 *  Its only job is to be a value the remote can only see THROUGH the mount. */
function localSentinelValue(): string {
  const file = path.join(JINN_HOME, MOUNT_SENTINEL);
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch { /* first use */ }
  const value = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(JINN_HOME, { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

async function readRemoteSentinel(destination: string, mount: string): Promise<string> {
  const res = await sshRun(destination, [`cat ${shq(path.posix.join(mount, MOUNT_SENTINEL))} 2>/dev/null || true`]);
  return res.stdout.trim();
}

// ── Wake ─────────────────────────────────────────────────────────────────────

/** Send a Wake-on-LAN magic packet: 6 × 0xFF followed by the target MAC sixteen
 *  times. No dependency needed — it is 102 bytes on a broadcast UDP socket. */
export async function sendWakeOnLan(mac: string): Promise<void> {
  const hex = mac.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 12) throw new Error(`remote.wakeMac "${mac}" is not a 6-byte MAC address`);
  const bytes = Buffer.from(hex, "hex");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), Buffer.alloc(16 * 6)]);
  for (let i = 0; i < 16; i += 1) bytes.copy(packet, 6 + i * 6);

  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const done = (err?: Error) => {
      try { socket.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve();
    };
    socket.once("error", done);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // Port 9 (discard) is the conventional WoL destination; 7 is also used.
      socket.send(packet, 0, packet.length, 9, "255.255.255.255", (err) => done(err ?? undefined));
    });
  });
}

async function runLocalWakeCommand(command: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 30_000);
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      logger.warn(`remote wakeCommand failed to start: ${err instanceof Error ? err.message : String(err)}`);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A wake is best-effort by nature — the box may already be up, the plug
      // may report oddly. The reachability poll is the real verdict, so a
      // non-zero exit is logged and not treated as fatal.
      if (code !== 0) logger.warn(`remote wakeCommand exited ${code}: ${stderr.trim()}`);
      resolve();
    });
  });
}

// ── Readiness ────────────────────────────────────────────────────────────────

export type RemoteReadiness =
  | { ready: true; facts: RemoteFacts }
  | { ready: false; reason: string };

export interface EnsureReadyOpts {
  /** Whether an unreachable host may be woken. FALSE for the dashboard's idle
   *  PTY: opening a terminal tab must never boot someone's desktop. */
  allowWake: boolean;
  /** Called once when the host is not up and we are about to wait, so the turn
   *  path can move the session to "waiting" and tell the operator. */
  onWaitStart?: (info: { destination: string; waking: boolean }) => void;
  /** Polled while waiting; returning true abandons the wait (session stopped). */
  shouldAbort?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Is the host answering ssh at all? */
async function probeReachable(destination: string): Promise<boolean> {
  const res = await sshRun(destination, ["true"], {
    timeoutMs: (PROBE_CONNECT_TIMEOUT_S + 5) * 1000,
    connectTimeoutSeconds: PROBE_CONNECT_TIMEOUT_S,
  });
  if (res.code === 0) return true;
  if (/host key verification failed/i.test(res.stderr)) {
    // Fail closed but say the exact thing the operator must do; BatchMode turns
    // the usual interactive TOFU prompt into a bare non-zero exit.
    throw new Error(
      `host key verification failed for ${destination} — add its key to the gateway's known_hosts `
      + `(e.g. \`ssh-keyscan -H <host> >> ~/.ssh/known_hosts\`) after checking the fingerprint`,
    );
  }
  if (/permission denied/i.test(res.stderr)) {
    throw new Error(
      `ssh to ${destination} was refused (permission denied) — remote execution is key-only `
      + `(BatchMode), so a passphrase-locked key with no agent will always fail`,
    );
  }
  return false;
}

/**
 * Bring a remote host to the point where a session can be spawned on it:
 * reachable, running a matching jinn-cli, with the gateway's JINN_HOME mounted.
 *
 * Waiting is BOUNDED on purpose. A desktop that is off for the weekend must
 * fail the turn with something the operator can read, not pin the session at
 * "waiting" indefinitely.
 */
export async function ensureRemoteReady(
  target: RemoteTarget,
  remote: RemoteExecutionConfig | undefined,
  opts: EnsureReadyOpts,
): Promise<RemoteReadiness> {
  if (!remote) return { ready: false, reason: "no `remote` config block is configured" };
  const destination = sshDestination(target as RemoteTarget & { remoteHost: string });
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;

  try {
    if (!await probeReachable(destination)) {
      const problem = await wakeAndWait(destination, remote, opts, now, sleep);
      if (problem) return { ready: false, reason: problem };
    }
    const facts = await gatherFacts(destination);
    const mountProblem = await verifyMount(destination, remote);
    if (mountProblem) return { ready: false, reason: mountProblem };
    const profileProblem = await verifyClaudeProfile(destination, resolveRemoteClaudeConfigDir(target, remote));
    if (profileProblem) return { ready: false, reason: profileProblem };
    return { ready: true, facts };
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Hosts+profiles already seen signed in. Only SUCCESS is cached: a profile that
 *  failed may have been signed in since, and re-checking a failure costs one ssh
 *  round trip against a turn that was going to fail anyway. */
const authedProfiles = new Set<string>();

/** Exported for tests: forget cached profile auth results. */
export function clearRemoteProfileCache(): void {
  authedProfiles.clear();
}

/**
 * Refuse a profile that is not signed in.
 *
 * Claude Code answers an unauthenticated start with an interactive login
 * prompt. In a gateway PTY there is nobody to answer it, so the turn would hang
 * with no hook, no notification and no error — the same silent-hang class as the
 * folder-trust dialog, and worth the same explicit guard rather than a mystery.
 *
 * Only checked when a profile is named: the remote user's default profile is
 * whatever `claude` would use interactively, and second-guessing it here would
 * reject working setups that keep credentials somewhere we do not know about.
 */
async function verifyClaudeProfile(
  destination: string,
  claudeConfigDir: string | undefined,
): Promise<string | undefined> {
  if (!claudeConfigDir) return undefined;
  const key = `${destination}:${claudeConfigDir}`;
  if (authedProfiles.has(key)) return undefined;
  const creds = path.posix.join(claudeConfigDir, ".credentials.json");
  const res = await sshRun(destination, [`test -d ${shq(claudeConfigDir)} && echo dir; test -s ${shq(creds)} && echo creds; true`]);
  const out = res.stdout;
  if (!out.includes("dir")) {
    return `the Claude profile directory ${claudeConfigDir} does not exist on ${destination}`;
  }
  if (!out.includes("creds")) {
    return `the Claude profile at ${claudeConfigDir} on ${destination} is not signed in `
      + `(no .credentials.json) — claude would open a login prompt in front of a PTY with nobody at the keyboard`;
  }
  authedProfiles.add(key);
  return undefined;
}

/** Fire whichever wake mechanism is configured. `wakeCommand` wins over
 *  `wakeMac` so an operator whose box is not WoL-capable is never second-guessed. */
async function triggerWake(destination: string, remote: RemoteExecutionConfig): Promise<string | undefined> {
  if (remote.wakeCommand) {
    logger.info(`remote: waking ${destination} via wakeCommand`);
    await runLocalWakeCommand(remote.wakeCommand);
    return undefined;
  }
  if (remote.wakeMac) {
    logger.info(`remote: sending Wake-on-LAN to ${destination}`);
    await sendWakeOnLan(remote.wakeMac);
    return undefined;
  }
  return `${destination} is not reachable and no remote.wakeCommand/remote.wakeMac is configured`;
}

/** Wake an unreachable host and poll until it answers or the budget runs out.
 *  Returns the reason it is still not usable, or undefined on success. */
async function wakeAndWait(
  destination: string,
  remote: RemoteExecutionConfig,
  opts: EnsureReadyOpts,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const canWake = opts.allowWake && Boolean(remote.wakeCommand || remote.wakeMac);
  opts.onWaitStart?.({ destination, waking: canWake });

  // The dashboard's idle PTY passes allowWake:false. Opening a terminal tab
  // must never boot someone's desktop.
  if (!opts.allowWake) return `${destination} is not reachable`;
  const wakeProblem = await triggerWake(destination, remote);
  if (wakeProblem) return wakeProblem;

  return await pollUntilReachable(destination, remote, opts, now, sleep);
}

/** Poll a waking host until it answers, the operator stops the session, or the
 *  budget runs out. Bounded on purpose: a box that is off for the weekend must
 *  fail the turn with something readable, not pin it at "waiting" forever. */
async function pollUntilReachable(
  destination: string,
  remote: RemoteExecutionConfig,
  opts: EnsureReadyOpts,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const waitMs = remote.waitMs ?? DEFAULT_WAIT_MS;
  const interval = remote.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const aborted = () => opts.shouldAbort?.() === true;
  const deadline = now() + waitMs;
  while (now() < deadline) {
    if (aborted()) return "cancelled while waiting for the remote host";
    await sleep(interval);
    if (aborted()) return "cancelled while waiting for the remote host";
    if (await probeReachable(destination)) return undefined;
  }
  return `${destination} did not come up within ${Math.round(waitMs / 1000)}s of being woken`;
}

/**
 * Confirm the gateway's instance home is genuinely mounted on the remote host.
 *
 * The failure this exists for is a SILENTLY unmounted sshfs: the symlink farm
 * then points into an empty directory, the session's writes to knowledge/ and
 * docs/ succeed locally, and the org quietly diverges with no error anywhere.
 * A reboot does not bring sshfs back, so a host that just woke normally lands
 * here with a dead mount — which is why the remount attempt is on this path.
 */
async function verifyMount(
  destination: string,
  remote: RemoteExecutionConfig,
): Promise<string | undefined> {
  const expected = localSentinelValue();
  let seen = await readRemoteSentinel(destination, remote.mount);
  if (seen !== expected && remote.remountCommand) {
    logger.info(`remote: ${remote.mount} on ${destination} is not live — running remountCommand`);
    const res = await sshRun(destination, [remote.remountCommand]);
    if (res.code !== 0) {
      logger.warn(`remote remountCommand on ${destination} exited ${res.code}: ${res.stderr.trim()}`);
    }
    seen = await readRemoteSentinel(destination, remote.mount);
  }
  if (seen === expected) return undefined;
  return `the gateway's instance home is not mounted at ${remote.mount} on ${destination} `
    + `(sentinel ${seen ? "mismatched" : "unreadable"}) — without it the session's writes to `
    + `knowledge/, docs/ and org/ would land on the remote host instead of reaching the org`;
}

// ── Per-host staging ─────────────────────────────────────────────────────────

const seededTrust = new Set<string>();

/** Exported for tests: forget per-host staging so it runs again. */
export function clearRemoteStagingCache(): void {
  seededTrust.clear();
  stagingQueues.clear();
}

/**
 * Serialize control work per remote host.
 *
 * Two sessions preparing against the same box at the same moment would
 * otherwise interleave the two operations that mutate per-HOST state: staging
 * the shared assets, and the trust seed's read-modify-write of the remote
 * user's `~/.claude.json`. A lost update there is not cosmetic — the project
 * whose key was dropped is remembered as seeded and never retried, so its next
 * turn hangs forever on the folder-trust dialog.
 *
 * Per-SESSION staging needs no such lock: each session owns its own directory.
 */
const stagingQueues = new Map<string, Promise<unknown>>();

function serializePerHost<T>(destination: string, work: () => Promise<T>): Promise<T> {
  const prior = stagingQueues.get(destination) ?? Promise.resolve();
  // `catch` before chaining so one failed prepare does not poison the queue for
  // every later session on that host.
  const next = prior.catch(() => undefined).then(work);
  stagingQueues.set(destination, next.catch(() => undefined));
  return next;
}

/** Locate a shipped asset. Same three-candidate probe `server.ts` uses for
 *  hook-relay.mjs: `assets/` sits at a different depth relative to this module
 *  depending on whether it is running from `dist/` or a worktree, and guessing
 *  one depth is how the relay went missing before. */
function assetPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "..", "assets", name),
    path.join(here, "..", "..", "assets", name),
    path.join(here, "..", "assets", name),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`asset ${name} not found in any candidate location`);
  return found;
}

/** The two files staged as REAL copies at the per-host stage root, never
 *  symlinked through the mount: hooks fire many times a turn, and a relay that
 *  cannot run because the mount blipped would take the turn's completion signal
 *  with it. Living at the stage ROOT — outside any session's symlink farm — is
 *  what keeps the farm rebuild from converting them back into mount symlinks. */
const HOST_ASSETS = ["hook-relay.mjs", "remote-trust-seed.mjs"] as const;

export function remoteRelayScript(facts: RemoteFacts): string {
  return path.posix.join(facts.stageDir, "hook-relay.mjs");
}

/** A remote session's own `$JINN_HOME`.
 *
 *  Per SESSION, not per host, and that is load-bearing. `gateway.json` names
 *  the reverse-tunnel port, which is allocated per spawn — so a single shared
 *  copy means any second prepare rewrites the port another LIVE session's hook
 *  relay is about to read. The relay would then POST into a port with no tunnel
 *  behind it and, by design, swallow the failure: no Stop, no policy
 *  enforcement, and a turn that runs to completion while the gateway hears
 *  nothing. Giving each session its own home makes that collision impossible
 *  rather than unlikely. */
export function remoteSessionHome(facts: RemoteFacts, jinnSessionId: string): string {
  return path.posix.join(facts.stageDir, SESSIONS_DIR, safeSessionSegment(jinnSessionId));
}

/** Session ids are gateway-generated and already path-safe; this is here so a
 *  hand-crafted one can never walk out of the sessions directory. */
function safeSessionSegment(jinnSessionId: string): string {
  const clean = String(jinnSessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!clean || clean === "." || clean === "..") throw new Error(`unusable session id for remote staging: "${jinnSessionId}"`);
  return clean;
}

/** Stage the per-host assets. Driven by what the farm script actually observed
 *  on this spawn rather than by a process-lifetime cache: a stage directory
 *  wiped while the gateway keeps running would otherwise leave the relay
 *  missing and never restage it, which is a silent hang until the next
 *  restart. */
async function ensureAssets(destination: string, facts: RemoteFacts, present: Set<string>): Promise<void> {
  for (const name of HOST_ASSETS) {
    if (present.has(name)) continue;
    const content = fs.readFileSync(assetPath(name), "utf-8");
    await stageRemoteFile(destination, path.posix.join(facts.stageDir, name), content);
  }
}

/**
 * Dismiss Claude Code's first-run folder-trust dialog for `remoteCwd` on the
 * remote host.
 *
 * Not optional. The dialog does not match `parsePermissionPrompt`'s strict
 * "Do you want to proceed?" shape and fires no Notification hook, so without
 * this the first turn against a directory the remote Claude has not seen hangs
 * forever with nothing reported anywhere.
 */
/**
 * Cache key for a completed trust seed.
 *
 * The PROFILE is part of it, not just the directory. Trust is recorded in
 * `<profile>/.claude.json`, so a session that switches profiles faces a config
 * file that has never seen this directory — and a key blind to the profile
 * would report the seed already done and hand that session the hanging dialog.
 */
export function trustSeedKey(
  destination: string,
  remoteCwd: string,
  claudeConfigDir: string | undefined,
): string {
  return `${destination}:${claudeConfigDir ?? "-"}:${remoteCwd}`;
}

/**
 * The remote command that pre-trusts `remoteCwd`.
 *
 * `CLAUDE_CONFIG_DIR` must match what the SESSION runs with: the seeder resolves
 * `.claude.json` inside the config dir when the variable is set and beside
 * `$HOME` when it is not, so seeding under the wrong one is indistinguishable
 * from not seeding at all — the dialog still appears, and the turn still hangs.
 *
 * Pure and exported so that agreement is testable without a second machine.
 */
export function buildTrustSeedCommand(
  facts: RemoteFacts,
  remoteCwd: string,
  claudeConfigDir: string | undefined,
): string {
  const script = path.posix.join(facts.stageDir, "remote-trust-seed.mjs");
  const env = claudeConfigDir ? `CLAUDE_CONFIG_DIR=${shq(claudeConfigDir)} ` : "";
  return `mkdir -p ${shq(remoteCwd)} && ${env}${shq(facts.nodeBin)} ${shq(script)} ${shq(remoteCwd)}`;
}

async function seedRemoteTrust(
  destination: string,
  facts: RemoteFacts,
  remoteCwd: string,
  claudeConfigDir: string | undefined,
): Promise<void> {
  // The profile is part of the key, not just the directory. Trust is recorded
  // in `<profile>/.claude.json`, so a session that switches profiles is facing
  // a config file that has never seen this directory — and a cache keyed on the
  // directory alone would skip the seed and hand it the hanging trust dialog.
  const key = trustSeedKey(destination, remoteCwd, claudeConfigDir);
  if (seededTrust.has(key)) return;
  const res = await sshRun(destination, [buildTrustSeedCommand(facts, remoteCwd, claudeConfigDir)]);
  if (res.code !== 0) {
    throw new Error(
      `could not pre-trust ${remoteCwd} on ${destination}: ${res.stderr.trim() || `exit ${res.code}`} `
      + `— the first turn would hang on Claude Code's folder-trust dialog`,
    );
  }
  logger.info(
    `remote: trust seeded for ${remoteCwd} on ${destination}`
    + `${claudeConfigDir ? ` (profile ${claudeConfigDir})` : ""} (${res.stdout.trim()})`,
  );
  seededTrust.add(key);
}

export const FARM_SCRIPT = `
set -eu
mount=$1
root=$2
home=$3
ttl=$4
mkdir -p "$root" "$root/sessions" "$home" "$home/tmp"
chmod 700 "$root" "$root/sessions" "$home"
# Reap dead session stages. Every spawn rewrites its own session's gateway.json,
# so a live session's directory is never older than its last turn.
find "$root/sessions" -mindepth 1 -maxdepth 1 -type d -mtime +"$ttl" -exec rm -rf {} + 2>/dev/null || true
# Drop every symlink first so an entry removed from the gateway's home does not
# linger here as a dangling one. gateway.json and tmp/ are real, not symlinks,
# so they are untouched by this.
find "$home" -maxdepth 1 -type l -exec rm -f {} + 2>/dev/null || true
for entry in "$mount"/* "$mount"/.[!.]*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  case "$name" in
    gateway.json|tmp) continue ;;
  esac
  ln -sfn "$entry" "$home/$name"
done
# Report which per-host assets are really there. Free — this round trip is
# already happening — and it is what lets a wiped stage restage itself instead
# of relying on a cache that outlives the directory it describes.
for a in hook-relay.mjs remote-trust-seed.mjs; do
  if [ -f "$root/$a" ] && [ ! -L "$root/$a" ]; then printf 'asset=%s\\n' "$a"; fi
done
`;

/**
 * Rebuild ONE session's `$JINN_HOME` as a symlink farm over the mounted gateway
 * home, so the session reads and writes the org's REAL knowledge, docs, org and
 * skills rather than copies. Also reaps dead session stages and reports which
 * per-host assets are genuinely present.
 *
 * Two entries are deliberately excluded and staged for real instead:
 *  - `gateway.json`, because the mounted one names the gateway's own port,
 *    which on this host would point the hook relay at the wrong process.
 *  - `tmp/`, because per-session settings and MCP configs churn there and a
 *    network filesystem is the wrong place for it.
 *
 * Rebuilt every spawn rather than once: that is what keeps the farm honest when
 * the gateway's home gains a new top-level directory.
 */
export async function rebuildHomeFarm(
  destination: string,
  facts: RemoteFacts,
  mount: string,
  sessionHome: string,
): Promise<Set<string>> {
  const res = await sshScript(destination, FARM_SCRIPT, [
    mount,
    facts.stageDir,
    sessionHome,
    String(SESSION_STAGE_TTL_DAYS),
  ]);
  if (res.code !== 0) {
    throw new Error(`could not build the remote JINN_HOME farm on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const present = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const value = line.trim();
    if (value.startsWith("asset=")) present.add(value.slice("asset=".length));
  }
  return present;
}

/** Ask the remote host for a free TCP port on its loopback.
 *  Used as the listen end of the reverse tunnel. There is a small window in
 *  which something else could take it, which is exactly why the session is
 *  spawned with `ExitOnForwardFailure=yes` — a lost race becomes a fast, loud
 *  exit rather than a session whose hooks silently never arrive. */
export async function probeFreePort(destination: string, facts: RemoteFacts): Promise<number> {
  const script = `const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()});`;
  const res = await sshRun(destination, [`${shq(facts.nodeBin)} -e ${shq(script)}`]);
  const port = Number.parseInt(res.stdout.trim(), 10);
  if (res.code !== 0 || !Number.isInteger(port) || port <= 0) {
    throw new Error(`could not allocate a tunnel port on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return port;
}

// ── Per-session staging ──────────────────────────────────────────────────────

export interface PrepareRemoteSessionOpts {
  target: RemoteTarget;
  remote: RemoteExecutionConfig;
  facts: RemoteFacts;
  jinnSessionId: string;
  /** Gateway port the reverse tunnel forwards to. */
  gatewayPort: number;
  /** Resolved MCP set for this session, if any. Remapped for the remote install. */
  resolvedMcp?: ResolvedMcpConfig;
}

export interface RemoteSessionStaging {
  destination: string;
  tunnelPort: number;
  /** This session's own `$JINN_HOME` on the remote host. */
  sessionHome: string;
  /** Remote path for `--settings`. */
  settingsPath: string;
  /** Remote path for `--mcp-config`, when this session has MCP servers. */
  mcpConfigPath?: string;
  /** 0600 shell fragment the remote command sources for the session's secrets.
   *  A file rather than argv: everything on a remote command line is world-
   *  readable in that host's process table. */
  envFilePath: string;
}

/**
 * Stage everything one remote session needs and return the remote paths its
 * argv must reference.
 *
 * Ordering matters: the farm is rebuilt before anything is written into the
 * stage directory, and the trust seed runs before the session is ever spawned.
 */
export async function prepareRemoteSession(opts: PrepareRemoteSessionOpts): Promise<RemoteSessionStaging> {
  const { target, remote, facts, jinnSessionId } = opts;
  assertRemoteTarget(target, remote);
  const destination = sshDestination(target);
  const sessionHome = remoteSessionHome(facts, jinnSessionId);

  // Only the two steps that touch per-HOST state are serialized; everything
  // below writes inside this session's own directory and cannot collide.
  await serializePerHost(destination, async () => {
    const present = await rebuildHomeFarm(destination, facts, remote.mount, sessionHome);
    await ensureAssets(destination, facts, present);
    await seedRemoteTrust(destination, facts, target.remoteCwd, resolveRemoteClaudeConfigDir(target, remote));
  });

  const tunnelPort = await probeFreePort(destination, facts);

  await stageGatewayJson(destination, sessionHome, tunnelPort);
  const settingsPath = await stageSettings(destination, facts, sessionHome, jinnSessionId);
  const envFilePath = await stageSessionEnvFile(destination, sessionHome, tunnelPort);
  const mcpConfigPath = await stageMcpConfig(destination, facts, sessionHome, tunnelPort, opts.resolvedMcp);

  return {
    destination,
    tunnelPort,
    sessionHome,
    settingsPath,
    envFilePath,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
  };
}

/**
 * The trimmed `gateway.json` the remote side reads.
 *
 * It carries the TUNNEL port, the hook secret, and the API bearer — the last
 * because the built-in jinn MCP server resolves its bearer from
 * `<JINN_HOME>/gateway.json` (`mcp/server.ts` `resolveServerToken`), which is
 * the same 0600 same-uid file mechanism it uses locally, just on a second host.
 *
 * Nothing else from the real file travels: `pid`, `ptyPids`, `host` and `url`
 * all describe the gateway's own process and would only mislead a reader here.
 */
async function stageGatewayJson(destination: string, sessionHome: string, tunnelPort: number): Promise<void> {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  if (!info?.secret) throw new Error("the gateway has no hook secret yet — is the daemon fully started?");
  await stageRemoteFile(
    destination,
    path.posix.join(sessionHome, "gateway.json"),
    `${JSON.stringify({ port: tunnelPort, secret: info.secret, ...(info.token ? { token: info.token } : {}) }, null, 2)}\n`,
  );
}

/**
 * The session's `JINN_GATEWAY_URL` / `JINN_GATEWAY_TOKEN`, as a sourceable
 * shell fragment.
 *
 * The gateway exports both onto its own process env at boot, so a LOCAL session
 * inherits them and the system prompt can promise they are "already exported in
 * your environment" — which every documented curl in that prompt then uses:
 * delegation, following up on a child, reading a child's replies, pushing an
 * attachment, sending on a connector. A remote session inherits nothing from
 * the gateway process, so without this the whole set is dead there, and the URL
 * would in any case have to name the tunnel rather than the gateway's own port.
 *
 * A 0600 file rather than argv or `env K=V`: a remote command line is visible
 * to every process on that host, and the bearer token is not something to put
 * in a process table.
 */
async function stageSessionEnvFile(destination: string, sessionHome: string, tunnelPort: number): Promise<string> {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  const lines = [`export JINN_GATEWAY_URL=${shq(`http://127.0.0.1:${tunnelPort}`)}`];
  if (info?.token) lines.push(`export JINN_GATEWAY_TOKEN=${shq(info.token)}`);
  const envFilePath = path.posix.join(sessionHome, "tmp", "session-env.sh");
  await stageRemoteFile(destination, envFilePath, `${lines.join("\n")}\n`);
  return envFilePath;
}

/** Reuse the real settings builder rather than reimplementing the hook set — it
 *  is the single source of truth for WHICH hooks a session registers, and a
 *  remote session must register exactly the same seven. */
async function stageSettings(
  destination: string,
  facts: RemoteFacts,
  sessionHome: string,
  jinnSessionId: string,
): Promise<string> {
  const settingsPath = path.posix.join(sessionHome, "tmp", "settings.json");
  const settings = buildSessionSettings({
    sessionId: jinnSessionId,
    relayScript: remoteRelayScript(facts),
    // No statusLineDir: the recorder would write engine-limit JSON the gateway
    // cannot read from here. `claudeResetsAtSeconds()` simply returns undefined,
    // which the retry path already handles.
  });
  await stageRemoteFile(destination, settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

/** Rewrite the resolved MCP set for the remote install and stage it.
 *  Every server spec — the builtin AND every scrub-wrapped third party — names
 *  the gateway's own node and dist paths, so a config staged verbatim would
 *  point the remote claude at binaries that do not exist there. */
async function stageMcpConfig(
  destination: string,
  facts: RemoteFacts,
  sessionHome: string,
  tunnelPort: number,
  resolvedMcp: ResolvedMcpConfig | undefined,
): Promise<string | undefined> {
  if (!resolvedMcp || Object.keys(resolvedMcp.mcpServers ?? {}).length === 0) return undefined;
  const remapped = remapMcpConfigForRemote(resolvedMcp, {
    remoteNode: facts.nodeBin,
    remoteEntryDir: facts.entryDir,
    remoteHome: sessionHome,
    gatewayUrl: `http://127.0.0.1:${tunnelPort}`,
  });
  const mcpConfigPath = path.posix.join(sessionHome, "tmp", "mcp.json");
  await stageRemoteFile(destination, mcpConfigPath, `${JSON.stringify(remapped, null, 2)}\n`);
  return mcpConfigPath;
}

// ── The interactive spawn ────────────────────────────────────────────────────

export interface SshSpawnOpts {
  destination: string;
  tunnelPort: number;
  gatewayPort: number;
  remoteCwd: string;
  /** Environment for the REMOTE claude process. `env` passed to pty.spawn only
   *  reaches the local ssh client, so anything the engine needs is inlined into
   *  the remote command instead. */
  remoteEnv: Record<string, string>;
  /** Variables to REMOVE from the remote login environment before exec.
   *  Load-bearing for billing: an `ANTHROPIC_API_KEY` sitting in the remote
   *  user's shell profile would flip the session from Max-subscription auth to
   *  metered API billing, silently. The local path denies the same three from
   *  inheritance (`buildPtyEnv`); `env -u` is how that reaches another host. */
  unsetRemoteEnv?: string[];
  /** Directories prepended to the remote PATH.
   *
   *  Critical, not cosmetic: Claude Code invokes every hook as bare `node`
   *  (`buildSessionSettings`), and a hook runs in the claude process's own
   *  environment. On a host whose Node comes from a version manager, the
   *  non-interactive PATH we inherit has no `node` at all — so every hook would
   *  fail to execute, no Stop would ever arrive, and the turn would hang
   *  forever with nothing reported. Putting the resolved node directory here is
   *  what makes the relay runnable. */
  pathPrepend?: string[];
  /** 0600 shell fragment sourced before exec, carrying the session's secrets.
   *  Sourced rather than inlined because a remote command line is readable by
   *  every process on that host. */
  envFile?: string;
  claudeBin: string;
  claudeArgs: string[];
}

/**
 * Build the argv for the interactive `ssh` that carries the session.
 *
 * The flags are all load-bearing:
 *  - `-tt` forces remote PTY allocation. Passing an explicit remote command
 *    makes ssh default to NO pty, which breaks the TUI outright and with it the
 *    viewport parser that answers Claude Code's safety prompts.
 *  - `BatchMode=yes` keeps this key-only; there is nobody at the keyboard.
 *  - `EscapeChar=none` disables ssh's own `~`-prefixed escapes, which are
 *    otherwise live on the local PTY and could fire on transcript or paste
 *    content. Costs nothing — this is not an interactive human session.
 *  - `ExitOnForwardFailure=yes` is the important one: if the probed port was
 *    taken between probe and spawn, ssh exits immediately instead of running a
 *    session whose hooks and MCP calls can never reach the gateway. That turns
 *    a silent permanent hang — the worst failure for an unattended turn — into
 *    a fast exit the PTY watchdog already knows how to settle.
 */
export function buildSshSpawnArgs(opts: SshSpawnOpts): string[] {
  const unset = (opts.unsetRemoteEnv ?? []).flatMap((key) => ["-u", key]).map(shq).join(" ");
  // The one env entry that is NOT fully quoted: `"$PATH"` has to be expanded by
  // the remote shell so the prepended directories are added to whatever that
  // host's PATH already is, rather than replacing it. Each prepended directory
  // is still quoted individually, and `"$PATH"` is quoted so a directory
  // containing spaces survives on either side.
  const pathEntry = opts.pathPrepend?.length
    ? `PATH=${opts.pathPrepend.map(shq).join(":")}:"$PATH" `
    : "";
  const env = Object.entries(opts.remoteEnv)
    .map(([key, value]) => `${key}=${shq(value)}`)
    .join(" ");
  const claude = [opts.claudeBin, ...opts.claudeArgs].map(shq).join(" ");
  // Sourced BEFORE `env`, so the exported values are inherited through it while
  // `env -u` still strips the billing-critical names from the login profile.
  const source = opts.envFile ? `. ${shq(opts.envFile)} && ` : "";
  // `exec` so the remote shell is replaced by claude: one fewer process between
  // sshd and the TUI, so a dropped connection reaches claude directly.
  const remoteCommand = `cd ${shq(opts.remoteCwd)} && ${source}exec env ${unset ? `${unset} ` : ""}${pathEntry}${env} ${claude}`;
  return [
    "-tt",
    "-o", "BatchMode=yes",
    "-o", "EscapeChar=none",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-R", `${opts.tunnelPort}:127.0.0.1:${opts.gatewayPort}`,
    // `--` first: without it a destination beginning with `-` is read by the
    // LOCAL ssh as an option (`-oProxyCommand=…` then runs ON THE GATEWAY —
    // verified against the real ssh). The host is charset-validated at config
    // load too; this is the belt to that's braces.
    "--",
    opts.destination,
    "--",
    remoteCommand,
  ];
}

/** The directory holding the remote host's `node`.
 *
 *  Prepended to a remote session's PATH so Claude Code's hooks — invoked as
 *  bare `node` — can actually run. On a host using a version manager this
 *  directory is the ONLY place node exists, and a non-interactive ssh sees
 *  none of it. */
export function remoteNodeDir(facts: RemoteFacts): string {
  return path.posix.dirname(facts.nodeBin);
}

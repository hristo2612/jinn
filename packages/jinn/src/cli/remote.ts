import { loadConfig } from "../shared/config.js";
import { scanOrg } from "../gateway/org.js";
import { employeeRemoteTarget, resolveRemoteClaudeConfigDir, sshDestination, validateRemoteTarget } from "../shared/remote-target.js";
import { ensureRemoteReady, sendWakeOnLan, clearRemoteFactsCache } from "../engines/remote-stage.js";
import type { RemoteTarget } from "../shared/types.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Operator-facing view of remote execution.
 *
 * Deliberately an AFFORDANCE, not a mechanism: nothing on the turn path calls
 * into this file. A turn wakes and verifies its own host, because making that
 * depend on someone (or some model) remembering to run a command would put the
 * feature's worst failure mode — a session that silently never starts — back on
 * the table. This is here to answer "why isn't it working", and to let an
 * operator warm a box before queueing work into it.
 */

/** Config, or undefined with a clean message. An instance that has never been
 *  set up is the most likely reason someone runs this, so it should not answer
 *  with a stack trace — every other command degrades gracefully here. */
function readConfig(): ReturnType<typeof loadConfig> | undefined {
  try {
    return loadConfig();
  } catch (err) {
    console.log(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`);
    process.exitCode = 1;
    return undefined;
  }
}

interface RemoteEmployee {
  name: string;
  displayName: string;
  destination: string;
  /** The whole target, kept intact. Rebuilding one from `destination` by
   *  splitting on "@" silently drops `remoteUser`, so every probe would run as
   *  the GATEWAY's username and report an employee as unreachable that is
   *  perfectly fine — a debugging command that lies about the thing it exists
   *  to diagnose. */
  target: RemoteTarget;
  remoteCwd: string;
}

function remoteEmployees(config: ReturnType<typeof loadConfig>): RemoteEmployee[] {
  const out: RemoteEmployee[] = [];
  for (const employee of scanOrg(config).values()) {
    const target = employeeRemoteTarget(employee);
    if (!target) continue;
    out.push({
      name: employee.name,
      displayName: employee.displayName,
      destination: sshDestination(target as typeof target & { remoteHost: string }),
      target,
      remoteCwd: target.remoteCwd ?? "",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveOne(config: ReturnType<typeof loadConfig>, name: string | undefined): RemoteEmployee | undefined {
  const all = remoteEmployees(config);
  if (!name) return all.length === 1 ? all[0] : undefined;
  return all.find((e) => e.name === name);
}

function reportNoTarget(config: ReturnType<typeof loadConfig>, name: string | undefined): void {
  const all = remoteEmployees(config);
  if (all.length === 0) {
    console.log(`${YELLOW}No employees are configured for remote execution.${RESET}`);
    console.log(`${DIM}Add remoteHost/remoteUser/remoteCwd to an employee YAML under the instance org/ directory,`);
    console.log(`and a top-level \`remote:\` block (root, mount) to config.yaml.${RESET}`);
    return;
  }
  if (!name) {
    console.log(`${YELLOW}Several remote employees exist — name one:${RESET}`);
  } else {
    console.log(`${RED}No remote employee named "${name}".${RESET} Known:`);
  }
  for (const e of all) console.log(`  ${e.name} ${DIM}(${e.destination}:${e.remoteCwd})${RESET}`);
}

/** The instance-wide half of the status report. */
function printRemoteConfig(remote: NonNullable<ReturnType<typeof loadConfig>["remote"]>): void {
  console.log(`${DIM}root:  ${remote.root}${RESET}`);
  console.log(`${DIM}mount: ${remote.mount}${RESET}`);
  console.log(`${DIM}wake:  ${remote.wakeCommand ? "command" : remote.wakeMac ? `WoL ${remote.wakeMac}` : "not configured"}${RESET}`);
  console.log(`${DIM}claude profile: ${remote.claudeConfigDir ?? "(remote user's default)"}${RESET}`);
  console.log("");
}

/** One employee's line, probed but never woken. */
async function printEmployeeStatus(
  employee: RemoteEmployee,
  remote: NonNullable<ReturnType<typeof loadConfig>["remote"]>,
): Promise<void> {
  const problem = validateRemoteTarget(employee.target, remote);
  if (problem) {
    console.log(`${RED}✗ ${employee.name}${RESET} — ${problem.error}`);
    return;
  }
  // Never wake from a status check: "is it up" must not have the side effect
  // of turning it on.
  clearRemoteFactsCache();
  const readiness = await ensureRemoteReady(employee.target, remote, { allowWake: false });
  if (!readiness.ready) {
    console.log(`${YELLOW}✗ ${employee.name}${RESET} ${DIM}${employee.destination}${RESET} — ${readiness.reason}`);
    return;
  }
  const profile = resolveRemoteClaudeConfigDir(employee.target, remote);
  console.log(`${GREEN}✓ ${employee.name}${RESET} ${DIM}${employee.destination}:${employee.remoteCwd}${RESET}`);
  console.log(`  ${DIM}jinn ${readiness.facts.jinnVersion}, node ${readiness.facts.nodeBin}, home ${readiness.facts.stageDir}${RESET}`);
  console.log(`  ${DIM}profile ${profile ?? "(default)"}, claude ${readiness.facts.claudeBin}${RESET}`);
}

/** `jinn remote status [employee]` — what the turn path would find right now. */
export async function remoteStatus(name?: string): Promise<void> {
  const config = readConfig();
  if (!config) return;
  const remote = config.remote;
  if (!remote) {
    console.log(`${RED}No \`remote\` block in config.yaml${RESET} — remote employees will refuse to load.`);
    console.log(`${DIM}Needs at least: remote.root (the sandbox prefix every remoteCwd must sit under)`);
    console.log(`and remote.mount (where this instance's home is sshfs-mounted on the remote host).${RESET}`);
    return;
  }
  printRemoteConfig(remote);

  const targets = name ? [resolveOne(config, name)].filter(Boolean) as RemoteEmployee[] : remoteEmployees(config);
  if (targets.length === 0) {
    reportNoTarget(config, name);
    return;
  }

  for (const employee of targets) await printEmployeeStatus(employee, remote);
}

/** `jinn remote wake <employee>` — bring a host up without queueing work. */
export async function remoteWake(name?: string): Promise<void> {
  const config = readConfig();
  if (!config) return;
  const remote = config.remote;
  if (!remote) {
    console.log(`${RED}No \`remote\` block in config.yaml.${RESET}`);
    process.exitCode = 1;
    return;
  }
  const employee = resolveOne(config, name);
  if (!employee) {
    reportNoTarget(config, name);
    process.exitCode = 1;
    return;
  }
  if (!remote.wakeCommand && !remote.wakeMac) {
    console.log(`${RED}Neither remote.wakeCommand nor remote.wakeMac is configured.${RESET}`);
    process.exitCode = 1;
    return;
  }
  if (!remote.wakeCommand && remote.wakeMac) {
    // Report the packet going out even though ensureRemoteReady would send it
    // too — an operator running `wake` explicitly wants to see that step.
    await sendWakeOnLan(remote.wakeMac);
    console.log(`${DIM}Wake-on-LAN sent to ${remote.wakeMac}.${RESET}`);
  }
  console.log(`Waiting for ${employee.destination}…`);
  const readiness = await ensureRemoteReady(employee.target, remote, { allowWake: true });
  if (readiness.ready) {
    console.log(`${GREEN}✓ ${employee.destination} is ready.${RESET}`);
  } else {
    console.log(`${RED}✗ ${readiness.reason}${RESET}`);
    process.exitCode = 1;
  }
}

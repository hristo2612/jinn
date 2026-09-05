import { spawnSync } from "node:child_process"

export function signalGatewayGroup(handle, signal) {
  try {
    process.kill(-handle.child.pid, signal)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}

function groupHasLiveProcesses(group) {
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" })
  if (result.error || result.status !== 0) throw new Error(`could not inspect upgrade-verifier process group ${group}`)
  return result.stdout.trim().split("\n").some((row) => {
    const [pgid, state] = row.trim().split(/\s+/)
    return Number(pgid) === group && !state.startsWith("Z")
  })
}

export async function stopGatewayGroup(handle) {
  // CLI probes can outlive the foreground gateway and recreate a deleted HOME.
  // The gateway owns a fresh process group, so this never targets the caller.
  if (!signalGatewayGroup(handle, "SIGKILL")) return
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    // Exited orphans may remain zombies until init reaps them. Darwin can also
    // report EPERM from kill(-pgid, 0) during that interval; inspect state instead.
    if (!groupHasLiveProcesses(handle.child.pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`upgrade-verifier process group ${handle.child.pid} survived SIGKILL`)
}

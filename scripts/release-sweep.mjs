#!/usr/bin/env node
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { gitReader } from "./inspect-release.mjs"

const exec = promisify(execFile)
const GATES = ["build", "test", "typecheck", "lint", "ratchet", "footguns"]

export async function withSweepWorktree(repo, sha, action) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected exact surveyed commit SHA")
  const git = gitReader(repo)
  await git("cat-file", "-e", `${sha}^{commit}`)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jinn-release-sweep-"))
  const cwd = path.join(root, "checkout")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("JINN_")))
  env.JINN_HOME = path.join(root, "home")
  await fs.mkdir(env.JINN_HOME)
  let created = false
  try {
    await git("worktree", "add", "--detach", cwd, sha)
    created = true
    const isolatedGit = gitReader(cwd)
    if (await isolatedGit("rev-parse", "HEAD") !== sha || await isolatedGit("status", "--porcelain")) {
      throw new Error("Sweep worktree must be clean at the exact surveyed SHA")
    }
    return await action({ cwd, env, sha })
  } finally {
    if (created) await git("worktree", "remove", "--force", cwd)
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function runPnpm(args, context) {
  const { stdout, stderr } = await exec(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: context.cwd, env: context.env, timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    ...(process.platform === "win32" ? { shell: true } : {}),
  })
  return `${stdout}${stderr}`.trim()
}

async function recordedCommand(args, context, { run, logDirectory }) {
  const logFile = path.join(logDirectory, `${args[0]}.log`)
  try {
    const output = await run(args, context)
    await fs.writeFile(logFile, output)
    return { output, logFile }
  } catch (error) {
    await fs.writeFile(logFile, `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}`)
    error.message += `; full log: ${logFile}`
    error.logFile = logFile
    throw error
  }
}

export async function sweepGates(repo, sha, { run = runPnpm, evidenceDir = undefined } = {}) {
  // Triage runs in a later session, after the failed worktree is gone. Its
  // reproduction needs the full failing log, not only the last summary lines.
  const logDirectory = evidenceDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "jinn-sweep-evidence-"))
  await fs.mkdir(logDirectory, { recursive: true })
  return withSweepWorktree(repo, sha, async (context) => {
    await recordedCommand(["install", "--frozen-lockfile"], context, { run, logDirectory })
    const gates = []
    for (const gate of GATES) {
      try {
        const { output, logFile } = await recordedCommand([gate], context, { run, logDirectory })
        gates.push({ gate, result: "passed", logFile, tail: output.split("\n").slice(-20).join("\n") })
      } catch (error) {
        const tail = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}`.trim().split("\n").slice(-20).join("\n")
        return { decision: "red", headSha: sha, gates, failingGate: gate, tail, logDirectory, logFile: error.logFile }
      }
    }
    if (await gitReader(context.cwd)("status", "--porcelain")) throw new Error("Gates modified the swept tree")
    return { decision: "green", headSha: sha, gates, logDirectory }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await sweepGates(process.argv[2], process.argv[3], { evidenceDir: process.argv[4] }))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

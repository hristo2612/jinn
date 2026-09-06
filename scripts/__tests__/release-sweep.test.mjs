import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { sweepGates } from "../release-sweep.mjs"

function fixture(t) {
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-logs-"))
  t.after(() => fs.rmSync(evidenceDir, { recursive: true, force: true }))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-fixture-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  fs.writeFileSync(path.join(repo, "tracked.txt"), "surveyed content")
  git("add", ".")
  git("commit", "-m", "surveyed commit")
  const sha = git("rev-parse", "HEAD")
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  return { repo, git, sha, evidenceDir }
}

test("all gates see the surveyed detached commit despite staged, tracked, and package dirt in the shared tree", async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.repo, "tracked.txt"), "staged operator work")
  f.git("add", "tracked.txt")
  fs.writeFileSync(path.join(f.repo, "tracked.txt"), "unstaged operator work")
  fs.mkdirSync(path.join(f.repo, "packages"))
  fs.writeFileSync(path.join(f.repo, "packages/untracked.txt"), "another lane")
  const before = f.git("status", "--porcelain")
  const oldToken = process.env.JINN_GATEWAY_TOKEN
  process.env.JINN_GATEWAY_TOKEN = "fixture-must-be-scrubbed"
  t.after(() => { if (oldToken === undefined) delete process.env.JINN_GATEWAY_TOKEN; else process.env.JINN_GATEWAY_TOKEN = oldToken })
  const visited = []
  let checkout
  const result = await sweepGates(f.repo, f.sha, { evidenceDir: f.evidenceDir, run: async (args, context) => {
    checkout = context.cwd
    visited.push(args[0])
    assert.equal(fs.readFileSync(path.join(context.cwd, "tracked.txt"), "utf8"), "surveyed content")
    assert.equal(fs.existsSync(path.join(context.cwd, "packages/untracked.txt")), false)
    assert.equal(context.env.JINN_GATEWAY_TOKEN, undefined)
    assert.ok(context.env.JINN_HOME.startsWith(path.dirname(context.cwd)))
    assert.equal(execFileSync("git", ["-C", context.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), "HEAD")
    return "gate passed"
  } })
  assert.equal(result.decision, "green")
  assert.deepEqual(visited, ["install", "build", "test", "typecheck", "lint", "ratchet", "footguns"])
  assert.equal(f.git("status", "--porcelain"), before)
  assert.equal(fs.existsSync(checkout), false)
  assert.ok(!f.git("worktree", "list", "--porcelain").includes(checkout))
  t.diagnostic("shared staged/unstaged/package dirt preserved; six gates at detached surveyed SHA; worktree removed")
})

test("a red gate carries its diagnosis into triage and removes its own worktree", async (t) => {
  const f = fixture(t)
  let checkout
  const result = await sweepGates(f.repo, f.sha, { evidenceDir: f.evidenceDir, run: async (args, context) => {
    checkout = context.cwd
    if (args[0] === "test") throw Object.assign(new Error("test failed"), { stdout: "FAIL parser.test.ts\nexpected 2, received 1\n" + "summary filler\n".repeat(30) })
    return "passed"
  } })
  assert.equal(result.decision, "red")
  assert.equal(result.failingGate, "test")
  assert.match(fs.readFileSync(result.logFile, "utf8"), /parser.test.ts/)
  assert.equal(fs.existsSync(result.logDirectory), true)
  assert.equal(fs.existsSync(checkout), false)
})

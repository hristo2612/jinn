import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { verifyReleaseRepair } from "../verify-release-repair.mjs"

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repair-boundary-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  fs.writeFileSync(path.join(repo, "parser.ts"), "export const parse = () => 1\n")
  fs.writeFileSync(path.join(repo, "parser.test.ts"), "test('parses', () => expect(parse()).toBe(2))\n")
  fs.writeFileSync(path.join(repo, "size-baseline.json"), '{"parser.ts":10}\n')
  fs.writeFileSync(path.join(repo, "package.json"), '{"scripts":{"test":"vitest run"}}\n')
  git("add", ".")
  git("commit", "-m", "red gate")
  const baseSha = git("rev-parse", "HEAD")
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const check = async () => {
    git("add", "-A")
    git("commit", "-m", "candidate repair")
    return verifyReleaseRepair(repo, baseSha, git("rev-parse", "HEAD"))
  }
  return { repo, check }
}

test("a production fix with an additive regression preserves release eligibility", async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.repo, "parser.ts"), "export const parse = () => 2\n")
  fs.writeFileSync(path.join(f.repo, "parser-regression.test.ts"), "test('empty', () => expect(parse('')).toBe(2))\n")
  assert.equal((await f.check()).result, "preserved-tests-and-gates")
})

/** @type {Array<[string, (repo: string) => void, RegExp]>} */
const forbiddenRepairs = [
  ["delete test", (repo) => fs.unlinkSync(path.join(repo, "parser.test.ts")), /existing test/],
  ["skip test", (repo) => fs.writeFileSync(path.join(repo, "parser.test.ts"), "test.skip('parses', () => {})\n"), /existing test/],
  ["mark flaky", (repo) => fs.writeFileSync(path.join(repo, "flaky-tests.json"), '["parser.test.ts"]'), /protected gate/],
  ["widen ratchet", (repo) => fs.writeFileSync(path.join(repo, "size-baseline.json"), '{"parser.ts":20}'), /protected gate/],
  ["disable gate", (repo) => fs.writeFileSync(path.join(repo, "package.json"), '{"scripts":{"test":"true"}}'), /protected gate/],
  ["new skipped test", (repo) => fs.writeFileSync(path.join(repo, "new.test.ts"), "test.skip('new', () => {})\n"), /suppressed/],
  ["wrap existing tests", (repo) => fs.writeFileSync(path.join(repo, "parser.test.ts"), "if (false) {\n" + fs.readFileSync(path.join(repo, "parser.test.ts"), "utf8") + "}\n"), /existing test/],
  ["select only a new test", (repo) => fs.writeFileSync(path.join(repo, "new.test.ts"), "test\n.only('new', () => {})\n"), /suppressed/],
  ["replace footgun implementation", (repo) => { fs.mkdirSync(path.join(repo, "scripts/footguns"), { recursive: true }); fs.writeFileSync(path.join(repo, "scripts/footguns/privacy-leak.mjs"), "process.exit(0)") }, /protected gate/],
  ["change test setup", (repo) => fs.writeFileSync(path.join(repo, "vitest.setup.ts"), "process.exit(0)"), /protected gate/],
  ["disable typecheck", (repo) => fs.writeFileSync(path.join(repo, "tsconfig.json"), '{"exclude":["**/*"]}'), /protected gate/],
  ["rewrite checker", (repo) => fs.writeFileSync(path.join(repo, "verify-release-repair.mjs"), "process.exit(0)"), /protected gate/],
]
for (const [name, mutate, refusal] of forbiddenRepairs) {
  test(`automatic repair refuses to ${name}`, async (t) => {
    const f = fixture(t)
    mutate(f.repo)
    await assert.rejects(f.check(), refusal)
  })
}

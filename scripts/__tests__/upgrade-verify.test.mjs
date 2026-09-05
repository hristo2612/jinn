import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parseArgs } from "../upgrade-verify.mjs"
import {
  NONCE_FILE,
  PROTECTED_PORTS,
  assertShippedSkillsConverged,
  deriveScenarioPort,
  hashUpgradeSurface,
} from "../upgrade-verify-lib.mjs"

const entrypoint = fileURLToPath(new URL("../upgrade-verify.mjs", import.meta.url))

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-verify-test-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test("requires one exact candidate tarball", (t) => {
  const root = temporaryRoot(t)
  const tarball = path.join(root, "candidate.tgz")
  fs.writeFileSync(tarball, "candidate")
  assert.deepEqual(parseArgs(["--candidate-tarball", tarball]), { candidateTarball: tarball })
  assert.throws(() => parseArgs([]), /candidate-tarball is required/)
  assert.throws(() => parseArgs(["--candidate-tarball", path.join(root, "missing.tgz")]), /does not exist/)
  assert.throws(() => parseArgs(["--scenario", "stock"]), /unknown argument/)
})

test("derives stable scenario-specific ports from the disposable nonce", (t) => {
  const root = temporaryRoot(t)
  fs.writeFileSync(path.join(root, NONCE_FILE), "fixed-nonce\n")
  const stock = deriveScenarioPort(root, "stock")
  assert.equal(stock, deriveScenarioPort(root, "stock"))
  assert.notEqual(stock, deriveScenarioPort(root, "customized"))
  assert.ok(stock >= 20_000 && stock < 40_000)
  assert.equal(PROTECTED_PORTS.has(stock), false)
})

test("candidate template comparison proves exact convergence", (t) => {
  const root = temporaryRoot(t)
  const template = path.join(root, "candidate", "template", "skills", "example")
  const installed = path.join(root, "home", "skills", "example")
  fs.mkdirSync(template, { recursive: true })
  fs.mkdirSync(installed, { recursive: true })
  fs.writeFileSync(path.join(template, "SKILL.md"), "# {{portalName}}\nslug={{portalSlug}}\n")
  fs.writeFileSync(path.join(installed, "SKILL.md"), "# Jinn\nslug=jinn\n")
  assert.doesNotThrow(() => assertShippedSkillsConverged(path.join(root, "home"), path.join(root, "candidate"), ["example"]))
  fs.writeFileSync(path.join(installed, "SKILL.md"), "stale\n")
  assert.throws(
    () => assertShippedSkillsConverged(path.join(root, "home"), path.join(root, "candidate"), ["example"]),
    /was not rewritten to candidate bytes/,
  )
})

test("idempotency surface includes skills, receipt, version, and backups", (t) => {
  const home = temporaryRoot(t)
  for (const file of ["skills/example/SKILL.md", ".jinn-template-skills.json", "config.yaml", ".migration-backups/run/config.yaml"]) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true })
    fs.writeFileSync(path.join(home, file), `${file}\n`)
  }
  const before = hashUpgradeSurface(home)
  assert.deepEqual(hashUpgradeSurface(home), before)
  fs.appendFileSync(path.join(home, "config.yaml"), "changed\n")
  assert.notDeepEqual(hashUpgradeSurface(home), before)
})

test("standalone verifier never imports the retired migration harness", () => {
  const source = fs.readFileSync(entrypoint, "utf8")
  assert.doesNotMatch(source, /upgrade-lab\/run|migrations\/(service|snapshot|completion)\.js|getPendingInstanceMigration/)
  assert.match(source, /published jinn-cli@/)
  assert.match(source, /candidate-second-boot/)
})

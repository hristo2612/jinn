#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  assertShippedSkillsConverged,
  buildEnvironment,
  createDisposableRoot,
  deriveScenarioPort,
  hashUpgradeSurface,
  installTarball,
  latestPublishedTarball,
  listFiles,
  listSkillNames,
  removeDisposableRoot,
  run,
  sha256,
  startGateway,
  stopGateway,
} from "./upgrade-verify-lib.mjs"

const SCENARIOS = ["stock", "customized"]
const SENTINEL = "OPERATOR-AUTHORED-SKILL-SURVIVES\n"
const MODIFIED_SENTINEL = "\nOPERATOR-MODIFIED-RETIRED-SKILL-SURVIVES\n"
const REWRITE_SENTINEL = "\nUPGRADE-VERIFY-MUST-REWRITE-THIS\n"

export function parseArgs(argv) {
  let candidateTarball
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--") continue
    if (value === "--candidate-tarball") candidateTarball = path.resolve(argv[++index] ?? "")
    else throw new Error(`unknown argument: ${value}`)
  }
  if (!candidateTarball) throw new Error("--candidate-tarball is required; the verifier never guesses which artifact is under test")
  if (!fs.existsSync(candidateTarball) || !fs.statSync(candidateTarball).isFile()) {
    throw new Error(`candidate tarball does not exist: ${candidateTarball}`)
  }
  return { candidateTarball }
}

function setGatewayPort(home, port) {
  const config = path.join(home, "config.yaml")
  const source = fs.readFileSync(config, "utf8")
  const updated = source.replace(/^(\s+port:\s*)\d+(\s*)$/m, `$1${port}$2`)
  if (updated === source) throw new Error("baseline config has no numeric gateway port")
  fs.writeFileSync(config, updated)
}

function poisonVersionMarker(home) {
  const config = path.join(home, "config.yaml")
  const source = fs.readFileSync(config, "utf8")
  const updated = source.replace(/^(\s+version:\s*)[^\n]+$/m, "$1\"0.0.0-upgrade-verify\"")
  if (updated === source) throw new Error("baseline config has no jinn.version marker")
  fs.writeFileSync(config, updated)
}

function assertVersionStamped(home, version) {
  const source = fs.readFileSync(path.join(home, "config.yaml"), "utf8")
  const match = /^\s+version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(source)
  if (match?.[1] !== version) throw new Error(`jinn.version was ${match?.[1] ?? "missing"}, expected ${version}`)
}

function assertReceipt(home, version, skills) {
  const receipt = JSON.parse(fs.readFileSync(path.join(home, ".jinn-template-skills.json"), "utf8"))
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(["skills", "version"])) {
    throw new Error("template-skills receipt has unexpected fields")
  }
  if (receipt.version !== version || JSON.stringify(receipt.skills) !== JSON.stringify(skills)) {
    throw new Error(`template-skills receipt is wrong for candidate ${version}`)
  }
}

function assertBackups(home, removedNames, exactCopies = []) {
  const root = path.join(home, ".migration-backups")
  const backups = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  if (backups.length !== 1) throw new Error(`expected one first-boot backup, found ${backups.length}`)
  const backup = path.join(root, backups[0])
  for (const { file, bytes } of exactCopies) {
    const copy = path.join(backup, path.relative(home, file))
    if (!fs.existsSync(copy) || !fs.readFileSync(copy).equals(bytes)) {
      throw new Error(`backup does not contain the pre-upgrade bytes for ${path.relative(home, file)}`)
    }
  }
  for (const name of removedNames) {
    if (listFiles(path.join(backup, "skills", name)).length === 0) throw new Error(`backup is missing retired skill ${name}`)
  }
  return backup
}

async function boot(cli, layout, port, label) {
  try {
    const handle = await startGateway(cli, layout, port, label)
    await stopGateway(handle)
  } catch (error) {
    const attribution = label === "published-latest"
      ? "harness/environment fault: published baseline could not complete boot; candidate not evaluated"
      : `candidate rejection: ${label} failed`
    throw new Error(`${attribution}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function inspectSkillDelta(home, baselineRoot, candidateRoot) {
  const baselineSkills = listSkillNames(baselineRoot)
  const candidateSkills = listSkillNames(candidateRoot)
  const added = candidateSkills.filter((name) => !baselineSkills.includes(name))
  const retired = baselineSkills.filter((name) => !candidateSkills.includes(name))
  const commonNames = candidateSkills.filter((name) => baselineSkills.includes(name)
    && fs.existsSync(path.join(home, "skills", name, "SKILL.md")))
  const naturallyChanged = commonNames.find((name) => {
    try {
      assertShippedSkillsConverged(home, candidateRoot, [name])
      return false
    } catch {
      return true
    }
  })
  const common = naturallyChanged ?? commonNames[0]
  if (!common) throw new Error("published latest and candidate share no shipped skill to prove rewriting")
  for (const name of added) if (fs.existsSync(path.join(home, "skills", name))) throw new Error(`candidate-new skill ${name} already existed before upgrade`)
  for (const name of retired) if (!fs.existsSync(path.join(home, "skills", name))) throw new Error(`published retired skill ${name} was absent before upgrade`)
  return { baselineSkills, candidateSkills, added, retired, common, naturallyChanged }
}

function customizeSkillFixture(home, delta) {
  const operatorFile = path.join(home, "skills", "operator-authored", "SKILL.md")
  fs.mkdirSync(path.dirname(operatorFile), { recursive: true })
  fs.writeFileSync(operatorFile, SENTINEL)
  const corruptedFile = path.join(home, "skills", delta.common, "SKILL.md")
  fs.appendFileSync(corruptedFile, REWRITE_SENTINEL)
  const preservedRetired = delta.retired[0] ?? null
  let preservedModifiedFile
  if (preservedRetired) {
    preservedModifiedFile = path.join(home, "skills", preservedRetired, "SKILL.md")
    fs.appendFileSync(preservedModifiedFile, MODIFIED_SENTINEL)
  } else {
    preservedModifiedFile = path.join(home, "skills", "operator-modified", "SKILL.md")
    fs.mkdirSync(path.dirname(preservedModifiedFile), { recursive: true })
    fs.writeFileSync(preservedModifiedFile, `BASE OPERATOR SKILL${MODIFIED_SENTINEL}`)
  }
  const restoredMissing = delta.candidateSkills.find((name) => name !== delta.common && delta.baselineSkills.includes(name)) ?? null
  if (restoredMissing) fs.rmSync(path.join(home, "skills", restoredMissing), { recursive: true })
  poisonVersionMarker(home)
  return { operatorFile, corruptedFile, corruptedBytes: fs.readFileSync(corruptedFile), preservedRetired, preservedModifiedFile, preservedModifiedBytes: fs.readFileSync(preservedModifiedFile), restoredMissing }
}

function assertCustomFixture(home, fixture) {
  if (!fixture) return
  if (fs.readFileSync(fixture.operatorFile, "utf8") !== SENTINEL) throw new Error("operator-authored skill changed during boot-sync")
  if (fixture.restoredMissing && !fs.existsSync(path.join(home, "skills", fixture.restoredMissing))) {
    throw new Error(`missing shipped skill ${fixture.restoredMissing} was not added on boot`)
  }
  const value = fs.readFileSync(fixture.preservedModifiedFile)
  if (!value.equals(fixture.preservedModifiedBytes)) throw new Error(`operator-modified skill ${path.basename(path.dirname(fixture.preservedModifiedFile))} did not survive untouched`)
}

function assertRetiredRemoved(home, retired, preserved) {
  const removed = retired.filter((name) => name !== preserved)
  for (const name of removed) if (fs.existsSync(path.join(home, "skills", name))) throw new Error(`retired skill ${name} survived boot-sync`)
  return removed
}

function exactBackupCopies(home, configBefore, fixture) {
  const copies = [{ file: path.join(home, "config.yaml"), bytes: configBefore }]
  if (fixture) copies.push({ file: fixture.corruptedFile, bytes: fixture.corruptedBytes })
  return copies
}

function rewriteEvidence(delta, fixture) {
  if (delta.naturallyChanged) return delta.naturallyChanged
  return fixture ? `${delta.common} (fixture)` : "none changed by candidate"
}

async function verifyScenario({ scenario, root, baseline, candidate }) {
  const port = deriveScenarioPort(root, scenario)
  const layout = buildEnvironment(root, scenario, port)
  const baselineInstall = installTarball(baseline.tarball, path.join(layout.prefix, "baseline"), layout.env)
  const candidateInstall = installTarball(candidate.tarball, path.join(layout.prefix, "candidate"), layout.env)
  if (baselineInstall.version === candidateInstall.version) {
    throw new Error(`candidate version ${candidateInstall.version} equals npm latest; this is not an upgrade`)
  }
  run(process.execPath, [baselineInstall.cli, "setup"], { env: layout.env })
  setGatewayPort(layout.home, port)
  await boot(baselineInstall.cli, layout, port, "published-latest")
  const delta = inspectSkillDelta(layout.home, baselineInstall.packageRoot, candidateInstall.packageRoot)
  const fixture = scenario === "customized" ? customizeSkillFixture(layout.home, delta) : null
  const configBefore = Buffer.from(fs.readFileSync(path.join(layout.home, "config.yaml")))

  await boot(candidateInstall.cli, layout, port, "candidate-first-boot")
  assertShippedSkillsConverged(layout.home, candidateInstall.packageRoot, delta.candidateSkills)
  assertCustomFixture(layout.home, fixture)
  const removed = assertRetiredRemoved(layout.home, delta.retired, fixture?.preservedRetired)
  assertReceipt(layout.home, candidateInstall.version, delta.candidateSkills)
  assertVersionStamped(layout.home, candidateInstall.version)
  const backup = assertBackups(layout.home, removed, exactBackupCopies(layout.home, configBefore, fixture))

  const firstBootSurface = hashUpgradeSurface(layout.home)
  await boot(candidateInstall.cli, layout, port, "candidate-second-boot")
  const secondBootSurface = hashUpgradeSurface(layout.home)
  if (JSON.stringify(secondBootSurface) !== JSON.stringify(firstBootSurface)) throw new Error("second candidate boot changed the upgrade-owned surface")
  const preservedModified = fixture ? path.basename(path.dirname(fixture.preservedModifiedFile)) : null
  return { scenario, port, candidateVersion: candidateInstall.version, added: delta.added, restoredMissing: fixture?.restoredMissing ?? null, retired: removed, preservedModified, rewritten: rewriteEvidence(delta, fixture), backup: path.relative(root, backup) }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const root = createDisposableRoot()
  let result
  try {
    const bootstrap = buildEnvironment(root, "bootstrap", deriveScenarioPort(root, "bootstrap"))
    const baseline = latestPublishedTarball(root, bootstrap.env)
    const candidateCopy = path.join(root, path.basename(options.candidateTarball))
    fs.copyFileSync(options.candidateTarball, candidateCopy)
    const candidate = { tarball: candidateCopy, sha256: sha256(fs.readFileSync(candidateCopy)) }
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await verifyScenario({ scenario, root, baseline, candidate }))
    result = { baselineVersion: baseline.version, candidateSha256: candidate.sha256, scenarios }
    console.log(`PASS published jinn-cli@${baseline.version} -> candidate jinn-cli@${scenarios[0].candidateVersion} sha256=${candidate.sha256}`)
    for (const item of scenarios) console.log(`PASS ${item.scenario} port=${item.port} rewritten=${item.rewritten} added=${item.added.length} restoredMissing=${item.restoredMissing ?? "n/a"} retired=${item.retired.length} preservedModified=${item.preservedModified ?? "n/a"} backup=${item.backup}`)
    return result
  } finally {
    try {
      await removeDisposableRoot(root)
      console.log(`CLEANUP removed disposable root ${root}`)
    } catch (error) {
      console.error(`CLEANUP LEAK: disposable root ${root}; ${error instanceof Error ? error.message : String(error)}; manual cleanup required; verification result unchanged`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`FAIL upgrade verification: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

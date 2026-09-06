#!/usr/bin/env node
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { awaitNpmVersion, poll } from "./await-npm-version.mjs"
import { awaitRun, ensureRelease, gh, verifyRemoteTag } from "./release-github.mjs"

async function formulaMatches(version, checksum, run) {
  const file = JSON.parse(await run(["api", "repos/{owner}/{repo}/contents/Formula/jinn.rb?ref=main"]))
  const formula = Buffer.from(file.content, "base64").toString("utf8")
  return formula.includes(`url "https://registry.npmjs.org/jinn-cli/-/jinn-cli-${version}.tgz"`)
    && formula.includes(`sha256 "${checksum}"`)
}

async function tarballChecksum(version) {
  return poll(async (remaining) => {
    const response = await fetch(`https://registry.npmjs.org/jinn-cli/-/jinn-cli-${version}.tgz?release-check=${Date.now()}`, {
      cache: "no-store", headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(Math.min(60000, remaining)),
    })
    if (!response.ok) throw new Error(`Tarball HTTP ${response.status}`)
    return createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex")
  }, { label: `npm tarball ${version}` })
}

export async function watchHomebrew({ runId, minimumAttempt }, run, options = {}) {
  await poll(async (remaining) => {
    const info = JSON.parse(await run(["run", "view", String(runId), "--json", "status,conclusion,attempt"], Math.min(60000, remaining)))
    if (info.status !== "completed" || info.attempt < minimumAttempt) return false
    return info
  }, { timeoutMs: 10 * 60 * 1000, ...options, label: `Homebrew run ${runId} completion` })
}

async function recoverHomebrewRun({ tag, sha, event }, run, waitRun) {
  let runId
  try {
    runId = await waitRun({ workflow: "bump-formula.yml", sha, tag, event }, run)
  } catch {
    // An existing Release emits no second published event. Dispatching at the
    // same immutable tag repairs a lost event without deleting/recreating it.
    await run(["workflow", "run", "bump-formula.yml", "--ref", tag])
    runId = await waitRun({ workflow: "bump-formula.yml", sha, tag, event: "workflow_dispatch" }, run)
  }
  const info = JSON.parse(await run(["run", "view", String(runId), "--json", "status,conclusion,attempt"]))
  let minimumAttempt = info.attempt
  if (info.status === "completed") {
    await run(["run", "rerun", String(runId)])
    minimumAttempt += 1
  }
  return { runId, minimumAttempt }
}

export async function completeHomebrew({ tag, sha, checksum }, options = {}) {
  const { run = gh, matches = formulaMatches, waitRun = awaitRun, watch = watchHomebrew } = options
  const version = tag.slice(1)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await matches(version, checksum, run)) return "bumped"
    await verifyRemoteTag(tag, sha, run)
    const runId = await recoverHomebrewRun({ tag, sha, event: "release" }, run, waitRun)
    await watch(runId, run)
  }
  if (await matches(version, checksum, run)) return "bumped"
  throw new Error(`Homebrew ${tag} incomplete after 3 attempts; resume the same release, npm is already published`)
}

export async function completeRelease({ version, sha, title, notesFile }, options = {}) {
  const { registryCheck = awaitNpmVersion, release = ensureRelease,
    checksum = tarballChecksum, homebrew = completeHomebrew } = options
  // Registry truth is sufficient on resume, even if a later Actions step failed.
  // This command never publishes npm or creates/moves/pushes a git tag.
  await registryCheck(version)
  const tag = `v${version}`
  const releaseUrl = await release({ tag, sha, title, notesFile })
  const homebrewStatus = await homebrew({ tag, sha, checksum: await checksum(version) })
  return { version, npmVersion: version, releaseUrl, homebrew: homebrewStatus }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [version, sha, title, notesFile] = process.argv.slice(2)
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected full release commit SHA")
    console.log(JSON.stringify(await completeRelease({ version, sha, title, notesFile })))
  } catch (error) {
    console.error(`${error.message}. Completion remains pending; rerun for the same version and commit.`)
    process.exitCode = 1
  }
}

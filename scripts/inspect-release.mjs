#!/usr/bin/env node
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { gh } from "./release-github.mjs"
import { findAnnouncement, slackClient } from "./announce-release.mjs"

const exec = promisify(execFile)
const PACKAGE = "packages/jinn/package.json"

export function gitReader(repo) {
  return async (...args) => (await exec("git", ["-C", repo, ...args], {
    timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim()
}

export async function releaseCommit(version, git) {
  const tag = `v${version}`
  const remote = await git("ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
  if (remote) {
    const rows = remote.split("\n").map((line) => line.split(/\s+/))
    const sha = (rows.find((row) => row[1].endsWith("^{}")) ?? rows[0])[0]
    return { sha, tagged: true }
  }
  // A push can land before its tag. Locate the version-introducing commit,
  // rather than tagging today's HEAD (which may contain newer work).
  const commits = (await git("log", "origin/main", "--format=%H", "--", PACKAGE)).split("\n")
  let sha
  for (const commit of commits) {
    const pkg = JSON.parse(await git("show", `${commit}:${PACKAGE}`))
    if (pkg.version !== version) break
    sha = commit
  }
  if (!sha || !(await git("show", "-s", "--format=%s", sha)).startsWith(`release: ${tag}`)) {
    throw new Error(`No verifiable release commit for ${tag}`)
  }
  return { sha, tagged: false }
}

export async function validateReleaseCommit({ version, sha }, git) {
  await git("merge-base", "--is-ancestor", sha, "origin/main")
  const parents = (await git("show", "-s", "--format=%P", sha)).split(" ")
  if (parents.length !== 1) throw new Error("Release commit must have one swept parent")
  const baseSha = parents[0]
  const before = JSON.parse(await git("show", `${baseSha}:${PACKAGE}`))
  const after = JSON.parse(await git("show", `${sha}:${PACKAGE}`))
  const paths = (await git("diff", "--name-only", baseSha, sha)).split("\n").sort()
  if (after.version !== version || before.version === version
    || JSON.stringify({ ...before, version }) !== JSON.stringify(after)
    || JSON.stringify(paths) !== JSON.stringify(["CHANGELOG.md", PACKAGE])) {
    throw new Error("Release commit is not exclusively the intended version and changelog edits")
  }
  return baseSha
}

async function jsonResponse(url, fetchImpl) {
  const response = await fetchImpl(url, { cache: "no-store",
    headers: { "Cache-Control": "no-cache, no-store" }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Release inspection HTTP ${response.status}`)
  return response.json()
}

async function githubRelease(tag, run) {
  try { return JSON.parse(await run(["api", `repos/{owner}/{repo}/releases/tags/${tag}`])) }
  catch (error) {
    if (/HTTP 404/.test(`${error.message} ${error.stderr ?? ""}`)) return null
    throw error
  }
}

async function formulaComplete({ version, metadata }, git, fetchImpl) {
  const formula = await git("show", "origin/main:Formula/jinn.rb")
  const url = `https://registry.npmjs.org/jinn-cli/-/jinn-cli-${version}.tgz`
  if (!formula.includes(`url "${url}"`)) return false
  if (metadata.dist?.tarball !== url) throw new Error("Unexpected release tarball URL")
  const response = await fetchImpl(`${url}?release-check=${Date.now()}`, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Release tarball HTTP ${response.status}`)
  const checksum = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex")
  return formula.includes(`sha256 "${checksum}"`)
}

async function announcementComplete(release, { channel = undefined, api = undefined }) {
  if (!channel) return true
  const oldest = String(Date.parse(release.published_at) / 1000)
  if (!(Number(oldest) > 0) || !release.html_url) throw new Error("Missing release announcement identity")
  const slack = api ?? slackClient(process.env.SLACK_BOT_TOKEN)
  const auth = await slack("auth.test", {})
  return Boolean(await findAnnouncement({ channel, releaseUrl: release.html_url, oldest, user: auth.user_id }, slack))
}

async function releaseVisibility({ version, tag, tagged }, { git, run, fetchImpl, ...announcementOptions }) {
  const manifest = await jsonResponse(`https://registry.npmjs.org/jinn-cli?release-check=${Date.now()}`, fetchImpl)
  const metadata = manifest.versions?.[version]
  const release = tagged ? await githubRelease(tag, run) : null
  const github = release?.tag_name === tag && release.draft === false
  const npm = metadata?.version === version
  const homebrew = npm && github && await formulaComplete({ version, metadata }, git, fetchImpl)
  const announcement = github && await announcementComplete(release, announcementOptions)
  return { npm, github: Boolean(github), homebrew: Boolean(homebrew), announcement: Boolean(announcement) }
}

async function localMainComplete(sha, git) {
  try { await git("merge-base", "--is-ancestor", sha, "refs/heads/main"); return true }
  catch (error) { if (error.code === 1) return false; throw error }
}

export async function inspectRelease(repo, options = {}) {
  const { git = gitReader(repo), run = gh, fetchImpl = fetch } = options
  const { version } = JSON.parse(await git("show", `origin/main:${PACKAGE}`))
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable release version")
  const tag = `v${version}`
  const { sha, tagged } = await releaseCommit(version, git)
  const baseSha = await validateReleaseCommit({ version, sha }, git)
  const visibility = { ...await releaseVisibility({ version, tag, tagged }, { ...options, git, run, fetchImpl }),
    localMain: await localMainComplete(sha, git) }
  return { decision: tagged && Object.values(visibility).every(Boolean) ? "complete" : "resume",
    version, tag, sha, baseSha, tagged, ...visibility }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await inspectRelease(process.argv[2] ?? process.cwd(), { channel: process.argv[3] }))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

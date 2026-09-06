import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { gitReader, inspectRelease, validateReleaseCommit } from "../inspect-release.mjs"
import { completeRelease } from "../complete-npm-release.mjs"

const version = "1.2.3"
const tarball = "fixture tarball"
const checksum = createHash("sha256").update(tarball).digest("hex")
const url = `https://registry.npmjs.org/jinn-cli/-/jinn-cli-${version}.tgz`

function fixture(t, { tagged = true, extraPath = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-inspection-"))
  const repo = path.join(root, "repo")
  const remote = path.join(root, "origin.git")
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  fs.mkdirSync(path.join(repo, "packages/jinn"), { recursive: true })
  fs.mkdirSync(path.join(repo, "Formula"))
  fs.writeFileSync(path.join(repo, "packages/jinn/package.json"), JSON.stringify({ name: "jinn-cli", version: "1.2.2" }))
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), "Previous release\n")
  fs.writeFileSync(path.join(repo, "Formula/jinn.rb"), `url "${url}"\nsha256 "${checksum}"\n`)
  git("add", ".")
  git("commit", "-m", "initial fixture")
  const baseSha = git("rev-parse", "HEAD")
  git("tag", "v1.2.2")
  fs.writeFileSync(path.join(repo, "packages/jinn/package.json"), JSON.stringify({ name: "jinn-cli", version }))
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), "New release\n")
  if (extraPath) fs.writeFileSync(path.join(repo, "unreviewed.txt"), "must refuse")
  git("add", ".")
  git("commit", "-m", `release: v${version}`)
  const sha = git("rev-parse", "HEAD")
  if (tagged) git("tag", "-a", `v${version}`, "-m", `v${version}`)
  git("clone", "--bare", repo, remote)
  git("remote", "add", "origin", remote)
  git("fetch", "origin")
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { repo, git, sha, baseSha }
}

function services({ github = false, npm = true } = {}) {
  return {
    run: async () => {
      if (!github) throw new Error("gh: Not Found (HTTP 404)")
      return JSON.stringify({ tag_name: `v${version}`, draft: false,
        html_url: `https://example.invalid/releases/v${version}`, published_at: "2026-09-06T00:00:00Z" })
    },
    fetchImpl: async (target) => String(target).includes(".tgz") ? new Response(tarball)
      : new Response(JSON.stringify({ versions: npm ? { [version]: { version, dist: { tarball: url } } } : {} })),
  }
}

test("zero commits since tag still resumes npm published without GitHub Release, then completes that exact version", async (t) => {
  const f = fixture(t)
  assert.equal(f.git("rev-list", "--count", `v${version}..HEAD`), "0")
  const state = await inspectRelease(f.repo, services())
  assert.deepEqual(state, { decision: "resume", version, tag: `v${version}`, sha: f.sha,
    baseSha: f.baseSha, tagged: true, npm: true, github: false, homebrew: false, announcement: false, localMain: true })
  const completed = await completeRelease({ version: state.version, sha: state.sha, title: "Release", notesFile: "notes" }, {
    registryCheck: async (v) => assert.equal(v, version),
    release: async ({ sha, tag }) => { assert.equal(sha, f.sha); return `https://example.invalid/releases/${tag}` },
    checksum: async () => checksum, homebrew: async () => "bumped",
  })
  assert.equal(completed.version, version)
  assert.equal(completed.homebrew, "bumped")
  t.diagnostic(`zero-delta → resume ${state.tag} at ${state.sha} → GitHub Release → Homebrew`)
})

test("release commit pushed without a tag is discovered at its original SHA despite newer main work", async (t) => {
  const f = fixture(t, { tagged: false })
  fs.writeFileSync(path.join(f.repo, "new-work.txt"), "newer work")
  f.git("add", ".")
  f.git("commit", "-m", "fix: later work")
  f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"))
  const state = await inspectRelease(f.repo, services({ npm: false }))
  assert.equal(state.decision, "resume")
  assert.equal(state.sha, f.sha)
  assert.equal(state.tagged, false)
})

test("only verified npm, GitHub, and exact Homebrew checksum count as completed", async (t) => {
  const f = fixture(t)
  assert.equal((await inspectRelease(f.repo, services({ github: true }))).decision, "complete")
  const options = services({ github: true })
  const fetchImpl = options.fetchImpl
  options.fetchImpl = (target) => String(target).includes(".tgz") ? Promise.resolve(new Response("wrong bytes")) : fetchImpl(target)
  assert.equal((await inspectRelease(f.repo, options)).decision, "resume")
})

test("authentication and registry outages cannot masquerade as an empty quiet week", async (t) => {
  const f = fixture(t)
  await assert.rejects(inspectRelease(f.repo, { ...services(), run: async () => { throw new Error("HTTP 401") } }), /401/)
  await assert.rejects(inspectRelease(f.repo, { ...services(), fetchImpl: async () => new Response("down", { status: 503 }) }), /503/)
})

test("a lost announcement is resumed even after npm, GitHub and Homebrew completed", async (t) => {
  const f = fixture(t)
  let announced = false
  const api = async (method) => {
    if (method === "auth.test") return { user_id: "fixture-bot" }
    assert.equal(method, "conversations.history", "survey must never send a message")
    return { messages: announced ? [{ user: "fixture-bot", text: `Done https://example.invalid/releases/v${version}`, ts: "1.2" }] : [] }
  }
  const options = { ...services({ github: true }), channel: "fixture-channel", api }
  assert.equal((await inspectRelease(f.repo, options)).decision, "resume")
  announced = true
  assert.equal((await inspectRelease(f.repo, options)).decision, "complete")
})

test("completed release with newer divergent main work remains eligible for survey consolidation", async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.repo, "local.txt"), "local work")
  f.git("add", ".")
  f.git("commit", "-m", "fix: local work")
  const remoteHead = f.git("commit-tree", f.git("rev-parse", `${f.sha}^{tree}`), "-p", f.sha, "-m", "fix: remote work")
  f.git("update-ref", "refs/remotes/origin/main", remoteHead)
  assert.equal(f.git("rev-list", "--left-right", "--count", "main...origin/main"), "1\t1")
  assert.equal((await inspectRelease(f.repo, services({ github: true }))).decision, "complete")
})

test("an extra code edit in the release commit is a hard conflict", async (t) => {
  const f = fixture(t, { extraPath: true })
  await assert.rejects(validateReleaseCommit({ version, sha: f.sha }, gitReader(f.repo)), /exclusively/)
})

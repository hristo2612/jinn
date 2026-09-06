import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { awaitNpmVersion } from "../await-npm-version.mjs"
import { awaitRun, ensureRelease } from "../release-github.mjs"
import { completeHomebrew, completeRelease, watchHomebrew } from "../complete-npm-release.mjs"
import { announceRelease } from "../announce-release.mjs"

const version = "1.2.3"
const tag = `v${version}`
const sha = "a".repeat(40)
const releaseUrl = `https://github.com/example/project/releases/tag/${tag}`

function clock() {
  let time = 0
  const logs = []
  return { timeoutMs: 7000, initialDelayMs: 1000, maxDelayMs: 4000,
    now: () => time, wait: async (ms) => { time += ms }, log: (line) => logs.push(line), logs }
}

test("registry waits through two stale responses, defeats caching, then accepts exact version despite stale latest", async (t) => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, cache: request.headers["cache-control"] })
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ "dist-tags": { latest: "1.0.0" },
      versions: requests.length < 3 ? {} : { [version]: { version } } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const timing = clock()
  assert.equal((await awaitNpmVersion(version, { ...timing, registry: `http://127.0.0.1:${address.port}` })).version, version)
  assert.equal(requests.length, 3)
  assert.equal(new Set(requests.map((r) => r.url)).size, 3)
  assert.ok(requests.every((r) => r.cache === "no-cache, no-store"))
  assert.equal(timing.now(), 3000)
  t.diagnostic([...timing.logs, `visible ${version} at ${timing.now() / 1000}s; latest still 1.0.0`].join("\n"))
})

test("absent version waits the full window and reports visibility, not publish failure", async (t) => {
  const timing = clock()
  const fetchImpl = async () => new Response(JSON.stringify({ versions: {} }))
  await assert.rejects(awaitNpmVersion(version, { ...timing, fetchImpl }), (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /npm jinn-cli@1.2.3 not yet visible after 7 seconds/)
    assert.doesNotMatch(error.message, /workflow.*failed/)
    t.diagnostic(error.message)
    return true
  })
  assert.equal(timing.now(), 7000)
})

test("registry errors and timeouts are retried, never misreported as proof of absence", async () => {
  const timing = clock()
  await assert.rejects(awaitNpmVersion(version, { ...timing, fetchImpl: async () => { throw new Error("connection reset") } }), /after 7 seconds; last observation: connection reset/)
})

test("run resolution waits for exact tag and commit, ignoring unrelated runs", async (t) => {
  let calls = 0
  const timing = clock()
  const run = async () => JSON.stringify(++calls < 3 ? [{ databaseId: 99, headSha: sha, headBranch: "v9.0.0", event: "push" }]
    : [{ databaseId: 42, headSha: sha, headBranch: tag, event: "push" }])
  assert.equal(await awaitRun({ workflow: "publish-npm.yml", tag, sha, ...timing }, run), 42)
  assert.equal(timing.now(), 3000)
  t.diagnostic(`run absent twice; resolved 42 after ${timing.now() / 1000}s`)
  await assert.rejects(awaitRun({ workflow: "publish-npm.yml", tag, sha, ...clock() }, async () => "[]"), /run.*not yet visible after 7 seconds/)
})

function githubStub(options = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args[0] === "api") return JSON.stringify({ object: { type: "commit", sha: options.sha ?? sha } })
    if (args[1] === "create") throw new Error("a release with the same tag name already exists")
    if (args[1] === "view") return JSON.stringify({ tagName: options.tag ?? tag, isDraft: options.draft ?? false, url: releaseUrl })
    throw new Error(`Unexpected command: ${args.join(" ")}`)
  }
  return { run, calls }
}

test("gh release create hits existing release; exact published tag is success", async (t) => {
  const stub = githubStub()
  assert.equal(await ensureRelease({ tag, sha, title: tag, notesFile: "notes.md" }, stub.run), releaseUrl)
  assert.equal(stub.calls.filter((args) => args[1] === "create").length, 1)
  assert.ok(stub.calls.find((args) => args.includes("--verify-tag")))
  t.diagnostic(`gh release create: already exists -> verified ${tag} at ${sha} -> success ${releaseUrl}`)
})

test("existing release cannot hide mismatched tag, draft, or moved remote tag", async () => {
  for (const options of [{ tag: "v9.0.0" }, { draft: true }, { sha: "b".repeat(40) }]) {
    await assert.rejects(ensureRelease({ tag, sha, title: tag, notesFile: "notes.md" }, githubStub(options).run), /exact tag|expected commit/)
  }
})

test("Homebrew resumes a failed run and verifies formula before success", async () => {
  const commands = []
  let landed = false
  const result = await completeHomebrew({ tag, sha, checksum: "checksum" }, {
    run: async (args) => {
      commands.push(args)
      if (args[0] === "api") return JSON.stringify({ object: { type: "commit", sha } })
      if (args[1] === "view") return JSON.stringify({ status: "completed", conclusion: "failure" })
      return ""
    },
    matches: async () => landed, waitRun: async () => 42, watch: async () => { landed = true },
  })
  assert.equal(result, "bumped")
  assert.ok(commands.some((args) => args[1] === "rerun"))
  await completeHomebrew({ tag, sha, checksum: "checksum" }, { matches: async () => true, run: async () => assert.fail("already complete must not dispatch") })
})

test("missing Homebrew event dispatches at the immutable tag", async () => {
  let landed = false
  const commands = []
  const waits = []
  await completeHomebrew({ tag, sha, checksum: "checksum" }, {
    run: async (args) => { commands.push(args); return JSON.stringify({ object: { type: "commit", sha } }) },
    matches: async () => landed,
    waitRun: async (options) => { waits.push(options.event); if (options.event === "release") throw new Error("not visible"); return 44 },
    watch: async () => { landed = true },
  })
  assert.deepEqual(waits, ["release", "workflow_dispatch"])
  assert.deepEqual(commands.find((args) => args[0] === "workflow"), ["workflow", "run", "bump-formula.yml", "--ref", tag])
})

test("post-publish retry drives forward after interruption; registry absence gates side effects", async () => {
  let releaseCalls = 0
  let homebrewCalls = 0
  const options = {
    registryCheck: async () => ({ version }), checksum: async () => "checksum",
    release: async () => { releaseCalls++; return releaseUrl },
    homebrew: async () => { if (++homebrewCalls === 1) throw new Error("temporary outage"); return "bumped" },
  }
  const input = { version, sha, title: tag, notesFile: "notes.md" }
  await assert.rejects(completeRelease(input, options), /temporary outage/)
  assert.equal((await completeRelease(input, options)).homebrew, "bumped")
  assert.equal(releaseCalls, 2)
  await assert.rejects(completeRelease(input, { ...options, registryCheck: async () => { throw new Error("not yet visible") } }), /not yet visible/)
  assert.equal(releaseCalls, 2)
})

test("announcement resumes without duplicates, including accepted post with lost response", async () => {
  const messages = []
  let posts = 0
  const api = async (method, args) => {
    if (method === "auth.test") return { user_id: "release-bot" }
    if (method === "conversations.history") return { messages }
    assert.equal(method, "chat.postMessage")
    posts++
    messages.push({ user: "release-bot", ts: "123.456", text: args.text })
    throw new Error("response lost after Slack accepted post")
  }
  const input = { channel: "release-channel", oldest: "123", releaseUrl, text: `Released ${releaseUrl}` }
  assert.equal(await announceRelease(input, api, clock()), "123.456")
  assert.equal(await announceRelease(input, api, clock()), "123.456")
  assert.equal(posts, 1)
})

test("announcement for prefix-overlapping version does not suppress exact release", async () => {
  let posts = 0
  const api = async (method) => {
    if (method === "auth.test") return { user_id: "release-bot" }
    if (method === "conversations.history") return { messages: [{ user: "release-bot", ts: "1", text: `<${releaseUrl}0|release>` }] }
    posts++
    return { ts: "2" }
  }
  assert.equal(await announceRelease({ channel: "release-channel", oldest: "123", releaseUrl, text: releaseUrl }, api), "2")
  assert.equal(posts, 1)
})

test("Homebrew repairs formula even when the old run succeeded", async () => {
  let landed = false
  let reruns = 0
  await completeHomebrew({ tag, sha, checksum: "checksum" }, {
    run: async (args) => {
      if (args[0] === "api") return JSON.stringify({ object: { type: "commit", sha } })
      if (args[1] === "view") return JSON.stringify({ status: "completed", conclusion: "success", attempt: 1 })
      if (args[1] === "rerun") reruns++
      return ""
    },
    matches: async () => landed, waitRun: async () => 42,
    watch: async (target) => { assert.equal(target.minimumAttempt, 2); landed = true },
  })
  assert.equal(reruns, 1)
})

test("Homebrew rerun watch waits through stale prior-attempt completion", async () => {
  let reads = 0
  const timing = clock()
  await watchHomebrew({ runId: 42, minimumAttempt: 2 }, async () => JSON.stringify({
    status: "completed", conclusion: "success", attempt: ++reads < 3 ? 1 : 2,
  }), timing)
  assert.equal(timing.now(), 3000)
  assert.equal(reads, 3)
})

#!/usr/bin/env node
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { poll } from "./await-npm-version.mjs"

const exec = promisify(execFile)
export async function gh(args, timeout = 60000) {
  const { stdout } = await exec("gh", args, { timeout, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

export async function awaitRun({ workflow, sha, tag, event = "push", ...options }, run = gh) {
  // Actions run creation is asynchronous after tag push. Three minutes covers
  // normal dispatch lag; an empty listing is never a workflow failure verdict.
  return poll(async (remaining) => {
    const runs = JSON.parse(await run(["run", "list", `--workflow=${workflow}`,
      "--commit", sha, "--event", event, "--limit", "100", "--json",
      "databaseId,headSha,headBranch,event"], Math.min(60000, remaining)))
    return runs.find((item) => item.headSha === sha && item.headBranch === tag && item.event === event)?.databaseId
  }, { timeoutMs: 180000, ...options, label: `${workflow} run for ${tag} (${sha})` })
}

export async function verifyRemoteTag(tag, sha, run = gh) {
  let ref = JSON.parse(await run(["api", `repos/{owner}/{repo}/git/ref/tags/${tag}`]))
  while (ref.object.type === "tag") {
    ref = JSON.parse(await run(["api", `repos/{owner}/{repo}/git/tags/${ref.object.sha}`]))
  }
  if (ref.object.type !== "commit" || ref.object.sha !== sha) {
    throw new Error(`Remote tag ${tag} does not point at expected commit ${sha}`)
  }
}

export async function ensureRelease({ tag, sha, title, notesFile }, run = gh) {
  await verifyRemoteTag(tag, sha, run)
  // Re-read after create even on error: a prior attempt or a concurrent request
  // may already have published it, or the response may have been lost.
  let createError
  try {
    await run(["release", "create", tag, "--verify-tag", "--title", title, "--notes-file", notesFile])
  } catch (error) {
    createError = error
  }
  let release
  try {
    release = JSON.parse(await run(["release", "view", tag, "--json", "tagName,isDraft,url"]))
  } catch (error) {
    throw new Error(`GitHub Release ${tag} still incomplete: ${createError?.message ?? error.message}`)
  }
  if (release.tagName !== tag || release.isDraft) throw new Error(`Release must be published for exact tag ${tag}`)
  await verifyRemoteTag(tag, sha, run)
  return release.url
}

async function main(argv) {
  const [command, tag, sha, ...args] = argv
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Expected exact version tag and full commit SHA")
  }
  if (command === "wait-run") {
    console.log(await awaitRun({ tag, sha, workflow: args[0], event: args[1] ?? "push" }))
  } else if (command === "ensure-release") {
    console.log(await ensureRelease({ tag, sha, title: args[0], notesFile: args[1] }))
  } else throw new Error("Use wait-run or ensure-release")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)) } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

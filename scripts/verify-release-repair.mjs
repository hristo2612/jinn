#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { gitReader } from "./inspect-release.mjs"

const isTest = (file) => /(?:^|\/)(__tests__|test|tests)\/|\.(?:test|spec)\.[^/]+$/.test(file)
const protectedGate = (file) => /baseline|ratchet|flaky|release-sweep|verify-release-repair|(?:vitest|playwright|eslint)[.-]|(?:^|\/)scripts\/|(?:^|\/)(?:package|turbo|tsconfig[^/]*)\.json$|(?:^|\/)\.github\/workflows\//i.test(file)
const suppression = /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|fails|only)\b|\b(?:skipIf|runIf|fixme)\s*\(|@flaky|\b(?:testPathIgnorePatterns|exclude|testIgnore)\s*:/

export async function verifyReleaseRepair(repo, baseSha, repairSha) {
  if (![baseSha, repairSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error("Expected full repair and base SHAs")
  const git = gitReader(repo)
  await git("merge-base", "--is-ancestor", baseSha, repairSha)
  const changes = (await git("diff", "--numstat", "--no-renames", baseSha, repairSha)).split("\n").filter(Boolean)
  if (!changes.length) throw new Error("Repair produced no change")
  for (const change of changes) {
    const [, , file] = change.split("\t")
    // Even additive wrappers can disable existing tests. Automatic repairs add
    // regression files; changing an existing test belongs to independent review.
    const status = await git("diff", "--name-status", "--no-renames", baseSha, repairSha, "--", file)
    const newTest = isTest(file) && status.startsWith("A\t")
    if (protectedGate(file) && !newTest) throw new Error(`Repair changed protected gate policy: ${file}`)
    if (isTest(file) && !status.startsWith("A\t")) throw new Error(`Repair changed existing test content: ${file}`)
    const diff = await git("diff", "--no-ext-diff", "--unified=0", baseSha, repairSha, "--", file)
    const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    if (suppression.test(added.map((line) => line.slice(1)).join("\n"))) throw new Error(`Repair suppressed a gate or test: ${file}`)
  }
  return { baseSha, repairSha, result: "preserved-tests-and-gates" }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [repo, baseSha, repairSha] = process.argv.slice(2, 5)
    console.log(JSON.stringify(await verifyReleaseRepair(repo, baseSha, repairSha)))
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

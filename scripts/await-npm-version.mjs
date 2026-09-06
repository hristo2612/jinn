#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"

// v0.33.1 published successfully but a stale latest read stranded its release.
// Ten minutes doubles the existing Homebrew propagation window while leaving
// room for recovery inside the weekly publish node's 75-minute deadline.
export const REGISTRY_TIMEOUT_MS = 10 * 60 * 1000

const POLL_DEFAULTS = { timeoutMs: REGISTRY_TIMEOUT_MS, initialDelayMs: 1000,
  maxDelayMs: 15000, now: Date.now, wait: sleep, log: console.error, label: "Result" }

export async function poll(check, options = {}) {
  const { timeoutMs, initialDelayMs, maxDelayMs, now, wait, log, label } = { ...POLL_DEFAULTS, ...options }
  if (![timeoutMs, initialDelayMs, maxDelayMs].every((ms) => Number.isFinite(ms) && ms > 0)) {
    throw new Error("Polling durations must be positive")
  }
  const start = now()
  const deadline = start + timeoutMs
  let delay = initialDelayMs
  let last = "not visible"
  while (true) {
    try {
      const result = await check(Math.max(1, deadline - now()))
      if (result) return result
      last = "not visible"
    } catch (error) {
      last = error.message
    }
    const remaining = deadline - now()
    if (remaining <= 0) break
    log(`${label}: ${last}; retrying in ${Math.min(delay, remaining)}ms`)
    await wait(Math.min(delay, remaining))
    delay = Math.min(delay * 2, maxDelayMs)
  }
  throw new Error(`${label} not yet visible after ${(now() - start) / 1000} seconds; last observation: ${last}`)
}

export async function awaitNpmVersion(version, options = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Expected an exact npm version")
  const { registry = "https://registry.npmjs.org", fetchImpl = fetch } = options
  const result = await poll(async (remaining) => {
    const url = new URL("/jinn-cli", registry)
    url.searchParams.set("release-check", randomUUID())
    const response = await fetchImpl(url, {
      headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache", Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(Math.min(30000, remaining)),
    })
    if (!response.ok) throw new Error(`Registry HTTP ${response.status}`)
    const metadata = await response.json()
    return metadata.versions?.[version]?.version === version && metadata.versions[version]
  }, { ...options, label: `npm jinn-cli@${version}` })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const metadata = await awaitNpmVersion(process.argv[2])
    console.log(metadata.version)
  } catch (error) {
    console.error(`${error.message}. Registry visibility is not a publish-workflow verdict; inspect that run separately and resume this exact version.`)
    process.exitCode = 1
  }
}

#!/usr/bin/env node
// Prepares a throwaway sandbox home for a scroll check on a physical device, and
// prints the URL to open there. Momentum and rubber-band are platform fling
// physics: a desktop browser's touch emulation dispatches the events but does not
// run them, so the only way to see the real behaviour is a real phone, and the
// only way a phone reaches a loopback sandbox is a bind it can route to.
//
// Runs between `jinn-sandbox.sh create` and `start`, because the transcript store
// is the home's sqlite registry and the gateway holds it open once it is running.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// The production gateway and the operator's demo instance. A home configured on
// either is not disposable no matter what it is called, and this script rewrites
// the config and inserts rows.
const PROTECTED_PORTS = new Set([7777, 7788])
const PRODUCTION_HOME_NAME = ".jinn"

const SESSION_ID = "device-scroll-check"
const EXCHANGES = 110

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const requireFromJinn = createRequire(path.join(repoRoot, "packages/jinn/package.json"))
const YAML = requireFromJinn("yaml")

// The Node this checkout's native addons are compiled against. Read rather than
// written down so it cannot drift from the version pnpm actually enforces.
const PINNED_NODE = fs.readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim()

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = new Map()
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i], argv[i + 1])
  const home = args.get("--home")
  if (!home) throw new Error("--home <sandbox home> is required, e.g. --home ~/.jinn-qa-flick")
  return { home: path.resolve(home.replace(/^~(?=$|\/)/, os.homedir())) }
}

/**
 * Refuses any home this script must not rewrite. Kept pure and separate from the
 * reads around it so the refusal is testable without a home on disk.
 * @param {string} home
 * @param {{ gateway?: { port?: number } }} config
 */
export function assertDisposableHome(home, config) {
  if (path.basename(home) === PRODUCTION_HOME_NAME) {
    throw new Error(`${home} is the production instance home; pass a throwaway sandbox home instead`)
  }
  const port = config.gateway?.port
  if (typeof port === "number" && PROTECTED_PORTS.has(port)) {
    throw new Error(`${home} is configured on port ${port}, which is a protected gateway; refusing to touch it`)
  }
}

/**
 * Every IPv4 address a phone on the same network could route to, most-likely
 * first. Tailscale's 100.64/10 range is listed ahead of the LAN because it works
 * from anywhere the tailnet reaches, not only from the same Wi-Fi.
 * @param {Record<string, Array<{ address: string, family: string, internal: boolean }> | undefined>} interfaces
 */
export function reachableAddresses(interfaces) {
  const found = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue
      found.push(entry.address)
    }
  }
  return found.sort((a, b) => reachRank(a) - reachRank(b))
}

/**
 * Tailnet, then LAN, then everything else. The third rank has to be its own: give
 * a public address the same rank as the LAN and the two tie, which leaves the
 * order of `os.networkInterfaces()` deciding which URL the operator is handed.
 * @param {string} address
 */
function reachRank(address) {
  if (isTailnetAddress(address)) return 0
  return isPrivateAddress(address) ? 1 : 2
}

/**
 * Tailscale allocates out of 100.64/10 — second octet 64 through 127. The rest of
 * 100/8 is ordinary public space (100.20.5.6 is AWS), and offering one of those as
 * the address to open on the phone sends the operator somewhere else entirely.
 * @param {string} address
 */
function isTailnetAddress(address) {
  const [first, second] = address.split(".").map(Number)
  return first === 100 && second >= 64 && second <= 127
}

/**
 * The RFC 1918 ranges — what a phone on the same Wi-Fi actually reaches.
 * @param {string} address
 */
function isPrivateAddress(address) {
  const [first, second] = address.split(".").map(Number)
  if (first === 10) return true
  if (first === 172) return second >= 16 && second <= 31
  return first === 192 && second === 168
}

/** A transcript long enough that a flick has somewhere to coast. */
function transcriptRows(startedAt) {
  const rows = []
  for (let i = 0; i < EXCHANGES; i += 1) {
    const at = startedAt + i * 60_000
    rows.push({ role: "user", content: `Message ${i + 1}: what does the scroller do here?`, timestamp: at })
    rows.push({
      role: "assistant",
      timestamp: at + 1_000,
      content:
        `Reply ${i + 1}. Generic filler so the transcript is taller than any phone viewport and a flick ` +
        "has room to run. Nothing here is real content; it exists only to give the scroller a length.\n\n" +
        "It carries a second paragraph so row heights vary the way a real thread's do, which is what " +
        "makes the coast and the rubber-band at each end worth looking at.",
    })
  }
  return rows
}

/** @param {import("better-sqlite3").Database} db */
function seedTranscript(db) {
  const startedAt = Date.now() - EXCHANGES * 60_000
  const iso = new Date(startedAt).toISOString()
  db.prepare(`
    INSERT OR REPLACE INTO sessions (
      id, engine, source, source_ref, connector, session_key, model,
      title, prompt_excerpt, effort_level, status, created_at, last_activity
    ) VALUES (?, 'codex', 'web', ?, 'web', ?, 'gpt-5.5',
      'Device scroll check', 'A transcript long enough to flick', 'low', 'idle', ?, ?)
  `).run(SESSION_ID, `sandbox:${SESSION_ID}`, `sandbox:${SESSION_ID}`, iso, new Date().toISOString())

  db.prepare("DELETE FROM messages WHERE session_id = ?").run(SESSION_ID)
  // Timestamps are strictly increasing, which is the order the transcript reads
  // in, so `seq` adds nothing here — the sandbox seeder omits it for the same reason.
  const insert = db.prepare(
    "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
  )
  const rows = transcriptRows(startedAt)
  db.transaction(() => {
    rows.forEach((row, index) => {
      insert.run(`${SESSION_ID}-${index}`, SESSION_ID, row.role, row.content, row.timestamp)
    })
  })()
  return rows.length
}

/** @param {string} home @param {number} port @param {number} seeded */
function report(home, port, seeded) {
  const addresses = reachableAddresses(os.networkInterfaces())
  const instance = path.basename(home).replace(/^\./, "")
  console.log(`Seeded ${seeded} messages into session "${SESSION_ID}".`)
  console.log("Bind opened to 0.0.0.0 — start the sandbox, then open this on the phone:\n")
  if (addresses.length === 0) {
    console.log("  (no non-loopback IPv4 address found — join Wi-Fi or bring up Tailscale, then re-run)")
  }
  for (const address of addresses) console.log(`  http://${address}:${port}/?session=${SESSION_ID}`)
  console.log("\nA non-loopback bind always requires auth. Pair the phone with the code from:")
  console.log(`  jinn -i ${instance} pair`)
}

/**
 * better-sqlite3 loads its native addon at `new Database(...)` rather than at
 * require, so running under a Node with a different ABI fails here — with a
 * message about module versions that says nothing about how to get it right.
 * @param {any} error
 */
function isNativeAbiMismatch(error) {
  return error?.code === "ERR_DLOPEN_FAILED" || String(error?.message ?? error).includes("NODE_MODULE_VERSION")
}

/**
 * @param {(file: string) => import("better-sqlite3").Database} openDatabase
 * @param {string} file
 */
function openTranscriptStore(openDatabase, file) {
  try {
    return openDatabase(file)
  } catch (error) {
    if (!isNativeAbiMismatch(error)) throw error
    throw new Error(
      `better-sqlite3 in this checkout is built for Node ${PINNED_NODE}, and ${process.version} is running it. ` +
        "Run it under the pinned Node instead: " +
        "pnpm exec node scripts/device-scroll-fixture.mjs --home <sandbox home>",
      { cause: error },
    )
  }
}

/**
 * Reads the sandbox's config, refuses a home this script must not rewrite, and only
 * then rewrites the config and seeds the transcript. The store opens before the
 * write so a native-load failure leaves the home exactly as it was found: an
 * aborted run must not leave a sandbox bound to the network with an empty thread.
 * @param {string} home
 * @param {(file: string) => import("better-sqlite3").Database} openDatabase
 */
export function prepareSandbox(home, openDatabase) {
  const configPath = path.join(home, "config.yaml")
  if (!fs.existsSync(configPath)) throw new Error(`${configPath} does not exist; create the sandbox first`)

  const config = YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}
  assertDisposableHome(home, config)

  const db = openTranscriptStore(openDatabase, path.join(home, "sessions", "registry.db"))
  try {
    config.gateway = { ...(config.gateway ?? {}), host: "0.0.0.0" }
    // The first-run wizard is lazily imported, so it lands an extra commit inside
    // the window this check is looking at. Skip it.
    config.portal = { ...(config.portal ?? {}), onboarded: true, setupComplete: true }
    fs.writeFileSync(configPath, YAML.stringify(config))
    return { seeded: seedTranscript(db), port: config.gateway.port }
  } finally {
    db.close()
  }
}

function main() {
  const { home } = parseArgs(process.argv)
  const Database = requireFromJinn("better-sqlite3")
  const { seeded, port } = prepareSandbox(home, (file) => new Database(file))
  report(home, port, seeded)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()

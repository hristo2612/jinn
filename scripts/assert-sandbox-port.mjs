#!/usr/bin/env node
// Refuses a sandbox whose config.yaml binds a gateway the operator owns.
//
// The port that matters is the CONFIGURED one: the start/stop lifecycle kills whatever
// owns the port in the file, so `-p` on the command line does not make a file safe. This
// runs as its own executable rather than inline in the caller so the refusal can be aimed
// at any config and watched to fail — a guard buried in a script that always writes a safe
// port first is one nobody can prove still works.

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const YAML = createRequire(path.join(repoRoot, "packages/jinn/package.json"))("yaml")

// The default instance and the demo instance beside it, mirroring PRODUCTION_GATEWAY_PORTS
// in packages/jinn/src/shared/sandbox-env.ts.
const PROTECTED_PORTS = new Set([7777, 7788])
const LOWEST_SANDBOX_PORT = 8060

/** @param {string} configPath @param {number} expectedPort */
export function assertSandboxPort(configPath, expectedPort) {
  if (!fs.existsSync(configPath)) throw new Error(`${configPath} does not exist; create the sandbox first`)
  const port = YAML.parse(fs.readFileSync(configPath, "utf8"))?.gateway?.port
  if (PROTECTED_PORTS.has(port)) {
    throw new Error(
      `${configPath} declares gateway.port ${port}, which a live gateway owns — 7777 is the production ` +
        "instance and 7788 the operator's demo instance, and the lifecycle kills whatever owns the " +
        `configured port.\nFix: set gateway.port in ${configPath} to a free port at or above ` +
        `${LOWEST_SANDBOX_PORT}, or re-run with JINN_VERIFY_PORT set to one.`,
    )
  }
  if (port !== expectedPort) {
    throw new Error(
      `${configPath} declares gateway.port ${port ?? "<none>"}, expected ${expectedPort}.\n` +
        `Fix: set gateway.port in ${configPath} to ${expectedPort}, which is the port this run reserved.`,
    )
  }
  return port
}

function main() {
  const [configPath, expected] = process.argv.slice(2)
  if (!configPath || !expected) {
    console.error("usage: assert-sandbox-port.mjs <config.yaml> <expected port>")
    process.exit(2)
  }
  try {
    console.log(`${configPath} declares gateway port ${assertSandboxPort(configPath, Number(expected))}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()

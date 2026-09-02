#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const phase = args.get("--phase")

function required(name) {
  const value = args.get(name)
  if (!value) throw new Error(`${name} is required`)
  return path.resolve(value)
}

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, mode ? { mode } : undefined)
}

if (phase === "codex-home") {
  const target = required("--target")
  const sourceAuth = required("--source-auth")
  if (!fs.existsSync(sourceAuth)) throw new Error("Codex auth source does not exist; pass --source-auth explicitly")
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  const authLink = path.join(target, "auth.json")
  fs.rmSync(authLink, { force: true })
  fs.symlinkSync(sourceAuth, authLink)
  write(path.join(target, "config.toml"), "approval_policy = \"never\"\n", 0o600)
  process.exit(0)
}

if (phase !== "jinn-home") throw new Error("--phase must be codex-home or jinn-home")
const home = required("--home")
const port = Number(args.get("--port"))
const artifacts = required("--artifacts")
if (!Number.isInteger(port) || port < 8060) throw new Error("sandbox port must be 8060 or higher")
if (!fs.existsSync(path.join(home, "config.yaml"))) throw new Error("sandbox setup must run before jinn-home bootstrap")
if (!artifacts.startsWith(`${home}${path.sep}`)) throw new Error("artifacts must remain inside the sandbox home")

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const requireFromJinn = createRequire(path.join(repo, "packages/jinn/package.json"))
const YAML = requireFromJinn("yaml")
const Database = requireFromJinn("better-sqlite3")
const configPath = path.join(home, "config.yaml")
const config = YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}
config.gateway = { ...(config.gateway ?? {}), host: "127.0.0.1", port }
config.engines = {
  default: "codex",
  // Required by the gateway config contract even when Codex is the only
  // engine exercised by this isolated fixture.
  claude: {},
  codex: { bin: "codex", model: "gpt-5.5", effortLevel: "low" },
}
config.models = {
  codex: {
    default: "gpt-5.5", effortMechanism: "codex-config",
    models: [{ id: "gpt-5.5", label: "GPT-5.5", supportsEffort: true, effortLevels: ["low"] }],
  },
}
config.connectors = {}
config.mcp = { gateway: { enabled: true } }
config.sessions = { maxDurationMinutes: 10, maxCostUsd: 2 }
config.portal = { portalName: "Sandbox Operations", operatorName: "Operator", language: "English", onboarded: true, setupComplete: true }
config.logging = { file: true, stdout: true, level: "info" }
write(configPath, YAML.stringify(config))

const instructions = `# Workflow layout verification sandbox\n\nThis is a disposable, generic verification instance. Use only the current gateway URL supplied by the platform. Never inspect or edit repository code, access another Jinn home, use external connectors, or contact another loopback service. Workflow author sessions may use only the built-in Jinn workflow tools and must not start runs unless their prompt explicitly requires it.\n`
write(path.join(home, "AGENTS.md"), instructions)
write(path.join(home, "CLAUDE.md"), instructions)

const employees = [
  ...Array.from({ length: 5 }, (_, i) => `layout-author-${i + 1}`),
  "run-worker-a", "run-worker-b",
]
for (const name of employees) {
  const display = name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ")
  write(path.join(home, "org", "verification", `${name}.yaml`), YAML.stringify({
    name, displayName: display, department: "verification",
    // The first author doubles as the disposable approval root.
    rank: name === "layout-author-1" ? "manager" : "employee",
    engine: "codex", model: "gpt-5.5", effortLevel: "low",
    persona: "You are a disposable generic sandbox verifier. Use only built-in Jinn tools on the current sandbox gateway. Do not inspect files, edit code, use external systems, or contact another gateway.",
  }))
}
fs.mkdirSync(artifacts, { recursive: true })
write(path.join(artifacts, "environment.json"), `${JSON.stringify({ port, baseUrl: `http://127.0.0.1:${port}`, homeKind: "throwaway", connectors: [] }, null, 2)}\n`)

// Authorized approval must be independently testable even when the expensive
// author probes are disabled or externally rate-limited. Seed one ordinary idle
// manager conversation before gateway start, then derive the same capability-bound
// principal headers the product uses. The record and its public id remain wholly
// inside this throwaway home/artifact root.
const managerSessionId = "workflow-layout-approval-manager"
const managerSourceRef = `sandbox:${managerSessionId}`
const now = new Date().toISOString()
const db = new Database(path.join(home, "sessions", "registry.db"))
db.prepare(`
  INSERT OR IGNORE INTO sessions (
    id, engine, source, source_ref, connector, session_key, employee, model,
    title, prompt_excerpt, effort_level, status, created_at, last_activity
  ) VALUES (?, 'codex', 'web', ?, 'web', ?, 'layout-author-1', 'gpt-5.5',
    'Approval verifier', 'Capability-bound approval verification', 'low', 'idle', ?, ?)
`).run(managerSessionId, managerSourceRef, managerSourceRef, now, now)
db.close()
write(
  path.join(artifacts, "approval/manager-session.json"),
  `${JSON.stringify({ sessionId: managerSessionId, employee: "layout-author-1" }, null, 2)}\n`,
)

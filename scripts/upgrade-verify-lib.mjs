import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { signalGatewayGroup, stopGatewayGroup } from "./upgrade-verify-process-group.mjs"

export const NONCE_FILE = ".jinn-upgrade-verify-nonce"
export const PROTECTED_PORTS = new Set([7777, 7801])
const STRICT_VERSION = /^\d+\.\d+\.\d+$/
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "spawn"})${detail ? `\n${detail}` : ""}`)
  }
  return result.stdout.trim()
}

export function createDisposableRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-upgrade-verify-"))
  fs.writeFileSync(path.join(root, NONCE_FILE), `${crypto.randomUUID()}\n`, { mode: 0o600 })
  return fs.realpathSync(root)
}

export async function removeDisposableRoot(root) {
  const resolved = fs.realpathSync(root)
  const marker = path.join(resolved, NONCE_FILE)
  if (!fs.existsSync(marker) || !fs.lstatSync(marker).isFile()) throw new Error(`refusing cleanup without ${NONCE_FILE}: ${resolved}`)
  const nonce = fs.readFileSync(marker)
  // Engine CLI writers can outlive the gateway. Keep the ownership proof out of
  // recursive removal so an exhausted retry still leaves a cleanable root.
  for (let attempt = 0; ; attempt++) {
    for (const name of fs.readdirSync(resolved).filter((name) => name !== NONCE_FILE)) {
      await fs.promises.rm(path.join(resolved, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    fs.unlinkSync(marker)
    try {
      await fs.promises.rmdir(resolved)
      return
    } catch (error) {
      fs.writeFileSync(marker, nonce, { mode: 0o600, flag: "wx" })
      if (error.code !== "ENOTEMPTY" || attempt >= 5) throw error
      await sleep((attempt + 1) * 100)
    }
  }
}

export function deriveScenarioPort(root, scenario) {
  const nonce = fs.readFileSync(path.join(root, NONCE_FILE))
  const seed = crypto.createHash("sha256").update(nonce).update("\0").update(scenario).digest()
  const port = 20_000 + (seed.readUInt32BE(0) % 20_000)
  if (PROTECTED_PORTS.has(port)) throw new Error(`derived protected port ${port}`)
  return port
}

export async function assertPortAvailable(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || PROTECTED_PORTS.has(port)) {
    throw new Error(`refusing unsafe upgrade-verifier port ${port}`)
  }
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`upgrade-verifier port ${port} is unavailable: ${error.message}`)))
    server.listen(port, "127.0.0.1", () => resolve())
  })
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

export function buildEnvironment(root, scenario, port) {
  const scenarioRoot = path.join(root, scenario)
  const home = path.join(scenarioRoot, "home", ".jinn-verify")
  const osHome = path.join(scenarioRoot, "home")
  const prefix = path.join(scenarioRoot, "prefix")
  for (const dir of [home, prefix, path.join(scenarioRoot, "cache"), path.join(scenarioRoot, "logs")]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: osHome,
    JINN_HOME: home,
    JINN_INSTANCE: `upgrade-verify-${scenario}`,
    JINN_INSTANCES_REGISTRY: path.join(scenarioRoot, "instances.json"),
    JINN_REGISTRY_PATH: path.join(scenarioRoot, "instances.json"),
    JINN_LOG_DIR: path.join(scenarioRoot, "logs"),
    JINN_ATTACHMENTS_DIR: path.join(scenarioRoot, "attachments"),
    XDG_CONFIG_HOME: path.join(scenarioRoot, "xdg", "config"),
    XDG_CACHE_HOME: path.join(scenarioRoot, "xdg", "cache"),
    XDG_DATA_HOME: path.join(scenarioRoot, "xdg", "data"),
    npm_config_prefix: prefix,
    npm_config_cache: path.join(scenarioRoot, "cache"),
    npm_config_ignore_scripts: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    JINN_NO_OPEN: "1",
    JINN_PORT: String(port),
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }
  return { scenarioRoot, home, prefix, env }
}

export function latestPublishedTarball(root, env) {
  const version = run("npm", ["view", "jinn-cli", "version"], { env })
  if (!STRICT_VERSION.test(version)) throw new Error(`npm did not report a plain published latest version: ${version}`)
  const destination = path.join(root, "published")
  fs.mkdirSync(destination)
  run("npm", ["pack", `jinn-cli@${version}`, "--pack-destination", destination], { env })
  const tarball = path.join(destination, `jinn-cli-${version}.tgz`)
  if (!fs.existsSync(tarball)) throw new Error(`npm did not produce the published latest tarball for ${version}`)
  return { version, tarball }
}

export function installTarball(tarball, prefix, env) {
  fs.mkdirSync(prefix, { recursive: true })
  // The v0.33.0 gate skipped node-pty's Linux source build. Exercise every
  // dependency's normal lifecycle instead of maintaining a native rebuild list.
  run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts=false", "--no-audit", "--no-fund", tarball], {
    env: { ...env, npm_config_prefix: prefix },
  })
  const packageRoot = path.join(prefix, "lib", "node_modules", "jinn-cli")
  const cli = path.join(packageRoot, "dist", "bin", "jinn.js")
  if (!fs.existsSync(cli)) throw new Error(`installed package has no CLI: ${cli}`)
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version
  if (!STRICT_VERSION.test(version)) throw new Error(`installed package has an invalid version: ${String(version)}`)
  return { packageRoot, cli, version }
}

export function listSkillNames(packageRoot) {
  const root = path.join(packageRoot, "template", "skills")
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

export function listFiles(root) {
  if (!fs.existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else found.push(path.relative(root, absolute))
    }
  }
  visit(root)
  return found
}

function expectedTemplateBytes(file, portalName) {
  const bytes = fs.readFileSync(file)
  if (!new Set([".md", ".yaml", ".yml"]).has(path.extname(file).toLowerCase())) return bytes
  return Buffer.from(bytes.toString("utf8")
    .replaceAll("{{portalName}}", portalName)
    .replaceAll("{{portalSlug}}", portalName.toLowerCase().replace(/\s+/g, "-")))
}

function instancePortalName(home) {
  const config = path.join(home, "config.yaml")
  if (!fs.existsSync(config)) return "Jinn"
  const match = /^\s+portalName:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fs.readFileSync(config, "utf8"))
  return match?.[1] ?? "Jinn"
}

export function assertShippedSkillsConverged(home, candidateRoot, candidateSkills) {
  const portalName = instancePortalName(home)
  for (const name of candidateSkills) {
    const templateDir = path.join(candidateRoot, "template", "skills", name)
    const installedDir = path.join(home, "skills", name)
    const expectedFiles = listFiles(templateDir)
    const actualFiles = listFiles(installedDir)
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`shipped skill ${name} did not converge: expected [${expectedFiles}], found [${actualFiles}]`)
    }
    for (const relative of expectedFiles) {
      const expected = expectedTemplateBytes(path.join(templateDir, relative), portalName)
      const actual = fs.readFileSync(path.join(installedDir, relative))
      if (!actual.equals(expected)) throw new Error(`shipped skill ${name}/${relative} was not rewritten to candidate bytes`)
    }
  }
}

export function hashUpgradeSurface(home) {
  const result = {}
  for (const relative of ["skills", ".jinn-template-skills.json", "config.yaml", ".migration-backups"]) {
    const absolute = path.join(home, relative)
    if (!fs.existsSync(absolute)) continue
    if (fs.statSync(absolute).isDirectory()) {
      for (const file of listFiles(absolute)) result[`${relative}/${file}`] = sha256(fs.readFileSync(path.join(absolute, file)))
    } else result[relative] = sha256(fs.readFileSync(absolute))
  }
  return result
}

function executableIsMissing(error) {
  return Boolean(error && "code" in error && error.code === "ENOENT")
}

function listeningPid(port) {
  const commands = process.platform === "darwin" ? ["/usr/sbin/lsof", "lsof"] : ["lsof"]
  for (const command of commands) {
    const result = spawnSync(command, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
    if (executableIsMissing(result.error)) continue
    if (result.status === 1 && !result.stdout.trim()) return null
    if (result.error || result.status !== 0) throw new Error(`could not inspect upgrade-verifier port ${port}`)
    const pids = [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))]
    if (pids.length !== 1) throw new Error(`upgrade-verifier port ${port} has ${pids.length} listening owners`)
    return pids[0]
  }
  throw new Error("lsof is required to verify upgrade-verifier process ownership")
}

async function gatewayIsReady(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/status`)).ok
  } catch {
    return false
  }
}

async function waitForGateway(handle, label) {
  let exited = null
  handle.child.once("exit", (code, signal) => { exited = { code, signal } })
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (exited) throw new Error(`${label} gateway exited before readiness: ${JSON.stringify(exited)}\n${fs.readFileSync(handle.logPath, "utf8")}`)
    if (await gatewayIsReady(handle.port)) {
      const owner = listeningPid(handle.port)
      if (owner !== handle.child.pid) throw new Error(`refusing foreign listener on port ${handle.port}: expected PID ${handle.child.pid}, found ${owner}`)
      return
    }
    await sleep(100)
  }
  throw new Error(`${label} gateway did not become ready on port ${handle.port}\n${fs.readFileSync(handle.logPath, "utf8")}`)
}

export async function startGateway(cli, layout, port, label) {
  await assertPortAvailable(port)
  const logPath = path.join(layout.scenarioRoot, "logs", `${label}.log`)
  const log = fs.openSync(logPath, "a")
  const child = spawn(process.execPath, [cli, "start", "--port", String(port)], {
    cwd: layout.env.HOME,
    env: layout.env,
    stdio: ["ignore", log, log],
    detached: process.platform !== "win32",
  })
  const handle = { child, log, logPath, port, processGroup: process.platform !== "win32" }
  try {
    await waitForGateway(handle, label)
    return handle
  } catch (error) {
    await stopGateway(handle)
    throw error
  }
}

export async function stopGateway(handle) {
  if (!handle) return
  const exited = () => handle.child.exitCode !== null || handle.child.signalCode !== null
  const wait = async (milliseconds) => {
    const deadline = Date.now() + milliseconds
    while (!exited() && Date.now() < deadline) await sleep(50)
  }
  if (!exited()) {
    if (handle.processGroup) signalGatewayGroup(handle, "SIGTERM")
    else handle.child.kill("SIGTERM")
    await wait(5_000)
  }
  if (!exited()) {
    handle.child.kill("SIGKILL")
    await wait(5_000)
  }
  if (!exited()) throw new Error(`upgrade-verifier PID ${handle.child.pid} survived SIGKILL`)
  if (handle.processGroup) await stopGatewayGroup(handle)
  fs.closeSync(handle.log)
}

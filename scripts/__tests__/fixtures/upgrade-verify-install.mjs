// Local package fixtures exercise the CLI's real assertions and exit handling
// without npm/network dependencies. Gateway shutdown is tested with a real child
// in upgrade-verify-cleanup.test.mjs.
import fs from "node:fs"
import path from "node:path"
export * from "../../upgrade-verify-lib.mjs"

export function latestPublishedTarball() {
  return { version: "1.0.0", tarball: "baseline.tgz" }
}

export function installTarball(_tarball, prefix) {
  const version = prefix.endsWith("baseline") ? "1.0.0" : "1.0.1"
  const template = path.join(prefix, "template", "skills", "example")
  fs.mkdirSync(template, { recursive: true })
  fs.writeFileSync(path.join(template, "SKILL.md"), "# Example\n")
  return { packageRoot: prefix, cli: prefix, version }
}

export function run(_command, _args, { env }) {
  const home = env.JINN_HOME
  fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 4321\njinn:\n  version: 1.0.0\n")
  fs.mkdirSync(path.join(home, "skills", "example"), { recursive: true })
  fs.writeFileSync(path.join(home, "skills", "example", "SKILL.md"), "# Example\n")
}

export function startGateway(cli, layout, _port, label) {
  if (process.env.UPGRADE_TEST_ASSERTION_FAILURE === "baseline" && label === "published-latest") {
    throw new Error("published-latest gateway exited before readiness: missing native binding")
  }
  if (process.env.UPGRADE_TEST_ASSERTION_FAILURE && label === "candidate-first-boot") {
    throw new Error("injected upgrade assertion failure")
  }
  if (!cli.endsWith("candidate") || label !== "candidate-first-boot") return
  const home = layout.home
  const backup = path.join(home, ".migration-backups", "1.0.1-2026-01-01T00-00-01-000Z")
  fs.mkdirSync(backup, { recursive: true })
  fs.copyFileSync(path.join(home, "config.yaml"), path.join(backup, "config.yaml"))
  fs.cpSync(path.join(home, "skills"), path.join(backup, "skills"), { recursive: true })
  fs.writeFileSync(path.join(home, "skills", "example", "SKILL.md"), "# Example\n")
  fs.writeFileSync(path.join(home, ".jinn-template-skills.json"), JSON.stringify({ version: "1.0.1", skills: ["example"] }))
  const config = path.join(home, "config.yaml")
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(/  version:.*/, "  version: 1.0.1"))
}

export function stopGateway() {}

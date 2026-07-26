import { execFileSync, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const generator = path.resolve("scripts/instance-migration-bundle.mjs")
const roots: string[] = []

function write(root: string, relative: string, contents: string | Buffer): void {
  const file = path.join(root, "packages/jinn/template", relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-bundle-"))
  roots.push(root)
  git(root, "init", "-q")
  git(root, "config", "user.name", "Test Operator")
  git(root, "config", "user.email", "test@example.invalid")
  // A throwaway fixture must not inherit the developer's line-ending config.
  // With core.autocrlf=true (the Git for Windows default) git prints "LF will be
  // replaced by CRLF" advisories to stderr, and one case below asserts stderr is
  // empty — so the suite failed on Windows for a property it never meant to test.
  git(root, "config", "core.autocrlf", "false")
  git(root, "config", "core.eol", "lf")
  write(root, "CLAUDE.md", "base doctrine\n")
  write(root, "skills/old/SKILL.md", "renamed body\n")
  write(root, "removed.txt", "remove me\n")
  write(root, "unchanged.txt", "same\n")
  write(root, "binary.bin", Buffer.from([0, 1, 2, 255]))
  write(root, "migrations/0.25.0/ignored.txt", "ignore migration output\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "v0.25 fixture")
  git(root, "tag", "v0.25.0")

  fs.writeFileSync(
    path.join(root, "packages/jinn/package.json"),
    JSON.stringify({ name: "jinn-cli", version: "0.26.0" }, null, 2) + "\n",
  )

  write(root, "CLAUDE.md", "target doctrine\n")
  fs.renameSync(
    path.join(root, "packages/jinn/template/skills/old"),
    path.join(root, "packages/jinn/template/skills/new"),
  )
  fs.rmSync(path.join(root, "packages/jinn/template/removed.txt"))
  write(root, "added.txt", "new file\n")
  write(root, "binary.bin", Buffer.from([0, 4, 2, 255]))
  write(root, "migrations/0.26.0/ignored.txt", "must not recurse\n")
  return root
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: root,
    encoding: "utf8",
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("instance migration bundle generator", () => {
  it("accepts the pnpm argument separator", () => {
    const root = fixture()
    expect(run(root, "generate", "--", "--base-ref", "v0.25.0", "--version", "0.26.0").status).toBe(0)
  })

  it("writes a deterministic, complete manifest and payload set", () => {
    const root = fixture()
    const args = ["generate", "--base-ref", "v0.25.0", "--version", "0.26.0"]
    expect(run(root, ...args).status).toBe(0)
    const out = path.join(root, "packages/jinn/template/migrations/0.26.0")
    const first = fs.readFileSync(path.join(out, "manifest.json"))
    const firstPrompt = fs.readFileSync(path.join(out, "MIGRATION.md"))
    expect(run(root, ...args).status).toBe(0)
    expect(fs.readFileSync(path.join(out, "manifest.json"))).toEqual(first)
    expect(fs.readFileSync(path.join(out, "MIGRATION.md"))).toEqual(firstPrompt)

    const manifest = JSON.parse(first.toString("utf8"))
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: "0.26.0",
      baseVersion: "0.25.0",
      generatedFrom: { baseRef: "v0.25.0", headRef: "WORKTREE" },
    })
    expect(manifest.files.map((entry: { path: string }) => entry.path)).toEqual([
      "CLAUDE.md",
      "added.txt",
      "binary.bin",
      "removed.txt",
      "skills/new/SKILL.md",
      "skills/old/SKILL.md",
    ])
    expect(manifest.files.map((entry: { operation: string }) => entry.operation)).toEqual([
      "modify", "add", "modify", "remove", "add", "remove",
    ])
    for (const entry of manifest.files) {
      expect(entry.path).not.toContain("\\")
      expect(entry.path).not.toContain("..")
      for (const side of ["base", "target"] as const) {
        const payload = entry[`${side}Payload`]
        const hash = entry[`${side}Sha256`]
        if (payload === null) expect(hash).toBeNull()
        else {
          const bytes = fs.readFileSync(path.join(out, payload))
          expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(hash)
        }
      }
    }
    const prompt = firstPrompt.toString("utf8")
    expect(prompt.match(/^## `.+`$/gm)).toHaveLength(manifest.files.length)
    expect(prompt).toMatch(/materialized base payload.*materialized target payload/is)
    expect(prompt).toMatch(/never.*raw.*placeholder/is)
  })

  it("checks committed output and detects drift", () => {
    const root = fixture()
    const args = ["--base-ref", "v0.25.0", "--version", "0.26.0"]
    expect(run(root, "generate", ...args).status).toBe(0)
    expect(run(root, "check", ...args).status).toBe(0)
    fs.appendFileSync(path.join(root, "packages/jinn/template/migrations/0.26.0/MIGRATION.md"), "drift\n")
    const checked = run(root, "check", ...args)
    expect(checked.status).toBe(1)
    expect(checked.stderr).toContain("out of date")
  })

  it("keeps the default rationale idempotent after the bundle is committed", () => {
    const root = fixture()
    const args = ["--base-ref", "v0.25.0", "--version", "0.26.0"]
    expect(run(root, "generate", ...args).status).toBe(0)
    git(root, "add", "packages/jinn/template/migrations/0.26.0")
    git(root, "commit", "-qm", "commit migration bundle")

    const checked = run(root, "check", ...args)

    expect(checked.status).toBe(0)
    expect(checked.stderr).toBe("")
  })

  it("preserves reviewed rationale but rejects unresolved release placeholders", () => {
    const root = fixture()
    const args = ["generate", "--base-ref", "v0.25.0", "--version", "0.26.0"]
    expect(run(root, ...args).status).toBe(0)
    const migration = path.join(root, "packages/jinn/template/migrations/0.26.0/MIGRATION.md")
    const reviewed = fs.readFileSync(migration, "utf8").replace(
      "This release bundle was generated from the exact instance-template delta.",
      "Reviewed Todo rationale for this release.",
    )
    fs.writeFileSync(migration, reviewed)
    expect(run(root, ...args).status).toBe(0)
    expect(fs.readFileSync(migration, "utf8")).toContain("Reviewed Todo rationale for this release.")

    fs.writeFileSync(migration, fs.readFileSync(migration, "utf8").replace(
      "Reviewed Todo rationale for this release.",
      "TODO: explain this bundle.",
    ))
    const unresolved = run(root, ...args)
    expect(unresolved.status).toBe(1)
    expect(unresolved.stderr).toMatch(/unresolved release placeholder/i)
  })

  it("rejects empty bundles, unsafe symlinks, and version mismatch", () => {
    const root = fixture()
    git(root, "reset", "--hard", "v0.25.0")
    git(root, "clean", "-fdq")
    fs.writeFileSync(
      path.join(root, "packages/jinn/package.json"),
      JSON.stringify({ name: "jinn-cli", version: "0.26.0" }, null, 2) + "\n",
    )
    expect(run(root, "generate", "--base-ref", "v0.25.0", "--version", "0.26.0").status).toBe(1)
    expect(run(root, "generate", "--base-ref", "v0.25.0", "--version", "0.26.0", "--allow-empty").status).toBe(0)

    write(root, "escape", "placeholder")
    fs.rmSync(path.join(root, "packages/jinn/template/escape"))
    fs.symlinkSync(os.tmpdir(), path.join(root, "packages/jinn/template/escape"))
    expect(run(root, "generate", "--base-ref", "v0.25.0", "--version", "0.26.0", "--allow-empty").status).toBe(1)
    expect(run(root, "generate", "--base-ref", "v0.25.0", "--version", "0.25.1", "--allow-empty").status).toBe(1)
  })

  it("fails closed for changed internal and external target symlinks", () => {
    for (const target of ["CLAUDE.md", os.tmpdir()]) {
      const root = fixture()
      const link = path.join(root, "packages/jinn/template/changed-link")
      fs.symlinkSync(target, link)

      const result = run(root, "generate", "--base-ref", "v0.25.0", "--version", "0.26.0")

      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/changed template symlink.*changed-link.*unsupported/i)
    }
  })

  it("fails closed when a changed base path was a symlink", () => {
    const root = fixture()
    const link = path.join(root, "packages/jinn/template/base-link")
    fs.symlinkSync("CLAUDE.md", link)
    git(root, "add", "packages/jinn/template/base-link")
    git(root, "commit", "--amend", "-qm", "v0.25 fixture with link")
    git(root, "tag", "-f", "v0.25.0")
    fs.rmSync(link)

    const result = run(root, "generate", "--base-ref", "v0.25.0", "--version", "0.26.0")

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/changed template symlink.*base-link.*unsupported/i)
  })
})

import { readFileSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../")
const routesRoot = join(webRoot, "src/routes")
const shellRoot = join(webRoot, "src/components/shell")

const HATCH = /\/\/\s*jinn-shell:\s*ok\b[ \t]+\S/
const LARGE_TITLE = /--text-large-title/
const ACCENT_BUTTON = /bg-\[var\(--accent\)\]/
const ACCENT_CONTRAST = /text-\[var\(--accent-contrast\)\]/
const SHEET_SIGNATURE = /animate-sheet-in|rounded-t-\[var\(--radius-2xl\)\]|rounded-t-\[18px\]/

const KNOWN_SHEETS = new Set([
  "src/routes/todos/new-todo-dialog.tsx",
  "src/routes/todos/pickers/picker-shell.tsx",
  "src/routes/todos/quick-add/capture-bar.tsx",
  "src/routes/todos/todo-filter-sheet.tsx",
  "src/routes/workflow/editor/inspector.tsx",
  "src/routes/workflow/editor/palette.tsx",
])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return []
      return sourceFiles(path)
    }
    if (![".ts", ".tsx"].includes(extname(entry.name)) || entry.name.includes(".test.")) return []
    return [path]
  })
}

const relativePath = (path: string): string => relative(webRoot, path).replaceAll("\\", "/")

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length
}

function lineAt(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? ""
}

export function largeTitleViolations(source: string, relPath: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(new RegExp(LARGE_TITLE, "g"))) {
    const line = lineOf(source, match.index ?? 0)
    if (HATCH.test(lineAt(source, line))) continue
    found.push(`${relPath}:${line} ${match[0]}`)
  }
  return found
}

/** Where a `className` attribute's value starts and ends, braces and strings
 *  balanced, so a class list prettier broke over five lines still reads as one. */
function classNameSpans(source: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  for (const match of source.matchAll(/className=/g)) {
    const start = (match.index ?? 0) + match[0].length
    const end = spanEnd(source, start)
    if (end > start) spans.push({ start, end })
  }
  return spans
}

function spanEnd(source: string, start: number): number {
  const opener = source[start]
  if (opener === '"' || opener === "'") {
    const close = source.indexOf(opener, start + 1)
    return close < 0 ? source.length : close + 1
  }
  if (opener !== "{") return start
  let depth = 0
  let quote = ""
  for (let i = start; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      if (char === "\\") i++
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return i + 1
  }
  return source.length
}

function hatchedBetween(source: string, firstLine: number, lastLine: number): boolean {
  for (let line = firstLine; line <= lastLine; line++) {
    if (HATCH.test(lineAt(source, line))) return true
  }
  return false
}

/**
 * The accent pair makes a page-level button wherever the two tokens end up in
 * the same class list — which is not the same as the same LINE, because that is
 * a decision prettier makes about width. So the window is the whole `className`
 * attribute the `bg-` token sits in, and only a pair written outside one falls
 * back to its line. Reported at the `bg-` token, hatchable anywhere in the span.
 */
export function accentButtonViolations(source: string, relPath: string): string[] {
  const spans = classNameSpans(source)
  const found: string[] = []
  for (const match of source.matchAll(new RegExp(ACCENT_BUTTON, "g"))) {
    const index = match.index ?? 0
    const span = spans.find((candidate) => index >= candidate.start && index < candidate.end)
    const line = lineOf(source, index)
    const firstLine = span ? lineOf(source, span.start) : line
    const lastLine = span ? lineOf(source, span.end) : line
    if (!ACCENT_CONTRAST.test(span ? source.slice(span.start, span.end) : lineAt(source, line))) continue
    if (hatchedBetween(source, firstLine, lastLine)) continue
    found.push(`${relPath}:${line} ${lineAt(source, line).trim()}`)
  }
  return found
}

function hatchedLines(source: string): number[] {
  const lines: number[] = []
  source.split("\n").forEach((text, offset) => {
    if (HATCH.test(text)) lines.push(offset + 1)
  })
  return lines
}

/**
 * One entry per unhatched sheet, not per file. Both suppressions used to answer
 * file-wide — a hatch for everything under it, a `KNOWN_SHEETS` entry for
 * everything in the file it names — so a second sheet added beside an
 * already-answered-for one arrived unseen. Counting sheets instead means the
 * second one shows up as a second entry the enumerated set cannot balance.
 *
 * A sheet is the `className` its signature sits in, so the several tokens one
 * sheet spells itself with count once however prettier wrapped them, and two
 * sheets sharing a line stay two. A signature written outside a `className` is
 * its own sheet. A hatch answers for a sheet rather than for a line, so it is
 * claimed by the first sheet whose span it falls in and cannot cover a sibling
 * that happens to sit beside it.
 */
export function sheetHits(source: string, relPath: string): string[] {
  const spans = classNameSpans(source)
  const sheets = new Map<number, { firstLine: number; lastLine: number }>()
  for (const match of source.matchAll(new RegExp(SHEET_SIGNATURE, "g"))) {
    const index = match.index ?? 0
    const span = spans.find((candidate) => index >= candidate.start && index < candidate.end)
    const key = span ? span.start : index
    if (sheets.has(key)) continue
    sheets.set(key, {
      firstLine: lineOf(source, span ? span.start : index),
      lastLine: lineOf(source, span ? span.end : index),
    })
  }
  const unclaimed = hatchedLines(source)
  const found: string[] = []
  for (const { firstLine, lastLine } of sheets.values()) {
    const hatch = unclaimed.findIndex((line) => line >= firstLine && line <= lastLine)
    if (hatch >= 0) unclaimed.splice(hatch, 1)
    else found.push(relPath)
  }
  return found
}

describe("jinn shell contract", () => {
  it("rule 1 goes red on a hand-rolled large title and green with a reasoned hatch", () => {
    const violation = `<h1 className="md:text-[length:var(--text-large-title)]">Title</h1>`
    expect(largeTitleViolations(violation, "src/routes/fake.tsx")).toEqual([
      "src/routes/fake.tsx:1 --text-large-title",
    ])
    const hatched = `<h1 className="md:text-[length:var(--text-large-title)]">Title</h1> // jinn-shell: ok fixture`
    expect(largeTitleViolations(hatched, "src/routes/fake.tsx")).toEqual([])
  })

  it("rule 2 goes red on a hand-rolled page-level accent button and green with a reasoned hatch", () => {
    const violation = `className="rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]"`
    expect(accentButtonViolations(violation, "src/routes/fake.tsx")).toHaveLength(1)
    const hatched = `className="rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]" // jinn-shell: ok dialog submit`
    expect(accentButtonViolations(hatched, "src/routes/fake.tsx")).toEqual([])
  })

  it("rule 2 goes red on an accent button whose className spans several lines", () => {
    const wrapped = [
      "<button",
      "  className={cn(",
      '    "rounded-full bg-[var(--accent)]",',
      '    "text-[var(--accent-contrast)]",',
      "  )}",
      "/>",
    ].join("\n")
    expect(accentButtonViolations(wrapped, "src/routes/fake.tsx")).toEqual([
      'src/routes/fake.tsx:3 "rounded-full bg-[var(--accent)]",',
    ])
    // A hatch answers for the span it sits in, so it goes on the offending line.
    const hatched = wrapped.replace('bg-[var(--accent)]",', 'bg-[var(--accent)]", // jinn-shell: ok fixture')
    expect(accentButtonViolations(hatched, "src/routes/fake.tsx")).toEqual([])
  })

  it("rule 3 goes red on a new bottom sheet outside the enumerated set", () => {
    const source = `className="absolute inset-x-0 bottom-0 rounded-t-[var(--radius-2xl)] animate-sheet-in"`
    expect(sheetHits(source, "src/routes/new-sheet.tsx")).toEqual(["src/routes/new-sheet.tsx"])
    expect(sheetHits(source, "src/routes/todos/todo-filter-sheet.tsx")).toEqual([
      "src/routes/todos/todo-filter-sheet.tsx",
    ])
  })

  it("rule 3 counts two sheets that share a line as two, not one", () => {
    const attributes = `<div className="animate-sheet-in" /><aside className="rounded-t-[18px]" />`
    expect(sheetHits(attributes, "src/routes/new-sheet.tsx")).toHaveLength(2)
    const bare = `const [shell, sibling] = ["animate-sheet-in", "rounded-t-[18px]"]`
    expect(sheetHits(bare, "src/routes/new-sheet.tsx")).toHaveLength(2)
  })

  it("rule 3 lets one hatch answer for one of two sheets sharing a line, not for both", () => {
    const source = `<div className="animate-sheet-in" /><aside className="rounded-t-[18px]" /> // jinn-shell: ok the enumerated picker`
    expect(sheetHits(source, "src/routes/new-sheet.tsx")).toEqual(["src/routes/new-sheet.tsx"])
  })

  it("rule 3 counts one className's several signature tokens as one sheet", () => {
    const wrapped = [
      "<div",
      "  className={cn(",
      '    "animate-sheet-in",',
      '    "rounded-t-[var(--radius-2xl)]",',
      "  )}",
      "/>",
    ].join("\n")
    expect(sheetHits(wrapped, "src/routes/new-sheet.tsx")).toEqual(["src/routes/new-sheet.tsx"])
  })

  it("rule 3 goes red on a second, unhatched sheet in a file that already hatched one", () => {
    const source = [
      'const known = "animate-sheet-in" // jinn-shell: ok the enumerated picker',
      'const fresh = "rounded-t-[18px]"',
    ].join("\n")
    expect(sheetHits(source, "src/routes/new-sheet.tsx")).toEqual(["src/routes/new-sheet.tsx"])
  })

  // Enumeration is a suppression too: `KNOWN_SHEETS` accounts for one sheet per
  // file it names, so a second one added beside it has to arrive as a second
  // entry or the tree comparison balances and the gate says nothing.
  it("rule 3 goes red on a second unhatched sheet in a file the enumerated set already covers", () => {
    const source = [
      'const shell = "animate-sheet-in"',
      'export const second = "animate-sheet-in"',
    ].join("\n")
    const found = sheetHits(source, "src/routes/todos/quick-add/capture-bar.tsx")
    expect(found).toHaveLength(2)
    expect(found).not.toEqual([...KNOWN_SHEETS].filter((path) => found.includes(path)))
  })

  it("rule 1 is green on the migrated tree", () => {
    const violations = sourceFiles(routesRoot).flatMap((path) =>
      largeTitleViolations(readFileSync(path, "utf8"), relativePath(path)),
    )
    expect(violations).toEqual([])
  })

  it("rule 2 is green on the migrated tree", () => {
    const violations = sourceFiles(routesRoot).flatMap((path) =>
      accentButtonViolations(readFileSync(path, "utf8"), relativePath(path)),
    )
    expect(violations).toEqual([])
  })

  it("rule 3 is green when only the enumerated bottom sheets remain", () => {
    const found = sourceFiles(routesRoot)
      .flatMap((path) => sheetHits(readFileSync(path, "utf8"), relativePath(path)))
      .sort()
    expect(found).toEqual([...KNOWN_SHEETS].sort())
  })

  it("the collapse is CSS-only: no scroll listener, observer, or collapsed flag", () => {
    const files = sourceFiles(shellRoot)
    const hits: string[] = []
    for (const path of files) {
      const source = readFileSync(path, "utf8")
      const rel = relativePath(path)
      if (/addEventListener\(\s*["']scroll["']/.test(source)) hits.push(`${rel} addEventListener("scroll")`)
      if (/IntersectionObserver/.test(source)) hits.push(`${rel} IntersectionObserver`)
      if (/useState\([^)]*collaps/i.test(source) || /setCollapsed\b/.test(source)) {
        hits.push(`${rel} collapsed useState`)
      }
    }
    expect(hits).toEqual([])
  })

  it("workflow list and todos board both render PrimaryAction with the same data-slot", () => {
    const workflow = readFileSync(join(routesRoot, "workflow/list.tsx"), "utf8")
    const board = readFileSync(join(routesRoot, "todos/board/board-page.tsx"), "utf8")
    expect(workflow).toMatch(/<PrimaryAction\b/)
    expect(board).toMatch(/<PrimaryAction\b/)
    expect(workflow).not.toMatch(/bg-\[var\(--accent\)\].*text-\[var\(--accent-contrast\)\]/)
    expect(readFileSync(join(shellRoot, "primary-action.tsx"), "utf8")).toMatch(/PRIMARY_ACTION_SLOT/)
    expect(readFileSync(join(shellRoot, "primary-action.tsx"), "utf8")).toMatch(/data-slot=\{PRIMARY_ACTION_SLOT\}/)
  })
})

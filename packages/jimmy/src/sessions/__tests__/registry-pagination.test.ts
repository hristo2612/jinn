import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pg-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

function insert(
  db: import("better-sqlite3").Database,
  id: string,
  fields: { source?: string; sourceRef?: string; employee?: string | null; lastActivity: string },
) {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, employee, status, created_at, last_activity)
     VALUES (?, 'claude', ?, ?, ?, 'idle', ?, ?)`,
  ).run(
    id,
    fields.source ?? "web",
    fields.sourceRef ?? `web:${id}`,
    fields.employee ?? null,
    fields.lastActivity,
    fields.lastActivity,
  );
}

beforeAll(async () => {
  reg = await import("../registry.js");
  const db = reg.initDb();
  // Alice: 12 chats, Bob: 3, direct: 6, cron: 20.
  let t = 0;
  const ts = () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`;
  for (let i = 0; i < 12; i++) insert(db, `alice-${i}`, { employee: "alice", lastActivity: ts() });
  for (let i = 0; i < 3; i++) insert(db, `bob-${i}`, { employee: "bob", lastActivity: ts() });
  for (let i = 0; i < 6; i++) insert(db, `direct-${i}`, { employee: null, lastActivity: ts() });
  for (let i = 0; i < 20; i++)
    insert(db, `cron-${i}`, { source: "cron", sourceRef: `cron:job:${i}`, lastActivity: ts() });
  // a titled row in its own group (old timestamp) so it doesn't perturb the
  // alice/bob/direct/cron pagination assertions above
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, employee, title, status, created_at, last_activity)
     VALUES ('titled-1','claude','web','web:t1','zoe','Quarterly budget review','idle','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')`,
  ).run();
});

describe("searchSessions", () => {
  it("matches title case-insensitively across all sessions", () => {
    const hits = reg.searchSessions("BUDGET");
    expect(hits.map((r) => r.id)).toContain("titled-1");
  });

  it("matches employee and id, and returns nothing for misses", () => {
    expect(reg.searchSessions("bob").length).toBeGreaterThanOrEqual(3);
    expect(reg.searchSessions("alice-7").map((r) => r.id)).toEqual(["alice-7"]);
    expect(reg.searchSessions("nonexistent-zzz")).toEqual([]);
  });
});

describe("listRecentPerGroup", () => {
  it("caps each group at perGroup, regardless of group size", () => {
    const rows = reg.listRecentPerGroup(8);
    const byEmp = (e: string | null, cron = false) =>
      rows.filter((r) =>
        cron ? r.source === "cron" : r.source !== "cron" && (r.employee ?? null) === e,
      );

    expect(byEmp("alice").length).toBe(8); // 12 → capped at 8
    expect(byEmp("bob").length).toBe(3); // 3 → all
    expect(byEmp(null).length).toBe(6); // direct → all
    expect(byEmp(null, true).length).toBe(8); // 20 cron → capped at 8

    // 8 (alice) + 3 (bob) + 6 (direct) + 8 (cron) + 1 (zoe) = 26 instead of all
    expect(rows.length).toBe(26);
  });

  it("returns the most recent rows within a group", () => {
    const rows = reg.listRecentPerGroup(8);
    const alice = rows.filter((r) => r.employee === "alice").map((r) => r.id);
    // alice-11 is newest; alice-0..3 are the oldest and should be excluded.
    expect(alice).toContain("alice-11");
    expect(alice).not.toContain("alice-0");
  });
});

describe("listSessionsForGroup", () => {
  it("paginates a single employee newest-first", () => {
    const page1 = reg.listSessionsForGroup("alice", 5, 0);
    const page2 = reg.listSessionsForGroup("alice", 5, 5);
    expect(page1.map((r) => r.id)).toEqual(["alice-11", "alice-10", "alice-9", "alice-8", "alice-7"]);
    expect(page2.map((r) => r.id)).toEqual(["alice-6", "alice-5", "alice-4", "alice-3", "alice-2"]);
  });

  it("paginates the cron and direct sentinel groups", () => {
    expect(reg.listSessionsForGroup(reg.CRON_GROUP, 100, 0).length).toBe(20);
    expect(reg.listSessionsForGroup(reg.DIRECT_GROUP, 100, 0).length).toBe(6);
    // direct must not leak cron rows
    expect(reg.listSessionsForGroup(reg.DIRECT_GROUP, 100, 0).every((r) => r.source !== "cron")).toBe(true);
  });
});

describe("getSessionGroupCounts", () => {
  it("returns true totals per group", () => {
    const counts = reg.getSessionGroupCounts();
    expect(counts["alice"]).toBe(12);
    expect(counts["bob"]).toBe(3);
    expect(counts[reg.DIRECT_GROUP]).toBe(6);
    expect(counts[reg.CRON_GROUP]).toBe(20);
  });
});

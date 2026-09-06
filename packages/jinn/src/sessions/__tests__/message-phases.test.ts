import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-message-phases-"));
const dbModule = await import("../../shared/db.js");
const reg = await import("../registry.js");
function newSession(id: string): void {
  dbModule.initDb().prepare("INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'codex', 'web', ?, 'idle', 't', 't')").run(id, `web:${id}`);
}
describe("legacy assistant message phases", () => {
  it("recovers final versus commentary evidence from legacy rows across pagination", () => {
    newSession("phase-history");
    reg.insertMessage("phase-history", "user", "Research the design.");
    reg.insertPartialMessage("phase-history", "assistant", "Checking the implementation.", 0);
    reg.finalizePartialMessages("phase-history");
    const finalId = reg.insertMessage("phase-history", "assistant", "The complete conclusion.");
    reg.insertMessage("phase-history", "assistant", "Callback acknowledged.");
    const rows = reg.getMessages("phase-history");
    expect(rows[1].meta?.assistantPhase).toBe("commentary");
    expect(rows[2].meta?.assistantPhase).toBe("final");
    expect(rows[3].meta?.assistantPhase).toBe("final");
    expect(reg.getMessagePage("phase-history", { before: finalId, limit: 1 }).messages[0].meta?.assistantPhase).toBe("commentary");
  });
});

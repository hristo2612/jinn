import { describe, expect, it } from "vitest"
import { buildConstellation } from "../constellation"
import type { Employee, WorkItemCompactWire } from "../api"

describe("buildConstellation", () => {
  it("connects people, work, and sessions without dangling edges", () => {
    const employees: Employee[] = [
      { name: "lead", displayName: "Lead", department: "studio", rank: "manager", engine: "codex", model: "x", persona: "" },
      { name: "maker", displayName: "Maker", department: "studio", rank: "senior", engine: "claude", model: "x", persona: "", reportsTo: "lead" },
    ]
    const todos = [{ id: "STU-1", title: "Compose", status: "executing", assignee: "maker", department: "studio", source: "human", sourceRef: null, approvalState: null, approvalRequest: null, approvalRef: null, approvalTarget: null, approvalEscalatedAt: null, updatedAt: "2026-01-01" }] as WorkItemCompactWire[]
    const graph = buildConstellation(employees, todos, [{ id: "session-1", employee: "maker", workItemId: "STU-1", status: "running", title: "Compose" }])
    const ids = new Set(graph.nodes.map((node) => node.id))

    expect(graph.nodes.some((node) => node.id === "todo:STU-1" && node.status === "executing")).toBe(true)
    expect(graph.edges.some((edge) => edge.source === "session:session-1" && edge.target === "todo:STU-1")).toBe(true)
    expect(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true)
  })
})

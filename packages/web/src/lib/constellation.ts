import type { Employee, WorkItemCompactWire } from "./api"

export type ConstellationKind = "employee" | "todo" | "session" | "department"

export interface ConstellationNode {
  id: string
  kind: ConstellationKind
  label: string
  meta: string
  status: string
  href?: string
  group: string
  weight: number
}

export interface ConstellationEdge {
  id: string
  source: string
  target: string
  kind: "reports" | "owns" | "runs" | "groups"
}

export interface ConstellationGraph {
  nodes: ConstellationNode[]
  edges: ConstellationEdge[]
}

type SessionFact = Record<string, unknown>
type GraphParts = { nodes: ConstellationNode[]; edges: ConstellationEdge[] }

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function sessionStatus(session: SessionFact): string {
  return text(session.transportState) ?? text(session.status) ?? "idle"
}

function addDepartments(parts: GraphParts, employees: Employee[]) {
  const departments = [...new Set(employees.map((employee) => employee.department).filter(Boolean))]
  for (const department of departments) {
    parts.nodes.push({ id: `department:${department}`, kind: "department", label: department, meta: "Department", status: "structural", group: department, weight: 1.5 })
  }
}

function addEmployees(parts: GraphParts, employees: Employee[], employeeNames: Set<string>) {
  for (const employee of employees) {
    const id = `employee:${employee.name}`
    parts.nodes.push({
      id,
      kind: "employee",
      label: employee.displayName,
      meta: `${employee.rank} · ${employee.engine}`,
      status: "available",
      href: `/org?employee=${encodeURIComponent(employee.name)}`,
      group: employee.department || "company",
      weight: employee.rank === "executive" ? 2.4 : employee.rank === "manager" ? 1.9 : 1.35,
    })
    const parents = Array.isArray(employee.reportsTo) ? employee.reportsTo : employee.reportsTo ? [employee.reportsTo] : []
    for (const parent of parents) {
      if (employeeNames.has(parent)) parts.edges.push({ id: `reports:${employee.name}:${parent}`, source: id, target: `employee:${parent}`, kind: "reports" })
    }
    if (employee.department) parts.edges.push({ id: `groups:${employee.name}`, source: id, target: `department:${employee.department}`, kind: "groups" })
  }
}

function addTodos(parts: GraphParts, todos: WorkItemCompactWire[], employeeNames: Set<string>) {
  for (const todo of todos) {
    const id = `todo:${todo.id}`
    parts.nodes.push({
      id,
      kind: "todo",
      label: todo.id,
      meta: todo.title,
      status: todo.status,
      href: `/todos/${encodeURIComponent(todo.id)}`,
      group: todo.department ?? "company",
      weight: todo.status === "blocked" || todo.status === "escalated" ? 1.55 : 1.1,
    })
    if (todo.assignee && employeeNames.has(todo.assignee)) parts.edges.push({ id: `owns:${todo.id}:${todo.assignee}`, source: id, target: `employee:${todo.assignee}`, kind: "owns" })
    if (todo.parentId) parts.edges.push({ id: `owns:${todo.id}:${todo.parentId}`, source: id, target: `todo:${todo.parentId}`, kind: "owns" })
  }
}

function addSession(parts: GraphParts, session: SessionFact, employeeNames: Set<string>) {
  const rawId = text(session.id)
  if (!rawId) return
  const employee = text(session.employee)
  const title = text(session.title) ?? text(session.promptExcerpt) ?? "Session"
  const id = `session:${rawId}`
  parts.nodes.push({
    id,
    kind: "session",
    label: title,
    meta: employee ? `Session · ${employee}` : "Direct session",
    status: sessionStatus(session),
    href: `/chat/${encodeURIComponent(rawId)}`,
    group: employee ?? "direct",
    weight: sessionStatus(session) === "running" ? 1.45 : 0.85,
  })
  if (employee && employeeNames.has(employee)) parts.edges.push({ id: `runs:${rawId}:${employee}`, source: id, target: `employee:${employee}`, kind: "runs" })
  const workItemId = text(session.workItemId)
  if (workItemId) parts.edges.push({ id: `runs:${rawId}:${workItemId}`, source: id, target: `todo:${workItemId}`, kind: "runs" })
}

function addSessions(parts: GraphParts, sessions: SessionFact[], employeeNames: Set<string>) {
  for (const session of sessions.slice(0, 80)) addSession(parts, session, employeeNames)
}

export function buildConstellation(employees: Employee[], todos: WorkItemCompactWire[], sessions: SessionFact[]): ConstellationGraph {
  const parts: GraphParts = { nodes: [], edges: [] }
  const employeeNames = new Set(employees.map((employee) => employee.name))
  addDepartments(parts, employees)
  addEmployees(parts, employees, employeeNames)
  addTodos(parts, todos, employeeNames)
  addSessions(parts, sessions, employeeNames)
  const present = new Set(parts.nodes.map((node) => node.id))
  return { nodes: parts.nodes, edges: parts.edges.filter((edge) => present.has(edge.source) && present.has(edge.target)) }
}

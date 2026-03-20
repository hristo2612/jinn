"use client"
import {
  ReactFlow,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  ConnectionLineType,
} from "@xyflow/react"
import { useCallback, useEffect } from "react"
import dagre from "@dagrejs/dagre"
import type { Employee, OrgTreeData, OrgTreeNode } from "@/lib/api"
import { nodeTypes } from "@/components/org/employee-node"

interface OrgMapProps {
  employees: Employee[]
  selectedName: string | null
  onNodeClick: (employee: Employee) => void
  orgTree?: OrgTreeData | null
}

const NODE_W = 220
const NODE_H = 80
const INNER_GAP = 14
const GROUP_PAD_X = 24
const GROUP_LABEL_H = 28
const GROUP_PAD_BOTTOM = 18
const COLS = 2

// ── Gather department info from tree ─────────────────────────

interface DeptInfo {
  path: string
  displayName: string
  managerName?: string
  memberNames: string[]
  childPaths: string[]
  parentPath?: string
  depth: number
}

function gatherDepts(tree: OrgTreeNode[], parent?: string, depth = 0): DeptInfo[] {
  const result: DeptInfo[] = []
  for (const node of tree) {
    result.push({
      path: node.path,
      displayName: node.displayName || node.name,
      managerName: node.manager?.name,
      memberNames: node.employees
        .filter((e) => e.name !== node.manager?.name)
        .map((e) => e.name),
      childPaths: node.children.map((c) => c.path),
      parentPath: parent,
      depth,
    })
    result.push(...gatherDepts(node.children, node.path, depth + 1))
  }
  return result
}

// ── Member-only group size (manager is outside) ──────────────

function memberGroupSize(memberCount: number): { w: number; h: number } {
  if (memberCount === 0) return { w: NODE_W + GROUP_PAD_X * 2, h: 0 }
  const cols = Math.min(memberCount, COLS)
  const rows = Math.ceil(memberCount / cols)
  return {
    w: cols * NODE_W + (cols - 1) * INNER_GAP + GROUP_PAD_X * 2,
    h: rows * NODE_H + (rows - 1) * INNER_GAP + GROUP_LABEL_H + GROUP_PAD_BOTTOM,
  }
}

// ── Build tree layout ─────────────────────────────────────────

function buildTreeLayout(
  employees: Employee[],
  selectedName: string | null,
  orgTree?: OrgTreeData | null,
): { nodes: Node[]; edges: Edge[] } {
  if (employees.length === 0) return { nodes: [], edges: [] }

  const executive = employees.find((e) => e.rank === "executive")
  const empMap = new Map(employees.map((e) => [e.name, e]))

  // ── With tree data: separated manager/group layout ──
  if (orgTree?.tree) {
    const depts = gatherDepts(orgTree.tree)
    const deptByPath = new Map(depts.map((d) => [d.path, d]))

    // Dagre graph: managers as individual nodes, member-groups as separate nodes
    // Edges: executive → managers, manager → child-managers, manager → own member-group
    const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 90, marginx: 50, marginy: 50 })

    // Executive
    if (executive) {
      g.setNode(executive.name, { width: NODE_W, height: NODE_H })
    }

    for (const dept of depts) {
      // Manager as standalone node
      if (dept.managerName) {
        g.setNode(dept.managerName, { width: NODE_W, height: NODE_H })
      }
      // Member group (only if has members)
      if (dept.memberNames.length > 0) {
        const sz = memberGroupSize(dept.memberNames.length)
        g.setNode(`grp:${dept.path}`, { width: sz.w, height: sz.h })
      }
    }

    // Edges for Dagre ranking
    for (const dept of depts) {
      if (!dept.managerName) continue

      // Executive → top-level managers
      if (!dept.parentPath && executive) {
        g.setEdge(executive.name, dept.managerName)
      }
      // Parent manager → child manager
      if (dept.parentPath) {
        const parentDept = deptByPath.get(dept.parentPath)
        if (parentDept?.managerName) {
          g.setEdge(parentDept.managerName, dept.managerName)
        }
      }
      // Manager → own member group (keeps group directly below manager)
      if (dept.memberNames.length > 0) {
        g.setEdge(dept.managerName, `grp:${dept.path}`)
      }
    }

    dagre.layout(g)

    const nodes: Node[] = []
    const edges: Edge[] = []

    // ── Place executive ──
    if (executive) {
      const p = g.node(executive.name)
      if (p) {
        nodes.push({
          id: executive.name,
          type: "employeeNode",
          data: executive as unknown as Record<string, unknown>,
          position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
          selected: executive.name === selectedName,
          zIndex: 2,
        })
      }
    }

    // ── Place managers (standalone) and member groups ──
    for (const dept of depts) {
      // Manager node (standalone, not inside any group)
      if (dept.managerName && empMap.has(dept.managerName)) {
        const mgr = empMap.get(dept.managerName)!
        const p = g.node(dept.managerName)
        if (p) {
          nodes.push({
            id: mgr.name,
            type: "employeeNode",
            data: mgr as unknown as Record<string, unknown>,
            position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
            selected: mgr.name === selectedName,
            zIndex: 2,
            draggable: false,
          })
        }
      }

      // Member group box + member nodes inside
      if (dept.memberNames.length > 0) {
        const gNode = g.node(`grp:${dept.path}`)
        if (!gNode) continue

        const sz = memberGroupSize(dept.memberNames.length)
        const groupId = `grp:${dept.path}`
        const gx = gNode.x - sz.w / 2
        const gy = gNode.y - sz.h / 2

        // Group background
        nodes.push({
          id: groupId,
          type: "departmentGroup",
          data: { label: dept.displayName },
          position: { x: gx, y: gy },
          style: {
            width: sz.w,
            height: sz.h,
            background: "var(--fill-quaternary)",
            borderRadius: 12,
            border: "1px solid var(--separator)",
            padding: 0,
          },
          selectable: false,
          draggable: false,
          zIndex: 0,
        })

        // Members inside group (relative positions)
        const cols = Math.min(dept.memberNames.length, COLS)
        const gridW = cols * NODE_W + (cols - 1) * INNER_GAP
        const gridStartX = (sz.w - gridW) / 2
        const gridStartY = GROUP_LABEL_H

        dept.memberNames.forEach((name, i) => {
          const emp = empMap.get(name)
          if (!emp) return
          const col = i % COLS
          const row = Math.floor(i / COLS)
          nodes.push({
            id: emp.name,
            type: "employeeNode",
            data: emp as unknown as Record<string, unknown>,
            position: {
              x: gridStartX + col * (NODE_W + INNER_GAP),
              y: gridStartY + row * (NODE_H + INNER_GAP),
            },
            parentId: groupId,
            extent: "parent" as const,
            selected: emp.name === selectedName,
            zIndex: 1,
            draggable: false,
          })
        })
      }
    }

    // ── Chain of command edges (manager → manager) ──
    // These route in open space between levels — no group crossing

    for (const dept of depts) {
      if (!dept.managerName) continue

      if (!dept.parentPath && executive) {
        const hl = selectedName === executive.name || selectedName === dept.managerName
        edges.push({
          id: `chain-exec-${dept.managerName}`,
          source: executive.name,
          target: dept.managerName,
          type: "smoothstep",
          style: {
            stroke: hl ? "var(--accent)" : "var(--text-secondary)",
            strokeWidth: hl ? 3 : 2,
            opacity: hl ? 1 : 0.55,
          },
          animated: hl,
        })
      } else if (dept.parentPath) {
        const parentDept = deptByPath.get(dept.parentPath)
        if (parentDept?.managerName) {
          const hl = selectedName === parentDept.managerName || selectedName === dept.managerName
          edges.push({
            id: `chain-${parentDept.managerName}-${dept.managerName}`,
            source: parentDept.managerName,
            target: dept.managerName,
            type: "smoothstep",
            style: {
              stroke: hl ? "var(--accent)" : "var(--text-secondary)",
              strokeWidth: hl ? 3 : 2,
              opacity: hl ? 1 : 0.55,
            },
            animated: hl,
          })
        }
      }
    }

    // ── Manager → member group edges (subtle connector) ──

    for (const dept of depts) {
      if (!dept.managerName || dept.memberNames.length === 0) continue
      for (const memberName of dept.memberNames) {
        if (!empMap.has(memberName)) continue
        const hl = selectedName === dept.managerName || selectedName === memberName
        edges.push({
          id: `team-${dept.managerName}-${memberName}`,
          source: dept.managerName,
          target: memberName,
          type: "smoothstep",
          style: {
            stroke: hl ? "var(--accent)" : "var(--text-quaternary)",
            strokeWidth: hl ? 2 : 1,
            opacity: hl ? 1 : 0.2,
          },
          animated: hl,
        })
      }
    }

    return { nodes, edges }
  }

  // ── Fallback: flat layout (no tree data) ──
  const allIds = employees.map((e) => e.name)
  const hierEdges = inferFlatEdges(employees, executive?.name)

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 100, marginx: 40, marginy: 40 })
  for (const id of allIds) g.setNode(id, { width: NODE_W, height: NODE_H })
  for (const [s, t] of hierEdges) if (empMap.has(s) && empMap.has(t)) g.setEdge(s, t)
  dagre.layout(g)

  const nodes: Node[] = allIds
    .map((id) => {
      const emp = empMap.get(id)
      const p = g.node(id)
      if (!emp || !p) return null
      return {
        id: emp.name, type: "employeeNode",
        data: emp as unknown as Record<string, unknown>,
        position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
        selected: emp.name === selectedName,
      } as Node
    })
    .filter(Boolean) as Node[]

  const nodeIdSet = new Set(nodes.map((n) => n.id))
  const edges: Edge[] = hierEdges
    .filter(([s, t]) => nodeIdSet.has(s) && nodeIdSet.has(t))
    .map(([src, tgt]) => ({
      id: `hier-${src}-${tgt}`, source: src, target: tgt, type: "smoothstep",
      style: {
        stroke: selectedName === src || selectedName === tgt ? "var(--accent)" : "var(--text-quaternary)",
        strokeWidth: selectedName === src || selectedName === tgt ? 2.5 : 1.5,
        opacity: selectedName === src || selectedName === tgt ? 1 : 0.5,
      },
      animated: selectedName === src || selectedName === tgt,
    }))

  return { nodes, edges }
}

// ── Fallback: infer edges from flat data ──────────────────────

function inferFlatEdges(
  employees: Employee[],
  executiveName: string | undefined,
): [string, string][] {
  const pairs: [string, string][] = []
  const deptMap = new Map<string, Employee[]>()

  for (const emp of employees) {
    if (emp.department && emp.rank !== "executive") {
      const list = deptMap.get(emp.department) || []
      list.push(emp)
      deptMap.set(emp.department, list)
    }
  }

  const rankOrder: Record<string, number> = { executive: 0, director: 0, manager: 1, lead: 1, senior: 2, employee: 3 }

  for (const [, members] of deptMap) {
    const sorted = [...members].sort(
      (a, b) => (rankOrder[a.rank] ?? 3) - (rankOrder[b.rank] ?? 3),
    )
    const topPerson = sorted[0]
    if (!topPerson) continue
    if (executiveName) pairs.push([executiveName, topPerson.name])
    for (let i = 1; i < sorted.length; i++) {
      pairs.push([topPerson.name, sorted[i].name])
    }
  }
  return pairs
}

// ── Component ──────────────────────────────────────────────────

export function OrgMap({ employees, selectedName, onNodeClick, orgTree }: OrgMapProps) {
  const { nodes: initialNodes, edges: initialEdges } = buildTreeLayout(
    employees,
    selectedName,
    orgTree,
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    const { nodes: n, edges: e } = buildTreeLayout(
      employees,
      selectedName,
      orgTree,
    )
    setNodes(n)
    setEdges(e)
  }, [employees, selectedName, orgTree, setNodes, setEdges])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const employee = employees.find((e) => e.name === node.id)
      if (employee) onNodeClick(employee)
    },
    [employees, onNodeClick],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes}
      connectionLineType={ConnectionLineType.SmoothStep}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Controls
        position="bottom-left"
        style={{ left: 16, bottom: 16 }}
      />
    </ReactFlow>
  )
}

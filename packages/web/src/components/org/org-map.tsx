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

// ── Full group size (manager + members inside) ──────────────

const GROUP_MGR_TOP = 40 // space for label + manager

function fullGroupSize(memberCount: number): { w: number; h: number } {
  const cols = Math.min(Math.max(memberCount, 1), COLS)
  const rows = memberCount > 0 ? Math.ceil(memberCount / cols) : 0
  const membersH = rows > 0 ? rows * NODE_H + (rows - 1) * INNER_GAP : 0
  const contentW = Math.max(NODE_W, cols * NODE_W + (cols - 1) * INNER_GAP)
  return {
    w: contentW + GROUP_PAD_X * 2,
    h: GROUP_MGR_TOP + NODE_H + (membersH > 0 ? INNER_GAP + membersH : 0) + GROUP_PAD_BOTTOM,
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

  // ── With tree data: group-based layout, managers inside boxes ──
  if (orgTree?.tree) {
    const depts = gatherDepts(orgTree.tree)
    const deptByPath = new Map(depts.map((d) => [d.path, d]))

    // Dagre: executive as root → top-level groups → sub-groups
    const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 120, marginx: 60, marginy: 60 })

    // Executive is a real Dagre node at the root
    if (executive) {
      g.setNode(executive.name, { width: NODE_W + 40, height: NODE_H })
    }

    // Group sizes precomputed
    const groupSizes = new Map<string, { w: number; h: number }>()
    for (const dept of depts) {
      const sz = fullGroupSize(dept.memberNames.length)
      groupSizes.set(dept.path, sz)
      g.setNode(`grp:${dept.path}`, { width: sz.w, height: sz.h })
    }

    // Dagre edges: executive → top-level groups, parent group → child group
    for (const dept of depts) {
      if (dept.parentPath) {
        g.setEdge(`grp:${dept.parentPath}`, `grp:${dept.path}`)
      } else if (executive) {
        g.setEdge(executive.name, `grp:${dept.path}`)
      }
    }

    dagre.layout(g)

    const nodes: Node[] = []
    const edges: Edge[] = []

    // ── Executive — positioned by Dagre at the true root ──
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

    // ── Department groups (manager + members inside) ──
    for (const dept of depts) {
      const dagreNode = g.node(`grp:${dept.path}`)
      if (!dagreNode) continue

      const sz = groupSizes.get(dept.path)!
      const groupId = `grp:${dept.path}`
      const gx = dagreNode.x - sz.w / 2
      const gy = dagreNode.y - sz.h / 2

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

      // Manager inside group (top, centered) — skip if executive (already placed as root)
      const isExecManager = executive && dept.managerName === executive.name
      if (dept.managerName && empMap.has(dept.managerName) && !isExecManager) {
        const mgr = empMap.get(dept.managerName)!
        nodes.push({
          id: mgr.name,
          type: "employeeNode",
          data: mgr as unknown as Record<string, unknown>,
          position: { x: (sz.w - NODE_W) / 2, y: GROUP_MGR_TOP },
          parentId: groupId,
          extent: "parent" as const,
          selected: mgr.name === selectedName,
          zIndex: 1,
          draggable: false,
        })
      }

      // Members inside group (grid below manager, or at top if manager is executive)
      if (dept.memberNames.length > 0) {
        const cols = Math.min(dept.memberNames.length, COLS)
        const gridW = cols * NODE_W + (cols - 1) * INNER_GAP
        const gridStartX = (sz.w - gridW) / 2
        const gridStartY = isExecManager ? GROUP_MGR_TOP : GROUP_MGR_TOP + NODE_H + INNER_GAP

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

    // ════════════════════════════════════════════════════════════
    // EDGES — two distinct visual types
    // ════════════════════════════════════════════════════════════

    // Build a lookup: employee name → department path (for selection context)
    const empToDept = new Map<string, string>()
    for (const dept of depts) {
      if (dept.managerName) empToDept.set(dept.managerName, dept.path)
      for (const m of dept.memberNames) empToDept.set(m, dept.path)
    }
    const selectedDept = selectedName ? empToDept.get(selectedName) : null

    // 1) CHAIN OF COMMAND (group → group, solid lines between boxes)
    //    Routes cleanly between group boundaries, never through other groups

    for (const dept of depts) {
      if (!dept.parentPath && executive) {
        // Executive → top-level group
        const groupId = `grp:${dept.path}`
        const hl = selectedDept === dept.path || selectedName === executive.name
        edges.push({
          id: `cmd-exec-${dept.path}`,
          source: executive.name,
          target: groupId,
          type: "smoothstep",
          zIndex: 10,
          style: {
            stroke: hl ? "var(--accent)" : "var(--text-secondary)",
            strokeWidth: hl ? 2.5 : 1.8,
            opacity: hl ? 1 : 0.5,
          },
          animated: hl,
        })
      } else if (dept.parentPath) {
        // Parent group → child group
        const parentGroupId = `grp:${dept.parentPath}`
        const childGroupId = `grp:${dept.path}`
        const hl = selectedDept === dept.path || selectedDept === dept.parentPath
        edges.push({
          id: `cmd-${dept.parentPath}-${dept.path}`,
          source: parentGroupId,
          target: childGroupId,
          type: "smoothstep",
          zIndex: 10,
          style: {
            stroke: hl ? "var(--accent)" : "var(--text-secondary)",
            strokeWidth: hl ? 2.5 : 1.8,
            opacity: hl ? 1 : 0.5,
          },
          animated: hl,
        })
      }
    }

    // 2) SERVICE LINKS (manager → members, only visible when group is selected)
    //    Dashed, thin — appears on click to show internal structure

    if (selectedDept) {
      const selDept = deptByPath.get(selectedDept)
      if (selDept?.managerName) {
        for (const memberName of selDept.memberNames) {
          if (!empMap.has(memberName)) continue
          edges.push({
            id: `svc-${selDept.managerName}-${memberName}`,
            source: selDept.managerName,
            target: memberName,
            type: "smoothstep",
            zIndex: 5,
            style: {
              stroke: "var(--accent)",
              strokeWidth: 1.5,
              strokeDasharray: "5 3",
              opacity: 0.7,
            },
          })
        }
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

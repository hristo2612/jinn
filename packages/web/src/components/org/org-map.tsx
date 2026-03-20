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
const INNER_GAP = 16
const GROUP_PAD_X = 28
const GROUP_PAD_TOP = 48
const GROUP_PAD_BOTTOM = 24
const COLS = 2 // max columns for members inside a group

// ── Gather department info from tree ─────────────────────────

interface DeptInfo {
  path: string
  displayName: string
  managerName?: string
  memberNames: string[] // non-manager employees
  childPaths: string[]
  parentPath?: string
}

function gatherDepts(tree: OrgTreeNode[], parent?: string): DeptInfo[] {
  const result: DeptInfo[] = []
  for (const node of tree) {
    const info: DeptInfo = {
      path: node.path,
      displayName: node.displayName || node.name,
      managerName: node.manager?.name,
      memberNames: node.employees
        .filter((e) => e.name !== node.manager?.name)
        .map((e) => e.name),
      childPaths: node.children.map((c) => c.path),
      parentPath: parent,
    }
    result.push(info)
    result.push(...gatherDepts(node.children, node.path))
  }
  return result
}

// ── Compute inner size for a department group ────────────────

function groupInnerSize(memberCount: number): { w: number; h: number } {
  if (memberCount === 0) return { w: NODE_W, h: 0 }
  const cols = Math.min(memberCount, COLS)
  const rows = Math.ceil(memberCount / cols)
  const w = cols * NODE_W + (cols - 1) * INNER_GAP
  const h = rows * NODE_H + (rows - 1) * INNER_GAP
  return { w, h }
}

function groupSize(memberCount: number): { w: number; h: number } {
  // Manager sits at top inside the group, then members below in grid
  const inner = groupInnerSize(memberCount)
  const contentW = Math.max(NODE_W, inner.w) // at least manager width
  const contentH = NODE_H + (memberCount > 0 ? INNER_GAP + inner.h : 0)
  return {
    w: contentW + GROUP_PAD_X * 2,
    h: contentH + GROUP_PAD_TOP + GROUP_PAD_BOTTOM,
  }
}

// ── Extract hierarchy edges between managers/directors ────────

function extractManagerEdges(
  depts: DeptInfo[],
  executiveName?: string,
): [string, string][] {
  const pairs: [string, string][] = []
  const deptByPath = new Map(depts.map((d) => [d.path, d]))

  for (const dept of depts) {
    if (!dept.managerName) continue
    // Connect to parent department's manager
    if (dept.parentPath) {
      const parent = deptByPath.get(dept.parentPath)
      if (parent?.managerName) {
        pairs.push([parent.managerName, dept.managerName])
      }
    } else if (executiveName) {
      // Top-level dept → executive
      pairs.push([executiveName, dept.managerName])
    }
  }
  return pairs
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

  // ── With tree data: group-based layout ──
  if (orgTree?.tree) {
    const depts = gatherDepts(orgTree.tree)
    const deptByPath = new Map(depts.map((d) => [d.path, d]))

    // Dagre layout with department groups as compound nodes + executive
    const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 120, marginx: 60, marginy: 60 })

    // Executive node
    if (executive) {
      g.setNode(executive.name, { width: NODE_W + 40, height: NODE_H })
    }

    // One Dagre node per department group (sized to fit its members)
    for (const dept of depts) {
      const size = groupSize(dept.memberNames.length)
      g.setNode(`grp:${dept.path}`, { width: size.w, height: size.h })
    }

    // Edges: executive → top-level group managers, parent group → child group
    for (const dept of depts) {
      if (dept.parentPath) {
        g.setEdge(`grp:${dept.parentPath}`, `grp:${dept.path}`)
      } else if (executive) {
        g.setEdge(executive.name, `grp:${dept.path}`)
      }
    }

    dagre.layout(g)

    // Read group positions from Dagre
    const groupPositions = new Map<string, { x: number; y: number; w: number; h: number }>()
    for (const dept of depts) {
      const dagreNode = g.node(`grp:${dept.path}`)
      if (!dagreNode) continue
      const size = groupSize(dept.memberNames.length)
      groupPositions.set(dept.path, {
        x: dagreNode.x - size.w / 2,
        y: dagreNode.y - size.h / 2,
        w: size.w,
        h: size.h,
      })
    }

    const nodes: Node[] = []
    const edges: Edge[] = []

    // Executive node (absolute position)
    if (executive) {
      const exPos = g.node(executive.name)
      if (exPos) {
        nodes.push({
          id: executive.name,
          type: "employeeNode",
          data: executive as unknown as Record<string, unknown>,
          position: { x: exPos.x - NODE_W / 2, y: exPos.y - NODE_H / 2 },
          selected: executive.name === selectedName,
          zIndex: 1,
        })
      }
    }

    // Department group nodes + employee children
    for (const dept of depts) {
      const gPos = groupPositions.get(dept.path)
      if (!gPos) continue

      const groupId = `grp:${dept.path}`

      // Group background node
      nodes.push({
        id: groupId,
        type: "departmentGroup",
        data: { label: dept.displayName },
        position: { x: gPos.x, y: gPos.y },
        style: {
          width: gPos.w,
          height: gPos.h,
          background: "var(--fill-quaternary)",
          borderRadius: 12,
          border: "1px solid var(--separator)",
          padding: 0,
        },
        selectable: false,
        draggable: false,
        zIndex: -1,
      })

      // Manager node (centered at top inside group, relative position)
      if (dept.managerName && empMap.has(dept.managerName)) {
        const mgr = empMap.get(dept.managerName)!
        nodes.push({
          id: mgr.name,
          type: "employeeNode",
          data: mgr as unknown as Record<string, unknown>,
          position: {
            x: (gPos.w - NODE_W) / 2,
            y: GROUP_PAD_TOP,
          },
          parentId: groupId,
          extent: "parent" as const,
          selected: mgr.name === selectedName,
          zIndex: 1,
          draggable: false,
        })
      }

      // Member nodes (grid below manager, relative positions)
      const cols = Math.min(dept.memberNames.length, COLS)
      const gridW = cols * NODE_W + (cols - 1) * INNER_GAP
      const gridStartX = (gPos.w - gridW) / 2
      const gridStartY = GROUP_PAD_TOP + NODE_H + INNER_GAP

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

    // Edges: executive → top-level group, parent group → child group
    for (const dept of depts) {
      if (!dept.parentPath && executive) {
        // Executive → top-level department group
        const isHighlighted = selectedName === executive.name || selectedName === dept.managerName
        edges.push({
          id: `chain-exec-${dept.path}`,
          source: executive.name,
          target: `grp:${dept.path}`,
          type: "smoothstep",
          style: {
            stroke: isHighlighted ? "var(--accent)" : "var(--text-quaternary)",
            strokeWidth: isHighlighted ? 2.5 : 1.8,
            opacity: isHighlighted ? 1 : 0.5,
          },
          animated: isHighlighted,
        })
      } else if (dept.parentPath) {
        // Parent group → child group
        const parentDept = deptByPath.get(dept.parentPath)
        const isHighlighted = selectedName === parentDept?.managerName || selectedName === dept.managerName
        edges.push({
          id: `chain-${dept.parentPath}-${dept.path}`,
          source: `grp:${dept.parentPath}`,
          target: `grp:${dept.path}`,
          type: "smoothstep",
          style: {
            stroke: isHighlighted ? "var(--accent)" : "var(--text-quaternary)",
            strokeWidth: isHighlighted ? 2.5 : 1.8,
            opacity: isHighlighted ? 1 : 0.5,
          },
          animated: isHighlighted,
        })
      }
    }

    // Internal edges: manager → members within each group
    for (const dept of depts) {
      if (!dept.managerName) continue
      for (const memberName of dept.memberNames) {
        if (!empMap.has(memberName)) continue
        const isHighlighted = selectedName === dept.managerName || selectedName === memberName
        edges.push({
          id: `mgr-${dept.managerName}-${memberName}`,
          source: dept.managerName,
          target: memberName,
          type: "smoothstep",
          style: {
            stroke: isHighlighted ? "var(--accent)" : "var(--text-quaternary)",
            strokeWidth: isHighlighted ? 2 : 1,
            opacity: isHighlighted ? 1 : 0.3,
          },
          animated: isHighlighted,
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

  for (const id of allIds) {
    g.setNode(id, { width: NODE_W, height: NODE_H })
  }
  for (const [src, tgt] of hierEdges) {
    if (empMap.has(src) && empMap.has(tgt)) g.setEdge(src, tgt)
  }
  dagre.layout(g)

  const nodes: Node[] = allIds
    .map((id) => {
      const emp = empMap.get(id)
      const pos = g.node(id)
      if (!emp || !pos) return null
      return {
        id: emp.name,
        type: "employeeNode",
        data: emp as unknown as Record<string, unknown>,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
        selected: emp.name === selectedName,
      } as Node
    })
    .filter(Boolean) as Node[]

  const nodeIdSet = new Set(nodes.map((n) => n.id))
  const edges: Edge[] = hierEdges
    .filter(([s, t]) => nodeIdSet.has(s) && nodeIdSet.has(t))
    .map(([src, tgt]) => {
      const hl = selectedName === src || selectedName === tgt
      return {
        id: `hier-${src}-${tgt}`,
        source: src,
        target: tgt,
        type: "smoothstep",
        style: {
          stroke: hl ? "var(--accent)" : "var(--text-quaternary)",
          strokeWidth: hl ? 2.5 : 1.5,
          opacity: hl ? 1 : 0.5,
        },
        animated: hl,
      }
    })

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

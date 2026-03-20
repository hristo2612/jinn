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

// ── Extract hierarchy edges from tree ─────────────────────────

function extractTreeEdges(
  tree: OrgTreeNode[],
  executiveName: string | undefined,
): [string, string][] {
  const pairs: [string, string][] = []

  function walkNode(node: OrgTreeNode, parentManager?: string) {
    const manager = node.manager?.name
    if (manager && parentManager && manager !== parentManager) {
      pairs.push([parentManager, manager])
    }
    if (manager && !parentManager && executiveName) {
      pairs.push([executiveName, manager])
    }
    if (manager) {
      for (const emp of node.employees) {
        if (emp.name !== manager) {
          pairs.push([manager, emp.name])
        }
      }
    }
    for (const child of node.children) {
      walkNode(child, manager)
    }
  }

  for (const root of tree) {
    walkNode(root)
  }
  return pairs
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

    // Connect executive to department head
    if (executiveName) {
      pairs.push([executiveName, topPerson.name])
    }
    // Connect head to other members
    for (let i = 1; i < sorted.length; i++) {
      pairs.push([topPerson.name, sorted[i].name])
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

  // Get hierarchy edges
  const hierEdges: [string, string][] = orgTree?.tree
    ? extractTreeEdges(orgTree.tree, executive?.name)
    : inferFlatEdges(employees, executive?.name)

  // Collect all node IDs that appear in edges
  const connectedIds = new Set<string>()
  for (const [src, tgt] of hierEdges) {
    connectedIds.add(src)
    connectedIds.add(tgt)
  }

  // All employee IDs — connected ones first, then orphans
  const allIds = employees.map((e) => e.name)

  // Global Dagre layout — single tree, top-to-bottom
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: "TB",
    nodesep: 50,
    ranksep: 100,
    marginx: 40,
    marginy: 40,
  })

  for (const id of allIds) {
    g.setNode(id, { width: NODE_W, height: NODE_H })
  }
  for (const [src, tgt] of hierEdges) {
    if (empMap.has(src) && empMap.has(tgt)) {
      g.setEdge(src, tgt)
    }
  }

  dagre.layout(g)

  // Build ReactFlow nodes
  const nodes: Node[] = []
  for (const id of allIds) {
    const emp = empMap.get(id)
    const pos = g.node(id)
    if (!emp || !pos) continue
    nodes.push({
      id: emp.name,
      type: "employeeNode",
      data: emp as unknown as Record<string, unknown>,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      selected: emp.name === selectedName,
    })
  }

  // Build ReactFlow edges
  const edges: Edge[] = []
  const nodeIdSet = new Set(nodes.map((n) => n.id))

  for (const [src, tgt] of hierEdges) {
    if (!nodeIdSet.has(src) || !nodeIdSet.has(tgt)) continue
    const isHighlighted = selectedName === src || selectedName === tgt
    edges.push({
      id: `hier-${src}-${tgt}`,
      source: src,
      target: tgt,
      type: "smoothstep",
      style: {
        stroke: isHighlighted ? "var(--accent)" : "var(--text-quaternary)",
        strokeWidth: isHighlighted ? 2.5 : 1.5,
        opacity: isHighlighted ? 1 : 0.5,
      },
      animated: isHighlighted,
    })
  }

  return { nodes, edges }
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, CircleDot, Focus, Search, Sparkles, X } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { api, type WorkItemCompactWire } from "@/lib/api"
import { buildConstellation, type ConstellationGraph, type ConstellationKind, type ConstellationNode } from "@/lib/constellation"
import { useOrg } from "@/hooks/use-employees"
import { useSessions } from "@/hooks/use-sessions"
import "./constellation.css"

type Lens = "all" | "employee" | "todo" | "session"
type Point = { x: number; y: number }

const VIEW = { width: 1440, height: 920 }
const KIND_LABEL: Record<ConstellationKind, string> = {
  employee: "People",
  todo: "Work",
  session: "Pulse",
  department: "Systems",
}

async function fetchConstellationTodos(): Promise<WorkItemCompactWire[]> {
  const workItems: WorkItemCompactWire[] = []
  let offset = 0
  for (;;) {
    const page = await api.listWorkItems({ offset, limit: 100 })
    workItems.push(...page.workItems)
    if (page.nextOffset == null || workItems.length >= 500) break
    offset = page.nextOffset
  }
  return workItems
}

function hash(value: string): number {
  let n = 2166136261
  for (let index = 0; index < value.length; index += 1) n = Math.imul(n ^ value.charCodeAt(index), 16777619)
  return n >>> 0
}

function placeDepartments(graph: ConstellationGraph, points: Map<string, Point>, center: Point): Map<string, Point> {
  const departments = graph.nodes.filter((node) => node.kind === "department")
  const departmentPoint = new Map<string, Point>()
  departments.forEach((node, index) => {
    const angle = (index / Math.max(1, departments.length)) * Math.PI * 2 - Math.PI / 2
    const radius = departments.length === 1 ? 0 : 185
    const point = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }
    points.set(node.id, point)
    departmentPoint.set(node.group, point)
  })
  return departmentPoint
}

function placeEmployees(graph: ConstellationGraph, points: Map<string, Point>, departmentPoint: Map<string, Point>, center: Point) {
  const employeesByGroup = new Map<string, ConstellationNode[]>()
  for (const node of graph.nodes.filter((item) => item.kind === "employee")) {
    const list = employeesByGroup.get(node.group) ?? []
    list.push(node)
    employeesByGroup.set(node.group, list)
  }
  for (const [group, employees] of employeesByGroup) {
    const origin = departmentPoint.get(group) ?? center
    employees.forEach((node, index) => {
      const angle = (index / Math.max(1, employees.length)) * Math.PI * 2 + (hash(group) % 360) * Math.PI / 180
      const radius = 92 + (index % 3) * 18
      points.set(node.id, { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius })
    })
  }
}

function placeSatellites(graph: ConstellationGraph, points: Map<string, Point>, departmentPoint: Map<string, Point>, center: Point) {
  const satellites = graph.nodes.filter((node) => node.kind === "todo" || node.kind === "session")
  const edgeParent = new Map(graph.edges.filter((edge) => edge.kind === "owns" || edge.kind === "runs").map((edge) => [edge.source, edge.target]))
  const counts = new Map<string, number>()
  for (const node of satellites) {
    const parent = edgeParent.get(node.id)
    const origin = parent ? points.get(parent) : undefined
    const groupOrigin = departmentPoint.get(node.group) ?? center
    const anchor = origin ?? groupOrigin
    const sibling = counts.get(parent ?? node.group) ?? 0
    counts.set(parent ?? node.group, sibling + 1)
    const seed = hash(node.id)
    const angle = ((seed % 360) * Math.PI) / 180 + sibling * 0.76
    const radius = node.kind === "todo" ? 150 + (sibling % 4) * 24 : 218 + (sibling % 5) * 25
    points.set(node.id, {
      x: Math.max(44, Math.min(VIEW.width - 44, anchor.x + Math.cos(angle) * radius)),
      y: Math.max(44, Math.min(VIEW.height - 44, anchor.y + Math.sin(angle) * radius * 0.72)),
    })
  }
}

function layoutGraph(graph: ConstellationGraph): Map<string, Point> {
  const points = new Map<string, Point>()
  const center = { x: VIEW.width / 2, y: VIEW.height / 2 }
  const departmentPoint = placeDepartments(graph, points, center)
  placeEmployees(graph, points, departmentPoint, center)
  placeSatellites(graph, points, departmentPoint, center)
  return points
}

interface Particle { x: number; y: number; vx: number; vy: number; size: number }
interface ParticleScene { width: number; height: number; pointer: Point; reduced: boolean }

function makeParticles(reduced: boolean): Particle[] {
  return Array.from({ length: reduced ? 30 : 92 }, (_, index) => ({
      x: (hash(`x:${index}`) % 1000) / 1000,
      y: (hash(`y:${index}`) % 1000) / 1000,
      vx: ((hash(`vx:${index}`) % 100) - 50) / 8500,
      vy: ((hash(`vy:${index}`) % 100) - 50) / 8500,
      size: 0.5 + (hash(`s:${index}`) % 18) / 10,
  }))
}

function paintParticles(context: CanvasRenderingContext2D, particles: Particle[], scene: ParticleScene) {
  context.clearRect(0, 0, scene.width, scene.height)
  for (const particle of particles) {
    if (!scene.reduced) {
      particle.x = (particle.x + particle.vx + 1) % 1
      particle.y = (particle.y + particle.vy + 1) % 1
    }
    const x = particle.x * scene.width
    const y = particle.y * scene.height
    const glow = Math.max(0, 1 - Math.hypot(x - scene.pointer.x, y - scene.pointer.y) / 220)
    context.beginPath()
    context.fillStyle = `rgba(${110 + glow * 90}, ${155 + glow * 70}, 255, ${0.18 + glow * 0.52})`
    context.arc(x, y, particle.size + glow * 1.8, 0, Math.PI * 2)
    context.fill()
  }
}

function startParticles(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d")
  if (!context) return () => undefined
  const scene: ParticleScene = { width: 0, height: 0, pointer: { x: -1000, y: -1000 }, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches }
  const particles = makeParticles(scene.reduced)
  let frame = 0
  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    Object.assign(scene, { width: rect.width, height: rect.height })
    Object.assign(canvas, { width: Math.round(rect.width * ratio), height: Math.round(rect.height * ratio) })
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
  }
  const onPointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    scene.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const draw = () => {
    paintParticles(context, particles, scene)
    if (!scene.reduced) frame = requestAnimationFrame(draw)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  canvas.parentElement?.addEventListener("pointermove", onPointer)
  resize(); draw()
  return () => { cancelAnimationFrame(frame); observer.disconnect(); canvas.parentElement?.removeEventListener("pointermove", onPointer) }
}

function Particles() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (canvasRef.current) return startParticles(canvasRef.current)
  }, [])
  return <canvas ref={canvasRef} className="constellation-particles" aria-hidden="true" />
}

function nodeColor(node: ConstellationNode): string {
  if (node.status === "blocked" || node.status === "escalated" || node.status === "error") return "#ff6b7d"
  if (node.status === "running" || node.status === "executing") return "#79f2c0"
  if (node.kind === "employee") return "#b8a5ff"
  if (node.kind === "todo") return "#6ed6ff"
  if (node.kind === "department") return "#ffd47a"
  return "#8ba7ff"
}

function Header({ graph, query, onQuery }: { graph: ConstellationGraph; query: string; onQuery: (value: string) => void }) {
  return <header className="constellation-header">
    <div><div className="constellation-kicker"><Sparkles size={13} strokeWidth={1.5} /> Live company intelligence</div><h1>Constellation</h1><p>{graph.nodes.length} entities · {graph.edges.length} living relationships</p></div>
    <div className="constellation-search-shell"><Search size={16} strokeWidth={1.5} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Find a person, Todo, or session" aria-label="Search constellation" />{query && <button onClick={() => onQuery("")} aria-label="Clear search"><X size={14} /></button>}</div>
  </header>
}

function LensDock({ lens, onLens }: { lens: Lens; onLens: (lens: Lens) => void }) {
  return <div className="constellation-lenses" role="group" aria-label="Constellation layers">
    {(["all", "employee", "todo", "session"] as Lens[]).map((item) => {
      const label = item === "all" ? "All systems" : KIND_LABEL[item]
      return <button key={item} aria-label={label} className={lens === item ? "is-active" : ""} onClick={() => onLens(item)}><span />{label}</button>
    })}
  </div>
}

function GraphEdge({ edge, points }: { edge: ConstellationGraph["edges"][number]; points: Map<string, Point> }) {
  const source = points.get(edge.source)
  const target = points.get(edge.target)
  if (!source || !target) return null
  return <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={`constellation-edge edge-${edge.kind}`} />
}

function GraphNode({ node, point, index, active, onSelect }: { node: ConstellationNode; point: Point; index: number; active: boolean; onSelect: (id: string) => void }) {
  const radius = 9 + node.weight * 6
  const select = () => onSelect(node.id)
  return <g
    className={`constellation-node node-${node.kind}${active ? " is-selected" : ""}`}
    transform={`translate(${point.x} ${point.y})`}
    style={{ "--node-color": nodeColor(node), "--node-delay": `${(index % 20) * -0.18}s` } as React.CSSProperties}
    role="button" tabIndex={0} aria-label={`${KIND_LABEL[node.kind]}: ${node.label}. ${node.meta}`}
    onPointerDown={(event) => event.stopPropagation()} onClick={select}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") select() }}
  >
    <circle r={radius * 1.9} className="node-aura" /><circle r={radius} className="node-core" filter={active ? "url(#nodeGlow)" : undefined} />
    <circle r={radius * .38} fill="url(#coreFill)" className="node-light" />
    {(node.status === "running" || node.status === "executing") && <circle r={radius * 1.38} className="node-pulse" />}
    <text y={radius + 18} textAnchor="middle" className="node-label">{node.label.length > 26 ? `${node.label.slice(0, 24)}…` : node.label}</text>
  </g>
}

interface MapProps {
  graph: ConstellationGraph; points: Map<string, Point>; visible: Set<string>; selectedId: string | null
  transform: { x: number; y: number; scale: number }; busy: boolean; onSelect: (id: string) => void
  onWheel: (event: React.WheelEvent<SVGSVGElement>) => void; onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void
  onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void; onPointerEnd: () => void; onReset: () => void
}

function GraphStage(props: MapProps) {
  const edges = props.graph.edges.filter((edge) => props.visible.has(edge.source) && props.visible.has(edge.target))
  const layer = { department: 0, session: 1, todo: 2, employee: 3 }
  const nodes = props.graph.nodes
    .filter((node) => props.visible.has(node.id))
    .sort((first, second) => layer[first.kind] - layer[second.kind])
  return <div className="constellation-stage">
    {props.busy && <div className="constellation-loading"><span /> Mapping your company</div>}
    <svg className="constellation-map" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} role="img" aria-label="Interactive map of the Jinn organization, Todos, and sessions" onWheel={props.onWheel} onPointerDown={props.onPointerDown} onPointerMove={props.onPointerMove} onPointerUp={props.onPointerEnd} onPointerCancel={props.onPointerEnd}>
      <defs><filter id="nodeGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="7" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter><radialGradient id="coreFill"><stop offset="0" stopColor="#fff" stopOpacity=".96" /><stop offset=".22" stopColor="#b9d1ff" stopOpacity=".7" /><stop offset="1" stopColor="#7188ff" stopOpacity=".05" /></radialGradient></defs>
      <g transform={`translate(${props.transform.x} ${props.transform.y}) scale(${props.transform.scale})`} className="constellation-world">
        <circle cx={VIEW.width / 2} cy={VIEW.height / 2} r="335" className="constellation-orbit orbit-a" /><circle cx={VIEW.width / 2} cy={VIEW.height / 2} r="235" className="constellation-orbit orbit-b" />
        {edges.map((edge) => <GraphEdge key={edge.id} edge={edge} points={props.points} />)}
        {nodes.map((node, index) => <GraphNode key={node.id} node={node} point={props.points.get(node.id)!} index={index} active={props.selectedId === node.id} onSelect={props.onSelect} />)}
      </g>
    </svg>
    <button className="constellation-focus" onClick={props.onReset} aria-label="Reset constellation view"><Focus size={17} strokeWidth={1.5} /></button>
    <div className="constellation-legend"><span><i className="legend-running" /> Active</span><span><i className="legend-blocked" /> Blocked</span><span><i className="legend-system" /> System</span></div>
  </div>
}

function Inspector({ selected, graph, onClose }: { selected: ConstellationNode | null; graph: ConstellationGraph; onClose: () => void }) {
  const navigate = useNavigate()
  const connections = selected ? graph.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).length : 0
  return <aside className={`constellation-inspector${selected ? " is-open" : ""}`} aria-hidden={!selected}>{selected && <div className="constellation-inspector-core">
    <button className="inspector-close" onClick={onClose} aria-label="Close inspector"><X size={16} /></button>
    <div className="inspector-orb" style={{ "--node-color": nodeColor(selected) } as React.CSSProperties}><CircleDot size={28} strokeWidth={1.15} /></div>
    <span className="inspector-kind">{KIND_LABEL[selected.kind]}</span><h2>{selected.label}</h2><p>{selected.meta}</p>
    <dl><div><dt>Status</dt><dd>{selected.status}</dd></div><div><dt>System</dt><dd>{selected.group}</dd></div><div><dt>Connections</dt><dd>{connections}</dd></div></dl>
    {selected.href && <button className="inspector-open" onClick={() => navigate(selected.href!)}>Open in Jinn <span><ArrowUpRight size={15} strokeWidth={1.5} /></span></button>}
  </div>}</aside>
}

function usePanZoom() {
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const onWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => { event.preventDefault(); setTransform((current) => ({ ...current, scale: Math.max(.55, Math.min(2.25, current.scale * (event.deltaY > 0 ? .92 : 1.08))) })) }, [])
  const onPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => { drag.current = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y }; event.currentTarget.setPointerCapture(event.pointerId) }, [transform.x, transform.y])
  const onPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => { if (drag.current) setTransform((current) => ({ ...current, x: drag.current!.tx + event.clientX - drag.current!.x, y: drag.current!.ty + event.clientY - drag.current!.y })) }, [])
  const onPointerEnd = useCallback(() => { drag.current = null }, [])
  const onReset = useCallback(() => setTransform({ x: 0, y: 0, scale: 1 }), [])
  return { transform, onWheel, onPointerDown, onPointerMove, onPointerEnd, onReset }
}

export default function ConstellationPage() {
  const { data: org, isPending: orgPending } = useOrg()
  const { data: sessions = [], isPending: sessionsPending } = useSessions()
  const { data: todos = [], isPending: todosPending } = useQuery({ queryKey: ["constellation", "work-items"], queryFn: fetchConstellationTodos, staleTime: 10_000 })
  const [lens, setLens] = useState<Lens>("all")
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const panZoom = usePanZoom()
  const graph = useMemo(() => buildConstellation(org?.employees ?? [], todos, sessions), [org?.employees, todos, sessions])
  const points = useMemo(() => layoutGraph(graph), [graph])
  const normalizedQuery = query.trim().toLowerCase()
  const visible = useMemo(() => new Set(graph.nodes.filter((node) => {
    if (lens !== "all" && node.kind !== lens && node.kind !== "department") return false
    return !normalizedQuery || `${node.label} ${node.meta} ${node.group}`.toLowerCase().includes(normalizedQuery)
  }).map((node) => node.id)), [graph.nodes, lens, normalizedQuery])
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null
  const busy = orgPending || todosPending || sessionsPending

  return <PageLayout><div className="constellation-shell">
    <Particles /><div className="constellation-aurora" aria-hidden="true" />
    <Header graph={graph} query={query} onQuery={setQuery} /><LensDock lens={lens} onLens={setLens} />
    <GraphStage graph={graph} points={points} visible={visible} selectedId={selectedId} busy={busy} onSelect={setSelectedId} {...panZoom} />
    <Inspector selected={selected} graph={graph} onClose={() => setSelectedId(null)} />
  </div></PageLayout>
}

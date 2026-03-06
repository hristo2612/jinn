"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  Home,
  MessageSquare,
  Layers,
  Users,
  LayoutGrid,
  Clock,
  DollarSign,
  Activity,
  Zap,
  Settings,
} from "lucide-react"

const API =
  typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:7777"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string
  label: string
  subtitle?: string
  icon: React.ReactNode
  href: string
  category: "Pages" | "Employees" | "Cron Jobs"
}

interface Employee {
  id: string
  name: string
  title?: string
  emoji?: string
}

interface CronJob {
  id: string
  name: string
  schedule?: string
}

// ---------------------------------------------------------------------------
// Static pages
// ---------------------------------------------------------------------------

const STATIC_PAGES: SearchResult[] = [
  { id: "page-home", label: "Dashboard", icon: <Home size={16} />, href: "/", category: "Pages" },
  { id: "page-chat", label: "Chat", icon: <MessageSquare size={16} />, href: "/chat", category: "Pages" },
  { id: "page-sessions", label: "Sessions", icon: <Layers size={16} />, href: "/sessions", category: "Pages" },
  { id: "page-org", label: "Organization", icon: <Users size={16} />, href: "/org", category: "Pages" },
  { id: "page-kanban", label: "Kanban", icon: <LayoutGrid size={16} />, href: "/kanban", category: "Pages" },
  { id: "page-cron", label: "Cron", icon: <Clock size={16} />, href: "/cron", category: "Pages" },
  { id: "page-costs", label: "Costs", icon: <DollarSign size={16} />, href: "/costs", category: "Pages" },
  { id: "page-logs", label: "Activity", icon: <Activity size={16} />, href: "/logs", category: "Pages" },
  { id: "page-skills", label: "Skills", icon: <Zap size={16} />, href: "/skills", category: "Pages" },
  { id: "page-settings", label: "Settings", icon: <Settings size={16} />, href: "/settings", category: "Pages" },
]

// ---------------------------------------------------------------------------
// Simple fuzzy match (case-insensitive includes)
// ---------------------------------------------------------------------------

function fuzzyMatch(query: string, target: string): boolean {
  return target.toLowerCase().includes(query.toLowerCase())
}

// ---------------------------------------------------------------------------
// GlobalSearch component
// ---------------------------------------------------------------------------

export function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [crons, setCrons] = useState<CronJob[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  // Cmd+K / Ctrl+K toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  // Fetch data when modal opens
  useEffect(() => {
    if (!open) return
    setQuery("")
    setActiveIndex(0)

    fetch(`${API}/api/org`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: unknown) => {
        if (Array.isArray(data)) setEmployees(data as Employee[])
        else if (data && typeof data === "object" && "employees" in data) {
          setEmployees((data as { employees: Employee[] }).employees ?? [])
        }
      })
      .catch(() => setEmployees([]))

    fetch(`${API}/api/cron`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: unknown) => {
        if (Array.isArray(data)) setCrons(data as CronJob[])
        else if (data && typeof data === "object" && "crons" in data) {
          setCrons((data as { crons: CronJob[] }).crons ?? [])
        }
      })
      .catch(() => setCrons([]))
  }, [open])

  // Focus input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Prevent body scroll
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = ""
    }
    return () => {
      document.body.style.overflow = ""
    }
  }, [open])

  // Build filtered results
  const results = useMemo(() => {
    const all: SearchResult[] = [...STATIC_PAGES]

    employees.forEach((emp) => {
      all.push({
        id: `emp-${emp.id}`,
        label: emp.name,
        subtitle: emp.title,
        icon: <Users size={16} />,
        href: `/org`,
        category: "Employees",
      })
    })

    crons.forEach((c) => {
      all.push({
        id: `cron-${c.id}`,
        label: c.name,
        subtitle: c.schedule,
        icon: <Clock size={16} />,
        href: "/cron",
        category: "Cron Jobs",
      })
    })

    if (!query.trim()) return all

    return all.filter(
      (r) =>
        fuzzyMatch(query, r.label) ||
        (r.subtitle && fuzzyMatch(query, r.subtitle))
    )
  }, [query, employees, crons])

  // Group by category
  const grouped = useMemo(() => {
    const groups: { category: string; items: SearchResult[] }[] = []
    const order: SearchResult["category"][] = ["Pages", "Employees", "Cron Jobs"]
    for (const cat of order) {
      const items = results.filter((r) => r.category === cat)
      if (items.length > 0) groups.push({ category: cat, items })
    }
    return groups
  }, [results])

  const flatResults = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

  // Navigate to result
  const navigate = useCallback(
    (result: SearchResult) => {
      setOpen(false)
      router.push(result.href)
    },
    [router]
  )

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        setOpen(false)
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIndex((prev) => Math.min(prev + 1, flatResults.length - 1))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIndex((prev) => Math.max(prev - 1, 0))
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        if (flatResults[activeIndex]) navigate(flatResults[activeIndex])
        return
      }
    },
    [activeIndex, flatResults, navigate]
  )

  // Reset active index on query change
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector('[data-active="true"]')
    if (el) el.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  if (!open) return null

  let flatIndex = 0

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "20vh",
      }}
    >
      {/* Backdrop */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Jimmy"
        className="animate-scale-in"
        onKeyDown={handleKeyDown}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 560,
          margin: "0 16px",
          borderRadius: "var(--radius-xl)",
          background: "var(--bg-secondary)",
          border: "1px solid var(--separator)",
          boxShadow: "var(--shadow-overlay)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: 480,
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: "1px solid var(--separator)",
          }}
        >
          <Search
            size={18}
            style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Jimmy..."
            aria-label="Search Jimmy"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 15,
              color: "var(--text-primary)",
              fontFamily: "inherit",
            }}
          />
          <kbd
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--fill-quaternary)",
              color: "var(--text-quaternary)",
              border: "1px solid var(--separator)",
              lineHeight: "16px",
            }}
          >
            esc
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Search results"
          style={{ flex: 1, overflowY: "auto", padding: 8 }}
        >
          {flatResults.length === 0 && query.trim() && (
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
                color: "var(--text-tertiary)",
                fontSize: 13,
              }}
            >
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {grouped.map((group) => (
            <div key={group.category} style={{ marginBottom: 4 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-tertiary)",
                  padding: "6px 8px 4px",
                }}
              >
                {group.category}
              </div>

              {group.items.map((item) => {
                const currentIndex = flatIndex++
                const isActive = currentIndex === activeIndex

                return (
                  <button
                    key={item.id}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    onClick={() => navigate(item)}
                    onMouseEnter={() => setActiveIndex(currentIndex)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      minHeight: 40,
                      padding: "8px 10px",
                      borderRadius: "var(--radius-sm)",
                      border: "none",
                      background: isActive ? "var(--accent-fill)" : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 80ms var(--ease-smooth)",
                      outline: "none",
                      color: "var(--text-primary)",
                      fontFamily: "inherit",
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 6,
                        background: "var(--fill-quaternary)",
                        flexShrink: 0,
                        color: "var(--text-secondary)",
                      }}
                    >
                      {item.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.label}
                      </div>
                      {item.subtitle && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-tertiary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Footer hints */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: "8px 16px",
            borderTop: "1px solid var(--separator)",
            fontSize: 11,
            color: "var(--text-quaternary)",
          }}
        >
          <span>
            <kbd style={{ fontFamily: "var(--font-mono)" }}>{"\u2191\u2193"}</kbd> Navigate
          </span>
          <span>
            <kbd style={{ fontFamily: "var(--font-mono)" }}>{"\u21B5"}</kbd> Open
          </span>
          <span>
            <kbd style={{ fontFamily: "var(--font-mono)" }}>esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}

"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "@/lib/api"
import { describeCron, formatDuration } from "@/lib/cron-utils"
import { PageLayout } from "@/components/page-layout"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { WeeklySchedule } from "@/components/crons/weekly-schedule"
import { PipelineGraph } from "@/components/crons/pipeline-graph"

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  timezone?: string
  engine?: string
  model?: string
  employee?: string
  prompt?: string
  delivery?: unknown
  [key: string]: unknown
}

interface CronRun {
  id?: string
  ts?: string
  startedAt?: string
  finishedAt?: string
  status?: string
  durationMs?: number
  error?: string
  [key: string]: unknown
}

type Filter = "all" | "enabled" | "disabled"

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "never"
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return "\u2014"
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  const hrs = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  if (hrs < 24) return `${hrs}h ago`
  return `${days}d ago`
}

/* ------------------------------------------------------------------ */
/*  RecentRuns (lazy-loaded per job)                                    */
/* ------------------------------------------------------------------ */

function RecentRuns({ jobId }: { jobId: string }) {
  const [runs, setRuns] = useState<CronRun[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .getCronRuns(jobId)
      .then((data) => {
        setRuns((data as CronRun[]).slice(0, 5))
        setLoading(false)
      })
      .catch(() => {
        setRuns([])
        setLoading(false)
      })
  }, [jobId])

  if (loading) {
    return (
      <div style={{ marginTop: "var(--space-3)" }}>
        <div style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
          Recent Runs
        </div>
        {[1, 2, 3].map(i => (
          <Skeleton key={i} style={{ height: 16, marginBottom: 4, width: "80%" }} />
        ))}
      </div>
    )
  }

  if (!runs || runs.length === 0) {
    return (
      <div style={{ marginTop: "var(--space-3)" }}>
        <div style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
          Recent Runs
        </div>
        <div style={{ fontSize: "var(--text-caption2)", color: "var(--text-tertiary)" }}>No run history</div>
      </div>
    )
  }

  return (
    <div style={{ marginTop: "var(--space-3)" }}>
      <div style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
        Recent Runs
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {runs.map((run, i) => {
          const ts = run.ts || run.startedAt || ""
          const status = run.status || "unknown"
          const statusDot =
            status === "success" || status === "ok" ? "var(--system-green)"
            : status === "error" || status === "failed" ? "var(--system-red)"
            : "var(--text-tertiary)"
          const ago = timeAgo(ts)
          const duration = run.durationMs != null ? formatDuration(run.durationMs) : "\u2014"

          return (
            <div
              key={`${ts}-${i}`}
              className="flex items-center"
              style={{
                gap: "var(--space-2)",
                fontSize: "var(--text-caption2)",
                minHeight: 22,
                padding: "2px 0",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusDot, flexShrink: 0 }} />
              <span style={{ color: "var(--text-tertiary)", minWidth: 52, flexShrink: 0 }}>{ago}</span>
              <span style={{ color: "var(--text-secondary)", minWidth: 52, flexShrink: 0 }}>{duration}</span>
              <span style={{ color: "var(--text-secondary)", textTransform: "capitalize" }}>{status}</span>
              {run.error && (
                <span className="truncate" style={{ color: "var(--system-red)", minWidth: 0, flex: 1 }}>
                  {run.error}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [updatedAgo, setUpdatedAgo] = useState("just now")
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const refresh = useCallback(() => {
    setError(null)
    api
      .getCronJobs()
      .then((data) => {
        setJobs(data as CronJob[])
        setLastRefresh(new Date())
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unknown error"))
      .finally(() => setLoading(false))
  }, [])

  // Initial load + auto-refresh every 60s
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 60000)
    return () => clearInterval(interval)
  }, [refresh])

  // "Updated X ago" ticker
  useEffect(() => {
    const tick = () => setUpdatedAgo(timeAgo(lastRefresh.toISOString()))
    tick()
    const interval = setInterval(tick, 30000)
    return () => clearInterval(interval)
  }, [lastRefresh])

  // Toggle enabled via PUT
  function toggleEnabled(job: CronJob) {
    const newEnabled = !job.enabled
    api
      .updateCronJob(job.id, { enabled: newEnabled })
      .then(() => {
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, enabled: newEnabled } : j))
        )
      })
      .catch(() => {})
  }

  // Derived data
  const enabledCount = jobs.filter(j => j.enabled).length
  const disabledCount = jobs.filter(j => !j.enabled).length
  const filtered = jobs.filter(j => {
    if (filter === "enabled") return j.enabled
    if (filter === "disabled") return !j.enabled
    return true
  })

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
        {/* Header */}
        <header
          className="flex-shrink-0"
          style={{
            background: "var(--material-regular)",
            borderBottom: "1px solid var(--separator)",
            padding: "var(--space-4) var(--space-6)",
          }}
        >
          <div className="flex items-center justify-between">
            <div>
              <h1 style={{
                fontSize: "var(--text-title1)",
                fontWeight: 700,
                color: "var(--text-primary)",
                letterSpacing: "-0.5px",
                lineHeight: 1.2,
              }}>
                Cron Jobs
              </h1>
              {!loading && (
                <p style={{
                  fontSize: "var(--text-footnote)",
                  color: "var(--text-secondary)",
                  marginTop: "var(--space-1)",
                }}>
                  {jobs.length} total &middot; {enabledCount} enabled &middot; {disabledCount} disabled
                </p>
              )}
            </div>
            <div className="flex items-center" style={{ gap: "var(--space-3)" }}>
              <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)" }}>
                Updated {updatedAgo}
              </span>
              <button
                onClick={refresh}
                aria-label="Refresh cron data"
                style={{
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-tertiary)",
                  cursor: "pointer",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                  <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                </svg>
              </button>
            </div>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto" style={{ padding: "var(--space-4) var(--space-6) var(--space-6)" }}>
          {error && jobs.length === 0 ? (
            <div style={{
              background: "rgba(255,69,58,0.06)",
              border: "1px solid var(--system-red)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-4)",
              color: "var(--system-red)",
              fontSize: "var(--text-footnote)",
              marginBottom: "var(--space-4)",
            }}>
              Failed to load cron jobs: {error}
              <button
                onClick={refresh}
                style={{
                  marginLeft: "var(--space-3)",
                  textDecoration: "underline",
                  background: "none",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: "inherit",
                }}
              >
                Retry
              </button>
            </div>
          ) : loading ? (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
                {[1, 2, 3].map(i => (
                  <div key={i} style={{ background: "var(--material-regular)", border: "1px solid var(--separator)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
                    <Skeleton style={{ width: 60, height: 10, marginBottom: 8 }} />
                    <Skeleton style={{ width: 80, height: 14 }} />
                  </div>
                ))}
              </div>
              {[1, 2, 3, 4].map(i => (
                <Skeleton key={i} style={{ height: 48, marginBottom: 4, borderRadius: "var(--radius-sm)" }} />
              ))}
            </div>
          ) : (
            <Tabs defaultValue="overview">
              <TabsList variant="line">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="schedule">Schedule</TabsTrigger>
                <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
              </TabsList>

              {/* ─── OVERVIEW TAB ────────────────────────────── */}
              <TabsContent value="overview">
                {/* Summary cards */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: "var(--space-3)",
                  marginBottom: "var(--space-4)",
                  marginTop: "var(--space-4)",
                }}>
                  <SummaryCard label="Total Jobs" value={jobs.length} />
                  <SummaryCard label="Enabled" value={enabledCount} color="var(--system-green)" />
                  <SummaryCard label="Disabled" value={disabledCount} color="var(--text-tertiary)" />
                </div>

                {/* Filter pills */}
                <div className="flex items-center" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                  {(["all", "enabled", "disabled"] as Filter[]).map(f => {
                    const isActive = filter === f
                    const count = f === "all" ? jobs.length : f === "enabled" ? enabledCount : disabledCount
                    return (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        style={{
                          borderRadius: 20,
                          padding: "6px 14px",
                          fontSize: "var(--text-footnote)",
                          fontWeight: 500,
                          border: "none",
                          cursor: "pointer",
                          transition: "all 200ms ease",
                          background: isActive ? "var(--accent-fill)" : "var(--fill-secondary)",
                          color: isActive ? "var(--accent)" : "var(--text-primary)",
                        }}
                      >
                        {f.charAt(0).toUpperCase() + f.slice(1)} ({count})
                      </button>
                    )
                  })}
                </div>

                {/* Job list */}
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center" style={{ height: 200, color: "var(--text-secondary)", gap: "var(--space-2)" }}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-tertiary)", marginBottom: "var(--space-2)" }}>
                      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span style={{ fontSize: "var(--text-subheadline)", fontWeight: 500 }}>
                      {jobs.length === 0 ? "No cron jobs configured" : "No jobs match this filter"}
                    </span>
                  </div>
                ) : (
                  <div style={{
                    borderRadius: "var(--radius-md)",
                    overflow: "hidden",
                    background: "var(--material-regular)",
                    border: "1px solid var(--separator)",
                  }}>
                    {filtered.map((job, idx) => {
                      const isExpanded = expandedId === job.id

                      return (
                        <div key={job.id}>
                          {idx > 0 && (
                            <div style={{ height: 1, background: "var(--separator)", marginLeft: "var(--space-4)", marginRight: "var(--space-4)" }} />
                          )}

                          {/* Row */}
                          <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={isExpanded}
                            onClick={() => setExpandedId(isExpanded ? null : job.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault()
                                setExpandedId(isExpanded ? null : job.id)
                              }
                            }}
                            className="flex items-center cursor-pointer"
                            style={{
                              minHeight: 48,
                              padding: "0 var(--space-4)",
                              borderLeft: `3px solid ${job.enabled ? "var(--system-green)" : "transparent"}`,
                              transition: "background 150ms ease",
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--fill-secondary)" }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "" }}
                          >
                            {/* Status dot */}
                            <span style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: job.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                              flexShrink: 0,
                            }} />

                            {/* Name + schedule */}
                            <div className="min-w-0 flex-1" style={{ marginLeft: 12, display: "flex", flexDirection: "column" }}>
                              <span className="truncate" style={{
                                fontSize: "var(--text-footnote)",
                                fontWeight: 600,
                                color: "var(--text-primary)",
                              }}>
                                {job.name}
                              </span>
                              <span style={{
                                fontSize: "var(--text-caption1)",
                                color: "var(--text-tertiary)",
                              }}>
                                {describeCron(job.schedule)}
                              </span>
                            </div>

                            {/* Metadata badges */}
                            <div className="flex items-center flex-shrink-0" style={{ gap: "var(--space-2)", marginLeft: "auto" }}>
                              {job.employee && (
                                <span style={{
                                  fontSize: "var(--text-caption1)",
                                  padding: "1px 8px",
                                  borderRadius: 12,
                                  background: "color-mix(in srgb, var(--system-blue) 15%, transparent)",
                                  color: "var(--system-blue)",
                                }}>
                                  {job.employee}
                                </span>
                              )}
                              {job.engine && (
                                <span style={{
                                  fontSize: "var(--text-caption1)",
                                  padding: "1px 8px",
                                  borderRadius: 12,
                                  background: "var(--fill-tertiary)",
                                  color: "var(--text-tertiary)",
                                }}>
                                  {job.engine}
                                </span>
                              )}

                              {/* Enable/disable toggle */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleEnabled(job)
                                }}
                                aria-label={job.enabled ? "Disable job" : "Enable job"}
                                style={{
                                  position: "relative",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  width: 36,
                                  height: 20,
                                  borderRadius: 10,
                                  border: "none",
                                  cursor: "pointer",
                                  background: job.enabled ? "var(--system-green)" : "var(--fill-tertiary)",
                                  transition: "background 200ms ease",
                                  flexShrink: 0,
                                }}
                              >
                                <span style={{
                                  display: "block",
                                  width: 14,
                                  height: 14,
                                  borderRadius: "50%",
                                  background: "white",
                                  transition: "transform 200ms ease",
                                  transform: job.enabled ? "translateX(18px)" : "translateX(3px)",
                                }} />
                              </button>

                              {/* Chevron */}
                              <span style={{
                                fontSize: "var(--text-footnote)",
                                color: "var(--text-tertiary)",
                                transition: "transform 200ms ease",
                                transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                display: "inline-block",
                              }}>
                                &#8250;
                              </span>
                            </div>
                          </div>

                          {/* Expanded detail */}
                          {isExpanded && (
                            <div style={{ padding: "0 var(--space-4) var(--space-4) var(--space-4)", marginLeft: 3 }}>
                              <div style={{
                                display: "grid",
                                gridTemplateColumns: "auto 1fr",
                                gap: "var(--space-1) var(--space-4)",
                                marginTop: "var(--space-2)",
                                marginBottom: "var(--space-3)",
                              }}>
                                <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)" }}>Schedule</span>
                                <div>
                                  <div style={{ fontSize: "var(--text-caption1)", color: "var(--text-secondary)" }}>
                                    {describeCron(job.schedule)}
                                  </div>
                                  <div style={{ fontSize: "var(--text-caption2)", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", marginTop: 2 }}>
                                    {job.schedule}
                                    {job.timezone && <span style={{ marginLeft: 8 }}>({job.timezone})</span>}
                                  </div>
                                </div>

                                <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)" }}>Status</span>
                                <span style={{
                                  fontSize: "var(--text-caption1)",
                                  color: job.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                                  fontWeight: 500,
                                }}>
                                  {job.enabled ? "Enabled" : "Disabled"}
                                </span>

                                {job.engine && (
                                  <>
                                    <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)" }}>Engine</span>
                                    <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-secondary)" }}>{job.engine}</span>
                                  </>
                                )}

                                {job.model && (
                                  <>
                                    <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)" }}>Model</span>
                                    <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>{job.model}</span>
                                  </>
                                )}

                                {job.employee && (
                                  <>
                                    <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-tertiary)" }}>Employee</span>
                                    <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-secondary)" }}>{job.employee}</span>
                                  </>
                                )}
                              </div>

                              {/* Run history */}
                              <RecentRuns jobId={job.id} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </TabsContent>

              {/* ─── SCHEDULE TAB ─────────────────────────────── */}
              <TabsContent value="schedule">
                <div style={{ marginTop: "var(--space-4)" }}>
                  <WeeklySchedule crons={jobs} />
                </div>
              </TabsContent>

              {/* ─── PIPELINES TAB ────────────────────────────── */}
              <TabsContent value="pipelines">
                <div style={{ marginTop: "var(--space-4)" }}>
                  <PipelineGraph crons={jobs} />
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </PageLayout>
  )
}

/* ------------------------------------------------------------------ */
/*  Summary Card                                                       */
/* ------------------------------------------------------------------ */

function SummaryCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div
      style={{
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-4)",
      }}
    >
      <div style={{
        fontSize: "var(--text-caption1)",
        color: "var(--text-tertiary)",
        fontWeight: 500,
        marginBottom: "var(--space-1)",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: "var(--text-title2)",
        fontWeight: 700,
        color: color || "var(--text-primary)",
      }}>
        {value}
      </div>
    </div>
  )
}

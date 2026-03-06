"use client"

import { useMemo, useState, useRef, useEffect, useCallback } from "react"
import { parseScheduleSlots, describeCron } from "@/lib/cron-utils"

interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  employee?: string
  [key: string]: unknown
}

interface WeeklyScheduleProps {
  crons: CronJob[]
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const DAY_LABELS_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
// Map cron dow (0=Sun) to grid column (0=Mon)
const DOW_TO_COL: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 }

function formatHourShort(h: number): string {
  if (h === 0 || h === 24) return "12a"
  if (h === 12) return "12p"
  return h < 12 ? `${h}a` : `${h - 12}p`
}

function formatHour(h: number): string {
  if (h === 0 || h === 24) return "12 AM"
  if (h === 12) return "12 PM"
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

interface SlotInfo {
  cron: CronJob
  hour: number
  minute: number
  col: number
}

interface TooltipData {
  slot: SlotInfo
  rect: DOMRect
}

function PillTooltip({ slot, rect, containerRect }: { slot: SlotInfo; rect: DOMRect; containerRect: DOMRect }) {
  const color = slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)"
  const top = rect.top - containerRect.top - 8
  const left = rect.left - containerRect.left + rect.width / 2

  return (
    <div
      style={{
        position: "absolute",
        top,
        left,
        transform: "translate(-50%, -100%)",
        background: "var(--material-regular)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-3) var(--space-4)",
        fontSize: "var(--text-caption1)",
        color: "var(--text-primary)",
        pointerEvents: "none",
        zIndex: 100,
        minWidth: 200,
        maxWidth: 300,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2)",
      }}
    >
      {/* Arrow */}
      <div
        style={{
          position: "absolute",
          bottom: -5,
          left: "50%",
          transform: "translateX(-50%) rotate(45deg)",
          width: 10,
          height: 10,
          background: "var(--material-regular)",
          borderRight: "1px solid var(--separator)",
          borderBottom: "1px solid var(--separator)",
        }}
      />
      {/* Name */}
      <div style={{
        fontWeight: 700,
        fontSize: "var(--text-footnote)",
        marginBottom: "var(--space-1)",
        borderLeft: `3px solid ${color}`,
        paddingLeft: "var(--space-2)",
      }}>
        {slot.cron.name}
      </div>
      {/* Schedule */}
      <div style={{ color: "var(--text-secondary)", fontSize: "var(--text-caption1)", marginBottom: "var(--space-2)" }}>
        {describeCron(slot.cron.schedule)}
      </div>
      {/* Raw cron */}
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-caption2)", color: "var(--text-tertiary)", marginBottom: "var(--space-2)" }}>
        {slot.cron.schedule}
      </div>
      {/* Status */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-caption1)" }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
            flexShrink: 0,
          }}
        />
        <span style={{
          color: slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
          fontWeight: 500,
        }}>
          {slot.cron.enabled ? "Enabled" : "Disabled"}
        </span>
        {slot.cron.employee && (
          <span style={{ color: "var(--text-tertiary)", marginLeft: "var(--space-1)" }}>
            {slot.cron.employee}
          </span>
        )}
      </div>
    </div>
  )
}

export function WeeklySchedule({ crons }: WeeklyScheduleProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null)

  const updateContainerRect = useCallback(() => {
    if (containerRef.current) {
      setContainerRect(containerRef.current.getBoundingClientRect())
    }
  }, [])

  useEffect(() => {
    updateContainerRect()
    const el = containerRef.current
    if (!el) return

    window.addEventListener("resize", updateContainerRect, { passive: true })
    return () => {
      window.removeEventListener("resize", updateContainerRect)
    }
  }, [updateContainerRect])

  // Parse all crons into schedule slots, grouped by (col, hour)
  const { slotsByDayHour, activeHours } = useMemo(() => {
    const map = new Map<string, SlotInfo[]>()
    const hourSet = new Set<number>()

    for (const cron of crons) {
      if (!cron.enabled) continue
      const parsed = parseScheduleSlots(cron.schedule)
      if (!parsed) continue

      for (const dow of parsed.days) {
        const col = DOW_TO_COL[dow]
        if (col === undefined) continue
        const key = `${col}-${parsed.hour}`
        const existing = map.get(key) || []
        existing.push({ cron, hour: parsed.hour, minute: parsed.minute, col })
        map.set(key, existing)
        hourSet.add(parsed.hour)
      }
    }

    // Sort slots within each cell by minute, then name
    for (const [key, slots] of map) {
      map.set(key, slots.sort((a, b) => a.minute - b.minute || a.cron.name.localeCompare(b.cron.name)))
    }

    const activeHours = Array.from(hourSet).sort((a, b) => a - b)
    return { slotsByDayHour: map, activeHours }
  }, [crons])

  // Current day/time
  const now = new Date()
  const nowDow = now.getDay()
  const nowCol = DOW_TO_COL[nowDow]
  const nowHour = now.getHours()
  const nowMinuteFrac = now.getMinutes() / 60

  // Find max pills in any cell for a given hour
  const maxPillsPerHour = useMemo(() => {
    const result = new Map<number, number>()
    for (const hour of activeHours) {
      let max = 0
      for (let col = 0; col < 7; col++) {
        const key = `${col}-${hour}`
        const count = slotsByDayHour.get(key)?.length || 0
        if (count > max) max = count
      }
      result.set(hour, max)
    }
    return result
  }, [activeHours, slotsByDayHour])

  function handlePillEnter(slot: SlotInfo, e: React.MouseEvent<HTMLButtonElement>) {
    const pillRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    updateContainerRect()
    setTooltip({ slot, rect: pillRect })
  }

  // Close tooltip when clicking outside
  useEffect(() => {
    if (!tooltip) return
    const handler = () => setTooltip(null)
    document.addEventListener("click", handler)
    return () => document.removeEventListener("click", handler)
  }, [tooltip])

  if (activeHours.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{
          height: 200,
          color: "var(--text-secondary)",
          gap: "var(--space-2)",
        }}
      >
        <svg
          width="32" height="32" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ color: "var(--text-tertiary)", marginBottom: "var(--space-2)" }}
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span style={{ fontSize: "var(--text-subheadline)", fontWeight: 500 }}>
          No scheduled jobs to display
        </span>
        <span style={{ fontSize: "var(--text-footnote)", color: "var(--text-tertiary)" }}>
          Enable some cron jobs to see the weekly schedule
        </span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "relative" }}
      onClick={() => setTooltip(null)}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "56px repeat(7, 1fr)",
          background: "var(--material-regular)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--separator)",
          overflow: "hidden",
        }}
      >
        {/* Header row */}
        <div
          style={{
            padding: "var(--space-3) var(--space-2)",
            borderBottom: "1px solid var(--separator)",
            background: "var(--material-thick)",
          }}
        />
        {DAY_LABELS.map((label, i) => {
          const isToday = i === nowCol
          return (
            <div
              key={label}
              style={{
                padding: "var(--space-3) var(--space-2)",
                textAlign: "center",
                borderBottom: "1px solid var(--separator)",
                borderLeft: "1px solid var(--separator)",
                background: isToday ? "var(--accent-fill)" : "var(--material-thick)",
                position: "relative",
              }}
            >
              <div
                title={DAY_LABELS_FULL[i]}
                style={{
                  fontSize: "var(--text-footnote)",
                  fontWeight: isToday ? 700 : 600,
                  color: isToday ? "var(--accent)" : "var(--text-primary)",
                  letterSpacing: "0.02em",
                }}
              >
                {label}
              </div>
              {isToday && (
                <div style={{
                  position: "absolute",
                  bottom: -3,
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  zIndex: 2,
                }} />
              )}
            </div>
          )
        })}

        {/* Hour rows */}
        {activeHours.map((hour, hourIdx) => {
          const maxPills = maxPillsPerHour.get(hour) || 1
          const cellPadding = 8
          const pillHeight = 28
          const pillGap = 4
          const minCellHeight = cellPadding + maxPills * pillHeight + (maxPills - 1) * pillGap
          const isNowHour = hour === nowHour
          const isLastRow = hourIdx === activeHours.length - 1

          return (
            <div key={hour} style={{ display: "contents" }}>
              {/* Hour label cell */}
              <div
                style={{
                  padding: "var(--space-2)",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "flex-end",
                  borderBottom: isLastRow ? "none" : "1px solid var(--separator)",
                  minHeight: minCellHeight,
                  background: isNowHour ? "var(--accent-fill)" : undefined,
                  position: "relative",
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-caption1)",
                    fontFamily: "var(--font-mono)",
                    color: isNowHour ? "var(--accent)" : "var(--text-tertiary)",
                    fontWeight: isNowHour ? 600 : 400,
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                    paddingTop: 2,
                  }}
                  title={formatHour(hour)}
                >
                  {formatHourShort(hour)}
                </span>
              </div>

              {/* Day cells for this hour */}
              {Array.from({ length: 7 }, (_, col) => {
                const key = `${col}-${hour}`
                const slots = slotsByDayHour.get(key) || []
                const isToday = col === nowCol
                const isNowCell = isToday && isNowHour

                return (
                  <div
                    key={key}
                    style={{
                      padding: `${cellPadding / 2}px 4px`,
                      borderLeft: "1px solid var(--separator)",
                      borderBottom: isLastRow ? "none" : "1px solid var(--separator)",
                      minHeight: minCellHeight,
                      display: "flex",
                      flexDirection: "column",
                      gap: pillGap,
                      background: isNowCell
                        ? "color-mix(in srgb, var(--accent) 6%, transparent)"
                        : isToday
                          ? "color-mix(in srgb, var(--accent) 3%, transparent)"
                          : undefined,
                      position: "relative",
                    }}
                  >
                    {/* Current time indicator (red line) */}
                    {isNowCell && (
                      <div style={{
                        position: "absolute",
                        top: `${(nowMinuteFrac * 100).toFixed(1)}%`,
                        left: 0,
                        right: 0,
                        height: 2,
                        background: "var(--system-red)",
                        opacity: 0.8,
                        zIndex: 3,
                        borderRadius: 1,
                      }} />
                    )}

                    {/* Pills */}
                    {slots.map((slot, slotIdx) => {
                      const pillColor = slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)"
                      const isActive = tooltip?.slot.cron.id === slot.cron.id
                        && tooltip?.slot.col === slot.col
                        && tooltip?.slot.hour === slot.hour

                      return (
                        <button
                          key={`${key}-${slotIdx}`}
                          type="button"
                          title={`${slot.cron.name} - ${describeCron(slot.cron.schedule)}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            const pillRect = e.currentTarget.getBoundingClientRect()
                            updateContainerRect()
                            if (isActive) {
                              setTooltip(null)
                            } else {
                              setTooltip({ slot, rect: pillRect })
                            }
                          }}
                          onMouseEnter={(e) => handlePillEnter(slot, e)}
                          onMouseLeave={() => setTooltip(null)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            height: pillHeight,
                            padding: "0 6px",
                            borderRadius: "var(--radius-sm)",
                            border: "none",
                            cursor: "pointer",
                            width: "100%",
                            minWidth: 0,
                            background: isActive
                              ? `color-mix(in srgb, ${pillColor} 25%, transparent)`
                              : `color-mix(in srgb, ${pillColor} 12%, transparent)`,
                            borderLeft: `3px solid ${pillColor}`,
                            transition: "background 150ms ease, box-shadow 150ms ease",
                            boxShadow: isActive
                              ? `0 0 0 1px color-mix(in srgb, ${pillColor} 40%, transparent)`
                              : "none",
                            textAlign: "left",
                            position: "relative",
                            overflow: "hidden",
                          }}
                        >
                          {/* Status dot */}
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              flexShrink: 0,
                              background: slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                            }}
                          />
                          {/* Time */}
                          <span
                            style={{
                              fontSize: "var(--text-caption2)",
                              fontFamily: "var(--font-mono)",
                              color: "var(--text-tertiary)",
                              flexShrink: 0,
                              lineHeight: 1,
                            }}
                          >
                            {`:${String(slot.minute).padStart(2, "0")}`}
                          </span>
                          {/* Name */}
                          <span
                            style={{
                              fontSize: "var(--text-caption2)",
                              fontWeight: 600,
                              color: pillColor,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              minWidth: 0,
                              flex: 1,
                              lineHeight: 1,
                            }}
                          >
                            {slot.cron.name}
                          </span>
                        </button>
                      )
                    })}

                    {slots.length === 0 && <div style={{ flex: 1 }} />}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Tooltip overlay */}
      {tooltip && containerRect && (
        <PillTooltip
          slot={tooltip.slot}
          rect={tooltip.rect}
          containerRect={containerRect}
        />
      )}
    </div>
  )
}

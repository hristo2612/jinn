
import { useMemo, useState, useRef, useEffect, useCallback } from "react"
import { describeCron } from "@/lib/cron-utils"
import { weekDatesFor, weeklyScheduleSlots } from "@/lib/cron-week"
import { PillTooltip, type CronJob, type SlotInfo } from "./pill-tooltip"

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

interface TooltipData {
  slot: SlotInfo
  rect: DOMRect
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

  // Current day/time
  const now = new Date()
  // The columns are one real week, not a generic one, so a day-of-month or
  // month restriction can be resolved against the dates actually on screen.
  // Anchored to midnight so the memo below survives a re-render mid-day.
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const weekDates = useMemo(() => weekDatesFor(new Date(todayStart)), [todayStart])

  // Parse all crons into schedule slots, grouped by (col, hour)
  const { slotsByDayHour, activeHours } = useMemo(() => {
    const map = new Map<string, SlotInfo[]>()
    const hourSet = new Set<number>()

    for (const cron of crons) {
      if (!cron.enabled) continue
      const parsed = weeklyScheduleSlots(cron.schedule, weekDates)
      if (!parsed) continue

      for (const dow of parsed.days) {
        const col = DOW_TO_COL[dow]
        if (col === undefined) continue
        for (const slot of parsed.slots) {
          const key = `${col}-${slot.hour}`
          const existing = map.get(key) || []
          existing.push({ cron, hour: slot.hour, minute: slot.minute, col, aggregatedCount: parsed.aggregatedCount })
          map.set(key, existing)
          hourSet.add(slot.hour)
        }
      }
    }

    // Sort slots within each cell by minute, then name
    for (const [key, slots] of map) {
      map.set(key, slots.sort((a, b) => a.minute - b.minute || a.cron.name.localeCompare(b.cron.name)))
    }

    const activeHours = Array.from(hourSet).sort((a, b) => a - b)
    return { slotsByDayHour: map, activeHours }
  }, [crons, weekDates])

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
    // An enabled monthly job is now absent from the weeks it does not fire in,
    // so "enable a cron job" would be wrong advice for a populated instance.
    const hasEnabled = crons.some((cron) => cron.enabled)
    return (
      <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
        <div className="px-6 py-12 text-center">
          <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
            {hasEnabled ? "Nothing this week" : "Nothing on the calendar"}
          </h3>
          <p className="mx-auto mt-2 max-w-[320px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
            {hasEnabled
              ? "No enabled job fires between Monday and Sunday of this week."
              : "Enable a cron job to see when the week fires."}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onClick={() => setTooltip(null)}
    >
      {/* The grid needs ~640px for seven readable columns; narrower viewports
          scroll it sideways inside the inset instead of crushing the pills. */}
      <div className="overflow-x-auto rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
      <div className="grid min-w-[640px] grid-cols-[48px_repeat(7,minmax(0,1fr))]">
        {/* Header row */}
        <div className="border-b border-[var(--separator)] p-[var(--space-3)_var(--space-2)]" />
        {DAY_LABELS.map((label, i) => {
          const isToday = i === nowCol
          return (
            <div
              key={label}
              className="relative border-b border-l border-[var(--separator)] p-[var(--space-3)_var(--space-2)] text-center"
              style={{
                background: isToday ? "var(--accent-fill)" : undefined,
              }}
            >
              <div
                title={DAY_LABELS_FULL[i]}
                className="text-[length:var(--text-footnote)] tracking-[0.02em]"
                style={{
                  fontWeight: isToday ? 700 : 600,
                  color: isToday ? "var(--accent)" : "var(--text-primary)",
                }}
              >
                {label}
              </div>
              {isToday && (
                <div
                  className="absolute -bottom-[3px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[var(--accent)] z-[2]"
                />
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
            <div key={hour} className="contents">
              {/* Hour label cell */}
              <div
                className="p-[var(--space-2)] flex items-start justify-end relative"
                style={{
                  borderBottom: isLastRow ? "none" : "1px solid var(--separator)",
                  minHeight: minCellHeight,
                  background: isNowHour ? "var(--accent-fill)" : undefined,
                }}
              >
                <span
                  className="text-[length:var(--text-caption1)] font-[family-name:var(--font-mono)] leading-[1.2] whitespace-nowrap pt-0.5"
                  style={{
                    color: isNowHour ? "var(--accent)" : "var(--text-tertiary)",
                    fontWeight: isNowHour ? 600 : 400,
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
                    className="flex flex-col relative border-l border-[var(--separator)]"
                    style={{
                      padding: `${cellPadding / 2}px 4px`,
                      borderBottom: isLastRow ? "none" : "1px solid var(--separator)",
                      minHeight: minCellHeight,
                      gap: pillGap,
                      background: isNowCell
                        ? "color-mix(in srgb, var(--accent) 6%, transparent)"
                        : isToday
                          ? "color-mix(in srgb, var(--accent) 3%, transparent)"
                          : undefined,
                    }}
                  >
                    {/* Current time indicator (red line) */}
                    {isNowCell && (
                      <div
                        className="absolute left-0 right-0 h-0.5 bg-[var(--system-red)] opacity-80 z-[3] rounded-[1px]"
                        style={{ top: `${(nowMinuteFrac * 100).toFixed(1)}%` }}
                      />
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
                          className="flex items-center gap-[5px] px-1.5 rounded-[var(--radius-sm)] border-none cursor-pointer w-full min-w-0 text-left relative overflow-hidden transition-[background,box-shadow] duration-150 ease-in-out"
                          style={{
                            height: pillHeight,
                            background: isActive
                              ? `color-mix(in srgb, ${pillColor} 26%, transparent)`
                              : `color-mix(in srgb, ${pillColor} 12%, transparent)`,
                          }}
                        >
                          {/* Status dot */}
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{
                              background: slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                            }}
                          />
                          {/* Time — dense schedules aggregate into one counted pill */}
                          <span className="text-[length:var(--text-caption2)] font-[family-name:var(--font-mono)] text-[var(--text-tertiary)] shrink-0 leading-none">
                            {slot.aggregatedCount
                              ? `×${slot.aggregatedCount}/day`
                              : `:${String(slot.minute).padStart(2, "0")}`}
                          </span>
                          {/* Name */}
                          <span
                            className="text-[length:var(--text-caption2)] font-semibold overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-1 leading-none"
                            style={{ color: pillColor }}
                          >
                            {slot.cron.name}
                          </span>
                        </button>
                      )
                    })}

                    {slots.length === 0 && <div className="flex-1" />}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
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

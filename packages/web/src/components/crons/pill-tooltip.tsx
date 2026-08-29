import { describeCron } from "@/lib/cron-utils"

/* The pill's data shape and its hover card, split out of weekly-schedule.tsx so
 * the grid file holds only the grid. Both types describe what a pill *is*, so
 * they live with the card that renders one. */

export interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  employee?: string | null
  [key: string]: unknown
}

export interface SlotInfo {
  cron: CronJob
  hour: number
  minute: number
  col: number
  /** True per-day fire count when the schedule is too dense for one pill per
   *  fire — the pill renders once with this count instead. */
  aggregatedCount?: number
}

export function PillTooltip({ slot, rect, containerRect }: { slot: SlotInfo; rect: DOMRect; containerRect: DOMRect }) {
  const top = rect.top - containerRect.top - 8
  const left = rect.left - containerRect.left + rect.width / 2
  const statusColor = slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)"

  return (
    <div
      className="absolute pointer-events-none z-[100] min-w-[200px] max-w-[300px] rounded-[var(--radius-lg)] bg-[var(--bg-tertiary)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-primary)]"
      style={{
        top,
        left,
        transform: "translate(-50%, -100%)",
        boxShadow: "var(--shadow-overlay)",
      }}
    >
      {/* Name */}
      <div className="mb-[var(--space-1)] text-[length:var(--text-footnote)] font-semibold">
        {slot.cron.name}
      </div>
      {/* Schedule */}
      <div className="text-[var(--text-secondary)] text-[length:var(--text-caption1)] mb-[var(--space-2)]">
        {describeCron(slot.cron.schedule)}
      </div>
      {/* Raw cron */}
      <div className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        {slot.cron.schedule}
      </div>
      {/* Status */}
      <div className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)]">
        <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: statusColor }} />
        <span className="font-medium" style={{ color: statusColor }}>
          {slot.cron.enabled ? "Enabled" : "Disabled"}
        </span>
        {slot.cron.employee && (
          <span className="text-[var(--text-tertiary)] ml-[var(--space-1)]">
            {slot.cron.employee}
          </span>
        )}
      </div>
    </div>
  )
}

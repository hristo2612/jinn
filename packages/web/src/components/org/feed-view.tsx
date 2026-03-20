"use client"

import type { Employee } from "@/lib/api"
import { cn } from "@/lib/utils"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"

interface FeedViewProps {
  employees: Employee[]
  selectedName: string | null
  onSelect: (employee: Employee) => void
}

function RankBadge({ rank }: { rank: string }) {
  const colors: Record<
    string,
    { bg: string; text: string }
  > = {
    executive: {
      bg: "color-mix(in srgb, var(--system-purple) 15%, transparent)",
      text: "var(--system-purple)",
    },
    manager: {
      bg: "color-mix(in srgb, var(--system-blue) 15%, transparent)",
      text: "var(--system-blue)",
    },
    senior: {
      bg: "color-mix(in srgb, var(--system-green) 15%, transparent)",
      text: "var(--system-green)",
    },
    employee: {
      bg: "var(--fill-tertiary)",
      text: "var(--text-tertiary)",
    },
  }
  const c = colors[rank] || colors.employee

  return (
    <span
      className="rounded-[10px] px-2 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.02em]"
      style={{ color: c.text, background: c.bg }}
    >
      {rank}
    </span>
  )
}

export function FeedView({ employees, selectedName, onSelect }: FeedViewProps) {
  // Sort: executives first, then managers, seniors, employees
  const rankOrder: Record<string, number> = {
    executive: 0,
    manager: 1,
    senior: 2,
    employee: 3,
  }
  const sorted = [...employees].sort(
    (a, b) => (rankOrder[a.rank] ?? 3) - (rankOrder[b.rank] ?? 3),
  )

  return (
    <div className="h-full overflow-y-auto p-[var(--space-6)]">
      <div className="mb-[var(--space-5)] flex gap-[var(--space-3)]">
        {(["executive", "director", "manager", "lead", "senior", "employee"] as const).map(
          (rank) => {
            const count = employees.filter((e) => e.rank === rank).length
            return (
              <div
                key={rank}
                className="flex flex-1 items-center gap-[var(--space-3)] rounded-[var(--radius-md,12px)] border border-[var(--separator)] bg-[var(--material-regular)] px-[var(--space-4)] py-[var(--space-3)]"
              >
                <EmployeeAvatar name={rank} size={20} />
                <div>
                  <div className="text-[length:var(--text-title3)] font-[var(--weight-bold)] leading-none text-[var(--text-primary)]">
                    {count}
                  </div>
                  <div className="mt-0.5 text-[length:var(--text-caption2)] capitalize text-[var(--text-tertiary)]">
                    {rank}s
                  </div>
                </div>
              </div>
            )
          },
        )}
      </div>

      {/* Employee list */}
      {sorted.length === 0 ? (
        <div className="px-[var(--space-4)] py-[var(--space-16)] text-center text-[var(--text-tertiary)]">
          <div className="text-[length:var(--text-body)] font-[var(--weight-medium)]">
            No employees found
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--bg-secondary)]">
          {sorted.map((emp, idx) => {
            const isSelected = selectedName === emp.name

            return (
              <button
                key={emp.name}
                onClick={() => onSelect(emp)}
                className={cn(
                  "flex w-full items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] text-left transition-colors",
                  isSelected ? "bg-[var(--fill-secondary)]" : "bg-transparent hover:bg-accent"
                )}
                style={idx > 0 ? { borderTop: "1px solid var(--separator)" } : undefined}
              >
                <EmployeeAvatar name={emp.name} size={24} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-[var(--space-2)]">
                    <span className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                      {emp.displayName || emp.name}
                    </span>
                    <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
                      {emp.name}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-[var(--space-2)]">
                    <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                      {emp.department || "No department"}
                    </span>
                  </div>
                </div>

                <RankBadge rank={emp.rank} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

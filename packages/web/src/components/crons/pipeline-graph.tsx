"use client"

import { describeCron } from "@/lib/cron-utils"

interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  employee?: string
  engine?: string
  [key: string]: unknown
}

interface PipelineGraphProps {
  crons: CronJob[]
}

export function PipelineGraph({ crons }: PipelineGraphProps) {
  if (crons.length === 0) {
    return (
      <div
        style={{
          background: "var(--material-regular)",
          border: "1px solid var(--separator)",
          borderRadius: "var(--radius-md)",
          padding: "32px 24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
          No cron jobs configured
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", maxWidth: 480, margin: "0 auto", lineHeight: 1.6 }}>
          Cron jobs will appear here as cards once configured.
        </div>
      </div>
    )
  }

  const enabled = crons.filter(c => c.enabled)
  const disabled = crons.filter(c => !c.enabled)

  return (
    <div>
      {enabled.length > 0 && (
        <CronCardGroup crons={enabled} label="Enabled" />
      )}
      {disabled.length > 0 && (
        <CronCardGroup crons={disabled} label="Disabled" />
      )}
    </div>
  )
}

function CronCardGroup({ crons, label }: { crons: CronJob[]; label: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "var(--text-secondary)",
          marginBottom: 12,
        }}
      >
        {label} ({crons.length})
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        {crons.map(cron => {
          const borderColor = cron.enabled ? "var(--system-green)" : "var(--text-tertiary)"

          return (
            <div
              key={cron.id}
              style={{
                background: "var(--material-regular)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--separator)",
                borderLeft: `3px solid ${borderColor}`,
                padding: "10px 14px",
              }}
            >
              {/* Name + status dot */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {cron.name}
                </div>
              </div>

              {/* Schedule (human-readable) */}
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 2 }}>
                {describeCron(cron.schedule)}
              </div>

              {/* Raw schedule */}
              <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", marginBottom: 4 }}>
                {cron.schedule}
              </div>

              {/* Badges row */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {/* Employee badge */}
                {cron.employee && (
                  <span
                    style={{
                      display: "inline-block",
                      fontSize: 9,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "color-mix(in srgb, var(--system-blue) 15%, transparent)",
                      color: "var(--system-blue)",
                    }}
                  >
                    {cron.employee}
                  </span>
                )}
                {/* Engine badge */}
                {cron.engine && (
                  <span
                    style={{
                      display: "inline-block",
                      fontSize: 9,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "var(--fill-tertiary)",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {cron.engine}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

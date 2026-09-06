import { RotateCcw, Trash2 } from "lucide-react"
import { Section } from "./shared"

export function ResetSection({ resetAll }: { resetAll: () => void }) {
  // Destructive actions use a quiet red wash rather than a solid alarm block.
  return (
    <Section title="Reset">
      <div
        className="flex flex-wrap items-center gap-[var(--space-3)]"
      >
        <button
          onClick={() => {
            localStorage.removeItem("jinn-onboarded")
            window.location.reload()
          }}
          className="inline-flex h-[38px] cursor-pointer items-center gap-1.5 rounded-full border-none bg-[var(--fill-tertiary)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <RotateCcw size={15} />
          Re-run Onboarding
        </button>
        <button
          onClick={() => {
            if (
              window.confirm("Reset all settings to defaults?")
            ) {
              localStorage.removeItem("jinn-settings")
              localStorage.removeItem("jinn-theme")
              resetAll()
              window.location.reload()
            }
          }}
          className="inline-flex h-[38px] cursor-pointer items-center gap-1.5 rounded-full border-none px-4 text-[length:var(--text-subheadline)] font-semibold text-[var(--system-red)] transition-transform hover:scale-[0.98]"
          style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
        >
          <Trash2 size={15} />
          Reset All Settings
        </button>
      </div>
    </Section>
  )
}

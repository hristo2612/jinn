import { Fragment } from 'react'
import { ChevronDown, Settings } from 'lucide-react'
import { FOLD_MS } from './fold-motion'

/**
 * The fold's ledger line — "Worked for 7m · 6 tools · 3 teammates" — and the
 * control that shows or hides the work behind it.
 *
 * Every answered region carries one in BOTH states. A region that is open
 * because its answer landed live still owes the reader a way to put it away,
 * and a reader who never scrolls past it would otherwise have no control at all.
 */

export interface FoldSummaryData {
  durationMs: number | null
  tools: number
  teammates: number
  nativeAgents?: number
  /** Interim prose messages the model wrote on the way to the answer. */
  updates: number
}

export function formatWorkDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1_000) return '<1s'
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function foldSummaryWords(summary: FoldSummaryData): string[] {
  const duration = summary.durationMs === null ? '' : formatWorkDuration(summary.durationMs)
  const words = duration ? [`Worked for ${duration}`] : []
  if (summary.tools > 0) words.push(`${summary.tools} tool${summary.tools === 1 ? '' : 's'}`)
  if (summary.teammates > 0) words.push(`${summary.teammates} teammate${summary.teammates === 1 ? '' : 's'}`)
  if (summary.nativeAgents) words.push(nativeAgentCount(summary.nativeAgents))
  if (summary.updates > 0) words.push(`${summary.updates} update${summary.updates === 1 ? '' : 's'}`)
  return words
}

function nativeAgentCount(count: number): string {
  return `${count} native agent${count === 1 ? '' : 's'}`
}

interface FoldSummaryLineProps {
  summary: FoldSummaryData
  /** The work is hidden — or on its way to being hidden. */
  closed: boolean
  /** The line is arriving rather than already there, and rises in. */
  arriving: boolean
  onToggle: () => void
}

export function FoldSummaryLine({ summary, closed, arriving, onToggle }: FoldSummaryLineProps) {
  const words = foldSummaryWords(summary)
  return (
    <Fragment>
      {/* The line carries its OWN after-user inset: an answered region rests
          directly under the user bubble (everything between the ask and the
          answer is inside it), and the items' role-switch spacers fold away
          with the evidence — without this the ledger line sits flush under the
          accent bubble. Constant in both states, so toggling and the item set
          changing mid-turn never shift layout through it. */}
      <div data-fold-summary-inset aria-hidden="true" className="h-[var(--space-6)]" />
      <div className="assistant-msg-row min-w-0">
        <button
          type="button"
          data-fold-summary
          style={arriving ? { animation: 'jinn-comm-rise 260ms var(--ease-smooth) 140ms both' } : undefined}
          aria-expanded={!closed}
          aria-label={`${words.join(', ')}. ${closed ? 'Show the work' : 'Hide the work'}.`}
          onClick={onToggle}
          className="-ml-1.5 flex min-h-8 w-full cursor-pointer items-center gap-[var(--space-2)] rounded-[8px] border-none bg-transparent py-[3px] pl-1.5 pr-2 text-left font-[inherit] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
        >
          <Settings size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
          <span className="flex min-w-0 flex-wrap items-center gap-[7px]">
            {words.map((word, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <span aria-hidden="true" className="size-[2.5px] shrink-0 rounded-full bg-[var(--text-quaternary)] opacity-45" />
                )}
                <span className="truncate [font-variant-numeric:tabular-nums]">{word}</span>
              </Fragment>
            ))}
          </span>
          {/* The one moving part of the control, and it runs the region's own
              timeline — same duration, same curve, so the chevron lands with
              the work rather than before or after it. */}
          <ChevronDown
            size={12}
            strokeWidth={2.5}
            aria-hidden="true"
            style={{ transitionDuration: `${FOLD_MS}ms` }}
            className={`ml-0.5 shrink-0 text-[var(--text-quaternary)] transition-transform ease-[var(--ease-smooth)] ${closed ? 'rotate-0' : 'rotate-180'}`}
          />
        </button>
      </div>
    </Fragment>
  )
}

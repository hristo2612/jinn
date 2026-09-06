import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useModelRegistry, engineList, effortLevelsFor, findModel, defaultEffort, clampEffort, contextWindowFor } from '@/hooks/use-model-registry'
import { loadExpandedByEngine, setEngineExpanded } from '@/lib/model-picker-prefs'

/** Round a token count to a compact `k` string (e.g. 23148 → "23k", 980 → "980"). */
export function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export interface ContextUsage {
  /** Tokens used on the most recent turn (0 for a fresh chat). */
  tokens: number
  /** The model's context window in tokens. */
  window: number
  /** Fraction full, clamped to [0,1] for the bar. */
  pct: number
  /** Raw (un-clamped) fraction, for the tooltip percentage. */
  rawPct: number
  /** True when the turn exceeded the window. */
  over: boolean
  /** Threshold colour (orange ≥75%, red ≥90%/over), else undefined. */
  color?: string
  /** Compact "23k / 200k" label (">200k / 200k" when over). */
  label: string
}

/**
 * Pure formatting for the in-dropdown context meter. Returns null only when the
 * window is unknown; a null/0 token count is a valid fresh-chat state (tokens 0).
 */
export function formatContextUsage(
  contextTokens: number | null | undefined,
  window: number | undefined,
): ContextUsage | null {
  if (!window || window <= 0) return null
  const tokens = contextTokens && contextTokens > 0 ? contextTokens : 0
  const rawPct = tokens / window
  const pct = Math.min(rawPct, 1)
  const over = tokens > window
  const color = pct >= 0.9 ? 'var(--system-red)' : pct >= 0.75 ? 'var(--system-orange)' : undefined
  const label = over ? `>${fmtK(window)} / ${fmtK(window)}` : `${fmtK(tokens)} / ${fmtK(window)}`
  return { tokens, window, pct, rawPct, over, color, label }
}

export interface SelectorValue {
  engine?: string
  model?: string
  effortLevel?: string
}

interface ModelSelectorRowProps {
  /** 'new' = pre-create selection; 'existing' = persisted to the active chat. */
  mode: 'new' | 'existing'
  value: SelectorValue
  onChange: (next: SelectorValue) => void
  /** Shown in 'existing' mode to hint the change applies on the next message. */
  pendingNote?: boolean
  /** Shown in 'existing' mode when a model/effort update is rejected. */
  errorNote?: string
  disabled?: boolean
  /** Most recent turn's input-context token count (session.lastContextTokens),
   *  for the in-dropdown context meter. Omitted/0 → fresh chat (window-only). */
  contextTokens?: number | null
}

const engineLabelOf = (e: string) => (e ? e.charAt(0).toUpperCase() + e.slice(1) : '')
const effortLabelOf = (lvl: string) => lvl.charAt(0).toUpperCase() + lvl.slice(1)

/** Live `prefers-reduced-motion` flag; transitions collapse to instant when true. */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    setReduce(mq.matches)
    const on = () => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/**
 * One panel of the selector surface. Mounts with a crisp directional fade+slide
 * (incoming from the right when going forward, from the left when going back);
 * `prefers-reduced-motion` swaps instantly. Keyed by the active panel in the
 * parent, so each panel change replays the entrance.
 */
function SlidePanel({ dir, reduceMotion, children }: { dir: 1 | -1; reduceMotion: boolean; children: ReactNode }) {
  const [entered, setEntered] = useState(reduceMotion)
  useEffect(() => {
    if (reduceMotion) {
      setEntered(true)
      return
    }
    const r = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(r)
  }, [reduceMotion])
  return (
    <div
      style={{
        opacity: entered ? 1 : 0,
        transform: entered ? 'translateX(0)' : `translateX(${dir * 10}px)`,
        transition: reduceMotion ? 'none' : 'opacity 180ms var(--ease-smooth), transform 200ms var(--ease-snappy)',
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  )
}

/**
 * Engine / Model / Effort selector for the chat composer, rendered as a single
 * "chip" trigger (`✦ Opus 4.8 · High ▾`) that opens one consolidated dropdown:
 * engine header, model radio list, effort pill row, a context-usage footer, and
 * a "Switch engine" affordance. All options come from the live registry
 * (GET /api/engines); nothing is hardcoded.
 *  - Engine: editable in-place; existing chats persist the change for the next turn.
 *  - Model: editable always.
 *  - Effort: editable always; hidden entirely for models with no effort levels.
 * Cascading: changing engine resets model to that engine's default; changing model
 * clamps effort to a level valid for the new model.
 *
 * The "Switch engine" affordance transitions the SINGLE menu surface in-place to
 * an engine-list panel (no nested/second menu). A back control returns to the
 * Model/Effort panel; choosing an engine sets it and auto-returns to that panel,
 * now reflecting the new engine's models.
 */
export function ModelSelectorRow({ mode, value, onChange, pendingNote, errorNote, disabled, contextTokens }: ModelSelectorRowProps) {
  const { data: registry, isLoading } = useModelRegistry()
  const queryClient = useQueryClient()

  // Open + which panel is showing inside the one surface ('main' = model/effort,
  // 'engine' = engine list). `dir` drives the slide direction (forward / back).
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<'main' | 'engine'>('main')
  const [dir, setDir] = useState<1 | -1>(1)
  const reduceMotion = usePrefersReducedMotion()

  // Per-engine "show all models" preference — the picker shows an engine's
  // featured models by default; expanding to the full list is remembered.
  const [expandedByEngine, setExpandedByEngine] = useState<Record<string, boolean>>(() => loadExpandedByEngine())

  // Focus-parking target: a tabindex=-1 wrapper INSIDE the menu layer. Parking
  // focus here before a panel swap keeps focus within the layer so Radix's
  // focus-outside dismissal never fires when the active item unmounts.
  const panelWrapRef = useRef<HTMLDivElement>(null)
  // Animated height of the surface as panels of different sizes swap in.
  const [surfaceH, setSurfaceH] = useState<number>()
  // Skip the focus-confirm on the first open (Radix focuses the content itself).
  const firstOpen = useRef(true)

  // Resolve the engine to display. Keep the chosen/default one, unless it's an
  // uninstalled engine on a NEW chat — then fall back to the first installed one.
  // Existing chats stay pinned to their (possibly hidden) engine.
  const engines = engineList(registry)
  const preferred = value.engine ?? registry?.default
  const engine =
    mode === 'new' && engines.length > 0 && !engines.some((e) => e.name === preferred)
      ? engines[0].name
      : (preferred ?? '')

  // If a NEW chat's selection resolved to a different (installed) engine because
  // the chosen one is unavailable, sync that back so the created session is valid.
  useEffect(() => {
    if (mode !== 'new' || !registry) return
    const pref = value.engine ?? registry.default
    if (engines.length === 0 || engines.some((e) => e.name === pref)) return
    const ne = registry.engines[engine]
    if (!ne) return
    onChange({
      engine,
      model: ne.defaultModel,
      effortLevel: defaultEffort(effortLevelsFor(registry, engine, ne.defaultModel)),
    })
  }, [registry, mode, engine, value.engine])

  // Track the surface height across panel swaps / content changes so the height
  // animates instead of snapping. ResizeObserver covers panel swaps AND any
  // model/effort/context content changes within a panel.
  useLayoutEffect(() => {
    if (!open) return
    const el = panelWrapRef.current
    if (!el) return
    setSurfaceH(el.offsetHeight)
    const ro = new ResizeObserver(() => setSurfaceH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  // After a panel change (not the initial open), re-park focus inside the layer
  // so keyboard users can arrow into the new panel and Esc still closes.
  useLayoutEffect(() => {
    if (!open) {
      firstOpen.current = true
      return
    }
    if (firstOpen.current) {
      firstOpen.current = false
      return
    }
    panelWrapRef.current?.focus()
  }, [panel, open])

  if (isLoading || !registry) return null

  const entry = registry.engines[engine]
  const models = entry?.models ?? []
  const currentModel = findModel(registry, engine, value.model)
  const modelId = value.model ?? currentModel?.id ?? entry?.defaultModel ?? ''
  const efforts = effortLevelsFor(registry, engine, modelId)
  const effort = value.effortLevel ?? defaultEffort(efforts)

  const modelLabel = models.find((m) => m.id === modelId)?.label ?? modelId ?? 'Model'
  const usage = formatContextUsage(contextTokens, contextWindowFor(registry, engine, modelId))

  // Featured/expand: when the engine has a featured set, show only those by
  // default (plus the current model if it isn't featured — include-current-always),
  // with a "More models…" affordance to reveal the full registry. Engines with no
  // featured marking keep the full list (unchanged behaviour).
  const hasFeatured = models.some((m) => m.featured)
  const collapsedModels = hasFeatured ? models.filter((m) => m.featured || m.id === modelId) : models
  const expanded = expandedByEngine[engine] ?? false
  const shownModels = hasFeatured && !expanded ? collapsedModels : models
  const hiddenCount = models.length - collapsedModels.length
  const showExpandToggle = hasFeatured && hiddenCount > 0
  const toggleExpanded = () => {
    const next = !expanded
    setEngineExpanded(engine, next)
    setExpandedByEngine((prev) => ({ ...prev, [engine]: next }))
  }

  // Other installed engines, for deciding whether the engine panel is useful.
  const otherEngines = engines.filter((e) => e.name !== engine)
  const canSwitchEngine = otherEngines.length > 0

  // Re-discover dynamic (pi) models without a restart, then update the cache.
  const refreshModels = async () => {
    try {
      const fresh = await api.refreshEngines()
      queryClient.setQueryData(queryKeys.engines.all, fresh)
    } catch {
      void queryClient.invalidateQueries({ queryKey: queryKeys.engines.all })
    }
  }

  const pickEngine = (nextEngine: string) => {
    const ne = registry.engines[nextEngine]
    const nextModel = ne?.defaultModel ?? ne?.models[0]?.id
    onChange({
      engine: nextEngine,
      model: nextModel,
      effortLevel: defaultEffort(effortLevelsFor(registry, nextEngine, nextModel)),
    })
  }

  const pickModel = (nextModel: string) => {
    const nextEffort = clampEffort(effortLevelsFor(registry, engine, nextModel), value.effortLevel)
    onChange({ engine, model: nextModel, effortLevel: nextEffort })
  }

  const pickEffort = (nextEffort: string) => {
    onChange({ engine, model: modelId, effortLevel: nextEffort })
  }

  // Park focus inside the layer, then move to the requested panel. Parking is
  // synchronous so the unmounting active item never drops focus to <body>.
  const goToPanel = (next: 'main' | 'engine') => {
    setDir(next === 'engine' ? 1 : -1)
    panelWrapRef.current?.focus()
    setPanel(next)
  }

  // Choose an engine from the engine panel, then auto-return to the main panel
  // (now reflecting the new engine's models). Re-picking the current engine is a
  // no-op selection (matches the old radio behaviour) — just slide back.
  const chooseEngine = (nextEngine: string) => {
    panelWrapRef.current?.focus()
    if (nextEngine !== engine) pickEngine(nextEngine)
    setDir(-1)
    setPanel('main')
  }

  const mainPanel = (
    <>
      {/* Engine header — current engine. */}
      <div className="px-2 pt-1 pb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
        Engine · {engineLabelOf(engine)}
      </div>

      {/* Model radio list — label left, accent ✓ on the selected (right). */}
      {models.length === 0 ? (
        <div className="px-2 py-1.5 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">
          No models discovered yet.
        </div>
      ) : (
        <>
          <DropdownMenuRadioGroup value={modelId} onValueChange={pickModel}>
            {shownModels.map((m) => (
              <DropdownMenuRadioItem
                key={m.id}
                value={m.id}
                className="justify-between rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] data-[state=checked]:font-[var(--weight-semibold)] data-[state=checked]:text-[var(--text-primary)] [&>span:first-child]:hidden"
              >
                <span className="truncate">{m.label}</span>
                {m.id === modelId && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {showExpandToggle && (
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); toggleExpanded() }}
              className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
            >
              {expanded ? 'Show fewer' : `More models (${hiddenCount})`}
            </DropdownMenuItem>
          )}
        </>
      )}

      {/* Effort — pill row; hidden when the model has no effort levels. */}
      {efforts.length > 0 && (
        <>
          <DropdownMenuSeparator className="bg-[var(--separator)]" />
          <div className="px-2 pt-0.5 pb-1 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
            Effort
          </div>
          <div
            data-testid="effort-levels"
            className={`flex gap-1 px-1 pb-1 ${efforts.length > 4 ? 'overflow-x-auto [-webkit-overflow-scrolling:touch]' : ''}`}
          >
            {efforts.map((lvl) => {
              const on = lvl === effort
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => pickEffort(lvl)}
                  aria-pressed={on}
                  className={`${efforts.length > 4 ? 'min-w-[56px] shrink-0 px-2' : 'flex-1'} rounded-[8px] py-1.5 text-center text-[length:var(--text-caption1)] capitalize transition-colors ${
                    on
                      ? 'bg-[var(--accent-fill)] font-[var(--weight-semibold)] text-[var(--accent)]'
                      : 'bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {lvl}
                </button>
              )
            })}
          </div>
        </>
      )}

      {mode === 'existing' && errorNote && (
        <div className="px-2 pb-1 text-[length:var(--text-caption2)] text-[var(--system-red)]">
          {errorNote}
        </div>
      )}
      {mode === 'existing' && !errorNote && pendingNote && (
        <div className="px-2 pb-1 text-[length:var(--text-caption2)] italic text-[var(--text-quaternary)]">
          Applies to your next message
        </div>
      )}

      {/* Context usage — how full the window is on the most recent turn.
          Fresh chat (no tokens yet) shows just the window size, no bar. */}
      {usage && (
        <>
          <DropdownMenuSeparator className="bg-[var(--separator)]" />
          <div className="px-2 pt-0.5 pb-1.5">
            <div className="flex items-center justify-between text-[length:var(--text-caption1)]">
              <span className="text-[var(--text-tertiary)]">Context</span>
              {usage.tokens > 0 ? (
                <span
                  className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-secondary)]"
                  style={usage.color ? { color: usage.color } : undefined}
                  title={`${usage.tokens.toLocaleString()} / ${usage.window.toLocaleString()} tokens (${Math.round(usage.rawPct * 100)}%)`}
                >
                  {usage.label}
                </span>
              ) : (
                <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-quaternary)]">
                  {fmtK(usage.window)} window
                </span>
              )}
            </div>
            {usage.tokens > 0 && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--fill-tertiary)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(usage.pct * 100, 2)}%`, background: usage.color ?? 'var(--accent)' }}
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Engine switch — navigates the SAME surface to the engine panel (no nested menu). */}
      <DropdownMenuSeparator className="bg-[var(--separator)]" />
      {canSwitchEngine ? (
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); goToPanel('engine') }}
          className="rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
        >
          <span className="flex-1">Switch engine…</span>
          <ChevronRightIcon className="size-3.5 shrink-0 text-[var(--text-quaternary)]" />
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); void refreshModels() }}
          className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
        >
          ↻ Refresh models
        </DropdownMenuItem>
      )}
    </>
  )

  const enginePanel = (
    <>
      {/* Back to the model/effort panel. */}
      <DropdownMenuItem
        onSelect={(e) => { e.preventDefault(); goToPanel('main') }}
        className="gap-1 rounded-[9px] py-1.5 pl-1.5 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
      >
        <ChevronLeftIcon className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
        <span className="flex-1">Back</span>
      </DropdownMenuItem>
      <div className="px-2 pt-0.5 pb-1 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
        Switch engine
      </div>
      {engines.map((e) => {
        const on = e.name === engine
        return (
          <DropdownMenuItem
            key={e.name}
            onSelect={(ev) => { ev.preventDefault(); chooseEngine(e.name) }}
            aria-checked={on}
            className="justify-between rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
          >
            <span className={on ? 'font-[var(--weight-semibold)] text-[var(--text-primary)]' : undefined}>
              {engineLabelOf(e.name)}
            </span>
            {on && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
          </DropdownMenuItem>
        )
      })}
      <DropdownMenuSeparator className="bg-[var(--separator)]" />
      <DropdownMenuItem
        onSelect={(e) => { e.preventDefault(); void refreshModels() }}
        className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
      >
        ↻ Refresh models
      </DropdownMenuItem>
    </>
  )

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) {
          // Always land on the model/effort panel when (re)opening.
          setPanel('main')
          setDir(1)
        }
      }}
    >
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model and effort: ${modelLabel}${effort ? ` · ${effortLabelOf(effort)}` : ''}`}
          className="group inline-flex min-h-[40px] md:min-h-0 max-w-full items-center gap-1.5 rounded-lg border-none bg-transparent px-1.5 py-1 text-[length:var(--text-footnote)] transition-colors hover:bg-[var(--fill-secondary)] disabled:cursor-default disabled:opacity-60 cursor-pointer"
        >
          <span aria-hidden className="shrink-0 text-[var(--accent)] text-[11px] leading-none">✦</span>
          <span className="truncate font-[var(--weight-semibold)] tracking-[-0.2px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">{modelLabel}</span>
          {effort && (
            // First thing to drop on a narrow composer — measured against the composer container, so a narrow PANE drops it too, not just a narrow viewport.
            <span className="shrink-0 text-[var(--text-tertiary)] @max-[340px]/composer:hidden">· {effortLabelOf(effort)}</span>
          )}
          <span aria-hidden className="shrink-0 text-[8px] leading-none text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]">▾</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-lg)] border-0 bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--shadow-overlay)]"
      >
        {/* Single surface; height animates as the two panels swap in place. */}
        <div
          style={{
            height: surfaceH != null ? `${surfaceH}px` : undefined,
            overflow: 'hidden',
            transition: reduceMotion ? 'none' : 'height 200ms var(--ease-smooth)',
          }}
        >
          <div ref={panelWrapRef} tabIndex={-1} className="outline-none">
            <SlidePanel key={panel} dir={dir} reduceMotion={reduceMotion}>
              {panel === 'main' ? mainPanel : enginePanel}
            </SlidePanel>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

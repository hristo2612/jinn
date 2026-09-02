import { useCallback, useState } from "react"
import { RunButton } from "./run-button"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import {
  ApiError,
  WorkflowValidationApiError,
  api,
  type WorkflowDefinitionWire,
  type WorkflowRunSummaryWire,
} from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { EditorCanvas, SaveChip, useAutosave } from "./editor/editor"
import { createEditorStore, EditorStoreContext, useEditor, useEditorApi, type EditorStoreApi } from "./editor/store"
import { WorkflowLifecycleMenu } from "./lifecycle-menu"
import {
  StatusGlyph,
  TRIGGER_KIND_LABEL,
  formatDuration,
  formatStarted,
  statusMeta,
} from "./run-support"

function RunRow({ run }: { run: WorkflowRunSummaryWire }) {
  const meta = statusMeta(run.status)
  const nodeHint = run.currentOrFailingNode
  return (
    <Link
      to={`/workflow/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.id)}`}
      className="flex items-center gap-3 rounded-[13px] px-3.5 py-3 hover:bg-[var(--fill-quaternary)]"
    >
      <StatusGlyph status={run.status} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
            {meta.label}
          </span>
          <span
            className="truncate text-[length:var(--text-caption1)] text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {run.id}
          </span>
        </span>
        <span className="block truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {TRIGGER_KIND_LABEL[run.trigger.kind]}
          {nodeHint ? ` · ${nodeHint.state === "failing" ? "failed at" : "at"} ${nodeHint.label}` : ""}
        </span>
      </span>
      <span
        className="shrink-0 text-right text-[length:var(--text-caption1)] text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        <span className="block">{formatStarted(run.startedAt)}</span>
        <span className="block text-[var(--text-quaternary)]">{formatDuration(run.startedAt, run.endedAt)}</span>
      </span>
    </Link>
  )
}

function RunsSection({ workflowId }: { workflowId: string }) {
  const query = useQuery({
    queryKey: queryKeys.workflows.runs(workflowId),
    queryFn: () => api.listWorkflowRunsV2(workflowId),
    enabled: Boolean(workflowId),
  })

  return (
    <section className="mx-auto max-w-[860px] px-5 pb-16 pt-6">
      {query.isPending && <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">Loading runs…</p>}
      {query.isError && (
        <p className="rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
          {query.error instanceof Error ? query.error.message : "Failed to load runs."}
        </p>
      )}
      {query.data && query.data.items.length === 0 && (
        <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">No runs yet.</p>
      )}
      {query.data && query.data.items.length > 0 && (
        <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
          {query.data.items.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
          {query.data.nextCursor && (
            <p className="px-3.5 py-2.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              Showing the latest {query.data.items.length} runs.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function EnableSwitch({ flushNow }: { flushNow: () => Promise<void> }) {
  const store = useEditorApi()
  const enabled = useEditor((state) => state.meta.enabled)
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()

  const toggle = useCallback(async () => {
    setBusy(true)
    try {
      await flushNow()
      const state = store.getState()
      if (state.save.state !== "saved") return
      const saved = await api.setWorkflowEnabledV2(state.meta.id, !state.meta.enabled, state.meta.revision)
      store.getState().acknowledge(saved)
      store.getState().setIssues(null)
      queryClient.setQueryData(queryKeys.workflows.definition(saved.id), saved)
    } catch (error) {
      if (error instanceof WorkflowValidationApiError) store.getState().setIssues(error.issues)
      else if (error instanceof ApiError && error.status === 409) store.getState().setSave({ state: "conflict" })
      else store.getState().setSave({ state: "error", message: error instanceof Error ? error.message : "Request failed." })
    } finally {
      setBusy(false)
    }
  }, [flushNow, queryClient, store])

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? "Disable workflow" : "Enable workflow"}
      disabled={busy}
      onClick={() => void toggle()}
      className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-1 disabled:opacity-50"
    >
      <span
        className="relative inline-flex h-[22px] w-[38px] items-center rounded-full transition-colors"
        style={{ background: enabled ? "var(--system-green)" : "var(--fill-secondary)" }}
      >
        <span
          className="absolute size-[18px] rounded-full bg-white shadow-[var(--shadow-subtle)] transition-transform"
          style={{ transform: enabled ? "translateX(18px)" : "translateX(2px)" }}
        />
      </span>
      <span className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
        {enabled ? "Enabled" : "Disabled"}
      </span>
    </button>
  )
}

type Lens = "editor" | "runs"

function LensControl({ lens, setLens }: { lens: Lens; setLens: (lens: Lens) => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5">
      {(["editor", "runs"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={lens === value}
          onClick={() => setLens(value)}
          className={`h-7 rounded-full px-3 text-[length:var(--text-footnote)] font-[var(--weight-medium)] transition-colors ${
            lens === value
              ? "bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-subtle)]"
              : "text-[var(--text-secondary)]"
          }`}
        >
          {value === "editor" ? "Editor" : "Runs"}
        </button>
      ))}
    </div>
  )
}

function WorkflowSurface({ store }: { store: EditorStoreApi }) {
  const { flushNow } = useAutosave(store)
  const meta = useEditor((state) => state.meta)
  const hasManualTrigger = useEditor((state) =>
    state.nodes.some((node) => node.data.node.type === "trigger" && node.data.node.config["kind"] === "manual"))
  const [params, setParams] = useSearchParams()
  const lens: Lens = params.get("lens") === "runs" ? "runs" : "editor"
  const setLens = useCallback(
    (next: Lens) => setParams(next === "runs" ? { lens: "runs" } : {}, { replace: true }),
    [setParams],
  )
  const queryClient = useQueryClient()

  const reload = useCallback(async () => {
    const fresh = await api.getWorkflowDefinitionV2(meta.id)
    store.getState().applyDefinition(fresh)
    queryClient.setQueryData(queryKeys.workflows.definition(fresh.id), fresh)
  }, [meta.id, queryClient, store])

  // A conflict means the header is holding a revision the server has moved past, so
  // take its copy before showing the chip — otherwise the next action repeats the
  // same refused write. If that GET fails too, the chip is the button that retries.
  const onLifecycleFailure = useCallback(async (error: unknown) => {
    const conflict = error instanceof ApiError && error.status === 409
    if (conflict) await reload().catch(() => undefined)
    store.getState().setSave(conflict
      ? { state: "conflict" }
      : { state: "error", message: error instanceof Error ? error.message : "Request failed." })
  }, [reload, store])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 pt-4 md:px-5">
        <Link
          to="/workflow"
          aria-label="Back to workflows"
          className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Link>
        {/* Basis keeps the title readable at 390px — trailing controls wrap
            below instead of squeezing it to one glyph. */}
        <div className="min-w-0 flex-[1_1_160px]">
          <h1 className="truncate text-[length:var(--text-headline)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)]">
            {meta.title}
          </h1>
        </div>
        <SaveChip onReload={() => void reload()} />
        <EnableSwitch flushNow={flushNow} />
        {meta.enabled && hasManualTrigger && <RunButton workflowId={meta.id} inputs={meta.inputs} />}
        <LensControl lens={lens} setLens={setLens} />
        <WorkflowLifecycleMenu
          variant="header"
          workflow={meta}
          onChanged={(saved) => store.getState().acknowledge(saved)}
          onFailure={(error) => { void onLifecycleFailure(error) }}
        />
      </header>
      <div className="min-h-0 flex-1">
        {lens === "editor" ? (
          <EditorCanvas />
        ) : (
          <div className="h-full overflow-y-auto" data-scrollable="true">
            <RunsSection workflowId={meta.id} />
          </div>
        )}
      </div>
    </div>
  )
}

function WorkflowEditorProvider({ definition }: { definition: WorkflowDefinitionWire }) {
  const [store] = useState(() => createEditorStore(definition))
  return (
    <EditorStoreContext value={store}>
      <WorkflowSurface store={store} />
    </EditorStoreContext>
  )
}

export default function WorkflowPage() {
  const { id = "" } = useParams<{ id: string }>()
  const query = useQuery({
    queryKey: queryKeys.workflows.definition(id),
    queryFn: () => api.getWorkflowDefinitionV2(id),
    enabled: Boolean(id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  return (
    <PageLayout>
      {query.isPending && <p className="py-12 text-center text-[var(--text-secondary)]">Loading workflow…</p>}
      {query.isError && (
        <p className="mx-auto mt-6 max-w-[560px] rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
          {query.error instanceof Error ? query.error.message : "Failed to load workflow."}
        </p>
      )}
      {query.data && <WorkflowEditorProvider key={query.data.id} definition={query.data} />}
    </PageLayout>
  )
}

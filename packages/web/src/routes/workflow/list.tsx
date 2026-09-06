import { useCallback, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Plus, Workflow } from "lucide-react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { PrimaryAction } from "@/components/shell/primary-action"
import {
  ApiError,
  api,
  type WorkflowDefinitionSummaryWire,
  type WorkflowDefinitionWire,
} from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { WorkflowLifecycleMenu } from "./lifecycle-menu"
import { WorkflowNameDialog } from "./name-dialog"

function NewWorkflowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (input: { id: string; title: string }) => api.createWorkflowV2(input),
    onSuccess: (definition) => {
      queryClient.setQueryData(queryKeys.workflows.definition(definition.id), definition)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all })
      navigate(`/workflow/${encodeURIComponent(definition.id)}`)
    },
  })

  return (
    <WorkflowNameDialog
      open={open}
      onClose={onClose}
      heading="New workflow"
      description="Name the procedure — its identifier is derived from the title."
      submitLabel="Create"
      pendingLabel="Creating…"
      error={create.error}
      pending={create.isPending}
      onSubmit={(input) => create.mutate(input)}
    />
  )
}

interface WorkflowListEntry {
  summary: WorkflowDefinitionSummaryWire
  definition: WorkflowDefinitionWire | null
}

async function loadDefinitions(retired: boolean): Promise<WorkflowListEntry[]> {
  const page = await api.listWorkflowDefinitionsV2(undefined, retired)
  return Promise.all(page.items.map(async (summary) => ({
    summary,
    definition: await api.getWorkflowDefinitionV2(summary.id).catch(() => null),
  })))
}

function countLabel(definition: WorkflowDefinitionWire | null): string {
  if (!definition) return "Definition unavailable"
  const nodes = `${definition.nodes.length} ${definition.nodes.length === 1 ? "node" : "nodes"}`
  const edges = `${definition.edges.length} ${definition.edges.length === 1 ? "edge" : "edges"}`
  return `${nodes} · ${edges}`
}

const SHELVES = [{ id: "active", label: "Active" }, { id: "archived", label: "Archived" }] as const
type Shelf = typeof SHELVES[number]["id"]

/** Which shelf is showing, held in the URL rather than in state so the view is
 *  shareable and survives a reload. The default is the absent param, matching
 *  how the workflow page writes its own lens. */
function useShelf(): { shelf: Shelf; setShelf: (next: Shelf) => void } {
  const [params, setParams] = useSearchParams()
  const shelf: Shelf = params.get("retired") === "true" ? "archived" : "active"
  const setShelf = useCallback((next: Shelf) => {
    setParams((current) => {
      const updated = new URLSearchParams(current)
      if (next === "active") updated.delete("retired")
      else updated.set("retired", "true")
      return updated
    }, { replace: true })
  }, [setParams])
  return { shelf, setShelf }
}

export default function WorkflowListPage() {
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { shelf, setShelf } = useShelf()
  const queryClient = useQueryClient()
  const archived = shelf === "archived"
  const query = useQuery({
    queryKey: queryKeys.workflows.list(archived),
    queryFn: () => loadDefinitions(archived),
  })

  // A rejected write always leaves a message and a refetch behind: the row on
  // screen is the one thing we now know to be out of date.
  const onFailure = useCallback((error: unknown) => {
    setNotice(error instanceof ApiError && error.status === 409
      ? "This workflow changed elsewhere — reloaded."
      : error instanceof Error ? error.message : "That action could not be completed.")
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all })
  }, [queryClient])

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="760px"
        header={
          <LargeTitleHeader
            title="Workflows"
            subtitle="Repeatable procedures your company runs."
          />
        }
        primaryAction={
          <PrimaryAction
            aria-label="New workflow"
            label="New workflow"
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => setCreating(true)}
          />
        }
      >
        <main>
          <NewWorkflowDialog open={creating} onClose={() => setCreating(false)} />

          <div className="mb-3.5 flex gap-2" role="group" aria-label="Filter workflows">
            {SHELVES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={shelf === id}
                onClick={() => { setNotice(null); setShelf(id) }}
                className={`inline-flex h-[40px] md:h-[34px] items-center rounded-full px-[13px] text-[length:var(--text-footnote)] transition-colors ${
                  shelf === id
                    ? "bg-[var(--accent-fill)] font-semibold text-[var(--accent)]"
                    : "bg-[var(--fill-tertiary)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {notice && (
            <p role="status" className="mb-3 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] px-4 py-2.5 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              {notice}
            </p>
          )}

          {query.isPending && <p className="py-12 text-center text-[var(--text-secondary)]">Loading workflows…</p>}
          {query.isError && (
            <p className="rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
              {query.error instanceof Error ? query.error.message : "Failed to load workflows."}
            </p>
          )}
          {query.data?.length === 0 && (
            <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-8 py-16 text-center shadow-[var(--shadow-card)]">
              <Workflow className="mx-auto size-8 text-[var(--text-tertiary)]" aria-hidden />
              <h2 className="mt-4 text-[length:var(--text-title3)] font-[var(--weight-semibold)]">
                {archived ? "Nothing archived" : "No workflows yet"}
              </h2>
            </div>
          )}
          <div className="space-y-3">
            {query.data?.map(({ summary, definition }) => (
              <Link
                key={summary.id}
                to={`/workflow/${encodeURIComponent(summary.id)}`}
                className="hover-lift flex items-center gap-4 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-5 py-4 shadow-[var(--shadow-card)]"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--fill-tertiary)]">
                  <Workflow className="size-[18px] text-[var(--text-secondary)]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-[var(--weight-semibold)] text-[var(--text-primary)]">{summary.title}</span>
                  <span className="block truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                    {summary.description || countLabel(definition)}
                  </span>
                  {summary.description && (
                    <span className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{countLabel(definition)}</span>
                  )}
                </span>
                <span className="shrink-0 text-right text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  <span className="block">{summary.retiredAt ? "Archived" : summary.enabled ? "Enabled" : "Disabled"}</span>
                  <span className="block">Revision {summary.revision}</span>
                </span>
                <WorkflowLifecycleMenu variant="row" workflow={summary} onFailure={onFailure} />
                <ArrowRight className="hidden size-4 shrink-0 text-[var(--text-quaternary)] sm:block" aria-hidden />
              </Link>
            ))}
          </div>
        </main>
      </PageScaffold>
    </PageLayout>
  )
}

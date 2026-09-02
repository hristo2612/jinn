import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Play } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { api, type WorkflowDefinitionWire } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { collectRunInput } from "./run-input"

/** Starts a manual run, after asking for whatever inputs the definition declares. */
export function RunButton({ workflowId, inputs }: { workflowId: string; inputs: WorkflowDefinitionWire["inputs"] }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const start = useMutation({
    mutationFn: (input: Record<string, string>) => api.startWorkflowRunV2(workflowId, input),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.workflows.run(workflowId, detail.id), detail)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.runs(workflowId) })
      void navigate(`/workflow/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(detail.id)}`)
    },
  })

  return (
    <button
      type="button"
      onClick={() => {
        const input = collectRunInput(inputs)
        if (input) start.mutate(input)
      }}
      disabled={start.isPending}
      title={start.isError ? (start.error instanceof Error ? start.error.message : "Failed to start run.") : undefined}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50" // jinn-shell: ok editor run control, not page chrome
    >
      <Play className="size-3.5" aria-hidden />
      {start.isPending ? "Starting…" : "Run"}
    </button>
  )
}


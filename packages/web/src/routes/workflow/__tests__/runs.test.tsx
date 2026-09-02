import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getWorkflowDefinition = vi.fn()
const listWorkflowRuns = vi.fn()
const getWorkflowRun = vi.fn()
const startWorkflowRun = vi.fn()
const decideWorkflowApproval = vi.fn()

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message)
    }
  }
  class WorkflowValidationApiError extends ApiError {
    constructor(status: number, message: string, code: string | undefined, readonly issues: unknown[]) {
      super(status, message, code)
    }
  }
  return {
    ApiError,
    WorkflowValidationApiError,
    api: {
      getWorkflowDefinitionV2: (...args: unknown[]) => getWorkflowDefinition(...args),
      listWorkflowRunsV2: (...args: unknown[]) => listWorkflowRuns(...args),
      getWorkflowRunV2: (...args: unknown[]) => getWorkflowRun(...args),
      getWorkflowRunFullV2: (...args: unknown[]) => getWorkflowRun(...args),
      startWorkflowRunV2: (...args: unknown[]) => startWorkflowRun(...args),
      decideWorkflowApprovalV2: (...args: unknown[]) => decideWorkflowApproval(...args),
    },
  }
})
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import WorkflowPage from "../page"
import WorkflowRunPage from "../run"

const definition = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  revision: 3,
  enabled: true,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [
    { id: "trigger", type: "trigger", name: "Manual", config: { kind: "manual" } },
    { id: "writer", type: "employee", name: "Writer", config: { employee: { source: "fixed", value: "" }, prompt: "" } },
    { id: "gate", type: "approval", name: "Publish gate", config: { description: "" } },
  ],
  edges: [],
  ui: { positions: {} },
}

const runSummary = {
  id: "run-01HZX", workflowId: "morning-digest", workflowTitle: "Morning Digest",
  definitionRevision: 3, status: "failed" as const,
  trigger: { nodeId: "trigger", kind: "manual" as const },
  startedAt: "2026-07-22T08:00:00.000Z", endedAt: "2026-07-22T08:03:12.000Z",
  currentOrFailingNode: { nodeId: "writer", label: "Writer", employeeId: "writer", state: "failing" as const },
}

const runDetail = {
  id: "run-01HZX", workflowId: "morning-digest", workflowTitle: "Morning Digest",
  definitionRevision: 3, revision: 7,
  definition: { nodes: definition.nodes, edges: [] },
  spendUsd: 0,
  status: "waiting" as const,
  trigger: { nodeId: "trigger", kind: "manual" as const },
  startedAt: "2026-07-22T08:00:00.000Z",
  nodeRuns: [
    { runId: "run-01HZX", nodeId: "trigger", nodeType: "trigger", status: "completed", activated: true, startedAt: "2026-07-22T08:00:00.000Z", endedAt: "2026-07-22T08:00:01.000Z" },
    { runId: "run-01HZX", nodeId: "writer", nodeType: "employee", status: "completed", activated: true, startedAt: "2026-07-22T08:00:01.000Z", endedAt: "2026-07-22T08:02:41.000Z" },
    { runId: "run-01HZX", nodeId: "gate", nodeType: "approval", status: "waiting", activated: true, startedAt: "2026-07-22T08:02:41.000Z" },
  ],
  attempts: [
    { runId: "run-01HZX", nodeId: "writer", attempt: 1, status: "failed", startedAt: "2026-07-22T08:00:01.000Z", endedAt: "2026-07-22T08:01:00.000Z", error: { code: "engine-error", message: "Engine crashed mid-turn.", retryable: true } },
    { runId: "run-01HZX", nodeId: "writer", attempt: 2, status: "completed", startedAt: "2026-07-22T08:01:00.000Z", endedAt: "2026-07-22T08:02:41.000Z", output: { text: "Digest drafted.", fields: {} } },
  ],
  approvals: [
    { runId: "run-01HZX", nodeId: "gate", status: "pending", requestedAt: "2026-07-22T08:02:41.000Z" },
  ],
}

function renderRoute(path: string) {
  const router = createMemoryRouter([
    { path: "/workflow/:id", element: <WorkflowPage /> },
    { path: "/workflow/:id/runs/:runId", element: <WorkflowRunPage /> },
  ], { initialEntries: [path] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkflowDefinition.mockResolvedValue(definition)
  listWorkflowRuns.mockResolvedValue({ items: [runSummary], nextCursor: null })
  getWorkflowRun.mockResolvedValue(runDetail)
})

describe("workflow runs lens", () => {
  it("lists runs with status, trigger kind, and failing node", async () => {
    renderRoute("/workflow/morning-digest?lens=runs")

    expect(await screen.findByText("Failed")).toBeTruthy()
    expect(screen.getByText("run-01HZX")).toBeTruthy()
    expect(screen.getByText("Manual · failed at Writer")).toBeTruthy()
    expect(listWorkflowRuns).toHaveBeenCalledWith("morning-digest")
  })

  it("starts a manual run and navigates to its detail page", async () => {
    startWorkflowRun.mockResolvedValue(runDetail)
    const router = renderRoute("/workflow/morning-digest")

    await userEvent.click(await screen.findByRole("button", { name: "Run" }))

    await waitFor(() => expect(startWorkflowRun).toHaveBeenCalledWith("morning-digest", {}))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/workflow/morning-digest/runs/run-01HZX"))
  })

  it("hides the Run button when the workflow is disabled", async () => {
    getWorkflowDefinition.mockResolvedValue({ ...definition, enabled: false })
    renderRoute("/workflow/morning-digest")

    await screen.findByText("Morning Digest")
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull()
  })

  it("renders the run page as a canvas with the definition's nodes", async () => {
    renderRoute("/workflow/morning-digest/runs/run-01HZX")

    expect(await screen.findByText("Manual run")).toBeTruthy()
    expect(screen.getByText("Writer")).toBeTruthy()
    expect(screen.getByText("Publish gate")).toBeTruthy()
    expect(document.querySelector(".react-flow")).toBeTruthy()
  })

  it("shows non-zero run spend in the header", async () => {
    getWorkflowRun.mockResolvedValue({ ...runDetail, spendUsd: 2.75 })
    renderRoute("/workflow/morning-digest/runs/run-01HZX")

    expect(await screen.findByText("$2.75")).toBeTruthy()
  })

  it("shows positive sub-cent run spend without rounding it to zero", async () => {
    getWorkflowRun.mockResolvedValue({ ...runDetail, spendUsd: 0.004 })
    renderRoute("/workflow/morning-digest/runs/run-01HZX")

    expect(await screen.findByText("$0.004")).toBeTruthy()
    expect(screen.queryByText("$0.00")).toBeNull()
  })

  it("does not show a zero-dollar placeholder", async () => {
    getWorkflowRun.mockResolvedValue({ ...runDetail, spendUsd: 0 })
    renderRoute("/workflow/morning-digest/runs/run-01HZX")

    await screen.findByText("Manual run")
    expect(screen.queryByText("$0.00")).toBeNull()
  })
})

"use client"

import { useEffect, useState, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'
import type { Employee, OrgData } from '@/lib/api'
import type { KanbanTicket, TicketStatus, TicketPriority } from '@/lib/kanban/types'
import {
  loadTickets,
  saveTickets,
  createTicket,
  updateTicket,
  moveTicket,
  deleteTicket,
  type KanbanStore,
} from '@/lib/kanban/store'
import { PageLayout } from '@/components/page-layout'
import { KanbanBoard } from '@/components/kanban/kanban-board'
import { CreateTicketModal } from '@/components/kanban/create-ticket-modal'
import { TicketDetailPanel } from '@/components/kanban/ticket-detail-panel'

export default function KanbanPage() {
  const [tickets, setTickets] = useState<KanbanStore>({})
  const [employees, setEmployees] = useState<Employee[]>([])
  const [departments, setDepartments] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<KanbanTicket | null>(null)
  const [filterEmployeeId, setFilterEmployeeId] = useState<string | null>(null)

  const loadData = useCallback(() => {
    setLoading(true)
    setError(null)

    // Load employees from API, then load board data from department boards
    api
      .getOrg()
      .then(async (data: OrgData) => {
        const details = await Promise.all(
          data.employees.map(async (name) => {
            try {
              return await api.getEmployee(name)
            } catch {
              return {
                name,
                displayName: name,
                department: '',
                rank: 'employee' as const,
                engine: 'unknown',
                model: 'unknown',
                persona: '',
              }
            }
          }),
        )
        setEmployees(details)
        setDepartments(data.departments)

        // Load board tickets from all departments
        const boardTickets: KanbanStore = {}
        for (const dept of data.departments) {
          try {
            const board = await api.getDepartmentBoard(dept) as unknown as Array<{
              id: string
              title: string
              description?: string
              status: string
              priority?: string
              assignee?: string
              createdAt?: string
              updatedAt?: string
            }>
            if (Array.isArray(board)) {
              for (const item of board) {
                // Map board.json status to kanban statuses
                const statusMap: Record<string, TicketStatus> = {
                  todo: 'todo',
                  'in_progress': 'in-progress',
                  'in-progress': 'in-progress',
                  done: 'done',
                  backlog: 'backlog',
                  review: 'review',
                }
                const status = statusMap[item.status] || 'todo'
                const priorityMap: Record<string, TicketPriority> = {
                  low: 'low',
                  medium: 'medium',
                  high: 'high',
                }
                const priority = priorityMap[item.priority || 'medium'] || 'medium'
                boardTickets[item.id] = {
                  id: item.id,
                  title: item.title,
                  description: item.description || '',
                  status,
                  priority,
                  assigneeId: item.assignee || null,
                  workState: 'idle',
                  createdAt: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
                  updatedAt: item.updatedAt ? new Date(item.updatedAt).getTime() : Date.now(),
                  departmentId: dept,
                }
              }
            }
          } catch {
            // Department may not have a board.json, that's fine
          }
        }

        // API is the sole source of truth on load. Do not merge localStorage —
        // agent-made changes (moves, deletes) are only reflected in the API,
        // and stale localStorage entries would cause ghost / wrong-state tickets.
        setTickets(boardTickets)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Persist tickets to both localStorage and the API whenever the store changes
  useEffect(() => {
    if (!loading) {
      saveTickets(tickets)
    }
  }, [tickets, loading])

  /**
   * Persist the current ticket store back to each department's board via the
   * gateway API. Tickets without a departmentId are silently skipped (they
   * remain in localStorage only until a department can be assigned).
   */
  const persistToApi = useCallback(
    async (store: KanbanStore) => {
      // Group tickets by their department
      const byDept: Record<string, KanbanTicket[]> = {}
      for (const ticket of Object.values(store)) {
        if (!ticket.departmentId) continue
        if (!byDept[ticket.departmentId]) byDept[ticket.departmentId] = []
        byDept[ticket.departmentId].push(ticket)
      }

      // Also PUT an empty array for any department that no longer has tickets
      // so deleted tickets don't come back on the next reload
      for (const dept of departments) {
        if (!byDept[dept]) byDept[dept] = []
      }

      // Write each department board; errors are non-fatal (UI still works via localStorage)
      await Promise.all(
        Object.entries(byDept).map(([dept, deptTickets]) => {
          const boardData = deptTickets.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            assignee: t.assigneeId ?? undefined,
            createdAt: new Date(t.createdAt).toISOString(),
            updatedAt: new Date(t.updatedAt).toISOString(),
          }))
          return api.updateDepartmentBoard(dept, boardData).catch(() => {
            // Silently ignore — department dir may not exist on disk yet
          })
        }),
      )
    },
    [departments],
  )

  // Keep selectedTicket in sync with store
  useEffect(() => {
    if (selectedTicket && tickets[selectedTicket.id]) {
      const current = tickets[selectedTicket.id]
      if (current.updatedAt !== selectedTicket.updatedAt) {
        setSelectedTicket(current)
      }
    }
  }, [tickets, selectedTicket])

  function handleCreateTicket(data: {
    title: string
    description: string
    priority: TicketPriority
    assigneeId: string | null
  }) {
    // Derive the department from the assignee, falling back to the first known department
    const assignee = employees.find((e) => e.name === data.assigneeId)
    const departmentId = assignee?.department || departments[0] || null

    setTickets((prev) => {
      const next = createTicket(prev, {
        ...data,
        status: 'backlog',
        departmentId,
      })
      persistToApi(next)
      return next
    })
  }

  function handleMoveTicket(ticketId: string, status: TicketStatus) {
    setTickets((prev) => {
      const next = moveTicket(prev, ticketId, status)
      persistToApi(next)
      return next
    })
  }

  function handleDeleteTicket(ticketId: string) {
    setTickets((prev) => {
      const next = deleteTicket(prev, ticketId)
      persistToApi(next)
      return next
    })
    setSelectedTicket(null)
  }

  function handleAssigneeChange(ticketId: string, assigneeId: string | null) {
    setTickets((prev) => {
      const next = updateTicket(prev, ticketId, { assigneeId })
      persistToApi(next)
      return next
    })
  }

  function handleTicketClick(ticket: KanbanTicket) {
    setSelectedTicket(ticket)
  }

  if (error) {
    return (
      <PageLayout>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 'var(--space-4)',
            color: 'var(--text-tertiary)',
          }}
        >
          <div
            style={{
              borderRadius: 'var(--radius-md)',
              background: 'color-mix(in srgb, var(--system-red) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--system-red) 30%, transparent)',
              padding: 'var(--space-3) var(--space-4)',
              fontSize: 'var(--text-body)',
              color: 'var(--system-red)',
            }}
          >
            Failed to load employees: {error}
          </div>
          <button
            onClick={loadData}
            style={{
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent)',
              color: 'var(--accent-contrast)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--text-body)',
              fontWeight: 'var(--weight-semibold)',
            }}
          >
            Retry
          </button>
        </div>
      </PageLayout>
    )
  }

  const ticketCount = Object.keys(tickets).length

  // Employees that have at least one ticket assigned
  const assignedEmployeeNames = new Set(
    Object.values(tickets)
      .map((t) => t.assigneeId)
      .filter(Boolean),
  )
  const assignedEmployees = employees.filter((e) => assignedEmployeeNames.has(e.name))

  return (
    <PageLayout>
      <div className="flex h-full relative" style={{ background: 'var(--bg)' }}>
        {/* Board area */}
        <div className="flex-1 h-full flex flex-col" style={{ minWidth: 0 }}>
          {/* Header */}
          <div
            style={{
              padding: 'var(--space-4) var(--space-5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
              borderBottom: '1px solid var(--separator)',
            }}
          >
            <div>
              <h1
                style={{
                  fontSize: 'var(--text-title2)',
                  fontWeight: 'var(--weight-bold)',
                  color: 'var(--text-primary)',
                  margin: 0,
                  letterSpacing: '-0.3px',
                }}
              >
                Kanban Board
              </h1>
              <p
                style={{
                  fontSize: 'var(--text-caption1)',
                  color: 'var(--text-tertiary)',
                  margin: '2px 0 0',
                }}
              >
                {ticketCount} ticket{ticketCount !== 1 ? 's' : ''}
              </p>
            </div>

            <button
              onClick={() => setCreateOpen(true)}
              style={{
                borderRadius: 'var(--radius-md)',
                padding: '8px 16px',
                fontSize: 'var(--text-footnote)',
                fontWeight: 'var(--weight-semibold)',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                background: 'var(--accent)',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              <Plus size={16} />
              New Ticket
            </button>
          </div>

          {/* Employee filter bar */}
          {assignedEmployees.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-5)',
                overflowX: 'auto',
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setFilterEmployeeId(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  padding: '4px 12px',
                  borderRadius: 'var(--radius-full)',
                  border: 'none',
                  fontSize: 'var(--text-caption1)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: filterEmployeeId === null ? 'var(--accent)' : 'var(--fill-tertiary)',
                  color: filterEmployeeId === null ? 'white' : 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              >
                All
              </button>
              {assignedEmployees.map((emp) => (
                <button
                  key={emp.name}
                  onClick={() =>
                    setFilterEmployeeId(filterEmployeeId === emp.name ? null : emp.name)
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-1)',
                    padding: '4px 12px',
                    borderRadius: 'var(--radius-full)',
                    border: 'none',
                    fontSize: 'var(--text-caption1)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    background:
                      filterEmployeeId === emp.name
                        ? 'var(--accent)'
                        : 'var(--fill-tertiary)',
                    color:
                      filterEmployeeId === emp.name
                        ? 'white'
                        : 'var(--text-secondary)',
                    flexShrink: 0,
                  }}
                >
                  {emp.displayName}
                </button>
              ))}
            </div>
          )}

          {/* Board */}
          <div style={{ flex: 1, padding: '0 var(--space-3)', minHeight: 0 }}>
            {loading ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: 'var(--text-tertiary)',
                  fontSize: 'var(--text-caption1)',
                }}
              >
                Loading...
              </div>
            ) : (
              <KanbanBoard
                tickets={tickets}
                employees={employees}
                onTicketClick={handleTicketClick}
                onMoveTicket={handleMoveTicket}
                onCreateTicket={() => setCreateOpen(true)}
                filterEmployeeId={filterEmployeeId}
              />
            )}
          </div>
        </div>

        {/* Mobile backdrop */}
        {selectedTicket && (
          <div
            className="fixed inset-0 z-30 lg:hidden"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            onClick={() => setSelectedTicket(null)}
          />
        )}

        {/* Detail panel */}
        {selectedTicket && (
          <TicketDetailPanel
            ticket={selectedTicket}
            employees={employees}
            onClose={() => setSelectedTicket(null)}
            onStatusChange={(status) => handleMoveTicket(selectedTicket.id, status)}
            onAssigneeChange={(name) => handleAssigneeChange(selectedTicket.id, name)}
            onDelete={() => handleDeleteTicket(selectedTicket.id)}
          />
        )}

        {/* Create ticket modal */}
        <CreateTicketModal
          open={createOpen}
          onOpenChange={setCreateOpen}
          employees={employees}
          onSubmit={handleCreateTicket}
        />
      </div>
    </PageLayout>
  )
}

// Kanban board types

export type TicketStatus = 'backlog' | 'todo' | 'in-progress' | 'review' | 'done'

export type TicketPriority = 'low' | 'medium' | 'high'

export type WorkState = 'idle' | 'starting' | 'working' | 'done' | 'failed'

export interface KanbanTicket {
  id: string
  title: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  assigneeId: string | null // employee name from /api/org
  workState: WorkState
  createdAt: number
  updatedAt: number
  /** The department this ticket belongs to; null for tickets not yet saved to any department */
  departmentId: string | null
}

export interface KanbanColumn {
  id: TicketStatus
  title: string
}

export const COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'todo', title: 'To Do' },
  { id: 'in-progress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
]

export const PRIORITY_COLORS: Record<TicketPriority, string> = {
  low: 'var(--system-green)',
  medium: 'var(--system-orange)',
  high: 'var(--system-red)',
}

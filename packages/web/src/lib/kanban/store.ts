'use client'

import type { KanbanTicket, TicketStatus, TicketPriority, WorkState } from './types'

export type KanbanStore = Record<string, KanbanTicket>

const STORAGE_KEY = 'jinn-kanban'

const VALID_STATUSES = new Set<TicketStatus>(['backlog', 'todo', 'in-progress', 'review', 'done'])
const VALID_PRIORITIES = new Set<TicketPriority>(['low', 'medium', 'high'])
const VALID_WORK_STATES = new Set<WorkState>(['idle', 'starting', 'working', 'done', 'failed'])

/** Validate and sanitize a ticket loaded from localStorage */
function sanitizeTicket(id: string, raw: Record<string, unknown>): KanbanTicket | null {
  // Require essential fields
  if (typeof raw.title !== 'string' || !raw.title) return null

  const status = (VALID_STATUSES.has(raw.status as TicketStatus) ? raw.status : 'backlog') as TicketStatus
  const priority = (VALID_PRIORITIES.has(raw.priority as TicketPriority) ? raw.priority : 'medium') as TicketPriority
  const workState = (VALID_WORK_STATES.has(raw.workState as WorkState) ? raw.workState : 'idle') as WorkState

  return {
    id,
    title: raw.title as string,
    description: typeof raw.description === 'string' ? raw.description : '',
    status,
    priority,
    assigneeId: typeof raw.assigneeId === 'string' ? raw.assigneeId : null,
    workState,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : (typeof raw.createdAt === 'number' ? raw.createdAt : 0),
    departmentId: typeof raw.departmentId === 'string' ? raw.departmentId : null,
  }
}

export function loadTickets(): KanbanStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
    const store: KanbanStore = {}

    for (const id of Object.keys(parsed)) {
      const ticket = sanitizeTicket(id, parsed[id])
      if (!ticket) continue // Skip corrupted entries

      // Recover tickets stuck mid-work (e.g. page reload during streaming).
      // Reset them to todo/idle so they can be re-triggered.
      if (ticket.workState === 'working' || ticket.workState === 'starting') {
        ticket.status = 'todo'
        ticket.workState = 'idle'
      }

      store[id] = ticket
    }

    return store
  } catch {
    return {}
  }
}

export function saveTickets(store: KanbanStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch { /* storage full or unavailable */ }
}

export function createTicket(
  store: KanbanStore,
  ticket: Omit<KanbanTicket, 'id' | 'createdAt' | 'updatedAt' | 'workState'>,
): KanbanStore {
  const id = crypto.randomUUID()
  const now = Date.now()
  return {
    ...store,
    [id]: {
      ...ticket,
      id,
      workState: 'idle',
      createdAt: now,
      updatedAt: now,
      departmentId: ticket.departmentId ?? null,
    },
  }
}

export function updateTicket(
  store: KanbanStore,
  id: string,
  updates: Partial<Omit<KanbanTicket, 'id' | 'createdAt'>>,
): KanbanStore {
  const existing = store[id]
  if (!existing) return store
  return {
    ...store,
    [id]: { ...existing, ...updates, updatedAt: Date.now() },
  }
}

export function moveTicket(
  store: KanbanStore,
  id: string,
  status: TicketStatus,
): KanbanStore {
  return updateTicket(store, id, { status })
}

export function deleteTicket(store: KanbanStore, id: string): KanbanStore {
  const next = { ...store }
  delete next[id]
  return next
}

export function getTicketsByStatus(
  store: KanbanStore,
  status: TicketStatus,
): KanbanTicket[] {
  return Object.values(store)
    .filter((t) => t.status === status)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

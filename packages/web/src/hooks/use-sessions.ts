import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api, type SessionsResponse } from '@/lib/api'

// The query cache holds the full SessionsResponse; both hooks below select from
// the same cached object so there is only ever one network request. Sidebar
// "load more" appends pages into `sessions` via queryClient.setQueryData.

export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions.all,
    queryFn: () => api.getSessions(),
    select: (d: SessionsResponse) => d.sessions,
  })
}

export function useSessionCounts() {
  return useQuery({
    queryKey: queryKeys.sessions.all,
    queryFn: () => api.getSessions(),
    select: (d: SessionsResponse) => ({ counts: d.counts, perGroup: d.perGroup }),
  })
}

// Server-side search across ALL sessions (not just the loaded page). Enabled
// only when there's a query; results are short-lived since they reflect a search.
export function useSessionSearch(query: string) {
  const q = query.trim()
  return useQuery({
    queryKey: queryKeys.sessions.search(q),
    queryFn: () => api.searchSessions(q),
    enabled: q.length > 0,
    staleTime: 10_000,
  })
}

export function useUpdateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string } }) =>
      api.updateSession(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
    onError: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useBulkDeleteSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteSessions(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useDuplicateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.duplicateSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

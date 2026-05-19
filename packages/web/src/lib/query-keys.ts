export const queryKeys = {
  sessions: {
    all: ['sessions'] as const,
    search: (q: string) => ['sessions', 'search', q] as const,
    detail: (id: string) => ['sessions', id] as const,
    children: (id: string) => ['sessions', id, 'children'] as const,
    transcript: (id: string) => ['sessions', id, 'transcript'] as const,
    queue: (id: string) => ['sessions', id, 'queue'] as const,
  },
  org: {
    all: ['org'] as const,
    employee: (name: string) => ['org', 'employees', name] as const,
    board: (dept: string) => ['org', 'departments', dept, 'board'] as const,
  },
  cron: {
    all: ['cron'] as const,
    runs: (id: string) => ['cron', id, 'runs'] as const,
  },
  skills: {
    all: ['skills'] as const,
    detail: (name: string) => ['skills', name] as const,
  },
  config: ['config'] as const,
  status: ['status'] as const,
} as const

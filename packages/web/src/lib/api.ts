export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  content: TranscriptContentBlock[]
}

export interface QueueItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'cancelled' | 'completed';
  position: number;
  createdAt: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "director" | "manager" | "lead" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  emoji?: string;
}

export interface OrgData {
  departments: string[];
  employees: string[];
}

export interface OrgTreeEmployee {
  name: string;
  displayName: string;
  rank: string;
}

export interface OrgTreeNode {
  name: string;
  displayName: string;
  description?: string;
  path: string;
  manager?: OrgTreeEmployee;
  employees: OrgTreeEmployee[];
  children: OrgTreeNode[];
}

export interface OrgTreeData {
  tree: OrgTreeNode[];
  unassigned: string[];
}

const BASE =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:7777";

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body.error) return String(body.error);
    if (body.message) return String(body.message);
  } catch {
    // Response wasn't JSON — fall through
  }
  return `API error: ${res.status}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

interface UploadedFile {
  id: string
  filename: string
  size: number
  mimetype: string | null
}

export const api = {
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  getSessions: () => get<Record<string, unknown>[]>("/api/sessions"),
  getSession: (id: string) => get<Record<string, unknown>>(`/api/sessions/${id}`),
  getSessionChildren: (id: string) => get<Record<string, unknown>[]>(`/api/sessions/${id}/children`),
  deleteSession: (id: string) => del<Record<string, unknown>>(`/api/sessions/${id}`),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ status: string; count: number }>("/api/sessions/bulk-delete", { ids }),
  createSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions", data),
  createStubSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions/stub", data),
  sendMessage: (id: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/message`, data),
  stopSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/stop`, {}),
  resetSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/reset`, {}),
  getCronJobs: () => get<Record<string, unknown>[]>("/api/cron"),
  getCronRuns: (id: string) => get<Record<string, unknown>[]>(`/api/cron/${id}/runs`),
  updateCronJob: (id: string, data: Record<string, unknown>) =>
    put<Record<string, unknown>>(`/api/cron/${id}`, data),
  triggerCronJob: (id: string) =>
    post<Record<string, unknown>>(`/api/cron/${id}/trigger`, {}),
  getOrg: () => get<OrgData>("/api/org"),
  getOrgTree: () => get<OrgTreeData>("/api/org/tree"),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  getDepartmentBoard: (name: string) =>
    get<Record<string, unknown>>(`/api/org/departments/${name}/board`),
  getSkills: () => get<Record<string, unknown>[]>("/api/skills"),
  getSkill: (name: string) => get<Record<string, unknown>>(`/api/skills/${name}`),
  getConfig: () => get<Record<string, unknown>>("/api/config"),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  updateConfig: (data: Record<string, unknown>) =>
    put<Record<string, unknown>>("/api/config", data),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; portalName: string | null; operatorName: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { portalName?: string; operatorName?: string; language?: string }) =>
    post<{ status: string; portal: { portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
  getActivity: () =>
    get<Array<{ event: string; payload: unknown; ts: number }>>("/api/activity"),
  updateDepartmentBoard: (name: string, data: unknown) =>
    put<Record<string, unknown>>(`/api/org/departments/${name}/board`, data),
  sttStatus: () =>
    get<{ available: boolean; model: string | null; downloading: boolean; progress: number; languages: string[] }>("/api/stt/status"),
  sttDownload: () =>
    post<{ status: string; model: string }>("/api/stt/download", {}),
  sttTranscribe: async (audioBlob: Blob, language?: string): Promise<{ text: string }> => {
    const params = language ? `?language=${encodeURIComponent(language)}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); // 5 min timeout
    try {
      const res = await fetch(`${BASE}/api/stt/transcribe${params}`, {
        method: "POST",
        headers: { "Content-Type": audioBlob.type || "audio/webm" },
        body: audioBlob,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Transcription timed out (5 min)");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
  sttUpdateConfig: (languages: string[]) =>
    put<{ status: string; languages: string[] }>("/api/stt/config", { languages }),
  getSessionQueue: (id: string) =>
    get<QueueItem[]>(`/api/sessions/${id}/queue`),
  cancelQueueItem: (sessionId: string, itemId: string) =>
    del<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}`),
  clearSessionQueue: (sessionId: string) =>
    del<{ status: string; cancelled: number }>(`/api/sessions/${sessionId}/queue`),
  pauseSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/pause`, {}),
  resumeSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/resume`, {}),
  getSessionTranscript: (id: string) =>
    get<TranscriptEntry[]>(`/api/sessions/${id}/transcript`),
  uploadFile: async (file: File): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BASE}/api/files`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(await extractErrorMessage(res))
    return res.json()
  },
};

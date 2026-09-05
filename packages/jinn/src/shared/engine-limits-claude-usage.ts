import type { EngineLimitWindow } from "./types.js";
import { isRecord, num, str, type JsonRecord } from "./engine-limits-util.js";

function usageWindow(name: string, percent: number, resetsAtIso: string | undefined, durationMins?: number): EngineLimitWindow {
  const parsed = resetsAtIso ? Date.parse(resetsAtIso) : NaN;
  const resetsAt = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
  return {
    name,
    usedPercent: Math.round(percent),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: resetsAt !== undefined ? resetsAtIso : undefined,
  };
}

function limitLabel(kind: string, modelName: string | undefined): { name: string; durationMins?: number } {
  if (kind === "session") return { name: "5h", durationMins: 300 };
  if (kind === "weekly_all") return { name: "7d", durationMins: 10_080 };
  // Scoped buckets have no duration so the UI keeps their model in the label.
  if (kind === "weekly_scoped") return { name: modelName ? `7d ${modelName}` : "7d (scoped)" };
  return { name: modelName ? `${kind} ${modelName}` : kind };
}

function windowFromLimit(item: unknown): EngineLimitWindow | undefined {
  if (!isRecord(item)) return undefined;
  const percent = num(item.percent);
  if (percent === undefined) return undefined;
  const scope = isRecord(item.scope) ? item.scope : undefined;
  const model = scope && isRecord(scope.model) ? scope.model : undefined;
  const modelName = model ? str(model.display_name) : undefined;
  const label = limitLabel(str(item.kind) ?? "limit", modelName);
  return usageWindow(label.name, percent, str(item.resets_at), label.durationMins);
}

function windowFromNamedBucket([key, value]: [string, unknown]): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const utilization = num(value.utilization);
  if (utilization === undefined) return undefined;
  const resetsAtIso = str(value.resets_at);
  if (key === "five_hour") return usageWindow("5h", utilization, resetsAtIso, 300);
  if (key === "seven_day") return usageWindow("7d", utilization, resetsAtIso, 10_080);
  return usageWindow(key.replace(/^seven_day_/, "7d "), utilization, resetsAtIso);
}

/**
 * Every numeric limits[] bucket is displayed, including future server-side
 * kinds. Older responses fall back to named utilization buckets when the
 * array yields none. Repeated display names retain their first reading.
 */
export function windowsFromClaudeUsage(usage: JsonRecord): EngineLimitWindow[] {
  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  const liveWindows = limits.map(windowFromLimit).filter((window) => window !== undefined);
  const windows = liveWindows.length > 0
    ? liveWindows
    : Object.entries(usage).map(windowFromNamedBucket).filter((window) => window !== undefined);
  const seen = new Set<string>();
  return windows.filter((window) => {
    if (seen.has(window.name)) return false;
    seen.add(window.name);
    return true;
  });
}

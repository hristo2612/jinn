/**
 * Pieces shared by the per-engine limit collectors: JSON narrowing, the
 * window-name convention, and the registry-derived snapshot every collector
 * starts from. Split out of engine-limits.ts so each engine's collector can
 * live in its own module without duplicating them.
 */
import type { EngineLimitEngineSnapshot, JinnConfig } from "./types.js";
import { getModelRegistry } from "./models.js";

export type JsonRecord = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function isoFromSeconds(seconds: number | undefined): string | undefined {
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

export function limitWindowName(fallback: string, durationMins: number | undefined): string {
  if (durationMins === 300) return "5h";
  if (durationMins === 10_080) return "7d";
  return fallback;
}

export function baseSnapshot(config: JinnConfig, engine: string): EngineLimitEngineSnapshot {
  const registry = getModelRegistry(config);
  const entry = registry[engine];
  return {
    name: engine,
    available: entry?.available ?? false,
    status: entry?.available ? "static" : "unavailable",
    source: "model-registry",
    refreshedAt: nowIso(),
    defaultModel: entry?.defaultModel,
    models: entry?.models ?? [],
  };
}

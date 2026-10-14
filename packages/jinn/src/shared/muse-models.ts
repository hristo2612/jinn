import type { ModelInfo } from "./types.js";

/**
 * Muse model catalog (lab fork). Muse has no non-interactive model-list
 * command, so — like the offline Claude/Grok fallbacks — the registry ships a
 * known list and the operator can override it wholesale with a `models.muse`
 * block in config.yaml. Ids observed in the Muse 1.4.7 model catalog;
 * `*-contributor` variants are per-run mode overrides of the CLI, not models
 * an employee should pin, so they are deliberately not listed.
 */
export const MUSE_EFFORT_LEVELS: string[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const MUSE_DEFAULT_MODEL = "muse-wonder-full-1.0";

const KNOWN: ReadonlyArray<{ id: string; label: string }> = [
  { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0" },
  { id: "muse-wonder-1.0", label: "Muse Wonder 1.0" },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
];

function museModelInfo(entry: { id: string; label: string }): ModelInfo {
  return { id: entry.id, label: entry.label, supportsEffort: true, effortLevels: [...MUSE_EFFORT_LEVELS] };
}

/** Known catalog with an operator pin floated to the front (mirrors knownGrokModels). */
export function knownMuseModels(pinned?: string): { defaultModel: string; models: ModelInfo[] } {
  const models = KNOWN.map(museModelInfo);
  if (pinned && !models.some((m) => m.id === pinned)) {
    models.unshift({ id: pinned, label: pinned, supportsEffort: true, effortLevels: [...MUSE_EFFORT_LEVELS] });
  }
  return { defaultModel: pinned || MUSE_DEFAULT_MODEL, models };
}

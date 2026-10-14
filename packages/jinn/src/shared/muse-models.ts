import type { ModelInfo } from "./types.js";

/**
 * Muse model catalog (lab fork). Muse has no non-interactive model-list
 * command, so — like the offline Claude/Grok fallbacks — the registry ships a
 * known list and the operator can override it wholesale with a `models.muse`
 * block in config.yaml.
 *
 * Slugs are the `visibility: visible` rows of the Muse 1.4.7 model
 * catalog (meta/tbh profile, verified 2026-10-14). Hidden rows are excluded
 * on purpose: `*-contributor` are per-run contributor-mode variants, not
 * models to pin, and `muse-image-1.0` is an image-generation model, not a
 * coding engine. The default follows the catalog's own `is_default` row
 * (muse-wonder-1.0); muse-wonder-full-1.0 stays selectable per employee.
 */
export const MUSE_EFFORT_LEVELS: string[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const MUSE_DEFAULT_MODEL = "muse-wonder-1.0";

const CONTEXT_WINDOW = 1007997;

const KNOWN: ReadonlyArray<{ id: string; label: string }> = [
  { id: "muse-wonder-1.0", label: "Muse Wonder 1.0" },
  { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0" },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2" },
];

function museModelInfo(entry: { id: string; label: string }): ModelInfo {
  return {
    id: entry.id,
    label: entry.label,
    supportsEffort: true,
    effortLevels: [...MUSE_EFFORT_LEVELS],
    contextWindow: CONTEXT_WINDOW,
  };
}

/** Known catalog with an operator pin floated to the front (mirrors knownGrokModels). */
export function knownMuseModels(pinned?: string): { defaultModel: string; models: ModelInfo[] } {
  const models = KNOWN.map(museModelInfo);
  if (pinned && !models.some((m) => m.id === pinned)) {
    models.unshift({ id: pinned, label: pinned, supportsEffort: true, effortLevels: [...MUSE_EFFORT_LEVELS] });
  }
  return { defaultModel: pinned || MUSE_DEFAULT_MODEL, models };
}

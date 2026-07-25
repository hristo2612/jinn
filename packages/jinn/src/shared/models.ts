import type {
  JinnConfig,
  ModelInfo,
  ModelRegistry,
  EngineRegistryEntry,
  EffortMechanism,
  EngineModelsConfig,
} from "./types.js";
import { logger } from "./logger.js";
import { resolveBin, isInstalled } from "./resolve-bin.js";
import { discoverPiModels } from "./pi-models.js";
import {
  CLAUDE_ALIAS_IDS,
  discoverClaudeEffortLevels,
  discoverClaudeModels,
  knownClaudeModels,
  type ClaudeModelDiscovery,
} from "./claude-models.js";
import {
  discoverCodexModels,
  type CodexModelDiscovery,
} from "./codex-models.js";
import {
  discoverAntigravityModels,
  type AntigravityModelDiscovery,
} from "./antigravity-models.js";
import {
  discoverGrokModels,
  GROK_EFFORT_LEVELS,
  knownGrokModels,
  type GrokModelDiscovery,
} from "./grok-models.js";
import {
  discoverHermesModels,
  knownHermesModels,
  HERMES_EFFORT_LEVELS,
  type HermesModelDiscovery,
} from "./hermes-models.js";

/**
 * Model + capability registry — the single source of truth for which engines and
 * models exist and what they support (effort levels, availability).
 *
 * Sources, in precedence order per engine:
 *   1. Dynamic discovery, refreshed at boot and on config reload into
 *      snapshots that the (synchronous) registry reads.
 *   2. The optional `models:` block in config.yaml.
 *   3. Synthesis from `engines.<name>.model` (back-compat default).
 *
 * `available` reflects whether the engine's binary is actually installed, so the
 * UI can hide engines you don't have.
 */

/** Engines registered in this build (mirrors server.ts engine map). */
const ENGINE_NAMES = ["claude", "codex", "antigravity", "grok", "pi", "hermes"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

/** Binary name probed for each engine's availability (override via engines.<name>.bin). */
const ENGINE_BIN: Record<EngineName, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  grok: "grok",
  pi: "pi",
  hermes: "hermes",
};

const EFFORT_MECHANISM: Record<EngineName, EffortMechanism> = {
  claude: "claude-flag",
  codex: "codex-config",
  antigravity: "none",
  grok: "grok-flag",
  pi: "pi-flag",
  hermes: "none",
};

export const CODEX_DEFAULT_MODEL = "gpt-5.5";

/** Conservative per-engine defaults used when synthesizing (no `models:` block). */
const SYNTH_DEFAULTS: Record<EngineName, { supportsEffort: boolean; effortLevels: string[]; fallbackModel: string }> = {
  claude: { supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], fallbackModel: "opus" },
  codex: { supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"], fallbackModel: CODEX_DEFAULT_MODEL },
  antigravity: { supportsEffort: false, effortLevels: [], fallbackModel: "Gemini 3.5 Flash (Medium)" },
  grok: { supportsEffort: true, effortLevels: GROK_EFFORT_LEVELS, fallbackModel: "grok-build" },
  // Placeholder shown only in the brief window before pi discovery completes; the
  // provider/id form keeps it well-typed for the engine's split.
  pi: { supportsEffort: false, effortLevels: [], fallbackModel: "ollama/gemma4:12b" },
  hermes: { supportsEffort: false, effortLevels: HERMES_EFFORT_LEVELS, fallbackModel: "openai-codex:gpt-5.5" },
};

/** Optional per-engine `bin` override from config. */
function engineBinOverride(config: JinnConfig, name: EngineName): string | undefined {
  return (config.engines as unknown as Record<string, { bin?: string } | undefined>)[name]?.bin;
}

/** Whether an engine's binary is installed (gates UI visibility). */
export function engineAvailable(config: JinnConfig, name: EngineName): boolean {
  const bin = ENGINE_BIN[name];
  // Unknown engine name (e.g. a typo in config.sessions.fallbackEngine) → not available.
  if (!bin) return false;
  return isInstalled(bin, engineBinOverride(config, name));
}

/** Type guard: is `name` one of the known engines? */
export function isKnownEngine(name: string): name is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(name);
}

/** Install hint per engine, surfaced when a missing CLI blocks a session. */
const ENGINE_INSTALL_HINT: Record<EngineName, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  antigravity: "install the Antigravity CLI (agy)",
  grok: "npm install -g @xai-official/grok, then run grok once to authenticate",
  pi: "install the Pi CLI",
  hermes: "install the Hermes CLI: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
};

/** Actionable error message for a session blocked by a missing engine binary. */
export function engineUnavailableMessage(config: JinnConfig, name: EngineName): string {
  const bin = engineBinOverride(config, name) || ENGINE_BIN[name];
  return `Engine "${name}" is not available — the "${bin}" CLI was not found on your PATH. Install it (${ENGINE_INSTALL_HINT[name]}) or set engines.${name}.bin in config.yaml to its full path, then retry.`;
}

/** Snapshot of dynamically-discovered Pi models (null until first discovery). */
let discoveredPiModels: ModelInfo[] | null = null;
/** Snapshot of dynamically-discovered Claude models (null until first discovery). */
let discoveredClaudeModels: ClaudeModelDiscovery | null = null;
/** Snapshot of Claude Code's read-only `--effort` options (null until first discovery). */
let discoveredClaudeEffortLevels: string[] | null = null;
/** Snapshot of dynamically-discovered Codex models (null until first discovery). */
let discoveredCodexModels: CodexModelDiscovery | null = null;
/** Snapshot of dynamically-discovered Antigravity models (null until first discovery). */
let discoveredAntigravityModels: AntigravityModelDiscovery | null = null;
/** Snapshot of dynamically-discovered Grok models (null until first discovery). */
let discoveredGrokModels: GrokModelDiscovery | null = null;
/** Snapshot of dynamically-discovered Hermes models (null until first discovery). */
let discoveredHermesModels: HermesModelDiscovery | null = null;

/**
 * Discover Claude's catalog through Claude Code OAuth. This is best-effort and
 * read-only; it never validates a model by starting a Claude turn.
 */
export async function refreshClaudeModels(config: JinnConfig): Promise<void> {
  if (!engineAvailable(config, "claude")) {
    discoveredClaudeModels = null;
    discoveredClaudeEffortLevels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("claude", engineBinOverride(config, "claude"));
    discoveredClaudeEffortLevels = await discoverClaudeEffortLevels(bin);
    discoveredClaudeModels = await discoverClaudeModels({
      effortLevels: discoveredClaudeEffortLevels.length > 0 ? discoveredClaudeEffortLevels : undefined,
    });
    logger.info(`Claude model discovery: ${discoveredClaudeModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Claude model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredClaudeModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

export function setDiscoveredClaudeModelsForTest(models: ClaudeModelDiscovery | null): void {
  discoveredClaudeModels = models;
  discoveredClaudeEffortLevels = null;
  invalidateModelRegistry();
}

/** Discover Codex's model catalog (`codex debug models`) and refresh the registry. */
export async function refreshCodexModels(config: JinnConfig): Promise<void> {
  if (!engineAvailable(config, "codex")) {
    discoveredCodexModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("codex", engineBinOverride(config, "codex"));
    discoveredCodexModels = await discoverCodexModels(bin);
    logger.info(`Codex model discovery: ${discoveredCodexModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Codex model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredCodexModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

/** Discover Antigravity's model catalog (`agy models`) and refresh the registry. */
export async function refreshAntigravityModels(config: JinnConfig): Promise<void> {
  if (!engineAvailable(config, "antigravity")) {
    discoveredAntigravityModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("agy", engineBinOverride(config, "antigravity"));
    discoveredAntigravityModels = await discoverAntigravityModels(bin);
    logger.info(`Antigravity model discovery: ${discoveredAntigravityModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Antigravity model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredAntigravityModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

/**
 * Discover Pi's local/custom models (`pi --list-models`) and refresh the registry.
 * Async — populates a snapshot the synchronous registry reads. Never throws;
 * degrades to the config/synthesized fallback when Pi is absent or discovery fails.
 */
export async function refreshPiModels(config: JinnConfig): Promise<void> {
  if (!engineAvailable(config, "pi")) {
    discoveredPiModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("pi", engineBinOverride(config, "pi"));
    discoveredPiModels = await discoverPiModels(bin);
    logger.info(`Pi model discovery: ${discoveredPiModels.length} local model(s)`);
  } catch (err) {
    logger.warn(`Pi model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredPiModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

/**
 * Discover Grok's authenticated model list (`grok models`) and refresh the registry.
 * Never throws; until discovery succeeds the registry uses Jinn's known Grok model
 * catalog so the UI still shows the public Grok choices.
 */
export async function refreshGrokModels(config: JinnConfig): Promise<void> {
  if (!engineAvailable(config, "grok")) {
    discoveredGrokModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("grok", engineBinOverride(config, "grok"));
    discoveredGrokModels = await discoverGrokModels(bin);
    logger.info(`Grok model discovery: ${discoveredGrokModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Grok model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredGrokModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

/**
 * Discover Hermes's available model list and refresh the registry.
 * Never throws; until discovery succeeds the registry uses Jinn's known Hermes model
 * catalog so the UI still shows the public Hermes choices.
 */
export async function refreshHermesModels(config: JinnConfig): Promise<void> {
  if (!engineAvailable(config, "hermes")) {
    discoveredHermesModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("hermes", engineBinOverride(config, "hermes"));
    discoveredHermesModels = await discoverHermesModels(bin);
    logger.info(`Hermes model discovery: ${discoveredHermesModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Hermes model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredHermesModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

let cached: ModelRegistry | null = null;

/** Clear the cached registry. Call on config reload / PUT /api/config. */
export function invalidateModelRegistry(): void {
  cached = null;
}

/** Resolve the registry (cached). Pass the current config; cache is keyed by
 *  invalidation, not by config identity — call invalidateModelRegistry() to refresh. */
export function getModelRegistry(config: JinnConfig): ModelRegistry {
  if (!cached) cached = buildRegistry(config);
  return cached;
}

/**
 * Valid effort levels for a session's engine+model, from the registry.
 * Returns [] when the engine/model doesn't support effort (e.g. antigravity) or
 * the engine is unknown. `modelId` defaults to the engine's default model.
 */
export function effortLevelsForModel(config: JinnConfig, engine: string, modelId?: string): string[] {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return [];
  const model =
    (modelId ? entry.models.find((m) => m.id === modelId) : undefined) ??
    entry.models.find((m) => m.id === entry.defaultModel) ??
    entry.models[0];
  return model?.supportsEffort ? model.effortLevels : [];
}

/** Context window (tokens) for a session's engine+model, or undefined if unknown. */
/** Declared context window for a model.
 *
 *  By default an unlisted model falls back to the engine's default model, which
 *  is right for display but wrong for comparisons: it would report model Y's
 *  window for model X. Pass `exact` when the answer is only meaningful if this
 *  specific model is actually in the roster. */
export function contextWindowForModel(
  config: JinnConfig,
  engine: string,
  modelId?: string,
  opts?: { exact?: boolean },
): number | undefined {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return undefined;
  const exactMatch = modelId ? entry.models.find((m) => m.id === modelId) : undefined;
  if (opts?.exact) return exactMatch?.contextWindow;
  const model =
    exactMatch ??
    entry.models.find((m) => m.id === entry.defaultModel) ??
    entry.models[0];
  return model?.contextWindow;
}

/** Build the registry without touching the cache (used by getModelRegistry + tests). */
export function buildRegistry(config: JinnConfig): ModelRegistry {
  const synthesized = synthesizeFromEngineConfig(config);
  const block = config.models;

  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const available = engineAvailable(config, name);
    // Dynamic engine model discovery overrides
    // both the config block and synthesis.
    if (name === "claude") {
      registry[name] = buildClaudeEntry(config, block?.claude, synthesized[name], available);
      continue;
    }
    if (name === "codex") {
      registry[name] = buildCodexEntry(config, block?.codex, synthesized[name], available);
      continue;
    }
    if (name === "antigravity") {
      registry[name] = buildAntigravityEntry(config, block?.antigravity, synthesized[name], available);
      continue;
    }
    if (name === "pi") {
      registry[name] = buildPiEntry(config, block?.pi, synthesized[name], available);
      continue;
    }
    if (name === "grok") {
      registry[name] = buildGrokEntry(config, block?.grok, synthesized[name], available);
      continue;
    }
    if (name === "hermes") {
      registry[name] = buildHermesEntry(config, block?.hermes, synthesized[name], available);
      continue;
    }
    const engineBlock = block?.[name];
    registry[name] = engineBlock
      ? fromEngineModelsConfig(name, engineBlock, available)
      : synthesized[name]; // engine omitted from the block → keep the synthesized entry
  }
  return registry;
}

/**
 * Mark the picker's featured set. Featured models show by default in the UI
 * before the "More models…" expansion; the rest stay one click away. Only ids
 * that actually exist in `models` are featured; `matched`/`unmatched` let the
 * caller detect a misconfigured override. Order/membership of `models` is
 * untouched — only the `featured` flag is set on matches.
 */
function applyFeatured(
  models: ModelInfo[],
  featuredIds: readonly string[],
): { models: ModelInfo[]; matched: string[]; unmatched: string[] } {
  const known = new Set(models.map((m) => m.id));
  const matched = featuredIds.filter((id) => known.has(id));
  const unmatched = featuredIds.filter((id) => !known.has(id));
  if (matched.length === 0) return { models, matched, unmatched };
  const featured = new Set(matched);
  return {
    models: models.map((m) => (featured.has(m.id) ? { ...m, featured: true } : m)),
    matched,
    unmatched,
  };
}

/**
 * Resolve the featured set for the claude picker, distinguishing three cases of
 * `engines.claude.featuredModels`:
 *   - absent      → default to the three latest alias families.
 *   - explicit [] → nothing featured (deliberate "long picker" opt-out).
 *   - nonempty    → feature the matching ids; warn about typos, and if NONE match
 *                   fall back to the default set so a stale override can't silently
 *                   regress the picker to the full 10+ model list.
 */
function resolveClaudeFeatured(merged: ModelInfo[], configured: string[] | undefined): ModelInfo[] {
  const defaults = [...CLAUDE_ALIAS_IDS];
  if (configured === undefined) return applyFeatured(merged, defaults).models;
  if (configured.length === 0) return merged;

  const res = applyFeatured(merged, configured);
  if (res.matched.length === 0) {
    logger.warn(
      `engines.claude.featuredModels matched no known models (${configured.join(", ")}); ` +
        `falling back to the default featured set (${defaults.join(", ")}).`,
    );
    return applyFeatured(merged, defaults).models;
  }
  if (res.unmatched.length > 0) {
    logger.warn(`engines.claude.featuredModels: ignoring unknown model id(s): ${res.unmatched.join(", ")}`);
  }
  return res.models;
}

/** Claude registry entry: discovered aliases/catalog > config additions > alias fallback. */
function buildClaudeEntry(
  config: JinnConfig,
  claudeBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  const pinned = config.engines.claude?.model;
  const discovered = discoveredClaudeModels?.models.length ? discoveredClaudeModels : null;
  const base = discovered ?? knownClaudeModels(pinned, discoveredClaudeEffortLevels ?? undefined);
  const merged = mergeDiscoveredModels(base.models, claudeBlock, { configuredOverridesDiscovered: false });
  const models = resolveClaudeFeatured(merged, config.engines.claude?.featuredModels);
  const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
  const defaultModel = valid(pinned) ?? valid(claudeBlock?.default) ?? valid(base.defaultModel) ?? models[0]?.id ?? synthEntry.defaultModel;
  return { name: "claude", available, defaultModel, effortMechanism: "claude-flag", models };
}

/** Codex registry entry: discovered catalog > config block > synthesized. */
function buildCodexEntry(
  config: JinnConfig,
  codexBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  if (discoveredCodexModels && discoveredCodexModels.models.length > 0) {
    const models = mergeDiscoveredModels(discoveredCodexModels.models, codexBlock, { configuredOverridesDiscovered: true });
    const pinned = config.engines.codex?.model;
    const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
    const defaultModel = valid(pinned) ?? valid(codexBlock?.default) ?? valid(discoveredCodexModels.defaultModel) ?? models[0].id;
    return { name: "codex", available, defaultModel, effortMechanism: "codex-config", models };
  }
  if (codexBlock) return fromEngineModelsConfig("codex", codexBlock, available, config.engines.codex?.model);
  return { ...synthEntry, available };
}

/** Antigravity registry entry: discovered catalog > config block > synthesized. */
function buildAntigravityEntry(
  config: JinnConfig,
  antigravityBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  if (discoveredAntigravityModels && discoveredAntigravityModels.models.length > 0) {
    const models = mergeDiscoveredModels(discoveredAntigravityModels.models, antigravityBlock, { configuredOverridesDiscovered: true });
    const pinned = config.engines.antigravity?.model;
    const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
    const defaultModel = valid(pinned) ?? valid(antigravityBlock?.default) ?? valid(discoveredAntigravityModels.defaultModel) ?? models[0].id;
    return { name: "antigravity", available, defaultModel, effortMechanism: "none", models };
  }
  if (antigravityBlock) return fromEngineModelsConfig("antigravity", antigravityBlock, available, config.engines.antigravity?.model);
  return { ...synthEntry, available };
}

/** Grok registry entry: discovered models > config `models.grok` block > known catalog. */
function buildGrokEntry(
  config: JinnConfig,
  grokBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  if (discoveredGrokModels && discoveredGrokModels.models.length > 0) {
    const models = mergeDiscoveredGrokModels(discoveredGrokModels.models, grokBlock);
    const pinned = config.engines.grok?.model;
    const configuredDefault = grokBlock?.default;
    const discoveredDefault = discoveredGrokModels.defaultModel;
    const validDefault = (id: string | undefined) => id && models.some((m) => m.id === id) ? id : undefined;
    const defaultModel =
      validDefault(pinned) ??
      validDefault(configuredDefault) ??
      validDefault(discoveredDefault) ??
      models[0].id;
    return { name: "grok", available, defaultModel, effortMechanism: "grok-flag", models };
  }
  if (grokBlock) return fromEngineModelsConfig("grok", grokBlock, available, config.engines.grok?.model);

  const known = knownGrokModels(config.engines.grok?.model);
  const defaultModel = known.defaultModel || synthEntry.defaultModel;
  return {
    name: "grok",
    available,
    defaultModel,
    effortMechanism: "grok-flag",
    models: known.models,
  };
}

/** Hermes registry entry: discovered models > config `models.hermes` block > known catalog. */
function buildHermesEntry(
  config: JinnConfig,
  hermesBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  const pinned = config.engines.hermes?.model;
  if (discoveredHermesModels && discoveredHermesModels.models.length > 0) {
    const models = discoveredHermesModels.models;
    const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
    const defaultModel = valid(pinned) ?? valid(discoveredHermesModels.defaultModel) ?? models[0].id;
    return { name: "hermes", available, defaultModel, effortMechanism: "none", models };
  }
  if (hermesBlock) return fromEngineModelsConfig("hermes", hermesBlock, available, pinned);
  const known = knownHermesModels(pinned);
  return { name: "hermes", available, defaultModel: known.defaultModel || synthEntry.defaultModel, effortMechanism: "none", models: known.models };
}

/** Pi registry entry: discovered models > config `models.pi` block > synthesized. */
function buildPiEntry(
  config: JinnConfig,
  piBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  if (discoveredPiModels && discoveredPiModels.length > 0) {
    let models = discoveredPiModels;
    const pinned = config.engines.pi?.model;
    if (pinned && !models.some((m) => m.id === pinned)) {
      models = [{
        id: pinned,
        label: pinned,
        supportsEffort: false,
        effortLevels: [],
      }, ...models];
    }
    const defaultModel = pinned || models[0].id;
    return { name: "pi", available, defaultModel, effortMechanism: "pi-flag", models };
  }
  if (piBlock) return fromEngineModelsConfig("pi", piBlock, available, config.engines.pi?.model);
  return { ...synthEntry, available };
}

/** Backward-compat: synthesize a minimal registry from engines.<name>.model. */
export function synthesizeFromEngineConfig(config: JinnConfig): ModelRegistry {
  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const defaults = SYNTH_DEFAULTS[name];
    const engineCfg = (config.engines as unknown as Record<string, { model?: string } | undefined>)[name];
    const modelId = engineCfg?.model || defaults.fallbackModel;
    if (name === "claude") {
      const known = knownClaudeModels(modelId);
      registry[name] = {
        name,
        available: engineAvailable(config, name),
        defaultModel: known.defaultModel || modelId,
        effortMechanism: EFFORT_MECHANISM[name],
        models: known.models,
      };
      continue;
    }
    if (name === "grok") {
      const known = knownGrokModels(modelId);
      registry[name] = {
        name,
        available: engineAvailable(config, name),
        defaultModel: known.defaultModel || modelId,
        effortMechanism: EFFORT_MECHANISM[name],
        models: known.models,
      };
      continue;
    }
    const model: ModelInfo = {
      id: modelId,
      label: modelId,
      supportsEffort: defaults.supportsEffort,
      effortLevels: defaults.supportsEffort ? [...defaults.effortLevels] : [],
    };
    registry[name] = {
      name,
      available: engineAvailable(config, name),
      defaultModel: modelId,
      effortMechanism: EFFORT_MECHANISM[name],
      models: [model],
    };
  }
  return registry;
}

function mergeDiscoveredModels(
  discovered: ModelInfo[],
  block: EngineModelsConfig | undefined,
  opts: { configuredOverridesDiscovered: boolean },
): ModelInfo[] {
  if (!block) return discovered;

  const configured = new Map(block.models.map((m) => [m.id, m]));
  const hidden = new Set(block.hidden ?? []);
  const seen = new Set<string>();
  const merged = discovered.filter((model) => !hidden.has(model.id)).map((model) => {
    seen.add(model.id);
    const configuredModel = configured.get(model.id);
    if (!configuredModel) return model;
    if (!opts.configuredOverridesDiscovered) return model;

    const supportsEffort = configuredModel.supportsEffort ?? model.supportsEffort;
    return {
      id: model.id,
      label: configuredModel.label || model.label,
      supportsEffort,
      effortLevels: supportsEffort ? (configuredModel.effortLevels ?? model.effortLevels) : [],
      ...(typeof configuredModel.contextWindow === "number"
        ? { contextWindow: configuredModel.contextWindow }
        : typeof model.contextWindow === "number"
          ? { contextWindow: model.contextWindow }
          : {}),
    };
  });

  for (const configuredModel of block.models) {
    if (hidden.has(configuredModel.id)) continue;
    if (!seen.has(configuredModel.id)) merged.push(modelInfoFromConfigEntry(configuredModel));
  }
  return merged;
}

function modelInfoFromConfigEntry(m: EngineModelsConfig["models"][number]): ModelInfo {
  const supportsEffort = m.supportsEffort ?? false;
  return {
    id: m.id,
    label: m.label || m.id,
    supportsEffort,
    effortLevels: supportsEffort ? (m.effortLevels ?? []) : [],
    ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
  };
}

function fromEngineModelsConfig(
  name: EngineName,
  block: EngineModelsConfig,
  available: boolean,
  pinnedModel?: string,
): EngineRegistryEntry {
  const hidden = new Set(block.hidden ?? []);
  const models: ModelInfo[] = (block.models ?? []).filter((m) => !hidden.has(m.id)).map((m) => {
    return modelInfoFromConfigEntry(m);
  });
  const validDefault = (id: string | undefined) => id && models.some((m) => m.id === id) ? id : undefined;
  const defaultModel = validDefault(pinnedModel) ?? validDefault(block.default) ?? models[0]?.id ?? SYNTH_DEFAULTS[name].fallbackModel;
  return {
    name,
    available,
    defaultModel,
    effortMechanism: block.effortMechanism ?? EFFORT_MECHANISM[name],
    models,
  };
}

function mergeDiscoveredGrokModels(discovered: ModelInfo[], block: EngineModelsConfig | undefined): ModelInfo[] {
  if (!block) return discovered;

  const configured = new Map(block.models.map((m) => [m.id, m]));
  const hidden = new Set(block.hidden ?? []);
  const seen = new Set<string>();
  const merged = discovered.filter((model) => !hidden.has(model.id)).map((model) => {
    seen.add(model.id);
    const configuredModel = configured.get(model.id);
    if (!configuredModel) return model;

    const supportsEffort = configuredModel.supportsEffort ?? model.supportsEffort;
    return {
      id: model.id,
      label: configuredModel.label || model.label,
      supportsEffort,
      effortLevels: supportsEffort ? (configuredModel.effortLevels ?? model.effortLevels) : [],
      ...(typeof configuredModel.contextWindow === "number"
        ? { contextWindow: configuredModel.contextWindow }
        : typeof model.contextWindow === "number"
          ? { contextWindow: model.contextWindow }
          : {}),
    };
  });

  for (const configuredModel of block.models) {
    if (hidden.has(configuredModel.id)) continue;
    if (!seen.has(configuredModel.id)) merged.push(modelInfoFromConfigEntry(configuredModel));
  }

  return merged;
}

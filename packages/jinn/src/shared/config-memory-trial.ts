/**
 * Validation for the `memoryTrial` block of jinn.config.
 *
 * Its own module so config.ts stays inside the 300-line limit, and split into
 * one function per concern so no single one carries the whole branch count:
 * the block has eight fields and three cross-field rules, more shape than any
 * other config section.
 */

type Block = Record<string, unknown>;

/** `problems` for a field that is present and of the wrong primitive type. */
function wrongType(block: Block, key: string, expected: "boolean" | "string"): string[] {
  const value = block[key];
  if (value === undefined || typeof value === expected) return [];
  return [`memoryTrial.${key} must be a ${expected} (got ${typeof value})`];
}

/** The activation epoch: finite when present, and required once enabled. */
function activationProblems(block: Block): string[] {
  const problems: string[] = [];
  const epoch = block.activationEpoch;
  if (epoch !== undefined && (typeof epoch !== "number" || !Number.isFinite(epoch))) {
    problems.push(`memoryTrial.activationEpoch must be a finite number (got ${typeof epoch})`);
  }
  if (block.enabled === true && typeof epoch !== "number") {
    problems.push("memoryTrial.activationEpoch is required when memoryTrial.enabled is true");
  }
  return problems;
}

/** The project root: absolute when present, and required once auto-archiving. */
function projectProblems(block: Block): string[] {
  const problems: string[] = [];
  const root = block.projectRoot;
  if (root !== undefined && (typeof root !== "string" || !root.startsWith("/"))) {
    problems.push("memoryTrial.projectRoot must be an absolute path");
  }
  problems.push(...wrongType(block, "autoArchiveProjectContent", "boolean"));
  if (block.autoArchiveProjectContent === true && typeof root !== "string") {
    problems.push("memoryTrial.projectRoot is required when autoArchiveProjectContent is true");
  }
  return problems;
}

/** The trigger list: an array, and only the two triggers the trial supports. */
function triggerProblems(block: Block): string[] {
  const triggers = block.triggers;
  if (triggers === undefined) return [];
  if (!Array.isArray(triggers)) return ["memoryTrial.triggers must be an array"];
  return triggers
    .filter((trigger) => trigger !== "authorized-session-start" && trigger !== "session-finalized")
    .map((trigger) => `memoryTrial.triggers contains unsupported trigger ${JSON.stringify(trigger)}`);
}

/** Every problem with the block, or an empty list when it is absent or sound. */
export function validateMemoryTrial(memoryTrial: unknown): string[] {
  if (memoryTrial === undefined) return [];
  if (typeof memoryTrial !== "object" || memoryTrial === null || Array.isArray(memoryTrial)) {
    return ["memoryTrial must be a mapping"];
  }
  const block = memoryTrial as Block;
  return [
    ...wrongType(block, "enabled", "boolean"),
    ...wrongType(block, "circuitOpen", "boolean"),
    ...activationProblems(block),
    ...projectProblems(block),
    ...triggerProblems(block),
  ];
}

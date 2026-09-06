import { assertIsolatedTestHome, createIsolatedTestFileHome } from './vitest.test-home.js';

// setupFiles execute inside each worker before its test module is evaluated.
// Abort loudly if the pre-worker global setup ever stops propagating its home.
assertIsolatedTestHome(process.env.JINN_HOME);
// A safe run-level home still shares SQLite state across forks. Allocate before
// static imports freeze paths; global teardown removes every file subtree.
createIsolatedTestFileHome();

/**
 * Scrub gateway/engine env that leaks in when the suite runs from inside a live
 * Jinn session — the common case on the operator's machine, where a Claude PTY
 * exports these into every child process.
 *
 * Same isolation boundary and same failure class as the JINN_HOME leak: the
 * test's result silently depends on WHO ran it. This one is not hypothetical —
 * it broke claude-interactive-compact-window.test.ts, whose "no proxy → no
 * first-party assertion" case failed on an inherited '1' from the enclosing PTY.
 *
 * JINN_HOME is deliberately NOT listed: setup owns the per-file home, and it
 * has already been asserted above.
 */
const LEAKY_ENV_VARS = [
  // Claude Code PTY env injected by the gateway (engines/claude-interactive.ts).
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDECODE',
  'ANTHROPIC_BASE_URL',
  // Session identity — a test inheriting these could act as a real session.
  'JINN_SESSION_ID',
  'JINN_SESSION_CAPABILITY',
  'JINN_GATEWAY_URL',
  'JINN_GATEWAY_TOKEN',
  'JINN_HOME_IDENTITY',
  // Instance identity — the live gateway exports its own binding into every session,
  // and JINN_HOST/JINN_PORT outrank a fixture's config.yaml wherever a test loads one.
  'JINN_INSTANCE',
  'JINN_HOST',
  'JINN_PORT',
  // Engine homes.
  'CODEX',
  'CODEX_HOME',
] as const;

for (const name of LEAKY_ENV_VARS) delete process.env[name];

/**
 * Deliberately NOT importing assertNotProductionGateway (src/shared/sandbox-env.ts)
 * here: a setup file's imports are instantiated before every test module, so pulling
 * in shared/home.ts caches it against the real 'node:os' and any later
 * vi.mock('node:os') in a test whose graph reaches it silently stops applying —
 * fork-claude-projectdir.test.ts fails that way. assertIsolatedTestHome above is the
 * stronger check regardless: it refuses the production home AND every non-temp one.
 */

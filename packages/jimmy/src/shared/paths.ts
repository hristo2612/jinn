import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve the home directory for the current instance. */
function resolveHome(): string {
  if (process.env.JINN_HOME) return process.env.JINN_HOME;
  const instance = process.env.JINN_INSTANCE || "jinn";
  return path.join(os.homedir(), `.${instance}`);
}

export const JINN_HOME = resolveHome();
export const CONFIG_PATH = path.join(JINN_HOME, "config.yaml");
export const SESSIONS_DB = path.join(JINN_HOME, "sessions", "registry.db");
export const CRON_JOBS = path.join(JINN_HOME, "cron", "jobs.json");
export const CRON_RUNS = path.join(JINN_HOME, "cron", "runs");
export const ORG_DIR = path.join(JINN_HOME, "org");
export const SKILLS_DIR = path.join(JINN_HOME, "skills");
export const DOCS_DIR = path.join(JINN_HOME, "docs");
export const LOGS_DIR = path.join(JINN_HOME, "logs");
export const TMP_DIR = path.join(JINN_HOME, "tmp");
export const MODELS_DIR = path.join(JINN_HOME, "models");
export const STT_MODELS_DIR = path.join(JINN_HOME, "models", "whisper");
export const PID_FILE = path.join(JINN_HOME, "gateway.pid");
export const CLAUDE_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
export const AGENTS_SKILLS_DIR = path.join(JINN_HOME, ".agents", "skills");
export const TEMPLATE_DIR = path.join(__dirname, "..", "..", "..", "template");
export const FILES_DIR = path.join(JINN_HOME, "files");
export const MIGRATIONS_DIR = path.join(JINN_HOME, "migrations");
export const TEMPLATE_MIGRATIONS_DIR = path.join(TEMPLATE_DIR, "migrations");

/** Path to the global instances registry (always in default ~/.jinn/) */
export const INSTANCES_REGISTRY = path.join(os.homedir(), ".jinn", "instances.json");

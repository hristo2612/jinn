import fs from "node:fs";
import path from "node:path";
import type { Employee, JimmyConfig } from "../shared/types.js";
import { JIMMY_HOME, SKILLS_DIR, ORG_DIR, CRON_JOBS, DOCS_DIR } from "../shared/paths.js";

/**
 * Build a rich system prompt for engine sessions.
 * This is what makes Jimmy "smart" — the engine sees all of this context
 * before responding to the user.
 */
export function buildContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
  connectors?: string[];
  config?: JimmyConfig;
}): string {
  const sections: string[] = [];

  // ── Identity ──────────────────────────────────────────────
  if (opts.employee) {
    sections.push(opts.employee.persona);
  } else {
    sections.push(buildIdentity());
  }

  // ── CLAUDE.md (user-defined instructions) ─────────────────
  const claudeMd = loadClaudeMd();
  if (claudeMd) {
    sections.push(`## User Instructions (CLAUDE.md)\n\n${claudeMd}`);
  }

  // ── Session context ───────────────────────────────────────
  sections.push(buildSessionContext(opts));

  // ── Configuration awareness ───────────────────────────────
  if (opts.config) {
    sections.push(buildConfigContext(opts.config));
  }

  // ── Organization ──────────────────────────────────────────
  const orgCtx = buildOrgContext();
  if (orgCtx) sections.push(orgCtx);

  // ── Skills ────────────────────────────────────────────────
  const skillsCtx = buildSkillsContext();
  if (skillsCtx) sections.push(skillsCtx);

  // ── Cron jobs ─────────────────────────────────────────────
  const cronCtx = buildCronContext();
  if (cronCtx) sections.push(cronCtx);

  // ── Knowledge / docs ──────────────────────────────────────
  const knowledgeCtx = buildKnowledgeContext();
  if (knowledgeCtx) sections.push(knowledgeCtx);

  // ── Connectors (Slack, etc.) ──────────────────────────────
  if (opts.connectors && opts.connectors.length > 0) {
    sections.push(buildConnectorContext(opts.connectors));
  }

  // ── Gateway API reference ─────────────────────────────────
  sections.push(buildApiReference());

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// Section builders
// ═══════════════════════════════════════════════════════════════

function buildIdentity(): string {
  return `# You are Jimmy

Jimmy is a personal AI assistant and gateway daemon. You are proactive, helpful, and opinionated — not a passive tool. You anticipate needs, suggest improvements, and take initiative when appropriate.

## Core principles
- **Be proactive**: Don't just answer questions — suggest next steps, flag issues, offer to do related tasks.
- **Be concise**: Respect the user's time. Lead with the answer, not the reasoning.
- **Be capable**: You have access to the filesystem, can run commands, call APIs, send messages via connectors, and manage the Jimmy system.
- **Be honest**: If you don't know something or can't do something, say so clearly.
- **Remember context**: You're part of a persistent system. Sessions can be resumed. Build on previous work.

## Your home directory
Your working directory is \`~/.jimmy\` (${JIMMY_HOME}). This contains:
- \`config.yaml\` — your configuration (engines, connectors, logging)
- \`org/\` — employee definitions (YAML files defining AI workers)
- \`skills/\` — reusable skill prompts
- \`docs/\` — documentation and knowledge base
- \`knowledge/\` — persistent knowledge files
- \`cron/\` — scheduled job definitions and run history
- \`sessions/\` — session database
- \`logs/\` — gateway logs
- \`CLAUDE.md\` — user-defined instructions (always follow these)
- \`AGENTS.md\` — agent/employee documentation

You can read, write, and modify any of these files to configure yourself, create new employees, add skills, etc.`;
}

function loadClaudeMd(): string | null {
  const claudePath = path.join(JIMMY_HOME, "CLAUDE.md");
  try {
    const content = fs.readFileSync(claudePath, "utf-8").trim();
    // Skip if it's just the default template
    if (content.length < 100 && content.includes("Jimmy orchestrates Claude Code")) {
      return null;
    }
    return content;
  } catch {
    return null;
  }
}

function buildSessionContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
}): string {
  let ctx = `## Current session\n`;
  ctx += `- Source: ${opts.source}\n`;
  ctx += `- Channel: ${opts.channel}\n`;
  if (opts.thread) ctx += `- Thread: ${opts.thread}\n`;
  ctx += `- User: ${opts.user}\n`;
  ctx += `- Working directory: ${JIMMY_HOME}`;
  return ctx;
}

function buildConfigContext(config: JimmyConfig): string {
  const lines: string[] = [`## Current configuration`];
  lines.push(`- Gateway: http://${config.gateway.host || "127.0.0.1"}:${config.gateway.port}`);
  lines.push(`- Default engine: ${config.engines.default}`);
  if (config.engines.claude?.model) {
    lines.push(`- Claude model: ${config.engines.claude.model}`);
  }
  if (config.engines.codex?.model) {
    lines.push(`- Codex model: ${config.engines.codex.model}`);
  }
  if (config.logging) {
    lines.push(`- Log level: ${config.logging.level || "info"}`);
  }
  return lines.join("\n");
}

function buildOrgContext(): string | null {
  try {
    const files = fs.readdirSync(ORG_DIR).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    if (files.length === 0) return null;

    const lines: string[] = [`## Organization (${files.length} employee(s))`];
    for (const file of files) {
      const content = fs.readFileSync(path.join(ORG_DIR, file), "utf-8");
      const name = file.replace(/\.ya?ml$/, "");
      // Extract display name and department from YAML (simple parse)
      const displayMatch = content.match(/displayName:\s*(.+)/);
      const deptMatch = content.match(/department:\s*(.+)/);
      const rankMatch = content.match(/rank:\s*(.+)/);
      lines.push(`- **${displayMatch?.[1] || name}** (${name}) — ${deptMatch?.[1] || "unassigned"}, ${rankMatch?.[1] || "employee"}`);
    }
    lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildSkillsContext(): string | null {
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md") || f.endsWith(".txt"));
    if (files.length === 0) return null;

    const lines: string[] = [`## Available skills (${files.length})`];
    for (const file of files) {
      const name = file.replace(/\.(md|txt)$/, "");
      lines.push(`- ${name}`);
    }
    lines.push(`\nSkill files are in \`${SKILLS_DIR}/\`. You can read them for detailed instructions.`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildCronContext(): string | null {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs) || jobs.length === 0) return null;

    const lines: string[] = [`## Scheduled cron jobs (${jobs.length})`];
    for (const job of jobs) {
      const status = job.enabled === false ? " (disabled)" : "";
      lines.push(`- **${job.name}**: \`${job.schedule}\`${status}${job.employee ? ` → ${job.employee}` : ""}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildKnowledgeContext(): string | null {
  const dirs = [DOCS_DIR, path.join(JIMMY_HOME, "knowledge")];
  const allFiles: string[] = [];

  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml"));
      allFiles.push(...files.map(f => `${dir}/${f}`));
    } catch {
      // dir doesn't exist
    }
  }

  if (allFiles.length === 0) return null;

  const lines: string[] = [`## Knowledge base (${allFiles.length} file(s))`];
  for (const file of allFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push(`\nYou can read these files for detailed information when needed.`);
  return lines.join("\n");
}

function buildConnectorContext(connectors: string[]): string {
  const lines: string[] = [`## Available connectors: ${connectors.join(", ")}`];
  lines.push(`You can send messages and interact with external services via the Jimmy gateway API.`);
  lines.push(`Use bash with curl to call these endpoints:\n`);

  if (connectors.includes("slack")) {
    lines.push(`### Slack`);
    lines.push(`- **Send message**: \`curl -X POST http://127.0.0.1:7777/api/connectors/slack/send -H 'Content-Type: application/json' -d '{"channel":"CHANNEL_ID","text":"message"}'\``);
    lines.push(`- **Send threaded reply**: add \`"thread":"THREAD_TS"\` to the JSON body`);
    lines.push(`- Channel IDs can be found in \`~/.jimmy/config.yaml\` or by checking Slack`);
    lines.push(`- You can proactively send messages to Slack without being asked — e.g., to notify about completed tasks, errors, or status updates`);
  }

  lines.push(`\n- **List connectors**: \`curl http://127.0.0.1:7777/api/connectors\``);
  return lines.join("\n");
}

function buildApiReference(): string {
  return `## Jimmy Gateway API (http://127.0.0.1:7777)

You can call these endpoints with curl to inspect and manage the gateway:

| Endpoint | Method | Description |
|----------|--------|-------------|
| \`/api/status\` | GET | Gateway status, uptime, engine info |
| \`/api/sessions\` | GET | List all sessions |
| \`/api/sessions/:id\` | GET | Session detail |
| \`/api/sessions\` | POST | Create new session (\`{prompt, engine?, employee?}\`) |
| \`/api/cron\` | GET | List cron jobs |
| \`/api/cron/:id\` | PUT | Update cron job (toggle enabled, etc.) |
| \`/api/cron/:id/runs\` | GET | Cron run history |
| \`/api/org\` | GET | Organization structure |
| \`/api/org/employees/:name\` | GET | Employee details |
| \`/api/skills\` | GET | List skills |
| \`/api/skills/:name\` | GET | Skill content |
| \`/api/config\` | GET | Current config |
| \`/api/config\` | PUT | Update config |
| \`/api/connectors\` | GET | List connectors |
| \`/api/connectors/:name/send\` | POST | Send message via connector |
| \`/api/logs\` | GET | Recent log lines |`;
}

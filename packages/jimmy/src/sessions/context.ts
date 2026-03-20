import fs from "node:fs";
import path from "node:path";
import type { Employee, JinnConfig } from "../shared/types.js";
import { JINN_HOME, ORG_DIR, CRON_JOBS, DOCS_DIR } from "../shared/paths.js";
import { scanOrgFull } from "../gateway/org.js";

/**
 * Token budget strategy:
 *
 * Sections are split into three tiers that are assembled in order.
 * If the accumulated prompt exceeds the configurable budget (default 100K chars),
 * lower-tier sections are progressively replaced with compact summaries.
 *
 *   ESSENTIAL  – identity, session, config                (always included)
 *   STANDARD   – org summary, cron summary, connectors,
 *                API ref, evolution, language              (included when budget allows)
 *   OPTIONAL   – knowledge listing, environment scan,
 *                delegation protocol                       (trimmed first when over budget)
 *
 * Knowledge and docs files are NEVER inlined — only filenames are listed.
 * The AI can read files on demand, saving ~200K+ chars per session.
 */

const DEFAULT_MAX_CONTEXT_CHARS = 100_000;

// ── Tier enum for progressive trimming ────────────────────────
const enum Tier {
  ESSENTIAL = 0,
  STANDARD = 1,
  OPTIONAL = 2,
}

interface Section {
  tier: Tier;
  marker: string; // leading text used to identify the section in trimContext
  content: string;
  summary: string; // compact fallback when budget is tight
}

/**
 * Build a rich system prompt for engine sessions.
 * This is what makes Jinn "smart" — the engine sees all of this context
 * before responding to the user.
 */
export function buildContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
  connectors?: string[];
  config?: JinnConfig;
  sessionId?: string;
  portalName?: string;
  operatorName?: string;
  language?: string;
  channelName?: string;
}): string {
  const maxChars = opts.config?.context?.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const sections: Section[] = [];

  // Compute gateway URL once — used by multiple sections
  const gatewayUrl = opts.config
    ? `http://${opts.config.gateway.host || "127.0.0.1"}:${opts.config.gateway.port || 7777}`
    : "http://127.0.0.1:7777";

  // Resolve personalized names from config
  const portalName = opts.portalName || opts.config?.portal?.portalName || "Jinn";
  const operatorName = opts.operatorName || opts.config?.portal?.operatorName;
  const language = opts.language || opts.config?.portal?.language || "English";

  // ── ESSENTIAL: Identity ─────────────────────────────────────
  if (opts.employee) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildEmployeeIdentity(opts.employee, portalName, language),
      summary: `# You are ${opts.employee.displayName}\nEmployee: ${opts.employee.name}, ${opts.employee.department}, ${opts.employee.rank}`,
    });
  } else {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildIdentity(portalName, operatorName, language),
      summary: `# You are ${portalName}\nYour working directory is \`~/.jinn\` (${JINN_HOME}).`,
    });
  }

  // ── STANDARD: Self-evolution ────────────────────────────────
  if (!opts.employee) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Self-evolution",
      content: buildEvolutionContext(portalName),
      summary: `## Self-evolution\nUpdate knowledge files in \`~/.jinn/knowledge/\` when you learn new info about the user or their projects.`,
    });
  }

  // ── ESSENTIAL: Session context ──────────────────────────────
  sections.push({
    tier: Tier.ESSENTIAL,
    marker: "## Current session",
    content: buildSessionContext({ ...opts, sessionId: opts.sessionId }),
    summary: "", // always included, no trimming
  });

  // ── ESSENTIAL: Configuration awareness ──────────────────────
  if (opts.config) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "## Current configuration",
      content: buildConfigContext(opts.config, gatewayUrl),
      summary: "", // always included
    });
  }

  // ── STANDARD: Organization ──────────────────────────────────
  const orgCtx = buildOrgContext();
  if (orgCtx) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Organization",
      content: orgCtx,
      summary: `## Organization\nEmployee files are in \`${ORG_DIR}/\`. Read them directly when needed.`,
    });
  }

  // ── STANDARD: Cron jobs (only enabled, with disabled count) ─
  const cronCtx = buildCronContext();
  if (cronCtx) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Scheduled cron",
      content: cronCtx,
      summary: "## Scheduled cron jobs\nCron definitions are in `~/.jinn/cron/jobs.json`. Read directly when needed.",
    });
  }

  // ── OPTIONAL: Knowledge / docs (filenames only, never inlined)
  const knowledgeCtx = buildKnowledgeContext();
  if (knowledgeCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Knowledge base",
      content: knowledgeCtx,
      summary: "## Knowledge base\nKnowledge files are in `~/.jinn/knowledge/` and `~/.jinn/docs/`. Read them directly when needed.",
    });
  }

  // ── STANDARD: Cross-department services ────────────────────
  if (opts.employee) {
    const svcCtx = buildServicesContext(opts.employee, gatewayUrl);
    if (svcCtx) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Available cross-department services",
        content: svcCtx,
        summary: `## Cross-department services\nUse \`POST ${gatewayUrl}/api/org/cross-request\` to request services from other departments.`,
      });
    }
  }

  // ── STANDARD: Language override for skills ──────────────────
  if (language !== "English") {
    sections.push({
      tier: Tier.STANDARD,
      marker: "When following skill",
      content: `When following skill instructions, always communicate with the user in ${language}, even if the skill contains English examples or dialogue.`,
      summary: `Communicate in ${language}.`,
    });
  }

  // ── STANDARD: Connectors (Slack, etc.) ──────────────────────
  if (opts.connectors && opts.connectors.length > 0) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Available connectors",
      content: buildConnectorContext(opts.connectors, gatewayUrl, portalName),
      summary: `## Available connectors: ${opts.connectors.join(", ")}\nUse \`curl POST ${gatewayUrl}/api/connectors/<name>/send\` to send messages.`,
    });
  }

  // ── OPTIONAL: Local environment ─────────────────────────────
  const envCtx = buildEnvironmentContext();
  if (envCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Local environment",
      content: envCtx,
      summary: "## Local environment\nRun `ls ~/` to explore the local filesystem.",
    });
  }

  // ── OPTIONAL: Delegation protocol (COO only) ───────────────
  if (!opts.employee) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Employee Delegation",
      content: buildDelegationProtocol(gatewayUrl, portalName, opts.config),
      summary: `## Employee Delegation Protocol\nDelegate via \`POST ${gatewayUrl}/api/sessions\` with \`{prompt, employee, parentSessionId}\`. Check children via \`GET /api/sessions/:id/children\`.`,
    });
  }

  // ── STANDARD: Gateway API reference ─────────────────────────
  sections.push({
    tier: Tier.STANDARD,
    marker: `## ${portalName} Gateway API`,
    content: buildApiReference(gatewayUrl, portalName),
    summary: `## ${portalName} Gateway API (${gatewayUrl})\nEndpoints: /api/status, /api/sessions, /api/cron, /api/org, /api/skills, /api/config, /api/connectors, /api/logs`,
  });

  // ── Assemble with progressive trimming by tier ──────────────
  return trimContext(sections, maxChars);
}

// ═══════════════════════════════════════════════════════════════
// Section builders
// ═══════════════════════════════════════════════════════════════

function buildEmployeeIdentity(employee: Employee, portalName: string, language: string): string {
  const languageInstruction = language !== "English"
    ? `\n**Language**: Always respond in ${language}. All your communication with the user must be in ${language}.\n`
    : "";

  return `# You are ${employee.displayName}

You are an AI employee in the ${portalName} gateway system.

## Your persona
${employee.persona}
${languageInstruction}
## Your role
- **Name**: ${employee.name}
- **Display name**: ${employee.displayName}
- **Department**: ${employee.department}
- **Rank**: ${employee.rank}
- **Engine**: ${employee.engine}
- **Model**: ${employee.model}

## System context
You are part of the ${portalName} AI gateway — a system that orchestrates AI workers. You have access to the filesystem, can run commands, call APIs, and send messages via connectors. Your working directory is \`~/.jinn\` (${JINN_HOME}).

You can:
- Read and write files in the home directory
- Run shell commands
- Call the gateway API to interact with other parts of the system
- Send messages via connectors (Slack, etc.)
- Access skills, knowledge base, and documentation
- Collaborate with other employees by mentioning them or creating sessions

Be proactive, take initiative, and deliver results. You're not a chatbot — you're a worker.

${buildChainOfCommand(employee)}`;
}

/**
 * Build the chain of command section for an employee's system prompt.
 */
function buildChainOfCommand(employee: Employee): string {
  try {
    const { employees, departments } = scanOrgFull();
    const orgPath = employee.orgPath;
    if (!orgPath) return "";

    const dept = departments.get(orgPath);
    if (!dept) return "";

    const lines: string[] = ["## Chain of command"];

    // Find top-level division (walk up the parent chain)
    let topDept = dept;
    while (topDept.parent && departments.has(topDept.parent)) {
      topDept = departments.get(topDept.parent)!;
    }

    if (topDept.path !== dept.path) {
      const topManager = topDept.manager ? employees.get(topDept.manager) : undefined;
      const topManagerStr = topManager ? `${topManager.displayName}` : topDept.manager || "unassigned";
      lines.push(`- **Division**: ${topDept.displayName} (directed by ${topManagerStr})`);
    }

    lines.push(`- **Team**: ${dept.displayName}`);

    // Your manager
    if (employee.reportsTo) {
      const manager = employees.get(employee.reportsTo);
      if (manager) {
        lines.push(`- **Your manager**: ${manager.displayName} (${manager.rank})`);
      } else {
        lines.push(`- **Your manager**: ${employee.reportsTo}`);
      }
    }

    // Direct reports: employees whose reportsTo is this employee
    const directReports: Employee[] = [];
    for (const [, emp] of employees) {
      if (emp.reportsTo === employee.name) {
        directReports.push(emp);
      }
    }
    if (directReports.length > 0) {
      const reportsList = directReports.map((r) => `${r.displayName} (${r.rank})`).join(", ");
      lines.push(`- **Your direct reports**: ${reportsList}`);
    }

    // Escalation path
    const escalation: string[] = [];
    let current = employee.reportsTo;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const mgr = employees.get(current);
      escalation.push(mgr ? mgr.displayName : current);
      current = mgr?.reportsTo;
    }
    escalation.push("Noxis (COO)");
    // Deduplicate in case Noxis is already in the chain
    const uniqueEscalation = [...new Set(escalation)];
    lines.push(`- **Escalation path**: ${uniqueEscalation.join(" -> ")}`);

    return lines.join("\n");
  } catch {
    return "";
  }
}

function buildIdentity(portalName: string, operatorName?: string, language?: string): string {
  const operatorLine = operatorName
    ? `\nThe user's name is **${operatorName}**. Address them by name when appropriate.`
    : "";

  const languageInstruction = language && language !== "English"
    ? `\n**Language**: Always respond in ${language}. All your communication with the user must be in ${language}.`
    : "";

  return `# You are ${portalName}

${portalName} is a personal AI assistant and gateway daemon. You are proactive, helpful, and opinionated — not a passive tool. You anticipate needs, suggest improvements, and take initiative when appropriate.${operatorLine}

## Core principles
- **Be proactive**: Don't just answer questions — suggest next steps, flag issues, offer to do related tasks.
- **Be concise**: Respect the user's time. Lead with the answer, not the reasoning.
- **Be capable**: You have access to the filesystem, can run commands, call APIs, send messages via connectors, and manage the system.
- **Be honest**: If you don't know something or can't do something, say so clearly.
- **Remember context**: You're part of a persistent system. Sessions can be resumed. Build on previous work.
${languageInstruction}
## Your home directory
Your working directory is \`~/.jinn\` (${JINN_HOME}). This contains:
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

function buildSessionContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  sessionId?: string;
  channelName?: string;
}): string {
  let ctx = `## Current session\n`;
  if (opts.sessionId) ctx += `- Session ID: ${opts.sessionId}\n`;
  ctx += `- Source: ${opts.source}\n`;
  if (opts.channelName) {
    ctx += `- Channel: #${opts.channelName} (${opts.channel})\n`;
  } else if (opts.source === "slack" && opts.channel.startsWith("D")) {
    ctx += `- Channel: Direct Message (${opts.channel})\n`;
  } else {
    ctx += `- Channel: ${opts.channel}\n`;
  }
  if (opts.thread) ctx += `- Thread: ${opts.thread}\n`;
  ctx += `- User: ${opts.user}\n`;
  ctx += `- Working directory: ${JINN_HOME}`;
  return ctx;
}

function buildConfigContext(config: JinnConfig, gatewayUrl: string): string {
  const lines: string[] = [`## Current configuration`];
  lines.push(`- Gateway: ${gatewayUrl}`);
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
    // Recursively collect all employee yaml files (skip department.yaml)
    const employeeFiles: { fullPath: string; name: string }[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
          entry.name !== "department.yaml"
        ) {
          employeeFiles.push({ fullPath, name: entry.name.replace(/\.ya?ml$/, "") });
        }
      }
    }

    scanDir(ORG_DIR);
    if (employeeFiles.length === 0) return null;

    const lines: string[] = [`## Organization (${employeeFiles.length} employee(s))`];
    for (const { fullPath, name } of employeeFiles) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const displayMatch = content.match(/displayName:\s*(.+)/);
      const deptMatch = content.match(/department:\s*(.+)/);
      const rankMatch = content.match(/rank:\s*(.+)/);
      const personaMatch = content.match(/persona:\s*[|>]?\s*\n?\s*(.+)/);
      let entry = `- **${displayMatch?.[1] || name}** (${name}) — ${deptMatch?.[1] || "unassigned"}, ${rankMatch?.[1] || "employee"}`;
      if (personaMatch?.[1]) {
        entry += `\n  _${personaMatch[1].trim().slice(0, 120)}_`;
      }
      lines.push(entry);
    }
    lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Cron context: shows only enabled jobs inline, with a count of disabled jobs.
 * Previously listed all 77+ jobs; now only active ones are shown to save tokens.
 */
function buildCronContext(): string | null {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs) || jobs.length === 0) return null;

    const enabled = jobs.filter((j: any) => j.enabled !== false);
    const disabledCount = jobs.length - enabled.length;

    const lines: string[] = [`## Scheduled cron jobs (${enabled.length} active, ${disabledCount} disabled)`];
    for (const job of enabled) {
      lines.push(`- **${job.name}**: \`${job.schedule}\`${job.employee ? ` → ${job.employee}` : ""}`);
    }
    if (disabledCount > 0) {
      lines.push(`\n_${disabledCount} disabled jobs not shown. See \`~/.jinn/cron/jobs.json\` for the full list._`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Knowledge context: lists filenames and sizes only — never inlines content.
 * The AI reads files on demand. This saves ~200K+ chars compared to full inlining.
 */
function buildKnowledgeContext(): string | null {
  const dirs = [
    { dir: DOCS_DIR, label: "docs" },
    { dir: path.join(JINN_HOME, "knowledge"), label: "knowledge" },
  ];
  const entries: { name: string; dir: string; sizeKb: string }[] = [];

  for (const { dir, label } of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f =>
        f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml"),
      );
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(dir, f));
          entries.push({
            name: f,
            dir: label,
            sizeKb: (stat.size / 1024).toFixed(1),
          });
        } catch {
          entries.push({ name: f, dir: label, sizeKb: "?" });
        }
      }
    } catch {
      // dir doesn't exist
    }
  }

  if (entries.length === 0) return null;

  const lines: string[] = [
    `## Knowledge base`,
    `Knowledge files are in \`~/.jinn/knowledge/\` and \`~/.jinn/docs/\`. Read them directly when needed.`,
    ``,
  ];

  // Group by directory
  for (const label of ["docs", "knowledge"]) {
    const group = entries.filter(e => e.dir === label);
    if (group.length === 0) continue;
    lines.push(`**${label}/** (${group.length} files):`);
    for (const e of group) {
      lines.push(`- \`${e.name}\` (${e.sizeKb} KB)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildConnectorContext(connectors: string[], gatewayUrl: string, portalName: string): string {
  const lines: string[] = [`## Available connectors: ${connectors.join(", ")}`];
  lines.push(`You can send messages and interact with external services via the ${portalName} gateway API.`);
  lines.push(`Use bash with curl to call these endpoints:\n`);

  for (const name of connectors) {
    lines.push(`### ${name}`);
    lines.push(`- **Send message**: \`curl -X POST ${gatewayUrl}/api/connectors/${name}/send -H 'Content-Type: application/json' -d '{"channel":"CHANNEL_ID","text":"message"}'\``);
    lines.push(`- **Send threaded reply**: add \`"thread":"THREAD_TS"\` to the JSON body`);
    lines.push(`- You can proactively send messages without being asked — e.g., to notify about completed tasks, errors, or status updates`);
  }

  lines.push(`\n- **List all connectors**: \`curl ${gatewayUrl}/api/connectors\``);
  lines.push(`- Channel IDs and connector config can be found in \`~/.jinn/config.yaml\``);
  return lines.join("\n");
}

function buildEnvironmentContext(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const lines: string[] = [`## Local environment`];
  let hasContent = false;

  const toolDirs: { dir: string; label: string; description: string }[] = [
    { dir: ".openclaw", label: "OpenClaw", description: "AI agent platform (agents, cron, memory, hooks, credentials)" },
    { dir: ".claude", label: "Claude Code", description: "Claude Code CLI config and projects" },
    { dir: ".codex", label: "Codex", description: "OpenAI Codex CLI config" },
  ];

  for (const tool of toolDirs) {
    const toolPath = path.join(home, tool.dir);
    try {
      const stat = fs.statSync(toolPath);
      if (stat.isDirectory()) {
        const contents = fs.readdirSync(toolPath).filter(f => !f.startsWith("."));
        lines.push(`- **${tool.label}** (\`~/${tool.dir}/\`): ${tool.description}`);
        if (contents.length > 0) {
          lines.push(`  Contents: ${contents.slice(0, 15).join(", ")}${contents.length > 15 ? `, ... (${contents.length} total)` : ""}`);
        }
        hasContent = true;
      }
    } catch {
      // doesn't exist
    }
  }

  // Scan ~/Projects for user's codebases
  const projectsDir = path.join(home, "Projects");
  try {
    const projects = fs.readdirSync(projectsDir).filter(f => {
      try { return fs.statSync(path.join(projectsDir, f)).isDirectory(); } catch { return false; }
    });
    if (projects.length > 0) {
      lines.push(`- **Projects** (\`~/Projects/\`): ${projects.join(", ")}`);
      hasContent = true;
    }
  } catch {
    // no Projects dir
  }

  if (!hasContent) return null;

  lines.push(`\nWhen the user asks about tools or systems on their machine, check these directories first before saying you don't know. Be resourceful — explore the filesystem.`);
  return lines.join("\n");
}

function buildEvolutionContext(portalName: string): string {
  const profilePath = path.join(JINN_HOME, "knowledge", "user-profile.md");
  let profileContent = "";
  try { profileContent = fs.readFileSync(profilePath, "utf-8").trim(); } catch {}

  const isNew = profileContent.length < 50;

  const lines: string[] = [`## Self-evolution`];

  if (isNew) {
    lines.push(`**ONBOARDING MODE**: This is a new or unconfigured ${portalName} installation.`);
    lines.push(`Before answering the user's request, introduce yourself briefly and ask them:`);
    lines.push(`1. What's your name and what do you do? (business, role, projects)`);
    lines.push(`2. What should ${portalName} help you automate? (code reviews, deployments, monitoring, etc.)`);
    lines.push(`3. Communication preferences — emoji style, verbosity (concise vs detailed), language`);
    lines.push(`4. Any active projects ${portalName} should know about?`);
    lines.push(`\nAfter the user responds, write their answers to \`~/.jinn/knowledge/user-profile.md\` and \`~/.jinn/knowledge/preferences.md\`.`);
    lines.push(`Then proceed to help with their original request.`);
  } else {
    lines.push(`You learn and evolve over time. When you discover new information about the user, their projects, or their preferences:`);
    lines.push(`- Update \`~/.jinn/knowledge/user-profile.md\` with business/identity info`);
    lines.push(`- Update \`~/.jinn/knowledge/preferences.md\` with style/communication preferences`);
    lines.push(`- Update \`~/.jinn/knowledge/projects.md\` with project details`);
    lines.push(`- If the user gives you persistent feedback (e.g. "always do X", "never do Y"), update \`~/.jinn/CLAUDE.md\``);
    lines.push(`\nDo this silently — don't announce every file update. Just evolve.`);
  }

  return lines.join("\n");
}

/**
 * Delegation protocol: condensed version focusing on the essential API patterns.
 * Verbose examples and multi-paragraph explanations have been trimmed.
 */
function buildDelegationProtocol(gatewayUrl: string, _portalName: string, config?: JinnConfig): string {
  const defaultEngine = config?.engines.default || "claude";
  const engineConfig = defaultEngine === "codex" ? config?.engines.codex : config?.engines.claude;
  const childOverride = engineConfig?.childEffortOverride;

  const effortOverrideNote = childOverride
    ? `\n> **Note**: \`childEffortOverride\` is set to \`"${childOverride}"\`. All child sessions use this effort level.`
    : "";

  return `## Employee Delegation Protocol

You are the COO. You orchestrate employees by creating **linked child sessions**.

### How delegation works

1. **Detect**: Spot \`@employee-name\` tags or infer the right employee from context.

2. **Check for existing children first**:
\`\`\`bash
curl -s ${gatewayUrl}/api/sessions/<your-session-id>/children
\`\`\`
If a child exists for this employee, reuse it (skip to step 5).

3. **Brief**: Craft clear, targeted instructions — translate user words into actionable briefs.

4. **Spawn**:
\`\`\`bash
curl -s -X POST ${gatewayUrl}/api/sessions \\
  -H 'Content-Type: application/json' \\
  -d '{"prompt": "<brief>", "employee": "<name>", "parentSessionId": "<your-session-id>"}'
\`\`\`

5. **Follow up** (existing child):
\`\`\`bash
curl -s -X POST ${gatewayUrl}/api/sessions/<child-id>/message \\
  -H 'Content-Type: application/json' \\
  -d '{"message": "<follow-up>"}'
\`\`\`

6. **Respond immediately**: Tell the user you've delegated and will follow up when it's done. **Do NOT poll or wait** — end your turn now.

7. **onComplete callback**: When the child session finishes, the gateway automatically sends you a notification message with the result. You will receive this as a new message in your session — no polling needed.

8. **Review**: When the onComplete notification arrives, assess work using oversight levels (TRUST / VERIFY / THOROUGH) based on complexity and risk, then relay the result to the user.

### Key rules
- **NEVER poll or wait for child sessions**. After spawning, reply to the user and end your turn. The gateway's onComplete callback will message you automatically when the child finishes.
- **Always reuse** child sessions — never create duplicates for the same employee.
- **Parallel spawning**: For independent sub-tasks, spawn multiple employees simultaneously.
- **Cross-reference**: Compare results from multiple employees before responding.
- **Effort levels**: Include \`"effortLevel"\` in the API body: \`"low"\` (lookups), \`"medium"\` (routine), \`"high"\` (code/architecture).

### Oversight Levels

| Level | When | You do |
|-------|------|--------|
| **TRUST** | Simple lookups, status checks | Skim, relay directly |
| **VERIFY** | Code changes, routine work | Read fully, spot-check key files |
| **THOROUGH** | Architecture, breaking changes, security | Full review, multi-turn follow-up, verify changes |

### Manager Delegation

When a department has 3+ employees, promote a senior to **manager**. Managers handle their own delegation; you review their summaries, not individual work.

### Your session ID

Your current session ID is in the "Current session" section above. Use it as \`parentSessionId\`.${effortOverrideNote}`;
}

function buildServicesContext(employee: Employee, gatewayUrl: string): string | null {
  try {
    const { departments, services } = scanOrgFull();
    if (services.size === 0) return null;

    const lines: string[] = ["## Available cross-department services"];
    lines.push("Other departments provide the following services. To request one, ask your manager or use the cross-request API:");
    lines.push(`\`POST ${gatewayUrl}/api/org/cross-request\` with \`{"fromEmployee": "${employee.name}", "service": "<name>", "prompt": "<what you need>"}\``);
    lines.push("");

    for (const [svcName, deptPath] of services) {
      // Skip services from own department
      if (deptPath === employee.orgPath) continue;
      const dept = departments.get(deptPath);
      lines.push(`- **${svcName}** — provided by ${dept?.displayName || deptPath} (manager: ${dept?.manager || "none"})`);
    }

    // If no external services, skip
    if (lines.length <= 4) return null;

    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildApiReference(gatewayUrl: string, portalName: string): string {
  return `## ${portalName} Gateway API (${gatewayUrl})

You can call these endpoints with curl to inspect and manage the gateway:

| Endpoint | Method | Description |
|----------|--------|-------------|
| \`/api/status\` | GET | Gateway status, uptime, engine info |
| \`/api/sessions\` | GET | List all sessions |
| \`/api/sessions/:id\` | GET | Session detail (includes messages) |
| \`/api/sessions\` | POST | Create new session (\`{prompt, engine?, employee?, parentSessionId?}\`) |
| \`/api/sessions/:id/message\` | POST | Send follow-up message to existing session (\`{message}\`) |
| \`/api/sessions/:id/children\` | GET | List child sessions of a parent |
| \`/api/cron\` | GET | List cron jobs |
| \`/api/cron/:id\` | PUT | Update cron job (toggle enabled, etc.) |
| \`/api/cron/:id/runs\` | GET | Cron run history |
| \`/api/org\` | GET | Organization structure |
| \`/api/org/employees/:name\` | GET | Employee details |
| \`/api/org/services\` | GET | List cross-department services |
| \`/api/org/cross-request\` | POST | Create cross-service request (\`{fromEmployee, service, prompt}\`) |
| \`/api/skills\` | GET | List skills |
| \`/api/skills/:name\` | GET | Skill content |
| \`/api/config\` | GET | Current config |
| \`/api/config\` | PUT | Update config |
| \`/api/connectors\` | GET | List connectors |
| \`/api/connectors/:name/send\` | POST | Send message via connector |
| \`/api/logs\` | GET | Recent log lines |`;
}

/**
 * Progressive trimming by tier: OPTIONAL sections are replaced with summaries first,
 * then STANDARD, then (as a last resort) ESSENTIAL sections.
 */
function trimContext(sections: Section[], maxChars: number): string {
  let parts = sections.map(s => s.content);
  let result = parts.join("\n\n");
  if (result.length <= maxChars) return result;

  // Trim OPTIONAL sections first, then STANDARD
  for (const tier of [Tier.OPTIONAL, Tier.STANDARD]) {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (result.length <= maxChars) break;
      if (sections[i].tier === tier && sections[i].summary) {
        parts[i] = sections[i].summary;
        result = parts.join("\n\n");
      }
    }
  }

  return result;
}

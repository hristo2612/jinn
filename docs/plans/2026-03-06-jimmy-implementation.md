# Jimmy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Jimmy — a lightweight AI gateway daemon that orchestrates Claude Code CLI and Codex SDK as an autonomous, self-organizing AI workforce.

**Architecture:** Monorepo with two packages (`@jimmy-ai/cli` core + `@jimmy-ai/web` dashboard). Single Node.js process gateway that spawns engine child processes, routes messages from connectors, runs cron jobs, and serves a static Next.js web UI. All state lives in `~/.jimmy/` as YAML, JSON, and SQLite files.

**Tech Stack:** Node.js, TypeScript, pnpm, Turborepo, better-sqlite3, node-cron, @slack/bolt, @openai/codex-sdk, commander, chokidar, ws, Next.js 15, Tailwind CSS

**Design Doc:** `docs/plans/2026-03-06-jimmy-design.md`

---

## Phase 1: Monorepo Scaffold + Shared Types

Get the project structure buildable and testable with zero functionality.

### Task 1.1: Initialize monorepo root

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `.gitignore`
- Create: `.npmrc`
- Create: `tsconfig.base.json`
- Create: `LICENSE`

**Step 1: Create root package.json**

```json
{
  "name": "jimmy",
  "private": true,
  "packageManager": "pnpm@10.6.4",
  "scripts": {
    "build": "turbo build",
    "dev": "turbo dev",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "clean": "turbo clean"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.8.0"
  }
}
```

**Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

**Step 3: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "lint": {},
    "clean": {
      "cache": false
    }
  }
}
```

**Step 4: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist"
  }
}
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
.next/
.turbo/
*.tsbuildinfo
.env
.env.local
```

**Step 6: Create LICENSE (MIT)**

**Step 7: Create .npmrc**

```
auto-install-peers=true
```

**Step 8: Install dependencies and verify**

Run: `pnpm install`
Expected: lockfile created, no errors

**Step 9: Commit**

```bash
git add -A
git commit -m "chore: initialize monorepo with pnpm + turborepo"
```

---

### Task 1.2: Create @jimmy-ai/cli package scaffold

**Files:**
- Create: `packages/jimmy/package.json`
- Create: `packages/jimmy/tsconfig.json`
- Create: `packages/jimmy/bin/jimmy.ts`
- Create: `packages/jimmy/src/shared/types.ts`
- Create: `packages/jimmy/src/shared/paths.ts`
- Create: `packages/jimmy/src/shared/config.ts`
- Create: `packages/jimmy/src/shared/logger.ts`

**Step 1: Create package.json**

```json
{
  "name": "@jimmy-ai/cli",
  "version": "0.1.0",
  "description": "Lightweight AI gateway daemon orchestrating Claude Code and Codex",
  "license": "MIT",
  "bin": {
    "jimmy": "./dist/bin/jimmy.js"
  },
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "files": [
    "dist/",
    "template/"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@slack/bolt": "^4.3.0",
    "@openai/codex-sdk": "^1.0.0",
    "better-sqlite3": "^11.8.0",
    "chokidar": "^4.0.0",
    "commander": "^13.1.0",
    "js-yaml": "^4.1.0",
    "node-cron": "^3.0.0",
    "uuid": "^11.1.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/js-yaml": "^4.0.0",
    "@types/node": "^22.0.0",
    "@types/node-cron": "^3.0.0",
    "@types/uuid": "^10.0.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.8.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["bin/**/*.ts", "src/**/*.ts"]
}
```

**Step 3: Create shared types (`src/shared/types.ts`)**

Define all core interfaces: `Engine`, `EngineResult`, `EngineRunOpts`, `Connector`, `IncomingMessage`, `Attachment`, `Target`, `Session`, `CronJob`, `CronDelivery`, `Employee`, `Department`, `JimmyConfig`.

See design doc sections 3-7 for exact shapes. Use the interfaces defined in the design for Engine, EngineResult, Connector, IncomingMessage, Attachment, Target. Add:

```typescript
export interface JimmyConfig {
  gateway: { port: number; host: string };
  engines: {
    default: "claude" | "codex";
    claude: { bin: string; model: string; effortLevel?: string };
    codex: { bin: string; model: string };
  };
  connectors: Record<string, any>;
  logging: { file: boolean; stdout: boolean; level: string };
}

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  employee: string | null;
  model: string | null;
  status: "idle" | "running" | "error";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine?: string;
  model?: string;
  employee?: string;
  prompt: string;
  delivery?: CronDelivery;
}

export interface CronDelivery {
  connector: string;
  channel: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
}
```

**Step 4: Create paths utility (`src/shared/paths.ts`)**

```typescript
import path from "node:path";
import os from "node:os";

export const JIMMY_HOME = path.join(os.homedir(), ".jimmy");
export const CONFIG_PATH = path.join(JIMMY_HOME, "config.yaml");
export const SESSIONS_DB = path.join(JIMMY_HOME, "sessions", "registry.db");
export const CRON_JOBS = path.join(JIMMY_HOME, "cron", "jobs.json");
export const CRON_RUNS = path.join(JIMMY_HOME, "cron", "runs");
export const ORG_DIR = path.join(JIMMY_HOME, "org");
export const SKILLS_DIR = path.join(JIMMY_HOME, "skills");
export const DOCS_DIR = path.join(JIMMY_HOME, "docs");
export const LOGS_DIR = path.join(JIMMY_HOME, "logs");
export const TMP_DIR = path.join(JIMMY_HOME, "tmp");
export const PID_FILE = path.join(JIMMY_HOME, "gateway.pid");
export const TEMPLATE_DIR = path.join(__dirname, "..", "..", "template");
```

**Step 5: Create config loader (`src/shared/config.ts`)**

Reads and parses `~/.jimmy/config.yaml` using js-yaml. Returns typed `JimmyConfig`. Throws helpful error if file doesn't exist (suggests running `jimmy setup`).

**Step 6: Create logger (`src/shared/logger.ts`)**

Simple logger that writes to both `~/.jimmy/logs/gateway.log` (append) and stdout. Supports levels: debug, info, warn, error. Timestamps each line. Respects config `logging.level` and `logging.stdout` settings.

**Step 7: Create CLI entry point (`bin/jimmy.ts`)**

```typescript
#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();
program
  .name("jimmy")
  .description("Lightweight AI gateway daemon")
  .version("0.1.0");

program.command("setup").description("Initialize Jimmy and install dependencies").action(() => {
  console.log("TODO: setup");
});

program.command("start").description("Start the gateway daemon").option("--daemon", "Run in background").action(() => {
  console.log("TODO: start");
});

program.command("stop").description("Stop the gateway daemon").action(() => {
  console.log("TODO: stop");
});

program.command("status").description("Show gateway status").action(() => {
  console.log("TODO: status");
});

program.parse();
```

**Step 8: Build and verify**

Run: `cd packages/jimmy && pnpm build`
Expected: compiles to `dist/` without errors

Run: `node dist/bin/jimmy.js --help`
Expected: shows help text with setup/start/stop/status commands

**Step 9: Commit**

```bash
git add -A
git commit -m "feat: scaffold @jimmy-ai/cli package with shared types"
```

---

## Phase 2: Session Registry + Engine Abstraction

Build the core: SQLite session registry and both engine wrappers.

### Task 2.1: Session registry (SQLite)

**Files:**
- Create: `packages/jimmy/src/sessions/registry.ts`

**Step 1: Write registry module**

Implements:
- `initDb()` — creates SQLite database at `~/.jimmy/sessions/registry.db`, runs CREATE TABLE IF NOT EXISTS
- `createSession(opts)` — inserts new session, returns Session
- `getSession(id)` — get by Jimmy session ID
- `getSessionBySourceRef(sourceRef)` — look up by source_ref (for routing)
- `updateSession(id, updates)` — update fields (engine_session_id, status, last_activity, last_error)
- `listSessions(filter?)` — list all, optionally filter by status/source/engine
- `deleteSession(id)` — for /new command (soft: just removes from registry)

Uses `better-sqlite3` (synchronous API, simple).

**Step 2: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add SQLite session registry"
```

---

### Task 2.2: Engine types and Claude engine

**Files:**
- Create: `packages/jimmy/src/engines/types.ts` (extract from shared/types.ts if needed)
- Create: `packages/jimmy/src/engines/claude.ts`

**Step 1: Write Claude engine**

Implements the `Engine` interface. Core logic:

```typescript
import { spawn } from "node:child_process";

export class ClaudeEngine implements Engine {
  name = "claude" as const;

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const args = ["-p", "--output-format", "json", "--verbose",
      "--permission-mode", "bypassPermissions"];

    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

    // Append attachment paths to prompt
    let prompt = opts.prompt;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
    }
    args.push(prompt);

    return new Promise((resolve, reject) => {
      const proc = spawn(opts.bin || "claude", args, {
        cwd: opts.cwd,
        env: { ...process.env, CLAUDECODE: undefined },
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout);
            resolve({
              sessionId: result.session_id,
              result: result.result,
              cost: result.total_cost_usd,
              durationMs: result.duration_ms,
              numTurns: result.num_turns,
            });
          } catch (e) {
            reject(new Error(`Failed to parse Claude output: ${e}`));
          }
        } else {
          resolve({
            sessionId: opts.resumeSessionId || "",
            result: "",
            error: `Claude exited with code ${code}: ${stderr.slice(0, 500)}`,
          });
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      });
    });
  }
}
```

**Step 2: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Claude Code engine wrapper"
```

---

### Task 2.3: Codex engine

**Files:**
- Create: `packages/jimmy/src/engines/codex.ts`

**Step 1: Write Codex engine**

Implements the `Engine` interface using `@openai/codex-sdk`:

```typescript
import { Codex } from "@openai/codex-sdk";

export class CodexEngine implements Engine {
  name = "codex" as const;
  private codex: Codex;

  constructor() {
    this.codex = new Codex();
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    try {
      const thread = opts.resumeSessionId
        ? this.codex.resumeThread(opts.resumeSessionId)
        : this.codex.startThread({ workingDirectory: opts.cwd });

      let prompt = opts.prompt;
      if (opts.systemPrompt) {
        prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
      }
      if (opts.attachments?.length) {
        prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
      }

      const result = await thread.run(prompt);

      return {
        sessionId: thread.id,
        result: result.finalResponse || "",
      };
    } catch (err: any) {
      return {
        sessionId: opts.resumeSessionId || "",
        result: "",
        error: `Codex error: ${err.message}`,
      };
    }
  }
}
```

Note: The exact Codex SDK API may differ slightly — adapt to actual SDK types at implementation time. The key contract is the `Engine` interface.

**Step 2: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Codex SDK engine wrapper"
```

---

### Task 2.4: Session manager

**Files:**
- Create: `packages/jimmy/src/sessions/manager.ts`
- Create: `packages/jimmy/src/sessions/context.ts`
- Create: `packages/jimmy/src/sessions/queue.ts`

**Step 1: Write context builder (`context.ts`)**

Builds the `--append-system-prompt` string for each session:

```typescript
export function buildContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
}): string {
  let ctx = `You are Jimmy, a personal AI assistant.\n`;
  ctx += `Session source: ${opts.source}, channel: ${opts.channel}`;
  if (opts.thread) ctx += `, thread: ${opts.thread}`;
  ctx += `\nUser: ${opts.user}\n`;

  if (opts.employee) {
    ctx = opts.employee.persona + `\n\nSession source: ${opts.source}, channel: ${opts.channel}\nUser: ${opts.user}\n`;
  }

  return ctx;
}
```

**Step 2: Write lane queue (`queue.ts`)**

Simple per-session queue. Each session key maps to a promise chain. New messages chain onto the previous one, ensuring serial execution per session.

```typescript
export class SessionQueue {
  private queues = new Map<string, Promise<void>>();

  async enqueue(sessionKey: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const next = prev.then(fn, fn); // run even if previous errored
    this.queues.set(sessionKey, next);
    return next;
  }
}
```

**Step 3: Write session manager (`manager.ts`)**

Orchestrates everything:
- `route(msg: IncomingMessage)` — determines source_ref, looks up/creates session, enqueues engine run
- `runSession(session, prompt, attachments, employee?)` — picks engine, builds context, spawns, handles result
- `handleCommand(msg, connector)` — handles /new, /status
- `resetSession(sourceRef)` — for /new command

Depends on: registry, engines, context builder, queue.

**Step 4: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add session manager with context builder and lane queue"
```

---

## Phase 3: Gateway Daemon + CLI

Wire everything into a running process.

### Task 3.1: Gateway server

**Files:**
- Create: `packages/jimmy/src/gateway/server.ts`
- Create: `packages/jimmy/src/gateway/api.ts`
- Create: `packages/jimmy/src/gateway/watcher.ts`
- Create: `packages/jimmy/src/gateway/lifecycle.ts`

**Step 1: Write HTTP + WebSocket server (`server.ts`)**

Uses Node.js `http.createServer` + `ws` WebSocket server on same port:
- Static file serving for web UI (from bundled `dist/web/` or dev path)
- `/api/*` routes handled by api.ts
- `/ws` upgrades to WebSocket
- Starts connector system, cron scheduler, file watcher
- Exposes `emit(event, payload)` to broadcast to all connected WebSocket clients

**Step 2: Write REST API (`api.ts`)**

Implements all endpoints from design doc section 10. Simple request handler function that parses URL, method, body and routes to the right handler. Returns JSON responses. Endpoints:
- `GET /api/status` — gateway uptime, engine availability, session counts
- `GET /api/sessions` — list from registry
- `GET /api/sessions/:id` — single session detail
- `POST /api/sessions` — create session from web UI (accepts `{ prompt, engine?, employee? }`)
- `POST /api/sessions/:id/message` — send follow-up
- `GET /api/cron` — read jobs.json
- `GET /api/cron/:id/runs` — read from runs/*.jsonl
- `PUT /api/cron/:id` — update job in jobs.json
- `GET /api/org` — scan org directory, return tree
- `GET /api/org/employees/:name` — read employee YAML
- `GET /api/org/departments/:name/board` — read board.json
- `GET /api/skills` — list skill directories
- `GET /api/skills/:name` — read SKILL.md content
- `GET /api/config` — read config.yaml
- `PUT /api/config` — write config.yaml
- `GET /api/logs` — tail last N lines of gateway.log

**Step 3: Write file watcher (`watcher.ts`)**

Uses chokidar to watch:
- `config.yaml` — on change, reload config, emit `config:reloaded`
- `cron/jobs.json` — on change, reload cron scheduler, emit `cron:reloaded`
- `org/` — on change, rebuild employee registry, emit `org:changed`

Debounce all watchers (500ms) to avoid rapid-fire reloads.

**Step 4: Write lifecycle manager (`lifecycle.ts`)**

Handles:
- `startForeground()` — start server, register SIGINT/SIGTERM handlers for graceful shutdown
- `startDaemon()` — fork child process, write PID to `~/.jimmy/gateway.pid`, parent exits
- `stop()` — read PID file, send SIGTERM, remove PID file
- `getStatus()` — check if PID file exists and process is alive
- Graceful shutdown: stop connectors, stop cron, close HTTP server, close DB

**Step 5: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add gateway server with API, file watcher, and lifecycle management"
```

---

### Task 3.2: Wire CLI commands

**Files:**
- Modify: `packages/jimmy/bin/jimmy.ts`
- Create: `packages/jimmy/src/cli/setup.ts`
- Create: `packages/jimmy/src/cli/start.ts`
- Create: `packages/jimmy/src/cli/stop.ts`
- Create: `packages/jimmy/src/cli/status.ts`

**Step 1: Write setup command (`cli/setup.ts`)**

1. Check Node.js version (>= 22)
2. Check for `claude` binary — if missing, prompt to install via `npm install -g @anthropic-ai/claude-code`
3. Check for `codex` binary — if missing, prompt to install via `npm install -g @openai/codex`
4. Check auth: run `claude --version` and `codex --version` to verify
5. Create `~/.jimmy/` directory structure by copying from `template/`
6. Initialize empty SQLite database with schema
7. Create empty `cron/jobs.json` with `[]`
8. Install LaunchAgent plist to `~/Library/LaunchAgents/com.jimmy-ai.gateway.plist`
9. Print summary

**Step 2: Write start command (`cli/start.ts`)**

Check if `~/.jimmy/` exists (suggest `jimmy setup` if not). If `--daemon` flag, call `lifecycle.startDaemon()`. Otherwise call `lifecycle.startForeground()`.

**Step 3: Write stop command (`cli/stop.ts`)**

Call `lifecycle.stop()`. Print confirmation or "not running".

**Step 4: Write status command (`cli/status.ts`)**

Call `lifecycle.getStatus()`. Print running/stopped, PID, uptime, port. If running, also call `/api/status` via HTTP to get live stats.

**Step 5: Wire into bin/jimmy.ts**

Replace TODO placeholders with actual imports and calls.

**Step 6: Build and test end-to-end**

Run: `pnpm build && node dist/bin/jimmy.js setup`
Expected: creates `~/.jimmy/` directory with all template files

Run: `node dist/bin/jimmy.js start`
Expected: gateway starts on port 7777, logs to stdout

Run (in another terminal): `curl http://localhost:7777/api/status`
Expected: JSON response with gateway status

Run: `node dist/bin/jimmy.js status`
Expected: shows "running" with PID and port

Ctrl+C the gateway.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire CLI commands (setup, start, stop, status)"
```

---

## Phase 4: Template Files (CLAUDE.md, AGENTS.md, Skills, Docs)

Create the brain — the files that make engines understand Jimmy.

### Task 4.1: Write CLAUDE.md and AGENTS.md

**Files:**
- Create: `packages/jimmy/template/CLAUDE.md`
- Create: `packages/jimmy/template/AGENTS.md`

**Step 1: Write CLAUDE.md**

This is the most important file in the project. It tells every Claude Code session who they are and how Jimmy works. Contents:

- Identity: "You are Jimmy, a personal AI assistant and COO of an AI organization"
- The `~/.jimmy/` folder structure and what each part does
- How to use skills (read SKILL.md from `~/.jimmy/skills/`)
- How the org system works (employees, departments, ranks, boards, personas)
- How to create/manage cron jobs (edit `cron/jobs.json`, gateway auto-reloads)
- How to self-modify (edit config, org files, create skills — gateway watches and reacts)
- Reference to `docs/` for deeper understanding
- List of pre-packaged skills
- Conventions: where to put knowledge, how to name files, YAML for personas, JSON for boards/cron

**Step 2: Write AGENTS.md**

Same content adapted for Codex. Codex reads AGENTS.md the way Claude reads CLAUDE.md. The instructions should be engine-agnostic in content but formatted for each engine's conventions.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add CLAUDE.md and AGENTS.md template files"
```

---

### Task 4.2: Write pre-packaged skills

**Files:**
- Create: `packages/jimmy/template/skills/management/SKILL.md`
- Create: `packages/jimmy/template/skills/cron-manager/SKILL.md`
- Create: `packages/jimmy/template/skills/skill-creator/SKILL.md`
- Create: `packages/jimmy/template/skills/self-heal/SKILL.md`
- Create: `packages/jimmy/template/skills/onboarding/SKILL.md`

**Step 1: Write management skill**

Instructions for: hiring employees (create persona YAML), firing (delete), creating departments (create dir + department.yaml + board.json), promoting ranks, delegating tasks (write to board.json), restructuring org. Include all YAML/JSON schemas. Include rank definitions and communication rules.

**Step 2: Write cron-manager skill**

Instructions for: creating cron jobs (append to jobs.json), editing (modify in place), deleting (remove from array), enabling/disabling. Include the CronJob JSON schema. Rule: always ask user about delivery channel if not specified.

**Step 3: Write skill-creator skill**

Thin wrapper: defer to Claude Code's native `/skill` command or Codex native capabilities. Ensure output lands in `~/.jimmy/skills/<name>/SKILL.md`. Include conventions for writing good SKILL.md files.

**Step 4: Write self-heal skill**

Instructions for: reading `logs/gateway.log` to diagnose issues, checking config.yaml for problems, verifying engine availability (run `claude --version` / `codex --version`), common fixes (restart gateway, clear tmp/, fix malformed JSON/YAML). Reference docs/ for architecture understanding.

**Step 5: Write onboarding skill**

Instructions for first-run flow: greet user, ask about projects, ask about tools/engines, detect `~/.openclaw/`, analyze OpenClaw data (skills, cron, knowledge, memory, config — full D analysis), present migration proposal with recommendations, let user pick what to migrate, scaffold org structure. Include predefined option lists for common use cases.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add pre-packaged skills (management, cron-manager, skill-creator, self-heal, onboarding)"
```

---

### Task 4.3: Write docs

**Files:**
- Create: `packages/jimmy/template/docs/overview.md`
- Create: `packages/jimmy/template/docs/architecture.md`
- Create: `packages/jimmy/template/docs/skills.md`
- Create: `packages/jimmy/template/docs/cron.md`
- Create: `packages/jimmy/template/docs/connectors.md`
- Create: `packages/jimmy/template/docs/org.md`
- Create: `packages/jimmy/template/docs/self-modification.md`

**Step 1: Write each doc**

These are for Jimmy's self-awareness. Each doc should be concise and technical:
- `overview.md` — what Jimmy is, core principles, how it differs from OpenClaw
- `architecture.md` — gateway, sessions, engines, connectors, cron, file watchers
- `skills.md` — how skills work, conventions, how to create them
- `cron.md` — job schema, scheduling, delivery, hot-reload
- `connectors.md` — connector interface, Slack specifics, future platforms
- `org.md` — employee personas, departments, ranks, boards, communication rules
- `self-modification.md` — what Jimmy can edit, how file watchers react, safety considerations

**Step 2: Write default config.yaml template**

Create: `packages/jimmy/template/config.default.yaml` with the config from the design doc.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add docs and default config template"
```

---

## Phase 5: Slack Connector

### Task 5.1: Implement Slack connector

**Files:**
- Create: `packages/jimmy/src/connectors/slack/index.ts`
- Create: `packages/jimmy/src/connectors/slack/threads.ts`
- Create: `packages/jimmy/src/connectors/slack/format.ts`

**Step 1: Write thread mapper (`threads.ts`)**

Function `deriveSourceRef(event)` that returns:
- DM: `"slack:dm:<userId>"`
- Channel root: `"slack:<channelId>"`
- Thread: `"slack:<channelId>:<threadTs>"`

Logic: if `event.channel_type === "im"` -> DM. Else if `event.thread_ts && event.thread_ts !== event.ts` -> thread. Else -> channel root.

**Step 2: Write message formatter (`format.ts`)**

Functions:
- `formatResponse(text)` — truncate if > 3000 chars (Slack limit), split into multiple messages if needed
- `downloadAttachment(url, token, destDir)` — download Slack file to `~/.jimmy/tmp/`, return local path

**Step 3: Write Slack connector (`index.ts`)**

Implements `Connector` interface using `@slack/bolt`:

```typescript
import { App } from "@slack/bolt";

export class SlackConnector implements Connector {
  name = "slack";
  private app: App;
  private handler: ((msg: IncomingMessage) => void) | null = null;

  constructor(config: { appToken: string; botToken: string }) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
  }

  async start() {
    this.app.message(async ({ event, client }) => {
      // Skip bot's own messages
      if (event.bot_id) return;

      // Check for Jimmy commands
      // Build IncomingMessage from event
      // Download attachments if present
      // Call handler
    });
    await this.app.start();
  }

  async stop() { await this.app.stop(); }

  async sendMessage(target, text) { /* client.chat.postMessage */ }
  async addReaction(target, emoji) { /* client.reactions.add */ }
  async removeReaction(target, emoji) { /* client.reactions.remove */ }
  async editMessage(target, text) { /* client.chat.update */ }

  onMessage(handler) { this.handler = handler; }
}
```

**Step 4: Wire connector into gateway**

In `server.ts`, read connector config from `config.yaml`. If `connectors.slack` is configured and enabled, instantiate and start `SlackConnector`. Register its `onMessage` handler to call `sessionManager.route()`.

**Step 5: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 6: Manual test with Slack**

Configure Slack tokens in `~/.jimmy/config.yaml`. Start gateway. Send a DM to the bot. Verify: eyes reaction appears, Claude Code runs, result posted, checkmark reaction added.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Slack connector with thread mapping and reactions"
```

---

## Phase 6: Cron System

### Task 6.1: Implement cron scheduler

**Files:**
- Create: `packages/jimmy/src/cron/jobs.ts`
- Create: `packages/jimmy/src/cron/scheduler.ts`
- Create: `packages/jimmy/src/cron/runner.ts`

**Step 1: Write job loader (`jobs.ts`)**

Reads and writes `~/.jimmy/cron/jobs.json`. Functions:
- `loadJobs()` — parse JSON, return typed CronJob array
- `saveJobs(jobs)` — write back to file
- `appendRunLog(jobId, entry)` — append JSONL to `runs/<jobId>.jsonl`

**Step 2: Write cron runner (`runner.ts`)**

Executes a single cron job:
1. Determine engine + model (job override -> employee override -> global default)
2. Build context with employee persona if set
3. Spawn engine session (fresh, no resume)
4. Capture result
5. If delivery configured, send to connector
6. Log run to JSONL

**Step 3: Write scheduler (`scheduler.ts`)**

Uses `node-cron`:
- `start(jobs, runner)` — schedule all enabled jobs
- `reload(jobs)` — stop all, reschedule with new jobs
- `stopAll()` — stop all scheduled tasks

**Step 4: Wire into gateway**

On gateway start, load jobs and start scheduler. File watcher on `jobs.json` calls `scheduler.reload()`.

**Step 5: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 6: Manual test**

Add a test job to `jobs.json` with `schedule: "* * * * *"` (every minute). Start gateway. Verify job fires, engine runs, result appears in run log.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add cron scheduler with job loader and runner"
```

---

## Phase 7: Org System (Gateway Awareness)

### Task 7.1: Employee registry in gateway

**Files:**
- Create: `packages/jimmy/src/gateway/org.ts`

**Step 1: Write org scanner**

Functions:
- `scanOrg()` — recursively scan `~/.jimmy/org/`, parse all `.yaml` files, return `Map<string, Employee>`
- `findEmployee(name, registry)` — look up by name (exact match)
- `extractMention(text, registry)` — scan message text for `@employee-name` patterns, return first match

Uses `js-yaml` to parse persona files. Gracefully handles malformed/missing files.

**Step 2: Wire into gateway**

On startup, call `scanOrg()` to build in-memory registry. File watcher on `org/` calls `scanOrg()` to rebuild. Session manager uses `extractMention()` to route messages.

**Step 3: Build and verify**

Run: `pnpm build`
Expected: compiles without errors

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add org scanner for employee mention routing"
```

---

## Phase 8: Web UI

### Task 8.1: Scaffold Next.js app

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/next.config.ts`
- Create: `packages/web/tailwind.config.ts`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/postcss.config.js`
- Create: `packages/web/src/app/layout.tsx`
- Create: `packages/web/src/app/page.tsx`
- Create: `packages/web/src/lib/api.ts`
- Create: `packages/web/src/lib/ws.ts`
- Create: `packages/web/src/hooks/use-gateway.ts`

**Step 1: Initialize Next.js with static export**

`next.config.ts`:
```typescript
import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  distDir: "out",
};
export default config;
```

**Step 2: Create API client (`lib/api.ts`)**

Typed fetch wrapper for all `/api/*` endpoints. Reads gateway URL from environment or defaults to `window.location.origin`.

**Step 3: Create WebSocket client (`lib/ws.ts`)**

Auto-reconnecting WebSocket connection to `/ws`. Emits typed events. React-friendly via `use-gateway.ts` hook.

**Step 4: Create layout with navigation**

Apple-inspired sidebar nav: Dashboard, Chat, Sessions, Organization, Cron, Skills, Logs, Settings. Clean typography, system font stack, Tailwind.

**Step 5: Create dashboard page**

Gateway status card, active sessions count, next cron fire, recent activity feed. All data from `/api/status` + WebSocket events.

**Step 6: Build and verify**

Run: `cd packages/web && pnpm build`
Expected: static export in `out/` directory

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold web UI with Next.js, dashboard page"
```

---

### Task 8.2: Chat page

**Files:**
- Create: `packages/web/src/app/chat/page.tsx`
- Create: `packages/web/src/components/chat/chat-sidebar.tsx`
- Create: `packages/web/src/components/chat/chat-messages.tsx`
- Create: `packages/web/src/components/chat/chat-input.tsx`

**Step 1: Build chat sidebar**

List of conversations. "New Chat" button. Jimmy always at top. Conversations from `/api/sessions?source=web`.

**Step 2: Build chat messages area**

Renders message history for selected session. Markdown rendering. Shows engine/model indicator.

**Step 3: Build chat input**

Text input with send button. Supports `/new` and `/status` commands. `@employee` mention autocomplete from `/api/org`. Shows processing spinner when session is running (via WebSocket events).

**Step 4: Wire together**

Chat page composes sidebar + messages + input. POST to `/api/sessions/:id/message` on send. Listen for `session:completed` WebSocket events to update messages.

**Step 5: Build and verify**

Run: `pnpm build`
Expected: chat page renders, can send messages via API

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add chat page with sidebar, messages, and input"
```

---

### Task 8.3: Sessions page

**Files:**
- Create: `packages/web/src/app/sessions/page.tsx`
- Create: `packages/web/src/components/sessions/session-list.tsx`
- Create: `packages/web/src/components/sessions/session-detail.tsx`

**Step 1: Build session list**

Table/list from `/api/sessions`. Columns: engine icon, source, employee, status badge, last activity. Click to select.

**Step 2: Build session detail panel**

Shows: metadata, chat history (via engine session), follow-up input box.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add sessions page"
```

---

### Task 8.4: Organization page

**Files:**
- Create: `packages/web/src/app/org/page.tsx`
- Create: `packages/web/src/components/org/org-tree.tsx`
- Create: `packages/web/src/components/org/employee-detail.tsx`
- Create: `packages/web/src/components/org/board-view.tsx`

**Step 1: Build org tree**

Interactive collapsible tree from `/api/org`. Jimmy at top, departments as nodes, employees as leaves with rank badges.

**Step 2: Build employee detail panel**

Persona summary, rank, engine/model, tasks from department board, recent sessions.

**Step 3: Build board view**

Kanban or list view of tasks from `/api/org/departments/:name/board`. Status columns: todo, in_progress, done.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add organization page with tree, employee detail, and board view"
```

---

### Task 8.5: Cron, Skills, Logs, Settings pages

**Files:**
- Create: `packages/web/src/app/cron/page.tsx`
- Create: `packages/web/src/app/skills/page.tsx`
- Create: `packages/web/src/app/logs/page.tsx`
- Create: `packages/web/src/app/settings/page.tsx`

**Step 1: Cron page**

Job list with toggle switches, schedule display, last run status. Click for run history table and job config editor.

**Step 2: Skills page**

Grid of skill cards from `/api/skills`. Click to view SKILL.md content (rendered markdown). "Create Skill" button opens chat with Jimmy.

**Step 3: Logs page**

Live log tail from `/api/logs` + WebSocket. Filter dropdowns for level and subsystem. Auto-scroll.

**Step 4: Settings page**

Form-based config editor. Reads `/api/config`, renders form fields for each section (gateway, engines, connectors, logging). Save button PUTs to `/api/config`.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add cron, skills, logs, and settings pages"
```

---

### Task 8.6: Bundle web UI into CLI package

**Files:**
- Modify: `packages/jimmy/package.json` (add build script that copies web output)
- Modify: `packages/jimmy/src/gateway/server.ts` (serve static files from bundled web)
- Modify: `turbo.json` (ensure web builds before jimmy)

**Step 1: Add build pipeline**

In turbo.json, ensure `@jimmy-ai/web` builds first (static export), then `@jimmy-ai/cli` copies the `out/` directory into its own dist.

**Step 2: Serve static files in gateway**

In `server.ts`, if request doesn't match `/api/*` or `/ws`, serve from the bundled static directory. Handle SPA routing (return `index.html` for non-file paths).

**Step 3: End-to-end test**

Run: `pnpm build` (builds both packages)
Run: `node dist/bin/jimmy.js start`
Open: `http://localhost:7777`
Expected: web UI loads, dashboard shows gateway status

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: bundle web UI into CLI package and serve from gateway"
```

---

## Phase 9: Integration Testing + Polish

### Task 9.1: End-to-end smoke test

**Step 1: Full setup flow**

Run: `jimmy setup` (fresh `~/.jimmy/`)
Run: `jimmy start`
Open: `http://localhost:7777`
Verify: dashboard loads, shows connected status

**Step 2: Chat via web UI**

Open `/chat`. Send "Hello, who are you?" Verify: eyes indicator shows, Claude Code runs, response appears.

**Step 3: Slack integration**

Configure Slack tokens. Restart gateway. DM the bot. Verify: eyes reaction, response in thread, checkmark.

**Step 4: Cron**

Add a test cron job via the web UI settings or by editing `jobs.json`. Wait for it to fire. Verify: run logged, delivery posted.

**Step 5: Org**

Via chat, tell Jimmy "Hire an SEO specialist for marketing." Verify: org files created, employee appears in web UI org page.

**Step 6: Fix any issues found**

**Step 7: Commit**

```bash
git add -A
git commit -m "fix: polish from end-to-end smoke testing"
```

---

### Task 9.2: README and publishing prep

**Files:**
- Create: `README.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/CONTRIBUTING.md`

**Step 1: Write README**

Project overview, installation instructions, quick start, architecture diagram, feature list, comparison to OpenClaw, contributing guide link.

**Step 2: Write CI workflow**

GitHub Actions: install pnpm, install deps, typecheck, build. Run on push and PR.

**Step 3: Commit**

```bash
git add -A
git commit -m "docs: add README, CI workflow, and contributing guide"
```

---

## Summary

| Phase | Tasks | What it delivers |
|-------|-------|-----------------|
| 1 | 1.1-1.2 | Buildable monorepo with shared types |
| 2 | 2.1-2.4 | Session registry + both engines + session manager |
| 3 | 3.1-3.2 | Running gateway daemon + CLI commands |
| 4 | 4.1-4.3 | CLAUDE.md, AGENTS.md, skills, docs (the brain) |
| 5 | 5.1 | Slack connector with thread mapping |
| 6 | 6.1 | Cron scheduler |
| 7 | 7.1 | Org system (employee routing) |
| 8 | 8.1-8.6 | Full web UI (dashboard, chat, sessions, org, cron, skills, logs, settings) |
| 9 | 9.1-9.2 | Integration testing + README + CI |

**After Phase 3** you have a working gateway you can talk to via the API.
**After Phase 5** you can talk to Jimmy on Slack.
**After Phase 8** you have the full product.

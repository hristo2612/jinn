# Changelog

## [0.1.1] - 2026-03-09

### 🐛 Bug Fixes
- Remove `@jinn/web` workspace dependency from published package — was causing `unsupported URL type "workspace:"` error on `npm i -g jinn-cli` (web UI is embedded as static files during build, not a runtime dependency)

## [0.1.0] - 2026-03-09

First release of the Jinn AI gateway platform.

### ✨ Core Platform
- Gateway server with HTTP REST API + WebSocket real-time events
- Session manager with context builder (32K char budget, progressive trimming)
- SQLite session registry with WAL mode
- Per-session serial execution queue
- File watchers for hot-reload (config, cron, org, skills)
- Daemon lifecycle management (start/stop/status as background process)
- Multi-instance support with dynamic home directory resolution

### ✨ Engines
- Claude Code CLI engine wrapper (spawn, JSON streaming, session resume)
- Codex SDK engine wrapper (in-process, streaming)
- Model/effort level passthrough and configuration

### ✨ CLI
- `jinn setup` — bootstrap ~/.jinn/ from templates
- `jinn start` / `stop` / `status` — daemon management
- `jinn create` / `list` / `remove` — instance management
- `jinn nuke` — permanent instance deletion with safety prompts
- `jinn migrate` — AI-assisted template migrations
- `jinn skills` — skill discovery + skills.sh integration
- `--port` flag for custom port binding

### ✨ Connectors
- Slack connector (Socket Mode via @slack/bolt)
- Thread/DM/channel source-ref mapping
- Reaction workflow (👀 → ✅/❌)
- Message splitting for long responses
- Attachment download support

### ✨ Organization System
- Employee personas (YAML) with departments, ranks, engine assignment
- Org scanner with @mention routing
- Department boards for inter-agent task tracking
- Rich employee identity + generic connector context
- Dynamic COO naming via onboarding

### ✨ Skills System
- Markdown-based skill playbooks (SKILL.md with YAML frontmatter)
- 10 built-in skills: management, cron-manager, skill-creator, self-heal, onboarding, migrate, sync, status, new, find-and-install
- Skill symlink syncing to .claude/skills/ and .agents/skills/
- skills.sh marketplace integration
- Skills directory watcher with WebSocket change events

### ✨ Cron System
- node-cron scheduler with hot-reloadable jobs.json
- Run logging to JSONL files
- Delegation pattern (cron → COO → employee → review → deliver)
- Optional delivery to connectors

### ✨ Web UI
- Full Next.js 15 static dashboard
- Chat interface with voice recording, file attachments, rich markdown
- Session browser with detail view
- Org map (React Flow) with grid/feed views + employee detail panels
- Kanban board with drag-drop, tickets, employee assignment
- Cron visualizations — weekly schedule heatmap, pipeline grid
- Cost dashboard with charts, anomaly detection, WoW comparison
- Activity console with log browser + floating live stream widget
- Global search (Cmd+K)
- Settings page + onboarding wizard
- 5-theme CSS system with accent color support
- shadcn/ui components

### ✨ Session Context
- Rich context injection (identity, CLAUDE.md, config, org, skills, cron, connectors, API reference)
- Local environment awareness
- Lazy onboarding (stub session)

### 🏗️ Infrastructure
- pnpm + Turborepo monorepo
- TypeScript throughout
- Web UI bundled into CLI package
- CI workflow (GitHub Actions)
- README, CONTRIBUTING guide, LICENSE

<h1 align="center">🧞 Jinn</h1>

<p align="center"><b>Run your AI agents as a company.</b></p>

<p align="center">
  Jinn turns the agent CLIs you already use - Claude Code, Codex, Grok, Hermes - into a persistent AI company:
  named employees, a durable Todo ledger, and reusable Workflows,
  all operated from a chat and web dashboard.<br/>
  It doesn't replace your agents. <b>It gives them an org to work in.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/jinn-cli"><img src="https://img.shields.io/npm/v/jinn-cli?color=7c3aed&label=npm" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/jinn-cli?color=7c3aed" alt="license" /></a>
  <img src="https://img.shields.io/node/v/jinn-cli?color=7c3aed" alt="node version" />
  <a href="https://github.com/hristo2612/jinn/pkgs/container/jinn"><img src="https://img.shields.io/badge/ghcr.io-hristo2612%2Fjinn-2496ED?logo=docker&logoColor=white" alt="Container image on GHCR" /></a>
  <img src="https://img.shields.io/badge/status-beta-7c3aed" alt="status: beta" />
</p>

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="Jinn web dashboard" width="820" />
</p>

> **You bring the engines. Jinn runs the company.**

---

## Why Jinn?

Agent CLIs are powerful alone. Jinn gives them shared structure, ownership, and history.

- **🎼 Bus, not brain.** Jinn conducts the agent CLIs on your `PATH` and adds no AI logic. Better engines make Jinn better automatically.
- **🏢 A real org.** Define named employees, ranks, departments, and reporting lines in YAML. Your COO delegates through the hierarchy.
- **📋 Durable work.** Todos preserve ownership and review beyond a session; the built-in MCP gives employees typed company tools.
- **🔁 Reusable automation.** Workflows combine sequential, conditional, parallel, and switch paths with per-phase models, approvals, triggers, and run history.
- **⏰ Work with receipts.** Cron, delegation, callbacks, and Workflows keep running and leave structured activity in Chat.

> Jinn is **beta**. It works today and moves fast; read the upgrade notes when you bump versions.

---

## Quickstart

### Native install

> **Prerequisites:** Node.js **22 or newer** (the repository pins **24.13.0** in `.nvmrc`), and at least one agent CLI installed **and signed in**. Jinn orchestrates your engines and can't run a session without one.

```bash
# 1. Install Jinn
npm install -g jinn-cli

# 2. Install + sign in to at least one engine (example: Claude Code)
npm install -g @anthropic-ai/claude-code
claude            # run once, use /login, then quit

# 3. Set up ~/.jinn (probes your engines, writes config, seeds your company)
jinn setup

# 4. Start the gateway - opens the dashboard for you
jinn start
```

Open **[http://localhost:7777](http://localhost:7777)** and send your first message.

Or install via **Homebrew**:

```bash
brew tap hristo2612/jinn https://github.com/hristo2612/jinn
brew install jinn
jinn setup && jinn start
```

> **`--version` ≠ signed in.** Jinn drives the official engine CLIs, so authenticate each one *before* `jinn start` (run `claude` → `/login`, run `codex` to sign in, and so on). Without this, sessions can't reach the models - the most common fresh-install gotcha.

### Docker

Docker needs Docker Engine or Docker Desktop with Compose v2, but it does **not** need Node.js, an agent CLI, or a checkout of this repository. The published image includes Claude Code and is built for `linux/amd64` and `linux/arm64`. Containerising bounds the engine's permission-free access to the directories you explicitly mount instead of your whole home directory:

```bash
# One file, no clone. Swap `main` for a tag (v0.29.1) to take that release's copy.
curl -O https://raw.githubusercontent.com/hristo2612/jinn/main/docker-compose.yml

# Edit docker-compose.yml and uncomment at least one "Project mounts" entry.
# Without one, /work is empty and the agents have nothing to work on.
docker compose up -d
docker compose exec jinn claude     # run once, use /login, then quit
docker compose exec jinn jinn pair  # prints a code for the browser
```

Then open **[http://localhost:7777](http://localhost:7777)** and enter the code at the pairing prompt. The gateway binds `0.0.0.0` inside the container, so it requires auth, and your browser reaches it through Docker's NAT rather than loopback — which is why pairing replaces the automatic sign-in a host install gets.

The image is **`ghcr.io/hristo2612/jinn`**, tagged `latest` plus every release (`0.29.1`, `0.29`). Pin one by putting `JINN_VERSION=0.29.1` in a `.env` file beside the compose file; upgrading is then `docker compose pull && docker compose up -d`, which keeps your login, sessions and pairing.

The compose image runs one Jinn instance. Additional instances need separate containers, dedicated Jinn/Claude volumes and separately published ports. The writable blast radius includes those state volumes (OAuth, sessions and plugins), every writable project mount, and unrestricted network egress; see the Docker guide before mounting sensitive data.

The image ships the `claude` engine only. `codex`, `grok` and `hermes` are not included, and neither are `ffmpeg`/`whisper-cli` for speech-to-text — the same as a Homebrew or npm install, which leave those to you. See **[docs/docker.md](docs/docker.md)** for the mount model, what persists across upgrades, how to add speech-to-text, building the image from a checkout instead, and what the isolation does and does not cover.

Everyday commands for a native install:

```bash
jinn start      # start the gateway daemon (auto-opens the dashboard)
jinn stop       # stop it
jinn restart    # restart safely (detached; works even from inside a session)
jinn status     # is the daemon running?
```

Docker owns the gateway lifecycle instead — `jinn start`, `jinn stop`, and `jinn restart` are intentionally unavailable inside the container:

```bash
docker compose ps                 # status and health
docker compose logs -f jinn       # follow gateway logs
docker compose restart jinn       # restart safely
docker compose pull               # fetch a newer image (then `up -d` to apply it)
docker compose down               # stop; named volumes remain intact
```

After upgrading an older install, run **`jinn migrate`**. Your COO applies the latest operating doctrine without overwriting your customizations.

---

## The company model

Jinn exposes a small set of building blocks and handles the machinery underneath.

**Employees** are editable YAML roles with a name, department, rank, and engine. One employee can run several sessions; different roles can use different engines.

**Todos** are the durable work ledger. They track assignee, priority, status, sub-tasks, discussion, approvals, and reviewer-owned completion across sessions.

<div align="center">
  <img src="assets/todos.png" alt="The Todos ledger - tickets assigned to AI employees across backlog, in-progress, review, and done" width="880" />
</div>

**Workflows** are reusable graph procedures with sequential, conditional, parallel, and switch paths. Phases can choose engines and models, require approval, and preserve evidence and run history. Triggers start them from schedules, webhooks, polls, or Todo changes.

<div align="center">
  <img src="assets/workflows.png" alt="Visual Workflow editor - a graph canvas of phases with sequential, parallel, and conditional paths" width="880" />
</div>

**Chat** operates the company. Delegations, callbacks, Todo changes, and Workflow operations appear beside the conversation as durable activity receipts.

<div align="center">
  <img src="assets/chat.png" alt="Jinn chat - an engineering employee diagnosing and fixing a flaky test, with company activity receipts" width="880" />
</div>
<div align="center"><sub>An Engineering employee triages a flaky test, ships the fix, and opens a PR, with each delegation and callback rendered as an activity receipt.</sub></div>

**Notes, Skills, and Cron** provide searchable Markdown knowledge, reusable playbooks, and scheduled work. A built-in **Jinn MCP** gives engines typed tools for company operations; shell access remains available for local implementation.

---

## How it works

Jinn is a local gateway daemon plus a web dashboard. It dispatches work to installed engines, persists company state, runs automation, and serves the UI at `localhost:7777`.

```
                          +----------------+
                          |    jinn CLI    |
                          +-------+--------+
                                  |
                          +-------v--------+
                          |    Gateway     |
                          |     Daemon     |
                          +--+--+--+--+----+
                             |  |  |  |
              +--------------+  |  |  +--------------+
              |                 |  |                 |
      +-------v---------+ +-----v------+  +---------v-----+
      |     Engines     | | Connectors |  |    Web UI     |
      | claude · codex  | | Slack · WA |  | localhost:7777|
      | grok · hermes…  | | Discord·TG |  |               |
      +-------+---------+ +-----+------+  +-------+-------+
              |                                   |
      +-------v-------+   +-----------+   +--------v-------+
      |  Todos ·      |   |   Cron    |   |  Jinn MCP      |
      |  Workflows    |   | Scheduler |   |  company hands |
      +---------------+   +-----------+   +----------------+
```

Claude runs in a real interactive terminal, so eligible turns bill against a Max/Pro subscription. Other engines use spawn-per-turn or streaming models. Jinn discovers supported models from each CLI when available.

---

## The org system

Employees live in `~/.jinn/org/` as plain YAML:

```yaml
name: research-lead
displayName: Research Lead
department: research
rank: manager
engine: claude
model: opus
reportsTo: chief-of-staff      # hierarchy of any depth
persona: |
  You lead market research. Break briefs into parallel sub-tasks,
  delegate to your analysts, and synthesize one clear answer.
```

Ranks set default reporting lines; `reportsTo` overrides them at any depth. Managers delegate sub-tasks as Todos and roll results back up, while any employee remains directly reachable.

Reviewers choose TRUST, VERIFY, or THOROUGH oversight. Money, irreversible or public actions, and legal or security risk route to you.

<div align="center">
  <img src="assets/org-map.png" alt="Interactive org chart of AI employees across departments" width="900" />
</div>

---

## Engines - bring your own

Jinn detects installed agent CLIs and lets each employee or session choose an engine. It discovers model catalogs when supported and otherwise uses labels from `config.yaml`.

| Engine | What it is | Install | Modes | Effort |
|--------|-----------|---------|-------|--------|
| **claude** | Anthropic Claude Code - first-party, subscription-friendly | `npm install -g @anthropic-ai/claude-code` | Chat (PTY + live stream) · CLI (xterm) | low / medium / high |
| **codex** | OpenAI Codex CLI | `npm install -g @openai/codex` | Chat · CLI (xterm) | low / medium / high / xhigh |
| **grok** | xAI Grok CLI | `npm install -g @xai-official/grok` (run `grok` once to auth) | Chat · CLI (xterm) | low / medium / high / xhigh / max |
| **antigravity** | Antigravity CLI (`agy`) | see Antigravity docs | CLI (xterm) | - |
| **pi** | Pi coding agent CLI | see Pi CLI docs | Chat | - |
| **hermes** | NousResearch Hermes - open-source, model-agnostic agent | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | Chat (ACP streaming) · CLI (xterm view) | - |

Fallback labels include **Opus (Latest)**, **Sonnet (Latest)**, **Fable (Latest)**, **GPT-5.5 Codex**, **Grok Build**, and **Gemini 3.5 Flash Medium / High / Low**. Pi and Hermes report their models at session start.

> **Hermes cost note.** Unlike the subscription-wrapped engines, Hermes owns its own model loop and bills **per token** on the provider configured in `~/.hermes`. It streams over the Agent Client Protocol (ACP) and runs fully auto-approved. See [`docs/engines-hermes.md`](docs/engines-hermes.md).

<details>
<summary><b>How the Claude engine runs on your subscription</b> (the PTY details)</summary>

Jinn drives the interactive `claude` binary through [node-pty](https://github.com/microsoft/node-pty), so eligible turns use Max/Pro subscription billing. Hooks mark turn boundaries, a loopback proxy streams model output, and transcript JSONL provides token usage.

The Chat and CLI views share one PTY. Terminal snapshots survive reconnects and gateway restarts. Codex, Grok, and Pi spawn per turn; Hermes streams over ACP.

</details>

---

## What people build with it

- **Shipping Slack bots** that delegate work and report back in-thread.
- **Content pipelines** that research, draft, review, and publish on schedule.
- **Support desks** that require human approval before sending replies.
- **Research orgs** where managers fan out questions and synthesize the results.
- **Ops runbooks** encoded as triggered Workflows with approvals and durable history.

---

## Configuration

Jinn reads `~/.jinn/config.yaml`. A fresh setup includes this core shape:

```yaml
gateway:
  port: 7777
  host: "127.0.0.1"
  authRequired: true
  notesEnabled: false

engines:
  default: claude
  claude:
    bin: claude
    model: opus
    effortLevel: medium
  codex:
    bin: codex
    model: gpt-5.5
  grok:
    bin: grok
    model: grok-build
  hermes:
    bin: hermes
    model: openai-codex:gpt-5.5

models:
  claude:
    default: opus
    effortMechanism: claude-flag
    models:
      - { id: opus, label: "Opus (Latest)", supportsEffort: true, effortLevels: [low, medium, high, xhigh, max] }

logging:
  file: true
  stdout: true
  level: info
```

- **Engines** select CLI binaries and defaults; `engines.default` controls new sessions.
- **Models** form an extensible per-engine capability registry. CLI discovery can replace fallback entries at runtime.
- **MCP servers** are optional; enable `mcp.gateway` for the built-in company tools.
- **Cron, employees, and skills** live in `~/.jinn/cron/jobs.json`, `~/.jinn/org/`, and `~/.jinn/skills/`.
- **Workflow evidence** defaults to `<JINN_HOME>/workflow-evidence`; `JINN_WORKFLOW_EVIDENCE_ROOT` relocates it.

Everything is human-readable and yours to edit. After upgrading, run **`jinn migrate`** to merge current operating doctrine into your customized instance.

---

## Roadmap

Jinn is in active beta. Shipped recently:

- **Workflow completion contracts** with validated output, bounded extensions, reminders, and an observable run canvas.
- **Collaborative Todo hierarchy** with sub-tasks, roll-up gates, labels, comments, links, attachments, provenance, and approval history.
- **Isolated workspaces** with separate homes, ports, access settings, and authentication.
- **Grouped Todo receipts**, model-scoped Claude limits, instance-wide MCP file reads, and authentication required by default.

On deck:

- **Engines:** local models and fallback chains.
- **Connectors:** iMessage and email.
- **Platform:** plugins and multi-user roles.

See [CHANGELOG.md](CHANGELOG.md) for release history, or [open an issue](https://github.com/hristo2612/jinn/issues).

---

## Development

Jinn is a pnpm + turbo monorepo.

```bash
git clone https://github.com/hristo2612/jinn.git
cd jinn
pnpm install
pnpm setup   # one-time: builds all packages and creates ~/.jinn
pnpm dev     # gateway (:7777) + Vite dev server (:5173) with hot reload
```

Open **[http://localhost:5173](http://localhost:5173)**. Vite proxies `/api` and `/ws` to the gateway.

```bash
pnpm build       # build every package (turbo) and sync web assets
pnpm test        # run the test suites across packages
pnpm typecheck   # type-check without emitting
pnpm lint        # lint every package
pnpm test:e2e    # Playwright end-to-end tests
```

> **Prerequisites:** Node.js **22 or newer**; contributors should use **24.13.0**, pinned by `.nvmrc` + `engine-strict` because native modules like `better-sqlite3` are ABI-locked. You also need pnpm **10.6+** and at least one engine CLI. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the full setup.

---

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for setup and pull request instructions.

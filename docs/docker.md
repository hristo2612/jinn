# Running Jinn in Docker

## Why

`InteractiveClaudeEngine` spawns `claude` with `--dangerously-skip-permissions` on every turn. That disables Claude Code's approval prompt for everything the process can reach — on a workstation, your entire home directory. The flag is deliberate (Jinn enforces its own policy through `PreToolUse` hooks rather than interactive prompts), but it means a mistake or a prompt injection has a large blast radius.

In a container, the filesystem radius is every writable mount: project bind mounts plus the `jinn-home` and `jinn-claude` named volumes. Those named volumes include Jinn secrets, session transcripts and browser-pairing state, plus Claude OAuth credentials, session history, MCP/plugin configuration and trust state. Nothing else on the host exists as far as the agents are concerned, but network egress is unrestricted, so any readable mounted data must be treated as exfiltratable.

Containerising also avoids a class of packaging problem. `better-sqlite3` needs its native binding compiled and `node-pty` needs its prebuilt `spawn-helper` to be executable, both at install time. Any install that skips lifecycle scripts yields a Jinn that crashes on boot or fails every PTY spawn with `posix_spawnp failed.` The image installs normally, so both are correct by construction.

## Quick start

First, edit `docker-compose.yml` and uncomment at least one entry under **Project mounts**. At least one is required — without it `/work` is empty and the agents have nothing to work on.

```yaml
      # - ${HOME}/code/my-project:/work/my-project     ← uncomment and edit
```

Then:

```bash
docker compose up -d --build
docker compose exec jinn claude      # use /login, complete the flow, then quit
docker compose exec jinn jinn pair   # prints a single-use pairing code
```

Open **http://localhost:7777** and enter the code at the **Pair This Browser** prompt.

### Why pairing, when a host install just opens the dashboard

`jinn setup` writes `authRequired: true`, and inside a container the entrypoint binds `0.0.0.0` — which also counts as network-exposed — so the gateway requires authentication. A host install skips the prompt because `jinn start` runs on a TTY and mints a short-lived local credential for the browser it opens, and that exchange is loopback-only. Your browser reaches the container through Docker's NAT, arriving as `172.x` rather than `127.0.0.1`, so it cannot use that path.

`jinn pair` is the way in: run inside the container it dials loopback and proves it controls `JINN_HOME`, then hands you a code to type into the browser. You only do this once per browser.

The image is intentionally a **single Jinn-instance deployment**. Secondary workspace creation/start and `--take-port` are rejected because the compose service persists and publishes only the primary instance. Run another instance as another container with its own `jinn-home` and `jinn-claude` volumes and its own published port.

## Credentials

Claude Code stores credentials differently per platform: the login Keychain on macOS, a plaintext `~/.claude/.credentials.json` on Linux. The container is Linux, so it needs its own login — you cannot copy macOS Keychain credentials into it.

Sign in once with `docker compose exec jinn claude`. The credentials land on the `jinn-claude` volume and survive restarts and rebuilds. The mount is read-write on purpose: the CLI refreshes its OAuth token in place, and a read-only mount turns a working login into a puzzling auth failure days later.

Run that from a real terminal. `docker compose exec` allocates a TTY by default, so invoking it where there isn't one — a CI step, an editor task runner, an agent shell — fails with a bare usage error rather than anything explanatory. For a non-interactive check, `docker compose exec -T jinn claude --version` works; the login flow itself needs the TTY.

Model discovery caches its result, so a `Claude model discovery returned 0 models` warning can linger in the log after a successful login. `docker compose restart` re-runs discovery and reports the real count.

Do not try to pass a token via `CLAUDE_CODE_OAUTH_TOKEN`. `buildEngineChildEnv` strips every `CLAUDE_CODE_*` key when spawning the engine (`packages/jinn/src/shared/child-env.ts`), so it never reaches the CLI. That env var is read by the gateway for model discovery, not by the spawned session.

## Mounts

Project mounts live in `docker-compose.yml` itself, under **Project mounts** — one line per repository:

```yaml
      - ${HOME}/code/my-project:/work/my-project
      - ${HOME}/code/design-system:/work/design-system:ro
```

**At least one is required.** With none, the container starts fine but `/work` is empty and the agents have nothing to act on. Check with `docker compose exec jinn ls /work`.

Point your employees' working directories at the container paths (`/work/my-project`), not the host paths.

Prefer `:ro` wherever the agents only need to read — that list is the blast radius, and everything on it is writable without a prompt.

> If you would rather not carry local edits in a tracked file, the same entries work in a `docker-compose.override.yml` (git-ignored, merged automatically by `docker compose`). Editing `docker-compose.yml` directly is the simpler default; the override file is there if you want a clean `git status`.

## What the isolation does and does not cover

**Covered.** The host filesystem outside your mounts — SSH keys, browser profiles, credential stores, other repositories, everything in `$HOME` you did not explicitly mount. Host processes.

**Not covered:**

- **The dashboard is published on your network.** `ports:` binds every interface, so anything that can reach the host on 7777 reaches the pairing prompt, and the gateway token is what stands between it and the agent. `JINN_BIND_ADDR=127.0.0.1` in a `.env` file makes it host-only; an interface address publishes on that one alone.

- **Mounted directories are fully writable.** An agent can delete or rewrite anything under a read-write mount without asking. Use `:ro` where you can, and prefer repositories with a clean git state.
- **The named volumes are writable too.** `jinn-home` contains Jinn secrets, OAuth-adjacent connector state, browser pairing, sessions and transcripts; `jinn-claude` contains Claude OAuth credentials, sessions/history, plugins, MCP configuration and trust state.
- **Network egress is unrestricted.** The container has to reach the Anthropic API; it can therefore reach anything else, so treat data inside mounts as exfiltratable.
- **Credentials in the container are real.** The `jinn-claude` volume holds a live token for your account.
- **Only the `claude` engine is installed.** `codex`, `grok` and `hermes` appear in the default config but their binaries are not in the image, so selecting one in the dashboard will fail. A Homebrew or npm install does not provide them either.
- **Voice features are not installed.** Speech-to-text needs `whisper-cli` and `ffmpeg`, neither of which is in the image — see [Enabling speech-to-text](#enabling-speech-to-text). Voice *output* (kokoro TTS) additionally shells out to `python`, which the runtime stage does not include, so `/talk` playback is unavailable without extending the image further.
- **Git has no identity.** `git commit` inside a mounted repo fails with *"Author identity unknown"* unless you supply `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`, and on a Linux host whose user is not uid 1000 the bind-mounted files are not writable by the container's `node` user. Reading them does work: the image sets `safe.directory = *` system-wide, without which git refuses a foreign-owned repository outright — `git status` and `git log` included, not just writes.

## Enabling speech-to-text

`/talk`, voice notes and the dashboard microphone shell out to `whisper-cli` and `ffmpeg`. The image does not include them — neither does a Homebrew or npm install, where you would run `brew install ffmpeg whisper-cpp` yourself.

Installing them inside a running container with `apt-get` will *not* work: that lands in the container's writable layer, which `docker compose up -d --build` throws away. They have to be baked into an image.

Build the base image under its own tag first, so the derived one has something to extend (compose tags its own build `jinn:local`, so `Dockerfile.stt` must not use that name as its base):

```bash
docker build --tag jinn:base .
```

Then create `Dockerfile.stt`:

```dockerfile
FROM jinn:base
USER root
ARG WHISPER_CPP_REF=v1.7.4
# curl is not listed: the base image already installs it, because agent turns reach
# the gateway with it. The model download shells out to the same binary.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg cmake g++ git \
 && git clone --depth 1 -b "$WHISPER_CPP_REF" https://github.com/ggerganov/whisper.cpp /tmp/w \
 && cmake -S /tmp/w -B /tmp/w/build \
 && cmake --build /tmp/w/build -j --target whisper-cli \
 && cp /tmp/w/build/bin/whisper-cli /usr/local/bin/ \
 && rm -rf /tmp/w /var/lib/apt/lists/*
USER node
```

Point compose at it in `docker-compose.override.yml`:

```yaml
services:
  jinn:
    build:
      dockerfile: Dockerfile.stt
```

Then `docker compose up -d --build` and download a model from the dashboard. **No extra volume is needed** — models are written to `~/.jinn/models/whisper`, already on the `jinn-home` volume, so each one downloads once and survives every later upgrade. Re-run the `docker build --tag jinn:base .` step whenever you upgrade Jinn itself.

## Persistence and upgrades

Upgrading is `docker compose up -d --build` (or a `pull` and recreate). **Nothing is lost** — the same as a `brew upgrade` or `npm i -g` bump. No re-login, no re-pairing, no repeated onboarding, no folder-trust prompts.

Two named volumes hold every stateful path:

| Volume | Contents |
| --- | --- |
| `jinn-home` | `~/.jinn` — `config.yaml`, your customised `CLAUDE.md`, `sessions/registry.db` and transcripts, paired browsers (`auth-devices.json`), cron jobs, connectors, workflows, knowledge, skills, `secrets/`, logs, and whisper models if you enable STT |
| `jinn-claude` | `~/.claude` — the engine login (`.credentials.json`), skills, agents, commands, plugins, hooks, Claude Code's own session history, **and `.claude.json`** |

That last entry is the one worth knowing about. Claude Code normally writes its global config to `~/.claude.json` — *outside* `~/.claude` — which in a container means the container layer, discarded on every rebuild. That file holds your user-scope MCP servers, per-project trust settings, account and subscription identity, and onboarding flags, so losing it means re-adding MCP servers and re-approving every mounted repository after each upgrade.

The image avoids that by setting `CLAUDE_CONFIG_DIR=/home/node/.claude`, which moves that one file inside the volume and changes nothing else. Verify with:

```bash
docker compose exec jinn ls -la ~/.claude/.claude.json
```

> **A note on that setting.** `CLAUDE_CONFIG_DIR` works (verified against Claude Code 2.1.220) but is not in the published settings documentation, and [anthropics/claude-code#25762](https://github.com/anthropics/claude-code/issues/25762), which asks for exactly this variable, is still open. The use here is deliberately safe: it points at the directory Claude Code already uses, so if a future release stops honouring it the only consequence is that `.claude.json` returns to its unpersisted default — nothing is corrupted.
>
> There is a second net under it. `~/.claude.json` is a symlink into the volume, so a release that ignores `CLAUDE_CONFIG_DIR` and updates that path in place still writes to persistent storage. Only a write that *replaces* the path — temp file, then rename — replaces the link with a real file in the container layer; the entrypoint copies that file onto the volume as `.claude.json.stray` on the next boot and says so loudly in `docker compose logs`. It has to copy rather than only warn, because the layer holding it does not survive the `docker compose up -d --build` that upgrades the image.

After upgrading, run `jinn migrate` as you would on a host install.

`docker compose down` keeps the volumes; `docker compose down -v` destroys them, which means re-running setup, signing in and pairing again.

## Notes on the container

- **Bind address.** The entrypoint starts the gateway with `JINN_HOST=0.0.0.0` when `config.yaml` names a loopback address or none. Inside a container the shipped default binds the container's own loopback, so a published port would resolve to nothing. The host side of that mapping is `JINN_BIND_ADDR`, `0.0.0.0` by default — `127.0.0.1` there keeps the gateway on the host. `config.yaml` is left untouched — the override is an environment variable, so a `jinn-home` volume you later open on a workstation does not carry the container's binding with it. Set `gateway.host` to a non-loopback address yourself and the entrypoint leaves it alone.
- **Port.** `JINN_PORT` moves it — set it in a `.env` file beside `docker-compose.yml` and both sides of the mapping follow, as does the gateway, which reads `JINN_PORT` in preference to `gateway.port`. Do not change only one of them: a gateway bound where the mapping does not reach refuses connections under a boot log that reads perfectly healthy. `docker compose exec jinn jinn status` sees the same variable, so it stays in agreement. Passing `--port` to the container is rejected outright, because it would move the gateway without moving the mapping.
- **Editing the binding from the dashboard.** Settings shows the *effective* host and port, so in the container it shows what `JINN_HOST`/`JINN_PORT` resolved to. Saving that page never writes those two values back into `config.yaml` — that is what would carry the container's binding onto the volume. Changing either one there is refused with an explicit message instead of being silently ignored: unset the variable and the field becomes yours again.
- **Health.** The image ships a `HEALTHCHECK` that asks `/api/status` at the address *and* port the gateway actually bound, both read from `gateway.json` — so a deliberate non-loopback `gateway.host` stays healthy. It catches the failure a restart policy cannot see: a live process that is no longer serving. Docker reports it in `docker compose ps` and does not restart on it.
- **Running one-off commands.** Use `docker compose exec jinn jinn <command>` for inspection of the live service. Do not use `docker compose run` for that job: it creates a separate container against the same volumes and does not inherit the live container's effective environment. The entrypoint skips setup and container configuration for arbitrary one-off commands, so launching one does not itself rewrite `gateway.json`, `gateway.pid` or `.claude.json`. A bare one-off service launch and an explicit replay of its private marker both fail on the shared-volume lock while the service is live. `jinn setup`, `jinn start` and `jinn restart` are rejected on one-off and exec paths; use `docker compose up -d` for startup and `docker compose restart jinn` for restart.
- **Single instance.** The compose service persists and publishes one Jinn instance. Its gateway holds an exclusive kernel `flock` on `gateway.lock` before setup or stale-record cleanup begins. Every container mounting that home contends on the same lock, and the kernel releases it automatically when the gateway process or container dies. `jinn restart` is disabled inside containers because a self-restart would create a lock gap; `docker compose restart jinn` replaces the container instead. `jinn create`, offline secondary start, `-i/--instance` gateway forwarding and `--take-port` are rejected in the image. A second instance needs a second container, dedicated Jinn/Claude volumes and a separately published port.
- **Bypass consent.** The container configuration step explicitly records `bypassPermissionsModeAccepted` in `/home/node/.claude/.claude.json`, which is inside the dedicated `jinn-claude` volume. Claude Code answers `--dangerously-skip-permissions` with a one-time blocking dialog, and nothing in a PTY presses a key — without this, every turn hangs and is eventually abandoned with *"no completion signal and no recoverable transcript"*. Host gateway startup does not accept this consent; it remains a container-scoped choice documented here.
- **Config location.** `CLAUDE_CONFIG_DIR=/home/node/.claude` keeps Claude Code's `.claude.json` inside the volume; see [Persistence and upgrades](#persistence-and-upgrades).
- **Engine version.** `@anthropic-ai/claude-code` is pinned by the `CLAUDE_CODE_VERSION` build arg so two builds of the same commit get the same engine, and `DISABLE_AUTOUPDATER=1` stops the CLI relocating itself onto the volume and drifting past the pin. Override with `docker compose build --build-arg CLAUDE_CODE_VERSION=<version>`.
- **Image provenance.** `.github/workflows/publish-image.yml` publishes `ghcr.io/<owner>/jinn` on every `v*` tag. Each architecture is built on a native runner and booted before anything is pushed (`scripts/docker-smoke.sh` — the same checks CI runs on amd64, which is the only place arm64 is exercised at all), then both digests are assembled into one `linux/amd64` + `linux/arm64` manifest list, which is read back from the registry and rejected if either architecture is missing. The workflow refuses a tag that disagrees with `packages/jinn/package.json` or is not an ancestor of `main`, so an image tag naming a version is that version. **The compose file in this repository still builds from your checkout** — the quick start above is the supported path, and pointing the default at the published image is a separate change.
- **Image tags are aliases, not fixed artifacts.** A release publishes `latest`, its exact version (`0.29.1`), its `major.minor` (`0.29`) and `sha-<short>`; a prerelease publishes only its exact version, moving neither `latest` nor `0.29`; a manual dispatch from a branch publishes only `sha-<short>`. None of them is immutable, including the version and SHA ones: re-running the workflow on the same ref repoints them, and the image resolves `node:24-bookworm-slim` and its apt packages by tag, so the same source commit can rebuild to a different digest. Where a build must not change underneath you, pin the digest instead — the workflow's run summary prints it, and `docker buildx imagetools inspect --format '{{.Manifest.Digest}}' ghcr.io/<owner>/jinn:0.29.1` reads it back afterwards.
- **Timezone.** The container is UTC. Shells do not normally export `TZ`, so `${TZ:-UTC}` takes the default unless you set it explicitly — either in your shell or, more reliably, in a `.env` file beside `docker-compose.yml` (`TZ=Europe/Paris`), which Compose reads automatically. It matters because a cron job with no explicit `timezone` fires in the container's zone; giving each job its own timezone is the more robust fix.
- **Non-root.** Everything runs as the image's `node` user.
- **`init: true`.** Each session spawns a PTY that spawns its own children; without an init process, orphans accumulate as zombies.
- **macOS sleep prevention** (`caffeinate`) is skipped automatically — it is guarded by a platform check.

## Troubleshooting

**Dashboard shows a pairing screen.** Expected on a new browser — run `docker compose exec jinn jinn pair` and enter the code. See [Why pairing](#why-pairing-when-a-host-install-just-opens-the-dashboard).

**Dashboard doesn't load at all.** Check `docker compose logs jinn` for `Jinn gateway listening on http://0.0.0.0:7777`. The entrypoint refuses to start if it cannot read or parse `config.yaml`, so that shows up as a restart loop with an explanatory message in the log rather than a silently dead dashboard. A missing `gateway.host` is overridden rather than treated as fatal. If the log says it is listening on a *different* port, the published mapping and the gateway have drifted apart — set `JINN_PORT` and recreate, which moves both.

**A warning about `~/.claude.json` in the logs.** The `CLAUDE_CONFIG_DIR` redirect stopped taking effect *and* the write replaced the symlink standing in for it, so Claude Code's config is a real file in the container layer. The entrypoint has already copied it to `~/.claude/.claude.json.stray` on the volume; merge what you need back into `~/.claude/.claude.json`. See the note under [Persistence and upgrades](#persistence-and-upgrades).

**A warning that `.claude.json` does not parse.** The entrypoint side-copies the damaged file to `~/.claude/.claude.json.corrupt`, then writes a fresh config so turns still run. A second incident gets its own slot (`.corrupt.1`, `.corrupt.2`, …) rather than overwriting the first. Your MCP servers and per-project trust are not restored automatically — recover what you need from the copy and re-add them.

**`docker compose ps` shows `unhealthy`.** The process is alive but `/api/status` stopped answering — a wedged turn, or an HTTP server that stopped accepting. Docker reports this; it does not act on it, because `restart:` policies react to exits and nothing exited. `docker compose restart jinn` is the fix; `docker compose logs jinn` is where the cause will be.

**Every turn stalls, then reports no completion signal.** The bypass consent is missing. Confirm with:

```bash
docker compose exec jinn node -e 'console.log(require(process.env.CLAUDE_CONFIG_DIR+"/.claude.json").bypassPermissionsModeAccepted)'
```

**Model discovery returns 0 models.** Authentication, not the container. `readClaudeOAuthToken()` in `packages/jinn/src/shared/claude-models.ts` is the single reader for the whole codebase; on Linux it expects `~/.claude/.credentials.json`. Re-run `docker compose exec jinn claude` and `/login`.

**Agent can't see a project.** It isn't mounted, or the employee's working directory still points at a host path. Check `docker compose exec jinn ls /work`.

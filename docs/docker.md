# Running Jinn in Docker

## Why

`InteractiveClaudeEngine` spawns `claude` with `--dangerously-skip-permissions` on every turn. That disables Claude Code's approval prompt for everything the process can reach — on a workstation, your entire home directory. The flag is deliberate (Jinn enforces its own policy through `PreToolUse` hooks rather than interactive prompts), but it means a mistake or a prompt injection has a large blast radius.

In a container, the filesystem radius is every writable mount: project bind mounts plus the `jinn-home` and `jinn-claude` named volumes. Those named volumes include Jinn secrets, session transcripts and browser-pairing state, plus Claude OAuth credentials, session history, MCP/plugin configuration and trust state. Nothing else on the host exists as far as the agents are concerned, but network egress is unrestricted, so any readable mounted data must be treated as exfiltratable.

Containerising also avoids a class of packaging problem. `better-sqlite3` needs its native binding compiled and `node-pty` needs its prebuilt `spawn-helper` to be executable, both at install time. Any install that skips lifecycle scripts yields a Jinn that crashes on boot or fails every PTY spawn with `posix_spawnp failed.` The image installs normally, so both are correct by construction.

## The image

Releases are published to this repository's GitHub Container Registry package — **`ghcr.io/<owner>/jinn`** — as a multi-architecture manifest covering `linux/amd64` and `linux/arm64`, so Apple Silicon and x86 both pull a native image and neither runs under emulation. It is public and unauthenticated: pulling it needs no `docker login`.

This guide never writes the owner out, so a fork inherits nothing here it then has to correct. `.github/workflows/publish-image.yml` derives the path it publishes to from `github.repository`, and the only spelled-out references in the repository are the default of `JINN_IMAGE` in `docker-compose.yml` and the README's quick start. The compose file is the authority on what your checkout actually pulls:

```bash
grep image: docker-compose.yml     # the exact reference this checkout pulls
```

Point `JINN_IMAGE` at a fork or an internal mirror in your `.env` and the rest of the compose file is unchanged. Substitute the same value wherever this guide writes `ghcr.io/<owner>/jinn`.

| Tag | Points at | Use it when |
| --- | --- | --- |
| `latest` | the newest release | You want the current version and are happy to take upgrades when you pull |
| `0.29.1` | that release | You want one version, and upgrades only when you say so |
| `0.29` | the newest patch of that minor | You want fixes but not features |
| `sha-<short>` | that source commit | You want to name a commit rather than a version |

Prereleases (`v1.0.0-rc.1`) get their exact version tag and nothing else — they move neither `latest` nor a `major.minor` tag. A manually dispatched build from a branch publishes only `sha-<short>`.

Those are all **aliases for a source revision, not fixed artifacts** — `0.29.1` and `sha-<short>` included. Re-running the publish workflow on the same ref repoints them, and the image resolves its base layer (`node:24-bookworm-slim`) and its apt packages by tag, so the same commit does not necessarily rebuild to the same bytes. `0.29.1` will not silently become 0.29.2, but it is not a promise of identical content.

Where that distinction matters — an audited deployment, a reproducible build, a base image you extend — pin the digest, which is the only reference that cannot be repointed. Each publish run prints it in its GitHub Actions summary, and it can be read back at any time:

```bash
docker buildx imagetools inspect --format '{{.Manifest.Digest}}' ghcr.io/<owner>/jinn:0.29.1
```

A Docker reference may carry a tag *and* a digest, and the digest is what resolves, so the version stays readable in your `.env` while the bytes are fixed:

```dotenv
JINN_VERSION=0.29.1@sha256:1f2e…
```

Nothing here needs a checkout. `docker-compose.yml` is the only file you need; if you would rather build the image from source, see [Building from a checkout](#building-from-a-checkout).

## Quick start

Put `docker-compose.yml` in an empty directory. The README's Docker section has a one-line `curl` for it, or take it from a release tag if you are pinning to that version.

Then edit it and uncomment at least one entry under **Project mounts**. At least one is required — without it `/work` is empty and the agents have nothing to work on.

```yaml
      # - ${HOME}/code/my-project:/work/my-project     ← uncomment and edit
```

Then:

```bash
docker compose up -d
docker compose exec jinn claude      # use /login, complete the flow, then quit
docker compose exec jinn jinn pair   # prints a single-use pairing code
```

Open **http://localhost:7777** and enter the code at the **Pair This Browser** prompt.

To pin a version, put it in a `.env` file beside `docker-compose.yml` — Compose reads that automatically, and the same file is where `TZ`, `JINN_PORT` and a non-default registry belong:

```dotenv
JINN_VERSION=0.29.1
# JINN_IMAGE=ghcr.io/you/jinn    # a fork or an internal mirror
```

### Without Compose

Compose is the recommended path — it is where the mount list, the loopback publish and the volume names are written down. But nothing in the image requires it, and the equivalent `docker run` is short enough to be worth having:

```bash
docker run -d --name jinn --init --restart unless-stopped \
  -p 127.0.0.1:7777:7777 \
  -v jinn-home:/home/node/.jinn \
  -v jinn-claude:/home/node/.claude \
  -v "$HOME/code/my-project:/work/my-project" \
  ghcr.io/<owner>/jinn:latest

docker exec -it jinn claude    # use /login, then quit
docker exec jinn jinn pair     # prints a pairing code
```

The image's default command is the entrypoint's private service marker, so a bare `docker run` boots the gateway; passing your own command runs that instead. Upgrading means `docker pull`, then `docker rm -f jinn` and a fresh `docker run` — the two named volumes carry all the state across, so nothing is lost.

### Building from a checkout

Working on Jinn itself, or running a commit that has not been released. From a clone of this repository:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`docker-compose.build.yml` adds the `build:` section and retags the result `jinn:local`, so a local build never shadows the published image for anything else on the machine. Everything else — ports, volumes, project mounts — still comes from `docker-compose.yml`, so edit your mounts there. It is deliberately *not* `docker-compose.override.yml`, which Compose merges automatically: in a checkout that would make every `docker compose up` rebuild instead of pull.

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

> Working from a checkout and would rather not carry local edits in a tracked file? The same entries work in a `docker-compose.override.yml` (git-ignored, merged automatically by `docker compose`). Editing `docker-compose.yml` directly is the simpler default; the override file is there if you want a clean `git status`.

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

Installing them inside a running container with `apt-get` will *not* work: that lands in the container's writable layer, which the next image swap throws away. They have to be baked into an image.

Extend the published image. Beside your `docker-compose.yml`, create `Dockerfile.stt`:

```dockerfile
# Same reference as `image:` in docker-compose.yml, pinned to a version so an STT
# rebuild cannot quietly upgrade Jinn too. Append `@sha256:…` as well if a rebuild
# has to land on the same base bytes — see The image for why a version tag alone
# does not guarantee that.
FROM ghcr.io/<owner>/jinn:0.29.1
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

Point compose at it in `docker-compose.override.yml`, which Compose merges automatically:

```yaml
services:
  jinn:
    build:
      context: .
      dockerfile: Dockerfile.stt
    # Its own tag, and `build` so Compose never tries to pull a name no registry has.
    image: jinn-stt:local
    pull_policy: build
```

Then `docker compose up -d --build` and download a model from the dashboard. **No extra volume is needed** — models are written to `~/.jinn/models/whisper`, already on the `jinn-home` volume, so each one downloads once and survives every later upgrade.

Upgrading now takes two steps rather than one: bump the `FROM` pin, then `docker compose build --pull && docker compose up -d`. The `JINN_VERSION` variable no longer applies — the `image:` above replaced the published reference it interpolated into.

## Persistence and upgrades

Upgrading is:

```bash
docker compose pull        # fetch the newer image
docker compose up -d       # recreate the container against it
```

**Nothing is lost** — the same as a `brew upgrade` or `npm i -g` bump. No re-login, no re-pairing, no repeated onboarding, no folder-trust prompts.

`pull` is a separate step because `up -d` on its own will not fetch a newer image (`pull_policy: missing` in the compose file). That is deliberate: with `latest`, an `up -d` run for an unrelated reason would otherwise swap versions underneath a working instance. If you pinned `JINN_VERSION`, bump it first — `pull` then fetches the version you asked for rather than a moving tag. Building from a checkout instead? `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

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
> There is a second net under it. `~/.claude.json` is a symlink into the volume, so a release that ignores `CLAUDE_CONFIG_DIR` and updates that path in place still writes to persistent storage. Only a write that *replaces* the path — temp file, then rename — replaces the link with a real file in the container layer; the entrypoint copies that file onto the volume as `.claude.json.stray` on the next boot and says so loudly in `docker compose logs`. It has to copy rather than only warn, because the layer holding it does not survive the container recreation that upgrades the image.

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
- **Engine version.** `@anthropic-ai/claude-code` is pinned by the `CLAUDE_CODE_VERSION` build arg so two builds of the same commit get the same engine, and `DISABLE_AUTOUPDATER=1` stops the CLI relocating itself onto the volume and drifting past the pin. A published image therefore carries a fixed engine, and moving it means building: `docker compose -f docker-compose.yml -f docker-compose.build.yml build --build-arg CLAUDE_CODE_VERSION=<version>`.
- **Image provenance.** `.github/workflows/publish-image.yml` builds each architecture on a native runner, boots a gateway from the result (`scripts/docker-smoke.sh` — the same checks CI runs on amd64, which is the only place arm64 is exercised at all), and only then pushes and assembles the manifest list, which it reads back from the registry and rejects if either architecture is missing. The workflow triggers on `v*` tags and refuses to publish a tag that disagrees with `packages/jinn/package.json` or is not an ancestor of `main`, so an image tag naming a version is that version. What it does *not* claim is that a tag is a fixed set of bytes — see [The image](#the-image) for why, and for the digest to pin when you need that.
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

# syntax=docker/dockerfile:1

# Jinn container image. InteractiveClaudeEngine always spawns `claude` with
# --dangerously-skip-permissions, which disables the approval gate for everything
# the process can reach; here that is only the paths deliberately mounted in.

FROM node:24-bookworm-slim AS builder

# g++/make/python3 compile better-sqlite3 and node-pty. No git: pnpm-lock.yaml has
# zero git specifiers and the install below is --frozen-lockfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

# pnpm version comes from the root package.json "packageManager" field.
RUN corepack enable
WORKDIR /src

# Manifests first so dependency installation caches independently of source edits.
# The two postinstall scripts by name, not the whole scripts/ trees: pnpm needs them on
# disk before the install, and copying their siblings too made editing any of them
# recompile better-sqlite3 and node-pty. The rest arrives with `COPY . .` below.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY scripts/fix-prebuild-permissions.mjs ./scripts/
COPY packages/gateway-events/package.json ./packages/gateway-events/
COPY packages/jinn/package.json ./packages/jinn/
COPY packages/jinn/scripts/fix-node-pty-permissions.mjs ./packages/jinn/scripts/
COPY packages/web/package.json ./packages/web/
COPY packages/shell/package.json ./packages/shell/

# The base image is already the Node pin. Honouring `use-node-version` would compile
# better-sqlite3/node-pty under a second Node fetched from nodejs.org while the runtime
# stage runs them under the image's own — an ABI pairing nothing enforces.
RUN sed -i '/^use-node-version=/d' .npmrc

RUN pnpm install --frozen-lockfile

COPY . .

# Again: `COPY . .` restored the tracked .npmrc over the stripped one, and the two steps
# below are the ones that compile and re-run the native lifecycle scripts.
RUN sed -i '/^use-node-version=/d' .npmrc

# The ROOT build, not `pnpm --filter jinn build`: the root script also runs
# sync-web-dist.mjs, which puts the dashboard where the gateway serves it from.
# Filtering to the jinn package yields a gateway with no UI.
RUN pnpm build

# Ship the build, not the tree that produced it: `deploy` writes a self-contained
# jinn-cli at 215MB against 650MB of workspace. The difference is the build toolchain —
# nothing opens it at runtime, and an agent running without the permission gate should
# not find one here. Lifecycle scripts still run, so the native addons stay loadable.
#
# --legacy because the workspace does not set inject-workspace-packages; pnpm 10
# refuses to deploy without one or the other (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE).
RUN pnpm deploy --legacy --filter=jinn-cli --prod /deploy


FROM node:24-bookworm-slim AS runtime

# procps/lsof: the gateway inspects its own processes and port ownership.
# util-linux: flock holds the cross-container service lock on the shared home volume.
# git: agents work inside mounted repositories.
# curl: sessions/context.ts tells every agent to reach the gateway with it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git lsof procps util-linux \
  && command -v flock >/dev/null \
  && rm -rf /var/lib/apt/lists/*

# A bind-mounted repo carries its host uid, so on any host not using uid 1000 git
# refuses it entirely (`fatal: detected dubious ownership`) and an agent cannot fix that
# from inside a session. The blast radius is the mount list either way.
RUN git config --system --add safe.directory '*'

# The engine spawns this binary; it is not a jinn dependency, so it is pinned here.
# Engine drift is a realised failure mode: 2.1.170 implied the Bypass Permissions
# consent through global onboarding and 2.1.220 does not.
ARG CLAUDE_CODE_VERSION=2.1.220
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# The Telegram auth flow verifies the same persistent Codex CLI account that
# interactive turns use. Keep it pinned in the image; the writable auth volume
# stores only its login state, not the executable.
ARG CODEX_CLI_VERSION=0.149.0
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}"

# Without this the pin is defeatable: the CLI is installed root-owned but runs as
# `node`, so the updater either warns every turn or relocates itself onto the
# writable volume, where the drift then survives rebuilds. Unprefixed on purpose —
# buildEngineChildEnv strips every CLAUDE_CODE_* key before spawning the engine.
ENV DISABLE_AUTOUPDATER=1

# Kept at packages/jinn so package-relative paths (the wrapper below,
# docker-configure.mjs, TEMPLATE_DIR) read as they do in a checkout. root:node because an
# agent running without the permission gate should not rewrite the gateway serving it.
COPY --from=builder --chown=root:node /deploy /opt/jinn/packages/jinn
COPY --from=builder --chown=root:node /src/scripts/docker-configure.mjs /opt/jinn/scripts/

# A shell wrapper rather than a symlink into dist/bin/jinn.js: that file's shebang
# is rewritten at publish time, so depending on it would couple us to packaging.
RUN printf '#!/bin/sh\nexec node /opt/jinn/packages/jinn/dist/bin/jinn.js "$@"\n' > /usr/local/bin/jinn \
  && chmod 0755 /usr/local/bin/jinn

COPY docker-entrypoint.sh /usr/local/bin/jinn-entrypoint
COPY docker-healthcheck.sh /usr/local/bin/jinn-healthcheck
RUN chmod 0755 /usr/local/bin/jinn-entrypoint /usr/local/bin/jinn-healthcheck

# Mount points first: Docker seeds a fresh named volume from the ownership underneath, so
# without these the volume is root-owned and `node` cannot write its own config.
#
# The symlink is the net under CLAUDE_CONFIG_DIR below — a release that stops honouring
# it writes ~/.claude.json, which the next rebuild discards. Linked after the chown and
# chowned with -h, because the target does not exist until Claude Code first runs.
RUN mkdir -p /home/node/.jinn /home/node/.claude /home/node/.codex /work \
  && chown -R node:node /home/node /work \
  && ln -s /home/node/.claude/.claude.json /home/node/.claude.json \
  && chown -h node:node /home/node/.claude.json

USER node
ENV HOME=/home/node
ENV JINN_CONTAINER=1
ENV JINN_CONTAINER_PRIMARY_HOME=/home/node/.jinn
ENV JINN_STT_SETTINGS=/home/node/.jinn/stt.json
ENV JINN_STT_MODELS_DIR=/home/node/.jinn/models/whisper
WORKDIR /home/node

# Keep Claude Code's config inside the volume. It otherwise writes ~/.claude.json,
# which sits in the container layer and is discarded by every rebuild along with
# the user's MCP servers, project trust and onboarding state.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
ENV CODEX_HOME=/home/node/.codex

# Publish to the host's loopback only. The dashboard authenticates with a shared
# gateway token, so a routable interface would put agent control on the network.
# Documentation only; the actual port follows JINN_PORT (see docker-configure.mjs).
EXPOSE 7777

# A wedged gateway keeps PID 1 alive, so nothing exit-based notices. The start period is
# generous because a first boot runs `jinn setup` on an empty volume. Docker reports
# health; it does not restart on it — see docker-healthcheck.sh.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD ["/usr/local/bin/jinn-healthcheck"]

ENTRYPOINT ["/usr/local/bin/jinn-entrypoint"]
CMD ["__jinn_service_start__"]

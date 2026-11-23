# syntax=docker/dockerfile:1.7

# ═══════════════════════════════════════════════════════════════════════════════
# agent-canvas all-in-one Docker image
#
# Combines three services into a single image:
#   1. Agent Server  — from ghcr.io/openhands/agent-server (upstream SDK image)
#   2. Automation    — installed via pip from openhands-automation
#   3. Frontend      — agent-canvas static build served by Node.js
#
# The entrypoint starts all three services and an ingress proxy that unifies
# them behind a single port (default 8000):
#   /api/automation/*  → automation backend (:18001)
#   /api/*, /sockets   → agent server (:18000)
#   /* (default)       → static frontend + SPA fallback
# ═══════════════════════════════════════════════════════════════════════════════

# ── Build args ────────────────────────────────────────────────────────────────
# No hardcoded defaults — values are derived from config/defaults.json.
# CI passes these via --build-arg; for local builds use:
#   node scripts/docker-build.mjs          (recommended, reads JSON for you)
#   docker build --build-arg AGENT_SERVER_IMAGE=... --build-arg AUTOMATION_VERSION=... -f docker/Dockerfile .
ARG AGENT_SERVER_IMAGE
ARG AGENT_SERVER_VERSION
ARG AUTOMATION_VERSION

# ── Stage 1: Build frontend ──────────────────────────────────────────────────
# Build stages run on the build host's own platform: their output (static
# assets, pure-JS modules, a generated env file) does not depend on the CPU, so
# a cross-build such as `--platform linux/amd64` on an arm64 Mac only emulates
# the final stage instead of the whole npm install and Vite build.
FROM --platform=$BUILDPLATFORM node:24.22.1-slim AS frontend-build

WORKDIR /build

# Cache-friendly: package files first
COPY package.json package-lock.json ./
RUN npm ci

# Copy everything needed for the build
COPY . .

# Build the static frontend.
# VITE_POSTHOG_API_KEY is a public client key baked into the bundle. CI passes
# production for tagged releases and staging for PR/main images.
# VITE_BASE_PATH is baked into React Router/Vite so the Docker image serves
# Canvas under the Cloud subpath instead of a dedicated hostname.
# VITE_WORKING_DIR is the base directory for per-conversation working dirs. It
# must be absolute and inside a volume so they outlive the container (#18960).
# /projects is that volume, and compose.yml binds it to a host folder
# (PROJECTS_DIR), so the files agents write are visible on the host.
ARG VITE_POSTHOG_API_KEY=""
ARG VITE_BASE_PATH="/canvas"
ARG VITE_WORKING_DIR="/projects"
ENV VITE_POSTHOG_API_KEY=${VITE_POSTHOG_API_KEY}
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_WORKING_DIR=${VITE_WORKING_DIR}
RUN npm run build

# ── Stage 1b: Generate shell-sourceable defaults from config/defaults.json ──
# This avoids needing jq/python at container runtime to parse the JSON.
FROM --platform=$BUILDPLATFORM node:24.22.1-slim AS config-gen
COPY config/defaults.json /tmp/
RUN node -e " \
  const c = JSON.parse(require('fs').readFileSync('/tmp/defaults.json','utf-8')); \
  const lines = [ \
    'CONFIG_AGENT_SERVER_PORT=' + c.ports.agentServer, \
    'CONFIG_AUTOMATION_PORT=' + c.ports.automation, \
    'CONFIG_PROXY_PORT=' + c.ports.proxy, \
    'CONFIG_VSCODE_PORT=' + c.ports.vscode, \
    'CONFIG_STATE_SUBDIR=' + c.paths.stateSubdir, \
    'CONFIG_CONVERSATIONS=' + c.paths.conversations, \
    'CONFIG_BASH_EVENTS=' + c.paths.bashEvents, \
    'CONFIG_AUTOMATION_DB=' + c.paths.automationDb, \
    'CONFIG_CANVAS_BASE_PATH=' + c.paths.canvasBasePath, \
    'CONFIG_VSCODE_BASE_PATH=' + c.paths.vscodeBasePath, \
    'CONFIG_POSTHOG_API_KEY=' + c.telemetry.posthogApiKey, \
    'CONFIG_POSTHOG_HOST=' + c.telemetry.posthogHost, \
  ]; \
  require('fs').writeFileSync('/tmp/defaults.env', lines.join('\n') + '\n'); \
"

# ── Stage 2: Combined image ──────────────────────────────────────────────────
FROM ${AGENT_SERVER_IMAGE} AS final

ARG AUTOMATION_VERSION
ARG AGENT_SERVER_VERSION
ARG AGENT_SERVER_SDK_GIT_REF=""
ARG OPENHANDS_BUILD_GIT_SHA=unknown
ARG OPENHANDS_BUILD_GIT_REF=unknown
ARG VITE_BASE_PATH="/canvas"
ARG VITE_POSTHOG_API_KEY=""

ARG AGENT_CANVAS_VERSION=dev
LABEL org.opencontainers.image.title="agent-canvas"
LABEL org.opencontainers.image.description="All-in-one agent-canvas: Agent Server + Automation + Frontend"
LABEL org.opencontainers.image.source="https://github.com/OpenHands/OpenHands"
LABEL org.opencontainers.image.version="${AGENT_CANVAS_VERSION}"
LABEL org.opencontainers.image.revision="${OPENHANDS_BUILD_GIT_SHA}"

ENV AGENT_CANVAS_BUILD_GIT_SHA=${OPENHANDS_BUILD_GIT_SHA}
ENV AGENT_CANVAS_BUILD_GIT_REF=${OPENHANDS_BUILD_GIT_REF}
ENV AGENT_CANVAS_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_POSTHOG_API_KEY=${VITE_POSTHOG_API_KEY}

USER root

# Refresh inherited packages so the final image includes available security
# fixes. asyncpg publishes wheels for the supported Python and architectures
# and implements the PostgreSQL protocol directly, so no libpq package is needed.
ARG DEBIAN_SNAPSHOT=20261114T000000Z
RUN if command -v apt-get >/dev/null 2>&1; then \
      printf '%s\n' \
        'Types: deb' \
        "URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/" \
        'Suites: trixie' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        '' \
        'Types: deb' \
        "URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/" \
        'Suites: trixie-security' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        > /etc/apt/sources.list.d/debian.sources && \
      apt-get update && \
      apt-get upgrade -y --no-install-recommends && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# Install automation server and the tool models its SDK clients deserialize.
# Match openhands-tools to the SDK already provided by the agent-server image,
# just as the local Canvas launcher does. Pin openhands-agent-server too: it
# arrives via openhands-workspace, and left unpinned the resolver downgraded it
# to dodge an openai conflict (#17531).
RUN uv pip install --system "openhands-automation==${AUTOMATION_VERSION}" "openhands-tools==${AGENT_SERVER_VERSION}" "openhands-agent-server==${AGENT_SERVER_VERSION}" 2>/dev/null \
    || pip install --no-cache-dir "openhands-automation==${AUTOMATION_VERSION}" "openhands-tools==${AGENT_SERVER_VERSION}" "openhands-agent-server==${AGENT_SERVER_VERSION}"

RUN if [ -n "${AGENT_SERVER_SDK_GIT_REF}" ]; then \
      BASE_GIT_URL="git+https://github.com/OpenHands/software-agent-sdk@${AGENT_SERVER_SDK_GIT_REF}" && \
      uv pip install --system --force-reinstall \
        "${BASE_GIT_URL}#subdirectory=openhands-sdk" \
        "${BASE_GIT_URL}#subdirectory=openhands-tools" \
        "${BASE_GIT_URL}#subdirectory=openhands-workspace"; \
    fi

# Copy the frontend build output.
# react-router.config.ts unpacks build/client/ into build/ for non-Vercel builds.
COPY --from=frontend-build /build/build /opt/agent-canvas/frontend

# Copy the static-server scripts and their production runtime deps.
COPY scripts/static-server.mjs /opt/agent-canvas/static-server.mjs
COPY scripts/bind-host.mjs /opt/agent-canvas/bind-host.mjs
COPY scripts/proxy-utils.mjs /opt/agent-canvas/proxy-utils.mjs
# static-server.mjs mounts the MARS web bridge, which pulls in these modules.
COPY scripts/http-body.mjs /opt/agent-canvas/http-body.mjs
COPY scripts/mars-web-bridge.mjs /opt/agent-canvas/mars-web-bridge.mjs
COPY scripts/mars-tunnel-bridge.mjs /opt/agent-canvas/mars-tunnel-bridge.mjs
COPY scripts/mars-api.mjs /opt/agent-canvas/mars-api.mjs
COPY scripts/mars-credentials.mjs /opt/agent-canvas/mars-credentials.mjs
COPY scripts/mars-secret-store.mjs /opt/agent-canvas/mars-secret-store.mjs
COPY scripts/mars-oauth.mjs /opt/agent-canvas/mars-oauth.mjs
COPY scripts/mars-session.mjs /opt/agent-canvas/mars-session.mjs
COPY scripts/tunnel-client.mjs /opt/agent-canvas/tunnel-client.mjs
COPY scripts/tunnel-registry.mjs /opt/agent-canvas/tunnel-registry.mjs
COPY --from=frontend-build /build/node_modules/ws /opt/agent-canvas/node_modules/ws
COPY --from=frontend-build /build/node_modules/httpxy /opt/agent-canvas/node_modules/httpxy
COPY --from=frontend-build /build/node_modules/sirv /opt/agent-canvas/node_modules/sirv
COPY --from=frontend-build /build/node_modules/@polka /opt/agent-canvas/node_modules/@polka
COPY --from=frontend-build /build/node_modules/mrmime /opt/agent-canvas/node_modules/mrmime
COPY --from=frontend-build /build/node_modules/totalist /opt/agent-canvas/node_modules/totalist
# The agent-server reads public skills from the package the frontend bundles
# (EXTENSIONS_PATH in entrypoint.sh) instead of cloning the extensions repo.
COPY --from=frontend-build /build/node_modules/@openhands/extensions /opt/agent-canvas/node_modules/@openhands/extensions

# Copy the runtime-services-info builder (entrypoint.sh runs it as a CLI to
# emit the agent's <RUNTIME_SERVICES> block; same builder the dev stack uses).
COPY scripts/runtime-services-info.mjs /opt/agent-canvas/runtime-services-info.mjs

# Optional Telegram bridge (docs/TELEGRAM.md); entrypoint.sh starts it only
# when TELEGRAM_BOT_TOKEN is set.
COPY scripts/telegram-bridge.mjs /opt/agent-canvas/telegram-bridge.mjs
COPY scripts/telegram-bridge-lib.mjs /opt/agent-canvas/telegram-bridge-lib.mjs
COPY scripts/agent-quality-lib.mjs /opt/agent-canvas/agent-quality-lib.mjs
# Built-in agent eval cases for /evals casos (docs/FEEDBACK-LOOP.md).
COPY evals/cases/ /opt/agent-canvas/evals/cases/

# Shared memory and code-graph tools for agents (docs/MEMORY.md):
#   mcp-server-qdrant  MCP server over the Qdrant service in compose.yml
#   graphify           builds a knowledge graph of a codebase (/graphify skill)
# Installed as uv tools with their own venvs; the binaries go on PATH.
ENV UV_TOOL_DIR=/opt/uv-tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    GRAPHIFY_QUERY_LOG_DISABLE=1 \
    GH_CONFIG_DIR=/home/openhands/.openhands/gh
RUN uv tool install "mcp-server-qdrant==0.8.1" && \
    uv tool install "graphifyy==0.9.108" && \
    mcp-server-qdrant --help >/dev/null && graphify --help >/dev/null
# Claude Code CLI, for `docker exec -it agent-canvas claude` → /login with a
# Pro/Max subscription (the login lands in the claude-login volume). npx in
# this image does not run the package's postinstall, which leaves its native
# binary missing, so install it globally and run the installer if needed.
# Wrangler for Cloudflare Workers/Pages work (cloudflare-wrangler skill). The
# global install brings the Linux workerd binary; a project's own node_modules
# installed on macOS would not run here.
RUN npm install -g "wrangler@4.162.0" && wrangler --version
RUN npm install -g "@anthropic-ai/claude-code@2.1.325" && \
    (claude --version >/dev/null 2>&1 || \
      node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs") && \
    claude --version && npm cache clean --force
COPY scripts/register-memory-mcp.mjs /opt/agent-canvas/register-memory-mcp.mjs
COPY scripts/register-pen-mcp.mjs /opt/agent-canvas/register-pen-mcp.mjs
COPY scripts/memory-watcher.mjs /opt/agent-canvas/memory-watcher.mjs
COPY scripts/memory-watcher-lib.mjs /opt/agent-canvas/memory-watcher-lib.mjs
COPY scripts/knowledge-lib.mjs /opt/agent-canvas/knowledge-lib.mjs
COPY scripts/knowledge-mcp.mjs /opt/agent-canvas/knowledge-mcp.mjs
# safe-branch: backed-up feature branches and a pre-commit risk check that
# agents run before pushing (change-safety-guard skill).
COPY scripts/safe-branch.mjs /opt/agent-canvas/safe-branch.mjs
COPY scripts/safe-branch-lib.mjs /opt/agent-canvas/safe-branch-lib.mjs
RUN printf '#!/bin/sh\nexec node /opt/agent-canvas/safe-branch.mjs "$@"\n' > /usr/local/bin/safe-branch && \
    chmod 755 /usr/local/bin/safe-branch
# Extra agent skills, synced into the agents' skill dirs at start.
COPY skills/ /opt/agent-canvas/skills/

# Persisted conversations created before the client_tools migration still
# import canvas_ui_tool by qualname. Keep the compatibility module available;
# new conversations define canvas_ui_control through a JSON client tool.
COPY tools/ /opt/agent-canvas/tools/

# Copy generated defaults.env (from config/defaults.json via config-gen stage)
COPY --from=config-gen /tmp/defaults.env /opt/agent-canvas/defaults.env

# Copy the entrypoint
COPY docker/entrypoint.sh /opt/agent-canvas/entrypoint.sh
# Normalize modes: COPY keeps the build host's file modes, and checkouts on
# filesystems without Unix permissions (exFAT, FAT, some network shares) report
# every file as 0700. The image runs as openhands, so root-owned 0700 files
# would be unreadable ("entrypoint.sh: Permission denied").
RUN chmod -R u=rwX,go=rX /opt/agent-canvas && \
    chmod 755 /opt/agent-canvas/entrypoint.sh

# Pre-create persistence directories with correct ownership so the
# openhands user can write to them even when Docker creates anonymous
# volumes (which default to root).
RUN mkdir -p /home/openhands/.openhands/agent-canvas/conversations \
             /home/openhands/.openhands/agent-canvas/bash_events \
             /home/openhands/.openhands/agent-canvas/workspaces \
             /home/openhands/.openhands/automation \
             /home/openhands/.claude \
             /projects && \
    chmod 755 /home/openhands && \
    chown -R openhands:openhands /home/openhands/.openhands /home/openhands/.claude /projects

USER openhands

# Keep all Claude Code state (subscription login, settings) in one directory
# so a single volume preserves a `claude` login across container recreation.
ENV CLAUDE_CONFIG_DIR=/home/openhands/.claude

# Persistence volumes:
#   /home/openhands/.openhands — settings, secrets, conversations, automation DB
#   /projects                  — user code the agent can read/edit
#   /home/openhands/.claude    — Claude Code login for the Claude Code ACP agent
# Bind-mount these for data to survive container restarts:
#   docker run -v ~/.openhands:/home/openhands/.openhands -v ~/projects:/projects ...
VOLUME ["/home/openhands/.openhands", "/projects", "/home/openhands/.claude"]

# The entrypoint starts all services and the ingress proxy.
# Port 8000 is the unified entry point.
EXPOSE 8000

ENTRYPOINT ["tini", "--", "/opt/agent-canvas/entrypoint.sh"]

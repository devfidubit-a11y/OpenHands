# Deploy Agent Canvas on another server

This packs the all-in-one image (Agent Server, Automation, Canvas UI, and the
optional [Telegram bridge](TELEGRAM.md)) on your machine and runs it on a
server with Docker Compose. The server does not need Node, Python or the source.

## 1. Build the bundle (on your machine)

```bash
npm ci
npm run docker:package                          # linux/amd64 (most VPS)
npm run docker:package -- --platform linux/arm64  # ARM servers (Graviton, Ampere)
```

Check the server's architecture with `uname -m`. `x86_64` is amd64, and
`aarch64` is arm64.

This creates `deploy-bundle/` with:

| File | What it is |
| --- | --- |
| `agent-canvas-<version>-<arch>.tar.gz` | The image |
| `qdrant-qdrant-<version>-<arch>.tar.gz` | Qdrant, for the agents' shared memory ([MEMORY.md](MEMORY.md)) |
| `compose.yml`, `.env.example` | Deployment files |
| `DEPLOY.md` | This guide |
| `IMAGE`, `SHA256SUMS` | Image tag and checksums |

Build stages that do not depend on the CPU run natively, so a cross-build from
an Apple Silicon Mac only emulates the final stage.

## 2. Copy and load it (on the server)

Requirements: Docker Engine 24+ with the Compose plugin, at least 4 GB RAM and
20 GB disk.

```bash
rsync -av deploy-bundle/ user@server:/opt/agent-canvas/
```

```bash
cd /opt/agent-canvas
sha256sum -c SHA256SUMS
for f in *.tar.gz; do docker load -i "$f"; done   # Agent Canvas, Qdrant, Docker engine
cp .env.example .env
mkdir -p projects && sudo chown 1000:1000 projects   # the container runs as uid 1000
```

Edit `.env`. At minimum set `AGENT_CANVAS_IMAGE` to the tag in `IMAGE`, and set
`PUBLIC_URL`. Leave the keys empty to have them generated and persisted.

Agents write their files to `PROJECTS_DIR` (`./projects` by default), mounted
at `/projects`. Each Canvas conversation gets its own subfolder, named after the
conversation id. Back this folder up together with the volumes.

## 3. Start it

```bash
docker compose up -d
docker compose ps          # wait until the status shows "healthy" (~1–3 min)
```

Canvas is served at `http://127.0.0.1:8000/canvas/`. With `AUTO_LOGIN=true`
(the `.env.example` default) it opens already connected to the container's own
backend, so there is no "Add a backend" step and no OpenHands Cloud sign-in.
You go straight to choosing the agent.

With `AUTO_LOGIN=false`, Canvas asks for the generated session key:

```bash
docker compose exec agent-canvas cat /home/openhands/.openhands/agent-canvas/api-key.txt
```

## 4. Expose it safely

The port is bound to **loopback** by default. Agents can run shell commands, so
never publish it unprotected.

> [!WARNING]
> Set `AUTO_LOGIN=false` before you open the port or put a public proxy in front.
> With auto-login on, anyone who can load the page gets the session key.

Put a TLS reverse proxy in front. For example, with Caddy (it gets certificates
automatically):

```
agents.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

WebSockets (`/sockets`) work through Caddy and Traefik without extra settings.
With nginx, add `proxy_http_version 1.1`, plus `Upgrade`/`Connection` headers
and `proxy_read_timeout 3600s`.

To stay private instead, use an SSH tunnel (`ssh -L 8000:127.0.0.1:8000 server`)
or a VPN such as Tailscale.

## 5. Claude and Telegram

- **Anthropic API key:** add it in Canvas → Settings → LLM, or set
  `ANTHROPIC_API_KEY` in `.env`.
- **Claude Pro/Max:** choose the Claude Code agent in Canvas, then sign in once:
  `docker compose exec -it agent-canvas claude`. Follow
  the login link, then quit. The login lives in the `claude-login` volume.
- **Telegram:** set `TELEGRAM_BOT_TOKEN`, run `docker compose up -d`, send
  `/whoami` to the bot, put the id in `TELEGRAM_ALLOWED_CHAT_IDS`, and
  `docker compose up -d` again. See [TELEGRAM.md](TELEGRAM.md).

## Memory and skills

Compose also runs Qdrant as shared memory for all agents. The image includes
Graphify and extra skills (DevOps, architecture, UX/UI, impeccable,
code-review). See [MEMORY.md](MEMORY.md).

## Operations

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Upgrade | `docker load -i <new>.tar.gz`, update `AGENT_CANVAS_IMAGE`, `docker compose up -d` |
| Back up state | `docker run --rm -v agent-canvas_openhands-state:/d -v $PWD:/b alpine tar czf /b/state.tgz -C /d .` |
| Stop | `docker compose down` (volumes are kept) |

Keep `OH_SECRET_KEY` stable. If you set it yourself and it changes, saved
settings and secrets can no longer be decrypted. When it is auto-generated, it
lives in the state volume, so back that volume up.

The container restarts on its own if it crashes (`restart: unless-stopped`). The
entrypoint exits when the Agent Server stops responding, so a hung server also
triggers a restart. The healthcheck marks the container unhealthy if `/alive`
fails. A Telegram bridge crash restarts only the bridge.

## Troubleshooting

- **`exec format error`**: the image architecture doesn't match the server.
  Rebuild with the right `--platform`.
- **Stuck in `starting`**: the first start can take a few minutes. Check
  `docker compose logs`.
- **Permission errors on `/projects`**: the container runs as uid 1000
  (`openhands`). Run `sudo chown -R 1000:1000 ./projects`.
- **Port already in use**: change `HOST_PORT` in `.env`.

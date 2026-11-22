# pen.dev (Pencil) for the agents

Agents in Docker can read and edit pen.dev designs (`.pen` files) through the
Pen app's MCP server. The frontend and UX experts use it (`pencil-design`
skill, `/design` in Telegram, and the `frontend` and `ux` experts of
`/consejo`).

```
agent (OpenHands or ACP) ─▶ agent server MCP "pencil"
   ─▶ http://host.docker.internal:8931/mcp  (scripts/pen-mcp-gateway.mjs, on the Mac)
   ─▶ Pen MCP binary (stdio, one per session) ─▶ Pen app
```

The Pen MCP server is a macOS binary that talks to the running Pen app, so it
can't run in the Linux container. The gateway runs on the Mac, starts one
MCP server per agent session, and exposes it as MCP Streamable HTTP. It has
no dependencies, listens on `127.0.0.1` only (Docker Desktop still reaches it
through `host.docker.internal`), and requires a bearer token.

## Setup

1. In `docker/.env`:

   ```
   PEN_MCP_URL=http://host.docker.internal:8931/mcp
   PEN_MCP_TOKEN=<openssl rand -hex 24>
   PEN_HOST_DOCUMENTS_DIR=/Users/<you>/Documents
   PEN_HOST_PROJECTS_DIR=/Users/<you>/OpenHands/projects
   ```

   The two `PEN_HOST_*` paths let agents translate `/documents/...` and
   `/projects/...` to the host paths the Pen app needs.

2. On the Mac, install the gateway as a LaunchAgent (starts at login,
   restarts on failure, log in `~/Library/Logs/pen-mcp-gateway.log`):

   ```bash
   scripts/install-pen-mcp-gateway.sh
   ```

   `scripts/install-pen-mcp-gateway.sh uninstall` removes it.

3. Recreate the container. On start it registers the `pencil` MCP server for
   all agents (once; after that, manage it in Agent Canvas settings).

Keep the Pen app open while agents use it. If it's closed, the tools fail and
agents report it and carry on without Pencil.

## Use

```
/dir /documents/dracma-web
/design implementa la pantalla Checkout de designs/app.pen con los tokens de Tailwind
/consejo ux, frontend, producto: mejorar el onboarding
```

`/pen` takes a photo without any agent: the bridge asks the Pen app for the
open file, exports the frames visible on the canvas (or `/pen wallet`, `/pen
<id>`; `/pen lista` lists them) as PNG into `Documents/.pen-shots/`, posts
them to the chat, and deletes the files.

Agents never read `.pen` files as text (they are encrypted), and they ask
before saving changes to an existing design file.

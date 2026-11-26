# Flutter agents and the iPhone simulator

The agents run in a Linux container, where there is no Xcode, iOS Simulator
or Flutter SDK. To work on mobile apps they use the `simulator` MCP. It runs
on the Mac, next to Xcode and Flutter, and drives the real simulators.

```
agent (container) ──MCP──▶ http://host.docker.internal:8932/mcp
                           scripts/pen-mcp-gateway.mjs   (stdio → HTTP, token)
                           └─ scripts/sim-mcp.mjs        (xcrun simctl, flutter, AXe)
```

## What the agents get

| Tool | What it does |
| --- | --- |
| `sim_list` | Simulators: name, iOS version, UDID, booted or not |
| `sim_boot` / `sim_shutdown` | Turn a simulator on (and open Simulator.app) or off |
| `flutter_run_ios` | `flutter build ios --simulator --debug` (with optional `target`, `flavor`, `dart_defines`), then install and launch the app |
| `flutter_cmd` | `pub`, `analyze`, `test` (with `integration_test -d <udid>` on the simulator), `build`, `clean`, `gen-l10n`, `doctor`, `devices`, `format`. `run` and `attach` are blocked because they are interactive. |
| `sim_screenshot` | PNG of the screen, so the agent can see its change |
| `sim_install` / `sim_launch` / `sim_terminate` | Any `.app` bundle, by path or bundle id |
| `sim_open_url` | Deep links and URLs |
| `sim_appearance` | Light or dark mode |
| `sim_logs` | Recent logs; use process `Runner` for a Flutter app |
| `sim_ui` | `describe` (accessibility tree), `tap`, `swipe`, `type`. Needs [AXe](https://github.com/cameroncooke/AXe) on the Mac. |

Paths can be the container's `/projects/...` or `/documents/...`. The MCP
maps them to the host folders from `PROJECTS_DIR` and `DOCUMENTS_DIR`, and
refuses any path outside them.

### Expert agents

- **Agent profiles** (Agent Canvas → Settings → Agent profiles, or
  `/profile flutter` in Telegram). They are created on startup if they don't
  exist; edits you make in the UI are kept.
  - `flutter`: a senior Flutter/Dart engineer. It follows the app's
    architecture and writes tests. It checks every change with
    `flutter analyze`, the tests, `flutter_run_ios` and a screenshot.
  - `mobile-qa`: a mobile QA tester. It reproduces bugs and verifies fixes
    on the simulators: happy path, errors, dark mode, large text and deep
    links.
- **Skills** for every agent, Claude Code included: `flutter-expert` and
  `ios-simulator`.
- **Telegram**:
  - `/movil <task>`, for example "/movil arregla el overflow del login y
    compruébalo en el iPhone 17".
  - `@movil` joins the council, for example `/consejo flutter, ux: …`.

## Setup (once, on the Mac)

1. Requirements: Xcode with the iOS simulators, and Flutter in your `PATH`.
   AXe is optional; it enables taps:

   ```bash
   brew install cameroncooke/axe/axe
   ```

2. In `docker/.env`:

   ```
   SIM_MCP_URL=http://host.docker.internal:8932/mcp
   SIM_MCP_TOKEN=<openssl rand -hex 24>
   ```

3. Install the gateway as a LaunchAgent. It starts at login and restarts on
   failure; its log is `~/Library/Logs/sim-mcp-gateway.log`. Run the
   installer again after installing AXe or moving Flutter.

   ```bash
   scripts/install-sim-mcp-gateway.sh
   ```

4. Recreate the container so the `simulator` MCP is registered for all
   agents:

   ```bash
   cd docker && docker compose --env-file .env up -d --force-recreate agent-canvas
   ```

`scripts/install-sim-mcp-gateway.sh uninstall` removes the gateway.

## Security

- The gateway listens on `127.0.0.1` only and requires the bearer token.
- Flutter only runs inside the shared folders, and only the allowed
  subcommands are accepted. Arguments are passed straight to the program,
  never to a shell.
- Agents are told not to erase or reset simulators and not to change Xcode,
  certificates or signing.

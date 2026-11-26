#!/usr/bin/env bash
# Install the iOS Simulator + Flutter MCP gateway as a macOS LaunchAgent, so
# agents in Docker can boot iPhone simulators, build and launch Flutter apps
# and take screenshots on this Mac (docs/MOBILE.md).
#
#   scripts/install-sim-mcp-gateway.sh            # install or update, start
#   scripts/install-sim-mcp-gateway.sh uninstall  # stop and remove
#
# Reads SIM_MCP_TOKEN (and SIM_MCP_PORT, PROJECTS_DIR, DOCUMENTS_DIR) from
# docker/.env. Runs scripts/sim-mcp.mjs behind the same stdio → HTTP gateway
# as pen.dev, copied out of the repo. Listens on 127.0.0.1 only.
set -euo pipefail

LABEL="dev.openhands.sim-mcp-gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# No spaces: the gateway splits its server arguments on whitespace.
APP_DIR="$HOME/.openhands-sim-mcp"
LOG_DIR="$HOME/Library/Logs"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO/docker/.env}"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP_DIR"
  echo "Simulator MCP gateway removed."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "macOS only (Xcode and the Simulator run here)." >&2; exit 1; }
xcrun simctl help >/dev/null 2>&1 || { echo "Xcode command line tools not found (xcode-select -p)." >&2; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH." >&2; exit 1; }
FLUTTER="$(command -v flutter || true)"
AXE="$(command -v axe || true)"

env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
TOKEN="$(env_value SIM_MCP_TOKEN)"
PORT="$(env_value SIM_MCP_PORT)"
PORT="${PORT:-8932}"
[ -n "$TOKEN" ] || { echo "Set SIM_MCP_TOKEN in $ENV_FILE first." >&2; exit 1; }

# Container folder → host folder, the same mounts as docker/compose.yml.
host_dir() {
  local value="$1" fallback="$2"
  value="${value:-$fallback}"
  case "$value" in
    /*) ;;
    ~*) value="${value/#\~/$HOME}" ;;
    *) value="$REPO/docker/$value" ;;
  esac
  (cd "$value" 2>/dev/null && pwd) || echo "$value"
}
PATH_MAP="/projects=$(host_dir "$(env_value PROJECTS_DIR)" ./projects)"
PATH_MAP="$PATH_MAP,/documents=$(host_dir "$(env_value DOCUMENTS_DIR)" ./documents)"

TOOL_PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
[ -n "$FLUTTER" ] && TOOL_PATH="$(dirname "$FLUTTER"):$TOOL_PATH"
[ -n "$AXE" ] && TOOL_PATH="$(dirname "$AXE"):$TOOL_PATH"

mkdir -p "$APP_DIR" "$(dirname "$PLIST")" "$LOG_DIR"
cp "$REPO/scripts/pen-mcp-gateway.mjs" "$APP_DIR/mcp-gateway.mjs"
cp "$REPO/scripts/sim-mcp.mjs" "$APP_DIR/sim-mcp.mjs"

umask 077
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_DIR/mcp-gateway.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PEN_MCP_BIN</key><string>$NODE</string>
    <key>PEN_MCP_ARGS</key><string>$APP_DIR/sim-mcp.mjs</string>
    <key>PEN_MCP_TOKEN</key><string>$TOKEN</string>
    <key>PEN_MCP_PORT</key><string>$PORT</string>
    <key>PEN_MCP_HOST</key><string>127.0.0.1</string>
    <key>PEN_MCP_TIMEOUT_MS</key><string>1800000</string>
    <key>SIM_MCP_PATH_MAP</key><string>$PATH_MAP</string>
    <key>PATH</key><string>$TOOL_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/sim-mcp-gateway.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/sim-mcp-gateway.log</string>
</dict>
</plist>
PLIST
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
if [ -n "$ok" ]; then
  echo "Simulator MCP gateway running on http://127.0.0.1:$PORT/mcp (log: $LOG_DIR/sim-mcp-gateway.log)"
  echo "Shared folders: $PATH_MAP"
  [ -n "$FLUTTER" ] || echo "Note: flutter not found in PATH; flutter_run_ios and flutter_cmd won't work." >&2
  [ -n "$AXE" ] || echo "Note: AXe not found; sim_ui (tap/swipe/type) needs: brew install cameroncooke/axe/axe" >&2
else
  echo "Installed, but the health check failed; see $LOG_DIR/sim-mcp-gateway.log" >&2
  exit 1
fi

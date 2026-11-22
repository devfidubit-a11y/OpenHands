#!/usr/bin/env bash
# Install the pen.dev MCP gateway as a macOS LaunchAgent, so agents in Docker
# can use the Pen app's design tools (docs/PENCIL.md).
#
#   scripts/install-pen-mcp-gateway.sh            # install or update, start
#   scripts/install-pen-mcp-gateway.sh uninstall  # stop and remove
#
# Reads PEN_MCP_TOKEN (and PEN_MCP_PORT) from docker/.env. The gateway is
# copied out of the repo, so it keeps working when the repo's disk is not
# mounted. It listens on 127.0.0.1 only.
set -euo pipefail

LABEL="dev.openhands.pen-mcp-gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_DIR="$HOME/Library/Application Support/pen-mcp-gateway"
LOG_DIR="$HOME/Library/Logs"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO/docker/.env}"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP_DIR"
  echo "pen.dev MCP gateway removed."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "macOS only (the Pen app runs here)." >&2; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH." >&2; exit 1; }

env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
TOKEN="$(env_value PEN_MCP_TOKEN)"
PORT="$(env_value PEN_MCP_PORT)"
PORT="${PORT:-8931}"
[ -n "$TOKEN" ] || { echo "Set PEN_MCP_TOKEN in $ENV_FILE first." >&2; exit 1; }

mkdir -p "$APP_DIR" "$(dirname "$PLIST")" "$LOG_DIR"
cp "$REPO/scripts/pen-mcp-gateway.mjs" "$APP_DIR/pen-mcp-gateway.mjs"

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
    <string>$APP_DIR/pen-mcp-gateway.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PEN_MCP_TOKEN</key><string>$TOKEN</string>
    <key>PEN_MCP_PORT</key><string>$PORT</string>
    <key>PEN_MCP_HOST</key><string>127.0.0.1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/pen-mcp-gateway.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/pen-mcp-gateway.log</string>
</dict>
</plist>
PLIST
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "pen.dev MCP gateway running on http://127.0.0.1:$PORT/mcp (log: $LOG_DIR/pen-mcp-gateway.log)"
else
  echo "Installed, but the health check failed; see $LOG_DIR/pen-mcp-gateway.log" >&2
  exit 1
fi

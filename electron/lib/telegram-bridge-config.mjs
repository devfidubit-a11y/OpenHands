/**
 * Telegram bridge settings for the desktop app.
 *
 * The desktop app has no .env file or container env, so the bridge reads its
 * settings from `telegram.env` in the app's userData directory (KEY=VALUE
 * lines, `#` comments). Variables already set in the app's environment take
 * precedence, so a terminal launch can still override the file. The bridge
 * only starts when TELEGRAM_BOT_TOKEN is set.
 */

export const TELEGRAM_CONFIG_FILENAME = "telegram.env";

export const TELEGRAM_CONFIG_TEMPLATE = `# Telegram bridge for OpenHands Agent Canvas (docs/TELEGRAM.md).
# Fill in TELEGRAM_BOT_TOKEN and restart the app to turn the bridge on.

# Token from @BotFather.
TELEGRAM_BOT_TOKEN=

# Chats allowed to control agents, comma-separated. Leave empty at first:
# the bot then only answers /whoami, which tells you the id to put here.
TELEGRAM_ALLOWED_CHAT_IDS=

# Optional: only these Telegram users may act, even in allowed groups.
# TELEGRAM_ALLOWED_USER_IDS=

# Optional: agent profile for new agents (default: the active profile).
# OH_AGENT_PROFILE=

# Optional: folder the agents work in.
# OH_WORKING_DIR=
`;

const ALLOWED_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_BRIDGE_POLL_MS",
  "TELEGRAM_API_BASE",
  "OH_AGENT_PROFILE",
  "OH_WORKING_DIR",
]);

/** Parse KEY=VALUE lines; ignores comments, blanks, and unknown keys. */
export function parseTelegramEnvFile(text) {
  const result = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    if (!ALLOWED_KEYS.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.at(-1) === value[0]
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Build the bridge process env, or null when no bot token is configured.
 * The stack-owned values (server URL, session key, state path) always win.
 */
export function buildTelegramBridgeEnv({
  fileEnv = {},
  processEnv = {},
  agentServerUrl,
  sessionApiKey,
  statePath,
}) {
  const merged = { ...fileEnv };
  for (const key of ALLOWED_KEYS) {
    if (processEnv[key]) merged[key] = processEnv[key];
  }
  if (!merged.TELEGRAM_BOT_TOKEN?.trim()) return null;
  return {
    ...merged,
    OH_AGENT_SERVER_URL: agentServerUrl,
    OH_SESSION_API_KEY: sessionApiKey ?? "",
    TELEGRAM_BRIDGE_STATE: statePath,
  };
}

/** Delay before the nth restart (1-based): 5 s doubling, capped at 5 min. */
export function telegramRestartDelayMs(attempt) {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 300_000);
}

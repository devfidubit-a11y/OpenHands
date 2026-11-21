import { describe, expect, it } from "vitest";

import {
  buildTelegramBridgeEnv,
  parseTelegramEnvFile,
  TELEGRAM_CONFIG_TEMPLATE,
  telegramRestartDelayMs,
} from "./telegram-bridge-config.mjs";

const stack = {
  agentServerUrl: "http://127.0.0.1:18000",
  sessionApiKey: "stack-key",
  statePath: "/data/telegram-bridge-state.json",
};

describe("parseTelegramEnvFile", () => {
  it("reads known keys, strips quotes and export, ignores the rest", () => {
    const parsed = parseTelegramEnvFile(
      [
        "# comment",
        "",
        'TELEGRAM_BOT_TOKEN="123:abc"',
        "export TELEGRAM_ALLOWED_CHAT_IDS=1,-100",
        "OH_SESSION_API_KEY=should-be-ignored",
        "not a pair",
      ].join("\r\n"),
    );

    expect(parsed).toEqual({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_ALLOWED_CHAT_IDS: "1,-100",
    });
  });

  it("treats the shipped template as unconfigured", () => {
    const fileEnv = parseTelegramEnvFile(TELEGRAM_CONFIG_TEMPLATE);

    expect(buildTelegramBridgeEnv({ fileEnv, ...stack })).toBeNull();
  });
});

describe("buildTelegramBridgeEnv", () => {
  it("lets the app environment override the file, and the stack override both", () => {
    const env = buildTelegramBridgeEnv({
      fileEnv: { TELEGRAM_BOT_TOKEN: "file-token", OH_WORKING_DIR: "/w" },
      processEnv: { TELEGRAM_BOT_TOKEN: "env-token", PATH: "/bin" },
      ...stack,
    });

    expect(env).toEqual({
      TELEGRAM_BOT_TOKEN: "env-token",
      OH_WORKING_DIR: "/w",
      OH_AGENT_SERVER_URL: stack.agentServerUrl,
      OH_SESSION_API_KEY: stack.sessionApiKey,
      TELEGRAM_BRIDGE_STATE: stack.statePath,
    });
  });
});

describe("telegramRestartDelayMs", () => {
  it("backs off from 5 s and caps at 5 minutes", () => {
    expect([1, 2, 3, 20].map(telegramRestartDelayMs)).toEqual([
      5_000, 10_000, 20_000, 300_000,
    ]);
  });
});

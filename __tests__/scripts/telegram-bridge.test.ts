import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentServerClient,
  BridgeState,
  chunkText,
  isAuthorized,
  loadConfig,
  parseMessage,
  parseNewArgs,
  statusTransition,
} from "../../scripts/telegram-bridge-lib.mjs";

describe("telegram bridge config", () => {
  it("requires a bot token", () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("starts in setup mode with an empty allowlist, authorizing nobody", () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "t" });

    expect(config.allowedChats.size).toBe(0);
    expect(isAuthorized(config, 123, 1)).toBe(false);
  });

  it("authorizes listed chats and, when set, only listed users", () => {
    const chatsOnly = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWED_CHAT_IDS: "-100, 42",
    });
    const withUsers = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWED_CHAT_IDS: "-100",
      TELEGRAM_ALLOWED_USER_IDS: "7",
    });

    expect(isAuthorized(chatsOnly, -100, 999)).toBe(true);
    expect(isAuthorized(chatsOnly, 5, 999)).toBe(false);
    expect(isAuthorized(withUsers, -100, 7)).toBe(true);
    expect(isAuthorized(withUsers, -100, 8)).toBe(false);
  });

  it("strips a trailing slash from the agent-server URL", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      OH_AGENT_SERVER_URL: "http://host:18000/",
    });

    expect(config.agentServerUrl).toBe("http://host:18000");
  });
});

describe("parseMessage", () => {
  it("parses commands, including group-style /cmd@Bot", () => {
    expect(parseMessage("/new@MyBot fix the tests")).toEqual({
      kind: "command",
      command: "new",
      args: "fix the tests",
    });
    expect(parseMessage("/agents")).toEqual({
      kind: "command",
      command: "agents",
      args: "",
    });
  });

  it("parses messages addressed to an agent", () => {
    expect(parseMessage("@Front: use tailwind")).toEqual({
      kind: "addressed",
      agent: "front",
      text: "use tailwind",
    });
  });

  it("treats everything else as plain text", () => {
    expect(parseMessage("  hola  ")).toEqual({ kind: "text", text: "hola" });
  });
});

describe("parseNewArgs", () => {
  it("extracts an optional @name before the task", () => {
    expect(parseNewArgs("@api add pagination")).toEqual({
      name: "api",
      task: "add pagination",
    });
    expect(parseNewArgs("add pagination")).toEqual({
      name: null,
      task: "add pagination",
    });
  });

  it("flags names Telegram users cannot address", () => {
    expect(parseNewArgs("@bad.name do it").invalidName).toBe("bad.name");
  });
});

describe("chunkText", () => {
  it("keeps short text whole and splits long text under the limit", () => {
    expect(chunkText("short")).toEqual(["short"]);

    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkText(long, 500);

    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join("\n")).toBe(long);
  });
});

describe("statusTransition", () => {
  it("reports completion only after the agent was working", () => {
    expect(statusTransition("running", "finished")).toBe("done");
    expect(statusTransition("pending", "idle")).toBe("done");
    expect(statusTransition("idle", "idle")).toBeNull();
    expect(statusTransition("finished", "idle")).toBeNull();
  });

  it("reports confirmation requests and problems", () => {
    expect(statusTransition("running", "waiting_for_confirmation")).toBe(
      "confirm",
    );
    expect(statusTransition("running", "error")).toBe("problem");
    expect(statusTransition("running", "stuck")).toBe("problem");
  });
});

describe("BridgeState", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("tracks agents per chat, names them uniquely and finds them by name, index or id", () => {
    const state = new BridgeState();

    const first = state.addAgent(1, { id: "aaaa1111", name: null });
    const second = state.addAgent(1, { id: "bbbb2222", name: "api" });
    const third = state.addAgent(1, { id: "cccc3333", name: "api" });

    expect([first, second, third]).toEqual(["agente1", "api", "api-2"]);
    expect(state.activeAgent(1)?.id).toBe("cccc3333");
    expect(state.findAgent(1, "@api")?.id).toBe("bbbb2222");
    expect(state.findAgent(1, "1")?.id).toBe("aaaa1111");
    expect(state.findAgent(1, "cccc")?.id).toBe("cccc3333");
    expect(state.findAgent(2, "api")).toBeNull();
  });

  it("routes replies to the agent that sent the message and falls back on removal", () => {
    const state = new BridgeState();
    state.addAgent(1, { id: "a", name: "one" });
    state.addAgent(1, { id: "b", name: "two" });
    state.rememberMessage(1, 50, "a");

    expect(state.agentForReply(1, 50)?.name).toBe("one");

    state.removeAgent(1, "b");
    expect(state.activeAgent(1)?.id).toBe("a");
  });

  it("persists and reloads", () => {
    dir = mkdtempSync(join(tmpdir(), "tg-bridge-"));
    const path = join(dir, "state.json");
    const state = new BridgeState();
    state.offset = 9;
    state.addAgent(-100, { id: "x", name: "w" });

    state.save(path);
    const loaded = BridgeState.load(path);

    expect(loaded.offset).toBe(9);
    expect(loaded.findAgent(-100, "w")?.id).toBe("x");
    expect(BridgeState.load(join(dir, "missing.json")).offset).toBe(0);
  });
});

describe("AgentServerClient", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("starts a conversation from an Agent Profile with the session key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ id: "conv-1" }));
    const client = new AgentServerClient({
      baseUrl: "http://srv",
      sessionApiKey: "secret",
      fetchImpl,
    });

    const result = await client.createConversation({
      profileId: "p1",
      task: "do it",
      workingDir: "workspace/project",
      chatId: -100,
    });

    expect(result.id).toBe("conv-1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://srv/api/conversations");
    expect(init.headers["X-Session-API-Key"]).toBe("secret");
    expect(JSON.parse(init.body)).toMatchObject({
      agent_profile_id: "p1",
      workspace: { working_dir: "workspace/project" },
      initial_message: {
        role: "user",
        content: [{ type: "text", text: "do it" }],
        run: true,
      },
      tags: { source: "telegram", telegramchat: "-100" },
    });
  });

  it("resolves profiles by name, falling back to the active profile", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      ok({
        active_agent_profile_id: "id-b",
        profiles: [
          { id: "id-a", name: "Claude Code" },
          { id: "id-b", name: "OpenHands" },
        ],
      }),
    );
    const client = new AgentServerClient({
      baseUrl: "http://srv",
      sessionApiKey: null,
      fetchImpl,
    });

    expect(await client.resolveProfileId("claude code")).toBe("id-a");
    expect(await client.resolveProfileId(null)).toBe("id-b");
    expect(await client.resolveProfileId("nope")).toBeNull();
  });

  it("surfaces HTTP errors with the status code", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    const client = new AgentServerClient({
      baseUrl: "http://srv",
      sessionApiKey: null,
      fetchImpl,
    });

    await expect(client.getConversation("c")).rejects.toThrow(/HTTP 500/);
  });
});

/**
 * Telegram ↔ Agent Server bridge — building blocks.
 *
 * Lets a Telegram chat (private or group) start, address and supervise
 * several OpenHands agent conversations, the way a Slack channel is used to
 * coordinate agents. Everything here talks to the public Agent Server REST
 * API (the same one Canvas uses) and the Telegram Bot API over `fetch`; no
 * extra dependencies. `scripts/telegram-bridge.mjs` wires it together.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TELEGRAM_MAX_MESSAGE = 4096;
export const DEFAULT_AGENT_SERVER_URL = "http://127.0.0.1:18000";
// Mirrors DEFAULT_WORKING_DIR in src/api/agent-server-config.ts.
export const DEFAULT_WORKING_DIR = "workspace/project";

/** Statuses after which the agent is waiting for the humans in the chat. */
const SETTLED_STATUSES = new Set(["idle", "finished", "paused"]);
const PROBLEM_STATUSES = new Set(["error", "stuck"]);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function parseIdList(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Reads the bridge configuration from environment variables. Throws with a
 * readable message when a required value is missing.
 */
export function loadConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather).",
    );
  }
  // Empty allowlist = setup mode: the bot only answers /whoami so you can
  // learn the chat id to put in TELEGRAM_ALLOWED_CHAT_IDS.
  const allowedChats = parseIdList(env.TELEGRAM_ALLOWED_CHAT_IDS);
  const pollMs = Number(env.TELEGRAM_BRIDGE_POLL_MS ?? 4000);
  return {
    token,
    allowedChats,
    allowedUsers: parseIdList(env.TELEGRAM_ALLOWED_USER_IDS),
    agentServerUrl: (
      env.OH_AGENT_SERVER_URL?.trim() || DEFAULT_AGENT_SERVER_URL
    ).replace(/\/+$/, ""),
    sessionApiKey:
      env.OH_SESSION_API_KEY?.trim() || env.SESSION_API_KEY?.trim() || null,
    defaultProfile: env.OH_AGENT_PROFILE?.trim() || null,
    workingDir: env.OH_WORKING_DIR?.trim() || DEFAULT_WORKING_DIR,
    statePath:
      env.TELEGRAM_BRIDGE_STATE?.trim() || ".telegram-bridge-state.json",
    telegramApiBase: (
      env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org"
    ).replace(/\/+$/, ""),
    pollMs: Number.isFinite(pollMs) && pollMs >= 1000 ? pollMs : 4000,
  };
}

/** Whether a Telegram update author may drive agents. */
export function isAuthorized(config, chatId, userId) {
  if (!config.allowedChats.has(String(chatId))) return false;
  if (config.allowedUsers.size === 0) return true;
  return userId != null && config.allowedUsers.has(String(userId));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses an incoming chat text into an intent.
 *
 * - `/cmd@BotName args` → `{ kind: "command", command, args }`
 * - `@agent message`    → `{ kind: "addressed", agent, text }`
 * - anything else        → `{ kind: "text", text }`
 */
export function parseMessage(text) {
  const trimmed = String(text ?? "").trim();
  const command = /^\/([a-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (command) {
    return {
      kind: "command",
      command: command[1].toLowerCase(),
      args: (command[2] ?? "").trim(),
    };
  }
  const addressed = /^@([a-z0-9][a-z0-9_-]{0,31})[\s:,]+([\s\S]+)$/i.exec(
    trimmed,
  );
  if (addressed) {
    return {
      kind: "addressed",
      agent: addressed[1].toLowerCase(),
      text: addressed[2].trim(),
    };
  }
  return { kind: "text", text: trimmed };
}

/**
 * Splits `/new` arguments into an optional `@name` and the task text.
 * `"@front build the login page"` → `{ name: "front", task: "build…" }`.
 */
export function parseNewArgs(args) {
  const match = /^@([^\s]+)\s*([\s\S]*)$/.exec(args.trim());
  if (!match) return { name: null, task: args.trim() };
  const name = match[1].toLowerCase();
  if (!NAME_RE.test(name))
    return { name: null, task: args.trim(), invalidName: name };
  return { name, task: match[2].trim() };
}

/** Splits text into Telegram-sized chunks, preferring line boundaries. */
export function chunkText(text, size = TELEGRAM_MAX_MESSAGE) {
  const value = String(text ?? "");
  if (value.length <= size) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const MESSAGE_MAP_LIMIT = 1000;

/**
 * Persistent bridge state: Telegram update offset, the agents each chat runs,
 * and which Telegram message came from which agent (so a reply routes back).
 */
export class BridgeState {
  constructor(data = {}) {
    this.offset = data.offset ?? 0;
    this.chats = data.chats ?? {};
    this.messageMap = data.messageMap ?? {};
  }

  static load(path) {
    try {
      return new BridgeState(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return new BridgeState();
    }
  }

  save(path) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  toJSON() {
    return {
      offset: this.offset,
      chats: this.chats,
      messageMap: this.messageMap,
    };
  }

  chat(chatId) {
    const key = String(chatId);
    this.chats[key] ??= { active: null, profile: null, agents: [] };
    return this.chats[key];
  }

  /** Registers a new agent for the chat and makes it active. */
  addAgent(chatId, { id, name }) {
    const chat = this.chat(chatId);
    const agentName = this.uniqueName(
      chatId,
      name ?? `agente${chat.agents.length + 1}`,
    );
    chat.agents.push({ id, name: agentName, lastStatus: "pending" });
    chat.active = id;
    return agentName;
  }

  uniqueName(chatId, base) {
    const taken = new Set(this.chat(chatId).agents.map((agent) => agent.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  /** Finds an agent by name, 1-based list index, or conversation id prefix. */
  findAgent(chatId, ref) {
    const agents = this.chat(chatId).agents;
    const needle = String(ref ?? "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    if (!needle) return null;
    if (
      /^\d+$/.test(needle) &&
      Number(needle) >= 1 &&
      Number(needle) <= agents.length
    ) {
      return agents[Number(needle) - 1];
    }
    return (
      agents.find((agent) => agent.name === needle) ??
      agents.find((agent) => agent.id.toLowerCase().startsWith(needle)) ??
      null
    );
  }

  activeAgent(chatId) {
    const chat = this.chat(chatId);
    return chat.agents.find((agent) => agent.id === chat.active) ?? null;
  }

  removeAgent(chatId, id) {
    const chat = this.chat(chatId);
    chat.agents = chat.agents.filter((agent) => agent.id !== id);
    if (chat.active === id) chat.active = chat.agents.at(-1)?.id ?? null;
  }

  rememberMessage(chatId, messageId, conversationId) {
    this.messageMap[`${chatId}:${messageId}`] = conversationId;
    const keys = Object.keys(this.messageMap);
    for (const key of keys.slice(
      0,
      Math.max(0, keys.length - MESSAGE_MAP_LIMIT),
    )) {
      delete this.messageMap[key];
    }
  }

  agentForReply(chatId, messageId) {
    const id = this.messageMap[`${chatId}:${messageId}`];
    if (!id) return null;
    return this.chat(chatId).agents.find((agent) => agent.id === id) ?? null;
  }
}

/**
 * Decides what to tell the chat when an agent's execution status changes.
 * Returns `null` when nothing should be posted.
 */
export function statusTransition(previous, next) {
  if (!next || previous === next) return null;
  if (next === "waiting_for_confirmation") return "confirm";
  if (PROBLEM_STATUSES.has(next)) return "problem";
  if (
    SETTLED_STATUSES.has(next) &&
    (previous === "running" || previous === "pending")
  ) {
    return "done";
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------

async function readJson(response, what) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${what} failed: HTTP ${response.status} ${body.slice(0, 300)}`,
    );
  }
  return body ? JSON.parse(body) : null;
}

/** Minimal Agent Server REST client (see the OpenAPI contract). */
export class AgentServerClient {
  constructor({ baseUrl, sessionApiKey, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.sessionApiKey = sessionApiKey;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.sessionApiKey) headers["X-Session-API-Key"] = this.sessionApiKey;
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return readJson(response, `${method} ${path}`);
  }

  listProfiles() {
    return this.request("GET", "/api/agent-profiles");
  }

  /**
   * Resolves a profile reference (id or name) to its id; with no reference,
   * the server's active Agent Profile.
   */
  async resolveProfileId(ref) {
    const { profiles = [], active_agent_profile_id: activeId } =
      await this.listProfiles();
    if (!ref) return activeId ?? profiles[0]?.id ?? profiles[0]?.name ?? null;
    const lower = ref.toLowerCase();
    const match = profiles.find(
      (profile) => profile.id === ref || profile.name?.toLowerCase() === lower,
    );
    return match ? (match.id ?? match.name) : null;
  }

  createConversation({ profileId, task, workingDir, chatId }) {
    return this.request("POST", "/api/conversations", {
      agent_profile_id: profileId,
      workspace: { kind: "LocalWorkspace", working_dir: workingDir },
      initial_message: {
        role: "user",
        content: [{ type: "text", text: task }],
        run: true,
      },
      tags: { source: "telegram", telegramchat: String(chatId) },
    });
  }

  sendMessage(id, text) {
    return this.request("POST", `/api/conversations/${id}/events`, {
      role: "user",
      content: [{ type: "text", text }],
      run: true,
    });
  }

  getConversation(id) {
    return this.request("GET", `/api/conversations/${id}`);
  }

  async finalResponse(id) {
    const result = await this.request(
      "GET",
      `/api/conversations/${id}/agent_final_response`,
    );
    return result?.response ?? "";
  }

  pause(id) {
    return this.request("POST", `/api/conversations/${id}/pause`);
  }

  respondToConfirmation(id, accept, reason) {
    return this.request(
      "POST",
      `/api/conversations/${id}/events/respond_to_confirmation`,
      {
        accept,
        ...(reason ? { reason } : {}),
      },
    );
  }
}

/** Minimal Telegram Bot API client (long polling). */
export class TelegramClient {
  constructor({
    token,
    apiBase = "https://api.telegram.org",
    fetchImpl = fetch,
  }) {
    this.base = `${apiBase}/bot${token}`;
    this.fetch = fetchImpl;
  }

  async call(method, params) {
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params ?? {}),
    });
    const data = await response.json();
    if (!data.ok)
      throw new Error(`Telegram ${method} failed: ${data.description}`);
    return data.result;
  }

  getUpdates(offset, timeout = 30) {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
  }

  /** Sends text (chunked), returning the sent messages. */
  async sendText(chatId, text, extra = {}) {
    const sent = [];
    const chunks = chunkText(text);
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      sent.push(
        await this.call("sendMessage", {
          chat_id: chatId,
          text: chunk,
          link_preview_options: { is_disabled: true },
          ...(index === 0 && extra.replyTo
            ? { reply_parameters: { message_id: extra.replyTo } }
            : {}),
          ...(isLast && extra.keyboard
            ? { reply_markup: { inline_keyboard: extra.keyboard } }
            : {}),
        }),
      );
    }
    return sent;
  }

  answerCallback(id, text) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  setCommands(commands) {
    return this.call("setMyCommands", { commands });
  }
}

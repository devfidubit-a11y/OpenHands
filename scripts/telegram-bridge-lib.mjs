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
  // Minutes between "still working" notices; 0 turns them off.
  const progressMin = Number(env.TELEGRAM_PROGRESS_MINUTES ?? 3);
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
    progressMs:
      Number.isFinite(progressMin) && progressMin >= 0
        ? progressMin * 60_000
        : 180_000,
    // Time zone for /schedule and /bot times ("lunes 09:00").
    timeZone: validTimeZone(env.TELEGRAM_TIMEZONE?.trim() || env.TZ?.trim()),
    // pen.dev MCP gateway for /pen screenshots (docs/PENCIL.md).
    penMcpUrl: env.PEN_MCP_URL?.trim() || "",
    penMcpToken: env.PEN_MCP_TOKEN?.trim() || "",
    // agent_chat MCP server (loopback) that lets agents talk while they work.
    // 0 turns it off.
    chatMcpPort: Number(env.TELEGRAM_CHAT_MCP_PORT ?? 18790),
  };
}

/**
 * A scope is one conversation space of the bridge: a chat, or one topic of a
 * forum group ("<chatId>:<threadId>"). Each scope has its own agents,
 * coordinator, folder, project, schedules and councils.
 */
export function scopeKey(chatId, threadId = null) {
  return threadId ? `${chatId}:${threadId}` : String(chatId);
}

export function splitScope(key) {
  const [chatId, threadId] = String(key).split(":");
  return { chatId, threadId: threadId ? Number(threadId) : null };
}

/** The scope of an incoming message (its topic in a forum group). */
export function scopeOf(message) {
  const thread =
    message?.chat?.is_forum && message.is_topic_message
      ? message.message_thread_id
      : null;
  return scopeKey(message?.chat?.id, thread);
}

/** Whether a Telegram update author may drive agents. */
export function isAuthorized(config, chatId, userId) {
  if (!config.allowedChats.has(splitScope(chatId).chatId)) return false;
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
    this.botId = data.botId ?? null;
    this.offset = data.offset ?? 0;
    this.chats = data.chats ?? {};
    this.messageMap = data.messageMap ?? {};
    // Named projects: { name: { dir, createdAt } }, shared by all scopes.
    this.projects = data.projects ?? {};
    // Group ids Telegram migrated (group → supergroup): { oldId: newId }.
    this.migrations = data.migrations ?? {};
    // Bearer token of the agent_chat MCP server (generated once).
    this.chatMcpToken = data.chatMcpToken ?? null;
  }

  /**
   * A group became a supergroup (needed for topics) and got a new id: move
   * its scopes and remember the new id. Returns the number of scopes moved.
   */
  migrateChat(oldId, newId) {
    const from = String(oldId);
    const to = String(newId);
    let moved = 0;
    for (const key of Object.keys(this.chats)) {
      const { chatId, threadId } = splitScope(key);
      if (chatId !== from) continue;
      const target = scopeKey(to, threadId);
      this.chats[target] ??= this.chats[key];
      delete this.chats[key];
      moved += 1;
    }
    this.migrations[from] = to;
    return moved;
  }

  /**
   * Record which bot this state belongs to. When the token now belongs to a
   * different bot (or the state predates bot tracking), the update offset and
   * message→agent map (both per bot) are reset; the chats and their agents
   * are kept. Returns true when it reset.
   */
  switchBot(botId) {
    // A state without botId predates bot tracking: its offset may belong to
    // another bot. Resetting is safe because Telegram never re-sends updates
    // already confirmed by an earlier getUpdates.
    const switched =
      this.botId !== botId && (this.botId != null || this.offset > 0);
    if (switched) {
      this.offset = 0;
      this.messageMap = {};
    }
    this.botId = botId;
    return switched;
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
      botId: this.botId,
      offset: this.offset,
      chats: this.chats,
      messageMap: this.messageMap,
      projects: this.projects,
      migrations: this.migrations,
      chatMcpToken: this.chatMcpToken,
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

// ---------------------------------------------------------------------------
// Teams: a lead agent plans, the bridge hands subtasks to sub-agents.
// ---------------------------------------------------------------------------

export const MAX_TEAM_SIZE = 6;
const ASSIGNMENT_RE =
  /^\s*(?:[-*•]|\d+[.)])?\s*@([a-z0-9][a-z0-9_-]{0,31})\s*(?::|-|—|–)?\s+(\S[\s\S]*)$/i;

/**
 * Parse task assignments, one per line: `@name: task` (also `- @name task`,
 * `1. @name — task`). Assignments are read from the largest block of
 * consecutive assignment lines (blank lines allowed; the last block wins a
 * tie), so a stray `@mention` in the prose before a plan is not picked up.
 * A name used twice keeps its first task. Returns [{ name, task }].
 */
export function parseAssignments(text, max = MAX_TEAM_SIZE) {
  const groups = [];
  let current = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = ASSIGNMENT_RE.exec(line.replace(/\*\*|`/g, ""));
    if (match) {
      current.push({ name: match[1].toLowerCase(), task: match[2].trim() });
    } else if (current.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  const block = groups.reduce(
    (best, group) => (group.length >= best.length ? group : best),
    [],
  );
  const seen = new Set();
  const result = [];
  for (const { name, task } of block) {
    if (!task || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, task });
    if (result.length >= max) break;
  }
  return result;
}

/** Instructions for the lead agent of `/team`. */
export function buildLeadPrompt(task, max = MAX_TEAM_SIZE) {
  return [
    "You are the lead of a small team of AI agents coordinated from Telegram.",
    "Study the project and the request below, then split the work into at most",
    `${max} independent subtasks that different agents can do in parallel`,
    "without editing the same files. Do not do the work yourself yet.",
    "",
    "End your answer with the plan, one line per subtask, exactly like:",
    "@short-name: what this agent must do, which files or area, and what done looks like",
    "",
    "Names: lowercase letters, digits, - or _. If the work is too small to split,",
    "give a single line.",
    "",
    "Before the plan, list anything the work would delete, replace, or touch in",
    "data, secrets, auth, payments, infra or dependencies (change-safety-guard",
    "skill), so the user can approve it before distributing.",
    "",
    `Request: ${task}`,
  ].join("\n");
}

export const MAX_AUTO_ROUNDS = 3;

/**
 * Message for the chat's coordinator in automatic mode: answer small things
 * directly, or plan with `@name: task` lines that the bridge turns into
 * sub-agents on its own.
 */
export function buildCoordinatorPrompt(
  request,
  { workingDir = "", max = MAX_TEAM_SIZE } = {},
) {
  return [
    "You are the coordinator of a team of AI agents. The user talks to you from",
    "Telegram; the bridge creates and runs the agents you assign.",
    "Talk like a teammate in a chat: answer in the user's language, short and",
    "warm, no headings or long reports for small talk or quick questions.",
    workingDir ? `Working folder: ${workingDir}` : "",
    "",
    "- If the request is a question, a small task, or a status check, do it or",
    "  answer it yourself. Do not write any @name lines.",
    `- If it is bigger work, study the project and split it into at most ${max}`,
    "  independent subtasks that agents can do in parallel without editing the",
    "  same files. End your answer with the plan, one line per subtask:",
    "  @short-name: what to do, which files or area, and what done looks like",
    "  When code changes, include a QA agent (qa-testing skill) for the tests",
    "  that fit: unit, integration, API/route handlers, component, E2E, smoke,",
    "  snapshot, visual regression, performance and Core Web Vitals.",
    "  The bridge creates those agents immediately and sends you their reports",
    "  when they finish. Reusing a name sends that agent a follow-up.",
    "- You are in a group chat: if the message is people talking to each other",
    "  and nobody needs anything from the team, reply exactly NOOP (nothing else).",
    "- When the user asks to ship or open a PR, follow the ship steps: branch,",
    "  small commits, safe-branch check, push, gh pr create, self-review, CI green.",
    "  Never merge the PR yourself.",
    "- Follow the change-safety-guard skill: if the work would delete, replace,",
    "  or touch data, secrets, auth, payments, infra or dependencies, ask the user",
    "  first and do not assign it until they agree.",
    "",
    `User request: ${request}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** kebab-case slug for branch names: "Add a contact form!" → "add-contact-form". */
export function slugify(text, maxWords = 4) {
  const words = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(
      (w) =>
        w &&
        !["a", "an", "the", "de", "la", "el", "un", "una", "y", "and"].includes(
          w,
        ),
    );
  return words.slice(0, maxWords).join("-") || "feature";
}

/** First message for a sub-agent created from a team plan. */
export function buildMemberPrompt({ name, lead, goal, subtask }) {
  const branch = `feat/${slugify(goal)}-${name}`;
  return [
    `You are @${name}, a member of a team led by @${lead}, coordinated from Telegram.`,
    goal ? `Team goal: ${goal}` : "",
    `Your subtask: ${subtask}`,
    "",
    "Only change what your subtask needs; other agents work on the rest in",
    "parallel. Use the expert skills that fit your subtask (senior-frontend,",
    "senior-backend, component-design-patterns, pencil-design (pen.dev designs",
    "through the pencil MCP), ux-ui-storytelling, ui-design,",
    "ux-design, qa-testing, cloudflare-wrangler, docker-containers, senior-devops,",
    "senior-architect, flutter-expert and ios-simulator for mobile work on the",
    "iPhone simulator), and add or update tests for what you change. Check",
    "library APIs for the project's version with the context7 MCP.",
    "",
    "Follow the change-safety-guard skill: never delete, overwrite or touch",
    "secrets, data or infra without the user's consent; ask first.",
    "",
    "If the folder is a git repository, follow the feature-branch-pr skill:",
    `start with \`safe-branch start ${branch.slice(5)} --worktree\` (your own`,
    `worktree on ${branch}), commit with conventional messages, run`,
    "`safe-branch check` before pushing, then push and open a draft pull",
    "request. Never commit to the default branch.",
    "",
    "When you finish, reply with a short summary of what you changed, the",
    "branch and PR link, and anything the lead must know.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Message asking the lead to integrate the team's results. */
export function buildIntegrationPrompt(
  results,
  goal = "",
  { followUp = false } = {},
) {
  return [
    "Your team finished. Here is what each agent reported:",
    "",
    ...results.map(
      ({ name, response }) => `@${name}:\n${response || "(no answer)"}\n`,
    ),
    "Review each branch or pull request with the feature-branch-pr skill.",
    `Integrate them on one feature branch (feat/${slugify(goal)}) created from the`,
    "default branch: merge the members' branches, resolve conflicts, and run",
    "lint, type check, tests and `safe-branch check`. If the check reports",
    "items that need consent, stop and ask the user before pushing. Otherwise",
    "push it and open one pull request that",
    "describes the whole feature addition and links the members' PRs. Do not",
    "merge into the default branch. Reply with a final summary for the user",
    "and the PR link.",
    ...(followUp
      ? [
          "",
          "If something is still missing, assign it with @name: task lines",
          "(an existing name gets a follow-up). Otherwise write no @name lines.",
        ]
      : []),
  ].join("\n");
}

const DONE_STATUSES = new Set(["finished", "idle"]);
const FAILED_STATUSES = new Set(["error", "stuck"]);

/**
 * True once every member of the lead's team has stopped working. A member
 * counts as done only after it was seen running (a new conversation can
 * report idle before it starts), or when it failed.
 */
export function teamDone(agents, leadId) {
  const members = agents.filter((agent) => agent.team === leadId);
  return (
    members.length > 0 &&
    members.every(
      (agent) =>
        FAILED_STATUSES.has(agent.lastStatus) ||
        (agent.seenRunning && DONE_STATUSES.has(agent.lastStatus)),
    )
  );
}

/** Normalize a `/dir` argument: absolute path without trailing slashes. */
export function parseWorkingDir(args) {
  const value = String(args ?? "").trim();
  if (!value.startsWith("/") || value.includes("\0")) return null;
  const clean = value.replace(/\/+$/, "") || "/";
  if (clean.split("/").includes("..")) return null;
  return clean;
}

const STEP_KINDS = {
  execute: "ejecutando un comando",
  read: "leyendo archivos",
  edit: "editando archivos",
  delete: "borrando archivos",
  move: "moviendo archivos",
  search: "buscando en el código",
  fetch: "consultando la web",
  think: "pensando",
  switch_mode: "cambiando de modo",
  other: "trabajando",
};
const TOOL_NAMES = [
  [/terminal|bash|execute|cmd/i, "ejecutando un comando"],
  [/edit|write|str_replace|file_editor/i, "editando archivos"],
  [/read|view|cat/i, "leyendo archivos"],
  [/grep|glob|search|find/i, "buscando en el código"],
  [/browse|fetch|web/i, "consultando la web"],
  [/think/i, "pensando"],
  [/task|delegate/i, "delegando en un subagente"],
];

/**
 * What an agent's latest step is doing, from its last tool event, without
 * any command text or arguments (they can hold secrets). "" when unknown.
 */
export function describeStep(event) {
  if (!event) return "";
  if (event.tool_kind) return STEP_KINDS[event.tool_kind] ?? STEP_KINDS.other;
  const tool = String(event.tool_name ?? event.action?.kind ?? "");
  for (const [re, label] of TOOL_NAMES) if (re.test(tool)) return label;
  return tool ? "trabajando" : "";
}

/** "3 min", "1 h 5 min" from milliseconds. */
export function formatElapsed(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A short, actionable explanation for a conversation error, in Spanish. */
export function explainError(error) {
  if (!error) return "";
  const code = String(error.code ?? "");
  const detail = String(error.detail ?? "").slice(0, 300);
  if (/auth/i.test(code) || /authentication required/i.test(detail)) {
    return (
      "El agente no tiene credenciales. Para Claude Code, inicia sesión una vez:\n" +
      "docker exec -it agent-canvas claude  → /login\n" +
      "o usa /profile default con una clave de API en Canvas."
    );
  }
  return `Error: ${code}${detail ? ` — ${detail}` : ""}`;
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

  createConversation({ profileId, task, workingDir, chatId, project = null }) {
    return this.request("POST", "/api/conversations", {
      agent_profile_id: profileId,
      workspace: { kind: "LocalWorkspace", working_dir: workingDir },
      initial_message: {
        role: "user",
        content: [{ type: "text", text: task }],
        run: true,
      },
      tags: {
        source: "telegram",
        telegramchat: String(chatId),
        ...(project ? { project } : {}),
      },
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

  /** The latest tool step (ACP tool call or OpenHands action), or null. */
  async lastStep(id) {
    for (const kind of ["ACPToolCallEvent", "ActionEvent"]) {
      const page = await this.request(
        "GET",
        `/api/conversations/${id}/events/search?kind=${kind}&sort_order=TIMESTAMP_DESC&limit=1`,
      );
      if (page?.items?.[0]) return page.items[0];
    }
    return null;
  }

  /** One page of a conversation's events, oldest first. */
  listEvents(id, { limit = 100, pageId = null } = {}) {
    const query = new URLSearchParams({
      limit: String(limit),
      sort_order: "TIMESTAMP",
    });
    if (pageId) query.set("page_id", pageId);
    return this.request(
      "GET",
      `/api/conversations/${id}/events/search?${query}`,
    );
  }

  /** The conversation's most recent error event, or null. */
  async lastError(id) {
    const page = await this.request(
      "GET",
      `/api/conversations/${id}/events/search?kind=ConversationErrorEvent&sort_order=TIMESTAMP_DESC&limit=1`,
    );
    const event = page?.items?.[0];
    return event
      ? { code: event.code ?? "", detail: event.detail ?? "" }
      : null;
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

  /** Downloads a file sent to the bot (Bot API limit: 20 MB). */
  async downloadFile(fileId) {
    const file = await this.call("getFile", { file_id: fileId });
    if (!file?.file_path) throw new Error("Telegram no devolvió el archivo");
    const url = `${this.base.replace(/\/bot([^/]+)$/, "/file/bot$1")}/${file.file_path}`;
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`descarga: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
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
  async sendText(scope, text, extra = {}) {
    const { chatId, threadId } = splitScope(scope);
    const sent = [];
    const chunks = chunkText(text);
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      sent.push(
        await this.call("sendMessage", {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
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

  /**
   * Sends an image (Buffer) as a photo, or as a file when `asDocument` (no
   * recompression, for large or very tall designs).
   */
  async sendPhoto(
    scope,
    data,
    { caption = "", filename = "image.png", asDocument = false } = {},
  ) {
    const method = asDocument ? "sendDocument" : "sendPhoto";
    const { chatId, threadId } = splitScope(scope);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (threadId) form.append("message_thread_id", String(threadId));
    if (caption) form.append("caption", caption.slice(0, 1024));
    form.append(
      asDocument ? "document" : "photo",
      new Blob([data], { type: "image/png" }),
      filename,
    );
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!result.ok)
      throw new Error(`Telegram ${method} failed: ${result.description}`);
    return result.result;
  }

  /** Shows "typing…" in the chat (or topic) for a few seconds. */
  sendChatAction(scope, action = "typing") {
    const { chatId, threadId } = splitScope(scope);
    return this.call("sendChatAction", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      action,
    });
  }

  /** Creates a topic in a forum group; returns its message_thread_id. */
  async createForumTopic(chatId, name) {
    const topic = await this.call("createForumTopic", {
      chat_id: chatId,
      name: String(name).slice(0, 128),
    });
    return topic.message_thread_id;
  }

  answerCallback(id, text) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  setCommands(commands) {
    return this.call("setMyCommands", { commands });
  }

  getMe() {
    return this.call("getMe", {});
  }
}

// ---------------------------------------------------------------------------
// Skill commands (/scan, /review, /wiki, /ask, …)
// ---------------------------------------------------------------------------

/** Scan types of the code-scans skill. */
export const SCAN_TYPES = [
  "performance",
  "database",
  "coverage",
  "dead-code",
  "quality",
  "cleanup",
  "telemetry",
  "accessibility",
  "compliance",
  "security",
  "dependencies",
  "custom",
];

const SCAN_ALIASES = {
  perf: "performance",
  rendimiento: "performance",
  db: "database",
  queries: "database",
  tests: "coverage",
  cobertura: "coverage",
  dead: "dead-code",
  muerto: "dead-code",
  calidad: "quality",
  limpieza: "cleanup",
  a11y: "accessibility",
  accesibilidad: "accessibility",
  seguridad: "security",
  deps: "dependencies",
  dependencias: "dependencies",
};

/**
 * Turns a skill command into a request for the coordinator, or returns
 * `{ usage }` when the arguments are missing. The request names the skill so
 * the coordinator (and any subagent) follows it.
 */
export function buildSkillRequest(command, rawArgs = "") {
  const args = String(rawArgs ?? "").trim();
  switch (command) {
    case "scan": {
      const [first = "", ...rest] = args.split(/\s+/);
      const type = SCAN_ALIASES[first.toLowerCase()] ?? first.toLowerCase();
      if (!SCAN_TYPES.includes(type)) {
        return {
          usage: `Uso: /scan <tipo> [enfoque]\nTipos: ${SCAN_TYPES.join(", ")}\nEj.: /scan database src/api`,
        };
      }
      const focus = rest.join(" ");
      if (type === "custom" && !focus) {
        return { usage: "Uso: /scan custom <qué buscar>" };
      }
      return {
        request: [
          `Use the code-scans skill: run a "${type}" scan of the working folder${focus ? `, focused on: ${focus}` : ""}.`,
          type === "security" ? "Follow the security-audit skill for it." : "",
          "Report the ranked findings (IDs, path:line, severity, suggested fix) and do not change any code. I will pick which findings to fix.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    case "review":
      if (!args)
        return { usage: "Uso: /review <número o URL del PR> [instrucciones]" };
      return {
        request: `Use the pr-reviewer skill to review this pull request: ${args}. Group the changes, report Bugs, Flags and Security findings with path:line evidence, run its tests, and give a verdict. Do not post to GitHub or push fixes until I say so.`,
      };
    case "wiki":
      return {
        request: `Use the repo-wiki skill to generate or update the wiki of the working folder${args ? `. Notes: ${args}` : ""}. Write it on a branch and open a PR, unless the wiki already exists and nothing changed.`,
      };
    case "ask":
      if (!args) return { usage: "Uso: /ask <pregunta sobre el código>" };
      return {
        request: `Use the codebase-qa skill (read-only, answer it yourself, no subagents, no changes). Answer with path:line citations: ${args}`,
      };
    case "plan":
      if (!args)
        return { usage: "Uso: /plan <qué quieres construir o cambiar>" };
      return {
        request: `Use the codebase-qa skill in plan mode (read-only, no subagents yet). Plan this and end with a ready-to-run task prompt: ${args}`,
      };
    case "latency":
      return {
        request: `Use the latency-optimizer skill on the working folder${args ? `, focused on: ${args}` : ""}. Find the slowest endpoint, page, job or query, fix only the worst one, measure before and after, and open one small PR with the numbers.`,
      };
    case "security":
      return {
        request: `Use the security-audit skill on the working folder${args ? `, focused on: ${args}` : ""}. Read-only: report findings with severity, evidence and fixes; don't change code until I pick findings.`,
      };
    case "migrate":
      if (!args)
        return {
          usage:
            "Uso: /migrate <de qué a qué> (ej.: /migrate JavaScript a TypeScript)",
        };
      return {
        request: `Use the migration-modernization skill: ${args}. Assess and write the step-by-step migration plan first and wait for my approval before changing code.`,
      };
    case "design":
      if (!args)
        return {
          usage:
            "Uso: /design <qué diseñar o implementar> (ej.: /design implementa la pantalla Checkout del archivo landing.pen)",
        };
      return {
        request: `Frontend and design work with pen.dev: use the pencil-design skill (the pencil MCP tools; never read .pen files as text) together with senior-frontend, component-design-patterns, ux-design and ui-design. Task: ${args}. Map the design's styles to the project's tokens, build or update the components on a feature branch with tests and a draft PR, and compare the result with the Pencil frame. Don't save changes to an existing .pen file without asking me.`,
      };
    case "movil":
      if (!args)
        return {
          usage:
            "Uso: /movil <tarea de la app Flutter> (ej.: /movil arregla el overflow del login y compruébalo en el iPhone 17)",
        };
      return {
        request: `Mobile work on a Flutter app: give it to an agent that uses the flutter-expert and ios-simulator skills (the OpenHands profile "flutter" when creating one), with the simulator MCP on the Mac host and context7 for the docs of the project's versions. Task: ${args}. Work on a feature branch, run flutter analyze and the tests through flutter_cmd, run the app with flutter_run_ios on an iPhone simulator, check it with sim_screenshot (light and dark), and report what you ran and saw.`,
      };
    default:
      return null;
  }
}

/** Telegram commands handled by buildSkillRequest. */
export const SKILL_COMMANDS = [
  "scan",
  "review",
  "wiki",
  "ask",
  "plan",
  "latency",
  "security",
  "migrate",
  "design",
  "movil",
];

// ---------------------------------------------------------------------------
// Session insights
// ---------------------------------------------------------------------------

const NOISY_EVENT_KINDS = new Set(["ConversationStateUpdateEvent"]);

function eventText(event) {
  const parts = [];
  const content = event?.llm_message?.content ?? event?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) if (item?.text) parts.push(item.text);
  } else if (typeof content === "string") parts.push(content);
  for (const key of ["title", "thought", "detail", "code", "status"]) {
    const value = event?.[key];
    if (typeof value === "string" && value) parts.push(`${key}=${value}`);
    else if (Array.isArray(value))
      parts.push(value.map((v) => v?.text ?? "").join(""));
  }
  const command = event?.action?.command ?? event?.raw_input?.command;
  if (typeof command === "string") parts.push(`$ ${command}`);
  const observation = event?.observation?.content ?? event?.observation?.text;
  if (typeof observation === "string") parts.push(observation);
  else if (Array.isArray(observation))
    parts.push(observation.map((v) => v?.text ?? "").join(""));
  return parts.join(" | ").replace(/\s+/g, " ").trim();
}

/**
 * Compact, chronological digest of a conversation's events for the
 * session-insights skill: one line per event with elapsed time, kind,
 * source, tool and a truncated text. Keeps the head and the tail when long.
 */
export function summarizeEvents(
  events,
  { maxChars = 30_000, lineChars = 220 } = {},
) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return { digest: "", stats: { events: 0 } };
  const t0 = Date.parse(list[0].timestamp ?? "") || 0;
  const counts = {};
  let errors = 0;
  let userMessages = 0;
  let steps = 0;
  const lines = [];
  for (const event of list) {
    const kind = event.kind ?? "Event";
    counts[kind] = (counts[kind] ?? 0) + 1;
    // Counted, but too noisy to list one by one.
    if (NOISY_EVENT_KINDS.has(kind)) continue;
    if (/Error/.test(kind)) errors += 1;
    if (/Action|ToolCall/.test(kind)) steps += 1;
    if (kind === "MessageEvent" && event.source === "user") userMessages += 1;
    const ts = Date.parse(event.timestamp ?? "");
    const elapsed = t0 && ts ? `+${Math.round((ts - t0) / 1000)}s` : "+?";
    const tool = event.tool_name ?? event.action?.kind ?? event.tool_kind ?? "";
    const text = eventText(event).slice(0, lineChars);
    lines.push(
      `${elapsed} ${kind}${event.source ? `[${event.source}]` : ""}${tool ? ` ${tool}` : ""}${text ? `: ${text}` : ""}`,
    );
  }
  let digest = lines.join("\n");
  if (digest.length > maxChars) {
    const head = [];
    const tail = [];
    let size = 0;
    for (let i = 0, j = lines.length - 1; i <= j; i += 1, j -= 1) {
      if (size + lines[i].length > maxChars / 2) break;
      head.push(lines[i]);
      size += lines[i].length;
      if (i !== j) {
        if (size + lines[j].length > maxChars) break;
        tail.unshift(lines[j]);
        size += lines[j].length;
      }
    }
    const skipped = lines.length - head.length - tail.length;
    digest = [...head, `… (${skipped} events omitted) …`, ...tail].join("\n");
  }
  const last = Date.parse(list.at(-1).timestamp ?? "");
  return {
    digest,
    stats: {
      events: list.length,
      steps,
      errors,
      userMessages,
      durationSec: t0 && last ? Math.round((last - t0) / 1000) : null,
      kinds: counts,
    },
  };
}

/** Prompt for an agent that runs the session-insights skill on a digest. */
export function buildInsightsPrompt({ name, conversationId, stats, digest }) {
  return [
    `Use the session-insights skill to analyze the finished session of agent @${name} (conversation ${conversationId}).`,
    "The bridge already read its events for you; do not call the agent server API.",
    `Stats: ${JSON.stringify(stats)}`,
    "Event digest (elapsed time, kind[source], tool: text):",
    "```",
    digest || "(no events)",
    "```",
    "Report in Spanish: size class, category, outcome, timeline, issues ranked by time lost, an improved prompt, and recommended changes. Save 2-3 reusable lessons with qdrant-memory.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Schedules (/schedule) and bot templates (/bot)
// ---------------------------------------------------------------------------

export function validTimeZone(zone) {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

const WEEKDAYS = {
  domingo: 0,
  dom: 0,
  sunday: 0,
  sun: 0,
  lunes: 1,
  lun: 1,
  monday: 1,
  mon: 1,
  martes: 2,
  mar: 2,
  tuesday: 2,
  tue: 2,
  miercoles: 3,
  mie: 3,
  wednesday: 3,
  wed: 3,
  jueves: 4,
  jue: 4,
  thursday: 4,
  thu: 4,
  viernes: 5,
  vie: 5,
  friday: 5,
  fri: 5,
  sabado: 6,
  sab: 6,
  saturday: 6,
  sat: 6,
};
const WEEKDAY_NAMES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];
const MIN_INTERVAL_MS = 15 * 60_000;

const fold = (word) =>
  String(word ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function parseTime(token) {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(token ?? ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Splits "/schedule" arguments into a schedule and the text to run.
 * Accepted forms (Spanish or English):
 *   diario 09:00 <texto>        daily 9:00 <text>
 *   laborables 08:30 <texto>    weekdays 8:30 <text>
 *   lunes 09:00 <texto>         monday 9 <text>   (any weekday)
 *   cada 6h <texto>             every 30m <text>  (15 min or more)
 * Returns { schedule, text } or { error }.
 */
export function parseScheduleArgs(raw) {
  const tokens = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const [first, second] = tokens.map(fold);
  let schedule = null;
  let used = 0;
  if (first === "cada" || first === "every") {
    const match = /^(\d+)\s*(m|min|h|d)$/.exec(second ?? "");
    if (!match)
      return { error: "Intervalo inválido. Ej.: cada 6h, cada 30m, cada 1d" };
    const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2]
    ];
    const everyMs = Number(match[1]) * unit;
    if (everyMs < MIN_INTERVAL_MS)
      return { error: "El intervalo mínimo es 15 min." };
    schedule = { kind: "interval", everyMs };
    used = 2;
  } else {
    const time = parseTime(second);
    let days = null;
    if (["diario", "daily", "cada-dia", "todos"].includes(first))
      days = [0, 1, 2, 3, 4, 5, 6];
    else if (["laborables", "weekdays", "habiles"].includes(first))
      days = [1, 2, 3, 4, 5];
    else if (first in WEEKDAYS) days = [WEEKDAYS[first]];
    if (!days)
      return {
        error:
          "Cuándo no reconocido. Usa: diario 09:00, laborables 08:30, lunes 09:00 o cada 6h.",
      };
    if (!time) return { error: "Hora inválida. Ej.: 09:00" };
    schedule = { kind: "weekly", days, ...time };
    used = 2;
  }
  const text = tokens.slice(used).join(" ");
  if (!text) return { error: "Falta qué ejecutar después del cuándo." };
  return { schedule, text };
}

function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.weekday,
    ),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Next run time (ms since epoch) strictly after `from`. */
export function nextRun(schedule, from = Date.now(), timeZone = "UTC") {
  const start = typeof from === "number" ? from : from.getTime();
  if (schedule.kind === "interval") return start + schedule.everyMs;
  // Walk forward minute by minute (at most 8 days) in the target time zone,
  // which handles DST shifts without a time zone library.
  let t = Math.floor(start / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 8 * 24 * 60; i += 1, t += 60_000) {
    const { day, hour, minute } = zonedParts(new Date(t), timeZone);
    if (
      hour === schedule.hour &&
      minute === schedule.minute &&
      schedule.days.includes(day)
    )
      return t;
  }
  return null;
}

/** "lunes 09:00", "laborables 08:30", "cada 6 h". */
export function describeSchedule(schedule) {
  if (schedule.kind === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % 1440 === 0) return `cada ${minutes / 1440} d`;
    if (minutes % 60 === 0) return `cada ${minutes / 60} h`;
    return `cada ${minutes} min`;
  }
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  const days = [...schedule.days].sort();
  if (days.length === 7) return `diario ${time}`;
  if (days.join() === "1,2,3,4,5") return `laborables ${time}`;
  return `${days.map((d) => WEEKDAY_NAMES[d]).join(", ")} ${time}`;
}

/** When a run time falls, in the schedule's time zone, for messages. */
export function formatWhen(ms, timeZone = "UTC") {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

/**
 * Always-on bots: each template is a schedule plus a skill command, so a bot
 * owns one outcome (speed, quality, docs) and reports back on its own.
 */
export const BOT_TEMPLATES = {
  latency: {
    when: "lunes 09:00",
    text: "/latency",
    description:
      "Cada semana busca el endpoint, página o query más lento y abre un PR pequeño con el antes y después.",
  },
  scans: {
    when: "miercoles 09:00",
    text: "/scan quality",
    description:
      "Escaneo semanal de calidad de código con hallazgos priorizados.",
  },
  security: {
    when: "viernes 09:00",
    text: "/security dependencias, secretos y authz",
    description: "Auditoría de seguridad semanal (solo lectura).",
  },
  deps: {
    when: "lunes 08:00",
    text: "/scan dependencies",
    description:
      "Revisa dependencias vulnerables o desactualizadas cada semana.",
  },
  consejo: {
    when: "jueves 10:00",
    text: "/consejo producto, ux, frontend, qa, growth: revisa el producto y propone las 3 mejoras con más impacto para los usuarios esta semana",
    description:
      "Cada semana un consejo de expertos debate y propone las mejoras del producto; tú apruebas el plan.",
  },
  evals: {
    when: "domingo 18:00",
    text: "/evals casos",
    description:
      "Cada semana corre los casos de evaluación de los agentes y compara la puntuación con la semana anterior.",
  },
  mejora: {
    when: "lunes 10:00",
    text: "/mejora",
    description:
      "Cada semana @curador convierte el feedback y los evals en skills, reglas o casos nuevos; tú apruebas cada uno.",
  },
  upstream: {
    when: "martes 09:00",
    text: "Mantén este fork al día con su upstream sin tocar nuestros cambios: corre `safe-branch sync` en el repo (con la skill feature-branch-pr). Si hay commits nuevos, `safe-branch sync --apply`, resuelve conflictos conservando nuestro comportamiento, corre lint, tipos, tests y build en la rama sync/… y repórtame qué entró, qué archivos tocamos ambos y el resultado. No fusiones a main ni hagas push sin mi OK.",
    description:
      "Cada semana trae los cambios del upstream a una rama sync/… verificada, sin tocar los nuestros; tú decides cuándo entra a main.",
  },
  wiki: {
    when: "domingo 20:00",
    text: "/wiki actualiza solo las páginas cuyo código cambió",
    description: "Mantiene la wiki del repo al día con el código.",
  },
  qa: {
    when: "laborables 18:00",
    text: "Use the qa-testing skill: find the PRs opened or updated today (gh pr list), run their tests and a smoke test in an isolated container, and report results per PR. Don't push or post anything.",
    description:
      "Cada día laborable prueba los PRs del día en un contenedor aislado.",
  },
};

/** Request text for a scheduled entry: skill commands expand, text stays. */
export function expandScheduledText(text) {
  const parsed = parseMessage(String(text ?? ""));
  if (parsed.kind === "command" && SKILL_COMMANDS.includes(parsed.command)) {
    const built = buildSkillRequest(parsed.command, parsed.args);
    if (built?.request) return built.request;
  }
  return String(text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Expert council: experts propose in parallel, debate each other's proposals,
// vote, and a moderator decides and writes the plan the user approves.
// ---------------------------------------------------------------------------

export const COUNCIL_EXPERTS = {
  producto: {
    title: "product manager",
    focus:
      "user value, the problem worth solving, metrics (activation, retention, conversion) and RICE prioritization",
    skills: ["codebase-qa"],
  },
  ux: {
    title: "UX/UI designer",
    focus:
      "user flows, friction, accessibility, UX copy, visual consistency and storytelling",
    skills: [
      "ux-design",
      "ui-design",
      "ux-ui-storytelling",
      "impeccable",
      "pencil-design (pencil MCP: read the .pen designs)",
    ],
  },
  frontend: {
    title: "senior frontend engineer",
    focus:
      "components, state, rendering, bundle size, Core Web Vitals and frontend tech debt",
    skills: [
      "senior-frontend",
      "component-design-patterns",
      "pencil-design (pencil MCP: compare the code with the .pen designs)",
    ],
  },
  backend: {
    title: "senior backend engineer",
    focus: "APIs, data model, queries, jobs, error handling and reliability",
    skills: ["senior-backend"],
  },
  arquitectura: {
    title: "software architect",
    focus:
      "boundaries, coupling, scalability, build-vs-buy, and the cost of each change over time",
    skills: ["senior-architect"],
  },
  qa: {
    title: "QA lead",
    focus:
      "test coverage of risky paths, flaky areas, regressions and how each proposal will be verified",
    skills: ["qa-testing"],
  },
  seguridad: {
    title: "application security engineer",
    focus: "authn/authz, injection, secrets, dependencies and data protection",
    skills: ["security-audit"],
  },
  rendimiento: {
    title: "performance engineer",
    focus: "latency, slow queries, payload size and the user-perceived speed",
    skills: ["latency-optimizer"],
  },
  devops: {
    title: "DevOps/SRE engineer",
    focus:
      "CI/CD, Docker, Cloudflare deploys, observability, cost and rollback",
    skills: ["senior-devops", "docker-containers", "cloudflare-wrangler"],
  },
  movil: {
    title: "senior Flutter/mobile engineer",
    focus:
      "Flutter/Dart architecture, state management, iOS/Android platform details, app performance, store readiness and how each proposal looks on a real iPhone",
    skills: [
      "flutter-expert",
      "ios-simulator (simulator MCP: run the app and take screenshots)",
    ],
  },
  growth: {
    title: "growth and marketing expert",
    focus:
      "onboarding, conversion funnel, SEO, landing pages, pricing pages and messaging",
    skills: ["ux-ui-storytelling"],
  },
  datos: {
    title: "data and analytics expert",
    focus:
      "event tracking, product metrics, dashboards, data quality and experiments (A/B)",
    skills: ["senior-backend"],
  },
};

export const DEFAULT_COUNCIL = [
  "producto",
  "ux",
  "arquitectura",
  "qa",
  "seguridad",
];

const COUNCIL_ALIASES = {
  product: "producto",
  pm: "producto",
  design: "ux",
  ui: "ux",
  architecture: "arquitectura",
  architect: "arquitectura",
  security: "seguridad",
  sec: "seguridad",
  performance: "rendimiento",
  perf: "rendimiento",
  latency: "rendimiento",
  sre: "devops",
  marketing: "growth",
  data: "datos",
  analytics: "datos",
  test: "qa",
  testing: "qa",
  mobile: "movil",
  flutter: "movil",
  ios: "movil",
  app: "movil",
};

const councilKey = (word) => {
  const key = String(word ?? "")
    .toLowerCase()
    .replace(/^@/, "");
  return COUNCIL_EXPERTS[key] ? key : (COUNCIL_ALIASES[key] ?? null);
};

/**
 * `/consejo [expertos:] tema` → { experts, topic } | { usage }.
 * The optional prefix is a comma or space separated list of expert names
 * ("ux, growth, producto: mejorar el onboarding"); any unknown word means
 * the prefix is part of the topic, and the default panel is used.
 */
export function parseCouncilArgs(raw, max = MAX_TEAM_SIZE) {
  const text = String(raw ?? "").trim();
  const usage = `Uso: /consejo [expertos:] tema\nEj.: /consejo mejorar el onboarding\n     /consejo ux, growth, producto: por qué no convierte la landing\nExpertos: ${Object.keys(COUNCIL_EXPERTS).join(", ")}\nPor defecto: ${DEFAULT_COUNCIL.join(", ")}`;
  if (!text) return { usage };
  let experts = [...DEFAULT_COUNCIL];
  let topic = text;
  const colon = text.indexOf(":");
  if (colon > 0) {
    const words = text
      .slice(0, colon)
      .split(/[\s,]+/)
      .filter(Boolean);
    const keys = words.map(councilKey);
    if (words.length && keys.every(Boolean)) {
      experts = [...new Set(keys)];
      topic = text.slice(colon + 1).trim();
    }
  }
  if (!topic) return { usage };
  if (experts.length < 2)
    return { usage: `Un consejo necesita al menos 2 expertos.\n\n${usage}` };
  return { experts: experts.slice(0, max), topic };
}

const clip = (text, max) => {
  const value = String(text ?? "").trim() || "(no answer)";
  return value.length > max ? `${value.slice(0, max)}\n…(truncated)` : value;
};

/** Phase 1: each expert studies the project alone and proposes. */
export function buildCouncilProposalPrompt({
  expert,
  name = expert,
  topic,
  panel = [],
  workingDir = "",
}) {
  const info = COUNCIL_EXPERTS[expert];
  return [
    `You are @${name}, the ${info.title} on a council of expert AI agents,`,
    "coordinated from Telegram. Each expert studies the project on their own,",
    "then the council debates and a moderator decides with the user.",
    `Council: ${panel.map((name) => `@${name}`).join(", ")}.`,
    workingDir ? `Working folder: ${workingDir}` : "",
    `Your focus: ${info.focus}.`,
    `Use these skills where they fit: ${info.skills.join(", ")}, qdrant-memory.`,
    "",
    "This phase is READ-ONLY: do not edit files, commit, install packages, or",
    "run anything with side effects. Look for existing knowledge first",
    "(qdrant-memory qdrant-find, docs/wiki, README, AGENTS.md), then the code.",
    "",
    "Answer in Spanish, under 500 words, in this format:",
    "## Diagnóstico",
    "3 to 6 bullets, each with evidence (path:line, a command output, a metric).",
    "## Propuestas",
    `At most 4, each starting with its id: \`${name}-P1: title\`, then`,
    "impact (alto/medio/bajo), effort (S/M/L), risk, confidence, why,",
    "the evidence, and how to measure success.",
    "## Riesgos",
    "What could go wrong, and what you would NOT do.",
    "## Preguntas",
    "What the user must decide or clarify.",
    "",
    `Topic: ${topic}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Phase 2: each expert reads the others' proposals, argues, and votes. */
export function buildCouncilDebatePrompt({ expert, topic, positions }) {
  const others = positions.filter((item) => item.name !== expert);
  return [
    `Debate round of the council on: ${topic}`,
    "Here are the other experts' positions:",
    "",
    ...others.map((item) => `### @${item.name}\n${clip(item.text, 3500)}\n`),
    "Debate them from your area, still READ-ONLY, in Spanish, under 400 words:",
    "- Where you agree, say so briefly. Where you disagree, say why, with",
    "  evidence from the code. Point out conflicts with your area (for example",
    "  a UX proposal that breaks security, or a refactor without tests).",
    "- You may merge proposals, or add at most one new one with a new id",
    `  (\`${expert}-P5\`, …). Change your mind when the evidence is better.`,
    "- End with exactly one line with your top 3 proposals of the whole",
    "  council, best first, using their ids, and at most one of your own:",
    "VOTOS: id-1, id-2, id-3",
  ].join("\n");
}

/** The ids from the last `VOTOS:` (or `VOTES:`) line of a debate answer. */
export function parseVotes(text) {
  const lines = String(text ?? "")
    .replace(/\*\*|`/g, "")
    .split(/\r?\n/)
    .filter((line) => /^\s*vot(?:os|es)\s*:/i.test(line));
  if (!lines.length) return [];
  const ids = lines
    .at(-1)
    .replace(/^\s*vot(?:os|es)\s*:/i, "")
    .match(/[a-z0-9_]+(?:-[a-z0-9_]+)*-p\d+/gi);
  return [...new Set((ids ?? []).map((id) => id.toLowerCase()))].slice(0, 3);
}

/**
 * Borda count of the debate votes: 3, 2 and 1 points for each voter's
 * first, second and third choice. Returns [{ id, points, voters }] sorted.
 */
export function tallyVotes(debate) {
  const scores = new Map();
  for (const { name, text } of debate) {
    parseVotes(text).forEach((id, index) => {
      const entry = scores.get(id) ?? { id, points: 0, voters: [] };
      entry.points += 3 - index;
      entry.voters.push(name);
      scores.set(id, entry);
    });
  }
  return [...scores.values()].sort(
    (a, b) => b.points - a.points || a.id.localeCompare(b.id),
  );
}

export function formatTally(tally, limit = 8) {
  if (!tally.length) return "(nadie votó)";
  return tally
    .slice(0, limit)
    .map(
      (entry, index) =>
        `${index + 1}. ${entry.id} — ${entry.points} pts (${entry.voters.map((name) => `@${name}`).join(", ")})`,
    )
    .join("\n");
}

/** Phase 3: the moderator weighs everything, decides, and plans. */
export function buildCouncilDecisionPrompt({
  topic,
  proposals,
  debate,
  tally,
  workingDir = "",
  max = MAX_TEAM_SIZE,
}) {
  return [
    "You are the moderator of a council of expert AI agents. They studied the",
    "project in parallel, proposed, debated each other and voted. Decide.",
    workingDir ? `Working folder: ${workingDir}` : "",
    `Topic: ${topic}`,
    "",
    "## Proposals",
    ...proposals.map((item) => `### @${item.name}\n${clip(item.text, 3000)}\n`),
    "## Debate",
    ...debate.map((item) => `### @${item.name}\n${clip(item.text, 2500)}\n`),
    "## Votes (Borda: 3/2/1 points)",
    formatTally(tally, 12),
    "",
    "Weigh evidence over vote counts: votes are an input, not the decision.",
    "Check any claim you doubt in the code (read-only). Answer in Spanish:",
    "## Decisión — two or three sentences.",
    "## Consenso — what the experts agree on.",
    "## Desacuerdos — who disagrees and why, how you resolved it, or what the",
    "   user must decide.",
    "## Matriz — table: id | propuesta | impacto | esfuerzo | riesgo | votos |",
    "   decisión (ahora / después / descartar).",
    "## ADR — context, decision, alternatives considered, consequences.",
    "",
    "Save the decision with qdrant-memory (qdrant-store), one short entry:",
    '"Decisión <fecha> <tema>: <decisión> (descartado: …)", so future agents',
    "don't reopen it.",
    "",
    "Follow change-safety-guard: before the plan, list anything it would",
    "delete, replace or touch in data, secrets, auth, payments, infra or",
    "dependencies. Do not do the work yourself. End with the plan for the",
    `"ahora" items, at most ${max} lines, one per agent, that can run in parallel`,
    "without editing the same files, including a QA agent when code changes:",
    "@short-name: what to do, which files or area, and what done looks like",
    "The user approves the plan in Telegram before anything runs.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// pen.dev screenshots: the bridge talks to the pencil MCP directly (no agent)
// to export design frames as PNG and send them to the chat.
// ---------------------------------------------------------------------------

/** Minimal MCP Streamable HTTP client (JSON or SSE responses). */
export class McpHttpClient {
  constructor({
    url,
    token = "",
    fetchImpl = fetch,
    clientName = "telegram-bridge",
  }) {
    this.url = url;
    this.token = token;
    this.fetch = fetchImpl;
    this.clientName = clientName;
    this.sessionId = null;
    this.nextId = 1;
  }

  async post(message) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const response = await this.fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (response.status === 202) return null;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const text = await response.text();
    if (
      (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ) {
      const events = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)));
      return (
        events.find((event) => event.id === message.id) ?? events.at(-1) ?? null
      );
    }
    return text ? JSON.parse(text) : null;
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const reply = await this.post({ jsonrpc: "2.0", id, method, params });
    if (reply?.error) throw new Error(reply.error.message ?? "MCP error");
    return reply?.result;
  }

  async connect() {
    if (this.sessionId) return;
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: this.clientName, version: "1.0.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Calls a tool; returns { text, isError }. */
  async callTool(name, args = {}) {
    await this.connect();
    const result = await this.request("tools/call", { name, arguments: args });
    const text = (result?.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return { text, isError: Boolean(result?.isError) };
  }

  async close() {
    if (!this.sessionId) return;
    const headers = { "Mcp-Session-Id": this.sessionId };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    await this.fetch(this.url, { method: "DELETE", headers }).catch(() => {});
    this.sessionId = null;
  }
}

/** The active document and the top-level nodes the user sees, from get_app_state. */
export function parsePenAppState(text) {
  const value = String(text ?? "");
  const uri = /active canvas editor URI:\s*`([^`]+)`/i.exec(value)?.[1] ?? null;
  const line = /Top-level nodes:(.*)/i.exec(value)?.[1] ?? "";
  const nodes = [
    ...line.matchAll(/`([^`]+)` \((\w+)\): (.+?) \[([^\]]+)\]/g),
  ].map(([, id, type, name, where]) => ({
    id,
    type,
    name: name.trim(),
    visible: /user visible/i.test(where),
  }));
  return { uri, nodes };
}

const foldText = (text) =>
  String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export const PEN_SHOT_TYPES = new Set(["frame", "group", "ref", "variants"]);

/**
 * Picks the nodes to export: an exact id, the frames whose name contains
 * every word of the query (best match first: visible on the canvas, a name
 * part equal to the query, then the shortest name), or (no query) the
 * frames visible on the canvas.
 */
export function pickPenNodes(nodes, query = "", max = 4) {
  const shots = nodes.filter((node) => PEN_SHOT_TYPES.has(node.type));
  const q = String(query ?? "").trim();
  if (!q) {
    const visible = shots.filter((node) => node.visible);
    return (visible.length ? visible : shots).slice(0, max);
  }
  const exact = nodes.find((node) => node.id === q);
  if (exact) return [exact];
  const folded = foldText(q);
  const words = folded.split(/\s+/).filter(Boolean);
  const score = (node) => {
    const name = foldText(node.name);
    const parts = name.split(/\s*[·|/>-]\s*/);
    return (
      (node.visible ? 4 : 0) +
      (parts.includes(folded) ? 2 : 0) +
      (name === folded ? 4 : 0)
    );
  };
  const seen = new Set();
  const unique = shots.filter(
    (node) => !seen.has(node.id) && seen.add(node.id),
  );
  const hits = (node) =>
    words.filter((word) => foldText(node.name).includes(word)).length;
  let matches = unique.filter((node) => hits(node) === words.length);
  // Typos ("oma wallet"): fall back to the frames matching the most words.
  if (!matches.length && words.length > 1) {
    const best = Math.max(0, ...unique.map(hits));
    if (best > 0) matches = unique.filter((node) => hits(node) === best);
  }
  return matches
    .sort((a, b) => score(b) - score(a) || a.name.length - b.name.length)
    .slice(0, max);
}

const PEN_FILLER = new Set(
  (
    "toma tomame tomar saca sacame haz hazme manda mandame envia enviame " +
    "muestra muestrame ensena ensename dame quiero necesito ver por favor porfa " +
    "una un unas unos la las el los lo de del al a en con para me mi mis que y o " +
    "foto fotos captura capturas screenshot screenshots screen pantallazo imagen " +
    "imagenes pantalla pantallas frame frames vista vistas diseno disenos " +
    "unicamente solo solamente sola nada mas only just of the please take send " +
    "show give me picture pic pen pencil pen.dev archivo file actual abierta abierto " +
    "revisa revisar revision audita auditar auditoria optimiza optimizar optimizala " +
    "optimizalo mejora mejorar mejorala mejoralo critica criticar analiza analizar " +
    "ux ui usabilidad experiencia usuario review audit optimize optimise improve " +
    "it this esta este"
  ).split(" "),
);
const PEN_PHOTO_RE =
  /\b(foto|fotos|captura|capturas|screenshot|screen|pantallazo|imagen|muestra(me)?|ensena(me)?|picture|pic|show)\b/;
const PEN_UX_RE =
  /\b(ux|usabilidad|revisa(r|la|lo)?|revision|audita(r)?|auditoria|optimiza(r|la|lo)?|mejora(r|la|lo)?|critica(r)?|analiza(r)?|review|audit|optimi[sz]e|improve)\b/;
const PEN_ONLY_RE = /\b(unicamente|solo|solamente|nada mas|only|just)\b/;
const PEN_LIST_RE = /^(lista|list|ls|pantallas|frames|indice|index)$/;

/**
 * What a natural-language pen request asks for:
 * { intent: "photo", query, only } | { intent: "list" } | { intent: "edit", request }.
 */
export function parsePenRequest(raw) {
  const text = String(raw ?? "").trim();
  const folded = foldText(text).replace(/[¿?¡!.,;:"']/g, " ");
  const words = folded.split(/\s+/).filter(Boolean);
  if (words.length === 1 && PEN_LIST_RE.test(words[0]))
    return { intent: "list" };
  if (!words.length) return { intent: "photo", query: "", only: false };
  // A node id looks like "I7gNe": mixed case or digits, no spaces.
  if (
    /^(?=.*[A-Z0-9])[A-Za-z0-9]{4,8}$/.test(text) &&
    text !== text.toUpperCase()
  )
    return { intent: "photo", query: text, only: true };
  // "revisa la ux de wallet y optimízala": the UX agent reviews and improves.
  if (PEN_UX_RE.test(folded)) {
    const query = words.filter((word) => !PEN_FILLER.has(word)).join(" ");
    return { intent: "ux", query, request: text };
  }
  const photo = PEN_PHOTO_RE.test(folded);
  // A bare name ("wallet", "dashboard mega menu") is a photo request too.
  const bare =
    words.length <= 4 &&
    !/\b(arregla|cambia|corrige|pon|quita|agrega|anade|crea|haz|mueve|alinea|ajusta|fix|change|make|add|remove)\b/.test(
      folded,
    );
  if (photo || bare) {
    const query = words.filter((word) => !PEN_FILLER.has(word)).join(" ");
    return { intent: "photo", query, only: PEN_ONLY_RE.test(folded) };
  }
  return { intent: "edit", request: text };
}

/**
 * A plain message addressed to pen ("pen, toma una foto de wallet", "en pen
 * arregla el header"): returns the request without the address, else null.
 */
export function penMessage(text) {
  const value = String(text ?? "").trim();
  const lead = /^(?:@?pen(?:\.dev)?|pencil)\b[\s,:;-]*/i.exec(value);
  if (lead) return value.slice(lead[0].length).trim();
  if (/\b(?:en|in|on) (?:pen(?:\.dev)?|pencil)\b/i.test(value)) return value;
  return null;
}

/** First message for the scope's design agent (pencil MCP). */
export function buildPenEditPrompt({ request, uri = "", file = "" }) {
  return [
    "You are @pen, the design agent of this chat. You work in the user's pen.dev",
    "(Pencil) app through the pencil MCP tools, following the pencil-design skill.",
    uri
      ? `Open document: ${file} (${uri}). Use this uri in every tool call.`
      : "",
    "",
    "Do exactly what the user asks in the open design, no more. Start with",
    "get_app_state and read_skill, then find the frames involved (execute with",
    "Get and a visitor), make the change with execute, and check it with",
    "TakeScreenshot. The user sees the change live in the app. Don't call the",
    "save tool unless the user asks to save. Don't read .pen files as text.",
    "If the request is unclear, ask one short question instead of guessing.",
    "",
    "Answer in Spanish in two or three lines: what you changed. Then end with",
    "one line with the ids of the top-level frames to photograph, like:",
    "FOTO: I7gNe, I98pva",
    "",
    `Request: ${request}`,
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

/**
 * First message for the chat's UX agent: review the frames, rank the
 * issues, and optimize them on copies (the originals stay untouched).
 */
export function buildPenUxPrompt({
  request,
  uri = "",
  file = "",
  frames = [],
}) {
  return [
    "You are @ux, a senior UX/UI designer. You review and optimize designs in",
    "the user's pen.dev (Pencil) app through the pencil MCP tools. Use the",
    "skills ux-design, ui-design, ux-ui-storytelling, impeccable and pencil-design.",
    uri
      ? `Open document: ${file} (${uri}). Use this uri in every tool call.`
      : "",
    frames.length
      ? `Frames: ${frames.map((frame) => `${frame.name} (${frame.id})`).join(", ")}.`
      : "Frames: the ones the user names, or the ones visible on the canvas (get_app_state).",
    "",
    "1. Review each frame: look at it with TakeScreenshot and read its",
    "   structure with Get. Check: visual hierarchy and the main action, Nielsen",
    "   heuristics, WCAG AA contrast and touch targets, spacing rhythm and",
    "   alignment, typography scale, consistency with the document's variables",
    "   and components, UX copy (Spanish, clear, short), empty/loading/error",
    "   states, and how the layout holds on mobile.",
    "2. Rank the findings: ID (U1, U2…), severity (alta/media/baja), frame,",
    "   the problem, and the fix. Skip personal taste; every finding says why",
    "   it hurts the user.",
    "3. Optimize without touching the originals: Copy each frame next to it",
    "   (FindEmptySpace to the right of the original), name the copy",
    '   "<original name> · UX v2", and apply the high and medium fixes there,',
    "   reusing the document's components and variables. Verify with",
    "   TakeScreenshot. Don't call save unless the user asks.",
    "",
    "Answer in Spanish: the findings table, what you changed in each copy, and",
    "what you left for the user to decide. End with one line pairing each",
    "original with its copy (before, after), like:",
    "FOTO: I7gNe, Xk9f2",
    "",
    `Request: ${request}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Frame ids from the `FOTO:` line of the design agent's answer. */
export function parsePhotoIds(text) {
  const lines = String(text ?? "")
    .replace(/\*\*|`/g, "")
    .split(/\r?\n/)
    .filter((line) => /^\s*(foto|fotos|photo|photos)\s*:/i.test(line));
  if (!lines.length) return [];
  return [
    ...new Set(
      lines
        .at(-1)
        .replace(/^[^:]*:/, "")
        .split(/[\s,]+/)
        .filter((id) => /^[A-Za-z0-9]{3,12}$/.test(id)),
    ),
  ].slice(0, 4);
}

/** pen.dev `execute` snippet that lists the document's top-level nodes. */
export const PEN_LIST_SNIPPET =
  "Print(JSON.stringify(Get(document,(n,c)=>{c.skipChildren();return {id:n.id,type:n.type,name:n.name}})))";

export function penExportSnippet(ids, hostDir, scale = 1) {
  return `Export(${JSON.stringify(ids)},"png",${JSON.stringify(hostDir)},{scale:${Number(scale) || 1}})`;
}

/** The JSON array printed by PEN_LIST_SNIPPET, or []. */
export function parsePenNodeList(text) {
  const match = /^\s*(\[.*\])\s*$/m.exec(String(text ?? ""));
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

/**
 * Maps a container path under /documents or /projects to the host path the
 * Pen app sees (PEN_HOST_DOCUMENTS_DIR / PEN_HOST_PROJECTS_DIR), or null.
 */
export function toPenHostPath(path, env = process.env) {
  const roots = [
    ["/documents", env.PEN_HOST_DOCUMENTS_DIR],
    ["/projects", env.PEN_HOST_PROJECTS_DIR],
  ];
  for (const [root, host] of roots) {
    if (!host) continue;
    if (path === root || path.startsWith(`${root}/`)) {
      return `${host.replace(/\/+$/, "")}${path.slice(root.length)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Projects: a name bound to a folder; each Telegram scope (chat or topic)
// works on one project, with its own agents and memory namespace.
// ---------------------------------------------------------------------------

/** "Dracma Web!" → "dracma-web" (letters, digits, - and _; at most 40). */
export function projectSlug(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * `/project` arguments → { action, name, dir } | { usage }.
 * Actions: list (no args), new <name> [dir], use <name>, rm <name>.
 */
export function parseProjectArgs(raw) {
  const usage = [
    "Uso:",
    "/project — proyecto de este chat o tema y la lista de proyectos",
    "/project new <nombre> [carpeta] — crea el proyecto (carpeta por defecto: /documents/<nombre>); en un grupo con temas abre un tema para él",
    "/project use <nombre> — este chat o tema trabaja en ese proyecto",
    "/project rm <nombre> — lo quita de la lista (no borra archivos)",
  ].join("\n");
  const [verb = "", name = "", ...rest] = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const action = {
    "": "list",
    list: "list",
    ls: "list",
    lista: "list",
    new: "new",
    add: "new",
    crear: "new",
    nuevo: "new",
    use: "use",
    usar: "use",
    rm: "rm",
    del: "rm",
    borrar: "rm",
  }[verb.toLowerCase()];
  if (!action) return { usage };
  if (action === "list") return { action };
  const slug = projectSlug(name);
  if (!slug) return { usage };
  if (action !== "new") return { action, name: slug };
  const dir = rest.length
    ? parseWorkingDir(rest.join(" "))
    : `/documents/${slug}`;
  if (!dir)
    return { usage: `La carpeta debe ser una ruta absoluta.\n\n${usage}` };
  return { action, name: slug, dir };
}

/**
 * First lines of every agent's first message in a project: where it works
 * and how to keep the shared memory separated per project.
 */
export function buildProjectContext(project, workingDir = "") {
  if (!project) return "";
  return [
    `Project: ${project}${workingDir ? ` (folder ${workingDir})` : ""}.`,
    `Shared memory is used by many projects: start every qdrant-store entry with "[${project}]",`,
    `include "${project}" in your qdrant-find queries, and ignore memories tagged with another project.`,
    "Only work inside this project's folder.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Agent-to-agent talk: the Telegram chat is shared by humans and agents. An
// agent addresses another one with a "PARA @name: message" line; the bridge
// posts it in the chat and delivers it, so humans see and can join in.
// ---------------------------------------------------------------------------

const AGENT_MESSAGE_RE =
  /^\s*(?:[-*•]\s*)?(?:para|to|a|msg|mensaje(?:\s+para)?)\s+@([a-z0-9][a-z0-9_-]{0,31})\s*(?::|—|–|-)\s*(\S[\s\S]*)$/i;

/** Messages an agent addressed to other agents: [{ to, text }]. */
export function parseAgentMessages(text, max = 3) {
  const result = [];
  for (const line of String(text ?? "")
    .replace(/\*\*|`/g, "")
    .split(/\r?\n/)) {
    const match = AGENT_MESSAGE_RE.exec(line);
    if (match)
      result.push({ to: match[1].toLowerCase(), text: match[2].trim() });
    if (result.length >= max) break;
  }
  return result;
}

/** How agents talk to each other; added to every agent's first message. */
export function buildAgentNetworkNote(name, others = [], scope = "") {
  return [
    `You are @${name} in a Telegram chat shared by humans and AI agents.`,
    others.length
      ? `Other agents here: ${others.map((other) => `@${other}`).join(", ")}.`
      : "",
    scope
      ? [
          `While you work, use the agent_chat MCP tools with chat="${scope}" and from="${name}":`,
          "chat_agents (who is here and what they do), chat_history (what was said),",
          "chat_send (message another agent), chat_post (tell the humans something),",
          "chat_ask_human (ask the user; the answer arrives as a new message).",
          "Coordinate on your own: ask the agent who owns a piece instead of guessing,",
          "share results others need, and keep messages short and useful.",
        ].join("\n")
      : "",
    "You can also end your answer with lines",
    '"PARA @name: message" (one line per agent, at most 3). The bridge posts it',
    "in the chat and delivers it; their reply comes back to you the same way.",
    "Humans read everything and may answer for them. Only do it when you need",
    "that agent; never use it for thanks or acknowledgements.",
    "",
  ]
    .filter((line, index) => line !== "" || index > 0)
    .join("\n");
}

/** The message a relayed agent receives. */
export function buildRelayPrompt(from, text) {
  return [
    `Message from @${from} (another agent in this chat):`,
    text,
    "",
    `Do what it asks if it fits your work. To answer @${from}, end with a line`,
    `"PARA @${from}: your answer". Don't answer if there is nothing to add.`,
  ].join("\n");
}

export const MAX_RELAYS_PER_HOUR = 6;

/**
 * Whether an agent may send another relay now (loop guard: at most
 * MAX_RELAYS_PER_HOUR per agent per hour). Mutates the agent's history.
 */
export function allowRelay(agent, now = Date.now(), max = MAX_RELAYS_PER_HOUR) {
  const recent = (agent.relays ?? []).filter((time) => now - time < 3_600_000);
  if (recent.length >= max) {
    agent.relays = recent;
    return false;
  }
  agent.relays = [...recent, now];
  return true;
}

// ---------------------------------------------------------------------------
// agent_chat MCP server: tools that let agents talk to each other and to the
// humans of their chat while they work. The bridge serves it on loopback.
// ---------------------------------------------------------------------------

export const CHAT_MCP_KEY = "agent_chat";
export const MAX_CHAT_LOG = 40;

const chatArgs = (extra = {}, required = []) => ({
  type: "object",
  properties: {
    chat: {
      type: "string",
      description: "Your chat id, from your first message",
    },
    from: { type: "string", description: "Your agent name, without @" },
    ...extra,
  },
  required: ["chat", "from", ...required],
});

export const CHAT_TOOLS = [
  {
    name: "chat_agents",
    description:
      "List the agents in your Telegram chat, their status and role.",
    inputSchema: chatArgs(),
  },
  {
    name: "chat_history",
    description:
      "Read the latest messages of your Telegram chat (humans and agents).",
    inputSchema: chatArgs({
      limit: {
        type: "number",
        description: "Messages to read (default 20, max 40)",
      },
    }),
  },
  {
    name: "chat_send",
    description:
      "Send a message to another agent of your chat. It is posted in the chat so humans see it, and the agent works on it; its answer comes back to you as a new message.",
    inputSchema: chatArgs(
      {
        to: { type: "string", description: "Agent name, without @" },
        text: { type: "string" },
      },
      ["to", "text"],
    ),
  },
  {
    name: "chat_post",
    description:
      "Post a short update for the humans of your chat (progress, a result, a heads-up). Replies to it come back to you.",
    inputSchema: chatArgs({ text: { type: "string" } }, ["text"]),
  },
  {
    name: "chat_ask_human",
    description:
      "Ask the humans of your chat a question when you need a decision or information. Don't wait for the answer: it arrives as a new message.",
    inputSchema: chatArgs({ question: { type: "string" } }, ["question"]),
  },
];

/** Adds a line to a scope's recent chat log (kept to MAX_CHAT_LOG). */
export function appendChatLog(chat, who, text, at = Date.now()) {
  const log = (chat.log ??= []);
  log.push({ at, who, text: String(text ?? "").slice(0, 500) });
  if (log.length > MAX_CHAT_LOG) log.splice(0, log.length - MAX_CHAT_LOG);
}

export function formatChatLog(log = [], limit = 20) {
  const items = log.slice(
    -Math.min(Math.max(1, Number(limit) || 20), MAX_CHAT_LOG),
  );
  if (!items.length) return "(no messages yet)";
  return items
    .map(
      (item) =>
        `[${new Date(item.at).toISOString().slice(11, 16)}] ${item.who}: ${item.text}`,
    )
    .join("\n");
}

/**
 * Handles one JSON-RPC message of the MCP protocol with the given tool
 * handlers ({ name: async (args) => text }). Returns the response, or null
 * for notifications.
 */
export async function handleMcpMessage(message, handlers, tools = CHAT_TOOLS) {
  if (!message || message.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "agent_chat", version: "1.0.0" },
        instructions:
          "Talk to the other agents and the humans of your Telegram chat. Pass your chat id and agent name from your first message.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const name = message.params?.name;
      const handler = handlers[name];
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `Unknown tool ${name}` },
        };
      }
      try {
        const text = await handler(message.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: String(text) }] });
      } catch (error) {
        return reply({
          content: [{ type: "text", text: error.message }],
          isError: true,
        });
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      };
  }
}

// ---------------------------------------------------------------------------
// Natural chat: greetings get an instant answer, and a command written inside
// a sentence ("hola /team arma el login") still works.
// ---------------------------------------------------------------------------

/**
 * A known command written after other words: "hola /team arma el login" →
 * { command: "team", args: "arma el login", before: "hola" }, else null.
 */
export function findInlineCommand(text, known) {
  const value = String(text ?? "");
  const pattern = /(^|\s)\/([a-z_]+)(?:@\S+)?(?=\s|$)/gi;
  for (const match of value.matchAll(pattern)) {
    const command = match[2].toLowerCase();
    if (!known.has(command)) continue;
    const end = match.index + match[0].length;
    return {
      command,
      args: value.slice(end).trim(),
      before: value.slice(0, match.index).trim(),
    };
  }
  return null;
}

const GREETING_RE =
  /^(hola+|holi|hey|hi|hello|buenas|buen[oa]s? (dias|tardes|noches)|que tal|que mas|como (estas|estan|vas|van)|saludos|ey|epa|alo|buenas buenas)$/;
const THANKS_RE =
  /^(gracias|muchas gracias|mil gracias|thanks|thank you|genial gracias|ok gracias|perfecto gracias|listo gracias)$/;

/** "greeting", "thanks" or null for a short social message. */
export function smallTalk(text) {
  const folded = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:👋🙌😊🙂]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      / (equipo|team|bot|chicos|a todos|todos|gente|crack|amigo|amigos)$/,
      "",
    )
    .replace(/^(hola|hey|buenas) (hola|hey|buenas)$/, "$1");
  if (!folded) return null;
  if (GREETING_RE.test(folded)) return "greeting";
  if (THANKS_RE.test(folded)) return "thanks";
  return null;
}

/** An instant, natural answer to a greeting, with what the team is doing. */
export function buildGreeting({
  user = "",
  agents = [],
  project = "",
  dir = "",
}) {
  const busy = agents.filter((agent) => agent.lastStatus === "running");
  const hello = `¡Hola${user ? `, ${user}` : ""}! 👋`;
  const where = project
    ? `Estamos en ${project} (${dir}).`
    : dir
      ? `Trabajamos en ${dir}.`
      : "";
  const status = busy.length
    ? `Ahora mismo ${busy.map((agent) => `@${agent.name}`).join(", ")} ${busy.length === 1 ? "está" : "están"} trabajando.`
    : agents.length
      ? "El equipo está libre."
      : "Aún no hay agentes trabajando; los creo cuando me pidas algo.";
  return [
    `${hello} ${where} ${status}`.replace(/\s+/g, " ").trim(),
    "Cuéntame qué necesitas con tus palabras, por ejemplo:",
    "• «arma un equipo para el login con Google»",
    "• «pen, foto de la pantalla wallet»",
    "• «revisa la ux del dashboard»",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Natural group conversation: when to answer, chat context, ship
// ---------------------------------------------------------------------------

/** Distinct people (not the bot) who wrote in the log within `windowMs`. */
export function recentHumans(
  log = [],
  now = Date.now(),
  windowMs = 15 * 60_000,
) {
  return new Set(
    log
      .filter((item) => item.who !== "bot" && now - item.at <= windowMs)
      .map((item) => item.who),
  ).size;
}

const ADDRESS_RE =
  /(^|[^\p{L}\p{N}_])(bot|coordinador|coordinadora|equipo|agentes?|team|openhands|asistente)([^\p{L}\p{N}_]|$)/u;

/**
 * In a group with privacy mode off every message reaches the bridge, also
 * people talking to each other. Answer a private chat, a reply to the bot,
 * a message that names the bot, the team or one of its agents, a follow-up
 * right after the bot spoke to the same person, or any message while only
 * one person is talking with the bot. Otherwise stay quiet (it still goes to
 * the chat log, so the team has the context).
 */
export function shouldAnswer({
  chatType = "private",
  text = "",
  who = "",
  botUsername = "",
  agentNames = [],
  isReplyToBot = false,
  log = [],
  now = Date.now(),
}) {
  if (chatType === "private" || isReplyToBot) return true;
  const folded = foldText(text);
  if (botUsername && folded.includes(`@${foldText(botUsername)}`)) return true;
  if (ADDRESS_RE.test(folded)) return true;
  for (const name of agentNames) {
    const slug = foldText(name);
    if (
      slug &&
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])@?${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}_]|$)`,
        "u",
      ).test(folded)
    )
      return true;
  }
  // Earlier entries, not this message (already appended to the log).
  const before = log.filter(
    (item) =>
      !(
        item.who === who &&
        item.text === String(text).slice(0, 500) &&
        now - item.at < 5_000
      ),
  );
  const last = before.at(-1);
  if (last?.who === "bot" && now - last.at < 3 * 60_000) {
    const asker = [...before].reverse().find((item) => item.who !== "bot");
    if (!asker || asker.who === who) return true;
  }
  return recentHumans(before, now) <= 1;
}

/**
 * Recent chat lines the coordinator hasn't seen (since `sinceAt`), so it
 * answers in context: who said what, including what people said to each
 * other and what the bot already posted.
 */
export function buildChatContext(
  log = [],
  sinceAt = 0,
  { limit = 12, skipLast = true } = {},
) {
  const items = log.filter((item) => item.at > sinceAt);
  if (skipLast) items.pop();
  const recent = items.slice(-limit);
  if (!recent.length) return "";
  return [
    "Recent group chat (context; answer only the user request below):",
    ...recent.map(
      (item) =>
        `- ${item.who === "bot" ? "bridge/agents" : item.who}: ${item.text.replace(/\s+/g, " ").slice(0, 240)}`,
    ),
    "",
  ].join("\n");
}

const SHIP_RE =
  /^(?:(?:por favor|porfa|dale|ok|listo|va)[, ]+)?(?:ship(?:ea|ealo|ear|pealo|it)?|haz (?:el )?ship|shipealo|(?:abre|haz|crea|manda|arma|sube) (?:el|un|la) (?:pr|pull request)|sube (?:los cambios|esto|eso|lo hecho)|subelo|abre pr)\b[\s:,.-]*(.*)$/s;

/** "ship", "shipéalo y revisa el CI", "abre el PR con el fix" → extra text or null. */
export function shipIntent(text) {
  const match = SHIP_RE.exec(foldText(text).trim());
  if (!match) return null;
  // Keep the user's own words (accents) for the extra instructions.
  const original = String(text ?? "").trim();
  const extra = match[1]
    ? original.slice(original.length - match[1].length).trim()
    : "";
  return { extra };
}

/** The ship protocol: from local changes to a reviewed PR with green CI. */
export function buildShipPrompt(extra = "", { workingDir = "" } = {}) {
  return [
    "SHIP: take this work to a reviewed pull request with green CI. Follow the feature-branch-pr, change-safety-guard and code-quality-gate skills.",
    workingDir
      ? `Repository folder: ${workingDir} (or the worktree you used).`
      : "",
    "1. Find the changes of this task (`git status`, `safe-branch branches`). If you are on the default branch, `safe-branch start <slug>` first (with --worktree when other agents share the checkout). Never commit to the default branch.",
    "2. `safe-branch check`. Exit code 2: STOP, list each item and ask me; do nothing else until I answer.",
    "3. Commit in small Conventional Commits (`safe-branch split` to group), then `safe-branch commits` and fix what it reports (rewrite only unpushed commits).",
    "4. Verify: the project's own lint, type check, tests and build for what changed.",
    "5. Push the branch (`git push -u origin HEAD`; never force, never the default branch) and open the PR with `gh pr create` (What / Why / How / Testing / Risk; draft while checks fail). If it already has a PR, update it.",
    "6. Review your own PR diff as a strict reviewer (pr-reviewer skill) and fix real problems in new commits.",
    "7. CI: `gh pr checks --watch --fail-fast` (up to 20 minutes). On a failure read `gh run view --log-failed`, fix, push and watch again, at most 3 rounds. If the base moved and conflicts, merge the base and resolve keeping both sides' behavior.",
    "8. Never merge the PR and never enable auto-merge: merging is my call.",
    "Final answer, short: the PR link, branch, commits, CI status and anything left for me; then the VERIFICACIÓN line.",
    extra ? `My extra instructions: ${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A short, varied acknowledgment when the coordinator is still busy. */
export function queuedAck(name, text = "") {
  const options = [
    `Anotado 👍 @${name} termina lo que está haciendo y sigue con esto.`,
    `Va, en cola: @${name} lo toma apenas acabe lo actual.`,
    `Recibido. @${name} está con otra cosa; esto va justo después.`,
  ];
  let hash = 0;
  for (const char of String(text))
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return options[hash % options.length];
}

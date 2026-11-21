/**
 * Pure helpers for memory-watcher.mjs: conversation summary notes, the
 * watcher's persisted state, finding git repositories, and a minimal MCP
 * stdio client used to write notes through mcp-server-qdrant (so automatic
 * notes use exactly the same embeddings and format as the agents' own).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const SUMMARIZABLE_STATUSES = new Set(["finished", "idle", "paused"]);

export function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

export function truncate(text, max) {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** First text part of a MessageEvent's llm_message, or "". */
export function messageText(event) {
  const content = event?.llm_message?.content;
  if (!Array.isArray(content)) return "";
  const part = content.find((c) => typeof c?.text === "string" && c.text);
  return part ? part.text : "";
}

function tagsOf(conversation) {
  const tags = conversation?.tags;
  return tags && typeof tags === "object" ? tags : {};
}

/**
 * Decide whether a listed conversation needs a (new) summary. Cheap: only
 * looks at the listing, so the final response is fetched only when needed.
 */
export function needsSummary(conversation, entry) {
  if (!SUMMARIZABLE_STATUSES.has(conversation?.execution_status)) return false;
  if (!entry) return true;
  return entry.updatedAt !== conversation.updated_at;
}

/** Build the note stored in memory for one finished conversation turn. */
export function buildConversationNote({
  conversation,
  firstUserText,
  finalResponse,
}) {
  const tags = tagsOf(conversation);
  const workingDir = conversation?.workspace?.working_dir ?? "";
  const title = truncate(conversation?.title || firstUserText, 120);
  const lines = [
    `Conversation summary: ${title || conversation.id}`,
    firstUserText ? `Task: ${truncate(firstUserText, 600)}` : "",
    `Outcome (${conversation.execution_status}): ${truncate(finalResponse, 2000)}`,
    workingDir ? `Working directory: ${workingDir}` : "",
  ].filter(Boolean);
  return {
    information: lines.join("\n"),
    metadata: {
      type: "conversation-summary",
      source: "auto",
      conversation_id: conversation.id,
      ...(tags.acpserver ? { agent: tags.acpserver } : {}),
      ...(workingDir ? { working_dir: workingDir } : {}),
      updated_at: conversation.updated_at,
    },
  };
}

// ── State ────────────────────────────────────────────────────────────────────

export function loadState(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return {
      initialized: Boolean(data.initialized),
      conversations: data.conversations ?? {},
      repos: data.repos ?? {},
    };
  } catch {
    return { initialized: false, conversations: {}, repos: {} };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// ── Git repositories ─────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "graphify-out",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  "__pycache__",
]);

/** Git work trees under root, up to maxDepth levels down (root is depth 0). */
export function findGitRepos(root, maxDepth = 3) {
  const repos = [];
  const walk = (dir, depth) => {
    if (existsSync(join(dir, ".git"))) {
      repos.push(dir);
      return; // don't descend into a repo (submodules handle themselves)
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith("."))
        continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  try {
    if (statSync(root).isDirectory()) walk(root, 0);
  } catch {
    // root missing: no repos
  }
  return repos;
}

// ── Keep graphify's repo changes local ──────────────────────────────────────

function readIfExists(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Snapshot of the files `graphify hook install` may touch in a work tree. */
export function snapshotRepoFiles(repo) {
  return { gitattributes: readIfExists(join(repo, ".gitattributes")) };
}

/**
 * Undo graphify's visible changes so a user's repository shows nothing new
 * in `git status`: lines it added to `.gitattributes` move to
 * `.git/info/attributes`, and `graphify-out/` goes to `.git/info/exclude`.
 * Both files are local to the clone and never committed.
 */
export function keepGraphifyLocal(repo, before) {
  const gitDir = join(repo, ".git");
  if (!statSync(gitDir).isDirectory()) return; // worktree/submodule: skip
  const infoDir = join(gitDir, "info");
  mkdirSync(infoDir, { recursive: true });

  const attrPath = join(repo, ".gitattributes");
  const after = readIfExists(attrPath);
  if (after !== before.gitattributes) {
    const old = new Set((before.gitattributes ?? "").split(/\r?\n/));
    const added = (after ?? "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !old.has(line));
    const localPath = join(infoDir, "attributes");
    const local = readIfExists(localPath) ?? "";
    const missing = added.filter(
      (line) => !local.split(/\r?\n/).includes(line),
    );
    if (missing.length) {
      appendFileSync(
        localPath,
        `${local && !local.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
      );
    }
    if (before.gitattributes === null) rmSync(attrPath, { force: true });
    else writeFileSync(attrPath, before.gitattributes);
  }

  const excludePath = join(infoDir, "exclude");
  const exclude = readIfExists(excludePath) ?? "";
  if (!exclude.split(/\r?\n/).includes("graphify-out/")) {
    appendFileSync(
      excludePath,
      `${exclude && !exclude.endsWith("\n") ? "\n" : ""}graphify-out/\n`,
    );
  }
}

// ── MCP stdio client ─────────────────────────────────────────────────────────

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0): enough to
 * initialize a server and call tools. One request at a time is fine here.
 */
export class McpStdioClient {
  constructor({ command, args = [], env = {}, spawnImpl = spawn }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    this.proc = this.spawnImpl(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf-8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr?.on("data", () => {});
    const failAll = (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.proc = null;
    };
    this.proc.on("error", failAll);
    this.proc.on("exit", (code) =>
      failAll(new Error(`MCP server exited (${code})`)),
    );
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-canvas-memory-watcher", version: "1" },
    });
    this.notify("notifications/initialized", {});
  }

  get running() {
    return this.proc !== null;
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = msg.id != null ? this.pending.get(msg.id) : undefined;
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || "MCP error"));
      else waiter.resolve(msg.result);
    }
  }

  send(message) {
    if (!this.proc) throw new Error("MCP server is not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    if (result?.isError) {
      const text = result.content?.map((c) => c.text).join(" ") || name;
      throw new Error(`MCP tool error: ${text}`);
    }
    return result;
  }

  stop() {
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }
}

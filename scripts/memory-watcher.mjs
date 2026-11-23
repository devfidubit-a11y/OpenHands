#!/usr/bin/env node
/**
 * Memory watcher for the all-in-one container (docs/MEMORY.md).
 *
 * 1. Conversation summaries: when a conversation finishes a turn, store a
 *    short note (title, task, outcome, working dir) in the shared Qdrant
 *    memory through mcp-server-qdrant, so later agents can find it.
 * 3. Project docs: README, AGENTS.md, docs/, wiki/ and the graphify report
 *    of every repository are kept in memory (re-ingested when they change),
 *    so agents find the project's knowledge with qdrant-find.
 * 2. Graphify on commit: install graphify's git hooks in every repository
 *    under the projects folder, so each commit re-indexes the code graph
 *    (code only, no LLM), and build the first graph when there is none.
 *
 * Env:
 *   OH_AGENT_SERVER_URL, OH_SESSION_API_KEY   agent-server access
 *   QDRANT_URL                                required for summaries
 *   MEMORY_COLLECTION, MEMORY_EMBEDDING_MODEL, FASTEMBED_CACHE_PATH
 *   MEMORY_AUTO_SUMMARY=false                 turn summaries off
 *   MEMORY_SUMMARY_BACKFILL (20)              recent conversations summarized
 *                                             on the very first run
 *   MEMORY_POLL_MS (30000)                    conversation poll interval
 *   GRAPHIFY_AUTO_HOOKS=false                 turn graphify hooks off
 *   GRAPHIFY_PROJECTS_DIR (/projects), GRAPHIFY_SCAN_MS (300000)
 *   MEMORY_INGEST_DOCS=false                  turn project-doc ingestion off
 *   MEMORY_INGEST_MS (600000)                 project-doc scan interval
 *   MEMORY_WATCHER_STATE                      state file path
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";

import {
  QdrantRest,
  buildChunkNotes,
  projectDocs,
  readSourceFile,
  sha,
  storeNotes,
} from "./knowledge-lib.mjs";
import { buildMemoryMcpServer } from "./register-memory-mcp.mjs";
import {
  buildConversationNote,
  findGitRepos,
  keepGraphifyLocal,
  loadState,
  McpStdioClient,
  messageText,
  needsSummary,
  saveState,
  shortHash,
  snapshotRepoFiles,
} from "./memory-watcher-lib.mjs";

const execFileAsync = promisify(execFile);
const env = process.env;
const log = (msg) => console.log(`[memory-watcher] ${msg}`);

const base = (env.OH_AGENT_SERVER_URL || "http://127.0.0.1:18000").replace(
  /\/+$/,
  "",
);
const headers = env.OH_SESSION_API_KEY
  ? { "X-Session-API-Key": env.OH_SESSION_API_KEY }
  : {};
const statePath = env.MEMORY_WATCHER_STATE || ".memory-watcher-state.json";
const summariesOn =
  env.MEMORY_AUTO_SUMMARY !== "false" && Boolean(env.QDRANT_URL);
const hooksOn = env.GRAPHIFY_AUTO_HOOKS !== "false";
const pollMs = Number(env.MEMORY_POLL_MS) || 30_000;
const scanMs = Number(env.GRAPHIFY_SCAN_MS) || 300_000;
const backfill = Number(env.MEMORY_SUMMARY_BACKFILL ?? 20);
const docsOn = env.MEMORY_INGEST_DOCS !== "false" && Boolean(env.QDRANT_URL);
const ingestMs = Number(env.MEMORY_INGEST_MS) || 600_000;
const rest = env.QDRANT_URL
  ? new QdrantRest({
      url: env.QDRANT_URL,
      collection: env.MEMORY_COLLECTION || "agent-memory",
    })
  : null;
// Comma-separated folders; each is a repo itself or holds repos (3 levels).
const projectsDirs = (env.GRAPHIFY_PROJECTS_DIR || "/projects")
  .split(",")
  .map((dir) => dir.trim())
  .filter(Boolean);

const state = loadState(statePath);
let mcp = null;

async function api(path) {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function memoryClient() {
  if (mcp?.running) return mcp;
  const server = buildMemoryMcpServer(env);
  mcp = new McpStdioClient({ command: server.command, env: server.env });
  await mcp.start();
  return mcp;
}

async function summarize(conversation) {
  const id = conversation.id;
  const final = await api(
    `/api/conversations/${encodeURIComponent(id)}/agent_final_response`,
  );
  const finalResponse = final?.response?.trim() ?? "";
  const entry = state.conversations[id];
  const hash = shortHash(finalResponse);
  if (!finalResponse || entry?.hash === hash) {
    state.conversations[id] = { ...entry, updatedAt: conversation.updated_at };
    return false;
  }
  let firstUserText = entry?.task ?? "";
  if (!firstUserText) {
    const events = await api(
      `/api/conversations/${encodeURIComponent(id)}/events/search?source=user&limit=1`,
    );
    firstUserText = messageText(events?.items?.[0]);
  }
  const note = buildConversationNote({
    conversation,
    firstUserText,
    finalResponse,
  });
  const client = await memoryClient();
  await client.callTool("qdrant-store", note);
  state.conversations[id] = {
    updatedAt: conversation.updated_at,
    hash,
    task: firstUserText.slice(0, 600),
  };
  return true;
}

async function pollConversations() {
  const page = await api(
    "/api/conversations/search?limit=50&sort_order=UPDATED_AT_DESC",
  );
  let candidates = (page?.items ?? []).filter((c) =>
    needsSummary(c, state.conversations[c.id]),
  );
  if (!state.initialized) {
    // First run: summarize only the most recent ones, mark the rest as seen.
    const keep = new Set(candidates.slice(0, backfill).map((c) => c.id));
    for (const c of page?.items ?? []) {
      if (!keep.has(c.id)) {
        state.conversations[c.id] = { updatedAt: c.updated_at };
      }
    }
    candidates = candidates.filter((c) => keep.has(c.id));
    state.initialized = true;
  }
  let stored = 0;
  for (const c of candidates) {
    try {
      if (await summarize(c)) stored++;
    } catch (err) {
      log(`summary for ${c.id} failed: ${err.message}`);
      if (!mcp?.running) mcp = null;
    }
  }
  if (stored)
    log(`stored ${stored} conversation summar${stored === 1 ? "y" : "ies"}`);
  saveState(statePath, state);
}

async function scanRepos() {
  const repos = [
    ...new Set(projectsDirs.flatMap((dir) => findGitRepos(dir, 3))),
  ];
  for (const repo of repos) {
    if (state.repos[repo]?.hooks) continue;
    try {
      const before = snapshotRepoFiles(repo);
      await execFileAsync("graphify", ["hook", "install"], {
        cwd: repo,
        timeout: 60_000,
      });
      keepGraphifyLocal(repo, before);
      state.repos[repo] = { hooks: true, at: new Date().toISOString() };
      log(`graphify hooks installed in ${repo}`);
      if (!existsSync(join(repo, "graphify-out", "graph.json"))) {
        // First graph now; later commits keep it current through the hook.
        execFile(
          "graphify",
          ["update", "."],
          {
            cwd: repo,
            timeout: 30 * 60_000,
            env: { ...env, PYTHONHASHSEED: "0" },
          },
          (err) =>
            log(
              err
                ? `initial graph for ${repo} failed: ${err.message}`
                : `initial graph built for ${repo}`,
            ),
        );
      }
    } catch (err) {
      state.repos[repo] = { hooks: false, error: err.message.slice(0, 200) };
      log(`graphify hook install failed in ${repo}: ${err.message}`);
    }
  }
  saveState(statePath, state);
}

/**
 * Keeps each repository's docs in memory: a changed file replaces its old
 * chunks. At most 40 files per pass, so a big first import spreads out.
 */
async function ingestProjectDocs() {
  state.docs ??= {};
  const repos = [
    ...new Set(projectsDirs.flatMap((dir) => findGitRepos(dir, 3))),
  ];
  let budget = 40;
  let stored = 0;
  for (const repo of repos) {
    for (const file of projectDocs(repo)) {
      if (budget <= 0) break;
      let text;
      try {
        text = readSourceFile(file);
      } catch {
        continue;
      }
      if (!text?.trim()) continue;
      const hash = sha(text);
      if (state.docs[file] === hash) continue;
      budget -= 1;
      const notes = buildChunkNotes({
        text,
        source: file,
        title: `${basename(repo)}/${relative(repo, file)}`,
        project: basename(repo),
        kind: "project-doc",
      });
      try {
        const client = await memoryClient();
        stored += await storeNotes(notes, {
          rest,
          store: (information, metadata) =>
            client.callTool("qdrant-store", { information, metadata }),
        });
        state.docs[file] = hash;
      } catch (err) {
        log(`ingesting ${file} failed: ${err.message}`);
        if (!mcp?.running) mcp = null;
      }
    }
  }
  if (stored) log(`ingested ${stored} project-doc chunk(s)`);
  saveState(statePath, state);
}

function every(ms, fn, name) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log(`${name}: ${err.message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, ms);
}

if (!summariesOn && !hooksOn && !docsOn) {
  log("nothing to do (summaries and graphify hooks are off)");
  process.exit(0);
}
log(
  `summaries ${summariesOn ? "on" : "off"}, project docs ${docsOn ? "on" : "off"}, graphify hooks ${hooksOn ? `on (${projectsDirs.join(", ")})` : "off"}`,
);
if (summariesOn) every(pollMs, pollConversations, "conversation poll");
if (hooksOn) every(scanMs, scanRepos, "repository scan");
if (docsOn) every(ingestMs, ingestProjectDocs, "project-doc ingestion");

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    mcp?.stop();
    process.exit(0);
  });
}

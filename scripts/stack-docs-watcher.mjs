#!/usr/bin/env node
/**
 * Stack docs watcher (docs/STACK_DOCS.md). A daemon that keeps the agents'
 * knowledge of Flutter, Node, Next.js, NestJS, Python, Rust, Go, C#/.NET,
 * C++, JavaScript/TypeScript and Java current on its own:
 *
 *  1. Every STACK_DOCS_INTERVAL_H hours (default 12) it reads each stack's
 *     latest stable version from its official release feed.
 *  2. When a version changes (and on the first run) it stores that
 *     release's official "what's new" pages and the llms.txt doc index in
 *     the shared Qdrant memory (type `stack-docs`), replacing the old copy.
 *  3. It rewrites the always-on `stack-versions` note in every agent's
 *     context (OpenHands and Claude Code): the version table plus the rule
 *     to read version-specific docs through the Context7 MCP.
 *
 * Env: STACK_DOCS_STACKS (comma list, default all), STACK_DOCS_INTERVAL_H,
 * STACK_DOCS_STATE (JSON state file), QDRANT_URL / MEMORY_COLLECTION (no
 * Qdrant: only the note), STACK_DOCS_INGEST=false, CONTEXT7_MCP=false.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { alwaysOnTargets, installManagedNote } from "./agent-quality-lib.mjs";
import {
  QdrantRest,
  buildChunkNotes,
  fetchUrlText,
  storeNotes,
} from "./knowledge-lib.mjs";
import { McpStdioClient } from "./memory-watcher-lib.mjs";
import { buildMemoryMcpServer } from "./register-memory-mcp.mjs";
import {
  STACKS,
  buildStackNote,
  changedStacks,
  clipDocs,
  fetchVersions,
  selectStacks,
} from "./stack-docs-lib.mjs";

const env = process.env;
const log = (msg) => console.log(`[stack-docs] ${msg}`);
const statePath = env.STACK_DOCS_STATE || ".stack-docs-state.json";
const intervalMs =
  Math.max(Number(env.STACK_DOCS_INTERVAL_H) || 12, 1) * 3_600_000;
const keys = selectStacks(env.STACK_DOCS_STACKS);
const ingestOn = env.STACK_DOCS_INGEST !== "false" && Boolean(env.QDRANT_URL);
const rest = env.QDRANT_URL
  ? new QdrantRest({
      url: env.QDRANT_URL,
      collection: env.MEMORY_COLLECTION || "agent-memory",
    })
  : null;
const USER_AGENT = "agent-canvas-stack-docs/1";

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { versions: {}, ingested: {}, changes: [] };
  }
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function get(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

let mcp = null;
async function memoryClient() {
  if (mcp?.running) return mcp;
  const server = buildMemoryMcpServer(env);
  mcp = new McpStdioClient({ command: server.command, env: server.env });
  await mcp.start();
  return mcp;
}

/** Stores one page as `stack-docs` notes; returns the chunk count. */
async function ingestPage(key, version, url) {
  const page = await fetchUrlText(url);
  const notes = buildChunkNotes({
    text: clipDocs(page.text),
    source: page.url,
    title: `${STACKS[key].label} ${version}: ${page.title}`,
    kind: "stack-docs",
    tags: [key, `${key}@${version}`],
  });
  const client = await memoryClient();
  return storeNotes(notes, {
    rest,
    store: (information, metadata) =>
      client.callTool("qdrant-store", { information, metadata }),
  });
}

async function tick() {
  const state = loadState();
  const { versions, errors } = await fetchVersions(keys, get, state.versions);
  for (const [key, message] of Object.entries(errors))
    log(`${key}: ${message} (kept the previous version)`);
  const changed = changedStacks(state.versions, versions).filter(
    (key) => !errors[key],
  );
  const now = new Date();
  for (const key of changed) {
    const from = state.versions?.[key]?.version ?? null;
    const to = versions[key].version;
    log(`${key}: ${from ?? "(new)"} → ${to}`);
    if (from)
      state.changes = [
        ...(state.changes ?? []),
        { stack: key, from, to, at: now.toISOString() },
      ].slice(-50);
  }
  state.versions = versions;
  state.checkedAt = now.toISOString();
  state.ingested ??= {};

  if (ingestOn) {
    for (const key of keys) {
      const version = versions[key]?.version;
      if (!version || state.ingested[key] === version) continue;
      const urls = [...(versions[key].docs ?? []), ...(STACKS[key].llms ?? [])];
      let chunks = 0;
      let failed = 0;
      for (const url of urls) {
        try {
          chunks += await ingestPage(key, version, url);
        } catch (error) {
          failed += 1;
          log(`${key}: ingesting ${url} failed: ${error.message}`);
          if (!mcp?.running) mcp = null;
        }
      }
      if (failed < urls.length) {
        state.ingested[key] = version;
        log(
          `${key} ${version}: stored ${chunks} chunk(s) of release notes and docs`,
        );
      }
    }
  }
  saveState(state);

  if (env.STACK_DOCS_ALWAYS_ON !== "false") {
    const written = installManagedNote(
      {
        name: "stack-versions",
        title: "Current stack versions and live docs",
        body: buildStackNote(versions, {
          checkedAt: now,
          context7: env.CONTEXT7_MCP !== "false",
        }),
      },
      alwaysOnTargets(env, homedir()),
    );
    if (changed.length) log(`version note updated in ${written.join(", ")}`);
  }
}

let running = false;
async function safeTick() {
  if (running) return;
  running = true;
  try {
    await tick();
  } catch (error) {
    log(`check failed: ${error.message}`);
  } finally {
    running = false;
  }
}

log(
  `watching ${keys.join(", ")} every ${intervalMs / 3_600_000} h; release notes to memory ${ingestOn ? "on" : "off"}`,
);
void safeTick();
setInterval(safeTick, intervalMs);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    mcp?.stop();
    process.exit(0);
  });
}

#!/usr/bin/env node
/**
 * Register the Qdrant memory MCP server with the Agent Server once it is up.
 *
 * The Agent Server forwards its MCP servers to every agent (OpenHands and ACP
 * agents such as Claude Code), so one entry gives all agents shared memory.
 * Idempotent: an existing `qdrant_memory` entry is left as the user set it,
 * including disabled. Never fatal: it logs and exits 0 on any problem.
 *
 * Env: OH_AGENT_SERVER_URL, OH_SESSION_API_KEY, QDRANT_URL (required to run),
 * MEMORY_COLLECTION, MEMORY_EMBEDDING_MODEL, FASTEMBED_CACHE_PATH.
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MEMORY_MCP_KEY = "qdrant_memory";
export const KNOWLEDGE_MCP_KEY = "knowledge";

/**
 * The knowledge MCP server (scripts/knowledge-mcp.mjs): the graphify code
 * graph and data ingestion into the same Qdrant memory.
 */
export function buildKnowledgeMcpServer(env) {
  const memory = buildMemoryMcpServer(env);
  return {
    transport: "stdio",
    command: "node",
    args: [
      env.KNOWLEDGE_MCP_SCRIPT ||
        join(dirname(fileURLToPath(import.meta.url)), "knowledge-mcp.mjs"),
    ],
    env: {
      ...memory.env,
      KNOWLEDGE_ROOTS: env.KNOWLEDGE_ROOTS || "/projects,/documents,/workspace",
    },
    description:
      "Team knowledge: graphify code graph (graph_report, graph_explain, graph_path) and the team memory separated per topic, workspace and folder (memory_search, memory_ingest, memory_learn)",
  };
}

export function buildMemoryMcpServer(env) {
  const serverEnv = {
    QDRANT_URL: env.QDRANT_URL,
    COLLECTION_NAME: env.MEMORY_COLLECTION || "agent-memory",
    EMBEDDING_MODEL:
      env.MEMORY_EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2",

    // qdrant-find takes a query_filter: memory_search keeps each topic,
    // workspace and folder apart with it (docs/MEMORY.md).
    QDRANT_ALLOW_ARBITRARY_FILTER: "true",
  };
  if (env.FASTEMBED_CACHE_PATH) {
    serverEnv.FASTEMBED_CACHE_PATH = env.FASTEMBED_CACHE_PATH;
  }
  return { transport: "stdio", command: "mcp-server-qdrant", env: serverEnv };
}

export async function waitForServer(base, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/settings`, { headers });
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/**
 * Register one MCP server with the Agent Server under `key`, unless an entry
 * with that key exists (kept as the user set it, including disabled).
 * Returns "registered", "exists", "unreachable" or "failed".
 */
export async function registerMcpServer(
  env,
  key,
  entry,
  {
    log = console.log,
    tag = "mcp",
    timeoutMs = 180_000,
    ensureEnabled = false,
  } = {},
) {
  const base = (env.OH_AGENT_SERVER_URL || "http://127.0.0.1:18000").replace(
    /\/+$/,
    "",
  );
  const headers = { "Content-Type": "application/json" };
  if (env.OH_SESSION_API_KEY) {
    headers["X-Session-API-Key"] = env.OH_SESSION_API_KEY;
  }

  const settings = await waitForServer(base, headers, timeoutMs);
  if (!settings) {
    log(`[${tag}] Agent Server not reachable; ${key} MCP not registered`);
    return "unreachable";
  }
  const existing = settings.agent_settings?.mcp_config ?? {};
  if (existing && typeof existing === "object" && key in existing) {
    // "Always connected": a disabled entry is switched back on.
    if (ensureEnabled && existing[key]?.enabled === false) {
      const res = await fetch(
        `${base}/api/settings/mcp/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...entry, enabled: true }),
        },
      );
      log(
        res.ok
          ? `[${tag}] ${key} MCP server was disabled; enabled it again`
          : `[${tag}] re-enabling ${key} MCP failed: HTTP ${res.status}`,
      );
      return res.ok ? "enabled" : "failed";
    }
    log(`[${tag}] ${key} MCP server already configured`);
    return "exists";
  }
  const res = await fetch(
    `${base}/api/settings/mcp/${encodeURIComponent(key)}`,
    { method: "POST", headers, body: JSON.stringify(entry) },
  );
  if (!res.ok) {
    log(`[${tag}] registering ${key} MCP failed: HTTP ${res.status}`);
    return "failed";
  }
  log(`[${tag}] Registered ${key} MCP server for all agents`);
  return "registered";
}

export async function registerMemoryMcp(env = process.env, log = console.log) {
  if (!env.QDRANT_URL) {
    log("[memory] QDRANT_URL not set; skipping memory MCP registration");
    return "skipped";
  }
  // MEMORY_ALWAYS_ON=false keeps a user's "disabled" choice in Settings → MCP.
  const ensureEnabled = env.MEMORY_ALWAYS_ON !== "false";
  const memory = await registerMcpServer(
    env,
    MEMORY_MCP_KEY,
    buildMemoryMcpServer(env),
    { log, tag: "memory", ensureEnabled },
  );
  if (memory === "unreachable") return memory;
  await registerMcpServer(
    env,
    KNOWLEDGE_MCP_KEY,
    buildKnowledgeMcpServer(env),
    { log, tag: "knowledge", ensureEnabled, timeoutMs: 10_000 },
  );
  return memory;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  registerMemoryMcp().catch((err) => {
    console.log(`[memory] registration error: ${err.message}`);
  });
}

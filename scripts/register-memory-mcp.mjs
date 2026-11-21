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

import { pathToFileURL } from "node:url";

export const MEMORY_MCP_KEY = "qdrant_memory";

export function buildMemoryMcpServer(env) {
  const serverEnv = {
    QDRANT_URL: env.QDRANT_URL,
    COLLECTION_NAME: env.MEMORY_COLLECTION || "agent-memory",
    EMBEDDING_MODEL:
      env.MEMORY_EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2",
  };
  if (env.FASTEMBED_CACHE_PATH) {
    serverEnv.FASTEMBED_CACHE_PATH = env.FASTEMBED_CACHE_PATH;
  }
  return { transport: "stdio", command: "mcp-server-qdrant", env: serverEnv };
}

async function waitForServer(base, headers, timeoutMs) {
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

export async function registerMemoryMcp(env = process.env, log = console.log) {
  if (!env.QDRANT_URL) {
    log("[memory] QDRANT_URL not set; skipping memory MCP registration");
    return "skipped";
  }
  const base = (env.OH_AGENT_SERVER_URL || "http://127.0.0.1:18000").replace(
    /\/+$/,
    "",
  );
  const headers = { "Content-Type": "application/json" };
  if (env.OH_SESSION_API_KEY) {
    headers["X-Session-API-Key"] = env.OH_SESSION_API_KEY;
  }

  const settings = await waitForServer(base, headers, 180_000);
  if (!settings) {
    log("[memory] Agent Server not reachable; memory MCP not registered");
    return "unreachable";
  }
  const existing = settings.agent_settings?.mcp_config ?? {};
  if (existing && typeof existing === "object" && MEMORY_MCP_KEY in existing) {
    log("[memory] qdrant_memory MCP server already configured");
    return "exists";
  }
  const res = await fetch(
    `${base}/api/settings/mcp/${encodeURIComponent(MEMORY_MCP_KEY)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(buildMemoryMcpServer(env)),
    },
  );
  if (!res.ok) {
    log(`[memory] registering memory MCP failed: HTTP ${res.status}`);
    return "failed";
  }
  log("[memory] Registered qdrant_memory MCP server for all agents");
  return "registered";
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  registerMemoryMcp().catch((err) => {
    console.log(`[memory] registration error: ${err.message}`);
  });
}

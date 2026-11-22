#!/usr/bin/env node
/**
 * Register the pen.dev (Pencil) MCP server with the Agent Server, so every
 * agent (OpenHands and ACP agents such as Claude Code) can read and design
 * .pen files through the Pen app on the host.
 *
 * The Pen MCP server only runs on the macOS host, next to the Pen app;
 * scripts/pen-mcp-gateway.mjs exposes it over HTTP. Set PEN_MCP_URL (for
 * example http://host.docker.internal:8931/mcp) and PEN_MCP_TOKEN in
 * docker/.env. Idempotent and never fatal, like register-memory-mcp.mjs.
 */

import { pathToFileURL } from "node:url";

import { registerMcpServer } from "./register-memory-mcp.mjs";

export const PEN_MCP_KEY = "pencil";

export function buildPenMcpServer(env) {
  const entry = {
    url: env.PEN_MCP_URL,
    transport: "http",
    timeout: Number(env.PEN_MCP_TIMEOUT_MS || 300_000),
    description:
      "pen.dev (Pencil): read, design and export .pen files through the Pen app on the host",
  };
  if (env.PEN_MCP_TOKEN)
    entry.auth = { strategy: "bearer", value: env.PEN_MCP_TOKEN };
  return entry;
}

export async function registerPenMcp(env = process.env, log = console.log) {
  if (!env.PEN_MCP_URL) {
    log("[pencil] PEN_MCP_URL not set; skipping pen.dev MCP registration");
    return "skipped";
  }
  return registerMcpServer(env, PEN_MCP_KEY, buildPenMcpServer(env), {
    log,
    tag: "pencil",
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  registerPenMcp().catch((err) => {
    console.log(`[pencil] registration error: ${err.message}`);
  });
}

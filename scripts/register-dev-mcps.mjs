#!/usr/bin/env node
/**
 * Registers two MCP servers for every agent (OpenHands and ACP agents):
 *
 *  - `context7`: up-to-date, version-specific library docs for any stack
 *    (Flutter, Node, Next.js, NestJS, Python, Rust, Go, C#, C++, JS, Java…),
 *    hosted by Upstash at https://mcp.context7.com/mcp. On by default; turn
 *    off with CONTEXT7_MCP=false. CONTEXT7_API_KEY (optional) raises limits.
 *  - `simulator`: iPhone/iPad simulators and Flutter on the macOS host
 *    (scripts/sim-mcp.mjs behind the gateway). Set SIM_MCP_URL (for example
 *    http://host.docker.internal:8932/mcp) and SIM_MCP_TOKEN in docker/.env.
 *
 * Idempotent and never fatal, like register-memory-mcp.mjs.
 */

import { pathToFileURL } from "node:url";

import { registerMcpServer } from "./register-memory-mcp.mjs";

export const CONTEXT7_DEFAULT_URL = "https://mcp.context7.com/mcp";

export function buildContext7Server(env) {
  const entry = {
    url: env.CONTEXT7_MCP_URL || CONTEXT7_DEFAULT_URL,
    transport: "http",
    timeout: 60_000,
    description:
      "Context7: current, version-specific docs and code examples for libraries and frameworks (resolve-library-id, then query the docs)",
  };
  if (env.CONTEXT7_API_KEY)
    entry.auth = { strategy: "bearer", value: env.CONTEXT7_API_KEY };
  return entry;
}

export function buildSimMcpServer(env) {
  const entry = {
    url: env.SIM_MCP_URL,
    transport: "http",
    // Flutter builds for the simulator can take many minutes.
    timeout: Number(env.SIM_MCP_TIMEOUT_MS || 1_800_000),
    description:
      "iOS Simulator + Flutter on the Mac host: list/boot simulators, flutter_run_ios, screenshots, logs, UI taps",
  };
  if (env.SIM_MCP_TOKEN)
    entry.auth = { strategy: "bearer", value: env.SIM_MCP_TOKEN };
  return entry;
}

export async function registerDevMcps(env = process.env, log = console.log) {
  const results = {};
  if (env.CONTEXT7_MCP === "false") {
    log("[context7] CONTEXT7_MCP=false; skipping");
    results.context7 = "skipped";
  } else {
    results.context7 = await registerMcpServer(
      env,
      "context7",
      buildContext7Server(env),
      { log, tag: "context7" },
    );
  }
  if (!env.SIM_MCP_URL) {
    log("[simulator] SIM_MCP_URL not set; skipping simulator MCP registration");
    results.simulator = "skipped";
  } else {
    results.simulator = await registerMcpServer(
      env,
      "simulator",
      buildSimMcpServer(env),
      { log, tag: "simulator" },
    );
  }
  return results;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  registerDevMcps().catch((err) => {
    console.log(`[dev-mcps] registration error: ${err.message}`);
  });
}

#!/usr/bin/env node
/**
 * pen.dev (Pencil) MCP gateway for the agents in Docker.
 *
 * The pen.dev MCP server is a macOS binary that talks over stdio to the Pen
 * app running on the host, so agents inside the container can't start it.
 * This gateway runs on the host, starts one MCP server process per session,
 * and exposes it as MCP "Streamable HTTP" (JSON responses) that the agent
 * server (and every OpenHands or ACP agent) can reach at
 * http://host.docker.internal:<port>/mcp.
 *
 * No dependencies. It listens on 127.0.0.1 only and, when PEN_MCP_TOKEN is
 * set, requires `Authorization: Bearer <token>`.
 *
 *   PEN_MCP_TOKEN=... node scripts/pen-mcp-gateway.mjs
 *
 * Env: PEN_MCP_BIN (the Pen MCP binary), PEN_MCP_ARGS (default
 * "--app desktop --agent openhands"), PEN_MCP_PORT (8931), PEN_MCP_HOST
 * (127.0.0.1), PEN_MCP_TOKEN, PEN_MCP_TIMEOUT_MS (300000),
 * PEN_MCP_IDLE_MS (3600000).
 */

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const DEFAULT_PEN_MCP_BIN =
  "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64";

export function gatewayConfig(env = process.env) {
  return {
    bin: env.PEN_MCP_BIN || DEFAULT_PEN_MCP_BIN,
    args: (env.PEN_MCP_ARGS || "--app desktop --agent openhands")
      .split(/\s+/)
      .filter(Boolean),
    host: env.PEN_MCP_HOST || "127.0.0.1",
    port: Number(env.PEN_MCP_PORT || 8931),
    token: env.PEN_MCP_TOKEN || "",
    timeoutMs: Number(env.PEN_MCP_TIMEOUT_MS || 300_000),
    idleMs: Number(env.PEN_MCP_IDLE_MS || 3_600_000),
  };
}

/** True when the request carries the expected bearer token (or none is set). */
export function authorized(header, token) {
  if (!token) return true;
  const match = /^Bearer\s+(.+)$/i.exec(String(header ?? ""));
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const isRequest = (message) =>
  message && typeof message.method === "string" && message.id !== undefined;
const isResponse = (message) =>
  message &&
  message.method === undefined &&
  message.id !== undefined &&
  ("result" in message || "error" in message);

/**
 * One MCP server process. Writes JSON-RPC lines to its stdin and resolves
 * pending requests from its stdout. Requests the server sends to the client
 * (sampling, roots, elicitation) can't be forwarded over JSON responses, so
 * they get a "method not found" error.
 */
export class StdioSession {
  constructor({ bin, args, spawnFn = spawn, log = () => {} }) {
    this.id = randomUUID();
    this.pending = new Map();
    this.lastUsed = Date.now();
    this.closed = false;
    this.child = spawnFn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.onLine(line);
      }
    });
    this.child.stderr?.on("data", (chunk) =>
      log(`[pen ${this.id.slice(0, 8)}] ${String(chunk).trim()}`),
    );
    this.child.on("exit", () => this.close("MCP server process exited"));
    this.child.on("error", (error) => this.close(error.message));
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (isResponse(message)) {
      const waiter = this.pending.get(String(message.id));
      if (waiter) {
        this.pending.delete(String(message.id));
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    } else if (isRequest(message)) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Not supported by the gateway" },
      });
    }
  }

  write(message) {
    if (this.closed) throw new Error("session closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends one message; resolves with the response for requests, else null. */
  send(message, timeoutMs) {
    this.lastUsed = Date.now();
    if (!isRequest(message)) {
      this.write(message);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const key = String(message.id);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32001, message: "Request timed out" },
        });
      }, timeoutMs);
      this.pending.set(key, { resolve, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        resolve({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: error.message },
        });
      }
    });
  }

  close(reason = "session closed") {
    if (this.closed) return;
    this.closed = true;
    for (const [key, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        jsonrpc: "2.0",
        id: key,
        error: { code: -32000, message: reason },
      });
    }
    this.pending.clear();
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

export function createGateway(
  config,
  { spawnFn = spawn, log = () => {} } = {},
) {
  const sessions = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        sessions: sessions.size,
        bin: existsSync(config.bin),
      });
    }
    if (url.pathname !== "/mcp")
      return sendJson(res, 404, { error: "not found" });
    if (!authorized(req.headers.authorization, config.token)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    const sessionId = req.headers["mcp-session-id"];
    if (req.method === "DELETE") {
      sessions.get(sessionId)?.close();
      sessions.delete(sessionId);
      return sendJson(res, 200);
    }
    if (req.method !== "POST") {
      // No server-initiated stream: clients fall back to POST only.
      return sendJson(
        res,
        405,
        { error: "method not allowed" },
        { Allow: "POST, DELETE" },
      );
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    let session = sessionId ? sessions.get(sessionId) : null;
    const initializing = messages.some((item) => item?.method === "initialize");
    if (!session && initializing) {
      if (!existsSync(config.bin) && spawnFn === spawn) {
        return sendJson(res, 503, {
          error: `Pen MCP binary not found: ${config.bin}`,
        });
      }
      session = new StdioSession({
        bin: config.bin,
        args: config.args,
        spawnFn,
        log,
      });
      sessions.set(session.id, session);
      log(
        `[gateway] session ${session.id.slice(0, 8)} started (${sessions.size} open)`,
      );
    }
    if (!session || session.closed) {
      if (session) sessions.delete(session.id);
      return sendJson(res, 404, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Session not found" },
      });
    }
    const results = (
      await Promise.all(
        messages.map((item) => session.send(item, config.timeoutMs)),
      )
    ).filter(Boolean);
    const headers = { "Mcp-Session-Id": session.id };
    if (results.length === 0) return sendJson(res, 202, undefined, headers);
    return sendJson(
      res,
      200,
      Array.isArray(payload) ? results : results[0],
      headers,
    );
  });

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.closed || now - session.lastUsed > config.idleMs) {
        session.close("idle");
        sessions.delete(id);
      }
    }
  }, 60_000);
  reaper.unref();
  server.on("close", () => {
    clearInterval(reaper);
    for (const session of sessions.values()) session.close("gateway stopped");
    sessions.clear();
  });
  return { server, sessions };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = gatewayConfig();
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  if (!config.token)
    log("[gateway] warning: PEN_MCP_TOKEN is not set; no auth");
  const { server } = createGateway(config, { log });
  server.listen(config.port, config.host, () =>
    log(`[gateway] pen.dev MCP on http://${config.host}:${config.port}/mcp`),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

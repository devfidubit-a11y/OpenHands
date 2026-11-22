import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  authorized,
  createGateway,
  gatewayConfig,
} from "../../scripts/pen-mcp-gateway.mjs";
import {
  buildPenMcpServer,
  registerPenMcp,
} from "../../scripts/register-pen-mcp.mjs";

/** A fake MCP stdio server: answers initialize and tools/list. */
function fakeSpawn() {
  const spawned: unknown[] = [];
  const spawnFn = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit");
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.id === undefined) continue;
        const result =
          message.method === "initialize"
            ? { serverInfo: { name: "pencil" } }
            : { tools: [{ name: "get_app_state" }] };
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`,
        );
      }
    });
    spawned.push(child);
    return child;
  };
  return { spawnFn, spawned };
}

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

async function start(token = "secret") {
  const { spawnFn, spawned } = fakeSpawn();
  const config = { ...gatewayConfig({}), token, port: 0, timeoutMs: 2000 };
  const { server, sessions } = createGateway(config, { spawnFn });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, sessions, spawned };
}

const post = (url: string, body: unknown, headers: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("pen.dev MCP gateway", () => {
  it("checks the bearer token", () => {
    expect(authorized("Bearer secret", "secret")).toBe(true);
    expect(authorized("Bearer nope", "secret")).toBe(false);
    expect(authorized(undefined, "secret")).toBe(false);
    expect(authorized(undefined, "")).toBe(true);
  });

  it("defaults to loopback and the Pen app binary", () => {
    const config = gatewayConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8931);
    expect(config.bin).toMatch(/Pen\.app/);
    expect(config.args).toEqual(["--app", "desktop", "--agent", "openhands"]);
  });

  it("proxies a session over HTTP to one stdio process", async () => {
    const { url, sessions, spawned } = await start();
    const auth = { Authorization: "Bearer secret" };
    expect((await post(url, {}, {})).status).toBe(401);

    const init = await post(
      url,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      auth,
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id")!;
    expect(sessionId).toBeTruthy();
    expect((await init.json()).result.serverInfo.name).toBe("pencil");

    const headers = { ...auth, "Mcp-Session-Id": sessionId };
    const notified = await post(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      headers,
    );
    expect(notified.status).toBe(202);
    const tools = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      headers,
    );
    expect((await tools.json()).result.tools[0].name).toBe("get_app_state");
    expect(spawned).toHaveLength(1);

    const unknown = await post(
      url,
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { ...auth, "Mcp-Session-Id": "nope" },
    );
    expect(unknown.status).toBe(404);

    await fetch(url, { method: "DELETE", headers });
    expect(sessions.size).toBe(0);
  });
});

describe("pen.dev MCP registration", () => {
  it("builds a bearer-authenticated HTTP entry", () => {
    expect(
      buildPenMcpServer({
        PEN_MCP_URL: "http://host.docker.internal:8931/mcp",
        PEN_MCP_TOKEN: "t",
      }),
    ).toMatchObject({
      url: "http://host.docker.internal:8931/mcp",
      transport: "http",
      auth: { strategy: "bearer", value: "t" },
      timeout: 300000,
    });
  });

  it("skips without PEN_MCP_URL", async () => {
    expect(await registerPenMcp({}, () => {})).toBe("skipped");
  });
});

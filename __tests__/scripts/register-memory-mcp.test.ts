// @ts-nocheck -- tests a plain-JS script: allowJs infers `= null` defaults as type null.
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error -- plain ESM script without type declarations
import { registerMemoryMcp } from "../../scripts/register-memory-mcp.mjs";

const env = {
  QDRANT_URL: "http://qdrant:6333",
  OH_AGENT_SERVER_URL: "http://agent:18000/",
  OH_SESSION_API_KEY: "key",
  FASTEMBED_CACHE_PATH: "/cache",
};

function mockServer(mcpConfig: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ agent_settings: { mcp_config: mcpConfig } }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("registerMemoryMcp", () => {
  it("adds the Qdrant memory server when it is missing", async () => {
    const calls = mockServer({ github: { transport: "http" } });

    const result = await registerMemoryMcp(env, () => {});

    expect(result).toBe("registered");
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe("http://agent:18000/api/settings/mcp/qdrant_memory");
    expect(
      (post?.init?.headers as Record<string, string>)["X-Session-API-Key"],
    ).toBe("key");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      transport: "stdio",
      command: "mcp-server-qdrant",
      env: {
        QDRANT_URL: "http://qdrant:6333",
        COLLECTION_NAME: "agent-memory",
        EMBEDDING_MODEL: "sentence-transformers/all-MiniLM-L6-v2",
        QDRANT_ALLOW_ARBITRARY_FILTER: "true",
        FASTEMBED_CACHE_PATH: "/cache",
      },
    });
  });

  it("keeps memory always on: a disabled entry is enabled again", async () => {
    const calls = mockServer({ qdrant_memory: { enabled: false } });

    expect(await registerMemoryMcp(env, () => {})).toBe("enabled");
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true);
  });

  it("leaves a disabled entry alone with MEMORY_ALWAYS_ON=false", async () => {
    const calls = mockServer({ qdrant_memory: { enabled: false } });

    expect(
      await registerMemoryMcp({ ...env, MEMORY_ALWAYS_ON: "false" }, () => {}),
    ).toBe("exists");
    expect(
      calls.some(
        (c) =>
          c.url.includes("qdrant_memory") &&
          ["POST", "PATCH"].includes(c.init?.method ?? ""),
      ),
    ).toBe(false);
  });

  it("does nothing without QDRANT_URL", async () => {
    const calls = mockServer({});

    expect(await registerMemoryMcp({ ...env, QDRANT_URL: "" }, () => {})).toBe(
      "skipped",
    );
    expect(calls).toHaveLength(0);
  });
});

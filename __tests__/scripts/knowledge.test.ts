import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  QdrantRest,
  allowedUrl,
  buildChunkNotes,
  buildLessonNote,
  chunkText,
  findRepoRoot,
  htmlToText,
  ingestSource,
  ingestible,
  projectDocs,
} from "../../scripts/knowledge-lib.mjs";
import {
  KNOWLEDGE_TOOLS,
  createKnowledgeHandlers,
  handleKnowledgeMessage,
} from "../../scripts/knowledge-mcp.mjs";
import {
  buildKnowledgeMcpServer,
  registerMcpServer,
} from "../../scripts/register-memory-mcp.mjs";

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fakeStore() {
  const notes: { information: string; metadata: Record<string, unknown> }[] =
    [];
  return {
    notes,
    store: async (information: string, metadata: Record<string, unknown>) => {
      notes.push({ information, metadata });
    },
  };
}

describe("chunking and reading", () => {
  it("splits long text into overlapping chunks at paragraph breaks", () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`,
    ).join("\n\n");
    const chunks = chunkText(text, 1000, 100);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunkText("short")).toEqual(["short"]);
  });

  it("never reads secrets or binaries", () => {
    expect(ingestible("docs/guide.md")).toBe(true);
    expect(ingestible(".env")).toBe(false);
    expect(ingestible("config/.env.production")).toBe(false);
    expect(ingestible(".env.example")).toBe(true);
    expect(ingestible("keys/server.pem")).toBe(false);
    expect(ingestible("logo.png")).toBe(false);
  });

  it("strips HTML to text", () => {
    expect(
      htmlToText(
        "<style>x{}</style><h1>Hola</h1><p>a &amp; b</p><script>evil()</script>",
      ),
    ).toBe("Hola\n a & b");
  });

  it("only fetches public http(s) URLs", () => {
    expect(allowedUrl("https://example.com/doc")).not.toBeNull();
    for (const url of [
      "file:///etc/passwd",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://169.254.169.254/latest",
      "http://10.0.0.5",
      "http://qdrant.internal",
    ]) {
      expect(allowedUrl(url)).toBeNull();
    }
  });
});

describe("ingestSource", () => {
  it("ingests a folder, skipping secrets and build output, and replaces old chunks", async () => {
    const root = tempDir();
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "node_modules/x"), { recursive: true });
    writeFileSync(join(root, "docs/guide.md"), "# Guide\nHow to deploy.");
    writeFileSync(join(root, ".env"), "API_KEY=secret");
    writeFileSync(join(root, "node_modules/x/index.js"), "nope");
    const deleted: string[] = [];
    const rest = {
      deleteSource: async (source: string) => deleted.push(source),
    };
    const { notes, store } = fakeStore();
    const result = await ingestSource(root, {
      store,
      rest,
      project: "dracma",
      allowedRoots: [root],
    });
    expect(result).toMatchObject({ sources: 1, chunks: 1 });
    expect(notes[0].information).toContain("[document · dracma] docs/guide.md");
    expect(notes[0].metadata).toMatchObject({
      type: "document",
      project: "dracma",
    });
    expect(deleted).toEqual([join(root, "docs/guide.md")]);
  });

  it("refuses paths outside the allowed roots", async () => {
    const { store } = fakeStore();
    await expect(
      ingestSource("/etc", { store, allowedRoots: ["/projects"] }),
    ).rejects.toThrow("fuera de las carpetas");
  });

  it("ingests a web page", async () => {
    const { notes, store } = fakeStore();
    const fetchImpl = async () =>
      new Response(
        "<html><title>Docs</title><body><p>Rate limit is 100/min.</p></body></html>",
        {
          headers: { "content-type": "text/html" },
        },
      );
    const result = await ingestSource("https://example.com/docs", {
      store,
      fetchImpl,
    });
    expect(result.chunks).toBe(1);
    expect(notes[0].information).toContain("Rate limit is 100/min.");
    expect(notes[0].metadata).toMatchObject({
      type: "web",
      source: "https://example.com/docs",
    });
  });
});

describe("project knowledge", () => {
  it("picks a repo's docs and finds its root", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "docs/adr"), { recursive: true });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "README.md"), "# Repo");
    writeFileSync(join(repo, "docs/adr/001.md"), "Decision");
    writeFileSync(join(repo, "src/app.ts"), "code");
    expect(
      projectDocs(repo).map((file) => file.slice(repo.length + 1)),
    ).toEqual(["README.md", "docs/adr/001.md"]);
    expect(findRepoRoot(join(repo, "src/app.ts"))).toBe(repo);
  });

  it("builds lesson and chunk notes with metadata", () => {
    const lesson = buildLessonNote({
      lesson: "Run vitest with --run in CI.",
      project: "web",
      origin: "feedback",
    });
    expect(lesson.document).toBe("[lesson · web] Run vitest with --run in CI.");
    expect(lesson.metadata).toMatchObject({
      type: "lesson",
      origin: "feedback",
      project: "web",
    });
    const [chunk] = buildChunkNotes({
      text: "hello",
      source: "a.md",
      kind: "project-doc",
      project: "web",
    });
    expect(chunk.metadata).toMatchObject({
      type: "project-doc",
      chunk: 1,
      chunks: 1,
    });
  });

  it("deletes a source's chunks through Qdrant REST", async () => {
    const calls: { url: string; body: string }[] = [];
    const rest = new QdrantRest({
      url: "http://qdrant:6333/",
      collection: "agent-memory",
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        return new Response(JSON.stringify({ result: { count: 3 } }));
      },
    });
    await rest.deleteSource("a.md");
    expect(calls[0].url).toBe(
      "http://qdrant:6333/collections/agent-memory/points/delete?wait=true",
    );
    expect(JSON.parse(calls[0].body).filter.must[0]).toEqual({
      key: "metadata.source",
      match: { value: "a.md" },
    });
    expect(await rest.count()).toBe(3);
  });
});

describe("knowledge MCP server", () => {
  it("lists its tools and stores lessons through qdrant-store", async () => {
    const stored: unknown[] = [];
    const qdrant = {
      running: true,
      callTool: async (name: string, args: unknown) =>
        stored.push([name, args]),
    };
    const handlers = createKnowledgeHandlers(
      { QDRANT_URL: "http://q" },
      { qdrant, rest: { deleteSource: async () => null } },
    );
    const list = await handleKnowledgeMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      handlers,
    );
    expect(
      list.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(KNOWLEDGE_TOOLS.map((tool) => tool.name));
    const reply = await handleKnowledgeMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory_learn",
          arguments: { lesson: "Use pnpm here.", project: "web" },
        },
      },
      handlers,
    );
    expect(reply.result.content[0].text).toContain("Lección guardada");
    expect(stored[0]).toEqual([
      "qdrant-store",
      expect.objectContaining({ information: "[lesson · web] Use pnpm here." }),
    ]);
  });

  it("reports tool errors as MCP errors, not crashes", async () => {
    const handlers = createKnowledgeHandlers({}, { qdrant: null, rest: null });
    const reply = await handleKnowledgeMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memory_ingest", arguments: { source: "/x" } },
      },
      handlers,
    );
    expect(reply.result.isError).toBe(true);
  });
});

describe("registration", () => {
  it("builds the knowledge server entry with the memory settings", () => {
    const entry = buildKnowledgeMcpServer({
      QDRANT_URL: "http://q:6333",
      KNOWLEDGE_MCP_SCRIPT: "/opt/k.mjs",
    });
    expect(entry).toMatchObject({
      transport: "stdio",
      command: "node",
      args: ["/opt/k.mjs"],
    });
    expect(entry.env).toMatchObject({
      QDRANT_URL: "http://q:6333",
      COLLECTION_NAME: "agent-memory",
    });
  });

  it("re-enables a disabled entry when asked to keep memory always on", async () => {
    const calls: { method: string; body?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", body: init.body as string });
      return new Response(
        JSON.stringify({
          agent_settings: { mcp_config: { knowledge: { enabled: false } } },
        }),
      );
    }) as typeof fetch;
    try {
      const result = await registerMcpServer(
        {},
        "knowledge",
        { command: "node" },
        { log: () => {}, ensureEnabled: true },
      );
      expect(result).toBe("enabled");
      expect(calls[1]).toEqual({
        method: "PATCH",
        body: JSON.stringify({ command: "node", enabled: true }),
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

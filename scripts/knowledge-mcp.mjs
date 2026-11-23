#!/usr/bin/env node
/**
 * `knowledge` MCP server (stdio) for every agent: the graphify code graph
 * and data ingestion into the shared Qdrant memory (docs/MEMORY.md).
 *
 * Tools: graph_report, graph_explain, graph_path, graph_update,
 * memory_search, memory_ingest, memory_learn, memory_status. Every note
 * records its chat/topic (`scope`), workspace (repo root) and folder, and
 * memory_search only looks inside them, so topics and projects stay apart.
 *
 * Env: QDRANT_URL, MEMORY_COLLECTION, MEMORY_EMBEDDING_MODEL,
 * FASTEMBED_CACHE_PATH, KNOWLEDGE_ROOTS (folders memory_ingest may read,
 * default /projects,/documents,/workspace).
 */

import { pathToFileURL } from "node:url";

import {
  MEMORY_LEVELS,
  QdrantRest,
  buildLessonNote,
  findRepoRoot,
  graphReport,
  ingestSource,
  memoryFilter,
  memoryWhere,
  runGraphify,
  storeNotes,
} from "./knowledge-lib.mjs";
import { McpStdioClient } from "./memory-watcher-lib.mjs";
import { buildMemoryMcpServer } from "./register-memory-mcp.mjs";

export const KNOWLEDGE_TOOLS = [
  {
    name: "graph_report",
    description:
      "Read the project's code knowledge graph report (graphify GRAPH_REPORT.md): modules, communities, key nodes and how they connect. Call it before exploring an unfamiliar codebase. Builds the graph when it's missing.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Any folder or file inside the project",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "graph_explain",
    description:
      "Explain one node of the code graph (a file, class, function or concept) and its neighbors.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, node: { type: "string" } },
      required: ["path", "node"],
    },
  },
  {
    name: "graph_path",
    description:
      "Shortest path between two nodes of the code graph: how A reaches B.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["path", "from", "to"],
    },
  },
  {
    name: "graph_update",
    description:
      "Re-index the project's code graph after big changes (code only, no LLM).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "memory_search",
    description:
      "Search the team memory of YOUR topic, workspace and folder (past decisions, lessons, docs, earlier conversations). Use it instead of qdrant-find: it never mixes other projects or chats in. level: tema (default: this chat/topic plus what this workspace shares), carpeta (this folder only), workspace (the whole repository), todo (everything, only when asked).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: {
          type: "string",
          description:
            "Your working folder (absolute). Sets the workspace and folder the note belongs to.",
        },
        scope: {
          type: "string",
          description:
            "Your chat/topic memory scope, when the task gave you one",
        },
        level: { type: "string", enum: MEMORY_LEVELS },
      },
      required: ["query", "path"],
    },
  },
  {
    name: "memory_ingest",
    description:
      "Ingest data into the shared team memory: a file, a folder (text, docs and code; secrets and build output are skipped) or a public URL. Chunks are searchable with qdrant-find. Re-ingesting a source replaces it.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Absolute path or https URL" },
        project: { type: "string" },
        path: {
          type: "string",
          description:
            "Your working folder (absolute). Sets the workspace and folder the note belongs to.",
        },
        scope: {
          type: "string",
          description:
            "Your chat/topic memory scope, when the task gave you one",
        },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["source"],
    },
  },
  {
    name: "memory_learn",
    description:
      "Save a durable lesson for the whole team (a decision, a gotcha, a fix that worked, a convention). One clear sentence or two; include the project.",
    inputSchema: {
      type: "object",
      properties: {
        lesson: { type: "string" },
        project: { type: "string" },
        path: {
          type: "string",
          description:
            "Your working folder (absolute). Sets the workspace and folder the note belongs to.",
        },
        scope: {
          type: "string",
          description:
            "Your chat/topic memory scope, when the task gave you one",
        },
        evidence: {
          type: "string",
          description: "path:line, PR, command output",
        },
      },
      required: ["lesson"],
    },
  },
  {
    name: "memory_status",
    description:
      "How much the team memory holds, per kind (summaries, documents, web pages, lessons); with path, only for that workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
];

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });

export function createKnowledgeHandlers(
  env = process.env,
  { qdrant = null, rest = null } = {},
) {
  let client = qdrant;
  const memory = async () => {
    if (client?.running !== false && client) return client;
    const server = buildMemoryMcpServer(env);
    client = new McpStdioClient({ command: server.command, env: server.env });
    await client.start();
    return client;
  };
  const restClient =
    rest ??
    (env.QDRANT_URL
      ? new QdrantRest({
          url: env.QDRANT_URL,
          collection: env.MEMORY_COLLECTION || "agent-memory",
        })
      : null);
  const store = async (information, metadata) =>
    (await memory()).callTool("qdrant-store", { information, metadata });
  const roots = (env.KNOWLEDGE_ROOTS || "/projects,/documents,/workspace")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const repoOf = (path) => {
    const repo = findRepoRoot(path ?? "");
    if (!repo) throw new Error(`no encuentro un repositorio en ${path}`);
    return repo;
  };
  const graphFile = (repo) => `${repo}/graphify-out/graph.json`;

  return {
    async graph_report({ path }) {
      return text((await graphReport(path)).text);
    },
    async graph_explain({ path, node }) {
      const repo = repoOf(path);
      return text(
        (
          await runGraphify(
            ["explain", String(node), "--graph", graphFile(repo)],
            repo,
            60_000,
          )
        ).output || "(sin resultado)",
      );
    },
    async graph_path({ path, from, to }) {
      const repo = repoOf(path);
      return text(
        (
          await runGraphify(
            [
              "path",
              String(from),
              String(to),
              "--graph",
              graphFile(repo),
              "--undirected",
            ],
            repo,
            60_000,
          )
        ).output || "(sin camino)",
      );
    },
    async graph_update({ path }) {
      const repo = repoOf(path);
      const result = await runGraphify(["update", repo], repo, 30 * 60_000);
      return text(
        result.ok
          ? `Grafo actualizado en ${repo}.`
          : `graphify update falló: ${result.output.slice(-800)}`,
      );
    },
    async memory_search({ query, path, scope = null, level = "tema" }) {
      if (!String(query ?? "").trim()) throw new Error("query is empty");
      if (!MEMORY_LEVELS.includes(level))
        throw new Error(`level must be one of ${MEMORY_LEVELS.join(", ")}`);
      const where = memoryWhere({ scope, folder: path });
      const filter = memoryFilter(where, level);
      const result = await (
        await memory()
      ).callTool("qdrant-find", {
        query: String(query),
        ...(filter ? { query_filter: filter } : {}),
      });
      const found = (result?.content ?? [])
        .map((item) => item.text)
        .join("\n")
        .trim();
      const place =
        level === "todo" || !where.workspace
          ? "toda la memoria"
          : level === "carpeta"
            ? where.folder
            : `${where.workspace}${level === "tema" && where.scope ? ` · tema ${where.scope}` : ""}`;
      return text(
        found && !/^No information found/i.test(found)
          ? `Memoria (${place}):\n${found}`
          : `Nada en la memoria de ${place}.`,
      );
    },
    async memory_ingest({
      source,
      project = null,
      tags = [],
      path = null,
      scope = null,
    }) {
      if (!env.QDRANT_URL)
        throw new Error("la memoria (QDRANT_URL) no está configurada");
      const result = await ingestSource(source, {
        store,
        rest: restClient,
        project,
        tags,
        scope,
        folder: path,
        allowedRoots: /^https?:/i.test(source) ? [] : roots,
      });
      return text(
        `Ingerido: ${result.sources} fuente(s), ${result.chunks} fragmento(s)${result.skipped.length ? `; omitidos ${result.skipped.length} (binarios, secretos o vacíos)` : ""}. Búscalo con qdrant-find.`,
      );
    },
    async memory_learn({
      lesson,
      project = null,
      evidence = "",
      path = null,
      scope = null,
    }) {
      if (!String(lesson ?? "").trim()) throw new Error("lesson is empty");
      const note = buildLessonNote({
        lesson,
        project,
        evidence,
        origin: "agent",
        where: memoryWhere({ scope, folder: path }),
      });
      await storeNotes([note], { store, rest: restClient });
      return text(
        "Lección guardada en la memoria de este workspace (y tema, si lo diste).",
      );
    },
    async memory_status({ path = null } = {}) {
      if (!restClient)
        return text("La memoria (QDRANT_URL) no está configurada.");
      const filter = path
        ? memoryFilter(memoryWhere({ folder: path }), "workspace")
        : null;
      const counts = await restClient.countByType(
        ["conversation-summary", "document", "web", "lesson", "project-doc"],
        filter,
      );
      const total = await restClient.count(filter);
      return text(
        `Memoria${filter ? ` de ${filter.must[0].match.value}` : ""}: ${total} notas. ${Object.entries(
          counts,
        )
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ")}.`,
      );
    },
  };
}

/** Handles one JSON-RPC message; returns the response or null. */
export async function handleKnowledgeMessage(message, handlers) {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return reply({
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "knowledge", version: "1" },
    });
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: KNOWLEDGE_TOOLS });
  if (method === "tools/call") {
    const handler = handlers[params?.name];
    if (!handler)
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool ${params?.name}` },
      };
    try {
      return reply(await handler(params?.arguments ?? {}));
    } catch (error) {
      return reply({
        isError: true,
        content: [{ type: "text", text: error.message }],
      });
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const handlers = createKnowledgeHandlers();
  const inFlight = new Set();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const task = handleKnowledgeMessage(message, handlers).then(
        (response) => {
          if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
        },
      );
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    }
  });
  // The client closed stdin: answer what is in flight, then exit.
  process.stdin.on("end", async () => {
    await Promise.allSettled([...inFlight]);
    process.exit(0);
  });
}

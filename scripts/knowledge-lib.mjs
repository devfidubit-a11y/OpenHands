/**
 * Knowledge for the agents: ingest data (files, folders, URLs, Telegram
 * uploads) into the shared Qdrant memory, keep each project's docs indexed,
 * store lessons, and query the graphify code graph. Used by the knowledge
 * MCP server, the memory watcher and the Telegram bridge (docs/MEMORY.md).
 *
 * Notes are written through mcp-server-qdrant (`qdrant-store`), so they use
 * the same embeddings and format the agents search with `qdrant-find`.
 * Re-ingesting a source first deletes its old chunks over Qdrant's REST API.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export const CHUNK_CHARS = 1800;
export const CHUNK_OVERLAP = 200;
export const MAX_FILE_BYTES = 2_000_000;
export const MAX_FOLDER_FILES = 300;
export const MAX_URL_BYTES = 3_000_000;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env.example",
  ".html",
  ".htm",
  ".xml",
  ".sql",
  ".graphql",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".php",
  ".cs",
  ".css",
  ".scss",
  ".sh",
  ".tf",
  ".prisma",
  ".proto",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "graphify-out",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "vendor",
]);
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|credentials.*|secrets?\..*)$/i;

export const sha = (text) =>
  createHash("sha256").update(String(text)).digest("hex").slice(0, 16);

/** True for files ingestion may read: text-like, small, never secrets. */
export function ingestible(path, size = 0) {
  const name = path.toLowerCase();
  if (SECRET_FILE.test(name) && !name.endsWith(".env.example")) return false;
  if (size > MAX_FILE_BYTES) return false;
  if (name.endsWith(".env.example")) return true;
  return (
    TEXT_EXTENSIONS.has(extname(name)) ||
    /(^|\/)(readme|license|changelog|dockerfile|makefile)$/i.test(name)
  );
}

/** Plain text from HTML: no scripts, styles or tags. */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Splits text in overlapping chunks, preferring paragraph boundaries. */
export function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const value = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!value) return [];
  if (value.length <= size) return [value];
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + size, value.length);
    if (end < value.length) {
      const window = value.slice(start, end);
      const cut = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
      );
      if (cut > size * 0.5) end = start + cut + 1;
    }
    chunks.push(value.slice(start, end).trim());
    if (end >= value.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

/** Lists the ingestible files of a folder (skips build output and secrets). */
export function listFiles(root, max = MAX_FOLDER_FILES) {
  const files = [];
  const walk = (dir) => {
    if (files.length >= max) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= max) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
          walk(path);
      } else if (entry.isFile()) {
        const size = statSync(path).size;
        if (ingestible(relative(root, path), size)) files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

/** The docs of a repository worth keeping in memory (watcher ingestion). */
export function projectDocs(repo, max = 120) {
  const picks = [];
  for (const name of [
    "README.md",
    "README",
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    "CHANGELOG.md",
  ]) {
    if (existsSync(join(repo, name))) picks.push(join(repo, name));
  }
  const report = join(repo, "graphify-out", "GRAPH_REPORT.md");
  if (existsSync(report)) picks.push(report);
  for (const dir of ["docs", "doc", "wiki", "adr", ".wiki"]) {
    const path = join(repo, dir);
    if (!existsSync(path)) continue;
    for (const file of listFiles(path, max)) {
      if (/\.(md|mdx|txt|rst|adoc)$/i.test(file)) picks.push(file);
    }
  }
  return [...new Set(picks)].slice(0, max);
}

// ---------------------------------------------------------------------------
// Where a note belongs: chat/topic, workspace and folder
// ---------------------------------------------------------------------------

/**
 * The place a note belongs to, so each topic, workspace and folder keeps its
 * own memory. `scope` is the chat or forum topic ("-100…" or "-100…:7"),
 * `folder` the working folder; `workspace` is its repository root (or the
 * folder itself when it is not a repository).
 */
export function memoryWhere({ scope = null, folder = null } = {}) {
  const dir = folder ? resolve(String(folder)) : null;
  return {
    scope: scope ? String(scope) : null,
    workspace: dir ? (findRepoRoot(dir) ?? dir) : null,
    folder: dir,
  };
}

function scopeFields(where) {
  if (!where) return {};
  const fields = {};
  for (const key of ["scope", "workspace", "folder"])
    if (where[key]) fields[key] = where[key];
  return fields;
}

export const MEMORY_LEVELS = ["tema", "carpeta", "workspace", "todo"];

/**
 * Qdrant filter for a search at one level:
 * - tema: this workspace, and notes of this chat/topic or shared by the
 *   workspace (project docs, notes without a chat);
 * - carpeta: notes of this exact folder;
 * - workspace: everything of this repository;
 * - todo: no filter.
 * Without a workspace there is nothing to separate by, so it's unfiltered.
 */
export function memoryFilter(where, level = "tema") {
  const { scope, workspace, folder } = where ?? {};
  if (level === "todo" || !workspace) return null;
  if (level === "carpeta" && folder)
    return { must: [{ key: "metadata.folder", match: { value: folder } }] };
  const must = [{ key: "metadata.workspace", match: { value: workspace } }];
  if (level === "tema" && scope)
    return {
      must,
      should: [
        { key: "metadata.scope", match: { value: scope } },
        { is_empty: { key: "metadata.scope" } },
      ],
    };
  return { must };
}

/**
 * Notes for one source: [{document, metadata}], one per chunk. The first
 * line of each chunk names the source so search results are self-explaining.
 */
export function buildChunkNotes({
  text,
  source,
  title = "",
  project = null,
  kind = "document",
  tags = [],
  where = null,
}) {
  const chunks = chunkText(text);
  const hash = sha(text);
  return chunks.map((chunk, index) => ({
    document: `[${kind}${project ? ` · ${project}` : ""}] ${title || source}${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ""}\n${chunk}`,
    metadata: {
      type: kind,
      source,
      title: title || source,
      project,
      chunk: index + 1,
      chunks: chunks.length,
      hash,
      tags,
      ...scopeFields(where),
      source_kind: "ingest",
      ingested_at: new Date().toISOString(),
    },
  }));
}

/** A lesson learned (feedback, eval failure, decision) as one memory note. */
export function buildLessonNote({
  lesson,
  project = null,
  agent = null,
  origin = "feedback",
  evidence = "",
  where = null,
}) {
  const text = String(lesson ?? "").trim();
  const fields = scopeFields(where);
  return {
    document: `[lesson${project ? ` · ${project}` : ""}] ${text}${evidence ? `\nEvidence: ${String(evidence).slice(0, 400)}` : ""}`,
    metadata: {
      type: "lesson",
      origin,
      project,
      agent,
      ...fields,
      // Per workspace and topic: the same lesson elsewhere is its own note.
      source: `lesson:${sha(`${fields.workspace ?? ""}|${fields.scope ?? ""}|${text}`)}`,
      source_kind: "learning",
      learned_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Qdrant
// ---------------------------------------------------------------------------

/** Minimal Qdrant REST client: delete a source's chunks, count, list. */
export class QdrantRest {
  constructor({ url, collection, fetchImpl = fetch }) {
    this.url = String(url ?? "").replace(/\/+$/, "");
    this.collection = collection || "agent-memory";
    this.fetch = fetchImpl;
  }

  async call(method, path, body) {
    const res = await this.fetch(
      `${this.url}/collections/${encodeURIComponent(this.collection)}${path}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new Error(`Qdrant ${method} ${path}: HTTP ${res.status}`);
    return (await res.json())?.result ?? null;
  }

  deleteSource(source) {
    return this.call("POST", "/points/delete?wait=true", {
      filter: { must: [{ key: "metadata.source", match: { value: source } }] },
    });
  }

  async count(filter = null) {
    const result = await this.call("POST", "/points/count", {
      exact: true,
      ...(filter ? { filter } : {}),
    });
    return result?.count ?? 0;
  }

  /** Counts per metadata.type (conversation-summary, document, lesson…). */
  async countByType(types, filter = null) {
    const counts = {};
    for (const type of types) {
      counts[type] = await this.count({
        ...(filter ?? {}),
        must: [
          ...(filter?.must ?? []),
          { key: "metadata.type", match: { value: type } },
        ],
      }).catch(() => 0);
    }
    return counts;
  }

  /** One page of points (payload only): {points, next}. */
  async scroll({ filter = null, limit = 100, offset = null } = {}) {
    const result = await this.call("POST", "/points/scroll", {
      limit,
      with_payload: true,
      with_vector: false,
      ...(filter ? { filter } : {}),
      ...(offset !== null ? { offset } : {}),
    });
    return {
      points: result?.points ?? [],
      next: result?.next_page_offset ?? null,
    };
  }

  /** Merges fields into metadata of the given points. */
  setMetadata(ids, fields) {
    return this.call("POST", "/points/payload?wait=true", {
      payload: fields,
      key: "metadata",
      points: ids,
    });
  }
}

/**
 * Stores notes through `store(document, metadata)` (qdrant-store). With a
 * `rest` client, the source's previous chunks are deleted first, so
 * re-ingesting a changed file replaces it instead of piling up.
 */
export async function storeNotes(notes, { store, rest = null }) {
  if (notes.length === 0) return 0;
  const source = notes[0].metadata.source;
  if (rest) await rest.deleteSource(source).catch(() => null);
  let stored = 0;
  for (const note of notes) {
    await store(note.document, note.metadata);
    stored += 1;
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Reading sources
// ---------------------------------------------------------------------------

/** Text of a local file, or null when it can't or mustn't be read. */
export function readSourceFile(path) {
  const stats = statSync(path);
  if (!stats.isFile() || !ingestible(path, stats.size)) return null;
  const raw = readFileSync(path, "utf8");
  if (raw.includes("\u0000")) return null; // binary
  return /\.html?$/i.test(path) ? htmlToText(raw) : raw;
}

/** Only public http(s) URLs: no loopback, link-local or private ranges. */
export function allowedUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host.startsWith("[fc") ||
    host.startsWith("[fd") ||
    host.startsWith("[fe80")
  )
    return null;
  return url;
}

export async function fetchUrlText(raw, fetchImpl = fetch) {
  const url = allowedUrl(raw);
  if (!url) throw new Error("solo URLs públicas http(s)");
  const res = await fetchImpl(url, {
    redirect: "follow",
    headers: { "User-Agent": "agent-canvas-knowledge/1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text|json|xml|html|markdown/i.test(type))
    throw new Error(`tipo no soportado: ${type || "desconocido"}`);
  const body = await res.text();
  if (body.length > MAX_URL_BYTES)
    throw new Error("la página es demasiado grande");
  const title =
    /<title[^>]*>([^<]{1,200})<\/title>/i.exec(body)?.[1]?.trim() ?? url.href;
  return {
    text: /html/i.test(type) ? htmlToText(body) : body,
    title,
    url: url.href,
  };
}

/**
 * Ingests a file, a folder or a URL. Returns {sources, chunks, skipped}.
 * `store(document, metadata)` writes one note; `rest` (optional) replaces
 * previous chunks of the same source.
 */
export async function ingestSource(
  source,
  {
    store,
    rest = null,
    project = null,
    tags = [],
    fetchImpl = fetch,
    allowedRoots = [],
    scope = null,
    folder = null,
  },
) {
  const result = { sources: 0, chunks: 0, skipped: [] };
  const value = String(source ?? "").trim();
  if (/^https?:\/\//i.test(value)) {
    const page = await fetchUrlText(value, fetchImpl);
    const notes = buildChunkNotes({
      text: page.text,
      source: page.url,
      title: page.title,
      project,
      kind: "web",
      tags,
      where: memoryWhere({ scope, folder }),
    });
    result.chunks += await storeNotes(notes, { store, rest });
    result.sources += 1;
    return result;
  }
  const path = resolve(value);
  if (
    allowedRoots.length &&
    !allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))
  ) {
    throw new Error(
      `ruta fuera de las carpetas permitidas (${allowedRoots.join(", ")})`,
    );
  }
  if (!existsSync(path)) throw new Error(`no existe ${value}`);
  const isDir = statSync(path).isDirectory();
  const files = isDir ? listFiles(path) : [path];
  for (const file of files) {
    let text = null;
    try {
      text = readSourceFile(file);
    } catch {
      text = null;
    }
    if (!text?.trim()) {
      result.skipped.push(file);
      continue;
    }
    const notes = buildChunkNotes({
      text,
      source: file,
      title: isDir ? relative(path, file) : basename(file),
      project,
      kind: "document",
      tags,
      // A file belongs to its own folder unless the caller names one.
      where: memoryWhere({ scope, folder: folder ?? dirname(file) }),
    });
    result.chunks += await storeNotes(notes, { store, rest });
    result.sources += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// graphify code graph
// ---------------------------------------------------------------------------

/** The nearest folder at or above `path` with a .git or graphify-out. */
export function findRepoRoot(path) {
  let dir = resolve(path);
  if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "graphify-out")) || existsSync(join(dir, ".git")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function runGraphify(args, cwd, timeoutMs = 180_000) {
  return new Promise((done) => {
    execFile(
      "graphify",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GRAPHIFY_QUERY_LOG_DISABLE: "1" },
      },
      (error, stdout, stderr) =>
        done({ ok: !error, output: `${stdout}${stderr}`.trim() }),
    );
  });
}

/** GRAPH_REPORT.md of the project (built first when missing). */
export async function graphReport(
  path,
  { maxChars = 14_000, build = true } = {},
) {
  const repo = findRepoRoot(path);
  if (!repo)
    return { ok: false, text: `No encuentro un repositorio en ${path}.` };
  const report = join(repo, "graphify-out", "GRAPH_REPORT.md");
  if (!existsSync(report) && build)
    await runGraphify(["update", repo], repo, 600_000);
  if (!existsSync(report))
    return {
      ok: false,
      repo,
      text: `No hay grafo en ${repo}; ejecuta graph_update.`,
    };
  const text = readFileSync(report, "utf8");
  return {
    ok: true,
    repo,
    text:
      text.length > maxChars
        ? `${text.slice(0, maxChars)}\n… (recortado; usa graph_explain para un nodo)`
        : text,
  };
}

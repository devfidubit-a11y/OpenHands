import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildConversationNote,
  findGitRepos,
  McpStdioClient,
  needsSummary,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/memory-watcher-lib.mjs";

const conversation = {
  id: "c-1",
  title: "Add health endpoint",
  execution_status: "finished",
  updated_at: "2026-11-21T10:00:00Z",
  workspace: { working_dir: "/projects/c1" },
  tags: { acpserver: "claude-code" },
};

describe("needsSummary", () => {
  it("summarizes finished turns that changed since the last note", () => {
    expect(needsSummary(conversation, undefined)).toBe(true);
    expect(
      needsSummary(conversation, { updatedAt: conversation.updated_at }),
    ).toBe(false);
    expect(needsSummary(conversation, { updatedAt: "older" })).toBe(true);
  });

  it("skips conversations that are still working", () => {
    expect(
      needsSummary({ ...conversation, execution_status: "running" }, undefined),
    ).toBe(false);
  });
});

describe("buildConversationNote", () => {
  it("keeps the note short and tagged for search", () => {
    const note = buildConversationNote({
      conversation,
      firstUserText: "Please   add a /health endpoint",
      finalResponse: "x".repeat(5000),
    });

    expect(note.information).toContain(
      "Conversation summary: Add health endpoint",
    );
    expect(note.information).toContain("Task: Please add a /health endpoint");
    expect(note.information).toContain("Working directory: /projects/c1");
    expect(note.information.length).toBeLessThan(2400);
    expect(note.metadata).toEqual({
      type: "conversation-summary",
      source: "auto",
      conversation_id: "c-1",
      agent: "claude-code",
      working_dir: "/projects/c1",
      updated_at: conversation.updated_at,
    });
  });
});

describe("findGitRepos", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds repos within the depth and skips dependency folders", () => {
    root = mkdtempSync(join(tmpdir(), "repos-"));
    for (const dir of [
      "a/.git",
      "group/b/.git",
      "group/b/nested/.git",
      "node_modules/pkg/.git",
      "x/y/z/too-deep/.git",
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
    }

    expect(findGitRepos(root, 3).sort()).toEqual(
      [join(root, "a"), join(root, "group/b")].sort(),
    );
  });
});

describe("McpStdioClient", () => {
  it("initializes and calls a tool over newline-delimited JSON-RPC", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => {},
    });
    const received: { method: string; params?: unknown }[] = [];
    stdin.on("data", (buf) => {
      for (const line of String(buf).split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        received.push(msg);
        if (msg.id != null) {
          const result =
            msg.method === "tools/call"
              ? { content: [{ type: "text", text: "stored" }] }
              : { protocolVersion: "2024-11-05" };
          stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`,
          );
        }
      }
    });
    const client = new McpStdioClient({
      command: "mcp-server-qdrant",
      spawnImpl: () => proc,
    });

    await client.start();
    const result = await client.callTool("qdrant-store", {
      information: "note",
    });

    expect(result.content[0].text).toBe("stored");
    expect(received.map((m) => m.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(received[2].params).toEqual({
      name: "qdrant-store",
      arguments: { information: "note" },
    });
  });
});

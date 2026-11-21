---
name: qdrant-memory
description: "Long-term memory shared by all agents, stored in Qdrant through the qdrant-find and qdrant-store MCP tools. Use at the start of a task to recall prior decisions, conventions, and context about the project or user, and at the end to save what future agents should know."
---

# Shared memory (Qdrant)

You have long-term memory that persists across conversations and agents. It is
a semantic store: you save short notes and later find them by meaning, not by
exact words.

Tools (from the `qdrant_memory` MCP server):

- `qdrant-find(query)`: search memory. Returns the closest notes.
- `qdrant-store(information, metadata)`: save one note.

## When to recall

At the start of any non-trivial task, search memory with the project name and
the topic ("<project> deployment", "<project> coding conventions", "user
preferences testing"). Treat results as hints that may be stale: check them
against the code before relying on them.

## When to store

Save a note when you learn something a future agent would otherwise have to
rediscover:

- Decisions and their reasons ("Chose Postgres over Mongo because ...").
- Project conventions, commands, and gotchas that aren't obvious from the code.
- User preferences and corrections.
- Where things live (services, credentials *locations*, dashboards).

Do not store secrets, tokens, passwords, personal data, or large code blocks.
Do not store what the repository already records clearly (README, code).

## How to write a note

One fact per note, self-contained, with the project name in it, 1 to 4
sentences. Put structured context in `metadata`, for example
`{"project": "billing-api", "type": "decision", "date": "2026-11-21"}`.
If a note becomes wrong, store a correction that says what changed.

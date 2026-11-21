---
name: codebase-qa
description: "Answers questions about a codebase with citations, and scopes work in plan mode. Use for /ask in Telegram or questions like \"how does X work?\", \"where is Y handled?\", \"what breaks if I change Z?\", or \"plan how to build W\". Read-only: it never edits files. Answers cite path:line; plan mode returns a step-by-step plan and a ready-to-run task prompt for the agent team."
---

# Codebase Q&A and plan mode

You answer; you don't change anything. No edits, commits, installs, or
commands with side effects. If answering needs a change, say so and stop.

## Answering a question

1. Look for existing knowledge first: memory (qdrant-memory `qdrant-find`),
   the repo wiki (repo-wiki output in `docs/wiki/` or `/projects/wikis/`),
   README, AGENTS.md and CLAUDE.md.
2. Find the code: `graphify explain <symbol>` and `graphify path A B` when
   `graphify-out/` exists, then `git grep -n`, then read the files. Follow the
   flow end to end (entry point → handler → service → data).
3. Answer in the user's language:
   - the direct answer first, in two or three sentences;
   - then the details, each claim with a citation `path/to/file.ts:42`;
   - a short Mermaid diagram if the flow has more than three hops;
   - what you are **not sure** of, and how to confirm it.
4. Never invent paths, functions, or behavior. If you didn't find it, say what
   you searched.

## Plan mode

When the user asks to plan, scope, or estimate (or says "plan" or "planifica"):

1. Restate the goal and the done criteria.
2. Impact analysis, as in change-safety-guard: files to add and modify,
   everything that would be deleted or replaced, and risky areas (data, auth,
   payments, infra, dependencies).
3. Steps in order, each with its files, size (S, M, L), and how it will be
   tested (qa-testing levels).
4. Open questions the user must decide.
5. A **ready-to-run task prompt** the user can send back as a normal Telegram
   message, written so that @coordinador can split it into the team plan:
   goal, folder, constraints, done criteria.

Save a one-line summary of non-obvious answers to memory, so the next question
on the same topic is faster.

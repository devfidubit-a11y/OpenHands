---
name: session-insights
description: "Post-mortem of a finished agent conversation. Use for /insights in Telegram or when asked why an agent session went slow, failed, or went off track: reads the conversation's events, measures size and effort, finds the issues and where time was lost, writes an improved prompt, suggests skill, memory or config changes, and saves the lessons to memory."
---

# Session insights

Learn from each finished session, so the next one is faster and goes right
the first time.

## 1. Read the session

The conversation id comes from the request. Read it through the agent server
REST API, with the session key from the environment (never print it):

```bash
curl -s -H "X-Session-API-Key: $OH_SESSION_API_KEY" \
  "$OH_AGENT_SERVER_URL/api/conversations/<id>"
curl -s -H "X-Session-API-Key: $OH_SESSION_API_KEY" \
  "$OH_AGENT_SERVER_URL/api/conversations/<id>/events/search?limit=100"
```

Page through the events with `page_id` when there are more. If those variables
aren't set, use `http://127.0.0.1:18000` and ask the user if the call is
rejected. Read only: never send messages to, pause, or delete the conversation
you analyze.

## 2. Measure

- Duration, number of steps (actions), user messages, and errors.
- Size class: **XS** (<10 steps), **S** (<30), **M** (<80), **L** (<200),
  **XL** (200+).
- Category: feature, bugfix, refactor, review, research, ops, question.
- Outcome: done, partially done, failed, or abandoned, with the evidence (the
  final message, the PR, the tests).

## 3. Find the issues

Build a short timeline of the phases (exploring, editing, testing, stuck), and
point out:

- loops: the same command or edit repeated, retries without changes;
- dead ends: long exploration of the wrong area;
- missing context: what the agent had to discover that the prompt, memory or
  wiki could have said (paths, commands, credentials it lacked);
- tool and environment failures: installs, auth, missing binaries, timeouts;
- safety issues: actions that should have asked for consent;
- misleading memory or skills: a memory entry or skill text that sent the
  agent the wrong way.

## 4. Recommend

- An **improved prompt** for the same task, in the user's language, with the
  missing context included.
- Concrete changes, each with its file: a skill to edit, a memory entry to add
  or fix, a `.env` or image change, a repo note (AGENTS.md).
- Don't apply changes outside memory without the user's yes.

## 5. Save the lessons

Store two or three short, reusable lessons with qdrant-memory
(`qdrant-store`), for example "dracma-web: tests need `pnpm test:unit`, not
`npm test`". Skip lessons that only apply to this one session.

## Report

Size, category, outcome, the timeline, the issues ranked by time lost, the
improved prompt, and the recommended changes.

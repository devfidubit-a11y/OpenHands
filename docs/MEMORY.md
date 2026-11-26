# Shared memory, code graph, and extra skills (Docker)

The Docker deployment gives every agent (the OpenHands agent and ACP agents
such as Claude Code) the same long-term memory, a code knowledge graph, and a
set of extra skills.

## Memory: Qdrant

`docker/compose.yml` runs a [Qdrant](https://qdrant.tech) container next to
Agent Canvas. It is only reachable from the compose network, and its data lives
in the `qdrant-data` volume.

At startup the container registers the `qdrant_memory` MCP server
([mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant)) with the
Agent Server, which forwards it to every agent. Agents get two tools:

- `qdrant-find`: semantic search over saved notes.
- `qdrant-store`: save a note.

The `qdrant-memory` skill tells agents when to recall and what to store.

- Embeddings are computed locally with FastEmbed
  (`sentence-transformers/all-MiniLM-L6-v2`). No API key is needed. The model is
  downloaded once, on first use, into the state volume.
- The registration only runs when the entry doesn't exist yet. Edit or disable
  it in Canvas → Settings → MCP, and that choice is kept.
- To turn memory off, set `QDRANT_URL=` (empty) in `.env`, and remove the
  `qdrant_memory` entry in Settings → MCP.
- Options in `.env`: `MEMORY_COLLECTION` (default `agent-memory`) and
  `MEMORY_EMBEDDING_MODEL`. Changing the model needs a new collection, because
  vector sizes differ.

### Automatic conversation summaries

Besides what agents save themselves, a watcher in the container stores one
note per finished conversation turn: the title, the original task, the agent's
final answer (shortened), and the working directory. Notes are tagged
`type: conversation-summary` and `source: auto`. A conversation that continues
gets a new note after each finished turn whose answer changed.

On the first start it summarizes the 20 most recent conversations
(`MEMORY_SUMMARY_BACKFILL`) and skips older ones. Turn it off with
`MEMORY_AUTO_SUMMARY=false`.

Back up memory with the other volumes:

```bash
docker run --rm -v agent-canvas_qdrant-data:/d -v $PWD:/b alpine tar czf /b/qdrant.tgz -C /d .
```

### Always connected

Every agent gets a memory protocol and the rules learned from feedback. This
includes agents started from Telegram, agents opened in the OpenHands UI, and
Claude Code (ACP) agents. The protocol is installed in two places:

- `~/.agents/skills/team-memory.md`. OpenHands loads a plain `.md` without
  triggers as permanent context.
- A managed block in `$CLAUDE_CONFIG_DIR/CLAUDE.md`. The rest of that file is
  left as it is.

The bridge rewrites both when a rule is added or removed. The memory watcher
installs them at startup, even without Telegram.

The protocol has three steps:

1. **At the start**, the agent runs `memory_search` on the task and reads the
   code graph with `graph_report`.
2. **While working**, it runs `memory_ingest` on any data you hand it.
3. **At the end**, it saves 1 to 3 durable lessons with `memory_learn`.

At startup the container keeps `qdrant_memory` and `knowledge` enabled. An
entry that was disabled in Settings → MCP is switched back on. Set
`MEMORY_ALWAYS_ON=false` to keep a "disabled" choice.

### Separated memory: topic, workspace, folder

Every note records where it belongs:

| Field                | Value                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `metadata.scope`     | The Telegram chat or forum topic (`-100…` or `-100…:7`). Empty for notes shared by the whole workspace, such as project docs and OpenHands UI conversations. |
| `metadata.workspace` | The repository root of the working folder, or the folder itself when it isn't a repository.                                                                  |
| `metadata.folder`    | The working folder.                                                                                                                                          |

`memory_search` (and `/memoria buscar`) looks at one level:

| Level            | What it searches                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tema` (default) | This workspace: the notes of this chat or topic, plus what the workspace shares. Other topics are never mixed in. |
| `carpeta`        | This folder only.                                                                                                 |
| `workspace`      | The whole repository, across topics.                                                                              |
| `todo`           | Everything. Use it only when asked.                                                                               |

Agents pass `path` (their working folder) and `scope` (given in the task by
the bridge) to `memory_search`, `memory_learn` and `memory_ingest`. Plain
`qdrant-find` still works, and it now accepts a `query_filter`
(`QDRANT_ALLOW_ARBITRARY_FILTER`), but without a filter it searches every
project.

Notes stored before this change are placed once at startup. The watcher
works out each note's workspace from its working dir, its source path or its
project name. Guardrails and skills stay global, because they are quality
rules.

### The `knowledge` MCP server

`scripts/knowledge-mcp.mjs` is registered for all agents next to
`qdrant_memory`, and uses the same Qdrant collection and embeddings.

| Tool            | What it does                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `graph_report`  | Returns the project's graphify report, and builds the graph first if it's missing.                                   |
| `graph_explain` | Explains one node and its neighbors.                                                                                 |
| `graph_path`    | Shows how A reaches B in the code graph.                                                                             |
| `graph_update`  | Re-indexes the code graph (code only, no LLM).                                                                       |
| `memory_search` | Searches the memory of this topic, workspace or folder (see above).                                                  |
| `memory_ingest` | Ingests a file, a folder or a public URL into the caller's workspace. Re-ingesting a source replaces its old chunks. |
| `memory_learn`  | Saves a lesson for this workspace and topic.                                                                         |
| `memory_status` | Counts the notes per kind, for one workspace when given a `path`.                                                    |

`memory_ingest` follows these rules:

- It only reads files under `KNOWLEDGE_ROOTS` (default
  `/projects,/documents,/workspace`).
- It skips `.env`, key and credential files, binaries and build output.
- It only fetches public http(s) URLs. Loopback and private addresses are
  refused.

### Data ingestion

- **Project docs, continuously.** The watcher keeps these files of every
  repository in memory, and re-ingests a file when it changes:
  - README, AGENTS.md, CLAUDE.md, CONTRIBUTING, ARCHITECTURE and CHANGELOG
  - `docs/`, `wiki/` and `adr/`
  - the graphify report

  These notes have `type: project-doc`. Turn it off with
  `MEMORY_INGEST_DOCS=false`.

- **Telegram:**
  - `/ingest <path | folder | URL>` ingests the source. For a repository it
    also refreshes the code graph.
  - A file sent to the chat (md, txt, csv, json, code, html; up to 20 MB) is
    saved and ingested. If it has a caption, the caption goes to
    @coordinador.
  - `/memoria` shows what this topic's memory holds.
    `/memoria buscar [tema|carpeta|workspace|todo] <q>` searches it, and
    `/memoria aprende <lesson>` adds a lesson to it.
  - Everything sent in a chat or topic is stored with that topic and its
    working folder.
- **Lessons from the feedback loop.** These are saved automatically as
  `type: lesson`, in the topic and workspace where they happened, so later
  agents there recall them with `memory_search`:
  - 👎 notes
  - fixes the judge suggests for failed evals
  - every applied mechanism

### Self-improvement

`/mejora auto on` is the default. After an eval run with failures, @curador
starts on its own, at most once a day. Proposed guardrail rules and eval cases
that pass validation are applied right away and announced in the chat; undo
one with `/mejora quitar`. New skills always wait for a human ✅.
`/mejora auto off` makes every proposal wait for approval. See
[FEEDBACK-LOOP.md](FEEDBACK-LOOP.md).

## Code graph: Graphify

[Graphify](https://github.com/Graphify-Labs/graphify) is installed in the image,
with its `/graphify` skill. In a conversation, ask the agent to run
`/graphify .` in the project. Graphify writes `graphify-out/` into the project:
`GRAPH_REPORT.md`, `graph.json`, and an interactive `graph.html`. Agents then use
the report and `graphify path` / `graphify explain` to navigate the code.

### Re-indexing on every commit

The watcher scans the projects folder every 5 minutes (three levels deep) for
git repositories and runs `graphify hook install` once in each. The hook
appends to any existing git hooks. After that, every commit, merge, checkout,
or rebase re-indexes the code graph in the background. This covers code only
and needs no LLM. A repository without a graph also gets its first graph built
right away. Turn it off with `GRAPHIFY_AUTO_HOOKS=false`. To remove it from one
repository, run `graphify hook uninstall` there.

Add more folders with `GRAPHIFY_PROJECTS_DIR`, comma-separated. Each one can be
a repository itself or a folder of repositories, for example
`/projects,/documents/my-app`.

Your repositories stay clean in `git status`. Graphify's merge-driver line
goes to `.git/info/attributes`, not `.gitattributes`, and `graphify-out/` goes
to `.git/info/exclude`. Both files are local to that clone and are never
committed. The git hooks themselves live in `.git/hooks`.

Code extraction runs offline. Graphify needs an LLM key only to extract docs,
PDFs and images. Its query log is turned off in the image
(`GRAPHIFY_QUERY_LOG_DISABLE=1`).

## Extra skills

Installed on every start, from `skills/` in this repository:

| Skill                       | Use                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `senior-devops`             | CI/CD, containers, Kubernetes, IaC, observability, incidents                                                                                       |
| `senior-architect`          | System design, trade-offs, ADRs, migrations                                                                                                        |
| `ux-design`                 | Flows, states, forms, usability, UX writing, accessibility                                                                                         |
| `ui-design`                 | Layout, typography, color, tokens, components, responsive                                                                                          |
| `impeccable`                | Deep design critique and polish (downloads its Linux helper on first use)                                                                          |
| `component-design-patterns` | Component APIs, composition, compound/headless components, state ownership                                                                         |
| `senior-frontend`           | React/Next.js/Vue front ends: architecture, data, performance, accessibility, tests                                                                |
| `senior-backend`            | APIs and services: validation, data and migrations, auth, idempotency, reliability                                                                 |
| `change-safety-guard`       | Impact analysis before changes; consent required for deletions, secrets, data, infra; backed-up branches                                           |
| `feature-branch-pr`         | Branch and PR control: feature branches, worktrees for parallel agents, conventional commits, draft PRs                                            |
| `qa-testing`                | Reviews and tests code: unit, integration, API/route handlers, component, E2E, smoke, snapshot, visual regression, performance and Core Web Vitals |
| `ux-ui-storytelling`        | UX/UI design that keeps one narrative across screens, copy and flows                                                                               |
| `docker-containers`         | Dockerize apps, Compose, isolated test containers on a private Docker engine, container deploys (with consent)                                     |
| `cloudflare-wrangler`       | Workers/Pages/OpenNext with wrangler (installed); deploys and secrets need consent                                                                 |
| `latency-optimizer`         | Finds the slowest endpoint/page/job/query, fixes the worst one, PR with before/after numbers (`/latency`, `/bot latency`)                          |
| `code-scans`                | Repo scans by type: performance, database, coverage, dead code, quality, security, dependencies… (`/scan`)                                         |
| `repo-wiki`                 | Generated wiki with Mermaid architecture and source links (`/wiki`)                                                                                |
| `codebase-qa`               | Cited answers about the code and plan mode, read-only (`/ask`, `/plan`)                                                                            |
| `pr-reviewer`               | PR review with Bugs/Flags/Security, tests, verdict, optional auto-fix (`/review`)                                                                  |
| `security-audit`            | OWASP, authz, secrets, dependency and config audit (`/security`)                                                                                   |
| `migration-modernization`   | Framework/language migrations in small tested PRs (`/migrate`)                                                                                     |
| `session-insights`          | Post-mortem of an agent session; lessons saved to memory (`/insights`)                                                                             |
| `pencil-design`             | pen.dev (Pencil) designs through the `pencil` MCP: design → code, code → design, design review (`/design`)                                         |
| `flutter-expert`            | Flutter/Dart apps: architecture, state, tests, performance; checks on the iPhone simulator (`/movil`, [MOBILE.md](MOBILE.md))                        |
| `ios-simulator`             | iPhone/iPad simulators on the Mac through the `simulator` MCP: run, screenshot, logs, taps                                                         |
| `qdrant-memory`             | How to use the shared memory                                                                                                                       |
| `code-review`               | From the OpenHands extensions package                                                                                                              |
| `graphify`                  | Installed by Graphify itself                                                                                                                       |

They go to `~/.agents/skills` (OpenHands agent, also forwarded to ACP agents)
and to Claude Code's own skills directory. Copies managed this way are replaced
on each start, so edit them in `skills/` and rebuild. Skills you add to those
directories yourself are left alone.

## Git and pull requests

`feature-branch-pr` makes agents work on `feat/…` branches and open pull
requests instead of committing to the default branch. Agents in a Telegram
`/team` each use their own git worktree and branch. The lead then integrates
them on one feature branch and opens a single PR. Nothing is merged into the
default branch.

To let agents push and open PRs, set these in `.env`: `GIT_USER_NAME`,
`GIT_USER_EMAIL`, and `GH_TOKEN`. For the token, use a fine-grained GitHub
token with Contents and Pull requests read/write. Instead of the token, you can
sign in once:

```bash
docker exec -it agent-canvas gh auth login
```

The login is kept in the state volume, and `gh` serves as git's credential
helper.

## Change safety guard

The `change-safety-guard` skill and the `safe-branch` tool keep agents from
damaging or deleting anything without your consent:

- Before working, the agent lists what it will add, modify, and **delete or
  replace**, plus any risky areas. Deletions and risky changes need your yes.
- `safe-branch start <slug> [--worktree]` refuses to run over uncommitted
  changes, tags the current commit as a local backup (`safety/<time>-<branch>`),
  and creates `feat/<slug>` from the up-to-date default branch. It never
  deletes, resets, stashes, or pushes.
- `safe-branch check` compares the work with the base branch and flags deleted
  files, secrets files and secret-looking values, database migrations and
  schema changes, renames, bulk removals, CI/deploy config, and dependency
  changes. Exit code 2 means the agent must stop and ask before committing or
  pushing.
- `safe-branch backups` lists the backup tags. To get a state back:
  `git switch -c restore <tag>`.
- `safe-branch branches` shows every local branch and worktree, with:
  - how far it is ahead of and behind the base
  - whether it is merged or pushed
  - any uncommitted work
- `safe-branch split` suggests how to split a large change into focused
  commits, one per area.
- `safe-branch commits` lints the branch's commits. It flags messages that
  aren't Conventional Commits, `fixup!` and WIP commits, oversized commits,
  and commits that mix more than 3 areas.
- `safe-branch sync [--upstream <url>] [--apply]` keeps a fork current
  without touching our changes. It fetches upstream, deepening a shallow
  clone if needed. It lists the new commits and the files each side
  changed, and runs a trial merge.

  With `--apply` it takes a backup tag, merges upstream on
  `sync/<remote>-<date>`, and checks that every file only we changed is
  unchanged. On conflicts it stops on that branch. It never touches our
  main branch, rebases or pushes.

  The `upstream` Telegram bot (`/bot upstream`) runs this weekly and
  reports. Merging into main waits for your OK.

This is guidance plus a tool, not a sandbox: agents can still run shell
commands. For hard limits, keep `AUTO_LOGIN` off on shared machines, mount
only the folders agents need (`DOCUMENTS_DIR`), and turn on confirmation for
risky actions in Canvas.

## Cloudflare

`wrangler` is installed in the image. To let agents use your account, set
`CLOUDFLARE_API_TOKEN` (scoped to what they need) and `CLOUDFLARE_ACCOUNT_ID`
in `.env`. The `cloudflare-wrangler` skill keeps work local or on preview
versions, and requires your consent for deploys, secrets, and remote data.

Projects mounted from macOS (under `/documents` or `/projects`) have macOS
native binaries in `node_modules` (workerd, esbuild), which don't run in the
Linux container. Agents work in a git worktree with its own `npm ci` instead
of reinstalling in your checkout.

Cloudflare's remote MCP servers (bindings, browser rendering, …) authenticate
with OAuth, and their tokens expire. If they show "failed to start", remove
them in Canvas → Settings → MCP and add them again, or rely on `wrangler` with
an API token.

## Private Docker engine

With `COMPOSE_PROFILES=docker` and `AGENT_DOCKER_HOST=tcp://docker:2375` in
`.env`, compose runs a Docker-in-Docker service (`agent-canvas-docker`). Agents
use it to build images and run throwaway containers for tests. It is isolated
from the host: agents can't see or stop your other containers. Ports of
containers started there are reached at `docker:<port>`. `/projects` and
`/documents` are mounted at the same paths, so bind mounts work.

It runs privileged and isn't published on the host. Leave the profile off on
servers where agents shouldn't run containers. Free space with
`docker exec agent-canvas-docker docker system prune -af`.

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

| Skill | Use |
| --- | --- |
| `senior-devops` | CI/CD, containers, Kubernetes, IaC, observability, incidents |
| `senior-architect` | System design, trade-offs, ADRs, migrations |
| `ux-design` | Flows, states, forms, usability, UX writing, accessibility |
| `ui-design` | Layout, typography, color, tokens, components, responsive |
| `impeccable` | Deep design critique and polish (downloads its Linux helper on first use) |
| `component-design-patterns` | Component APIs, composition, compound/headless components, state ownership |
| `senior-frontend` | React/Next.js/Vue front ends: architecture, data, performance, accessibility, tests |
| `senior-backend` | APIs and services: validation, data and migrations, auth, idempotency, reliability |
| `feature-branch-pr` | Branch and PR control: feature branches, worktrees for parallel agents, conventional commits, draft PRs |
| `qdrant-memory` | How to use the shared memory |
| `code-review` | From the OpenHands extensions package |
| `graphify` | Installed by Graphify itself |

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

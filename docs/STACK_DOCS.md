# Up-to-date docs for every stack

Models are trained on docs that age. Two pieces keep the agents current
without anyone doing anything:

1. **Source: Context7.** The `context7` MCP gives every agent current,
   version-specific docs and code examples for libraries and frameworks:
   Flutter, Dart packages, Node, Next.js, NestJS, React, Python, Rust, Go,
   .NET, Java, and thousands more. The agent calls `resolve-library-id`,
   then asks the docs for that library and topic.
   - It is registered on startup and points to
     `https://mcp.context7.com/mcp`.
   - It works without a key. With `CONTEXT7_API_KEY` in `docker/.env`, the
     rate limits are higher. `CONTEXT7_MCP=false` turns it off.
2. **Daemon: the stack docs watcher** (`scripts/stack-docs-watcher.mjs`). It
   runs in the container and restarts if it fails. Every 12 hours it:
   - reads the newest stable version of each stack from its official feed;
   - when a version changes, and on the first run, stores that release's
     official "what's new" pages and the `llms.txt` doc index in the shared
     memory, as type `stack-docs` with the stack tag. It replaces the
     previous copy.
   - rewrites the always-on `stack-versions` note. Every agent sees it,
     whether it was started from OpenHands, Claude Code or Telegram. The
     note has the version table and the rule: read the version the project
     uses, then follow the docs for that version through Context7, not
     memory.

| Stack | Version feed | What is stored when it changes |
| --- | --- | --- |
| Flutter / Dart | `flutter_infra_release/releases_macos.json` | Flutter what's new and release notes, Dart what's new, `llms.txt` |
| Node.js | endoflife.date (newest LTS and current) | `CHANGELOG_V<major>.md` |
| Next.js | npm `next` | nextjs.org/blog, `docs/llms.txt` |
| NestJS | npm `@nestjs/core` | GitHub release notes, `docs.nestjs.com/llms.txt` |
| Python | endoflife.date | `whatsnew/<minor>` |
| Rust | `channel-rust-stable.toml` | `releases.html` (newest first) |
| Go | `go.dev/dl/?mode=json` | `go.dev/doc/go<minor>` |
| C# / .NET | .NET `releases-index.json` | .NET and C# what's new |
| C++ | LLVM releases (GitHub) | cppreference compiler support |
| JavaScript / TypeScript | npm `typescript`, TC39 finished proposals | TC39 finished proposals, TypeScript release notes |
| Java | Adoptium API (newest feature release and LTS) | `openjdk.org/projects/jdk/<n>` |

If a feed fails, the last known version stays; one outage never empties the
table.

## Use it

- **Agents** do it on their own because of the always-on note. To search
  the stored release notes, call `memory_search` with level `todo`, for
  example: "flutter 3.50 release notes".
- **Telegram**: `/versiones` shows the current versions and the recent
  changes.

## Settings (`docker/.env`)

| Variable | Default | |
| --- | --- | --- |
| `STACK_DOCS_WATCH` | `true` | `false` turns the daemon off |
| `STACK_DOCS_INTERVAL_H` | `12` | Hours between checks (minimum 1) |
| `STACK_DOCS_STACKS` | all | Comma list: `flutter,node,nextjs,nestjs,python,rust,go,csharp,cpp,javascript,java` |
| `STACK_DOCS_INGEST` | `true` | `false` skips the release notes and keeps only the note |
| `STACK_DOCS_ALWAYS_ON` | `true` | `false` skips the always-on note |

State: `~/.openhands/agent-canvas/stack-docs-state.json` (versions, what has
been stored, and the last 50 changes).

The daemon never upgrades your toolchains or your projects' dependencies.
Agents suggest an upgrade as a separate change.

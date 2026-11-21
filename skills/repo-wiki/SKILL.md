---
name: repo-wiki
description: "Repository wiki generator. Use for /wiki in Telegram or when asked to document a codebase: generate a browsable wiki with an overview, architecture diagrams (Mermaid), module pages, data flow, API and data model references, setup and deploy guides, all with source links, and keep it up to date as the code changes. Steered by an optional wiki.json."
---

# Repository wiki

Build documentation a new engineer can learn the codebase from, where every
claim links to the code that proves it.

## Where it goes

- Default output: `docs/wiki/` in a branch (`safe-branch start wiki
  --worktree`) and a PR, so the user reviews it like code. If the user only
  wants to read it, write it to `/projects/wikis/<repo>/` instead and change
  nothing in the repo.
- Steering file (optional): `.openhands/wiki.json` in the repo:
  ```json
  {
    "repo_notes": ["Payments live in src/billing; treat as critical"],
    "pages": [{ "title": "Billing", "purpose": "How charges and refunds flow" }]
  }
  ```
  When it has `pages`, generate exactly those pages. Otherwise choose up to
  30 pages yourself.

## Steps

1. **Map the repo.** Use graphify when `graphify-out/` exists (`graphify
   explain`, `graphify path`) for modules and dependencies. Also read the
   manifests, entry points, routes, the database schema and migrations, env
   files (`.env.example` only; never print real secrets), CI, Docker and
   deploy config, and the existing README, AGENTS.md and CLAUDE.md.
2. **Plan the pages:**
   - `index.md`: what the product does, the tech stack, a top-level
     architecture diagram, and a map of the other pages.
   - `architecture.md`: components, boundaries, and request lifecycle (a
     Mermaid `flowchart` and a `sequenceDiagram` for the key flow).
   - One page per major module or domain: responsibility, key files, public
     API, dependencies in and out, and gotchas.
   - `data-model.md`: entities and relations (Mermaid `erDiagram`).
   - `api.md`: routes or endpoints with method, auth, input and output.
   - `setup.md` and `deploy.md`: local dev, tests, environments, CI/CD.
   - `glossary.md`: domain terms with their names in the code.
3. **Write each page.** Explain the why, not only the what. Link sources as
   relative links with line anchors (`[handler](../../src/api/quote.ts#L42)`).
   Use diagrams only where they explain something, and check that every
   Mermaid block is valid.
4. **Verify.** Every file path and symbol you mention must exist (check with
   `git ls-files` and `grep`). Mark anything you inferred but couldn't confirm
   as "(inferido)".

## Keeping it current

On a later run, diff the code since the commit recorded in `docs/wiki/.meta`
(`git diff --stat <sha>..HEAD`), and update only the pages whose sources
changed. Record the new commit SHA.

## Report

Pages created or updated, diagrams included, what is not covered yet, and the
PR link or output folder. Save a pointer to memory (qdrant-memory), "wiki for
<repo> at <path>, commit <sha>", so codebase-qa can use it.

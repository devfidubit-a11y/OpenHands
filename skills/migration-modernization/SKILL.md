---
name: migration-modernization
description: "Code migration and modernization expert. Use for framework and language upgrades and migrations: JavaScript to TypeScript, Next.js/React/Node major upgrades, Pages Router to App Router, CommonJS to ESM, Python 2/old Django or Java version upgrades, NoSQL to SQL, REST to typed clients, and moving between libraries. Plans the migration in small, tested, reversible steps and ships each step as its own PR."
---

# Migration and modernization

Big-bang migrations break things. Migrate in **small, shippable steps**, each
one green and reversible, while the app keeps working.

## 1. Assess

- Current and target versions, read from the lockfile and config, not
  memory. Read the official migration guides and changelogs for every major
  version you cross. Breaking changes are cumulative.
- Inventory what the migration touches: count files and usages
  (`git grep -c`), list the deprecated APIs in use, dependencies that must move
  together (peer dependencies), build and CI config, and runtime targets
  (Node version, Cloudflare `compatibility_date`, Docker base image).
- Check the safety net: how good the tests are around the affected areas. If
  coverage is thin, the first step is adding characterization tests
  (qa-testing) that lock in current behavior.

## 2. Plan

Write the plan for the user before changing code (change-safety-guard):

- the steps, ordered so each one builds and passes tests on its own; for
  example: tooling and config → leaf modules → shared modules → entry points →
  removal of compatibility shims;
- what each step changes, its size, and how it's verified;
- risks: data (a schema or storage migration needs a backfill and rollback
  plan and the user's consent), public APIs, performance, and bundle size;
- what stays out of scope.

## 3. Execute each step

- `safe-branch start migrate-<slug>-<step>`, in a worktree for host-mounted
  projects (don't reinstall dependencies in the user's checkout).
- Prefer the official codemods (`npx @next/codemod`, `npx types-react-codemod`,
  `jscodeshift`, `ts-migrate`, `pyupgrade`, OpenRewrite for Java), then fix
  what they miss by hand. Review every codemod diff.
- **JS → TS:** enable `allowJs` and `checkJs` first, convert leaf files first,
  start with `strict` off or per-folder, never silence errors with `any` or
  `@ts-ignore` without a comment saying why, and turn on `strict` at the end.
- **Data migrations (NoSQL → SQL, schema changes):** expand, migrate, then
  contract: add the new structure, dual-write or backfill, switch reads,
  verify, and remove the old structure last, with consent for each phase
  that touches a real database.
- Keep behavior identical unless the user asked for changes. Run the full
  test suite, lint, type check and build on every step. Compare bundle size
  and key performance numbers with the base (qa-testing).
- `safe-branch check`, then one PR per step (feature-branch-pr), whose body
  says which step of the plan it is and how to roll it back.

## Report

The plan with each step's status (done, PR open, pending), what changed, test
and build results, remaining deprecated usages (with counts), and the next
step. Save progress to memory (qdrant-memory) so another agent can continue
the migration.

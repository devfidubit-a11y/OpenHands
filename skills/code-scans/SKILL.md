---
name: code-scans
description: "Repository code scanner. Use for /scan in Telegram or when asked to scan a repo for one goal: performance, database queries, test coverage, dead code, code quality, cleanup, telemetry, accessibility, compliance, security, dependencies, or a custom goal. Produces a ranked findings list with file:line evidence, and fixes the findings the user picks in small PRs."
---

# Code scans

A scan looks for **one kind of problem** across a repo, and reports findings
the user can act on. Scanning never changes code. Fixing is a separate step,
done only for the findings the user picks.

## Scan types

| Type | Look for |
| --- | --- |
| `performance` | Hot paths doing avoidable work, serial awaits, sync I/O in handlers, missing memoization or caching, large bundles and images, re-renders. Hand deep work to latency-optimizer. |
| `database` | N+1 queries, missing indexes for filters and joins, unbounded selects, `SELECT *`, transactions held open, queries in loops, missing pagination, raw SQL injection risks. |
| `coverage` | Untested modules and branches, ranked by risk (money, auth, data). Run the coverage tool if one is configured (`vitest --coverage`, `pytest --cov`). |
| `dead-code` | Unused exports, files, dependencies, routes, feature flags and env vars (`knip`, `ts-prune`, `depcheck`, `vulture`, grep for references). |
| `quality` | Complexity hotspots, duplicated logic, swallowed errors, `any` and type escapes, inconsistent patterns, TODO/FIXME with risk. |
| `cleanup` | Lint and type errors, deprecated APIs, outdated config, leftover debug code and logs. |
| `telemetry` | Missing logs, metrics or traces on critical paths, errors not reported, PII in logs. |
| `accessibility` | Missing labels and alt text, contrast, keyboard traps, focus order, ARIA misuse, semantic HTML (axe, eslint-plugin-jsx-a11y). |
| `compliance` | Secrets in code, licenses of dependencies, PII handling, cookie and consent flows, data retention. |
| `security` | Use the security-audit skill. |
| `dependencies` | Outdated and vulnerable packages (`npm audit`, `pip-audit`, `osv-scanner`), unpinned versions, duplicate libraries. |
| `custom` | The user's own goal, for example "every API route checks the session". |

## How to scan

1. Read the repo's shape first. If `graphify-out/` exists, use `graphify` to
   find modules and dependencies; otherwise use `git ls-files` and the
   manifests. Scope to the folder the user named.
2. Combine tools and reading: run the linters, analyzers and audits that fit
   the stack (read-only, no `--fix`), then confirm every candidate by reading
   the code. Tool output alone is not a finding.
3. Don't reinstall dependencies in a host-mounted project. If a tool needs
   installed dependencies, use a worktree (cloudflare-wrangler rule 3).

## Findings

Rank by impact × confidence. Each finding has:

- **ID** (`S1`, `S2`, …), **severity** (high, medium, low), and **confidence**;
- **where**: `path:line`;
- **what and why it matters**, in one or two sentences, with the evidence;
- **suggested fix**, and its size (S, M, L).

Report at most 15 findings, and group repeats ("same N+1 in 6 handlers"). Say
what you didn't scan.

## Fixing

Stop after the report. The user picks findings (for example "arregla S1 y
S3"). Then, for each fix or small group of related fixes: change-safety-guard
analysis, `safe-branch start scan-<type>-<slug>`, the smallest change, tests
(qa-testing), `safe-branch check`, and one small PR per fix (feature-branch-pr).
Removing dead code is a deletion: list exactly what goes away and get consent
first.

Save a short summary of the scan to memory (qdrant-memory) so later scans can
skip known findings.

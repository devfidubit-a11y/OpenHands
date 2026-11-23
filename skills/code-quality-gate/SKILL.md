---
name: code-quality-gate
description: "Quality gate before saying a code change is done: run the project's own lint, type check, tests and build for what changed, add tests for behavior changes, review your own diff, and end with a VERIFICACIÓN line. Use whenever you change code, config or scripts, before you commit, open a PR or report the task as finished."
---

# Code quality gate

A change is done when it is **proven** to work, not when it compiles in your
head. The team scores every answer (human 👍/👎 and the @juez evals), and an
answer that changes code without evidence counts as a failure.

## Rules

1. **Use the project's own tools.** Find them before you start: `package.json`
   scripts, `Makefile`, `pyproject.toml`, `AGENTS.md`, CI workflows
   (`.github/workflows`). Run the same checks CI runs, scoped to what you
   touched when the full suite is slow.
2. **Tests for behavior.** Every bug fix gets a test that fails before and
   passes after. Every new behavior gets a test. Never change a test's
   expectations to make it pass unless the expectation itself was wrong, and
   say so.
3. **Small diffs.** One concern per change. No drive-by reformatting, renames
   or refactors you weren't asked for. Reuse existing helpers instead of
   duplicating them.
4. **Follow the repo's style.** Match naming, file layout, error handling and
   comment style of the neighbouring code. Run the formatter the repo uses.
5. **No new warnings.** Lint and type errors you introduced are bugs. Don't
   silence them with `any`, `// @ts-ignore`, `eslint-disable` or `--no-verify`.
6. **Safety first.** Follow change-safety-guard: no deletions, destructive git
   or secrets without consent; never push to the default branch.
7. **Honesty.** If a check fails or you could not run it, say so plainly. A
   claim of a check you didn't run is the worst possible failure.

## Workflow

1. Before editing: note which checks exist and run the relevant tests once to
   know the baseline (a test already failing is not your bug, but say it).
2. Make the change, with its tests.
3. Run, in this order, what applies: formatter → lint → type check → unit
   tests for the touched area → build (for frontend or packaging changes) →
   a quick manual or visual check for UI changes (qa-testing).
4. Review your own diff (`git diff`) as a strict reviewer would: dead code,
   leftover debug output, missing edge cases (empty, null, errors, large
   input), naming, comments that lie.
5. Fix what you found and rerun the checks.

## Report

End your final answer with exactly one line:

`VERIFICACIÓN: <command> → <result>; <command> → <result>`

for example `VERIFICACIÓN: npm run lint → ok; npx vitest run src/cart → 12 passed; npm run build → ok`.
When you couldn't verify: `VERIFICACIÓN: no pude ejecutar los tests (<why>)`.

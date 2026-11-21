---
name: pr-reviewer
description: "Pull request reviewer with optional auto-fix. Use for /review in Telegram or when asked to review a PR, MR, branch or diff: groups the changes by intent, reports Bugs, Flags and Security findings with path:line evidence, runs the tests, and, when the user asks, posts the review to GitHub or fixes the findings in a follow-up commit. Builds on the code-review skill."
---

# PR reviewer

Review like a senior engineer who must approve the merge: find the real
problems, prove them, and skip the noise.

## 1. Get the change

- GitHub PR: `gh pr view <n|url> --json title,body,baseRefName,headRefName,files`
  and `gh pr diff <n|url>`. Check out the PR in a worktree
  (`git worktree add ../<repo>-pr-<n> pr-<n>` after `gh pr checkout <n> -b pr-<n>`)
  to run it. Never change the user's own checkout.
- Branch or local diff: `git diff <base>...<branch>`.
- Read the PR description and the linked issue: review against what it
  claims to do.

## 2. Understand before judging

Group the changed files by intent (for example "API change", "UI", "migration",
"tests", "config"), and summarize each group in one line. Read the callers
and the tests of anything changed (`git grep`, graphify), not just the diff.

## 3. Findings

Use the code-review skill's checklist, and report three kinds of findings:

- **Bugs:** wrong behavior you can demonstrate: logic errors, broken edge
  cases, race conditions, null handling, wrong error handling, data loss,
  regressions for existing callers. Each one has a concrete failing scenario
  (input → wrong output).
- **Flags:** things a human should decide: risky design, missing tests for
  risky code, performance traps, breaking API or schema changes, missing
  migrations or rollback, config and dependency changes, unclear naming.
- **Security:** injection, authz/authn gaps, secrets, SSRF, XSS, unsafe
  deserialization, permissive CORS, PII exposure (security-audit skill).

For each one: ID (`B1`, `F1`, `S1`), `path:line`, what is wrong, why it
matters, and a suggested fix. Confidence: confirmed (you ran or traced it) or
plausible. Drop nitpicks and style the linter already covers.

## 4. Verify

Run the PR's tests, lint and type check in the worktree (qa-testing). Run
`safe-branch check` against the base to catch deletions, secrets and
migrations. Report what you ran and the results.

## 5. Output

- A verdict: **approve**, **approve with comments**, or **request changes**.
- The grouped summary, then the findings table, then the test results.
- **Posting to GitHub needs the user's yes** for that PR. Then use `gh pr
  review <n> --comment|--request-changes --body-file <file>` and inline
  comments through `gh api`. Never approve or merge on the user's behalf
  unless they explicitly ask.

## Auto-fix

Only when the user asks ("arregla B1 y S1"): fix them in the PR's worktree with
the smallest changes, add tests that fail without the fix, run
`safe-branch check`, and push to the PR branch (or to a new
`fix/pr-<n>-review` branch with its own PR if the PR is not the user's). List
each finding as fixed, skipped (and why), or not a bug after all.

---
name: feature-branch-pr
description: "Branch and pull request control. Use whenever you change code in a git repository: work on a feature branch (never the default branch), keep commits small with conventional messages, use a git worktree when other agents share the checkout, keep the branch up to date, push, and open a pull request that describes the feature addition. Also for reviewing a branch or PR before merge."
---

# Feature branches and pull requests

Every change lands as a **feature addition on its own branch**, reviewed through
a pull request. Never commit straight to the default branch, never force-push
a shared branch, and never merge your own PR unless the user explicitly asks.

Always apply the **change-safety-guard** skill too: analyze the impact first,
and get consent for anything destructive.

## 1. Start the branch

```bash
safe-branch start <short-slug>   # backup tag + feat/<short-slug> from the default branch
```

`safe-branch` refuses on uncommitted changes and never deletes anything. If
it isn't available, do the same by hand:

```bash
git status                      # stop if there are changes you didn't make
git fetch origin
BASE=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')
git tag "safety/$(date +%Y%m%dT%H%M%S)-$(git branch --show-current)"
git switch -c feat/<short-slug> "origin/$BASE"
```

- Prefixes: `feat/` (feature addition), `fix/`, `refactor/`, `docs/`,
  `chore/`, `test/`. The slug is kebab-case and short, such as
  `feat/contact-form`.
- If the user is already on a feature branch for this work, continue there.
- If the working tree has changes you didn't make, don't stash, reset, or
  commit them. Ask the user, or use a worktree (next section).

## 2. Parallel agents: one worktree each

Several agents in the same checkout would switch branches under each other.
When you are part of a team, or the checkout is busy, work in your own
worktree:

```bash
safe-branch start <slug> --worktree      # creates ../<repo>-<slug>
cd ../<repo>-<slug>
```

Install dependencies there if needed. When the branch is merged, remove it
with `git worktree remove ../<repo>-<slug>`.

## 3. Commit

- Small, focused commits. Each one builds and passes tests.
- Conventional Commits: `feat(contact): add form validation`,
  `fix(api): handle empty payload`. Imperative mood, at most 72 characters,
  with a body explaining *why* when it isn't obvious.
- Stage specific files (`git add <paths>`), not `git add -A`. Never commit
  secrets, `.env*` files with values, build output, or generated graphs.
- Run lint, type check, and tests before each commit you push.

## 4. Stay current

Before pushing, update from the base branch: `git fetch origin && git rebase
"origin/$BASE"` while the branch is only yours, or merge if others already
pulled it. Resolve conflicts by understanding both sides, never by blindly
taking yours.

## 5. Push and open the PR

Run `safe-branch check` first. Exit code 2 means something needs the user's
consent: stop and ask. Put its "Tell the user" items in the PR description.

```bash
git push -u origin HEAD
gh pr create --base "$BASE" --title "feat(scope): summary" --body-file pr.md
```

If `gh` isn't available, use the GitHub MCP tools or give the user the
compare URL. The PR body contains:

- **What:** the feature added, in two or three sentences.
- **Why:** the user need or issue (`Closes #123`).
- **How:** key design decisions and anything reviewers should look at first.
- **Testing:** commands run and their results, plus manual checks.
- **Risk and rollback:** migrations, flags, and config changes.

Open it as a draft while work is still in progress. Keep one PR per feature,
and split it when it grows past roughly 400 changed lines.

## 6. Reviewing a branch or PR

Check that the diff matches the description, it is scoped to one feature, the
tests cover the new behavior, there are no secrets or debug leftovers,
migrations are safe, and CI is green. Leave specific, actionable comments.
Approve or merge only when the user asks.

## Report

End with the branch name, the PR link (or why there isn't one), the commits,
and the verification you ran.

---
name: feature-branch-pr
description: "Branch, commit and pull request control. Use whenever you change code in a git repository: work on a feature branch (never the default branch), split work into small conventional commits, juggle several branches and worktrees, keep the branch up to date, sync a fork with its upstream without losing our changes, push, and open a pull request that describes the feature addition. Also for reviewing a branch or PR before merge."
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

## 3. Many branches at once

`safe-branch branches` lists every local branch and worktree, with:

- how far it is ahead of and behind the base
- whether it is merged
- whether it is pushed
- any uncommitted work

Run it before you start, so you don't open a second branch for the same work.

- **One branch per concern.** For a change that builds on another
  unmerged branch, branch from it (`safe-branch start <slug> --base
feat/parent`) and say so in the PR ("depends on #12").
- **After the parent merges,** move the child onto the base. Do this only
  while the child branch is yours alone:
  `git rebase --onto origin/$BASE feat/parent feat/child`
- **Never delete a branch with unmerged commits.** Remove `[merged]` ones
  only when the user agrees.

## 4. Commit

- Small, focused commits. Each one builds and passes tests.
- Conventional Commits: `feat(contact): add form validation`,
  `fix(api): handle empty payload`. Imperative mood, at most 72 characters,
  with a body explaining _why_ when it isn't obvious.
- Stage specific files (`git add <paths>`), not `git add -A`. Never commit
  secrets, `.env*` files with values, build output, or generated graphs.
- Run lint, type check, and tests before each commit you push.
- **Many changes at once:** `safe-branch split` suggests one commit per area,
  with tests kept next to their code, dependencies first and docs last.
  It prints the `git add` command for each group. Check each group with
  `git diff --cached`, and merge groups that only make sense together.
- **Before the PR:** `safe-branch commits` checks every commit on the branch:
  - the message format
  - `fixup!` or WIP commits left behind
  - commits over 400 lines
  - commits that mix more than 3 areas

  Fix those with `git rebase -i --autosquash origin/$BASE`, and only while
  the branch is yours and unpushed.

## 5. Stay current

Before pushing, update from the base branch: `git fetch origin && git rebase
"origin/$BASE"` while the branch is only yours, or merge if others already
pulled it. Resolve conflicts by understanding both sides, never by blindly
taking yours.

## 6. Sync a fork with its upstream

Use this to bring in upstream changes without touching ours. Start from a
clean tree on our main branch:

```bash
safe-branch sync --upstream https://github.com/<org>/<repo>.git   # report only
safe-branch sync --apply                                          # merge on sync/upstream-<date>
```

- **The report** fetches upstream, deepening a shallow clone if needed. It
  lists the new commits and the files each side changed, and runs a trial
  merge. Exit code 2 means there are conflicts. Nothing is changed.
- **`--apply`** does five things:
  1. tags a backup;
  2. creates `sync/<remote>-<date>` from our branch;
  3. merges upstream there with `--no-ff`;
  4. checks that every file only we changed is exactly as before;
  5. leaves our own branch as it was.
- **On conflicts,** the merge stops on the sync branch. Resolve each file
  keeping our behavior and adding upstream's change. Never take one side
  wholesale. Then `git add` the files and `git commit --no-edit`.
- **Then verify on the sync branch:** install dependencies, and run lint,
  type check, tests and the build. Look again at the files "changed by both"
  (`package.json`, lockfiles, translations, version numbers).
- **Land it** with `git switch main && git merge --ff-only sync/<…>`, then
  push. Never force-push our main, and never rebase our history onto
  upstream.

## 7. Push and open the PR

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

## 8. Reviewing a branch or PR

Check that the diff matches the description, it is scoped to one feature, the
tests cover the new behavior, there are no secrets or debug leftovers,
migrations are safe, and CI is green. Leave specific, actionable comments.
Approve or merge only when the user asks.

## Report

End with the branch name, the PR link (or why there isn't one), the commits,
and the verification you ran.

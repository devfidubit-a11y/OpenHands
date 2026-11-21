---
name: change-safety-guard
description: "Safety guard for every code or file change. Use before modifying, moving, or deleting anything in a repository or user folder: analyze what the change could damage or delete, get the user's explicit consent for destructive or sensitive changes, start work on a backed-up branch with safe-branch, and run safe-branch check before every commit and push."
---

# Change safety guard

Nothing gets deleted, overwritten, or broken without the user's consent. Your
job is to find what a change could damage **before** it happens, say it
plainly, and wait for a yes on anything destructive.

## Hard rules

1. **Never without explicit consent** for that exact item:
   - deleting or emptying files or folders, including `rm`, `git rm`,
     `git clean`, and moving files out of the repo;
   - `git reset --hard`, `git checkout -- <path>`, `git restore`, `git stash
     drop`, force-push, deleting branches or tags, rewriting history;
   - changing `.env*` files, secrets, keys, or credentials;
   - database migrations, schema or seed changes, and any command that writes
     to a real database;
   - CI/CD, deploy, or infrastructure config, and dependency upgrades or
     removals;
   - deploying or publishing anything (`wrangler deploy`, `versions deploy`,
     `secret put`, remote D1/KV/R2 writes, `npm publish`, merging PRs);
   - reinstalling dependencies in a folder mounted from the user's machine
     (`npm install` there replaces their native binaries). Use a worktree
     instead;
   - anything outside the task's folder.
2. Never discard work you didn't create. Uncommitted changes in the working
   tree belong to the user: don't stash, reset, overwrite, or commit them.
3. Never commit to the default branch, and never push without running
   `safe-branch check` first.
4. When in doubt, ask. A question costs a minute; lost work can't be undone.

"The user asked for the feature" is not consent to delete things along the
way. Consent is a clear yes to a list that named what would be deleted or
changed.

## Workflow

### 1. Before touching anything: impact analysis

- Read the request and list the files and areas you expect to change.
- Find what depends on them: imports and references (`grep -rn`), routes,
  database tables, env vars, public APIs, and tests. If `graphify-out/` exists,
  use `graphify explain <symbol>` and `graphify path A B` to see the blast
  radius.
- Write a short plan for the user that separates:
  - **Will add:** new files and features.
  - **Will modify:** existing files, and why.
  - **Will delete or replace:** every file, function, route, column, or config
    entry that goes away. This list needs consent.
  - **Risky areas:** data, auth, payments, secrets, infra, dependencies.

If the "delete or replace" or "risky" lists are not empty, stop and ask for
consent before you start.

### 2. Start safely

```bash
safe-branch start <short-slug>              # or --worktree when others share the checkout
```

It refuses when there are uncommitted changes. In that case, ask the user
what to do with them, or use `--worktree`. It also tags the current commit as
a local backup (`safe-branch backups` lists them), and creates
`feat/<slug>` from the up-to-date default branch.

### 3. While working

- Make the smallest change that does the job. Add, don't rewrite. Prefer
  deprecating over deleting.
- Don't reformat or "clean up" unrelated files.
- Before any command in the hard-rules list, stop and ask.

### 4. Before every commit and push

```bash
safe-branch check            # exit code 2 = needs consent
```

- **Exit 2:** show the user the "Needs the user's explicit consent" items and
  wait for approval of each one. Undo anything they reject.
- **"Tell the user" items** (renames, bulk removals, config, dependencies):
  mention them in your report and in the PR description.
- Never commit a secret. If one shows up, remove it from the change and tell
  the user so they can rotate it.

### 5. Report

End with: the branch, the backup tag, what was added, modified, and deleted
(with the consent you got for each deletion), the `safe-branch check` result,
and how to undo the change (`git switch -c restore <backup-tag>`, or close the
PR and delete the branch).

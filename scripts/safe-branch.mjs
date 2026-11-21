#!/usr/bin/env node
/**
 * safe-branch: start feature branches without losing anything, and check
 * what a change would damage or delete before it is committed or pushed.
 *
 *   safe-branch start <slug> [--prefix feat] [--base main] [--worktree]
 *       Refuses on uncommitted changes, tags the current commit as a local
 *       backup (safety/<time>-<branch>), and creates <prefix>/<slug> from the
 *       up-to-date base branch. --worktree puts it in ../<repo>-<slug>.
 *   safe-branch check [--base main] [--json]
 *       Compares the working tree (committed + uncommitted) with the base and
 *       lists deletions, renames, secrets, data, infra and dependency changes.
 *       Exit code 2 when something needs the user's consent.
 *   safe-branch backups
 *       Lists the backup tags, newest first.
 *
 * Read-only except `start`, which only creates a tag, a branch and optionally
 * a worktree. It never deletes, resets, stashes or pushes.
 */
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  addedLines,
  analyzeChange,
  formatReport,
  parseNameStatus,
  parseNumstat,
} from "./safe-branch-lib.mjs";

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).trimEnd();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function fail(message, code = 1) {
  console.error(`safe-branch: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--worktree" || arg === "--json") opts[arg.slice(2)] = true;
    else if (arg === "--base" || arg === "--prefix")
      opts[arg.slice(2)] = argv[++i];
    else opts._.push(arg);
  }
  return opts;
}

/** origin's default branch, else main/master, else the current branch. */
function resolveBase(explicit) {
  if (explicit) return explicit;
  const head = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const name of ["origin/main", "origin/master", "main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", name])) return name;
  }
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function dirtyPaths() {
  return git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean);
}

function start(opts) {
  const slug = (opts._[1] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug)
    fail(
      "usage: safe-branch start <slug> [--prefix feat] [--base main] [--worktree]",
    );
  const prefix = (opts.prefix ?? "feat").replace(/\/+$/, "");
  const branch = slug.includes("/") ? slug : `${prefix}/${slug}`;

  const dirty = dirtyPaths();
  if (dirty.length) {
    console.error("Uncommitted changes (not yours to move or discard):");
    for (const line of dirty.slice(0, 30)) console.error(`  ${line}`);
    fail(
      "the working tree is not clean. Ask the user, or use --worktree to work in a separate folder.",
      3,
    );
  }
  if (tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
    fail(
      `branch ${branch} already exists; pick another name or continue on it`,
    );
  }
  if (tryGit(["remote", "get-url", "origin"])) {
    try {
      git(["fetch", "--quiet", "origin"]);
    } catch (err) {
      console.error(
        `warning: fetch failed (${err.message.split("\n")[0]}); using local refs`,
      );
    }
  }
  const base = resolveBase(opts.base);
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*/, "");
  const tag = `safety/${stamp}-${current.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  git(["tag", tag, "HEAD"]);

  if (opts.worktree) {
    const top = git(["rev-parse", "--show-toplevel"]);
    const dir = resolve(
      dirname(top),
      `${basename(top)}-${slug.replace(/\//g, "-")}`,
    );
    git(["worktree", "add", "-b", branch, dir, base]);
    console.log(`Backup tag: ${tag} (at ${current})`);
    console.log(`Branch ${branch} from ${base} in worktree ${dir}`);
    console.log(`cd ${dir}`);
  } else {
    git(["switch", "-c", branch, base]);
    console.log(`Backup tag: ${tag} (at ${current})`);
    console.log(`Branch ${branch} created from ${base} and checked out`);
  }
}

function check(opts) {
  const base = resolveBase(opts.base);
  const mergeBase = tryGit(["merge-base", base, "HEAD"]) ?? base;
  const nameStatus = parseNameStatus(
    git(["diff", "--name-status", "-M", mergeBase]),
  );
  const numstat = parseNumstat(git(["diff", "--numstat", "-M", mergeBase]));
  const added = addedLines(git(["diff", "-U0", "--no-color", mergeBase]));
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  const analysis = analyzeChange({ nameStatus, numstat, added, untracked });
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (opts.json) {
    console.log(JSON.stringify({ base, branch, ...analysis }, null, 2));
  } else {
    console.log(formatReport({ base, branch, analysis, dirty: dirtyPaths() }));
  }
  process.exit(analysis.summary.high ? 2 : 0);
}

function backups() {
  const tags = tryGit([
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname:short)  %(objectname:short)  %(creatordate:iso)",
    "refs/tags/safety/",
  ]);
  console.log(tags || "No safety backups yet.");
  if (tags)
    console.log("\nRestore one into a new branch: git switch -c restore <tag>");
}

export function main(argv = process.argv.slice(2)) {
  if (!tryGit(["rev-parse", "--is-inside-work-tree"]))
    fail("not inside a git repository");
  const opts = parseArgs(argv);
  switch (opts._[0]) {
    case "start":
      return start(opts);
    case "check":
      return check(opts);
    case "backups":
      return backups();
    default:
      console.log(
        "usage: safe-branch start <slug> [--prefix feat] [--base main] [--worktree]\n" +
          "       safe-branch check [--base main] [--json]\n" +
          "       safe-branch backups",
      );
      return process.exit(opts._[0] ? 1 : 0);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}

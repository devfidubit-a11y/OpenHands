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
 *   safe-branch sync [--upstream <remote|url>] [--branch main] [--apply] [--worktree]
 *       Fork maintenance: fetches the upstream branch, shows its new commits,
 *       the files each side changed and a trial merge. --apply backs up,
 *       creates sync/<remote>-<date> from the current branch and merges
 *       upstream there (leaving conflicts to resolve, exit code 2), then
 *       checks that every file only we changed is exactly as before.
 *   safe-branch branches [--base main]
 *       Every local branch and worktree: ahead/behind the base, merged or
 *       not, uncommitted work, last commit.
 *   safe-branch commits [--base main]
 *       Lints the branch's commits: message format, fixups, size, mixed areas.
 *   safe-branch split
 *       Suggests how to split the uncommitted changes into focused commits.
 *
 * Read-only except `start` and `sync --apply`, which only create a tag, a
 * branch, a merge commit and optionally a worktree. It never deletes,
 * resets, stashes, rebases or pushes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  addedLines,
  analyzeChange,
  classifySync,
  formatReport,
  formatSyncReport,
  lintCommits,
  parseMergeTree,
  parseNameStatus,
  parseNumstat,
  planCommits,
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
    if (["--worktree", "--json", "--apply"].includes(arg))
      opts[arg.slice(2)] = true;
    else if (["--base", "--prefix", "--upstream", "--branch"].includes(arg))
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

function stampNow() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

function backupTag(label) {
  const tag = `safety/${stampNow()}-${label.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  git(["tag", tag, "HEAD"]);
  return tag;
}

function lines(text) {
  return String(text ?? "")
    .split("\n")
    .filter(Boolean);
}

/** The upstream remote: an existing name, or a URL added as "upstream". */
function upstreamRemote(value) {
  const wanted = value ?? "upstream";
  if (!/[:/]/.test(wanted)) {
    if (!tryGit(["remote", "get-url", wanted]))
      fail(
        `no remote "${wanted}". Add it once: safe-branch sync --upstream <url> (e.g. https://github.com/OpenHands/OpenHands.git)`,
      );
    return wanted;
  }
  for (const name of lines(git(["remote"]))) {
    if (tryGit(["remote", "get-url", name]) === wanted) return name;
  }
  if (tryGit(["remote", "get-url", "upstream"]))
    fail(
      `remote "upstream" already points elsewhere (${git(["remote", "get-url", "upstream"])}); pass its name instead`,
    );
  git(["remote", "add", "upstream", wanted]);
  return "upstream";
}

function sync(opts) {
  const remote = upstreamRemote(opts.upstream);
  const branch = opts.branch ?? "main";
  const upstream = `${remote}/${branch}`;
  const ours = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (opts.apply && dirtyPaths().length)
    fail(
      "the working tree is not clean; commit or set aside your changes first (nothing was touched)",
      3,
    );
  try {
    git(["fetch", "--quiet", remote, branch]);
  } catch (err) {
    fail(`fetch ${upstream} failed: ${err.message.split("\n")[0]}`);
  }
  // A shallow clone may not reach the common ancestor yet: deepen a bit.
  let mergeBase = tryGit(["merge-base", "HEAD", upstream]);
  for (let i = 0; !mergeBase && i < 5; i += 1) {
    if (tryGit(["rev-parse", "--is-shallow-repository"]) !== "true") break;
    tryGit(["fetch", "--quiet", "--deepen=200", remote, branch]);
    mergeBase = tryGit(["merge-base", "HEAD", upstream]);
  }
  if (!mergeBase)
    fail(
      `no common history with ${upstream}. In a shallow clone run: git fetch --unshallow`,
    );
  const behind = Number(git(["rev-list", "--count", `HEAD..${upstream}`]));
  const ahead = Number(git(["rev-list", "--count", `${upstream}..HEAD`]));
  const files = classifySync(
    lines(git(["diff", "--name-only", mergeBase, "HEAD"])),
    lines(git(["diff", "--name-only", mergeBase, upstream])),
  );
  const trial = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "HEAD", upstream],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (trial.status !== 0 && trial.status !== 1)
    fail(
      `trial merge failed: ${(trial.stderr || "").trim()} (needs git ≥ 2.38)`,
    );
  const { conflicts } = parseMergeTree(trial.stdout, trial.status);
  const commits = lines(
    git(["log", "--format=%h %s", "--no-merges", `HEAD..${upstream}`]),
  );
  const report = formatSyncReport({
    ours,
    upstream,
    behind,
    ahead,
    files,
    conflicts,
    commits,
    applying: Boolean(opts.apply),
  });
  if (opts.json && !opts.apply) {
    console.log(
      JSON.stringify(
        { ours, upstream, mergeBase, behind, ahead, files, conflicts, commits },
        null,
        2,
      ),
    );
    return process.exit(conflicts.length ? 2 : 0);
  }
  console.log(report);
  if (!opts.apply || behind === 0)
    return process.exit(conflicts.length ? 2 : 0);

  const tag = backupTag(ours);
  const day = stampNow().slice(0, 8);
  let syncBranch = `sync/${remote}-${day}`;
  for (
    let n = 2;
    tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${syncBranch}`]);
    n += 1
  )
    syncBranch = `sync/${remote}-${day}-${n}`;
  let dir = git(["rev-parse", "--show-toplevel"]);
  if (opts.worktree) {
    dir = resolve(
      dirname(dir),
      `${basename(dir)}-${syncBranch.replace(/\//g, "-")}`,
    );
    git(["worktree", "add", "-b", syncBranch, dir, "HEAD"]);
  } else git(["switch", "-c", syncBranch]);
  const oursHead = git(["rev-parse", "HEAD"]);
  console.log(`\nBackup tag: ${tag} (at ${ours})`);
  console.log(`Sync branch: ${syncBranch}${opts.worktree ? ` in ${dir}` : ""}`);
  const merge = spawnSync(
    "git",
    [
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `chore(sync): merge ${upstream} (${behind} commits)`,
      upstream,
    ],
    { cwd: dir, encoding: "utf-8" },
  );
  if (merge.status !== 0) {
    const open = lines(
      git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir }),
    );
    console.log("\nThe merge stopped on conflicts (left in place to resolve):");
    for (const path of open) console.log(`  ${path}`);
    console.log(
      "\nResolve each file keeping our behavior and upstream's changes, then `git add` them and `git commit --no-edit`. To give up: `git merge --abort` (the backup tag keeps everything).",
    );
    return process.exit(2);
  }
  // Our own files must come out exactly as they were.
  const touched = files.oursOnly.length
    ? lines(
        git(
          ["diff", "--name-only", oursHead, "HEAD", "--", ...files.oursOnly],
          {
            cwd: dir,
          },
        ),
      )
    : [];
  if (touched.length) {
    console.log("\nWARNING: files only we changed differ after the merge:");
    for (const path of touched) console.log(`  ${path}`);
    return process.exit(2);
  }
  console.log(
    `\nMerged. All ${files.oursOnly.length} file(s) only we changed are untouched; review the ${files.both.length} changed by both.`,
  );
  console.log(
    `Next: install deps, run lint/type check/tests on ${syncBranch}; then \`git switch ${ours} && git merge --ff-only ${syncBranch}\` and push.`,
  );
  return process.exit(0);
}

function worktreeMap() {
  const map = new Map();
  let path = null;
  for (const line of lines(git(["worktree", "list", "--porcelain"]))) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line.startsWith("branch refs/heads/"))
      map.set(line.slice("branch refs/heads/".length), path);
  }
  return map;
}

function branches(opts) {
  const base = resolveBase(opts.base);
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const trees = worktreeMap();
  const rows = [];
  for (const line of lines(
    git([
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)%09%(upstream:short)%09%(committerdate:relative)%09%(subject)",
      "refs/heads",
    ]),
  )) {
    const [name, tracking, when, subject] = line.split("\t");
    const counts = tryGit([
      "rev-list",
      "--left-right",
      "--count",
      `${base}...${name}`,
    ]);
    const [behind = "?", ahead = "?"] = (counts ?? "").split(/\s+/);
    const merged = tryGit(["merge-base", "--is-ancestor", name, base]) !== null;
    const tree = trees.get(name);
    const dirty = tree
      ? lines(tryGit(["-C", tree, "status", "--porcelain"]) ?? "").length
      : 0;
    rows.push(
      `${name === current ? "*" : " "} ${name}  +${ahead}/-${behind} vs ${base}${merged && name !== base.replace(/^origin\//, "") ? "  [merged]" : ""}${tracking ? `  ↔ ${tracking}` : "  (not pushed)"}${tree && tree !== git(["rev-parse", "--show-toplevel"]) ? `  worktree ${tree}` : ""}${dirty ? `  ${dirty} uncommitted` : ""}\n    ${when}: ${subject}`,
    );
  }
  console.log(`## Branches vs ${base}\n\n${rows.join("\n")}`);
  console.log(
    "\n[merged] branches can be removed once the user agrees (git branch -d <name>; git worktree remove <path>). Never delete one with unmerged commits.",
  );
}

function commits(opts) {
  const base = resolveBase(opts.base);
  const raw = git([
    "log",
    "--reverse",
    "--format=%x1e%H%x1f%P%x1f%s",
    "--numstat",
    `${base}..HEAD`,
  ]);
  const list = raw
    .split("\x1e")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [head, ...stat] = chunk.split("\n");
      const [hash, parents, subject] = head.split("\x1f");
      const numstat = parseNumstat(stat.join("\n"));
      return {
        hash,
        subject,
        merge: parents.trim().split(/\s+/).length > 1,
        files: [...numstat.keys()],
        added: [...numstat.values()].reduce((sum, item) => sum + item.added, 0),
        removed: [...numstat.values()].reduce(
          (sum, item) => sum + item.removed,
          0,
        ),
      };
    });
  const issues = lintCommits(list);
  console.log(
    `## ${list.length} commit(s) on ${git(["rev-parse", "--abbrev-ref", "HEAD"])} vs ${base}`,
  );
  for (const commit of list)
    console.log(
      `- ${commit.hash.slice(0, 7)} ${commit.subject} (+${commit.added}/-${commit.removed}, ${commit.files.length} files)`,
    );
  if (!issues.length) console.log("\nAll commits look good.");
  else {
    console.log("\n### Issues");
    for (const issue of issues)
      console.log(`- [${issue.level}] ${issue.commit}: ${issue.detail}`);
  }
  process.exit(issues.some((issue) => issue.level === "medium") ? 1 : 0);
}

function split() {
  const paths = dirtyPaths().map((line) => {
    const path = line.slice(3);
    return path.includes(" -> ") ? path.split(" -> ").pop() : path;
  });
  if (!paths.length) return console.log("Nothing to commit.");
  const plan = planCommits(paths);
  console.log(
    `## ${plan.length} focused commit(s) for ${paths.length} changed path(s)\n`,
  );
  plan.forEach((group, index) => {
    console.log(`${index + 1}. ${group.type}: <summary>   [${group.area}]`);
    console.log(
      `   git add -- ${group.files.map((file) => JSON.stringify(file)).join(" ")}`,
    );
  });
  console.log(
    "\nCheck each group with `git diff --cached` before committing, and run the tests after each one. Merge groups that only make sense together.",
  );
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
  const tag = backupTag(current);

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
    case "sync":
      return sync(opts);
    case "branches":
      return branches(opts);
    case "commits":
      return commits(opts);
    case "split":
      return split();
    default:
      console.log(
        "usage: safe-branch start <slug> [--prefix feat] [--base main] [--worktree]\n" +
          "       safe-branch check [--base main] [--json]\n" +
          "       safe-branch sync [--upstream <remote|url>] [--branch main] [--apply] [--worktree] [--json]\n" +
          "       safe-branch branches [--base main]\n" +
          "       safe-branch commits [--base main]\n" +
          "       safe-branch split\n" +
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

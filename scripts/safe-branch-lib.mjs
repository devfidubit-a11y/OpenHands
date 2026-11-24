/**
 * Pure risk analysis for safe-branch.mjs: classify a change against its base
 * branch and flag what must not happen without the user's consent.
 *
 * Levels: "high" needs explicit consent before commit/push, "medium" must be
 * mentioned to the user, "info" is context.
 */

const SECRET_PATH = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.dev\.vars$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)(id_rsa|id_ed25519)(\.pub)?$/i,
  /(^|\/)(secrets?|credentials?)(\/|\.|$)/i,
];
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;
const DATA_PATH = [
  /(^|\/)migrations?\//i,
  /(^|\/)prisma\/schema\.prisma$/i,
  /(^|\/)convex\/schema\.(ts|js)$/i,
  /(^|\/)drizzle\//i,
  /\.sql$/i,
  /(^|\/)seeds?\//i,
];
const INFRA_PATH = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)Dockerfile[^/]*$/i,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/i,
  /\.tf(vars)?$/i,
  /(^|\/)(k8s|helm|charts|deploy|infra)\//i,
  /(^|\/)(wrangler\.(toml|jsonc?)|vercel\.json|netlify\.toml|open-next\.config\.\w+)$/i,
  /(^|\/)next\.config\.\w+$/i,
];
const DEPS_PATH = [
  /(^|\/)package\.json$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock))$/i,
];
const SECRET_CONTENT = [
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-(live|proj|ant)?-?[A-Za-z0-9_-]{20,}/, "API secret key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, "Telegram bot token"],
  [
    /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    "hard-coded credential",
  ],
];

const matchesAny = (path, patterns) => patterns.some((re) => re.test(path));

/**
 * Parse `git diff --name-status -M` output into
 * [{ status: "A"|"M"|"D"|"R"|"C"|"T", path, from? }].
 */
export function parseNameStatus(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0][0];
    if (code === "R" || code === "C") {
      out.push({ status: code, from: parts[1], path: parts[2] });
    } else {
      out.push({ status: code, path: parts[1] });
    }
  }
  return out;
}

/** Parse `git diff --numstat -M` into a map path → { added, removed }. */
export function parseNumstat(text) {
  const map = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split("\t");
    let path = rest.join("\t");
    // renames: "old => new" or "dir/{old => new}/file"
    const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
    if (brace) path = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/");
    else if (path.includes(" => ")) path = path.split(" => ")[1];
    map.set(path, {
      added: added === "-" ? 0 : Number(added),
      removed: removed === "-" ? 0 : Number(removed),
      binary: added === "-",
    });
  }
  return map;
}

/** Added lines from a unified diff, as [{ path, line }]. */
export function addedLines(diffText) {
  const out = [];
  let path = null;
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice(6) : null;
    } else if (path && line.startsWith("+") && !line.startsWith("+++")) {
      out.push({ path, line: line.slice(1) });
    }
  }
  return out;
}

/**
 * Classify a change. Inputs are the parsed git outputs plus untracked paths.
 * Returns { findings: [{ level, kind, path, detail }], summary }.
 */
export function analyzeChange({
  nameStatus = [],
  numstat = new Map(),
  added = [],
  untracked = [],
  bulkRemovedLines = 50,
}) {
  const findings = [];
  const add = (level, kind, path, detail) =>
    findings.push({ level, kind, path, detail });

  for (const entry of nameStatus) {
    const { status, path } = entry;
    const stats = numstat.get(path) ?? { added: 0, removed: 0 };
    if (status === "D") {
      add("high", "delete", path, `file deleted (${stats.removed} lines)`);
    } else if (status === "R") {
      add("medium", "rename", path, `renamed from ${entry.from}`);
    }
    if (ENV_TEMPLATE.test(path)) {
      add(
        "medium",
        "env-template",
        path,
        "env template changed: make sure it holds no real values",
      );
    } else if (matchesAny(path, SECRET_PATH)) {
      add("high", "secret-file", path, "secrets or credentials file touched");
    } else if (matchesAny(path, DATA_PATH)) {
      add("high", "data", path, "database schema, migration or seed changed");
    } else if (matchesAny(path, INFRA_PATH)) {
      add("medium", "infra", path, "CI, deploy or runtime config changed");
    } else if (matchesAny(path, DEPS_PATH)) {
      add("medium", "deps", path, "dependencies or lockfile changed");
    }
    if (
      status === "M" &&
      stats.removed >= bulkRemovedLines &&
      stats.removed > stats.added * 2
    ) {
      add(
        "medium",
        "bulk-removal",
        path,
        `${stats.removed} lines removed, ${stats.added} added`,
      );
    }
  }

  for (const path of untracked) {
    if (!ENV_TEMPLATE.test(path) && matchesAny(path, SECRET_PATH)) {
      add(
        "high",
        "secret-file",
        path,
        "new untracked secrets file: never commit it",
      );
    }
  }

  const secretsByPath = new Map();
  for (const { path, line } of added) {
    for (const [re, label] of SECRET_CONTENT) {
      if (!re.test(line)) continue;
      const labels = secretsByPath.get(path) ?? new Set();
      labels.add(label);
      secretsByPath.set(path, labels);
    }
  }
  for (const [path, labels] of secretsByPath) {
    add(
      "high",
      "secret-content",
      path,
      `possible ${[...labels].join(", ")} added`,
    );
  }

  let addedTotal = 0;
  let removedTotal = 0;
  for (const s of numstat.values()) {
    addedTotal += s.added;
    removedTotal += s.removed;
  }
  const order = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return {
    findings,
    summary: {
      files: nameStatus.length,
      untracked: untracked.length,
      added: addedTotal,
      removed: removedTotal,
      high: findings.filter((f) => f.level === "high").length,
      medium: findings.filter((f) => f.level === "medium").length,
    },
  };
}

/** Human report (Markdown) for the analysis. */
export function formatReport({ base, branch, analysis, dirty = [] }) {
  const { findings, summary } = analysis;
  const lines = [
    `## Change safety check: ${branch} vs ${base}`,
    "",
    `${summary.files} files changed (+${summary.added} / -${summary.removed} lines), ${summary.untracked} untracked.`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("No risky changes found.");
  } else {
    for (const level of ["high", "medium"]) {
      const group = findings.filter((f) => f.level === level);
      if (!group.length) continue;
      lines.push(
        level === "high"
          ? "### Needs the user's explicit consent"
          : "### Tell the user",
      );
      for (const f of group) lines.push(`- \`${f.path}\`: ${f.detail}`);
      lines.push("");
    }
  }
  if (dirty.length) {
    lines.push("", "Uncommitted changes are included in this check.");
  }
  if (summary.high) {
    lines.push(
      "",
      "STOP: do not commit, push, or delete until the user approves each item above.",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Upstream sync (fork maintenance), branches and commits
// ---------------------------------------------------------------------------

/**
 * Splits the paths each side changed since the merge base:
 * ours only (must come out of the sync untouched), theirs only, and both
 * (need a look even when git merges them on its own).
 */
export function classifySync(ours, theirs) {
  const mine = new Set(ours);
  const upstream = new Set(theirs);
  return {
    oursOnly: [...mine].filter((path) => !upstream.has(path)).sort(),
    theirsOnly: [...upstream].filter((path) => !mine.has(path)).sort(),
    both: [...mine].filter((path) => upstream.has(path)).sort(),
  };
}

/**
 * `git merge-tree --write-tree --name-only` output: the tree id, then (on
 * conflict) the conflicted paths, a blank line and informational messages.
 */
export function parseMergeTree(text, exitCode = 0) {
  const [tree = "", ...rest] = String(text ?? "").split("\n");
  const end = rest.indexOf("");
  const conflicts =
    exitCode === 1 ? rest.slice(0, end < 0 ? rest.length : end) : [];
  return {
    tree: tree.trim(),
    conflicts: [...new Set(conflicts.filter(Boolean))],
  };
}

export function formatSyncReport({
  ours,
  upstream,
  behind,
  ahead,
  files,
  conflicts,
  commits = [],
  applying = false,
}) {
  const lines = [
    `## Upstream sync: ${upstream} → ${ours}`,
    "",
    `${behind} new upstream commit(s); ${ahead} commit(s) of ours on top.`,
    `Files: ${files.theirsOnly.length} only upstream, ${files.oursOnly.length} only ours (kept as they are), ${files.both.length} changed by both.`,
  ];
  if (commits.length) {
    lines.push("", "### New upstream commits");
    for (const line of commits.slice(0, 40)) lines.push(`- ${line}`);
    if (commits.length > 40) lines.push(`- … ${commits.length - 40} more`);
  }
  if (files.both.length) {
    lines.push("", "### Changed by both (review after the merge)");
    for (const path of files.both) lines.push(`- \`${path}\``);
  }
  lines.push("");
  if (behind === 0) lines.push("Already up to date.");
  else if (conflicts.length) {
    lines.push("### Conflicts (a trial merge, nothing was changed)");
    for (const path of conflicts) lines.push(`- \`${path}\``);
    lines.push(
      "",
      "Resolve them on a sync branch: keep our behavior and take upstream's on top; never drop either side blindly.",
    );
  } else
    lines.push(
      applying
        ? "Merges cleanly."
        : "Merges cleanly. Run with --apply to create the sync branch.",
    );
  return lines.join("\n");
}

const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: \S/;

/**
 * Checks each commit of a branch: message format, fixups left behind, size,
 * and commits that touch many unrelated areas (should be split).
 * commits: [{hash, subject, files:[path], added, removed, merge}]
 */
export function lintCommits(commits, { maxLines = 400, maxAreas = 3 } = {}) {
  const issues = [];
  for (const commit of commits) {
    const id = `${commit.hash.slice(0, 7)} ${commit.subject}`;
    if (commit.merge) continue;
    if (/^(fixup|squash|amend)! /.test(commit.subject))
      issues.push({
        commit: id,
        level: "medium",
        detail:
          "fixup left behind: squash it before the PR (git rebase -i --autosquash, only on your own unpushed branch)",
      });
    else if (/^(wip|tmp|temp)\b/i.test(commit.subject))
      issues.push({
        commit: id,
        level: "medium",
        detail: "work-in-progress commit: reword or squash it",
      });
    else if (!CONVENTIONAL.test(commit.subject))
      issues.push({
        commit: id,
        level: "info",
        detail: "not a Conventional Commit (type(scope): summary)",
      });
    if (commit.subject.length > 72)
      issues.push({
        commit: id,
        level: "info",
        detail: `subject is ${commit.subject.length} characters (max 72)`,
      });
    const lines = (commit.added ?? 0) + (commit.removed ?? 0);
    if (lines > maxLines)
      issues.push({
        commit: id,
        level: "medium",
        detail: `${lines} changed lines: consider splitting it`,
      });
    const areas = new Set((commit.files ?? []).map(areaOf));
    areas.delete("deps");
    if (areas.size > maxAreas)
      issues.push({
        commit: id,
        level: "medium",
        detail: `touches ${areas.size} areas (${[...areas].join(", ")}): one concern per commit`,
      });
  }
  return issues;
}

/**
 * The area a path belongs to, for grouping changes into commits: tests go
 * with the code they test, lockfiles and manifests with "deps".
 */
export function areaOf(path) {
  const value = String(path);
  if (matchesAny(value, DEPS_PATH)) return "deps";
  const parts = value
    .replace(/^(__tests__|tests?|spec)\//, "")
    .replace(/\.(test|spec)\.[^.]+$/, "")
    .split("/");
  if (parts.length === 1) return "root";
  if (
    ["src", "app", "lib", "packages", "skills", "apps"].includes(parts[0]) &&
    parts.length > 2
  )
    return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/**
 * Splits a set of changed paths into suggested commits, one per area, in a
 * safe order (deps first, docs last), each with a Conventional Commit type.
 */
export function planCommits(paths) {
  const groups = new Map();
  for (const path of paths) {
    const area = areaOf(path);
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(path);
  }
  const rank = (area) => (area === "deps" ? 0 : area === "docs" ? 2 : 1);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([area, files]) => {
      const isTest = files.every((file) =>
        /(^|\/)(__tests__|tests?)\/|\.(test|spec)\./.test(file),
      );
      const type =
        area === "deps"
          ? "chore(deps)"
          : area === "docs" || files.every((file) => /\.mdx?$/i.test(file))
            ? "docs"
            : isTest
              ? `test(${area.split("/").pop()})`
              : `feat(${area.split("/").pop()})`;
      return { area, type, files: files.sort() };
    });
}

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

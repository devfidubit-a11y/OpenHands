import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeChange,
  areaOf,
  classifySync,
  lintCommits,
  parseMergeTree,
  parseNameStatus,
  parseNumstat,
  planCommits,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/safe-branch-lib.mjs";

const CLI = resolve(__dirname, "../../scripts/safe-branch.mjs");

describe("analyzeChange", () => {
  it("flags deletions, secrets, data and infra; keeps plain edits quiet", () => {
    const nameStatus = parseNameStatus(
      [
        "D\tsrc/old.ts",
        "M\tsrc/app.ts",
        "M\t.env.production",
        "A\tconvex/migrations/002.ts",
        "M\t.github/workflows/ci.yml",
        "M\t.env.example",
        "R087\tsrc/a.ts\tsrc/b.ts",
        "M\tsrc/big.ts",
      ].join("\n"),
    );
    const numstat = parseNumstat(
      [
        "0\t40\tsrc/old.ts",
        "3\t1\tsrc/app.ts",
        "1\t1\t.env.production",
        "10\t0\tconvex/migrations/002.ts",
        "2\t2\t.github/workflows/ci.yml",
        "0\t0\tsrc/{a.ts => b.ts}",
        "5\t120\tsrc/big.ts",
      ].join("\n"),
    );

    const { findings, summary } = analyzeChange({
      nameStatus,
      numstat,
      added: [
        {
          path: "src/app.ts",
          line: 'const apiKey = "sk-live-abcdefghijklmnopqrstuvwx"',
        },
      ],
      untracked: [".env.local"],
    });

    const byKind = (kind: string) =>
      findings
        .filter((f: { kind: string }) => f.kind === kind)
        .map((f: { path: string }) => f.path);
    expect(byKind("delete")).toEqual(["src/old.ts"]);
    expect(byKind("secret-file")).toEqual([".env.production", ".env.local"]);
    expect(byKind("data")).toEqual(["convex/migrations/002.ts"]);
    expect(byKind("infra")).toEqual([".github/workflows/ci.yml"]);
    expect(byKind("env-template")).toEqual([".env.example"]);
    expect(byKind("rename")).toEqual(["src/b.ts"]);
    expect(byKind("bulk-removal")).toEqual(["src/big.ts"]);
    expect(byKind("secret-content")).toEqual(["src/app.ts"]);
    expect(
      findings.some(
        (f: { path: string; kind: string }) =>
          f.path === "src/app.ts" && f.kind !== "secret-content",
      ),
    ).toBe(false);
    expect(summary.high).toBe(5);
    expect(findings[0].level).toBe("high");
  });
});

describe("safe-branch CLI", () => {
  let repo: string;
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: "utf-8",
    });

  function makeRepo() {
    repo = mkdtempSync(join(tmpdir(), "safe-branch-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "keep.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "remove-me.ts"), "export const b = 2;\n");
    git("add", ".");
    git("commit", "-qm", "init");
  }

  it("refuses to start on uncommitted changes and touches nothing", () => {
    makeRepo();
    writeFileSync(join(repo, "keep.ts"), "export const a = 2;\n");

    const result = run("start", "contact-form");

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("keep.ts");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git("tag", "--list", "safety/*")).toBe("");
  });

  it("backs up, branches, and blocks a deletion until consent", () => {
    makeRepo();

    const started = run("start", "contact-form");
    expect(started.status).toBe(0);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/contact-form");
    expect(git("tag", "--list", "safety/*")).toMatch(
      /^safety\/\d{8}T\d{6}-main$/,
    );

    expect(run("check", "--base", "main").status).toBe(0);

    unlinkSync(join(repo, "remove-me.ts"));
    const checked = run("check", "--base", "main");
    expect(checked.status).toBe(2);
    expect(checked.stdout).toContain("`remove-me.ts`: file deleted");
    expect(checked.stdout).toContain("STOP");
  });
});

describe("sync, commits and split helpers", () => {
  it("splits paths by side and reads merge-tree conflicts", () => {
    expect(classifySync(["a", "both", "ours"], ["both", "theirs"])).toEqual({
      oursOnly: ["a", "ours"],
      theirsOnly: ["theirs"],
      both: ["both"],
    });
    expect(parseMergeTree("abc123\n", 0)).toEqual({
      tree: "abc123",
      conflicts: [],
    });
    expect(
      parseMergeTree("abc123\nsrc/x.ts\nsrc/x.ts\n\nAuto-merging src/x.ts", 1)
        .conflicts,
    ).toEqual(["src/x.ts"]);
  });

  it("flags fixups, WIP, oversized and mixed commits", () => {
    const issues = lintCommits([
      {
        hash: "a".repeat(40),
        subject: "feat(api): add route",
        files: ["src/api/x.ts"],
        added: 10,
        removed: 0,
      },
      {
        hash: "b".repeat(40),
        subject: "fixup! feat(api): add route",
        files: ["src/api/x.ts"],
        added: 1,
        removed: 0,
      },
      { hash: "c".repeat(40), subject: "wip", files: [], added: 0, removed: 0 },
      {
        hash: "d".repeat(40),
        subject: "feat: everything",
        files: ["src/a/1", "src/b/2", "docs/x.md", "scripts/y.mjs"],
        added: 900,
        removed: 0,
      },
      {
        hash: "e".repeat(40),
        subject: "Merge upstream",
        merge: true,
        files: [],
        added: 0,
        removed: 0,
      },
    ]);
    const details = issues
      .map((issue: { detail: string }) => issue.detail)
      .join(" | ");
    expect(
      issues.some((issue: { commit: string }) =>
        issue.commit.startsWith("aaaaaaa"),
      ),
    ).toBe(false);
    expect(details).toContain("fixup left behind");
    expect(details).toContain("work-in-progress");
    expect(details).toContain("900 changed lines");
    expect(details).toContain("touches 4 areas");
    expect(details).not.toContain("Merge upstream");
  });

  it("groups changes into focused commits, tests with their code", () => {
    expect(areaOf("__tests__/scripts/foo.test.ts")).toBe("scripts");
    expect(areaOf("src/components/x/y.tsx")).toBe("src/components");
    expect(areaOf("package-lock.json")).toBe("deps");
    expect(
      planCommits([
        "docs/MEMORY.md",
        "scripts/a.mjs",
        "__tests__/scripts/a.test.ts",
        "package.json",
      ]),
    ).toEqual([
      { area: "deps", type: "chore(deps)", files: ["package.json"] },
      {
        area: "scripts",
        type: "feat(scripts)",
        files: ["__tests__/scripts/a.test.ts", "scripts/a.mjs"],
      },
      { area: "docs", type: "docs", files: ["docs/MEMORY.md"] },
    ]);
  });
});

describe("safe-branch sync (fork maintenance)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  const commit = (cwd: string, file: string, text: string, message: string) => {
    writeFileSync(join(cwd, file), text);
    sh(cwd, "add", file);
    sh(cwd, "commit", "-qm", message);
  };

  function makeFork() {
    const up = mkdtempSync(join(tmpdir(), "sync-up-"));
    const fork = mkdtempSync(join(tmpdir(), "sync-fork-"));
    dirs.push(up, fork);
    sh(up, "init", "-q", "-b", "main");
    sh(up, "config", "user.email", "t@example.com");
    sh(up, "config", "user.name", "t");
    commit(up, "shared.txt", "one\n", "init");
    sh(fork, "clone", "-q", up, ".");
    sh(fork, "config", "user.email", "t@example.com");
    sh(fork, "config", "user.name", "t");
    commit(fork, "ours.txt", "our feature\n", "feat: ours");
    commit(up, "theirs.txt", "their feature\n", "feat: theirs");
    return { up, fork };
  }
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf-8" });

  it("reports, then merges upstream on a sync branch keeping our files", () => {
    const { up, fork } = makeFork();
    const report = run(fork, "sync", "--upstream", up);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain(
      "1 new upstream commit(s); 1 commit(s) of ours",
    );
    expect(report.stdout).toContain("Merges cleanly");
    expect(sh(fork, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    const applied = run(fork, "sync", "--upstream", up, "--apply");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain(
      "All 1 file(s) only we changed are untouched",
    );
    expect(sh(fork, "rev-parse", "--abbrev-ref", "HEAD")).toMatch(
      /^sync\/origin-\d{8}$/,
    );
    expect(sh(fork, "show", "HEAD:theirs.txt")).toBe("their feature");
    expect(sh(fork, "show", "HEAD:ours.txt")).toBe("our feature");
    // main itself is untouched until the user fast-forwards it
    expect(sh(fork, "ls-tree", "--name-only", "main")).not.toContain(
      "theirs.txt",
    );
  });

  it("stops on a conflict and leaves it on the sync branch", () => {
    const { up, fork } = makeFork();
    commit(fork, "shared.txt", "ours\n", "fix: ours");
    commit(up, "shared.txt", "theirs\n", "fix: theirs");
    const report = run(fork, "sync", "--upstream", up);
    expect(report.status).toBe(2);
    expect(report.stdout).toContain("`shared.txt`");
    const applied = run(fork, "sync", "--upstream", up, "--apply");
    expect(applied.status).toBe(2);
    expect(applied.stdout).toContain("shared.txt");
    expect(sh(fork, "diff", "--name-only", "--diff-filter=U")).toBe(
      "shared.txt",
    );
    expect(sh(fork, "tag", "--list", "safety/*")).toMatch(/^safety\//);
  });
});

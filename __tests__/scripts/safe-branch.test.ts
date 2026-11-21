import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeChange,
  parseNameStatus,
  parseNumstat,
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

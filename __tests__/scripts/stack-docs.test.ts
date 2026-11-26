// @ts-nocheck -- tests a plain-JS script: allowJs infers `= null` defaults as type null.
import { describe, expect, it } from "vitest";

import {
  STACK_KEYS,
  buildStackNote,
  changedStacks,
  fetchVersions,
  formatVersionsMessage,
  selectStacks,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/stack-docs-lib.mjs";
import {
  buildContext7Server,
  buildSimMcpServer,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/register-dev-mcps.mjs";
import {
  EXPERT_PROFILES,
  buildExpertProfile,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/register-agent-profiles.mjs";

const FEEDS: Record<string, string> = {
  "https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json":
    JSON.stringify({
      current_release: { stable: "h1" },
      releases: [
        { hash: "h0", version: "3.49.0" },
        {
          hash: "h1",
          version: "3.50.1",
          dart_sdk_version: "3.14.0",
          release_date: "2026-11-20T00:00:00Z",
        },
      ],
    }),
  "https://endoflife.date/api/v1/products/nodejs/": JSON.stringify({
    result: {
      releases: [
        {
          name: "27",
          isLts: false,
          isEol: false,
          latest: { name: "27.1.0", date: "2026-11-01" },
        },
        {
          name: "26",
          isLts: true,
          isEol: false,
          latest: { name: "26.13.1", date: "2026-11-11" },
        },
      ],
    },
  }),
  "https://registry.npmjs.org/next/latest": JSON.stringify({
    version: "16.4.6",
  }),
  "https://registry.npmjs.org/@nestjs/core/latest": JSON.stringify({
    version: "12.6.3",
  }),
  "https://endoflife.date/api/v1/products/python/": JSON.stringify({
    result: {
      releases: [
        {
          name: "3.15",
          isEol: false,
          latest: { name: "3.15.2", date: "2026-10-25" },
        },
      ],
    },
  }),
  "https://static.rust-lang.org/dist/channel-rust-stable.toml":
    'date = "2026-11-12"\n[pkg.cargo]\nversion = "0.101.0 (x)"\n[pkg.rust]\nversion = "1.100.0 (3acc 2026-11-05)"\n',
  "https://go.dev/dl/?mode=json": JSON.stringify([
    { version: "go1.27.4", stable: true },
  ]),
  "https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json":
    JSON.stringify({
      "releases-index": [
        {
          "channel-version": "11.0",
          "latest-release": "11.0.0",
          "support-phase": "active",
          "release-type": "sts",
        },
        {
          "channel-version": "10.0",
          "latest-release": "10.0.15",
          "support-phase": "active",
          "release-type": "lts",
        },
      ],
    }),
  "https://api.github.com/repos/llvm/llvm-project/releases/latest":
    JSON.stringify({
      tag_name: "llvmorg-23.1.6",
      published_at: "2026-11-17T00:00:00Z",
    }),
  "https://registry.npmjs.org/typescript/latest": JSON.stringify({
    version: "7.0.2",
  }),
  "https://raw.githubusercontent.com/tc39/proposals/main/finished-proposals.md":
    "| a | 2025 |\n| b | 2026 |\n| c | 2099 |\n",
  "https://api.adoptium.net/v3/info/available_releases": JSON.stringify({
    most_recent_lts: 25,
    most_recent_feature_release: 27,
  }),
};
const get = async (url: string) => {
  if (!(url in FEEDS)) throw new Error(`HTTP 404 ${url}`);
  return FEEDS[url];
};

describe("stack docs watcher", () => {
  it("reads every stack's latest stable version from its feed", async () => {
    const { versions, errors } = await fetchVersions(STACK_KEYS, get);
    expect(errors).toEqual({});
    expect(versions.flutter).toMatchObject({
      version: "3.50.1",
      detail: "Dart 3.14.0",
    });
    expect(versions.node).toMatchObject({
      version: "26.13.1",
      detail: "LTS · current 27.1.0",
    });
    expect(versions.python.docs).toEqual([
      "https://docs.python.org/3/whatsnew/3.15.html",
    ]);
    expect(versions.rust.version).toBe("1.100.0");
    expect(versions.go).toMatchObject({
      version: "1.27.4",
      docs: ["https://go.dev/doc/go1.27"],
    });
    expect(versions.csharp.detail).toBe("C# 15 · LTS .NET 10.0.15");
    expect(versions.cpp.version).toBe("23.1.6");
    expect(versions.javascript.detail).toBe("TypeScript · ECMAScript 2026");
    expect(versions.java).toMatchObject({ version: "27", detail: "LTS 25" });
    expect(versions.nestjs.docs[0]).toContain("/v12.6.3");
  });

  it("keeps the last known version when a feed fails", async () => {
    const previous = { go: { version: "1.27.3" } };
    const { versions, errors } = await fetchVersions(
      ["go"],
      async () => {
        throw new Error("down");
      },
      previous,
    );
    expect(errors.go).toBe("down");
    expect(versions.go.version).toBe("1.27.3");
  });

  it("detects changes and selects stacks", () => {
    expect(
      changedStacks(
        { go: { version: "1.27.3" }, rust: { version: "1.100.0" } },
        {
          go: { version: "1.27.4" },
          rust: { version: "1.100.0" },
          java: { version: "27" },
        },
      ),
    ).toEqual(["go", "java"]);
    expect(selectStacks("Flutter, go, cobol")).toEqual(["flutter", "go"]);
    expect(selectStacks("")).toEqual(STACK_KEYS);
  });

  it("writes the always-on note and the Telegram summary", async () => {
    const { versions } = await fetchVersions(STACK_KEYS, get);
    const note = buildStackNote(versions, {
      checkedAt: new Date("2026-11-26T10:00:00Z"),
    });
    expect(note).toContain(
      "| Flutter / Dart | 3.50.1 | Dart 3.14.0 | 2026-11-20 |",
    );
    expect(note).toContain("context7");
    expect(note).toContain("pubspec.lock");
    expect(buildStackNote(versions, { context7: false })).not.toContain(
      "context7",
    );
    const message = formatVersionsMessage({
      versions,
      checkedAt: "2026-11-26T10:00:00Z",
      changes: [
        {
          stack: "go",
          from: "1.27.3",
          to: "1.27.4",
          at: "2026-11-25T00:00:00Z",
        },
      ],
    });
    expect(message).toContain("• Go: 1.27.4");
    expect(message).toContain("2026-11-25 Go: 1.27.3 → 1.27.4");
    expect(formatVersionsMessage(null)).toContain("Aún no");
  });
});

describe("dev MCPs and expert profiles", () => {
  it("registers Context7 and the simulator with optional bearer auth", () => {
    expect(buildContext7Server({})).toMatchObject({
      url: "https://mcp.context7.com/mcp",
      transport: "http",
    });
    expect(buildContext7Server({}).auth).toBeUndefined();
    expect(buildContext7Server({ CONTEXT7_API_KEY: "k" }).auth).toEqual({
      strategy: "bearer",
      value: "k",
    });
    const sim = buildSimMcpServer({
      SIM_MCP_URL: "http://h:8932/mcp",
      SIM_MCP_TOKEN: "t",
    });
    expect(sim).toMatchObject({
      url: "http://h:8932/mcp",
      auth: { strategy: "bearer", value: "t" },
    });
    expect(sim.timeout).toBeGreaterThanOrEqual(1_800_000);
  });

  it("builds the flutter and mobile-qa profiles on the default profile's LLM", () => {
    expect(Object.keys(EXPERT_PROFILES)).toEqual(["flutter", "mobile-qa"]);
    const profile = buildExpertProfile("flutter", {
      llm_profile_ref: "claude-opus-5-5",
      public_skills: ["github"],
    });
    expect(profile).toMatchObject({
      agent_kind: "openhands",
      name: "flutter",
      llm_profile_ref: "claude-opus-5-5",
      mcp_server_refs: null,
      public_skills: ["github"],
    });
    expect(profile.system_message_suffix).toContain("flutter-expert");
    expect(profile.system_message_suffix).toContain("flutter_run_ios");
    expect(buildExpertProfile("mobile-qa").system_message_suffix).toContain(
      "sim_ui",
    );
  });
});

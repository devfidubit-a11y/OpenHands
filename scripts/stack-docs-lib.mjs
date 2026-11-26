/**
 * Stack docs watcher helpers (docs/STACK_DOCS.md): where each stack
 * publishes its latest stable version, which official pages describe what
 * changed, and the always-on note that tells every agent the current
 * versions and to read version-specific docs through Context7.
 *
 * Every source is official (the project's own release feed or registry) or
 * endoflife.date, which aggregates them. No dependencies.
 */

const json = async (get, url) => JSON.parse(await get(url));
const major = (v) => String(v).split(".")[0];
const minor = (v) => String(v).split(".").slice(0, 2).join(".");

/**
 * key → {label, latest(get) → {version, detail?, docs: [urls]}, llms: [urls]}.
 * `get(url)` returns the response body as text.
 */
export const STACKS = {
  flutter: {
    label: "Flutter / Dart",
    llms: ["https://docs.flutter.dev/llms.txt", "https://dart.dev/llms.txt"],
    async latest(get) {
      const data = await json(
        get,
        "https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json",
      );
      const hash = data.current_release?.stable;
      const release = data.releases?.find((r) => r.hash === hash);
      if (!release) throw new Error("no stable release");
      return {
        version: release.version,
        detail: `Dart ${release.dart_sdk_version}`,
        released: release.release_date?.slice(0, 10),
        docs: [
          "https://docs.flutter.dev/release/whats-new",
          "https://docs.flutter.dev/release/release-notes",
          "https://dart.dev/resources/whats-new",
        ],
      };
    },
  },
  node: {
    label: "Node.js",
    llms: [],
    async latest(get) {
      const data = await json(
        get,
        "https://endoflife.date/api/v1/products/nodejs/",
      );
      const releases = data.result?.releases ?? [];
      const lts = releases.find((r) => r.isLts && !r.isEol);
      const current = releases[0];
      if (!lts?.latest) throw new Error("no LTS release");
      return {
        version: lts.latest.name,
        detail:
          current && current !== lts
            ? `LTS · current ${current.latest?.name}`
            : "LTS",
        released: lts.latest.date,
        docs: [
          `https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V${major(lts.latest.name)}.md`,
        ],
      };
    },
  },
  nextjs: {
    label: "Next.js",
    llms: ["https://nextjs.org/docs/llms.txt"],
    async latest(get) {
      const { version } = await json(
        get,
        "https://registry.npmjs.org/next/latest",
      );
      return { version, docs: ["https://nextjs.org/blog"] };
    },
  },
  nestjs: {
    label: "NestJS",
    llms: ["https://docs.nestjs.com/llms.txt"],
    async latest(get) {
      const { version } = await json(
        get,
        "https://registry.npmjs.org/@nestjs/core/latest",
      );
      return {
        version,
        docs: [`https://github.com/nestjs/nest/releases/tag/v${version}`],
      };
    },
  },
  python: {
    label: "Python",
    llms: [],
    async latest(get) {
      const data = await json(
        get,
        "https://endoflife.date/api/v1/products/python/",
      );
      const release = (data.result?.releases ?? []).find(
        (r) => !r.isEol && r.latest,
      );
      if (!release) throw new Error("no release");
      return {
        version: release.latest.name,
        released: release.latest.date,
        docs: [
          `https://docs.python.org/3/whatsnew/${minor(release.latest.name)}.html`,
        ],
      };
    },
  },
  rust: {
    label: "Rust",
    llms: [],
    async latest(get) {
      const toml = await get(
        "https://static.rust-lang.org/dist/channel-rust-stable.toml",
      );
      const section = toml.split(/^\[pkg\.rust\]\s*$/m)[1] ?? "";
      const version = /^version\s*=\s*"(\d+\.\d+\.\d+)/m.exec(section)?.[1];
      if (!version) throw new Error("no rust version");
      const date = /^date\s*=\s*"([\d-]+)"/m.exec(toml)?.[1];
      return {
        version,
        released: date,
        docs: ["https://doc.rust-lang.org/stable/releases.html"],
      };
    },
  },
  go: {
    label: "Go",
    llms: [],
    async latest(get) {
      const data = await json(get, "https://go.dev/dl/?mode=json");
      const release = data.find((r) => r.stable);
      if (!release) throw new Error("no stable go");
      const version = release.version.replace(/^go/, "");
      return { version, docs: [`https://go.dev/doc/go${minor(version)}`] };
    },
  },
  csharp: {
    label: "C# / .NET",
    llms: [],
    async latest(get) {
      const data = await json(
        get,
        "https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json",
      );
      const active = (data["releases-index"] ?? []).filter(
        (r) => r["support-phase"] === "active",
      );
      const newest = active[0];
      if (!newest) throw new Error("no active .NET");
      const lts = active.find((r) => r["release-type"] === "lts");
      const net = Number(major(newest["channel-version"]));
      const csharp = net + 4; // .NET 10 ships C# 14
      return {
        version: newest["latest-release"],
        detail: `C# ${csharp}${lts && lts !== newest ? ` · LTS .NET ${lts["latest-release"]}` : newest["release-type"] === "lts" ? " · LTS" : ""}`,
        released: newest["latest-release-date"],
        docs: [
          `https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-${net}/overview`,
          `https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-${csharp}`,
        ],
      };
    },
  },
  cpp: {
    label: "C++ (LLVM/Clang)",
    llms: [],
    async latest(get) {
      const data = await json(
        get,
        "https://api.github.com/repos/llvm/llvm-project/releases/latest",
      );
      const version = String(data.tag_name ?? "").replace(/^llvmorg-/, "");
      if (!/^\d+\./.test(version)) throw new Error("no llvm release");
      return {
        version,
        detail: "Clang/LLVM; compiler support per standard in cppreference",
        released: data.published_at?.slice(0, 10),
        docs: ["https://en.cppreference.com/w/cpp/compiler_support"],
      };
    },
  },
  javascript: {
    label: "JavaScript / TypeScript",
    llms: [],
    async latest(get) {
      const { version } = await json(
        get,
        "https://registry.npmjs.org/typescript/latest",
      );
      const finished = await get(
        "https://raw.githubusercontent.com/tc39/proposals/main/finished-proposals.md",
      );
      const year = new Date().getUTCFullYear();
      const years = [...finished.matchAll(/\|\s*(20\d\d)\s*\|/g)]
        .map((m) => Number(m[1]))
        .filter((y) => y <= year);
      const es = years.length ? Math.max(...years) : null;
      return {
        version,
        detail: `TypeScript${es ? ` · ECMAScript ${es}` : ""}`,
        docs: [
          "https://raw.githubusercontent.com/tc39/proposals/main/finished-proposals.md",
          "https://www.typescriptlang.org/docs/handbook/release-notes/overview.html",
        ],
      };
    },
  },
  java: {
    label: "Java",
    llms: [],
    async latest(get) {
      const data = await json(
        get,
        "https://api.adoptium.net/v3/info/available_releases",
      );
      const lts = data.most_recent_lts;
      const feature = data.most_recent_feature_release;
      if (!lts) throw new Error("no java release");
      return {
        version: String(feature ?? lts),
        detail: `LTS ${lts}`,
        docs: [`https://openjdk.org/projects/jdk/${feature ?? lts}/`],
      };
    },
  },
};

export const STACK_KEYS = Object.keys(STACKS);

/** Stack keys from "flutter,go" (default all); unknown keys are dropped. */
export function selectStacks(raw) {
  const wanted = String(raw ?? "")
    .split(",")
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
  return wanted.length ? wanted.filter((key) => key in STACKS) : STACK_KEYS;
}

/**
 * Latest versions for `keys`. A failing source keeps its previous value and
 * is reported in `errors`, so one outage never wipes the table.
 */
export async function fetchVersions(keys, get, previous = {}) {
  const versions = {};
  const errors = {};
  await Promise.all(
    keys.map(async (key) => {
      try {
        versions[key] = await STACKS[key].latest(get);
      } catch (error) {
        errors[key] = error.message;
        if (previous[key]) versions[key] = previous[key];
      }
    }),
  );
  return { versions, errors };
}

/** Keys whose version (or detail) changed since `previous`. */
export function changedStacks(previous = {}, next = {}) {
  return Object.keys(next).filter(
    (key) =>
      previous[key]?.version !== next[key]?.version ||
      previous[key]?.detail !== next[key]?.detail,
  );
}

/** Markdown table of the versions, in STACKS order. */
export function formatVersionsTable(versions) {
  const rows = STACK_KEYS.filter((key) => versions[key]).map((key) => {
    const v = versions[key];
    return `| ${STACKS[key].label} | ${v.version} | ${v.detail ?? ""} | ${v.released ?? ""} |`;
  });
  return [
    "| Stack | Latest stable | Notes | Released |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Body of the always-on `stack-versions` note. */
export function buildStackNote(
  versions,
  { checkedAt = new Date(), context7 = true } = {},
) {
  return [
    `Checked ${checkedAt.toISOString().slice(0, 16).replace("T", " ")} UTC by the stack docs watcher; it updates itself every day.`,
    "",
    formatVersionsTable(versions),
    "",
    "How to use this:",
    "- Your training data is older than these versions. Before writing or reviewing code for one of these stacks, read the version the project actually uses (pubspec.lock, package.json / lockfile, pyproject, Cargo.toml, go.mod, *.csproj, pom.xml / build.gradle, CMake) and follow the docs for that version, not your memory.",
    context7
      ? '- Read version-specific docs and examples with the `context7` MCP: `resolve-library-id` (e.g. "flutter", "next.js", "nestjs", "riverpod"), then query the docs for that id and topic. Prefer it over guessing an API.'
      : "- Read the official docs for that version before using an API you are not sure about.",
    '- What changed in a new release is stored in the shared memory: `memory_search` with level `todo` and a query like "flutter 3.50 release notes".',
    "- Use a newer feature only when the project's version has it; suggest an upgrade separately instead of upgrading as a side effect.",
  ].join("\n");
}

/** Truncates fetched docs: release pages put the newest release first. */
export function clipDocs(text, max = 40_000) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max) : value;
}

/** Telegram text for /versiones. */
export function formatVersionsMessage(state) {
  const versions = state?.versions ?? {};
  if (Object.keys(versions).length === 0)
    return "Aún no tengo versiones; el vigilante de docs las revisa al arrancar y cada día.";
  const lines = STACK_KEYS.filter((key) => versions[key]).map((key) => {
    const v = versions[key];
    return `• ${STACKS[key].label}: ${v.version}${v.detail ? ` (${v.detail})` : ""}`;
  });
  const recent = (state.changes ?? [])
    .slice(-5)
    .reverse()
    .map(
      (c) =>
        `• ${c.at.slice(0, 10)} ${STACKS[c.stack]?.label ?? c.stack}: ${c.from ?? "—"} → ${c.to}`,
    );
  return [
    `Versiones estables (revisado ${String(state.checkedAt ?? "")
      .slice(0, 16)
      .replace("T", " ")} UTC):`,
    ...lines,
    ...(recent.length ? ["", "Cambios recientes:", ...recent] : []),
  ].join("\n");
}

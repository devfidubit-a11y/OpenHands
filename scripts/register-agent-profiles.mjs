#!/usr/bin/env node
/**
 * Creates the team's expert OpenHands agent profiles in the Agent Server
 * (Settings → Agent profiles in the UI, `/profile <name>` in Telegram):
 *
 *  - `flutter`: senior Flutter/Dart engineer that builds and checks its work
 *    on the iPhone simulator (skills flutter-expert + ios-simulator, MCPs
 *    `simulator` and `context7`).
 *  - `mobile-qa`: mobile QA that tests apps on the iPhone/iPad simulators.
 *
 * Only creates profiles that don't exist, so edits made in the UI are kept.
 * They use the LLM profile of the `default` profile. Idempotent and never
 * fatal. Turn off with AGENT_PROFILES_SEED=false.
 */

import { pathToFileURL } from "node:url";

import { waitForServer } from "./register-memory-mcp.mjs";

const COMMON = [
  "Before writing code for a library or framework, read the version the project uses and check its docs with the `context7` MCP (resolve-library-id, then the docs); the always-on `stack-versions` note lists the newest stable versions.",
  "The container has no Xcode or Flutter SDK: run flutter, the iOS simulators, screenshots and logs through the `simulator` MCP on the Mac host. If it isn't available, say so instead of installing toolchains.",
  "Follow change-safety-guard and feature-branch-pr: work on a feature branch, small conventional commits, `safe-branch check` before pushing, never commit to the default branch.",
];

export const EXPERT_PROFILES = {
  flutter: {
    summary: "Flutter/Dart senior + iPhone simulator",
    suffix: [
      "You are a senior Flutter and Dart engineer (iOS, Android, web, desktop).",
      "Use the flutter-expert and ios-simulator skills. Follow the app's existing architecture, state management and lints; write or update unit and widget tests (and integration_test for flows).",
      "Verify every UI change: flutter_cmd analyze and test, then flutter_run_ios and sim_screenshot on an iPhone simulator; report what you ran and saw.",
      ...COMMON,
    ].join("\n"),
  },
  "mobile-qa": {
    summary: "QA móvil en simuladores iPhone/iPad",
    suffix: [
      "You are a mobile QA engineer. Use the qa-testing, ios-simulator and flutter-expert skills.",
      "Reproduce bugs and verify fixes on iPhone/iPad simulators (sim_boot, flutter_run_ios or sim_install/sim_launch, sim_screenshot, sim_ui, sim_logs): happy path, errors, empty states, dark mode, large text, rotation, deep links.",
      "Write the missing tests (widget, golden, integration_test) and run them; report each check as passed, failed or not run, with evidence.",
      ...COMMON,
    ].join("\n"),
  },
};

/** The profile body for `name`, copying the base profile's LLM. */
export function buildExpertProfile(name, base = {}) {
  const spec = EXPERT_PROFILES[name];
  return {
    schema_version: base.schema_version ?? 4,
    agent_kind: "openhands",
    name,
    llm_profile_ref: base.llm_profile_ref ?? null,
    agent: base.agent ?? "CodeActAgent",
    mcp_server_refs: null, // all of the user's MCP servers
    public_skills: base.public_skills ?? null,
    disabled_skills: [],
    system_message_suffix: spec.suffix,
    ...(base.condenser ? { condenser: base.condenser } : {}),
  };
}

export async function registerAgentProfiles(
  env = process.env,
  log = console.log,
  fetchImpl = fetch,
) {
  if (env.AGENT_PROFILES_SEED === "false") return {};
  const base = (env.OH_AGENT_SERVER_URL || "http://127.0.0.1:18000").replace(
    /\/+$/,
    "",
  );
  const headers = { "Content-Type": "application/json" };
  if (env.OH_SESSION_API_KEY)
    headers["X-Session-API-Key"] = env.OH_SESSION_API_KEY;
  if (!(await waitForServer(base, headers, 180_000))) {
    log("[profiles] Agent Server not reachable; expert profiles not created");
    return {};
  }
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      ok: res.ok,
      status: res.status,
      json: res.ok ? await res.json() : null,
    };
  };
  const list = await call("GET", "/api/agent-profiles");
  const names = new Set((list.json?.profiles ?? []).map((p) => p.name));
  const def = names.has("default")
    ? ((await call("GET", "/api/agent-profiles/default")).json?.profile ?? {})
    : {};
  const results = {};
  for (const name of Object.keys(EXPERT_PROFILES)) {
    if (names.has(name)) {
      results[name] = "exists";
      continue;
    }
    const res = await call(
      "POST",
      `/api/agent-profiles/${encodeURIComponent(name)}`,
      buildExpertProfile(name, def),
    );
    results[name] = res.ok ? "created" : `failed (HTTP ${res.status})`;
    log(`[profiles] ${name}: ${results[name]}`);
  }
  return results;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  registerAgentProfiles().catch((err) => {
    console.log(`[profiles] error: ${err.message}`);
  });
}
